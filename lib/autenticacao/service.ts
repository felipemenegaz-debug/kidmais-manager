import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { db, withTransaction } from '../db/postgres';
import { ClienteServiceError } from '../clientes/services/errors';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository';
import { conferirSenha, hashToken } from './senha';
import { chaveDaOrigem } from '../http/origem-cliente';
export type Papel = 'ADMINISTRATIVO' | 'REPRESENTANTE_AUTORIZADO';
export type SessaoAdmin = {
    id: string;
    usuario_id: string;
    nome: string;
    cargo: string | null;
    papel: Papel;
    autenticado_em: string;
    expira_em: string;
    csrf_hash: string;
    /** Carimbo e leitura usam o mesmo relógio PostgreSQL. */
    consultado_em?: string;
    empresa_ativa_id?: string | null;
};
export function authError(message = 'Autenticação administrativa necessária.', status = 401, details?: Record<string, unknown>) {
    return new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', message, status, details);
}
export async function consultarSessao(token: string, tx: DbExecutor = db(), lock = false): Promise<SessaoAdmin> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw authError();
    const result = await tx.query<SessaoAdmin & { selecao_instalada: boolean }>(`SELECT s.id,s.usuario_id,u.nome,u.cargo,u.papel,s.autenticado_em::text,s.expira_em::text,s.csrf_hash,
    clock_timestamp()::text AS consultado_em, to_jsonb(s)->>'empresa_ativa_id' AS empresa_ativa_id,
    (to_jsonb(s) ? 'empresa_ativa_id') AS selecao_instalada
    FROM sessoes_administrativas s JOIN usuarios_administrativos u ON u.id=s.usuario_id
    WHERE s.token_hash=$1 AND s.revogado_em IS NULL AND u.ativo AND s.expira_em>clock_timestamp()
    AND s.ultima_atividade_em>clock_timestamp()-interval '30 minutes' AND s.autenticado_em>=u.senha_alterada_em
    ${lock ? 'FOR UPDATE OF u,s' : ''}`, [hashToken(token)]);
    const linha = result.rows[0];
    if (!linha)
        throw authError();
    // Antes da 063 não existe seleção de empresa na sessão: `empresa_ativa_id` fica AUSENTE (undefined), e
    // provarTenant mantém a regra legada (o empresaId pedido escolhe entre as memberships ativas). Com a 063,
    // null significa "nenhuma empresa selecionada" e a seleção explícita passa a valer.
    const { selecao_instalada: instalada, ...sessao } = linha;
    if (!instalada)
        delete sessao.empresa_ativa_id;
    return sessao;
}
function limitKey(value: string) {
    const secret = process.env.ADMIN_AUTH_SECRET;
    if (!secret || secret.length < 32)
        throw authError('Configure ADMIN_AUTH_SECRET no servidor.', 503);
    return createHmac('sha256', secret).update(value).digest('hex');
}
/**
 * Limites do login (docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md):
 * - IDENTIFICADOR: 5 tentativas por conta a cada 900 s (a proteção principal; o sucesso zera a conta).
 * - ORIGEM: só FALHAS contam, 300 a cada 900 s por IP (IPv6 por /64). Uma empresa inteira atrás do mesmo NAT não
 *   chega perto disso: 50 pessoas errando até o limite da própria conta somam 250. O login certo nunca consome a
 *   origem: a vaga é reservada antes do scrypt (para que uma rajada simultânea não escape do teto) e devolvida no
 *   sucesso. Não se zera a origem no sucesso: quem tem uma conta válida limparia o próprio IP entre as tentativas.
 * - Sem IP confiável não há limite de origem (nunca uma chave global que tranque todo mundo); fica o da conta.
 */
const REGRA_IDENTIFICADOR = { janelaSegundos: 900, limite: 5 } as const;
export const REGRA_ORIGEM_LOGIN = { namespace: 'login-falhas', janelaSegundos: 900, limite: 300 } as const;
type ReservaOrigem = { chave: string; janela: string } | null;
/**
 * Reserva uma vaga de falha na origem (linha travada só durante esta transação curta); 'recusado' quando a origem
 * está bloqueada ou o teto já está ocupado por falhas e tentativas em andamento.
 */
