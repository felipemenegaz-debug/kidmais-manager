import { withTransaction } from '../db/postgres';
import { resumoCampanha, type ResumoCampanha } from '../assinatura/campanha.ts';

/**
 * Resumo indicativo para o site (sem ids nem documentos). Falha ou demora da leitura (revisão de 22/10/2026: a página
 * pública é dinâmica e consulta o banco a cada visita) vira texto sem prazo nem estoque, sem segurar a página.
 */
export async function resumoCampanhaSite(limiteMs = 2500): Promise<ResumoCampanha | null> {
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const leitura = withTransaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '2s'");
        return resumoCampanha(tx);
    }).catch(() => null);
    const prazo = new Promise<null>((fim) => { relogio = setTimeout(() => fim(null), limiteMs); });
    try { return await Promise.race([leitura, prazo]); }
    finally { clearTimeout(relogio); }
}
