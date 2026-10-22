import { withTransaction } from '../db/postgres';
import { resumoCampanha, type ResumoCampanha } from '../assinatura/campanha.ts';

/**
 * Resumo indicativo para o site (sem ids nem documentos). Falha ou demora da leitura viram texto sem prazo nem estoque,
 * sem segurar a página. A página pública é dinâmica: uma única leitura em andamento por processo e um cache curto
 * evitam empilhar transações no pool quando o banco está lento (revisões de 22/10/2026). A contratação sempre recalcula.
 */
const CACHE_MS = 30_000;
let emAndamento: Promise<ResumoCampanha | null> | null = null;
let guardado: { valor: ResumoCampanha; ate: number } | null = null;

function lerUmaVez(): Promise<ResumoCampanha | null> {
    if (!emAndamento) {
        emAndamento = withTransaction(async (tx) => {
            await tx.query("SET LOCAL statement_timeout = '2s'");
            return resumoCampanha(tx);
        }).then((valor) => { guardado = { valor, ate: Date.now() + CACHE_MS }; return valor; }, () => null)
            .finally(() => { emAndamento = null; });
    }
    return emAndamento;
}

export async function resumoCampanhaSite(limiteMs = 2500): Promise<ResumoCampanha | null> {
    if (guardado && guardado.ate > Date.now()) return guardado.valor;
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<null>((fim) => { relogio = setTimeout(() => fim(null), limiteMs); });
    try { return await Promise.race([lerUmaVez(), prazo]); }
    finally { clearTimeout(relogio); }
}
