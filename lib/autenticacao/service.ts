import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { db, withTransaction } from '../db/postgres';
import { ClienteServiceError } from '../clientes/services/errors';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository';
import { conferirSenha, hashToken } from './senha';
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
export function authError(message = 'Autenticação administrativa necessária.', status = 401) {
    return new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', message, status);
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
function tentativa(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string) {
    return consumirLimite(tx, type, value, type === 'ORIGEM' ? { janelaSegundos: 300, limite: 30 } : { janelaSegundos: 900, limite: 5 });
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
    await tx.query(`UPDATE limites_autenticacao SET tentativas=$2::int,janela_iniciada_em=CASE WHEN $3::boolean THEN now() ELSE janela_iniciada_em END,
    bloqueado_ate=CASE WHEN $2::int>=$4::int THEN now()+($5::int*interval '1 second') ELSE NULL END WHERE chave_hash=$1`, [key, attempts, row.reiniciar, limit, seconds]);
    return attempts <= limit;
}
/** Zera a janela de um identificador (ex.: após uma troca de senha bem-sucedida). */
export async function limparLimite(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string, namespace?: string) {
    await tx.query('DELETE FROM limites_autenticacao WHERE chave_hash=$1', [chaveLimite(type, value, namespace)]);
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
    const result = await withTransaction(async (tx) => {
        if (!await tentativa(tx, 'ORIGEM', ip ?? 'ORIGEM_NAO_VERIFICADA') || !await tentativa(tx, 'IDENTIFICADOR', email.trim().toLowerCase()))
            return { error: 429 } as const;
        const user = (await tx.query<{
            id: string;
            senha_hash: string;
            ativo: boolean;
        }>('SELECT id,senha_hash,ativo FROM usuarios_administrativos WHERE email=$1 FOR UPDATE', [email.trim().toLowerCase()])).rows[0];
        const valid = await conferirSenha(password, user?.senha_hash ?? null);
        if (!valid || !user?.ativo) {
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
        await tx.query('DELETE FROM limites_autenticacao WHERE chave_hash=$1', [limitKey(`IDENTIFICADOR|${email.trim().toLowerCase()}`)]);
        const session = await criarSessaoAdministrativa(tx, user.id, ip, userAgent);
        if (empresaAnterior) await tx.query('UPDATE sessoes_administrativas SET empresa_ativa_id=$2::uuid WHERE id=$1', [session.id, empresaAnterior]);
        await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: user.id, acao: oldToken ? 'ADMIN_REAUTENTICACAO' : 'ADMIN_LOGIN', entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: session.id, origem: 'ADMIN_AUTENTICACAO', requestId, ip, userAgent }, tx);
        // Reautenticação: a sessão nova descende da anterior (mesma empresa ativa). O cliente só aceita a troca de
        // sessão quando recebe esta renovação para a sessão que ele mesmo enviou.
        return { token: session.token, csrf: session.csrf, expires: session.expires, renovacao: sessaoAnterior ? { anterior: sessaoAnterior, atual: session.id } : null };
    });
    if ('error' in result)
        throw authError(result.error === 429 ? 'Aguarde antes de tentar novamente.' : 'Credenciais inválidas.', result.error);
    return result;
}
export async function logoutAdmin(token: string) {
    return withTransaction(async (tx) => {
        const s = await consultarSessao(token, tx, true);
        await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [s.id]);
        await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: s.usuario_id, acao: 'ADMIN_LOGOUT', entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: s.id, origem: 'ADMIN_AUTENTICACAO' }, tx);
    });
}
export async function reautenticarAdmin(token: string, password: string) {
    const current = await consultarSessao(token);
    const email = (await db().query<{
        email: string;
    }>('SELECT email FROM usuarios_administrativos WHERE id=$1', [current.usuario_id])).rows[0].email;
    return loginAdmin(email, password, randomUUID(), null, null, token);
}
