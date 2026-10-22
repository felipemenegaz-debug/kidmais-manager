/**
 * Carteira do Wall-e no motor de créditos (090), em µUS$ inteiros. API pronta e testada, NÃO ligada ao atendimento:
 * o Wall-e segue desligado/regras por padrão e só pode usar esta carteira com CREDITOS_WALLE_CONSUMO_ATIVO=true E os
 * gates próprios do atendimento (R6, receptor, contatos; lib/creditos/config.ts walleDisponivel). Saldo nunca reativa o
 * atendimento nem eleva tetos de custo (AI_BUDGET_JSON continua valendo por cima).
 *
 *   reservarChamada  reserva o MÁXIMO calculado da interação (todas as chamadas previstas, entrada/cache/saída, passos);
 *   liquidarChamada  custo real conhecido → debita o apurado e libera o excesso; custo DESCONHECIDO (sem usage/preço)
 *                    → mantém a reserva aberta e pede parada das chamadas automáticas (nunca vira zero); custo acima do
 *                    reservado → debita só o reservado, o excedente é custo da plataforma e a configuração deve ser
 *                    suspensa até corrigir o estimador (`suspender`).
 */
import type { DbExecutor } from '../db/contracts';
import { walleDisponivel } from './config.ts';
import { abrirCarteira, encerrarReserva, lerCarteira, reservar, SaldoInsuficiente } from './ledger.ts';

type Env = Record<string, string | undefined>;
export type ResultadoReserva = { ok: true; reservaRepetida: boolean } | { ok: false; motivo: 'WALLE_INDISPONIVEL' | 'SALDO_INSUFICIENTE' | 'SEM_CARTEIRA' | 'MAXIMO_INVALIDO' };

export async function reservarChamada(tx: DbExecutor, r: { empresaId: string; operacaoId: string; maximoMicrousd: number; versaoPrecos: string }, env: Env = process.env): Promise<ResultadoReserva> {
    if (!walleDisponivel(env)) return { ok: false, motivo: 'WALLE_INDISPONIVEL' };
    if (!Number.isSafeInteger(r.maximoMicrousd) || r.maximoMicrousd <= 0) return { ok: false, motivo: 'MAXIMO_INVALIDO' };
    if (!await lerCarteira(tx, r.empresaId, 'WALLE')) return { ok: false, motivo: 'SEM_CARTEIRA' };
    try {
        const reserva = await reservar(tx, { empresaId: r.empresaId, recurso: 'WALLE', operacaoId: r.operacaoId, quantidade: r.maximoMicrousd, versaoPrecos: r.versaoPrecos, ator: 'SISTEMA' });
        return { ok: true, reservaRepetida: reserva.repetida };
    }
    catch (error) {
        if (error instanceof SaldoInsuficiente) return { ok: false, motivo: 'SALDO_INSUFICIENTE' };
        throw error;
    }
}

export type Liquidacao = { estado: 'CONSUMIDA' | 'LIBERADA' | 'CUSTO_DESCONHECIDO' | 'SEM_RESERVA'; debitado: number; excedenteMicrousd: number; suspender: boolean };
/** Encerramento da reserva; funciona com qualquer flag (obrigação já assumida). */
export async function liquidarChamada(tx: DbExecutor, l: { empresaId: string; operacaoId: string; custoRealMicrousd: number | null }): Promise<Liquidacao> {
    if (l.custoRealMicrousd === null || !Number.isSafeInteger(l.custoRealMicrousd) || l.custoRealMicrousd < 0)
        return { estado: 'CUSTO_DESCONHECIDO', debitado: 0, excedenteMicrousd: 0, suspender: true };
    await abrirCarteira(tx, l.empresaId, 'WALLE');
    const e = await encerrarReserva(tx, { empresaId: l.empresaId, recurso: 'WALLE', operacaoId: l.operacaoId, quantidadeFinal: l.custoRealMicrousd,
        custoRealMicrousd: l.custoRealMicrousd, ator: 'SISTEMA' });
    if (e.estado === 'SEM_RESERVA') return { estado: 'SEM_RESERVA', debitado: 0, excedenteMicrousd: 0, suspender: true };
    return { estado: e.estado, debitado: e.consumido, excedenteMicrousd: e.excedente, suspender: e.excedente > 0 };
}