async function reservarOrigem(tx: DbExecutor, ip: string): Promise<ReservaOrigem | 'recusado'> {
    const key = chaveLimite('ORIGEM', chaveDaOrigem(ip), REGRA_ORIGEM_LOGIN.namespace), seconds = REGRA_ORIGEM_LOGIN.janelaSegundos;
    await tx.query(`INSERT INTO limites_autenticacao(chave_hash,tipo,tentativas,janela_iniciada_em) VALUES($1,'ORIGEM',0,now()) ON CONFLICT DO NOTHING`, [key]);
    const row = (await tx.query<{ tentativas: number; bloqueado: boolean; reiniciar: boolean }>(`SELECT tentativas,
    COALESCE(bloqueado_ate>clock_timestamp(),false) AS bloqueado,janela_iniciada_em<clock_timestamp()-($2::int*interval '1 second') AS reiniciar
    FROM limites_autenticacao WHERE chave_hash=$1 FOR UPDATE`, [key, seconds])).rows[0];
    if (row.bloqueado || (!row.reiniciar && row.tentativas >= REGRA_ORIGEM_LOGIN.limite))
        return 'recusado';
    const janela = (await tx.query<{ janela: string }>(`UPDATE limites_autenticacao SET tentativas=CASE WHEN $2::boolean THEN 1 ELSE tentativas+1 END,
    janela_iniciada_em=CASE WHEN $2::boolean THEN now() ELSE LEAST(janela_iniciada_em,now()) END,bloqueado_ate=CASE WHEN $2::boolean THEN NULL ELSE bloqueado_ate END
    WHERE chave_hash=$1 RETURNING janela_iniciada_em::text AS janela`, [key, row.reiniciar])).rows[0].janela;
    return { chave: key, janela };
}
/**
 * Devolve a vaga (login certo, ou tentativa que não chegou a conferir senha). Mesma janela = início até o da reserva
 * (LEAST pode recuá-lo); janela reiniciada depois começa mais tarde e não tem nada a devolver.
 */
async function devolverOrigem(tx: DbExecutor, reserva: ReservaOrigem) {
    if (reserva)
        await tx.query(`UPDATE limites_autenticacao SET tentativas=GREATEST(tentativas-1,0) WHERE chave_hash=$1 AND janela_iniciada_em<=$2::timestamptz`, [reserva.chave, reserva.janela]);
}
/** A vaga vira falha; no teto, a origem fica bloqueada pela janela inteira. */
async function confirmarFalhaDeOrigem(tx: DbExecutor, reserva: ReservaOrigem) {
    if (reserva)
        await tx.query(`UPDATE limites_autenticacao SET bloqueado_ate=CASE WHEN tentativas>=$3::int THEN now()+($4::int*interval '1 second') ELSE bloqueado_ate END
        WHERE chave_hash=$1 AND janela_iniciada_em<=$2::timestamptz`, [reserva.chave, reserva.janela, REGRA_ORIGEM_LOGIN.limite, REGRA_ORIGEM_LOGIN.janelaSegundos]);
}
/**
 * Acerto da origem depois do resultado: um UPDATE avulso, fora da transação da sessão. Assim a linha do IP fica
 * travada só durante esse comando (50 acertos da mesma empresa não fazem fila segurando conexões) e o login nunca
 * segura conta/usuário esperando a origem (sem ciclo de travas com a fase de limites). Se falhar, a vaga expira com
 * a janela.
 */
async function acertarOrigem(reserva: ReservaOrigem, acerto: typeof devolverOrigem) {
    if (reserva)
        await acerto(db(), reserva).catch(() => undefined);
}
function chaveLimite(type: 'IDENTIFICADOR' | 'ORIGEM', value: string, namespace?: string) {
    return limitKey(namespace ? `${namespace}|${type}|${value}` : `${type}|${value}`);
}
/**
 * Janela de tentativas em limites_autenticacao (só o HMAC da chave é guardado). `namespace` separa os fluxos
 * (troca de senha, recuperação, convite) do login sem mudar a tabela; o tipo continua IDENTIFICADOR | ORIGEM.
 * Devolve false quando a janela estourou (e bloqueia pelo mesmo período).
 */
