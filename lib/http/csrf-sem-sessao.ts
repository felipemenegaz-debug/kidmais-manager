import { randomBytes } from 'node:crypto';

/** Mesmo formato exigido pelo POST de autenticação (32 bytes em base64url). */
const FORMATO_CSRF = /^[A-Za-z0-9_-]{43}$/;

/**
 * CSRF da resposta de `GET /api/admin/autenticacao` quando a sessão do pedido não vale (nunca existiu, expirou, foi
 * encerrada ou revogada). Um cookie CSRF já presente e bem formado é REAPROVEITADO, sem gravar outro: uma resposta
 * atrasada de uma sessão anterior (por exemplo, revogada pela troca de empresa nesta mesma página) não pode substituir
 * o CSRF da sessão nova — senão toda leitura seguinte da sessão nova falharia na conferência do CSRF e a pessoa iria
 * para o login. Sem cookie válido, gera um novo (o login precisa dele).
 */
export function csrfParaSessaoInvalida(atual: string | undefined): { csrf: string; gravar: boolean } {
    if (atual && FORMATO_CSRF.test(atual))
        return { csrf: atual, gravar: false };
    return { csrf: randomBytes(32).toString('base64url'), gravar: true };
}
