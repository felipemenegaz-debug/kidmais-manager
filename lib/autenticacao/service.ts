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
};
export function authError(message = 'Autenticação administrativa necessária.', status = 401) {
    return new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', message, status);
}
export async function consultarSessao(token: string, tx: DbExecutor = db(), lock = false): Promise<SessaoAdmin> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw authError();
    const result = await tx.query<SessaoAdmin>(`SELECT s.id,s.usuario_id,u.nome,u.cargo,u.papel,s.autenticado_em::text,s.expira_em::text,s.csrf_hash
    FROM sessoes_administrativas s JOIN usuarios_administrativos u ON u.id=s.usuario_id
    WHERE s.token_hash=$1 AND s.revogado_em IS NULL AND u.ativo AND s.expira_em>clock_timestamp()
    AND s.ultima_atividade_em>clock_timestamp()-interval '30 minutes' AND s.autenticado_em>=u.senha_alterada_em
    ${lock ? 'FOR UPDATE OF u,s' : ''}`, [hashToken(token)]);
    if (!result.rows[0])
        throw authError();
    return result.rows[0];
}
function limitKey(value: string) {
    const secret = process.env.ADMIN_AUTH_SECRET;
    if (!secret || secret.length < 32)
        throw authError('Configure ADMIN_AUTH_SECRET no servidor.', 503);
    return createHmac('sha256', secret).update(value).digest('hex');
}
async function tentativa(tx: DbExecutor, type: 'IDENTIFICADOR' | 'ORIGEM', value: string) {
    const key = limitKey(`${type}|${value}`), seconds = type === 'ORIGEM' ? 300 : 900, limit = type === 'ORIGEM' ? 30 : 5;
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
        if (oldToken) {
            const old = await consultarSessao(oldToken, tx, true);
            if (old.usuario_id !== user.id)
                throw authError();
            await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [old.id]);
        }
        await tx.query('DELETE FROM limites_autenticacao WHERE chave_hash=$1', [limitKey(`IDENTIFICADOR|${email.trim().toLowerCase()}`)]);
        const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
        const session = (await tx.query<{
            id: string;
            expira_em: Date;
        }>(`INSERT INTO sessoes_administrativas(usuario_id,token_hash,csrf_hash,autenticado_em,ultima_atividade_em,expira_em,ip,user_agent)
      VALUES($1,$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '8 hours',$4,$5) RETURNING id,expira_em`, [user.id, hashToken(token), hashToken(csrf), ip, userAgent])).rows[0];
        await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: user.id, acao: oldToken ? 'ADMIN_REAUTENTICACAO' : 'ADMIN_LOGIN', entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: session.id, origem: 'ADMIN_AUTENTICACAO', requestId, ip, userAgent }, tx);
        return { token, csrf, expires: session.expira_em };
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