export async function consumirLimite(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string, regra: { namespace?: string; janelaSegundos: number; limite: number }) {
    const key = chaveLimite(type, value, regra.namespace), seconds = regra.janelaSegundos, limit = regra.limite;
    await tx.query(`INSERT INTO limites_autenticacao(chave_hash,tipo,tentativas,janela_iniciada_em) VALUES($1,$2,0,now()) ON CONFLICT DO NOTHING`, [key, type]);
    const row = (await tx.query<{
        tentativas: number;
        bloqueado: boolean;
        reiniciar: boolean;
    }>(`SELECT tentativas,
    COALESCE(bloqueado_ate>clock_timestamp(),false) AS bloqueado,janela_iniciada_em<clock_timestamp()-($2::int*interval '1 second') AS reiniciar
    FROM limites_autenticacao WHERE chave_hash=$1 FOR UPDATE`, [key, seconds])).rows[0];
    if (row.bloqueado)
        return false;
    const attempts = row.reiniciar ? 1 : row.tentativas + 1;
    // LEAST: a janela pode ter sido aberta por uma transação que começou DEPOIS desta (now() é o início da transação);
    // sem recuar o início, o gatilho grava atualizado_em < janela_iniciada_em e a CHECK de datas derruba a tentativa.
    await tx.query(`UPDATE limites_autenticacao SET tentativas=$2::int,janela_iniciada_em=CASE WHEN $3::boolean THEN now() ELSE LEAST(janela_iniciada_em,now()) END,
    bloqueado_ate=CASE WHEN $2::int>=$4::int THEN now()+($5::int*interval '1 second') ELSE NULL END WHERE chave_hash=$1`, [key, attempts, row.reiniciar, limit, seconds]);
    return attempts <= limit;
}
/** Zera a janela de um identificador (ex.: após uma troca de senha bem-sucedida). */
export async function limparLimite(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string, namespace?: string) {
    await tx.query('DELETE FROM limites_autenticacao WHERE chave_hash=$1', [chaveLimite(type, value, namespace)]);
}
/**
 * Segundos até o bloqueio da janela acabar (para `Retry-After` em respostas 429), pelo relógio do banco.
 * null quando não há bloqueio vigente ou a chave não existe — nesse caso nenhum prazo é informado.
 */
