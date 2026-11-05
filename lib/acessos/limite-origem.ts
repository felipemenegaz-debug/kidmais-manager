import type { DbExecutor } from '../db/contracts';
import { consumirLimite, prazoDoLimite } from '../autenticacao/service.ts';
import { chaveDaOrigem } from '../http/origem-cliente.ts';

/**
 * Limite por origem dos fluxos públicos de acesso (convite, recuperação, cadastro) — docs/ACESSOS_SCRYPT_FORA_TX_20261022.md.
 *
 * Com IP confiável: a regra do fluxo por IP (IPv6 agrupado por /64, como no login). Sem IP confiável, NUNCA a antiga
 * chave única `ORIGEM_NAO_VERIFICADA` com o limite de um IP só (ela trancava todo mundo junto). Em vez dela:
 * - `porIdentificador`: a mesma regra contada por um valor da própria requisição (o hash do token do link). Quem tem
 *   o link não divide a janela com ninguém; adivinhar token (32 bytes) não é viável, e o scrypt só roda para token válido.
 * - `tetoGlobal`: uma chave global com teto ALTO, só nos fluxos que enviam e-mail para endereço digitado (proteção
 *   contra envio em massa); o limite por e-mail de cada fluxo continua valendo.
 * As chaves sem origem usam a namespace `<fluxo>-sem-origem`: as linhas antigas da chave global são ignoradas e expiram.
 */
export type RegraOrigem = { namespace: string; janelaSegundos: number; limite: number };
export type SemOrigem = { porIdentificador: string } | { tetoGlobal: number };
export const VALOR_SEM_ORIGEM = 'SEM_ORIGEM_CONFIAVEL';

/** Consome uma tentativa; devolve null quando cabe, ou o prazo (segundos, para `Retry-After`) quando a janela estourou. */
export async function consumirOrigem(tx: DbExecutor, ip: string | null, regra: RegraOrigem, semOrigem: SemOrigem): Promise<{ aguardar: number | null } | null> {
    const [tipo, valor, r] = ip
        ? ['ORIGEM' as const, chaveDaOrigem(ip), regra]
        : 'tetoGlobal' in semOrigem
            ? ['ORIGEM' as const, VALOR_SEM_ORIGEM, { ...regra, namespace: `${regra.namespace}-sem-origem`, limite: semOrigem.tetoGlobal }]
            : ['IDENTIFICADOR' as const, semOrigem.porIdentificador, { ...regra, namespace: `${regra.namespace}-sem-origem` }];
    if (await consumirLimite(tx, tipo, valor, r))
        return null;
    return { aguardar: await prazoDoLimite(tx, tipo, valor, r.namespace) };
}
