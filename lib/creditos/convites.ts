/**
 * Ponte entre a geração de Convites (lib/convites/service.ts) e o motor novo de créditos (095).
 *
 * Um único motor autoriza o débito de cada empresa:
 *   LEGADO   — sem carteira CONVITES (sem corte registrado, ou sem a 095): convite_carteiras/convite_consumos, como antes;
 *   CREDITOS — com carteira CONVITES (criada só pelo corte, lib/creditos/corte.ts): reserva de 1 crédito por geração no
 *              extrato; o motor legado nunca mais autoriza essa empresa (sem fallback quando o saldo novo acaba).
 * Cotas por festa/cliente, teto global diário, autorização do responsável (088) e confirmação de foto/galeria continuam
 * sendo barreiras independentes, conferidas antes da reserva, como hoje.
 *
 * Ordem de travas (igual à da geração): convite → carteira (CONVITES) → lotes → orçamento global.
 * Encerrar/liberar reservas existentes nunca depende de flag (obrigação já assumida); só NOVAS reservas exigem
 * CREDITOS_CONVITES_CONSUMO_ATIVO=true — sem ela, a empresa cortada recebe "manutenção" e pode seguir sem IA.
 */
import type { DbExecutor } from '../db/contracts';
import { creditosInstalados, encerrarReserva, lerCarteira, reservar, SaldoInsuficiente, type Ator } from './ledger.ts';
import { flagsCreditos } from './config.ts';

export type MotorConvites = 'LEGADO' | 'CREDITOS';

export async function motorConvites(tx: DbExecutor, empresaId: string): Promise<MotorConvites> {
    if (!await creditosInstalados(tx)) return 'LEGADO';
    return (await lerCarteira(tx, empresaId, 'CONVITES')) ? 'CREDITOS' : 'LEGADO';
}

/** Disponível da carteira nova (para as cotas da tela e a validação anterior à reserva). */
export async function disponivelConvites(tx: DbExecutor, empresaId: string) {
    const w = await lerCarteira(tx, empresaId, 'CONVITES');
    return w ? w.saldo - w.reservado - w.bloqueado : 0;
}

/** Resumo para o editor do buffet: motor, disponível/reservado da empresa e se o consumo novo está ligado. */
export async function infoCreditosConvites(tx: DbExecutor, empresaId: string, env: Record<string, string | undefined> = process.env) {
    if (await motorConvites(tx, empresaId) === 'LEGADO') return { motor: 'LEGADO' as const };
    const w = (await lerCarteira(tx, empresaId, 'CONVITES'))!;
    return { motor: 'CREDITOS' as const, disponivel: w.saldo - w.reservado - w.bloqueado, reservado: w.reservado, consumoAtivo: flagsCreditos(env).consumoConvites };
}

/** Reserva 1 crédito para a geração (chave = id da geração). false = sem saldo. */
export async function reservarGeracao(tx: DbExecutor, empresaId: string, geracaoId: string, ator: Ator) {
    try {
        await reservar(tx, { empresaId, recurso: 'CONVITES', operacaoId: geracaoId, quantidade: 1, ator });
        return true;
    }
    catch (error) {
        if (error instanceof SaldoInsuficiente) return false;
        throw error;
    }
}

/** A geração tem reserva no motor novo? (decide como devolver/consumir, independentemente do corte atual) */
export async function geracaoNoMotorNovo(tx: DbExecutor, empresaId: string, geracaoId: string) {
    if (!await creditosInstalados(tx)) return false;
    return (await tx.query("SELECT 1 FROM ia_credito_reservas WHERE empresa_id = $1::uuid AND recurso = 'CONVITES' AND operacao_id = $2", [empresaId, geracaoId])).rows.length > 0;
}

/** Consome (geração concluída ou cobrança confirmada pelo operador) ou libera (não enviada, sem cobrança). Idempotente. */
export async function encerrarGeracao(tx: DbExecutor, empresaId: string, geracaoId: string, consumir: boolean, ator: Ator) {
    if (!await geracaoNoMotorNovo(tx, empresaId, geracaoId)) return null;
    return encerrarReserva(tx, { empresaId, recurso: 'CONVITES', operacaoId: geracaoId, quantidadeFinal: consumir ? 1 : 0, ator });
}