export async function prazoDoLimite(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string, namespace?: string): Promise<number | null> {
    const row = (await tx.query<{ segundos: number | string | null }>(
        `SELECT GREATEST(1, ceil(extract(epoch FROM (bloqueado_ate - clock_timestamp()))))::int AS segundos
           FROM limites_autenticacao WHERE chave_hash=$1 AND bloqueado_ate > clock_timestamp()`,
        [chaveLimite(type, value, namespace)],
    )).rows[0];
    const segundos = row?.segundos == null ? null : Number(row.segundos);
    return segundos !== null && Number.isFinite(segundos) && segundos > 0 ? segundos : null;
}
/** Sessão administrativa nova: 8 h absolutas (a inatividade de 30 min é conferida em consultarSessao). Só os hashes vão ao banco. */
export async function criarSessaoAdministrativa(tx: DbExecutor, usuarioId: string, ip: string | null, userAgent: string | null) {
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    const session = (await tx.query<{
        id: string;
        expira_em: Date;
    }>(`INSERT INTO sessoes_administrativas(usuario_id,token_hash,csrf_hash,autenticado_em,ultima_atividade_em,expira_em,ip,user_agent)
      VALUES($1,$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '8 hours',$4,$5) RETURNING id,expira_em`, [usuarioId, hashToken(token), hashToken(csrf), ip, userAgent])).rows[0];
    return { id: session.id, token, csrf, expires: session.expira_em };
}
/** Encerra todas as sessões abertas da identidade; devolve quantas foram encerradas. */
export async function revogarSessoesDoUsuario(tx: DbExecutor, usuarioId: string) {
    return (await tx.query<{ id: string }>('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL RETURNING id', [usuarioId])).rows.length;
}
export async function loginAdmin(email: string, password: string, requestId: string, ip: string | null, userAgent: string | null, oldToken?: string) {
    const identificador = email.trim().toLowerCase();
    // 1) Limites, numa transação curta: as linhas de origem e de conta ficam travadas só aqui (milissegundos),
    // nunca durante o scrypt. Ordem de travas: origem → conta aqui; usuário → conta na fase 3 (que não toca a origem).
    const limites = await withTransaction(async (tx) => {
        const reserva = ip ? await reservarOrigem(tx, ip) : null;
        if (reserva === 'recusado')
            return { error: 429, aguardar: await prazoDoLimite(tx, 'ORIGEM', chaveDaOrigem(ip!), REGRA_ORIGEM_LOGIN.namespace) } as const;
        if (!await consumirLimite(tx, 'IDENTIFICADOR', identificador, REGRA_IDENTIFICADOR)) {
            await devolverOrigem(tx, reserva);
            return { error: 429, aguardar: await prazoDoLimite(tx, 'IDENTIFICADOR', identificador) } as const;
        }
        return { reserva };
    });
    if ('error' in limites)
        throw authError('Aguarde antes de tentar novamente.', 429, limites.aguardar ? { retryAfterSegundos: limites.aguardar } : undefined);
    const reserva = limites.reserva;
    let resolvida = false;
    try {
        // 2) Conferência da senha SEM conexão do pool: a leitura devolve a conexão antes do scrypt (o mesmo custo
        // para conta inexistente, que confere contra um hash vazio).
        const lido = (await db().query<{ id: string; senha_hash: string; ativo: boolean }>('SELECT id,senha_hash,ativo FROM usuarios_administrativos WHERE email=$1', [identificador])).rows[0];
        const valid = await conferirSenha(password, lido?.senha_hash ?? null);
        // 3) Resultado, noutra transação curta. No sucesso, a conta é relida travada: se a senha mudou (ou a conta foi
        // desativada) durante o scrypt, a tentativa vale como recusada.
        const result = await withTransaction(async (tx) => {
            const user = valid && lido?.ativo
                ? (await tx.query<{ id: string; senha_hash: string; ativo: boolean }>('SELECT id,senha_hash,ativo FROM usuarios_administrativos WHERE id=$1 FOR UPDATE', [lido.id])).rows[0]
                : undefined;
            if (!user || !user.ativo || user.senha_hash !== lido?.senha_hash) {
                await registrarAuditoria({ atorTipo: 'SISTEMA', acao: 'ADMIN_LOGIN_RECUSADO', entidadeTipo: 'AUTENTICACAO', entidadeId: requestId, origem: 'ADMIN_AUTENTICACAO', requestId, ip, userAgent }, tx);
                return { error: 401 } as const;
            }
            let empresaAnterior: string | null = null;
            let sessaoAnterior: string | null = null;
            if (oldToken) {
                const old = await consultarSessao(oldToken, tx, true);
                if (old.usuario_id !== user.id)
                    throw authError();
                await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [old.id]);
                empresaAnterior = old.empresa_ativa_id ?? null;
                sessaoAnterior = old.id;
            }
            await limparLimite(tx, 'IDENTIFICADOR', identificador);
            const session = await criarSessaoAdministrativa(tx, user.id, ip, userAgent);
            if (empresaAnterior) await tx.query('UPDATE sessoes_administrativas SET empresa_ativa_id=$2::uuid WHERE id=$1', [session.id, empresaAnterior]);
            await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: user.id, acao: oldToken ? 'ADMIN_REAUTENTICACAO' : 'ADMIN_LOGIN', entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: session.id, origem: 'ADMIN_AUTENTICACAO', requestId, ip, userAgent }, tx);
            // Reautenticação: a sessão nova descende da anterior (mesma empresa ativa). O cliente só aceita a troca de
            // sessão quando recebe esta renovação para a sessão que ele mesmo enviou.
            return { token: session.token, csrf: session.csrf, expires: session.expires, renovacao: sessaoAnterior ? { anterior: sessaoAnterior, atual: session.id } : null };
        });
        resolvida = true;
        // A vaga da origem: falha confirmada (pode bloquear o IP) ou devolvida no acerto.
        await acertarOrigem(reserva, 'error' in result ? confirmarFalhaDeOrigem : devolverOrigem);
        if ('error' in result)
            throw authError('Credenciais inválidas.', result.error);
        return result;
    }
    finally {
        // Erro antes do resultado (banco, sessão anterior inválida): a tentativa não conta contra a origem. Se a
        // devolução também falhar, a vaga expira com a janela.
        if (!resolvida)
            await acertarOrigem(reserva, devolverOrigem);
    }
}
export async function logoutAdmin(token: string) {
    return withTransaction(async (tx) => {
        const s = await consultarSessao(token, tx, true);
        await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [s.id]);
        await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: s.usuario_id, acao: 'ADMIN_LOGOUT', entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: s.id, origem: 'ADMIN_AUTENTICACAO' }, tx);
    });
}
export async function reautenticarAdmin(token: string, password: string, ip: string | null = null, userAgent: string | null = null) {
    const current = await consultarSessao(token);
    const email = (await db().query<{
        email: string;
    }>('SELECT email FROM usuarios_administrativos WHERE id=$1', [current.usuario_id])).rows[0].email;
    return loginAdmin(email, password, randomUUID(), ip, userAgent, token);
}
