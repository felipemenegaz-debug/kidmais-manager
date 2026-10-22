import { withTransaction } from '../db/postgres';
import { resumoCampanha, type ResumoCampanha } from '../assinatura/campanha.ts';

/**
 * Resumo indicativo para o site (sem ids nem documentos). Falha ou demora da leitura viram texto sem prazo nem estoque,
 * sem segurar a página. A página pública é dinâmica: uma única leitura em andamento por processo e um cache curto
 * evitam empilhar transações no pool quando o banco está lento (revisões de 22/10/2026). A contratação sempre recalcula.
 * O cache nunca atravessa a próxima mudança de fase conhecida (abertura ou fim da janela; revisão completa, P3-1): o
 * limite usa o relógio do processo, então a defasagem dele para o banco ainda vale. O estoque pós-janela segue indicativo.
 */
const CACHE_MS = 30_000;

/** Instante (ms) em que o resumo deixa de valer: abertura (ANTES) ou fim da janela (JANELA); sem fronteira, Infinity. */
export function proximaMudanca(r: ResumoCampanha): number {
    const iso = r.fase === 'ANTES' ? r.inicio : r.fase === 'JANELA' ? r.janelaFim : undefined;
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : Infinity;
}
let emAndamento: Promise<ResumoCampanha | null> | null = null;
let guardado: { valor: ResumoCampanha; ate: number } | null = null;

function lerUmaVez(): Promise<ResumoCampanha | null> {
    if (!emAndamento) {
        emAndamento = withTransaction(async (tx) => {
            await tx.query("SET LOCAL statement_timeout = '2s'");
            return resumoCampanha(tx);
        }).then((valor) => { guardado = { valor, ate: Math.min(Date.now() + CACHE_MS, proximaMudanca(valor)) }; return valor; }, () => null)
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
