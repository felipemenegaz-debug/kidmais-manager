/**
 * Estado local da assinatura a partir do estado ATUAL do provedor (E8) — função PURA.
 *
 * O webhook é só um aviso: quem chama sempre reconsulta a assinatura e as cobranças no provedor e aplica o resultado
 * desta função. Por isso a ordem dos eventos não importa (um "pago" que chega depois de um "cancelado" não reverte
 * nada: vale o que o provedor diz agora).
 *
 * Regras:
 *   - pago = CONFIRMED | RECEIVED | RECEIVED_IN_CASH (cobrança não removida). Estorno, chargeback e afins NÃO são pagos;
 *   - fim do período = vencimento da última cobrança paga + 1 mês (MENSAL) ou + 1 ano (ANUAL), à meia-noite de Brasília;
 *     o período nunca encolhe por aqui (estorno de período já liberado é decisão manual da plataforma);
 *   - atraso = cobrança OVERDUE vencida, sem cobrança paga com vencimento posterior, e período pago já terminado →
 *     EM_ATRASO desde o vencimento mais antigo nessa condição;
 *   - assinatura inativa, expirada ou removida no provedor → CANCELADA_FIM_PERIODO enquanto o período pago não
 *     terminou, senão ENCERRADA; quem nunca pagou e está em TESTE continua em TESTE;
 *   - transições fora da tabela da 068 nunca são propostas (o estado atual é mantido e o motivo é informado).
 */
import type { SituacaoAssinatura } from './acesso.ts';
import type { Ciclo } from './configuracao.ts';
import { cicloDoProvedor, type AssinaturaProvedor, type CobrancaProvedor } from './asaas.ts';

export const STATUS_PAGO = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);

export type EstadoLocal = {
    situacao: SituacaoAssinatura;
    ciclo: Ciclo | null;
    periodoAtualFim: string | null;
    emAtrasoDesde: string | null;
    canceladaEm: string | null;
    encerradaEm: string | null;
};
export type EstadoAlvo = EstadoLocal & { provedorSituacao: string; mudou: boolean; recusa: string | null };

/** Transições da guarda da 068 (database/migrations/20261007_068_cobranca_assinatura.sql). */
const TRANSICOES: Record<SituacaoAssinatura, readonly SituacaoAssinatura[]> = {
    TESTE: ['ATIVA', 'ENCERRADA'],
    ATIVA: ['EM_ATRASO', 'CANCELADA_FIM_PERIODO', 'ENCERRADA'],
    EM_ATRASO: ['ATIVA', 'CANCELADA_FIM_PERIODO', 'ENCERRADA'],
    CANCELADA_FIM_PERIODO: ['ATIVA', 'ENCERRADA'],
    ENCERRADA: ['ATIVA'],
};
export const transicaoPermitida = (de: SituacaoAssinatura, para: SituacaoAssinatura) => de === para || TRANSICOES[de].includes(para);

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
const iso = (t: number) => new Date(t).toISOString();

/** 'YYYY-MM-DD' (data do provedor, fuso de Brasília, UTC−3 sem horário de verão) → instante da meia-noite local. */
export function inicioDoDia(data: string) {
    const [a, m, d] = data.split('-').map(Number);
    return Date.UTC(a, m - 1, d, 3, 0, 0, 0);
}

/** Soma um ciclo mantendo o dia; dia inexistente no mês de destino vai para o último dia (31/01 + 1 mês = 28 ou 29/02). */
export function somarCiclo(data: string, ciclo: Ciclo) {
    const [a, m, d] = data.split('-').map(Number);
    const anoDestino = ciclo === 'ANUAL' ? a + 1 : a + Math.floor(m / 12);
    const mesDestino = ciclo === 'ANUAL' ? m - 1 : m % 12;
    const ultimo = new Date(Date.UTC(anoDestino, mesDestino + 1, 0)).getUTCDate();
    return Date.UTC(anoDestino, mesDestino, Math.min(d, ultimo), 3, 0, 0, 0);
}

function situacaoProvedor(assinatura: AssinaturaProvedor | null) {
    if (!assinatura || assinatura.deleted)
        return 'DELETED';
    return assinatura.status.slice(0, 40) || 'DESCONHECIDO';
}

export function estadoDoProvedor(atual: EstadoLocal, assinatura: AssinaturaProvedor | null, pagamentos: readonly CobrancaProvedor[], agora: number): EstadoAlvo {
    const provedorSituacao = situacaoProvedor(assinatura);
    const ciclo = cicloDoProvedor(assinatura?.cycle ?? null) ?? atual.ciclo;
    const validos = pagamentos.filter((p) => !p.deleted);
    const pagos = validos.filter((p) => STATUS_PAGO.has(p.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const ultimoPago = pagos.at(-1) ?? null;

    // Fim do período: pela última cobrança paga; nunca menor que o já gravado.
    let fim = ms(atual.periodoAtualFim);
    if (ultimoPago && ciclo) {
        const pelo = somarCiclo(ultimoPago.dueDate, ciclo);
        fim = Number.isFinite(fim) ? Math.max(fim, pelo) : pelo;
    }
    const temPeriodo = Number.isFinite(fim);
    const periodoVigente = temPeriodo && fim > agora;

    const manter = (recusa: string | null): EstadoAlvo => ({ ...atual, provedorSituacao, mudou: false, recusa });
    const proposto = (alvo: EstadoLocal): EstadoAlvo => {
        if (!transicaoPermitida(atual.situacao, alvo.situacao))
            return manter(`TRANSICAO_${atual.situacao}_${alvo.situacao}`);
        const mudou = (Object.keys(alvo) as (keyof EstadoLocal)[]).some((k) => (alvo[k] ?? null) !== (atual[k] ?? null));
        return { ...alvo, provedorSituacao, mudou, recusa: null };
    };

    const ativaNoProvedor = assinatura !== null && !assinatura.deleted && assinatura.status === 'ACTIVE';
    if (ativaNoProvedor) {
        // Sem cobrança paga NESTA assinatura, quem não está pagando (teste, cancelada, encerrada) continua onde está:
        // TESTE vence sozinho pela data; nova assinatura de quem cancelou só reativa quando a cobrança for paga.
        if (!temPeriodo || (!ultimoPago && atual.situacao !== 'ATIVA' && atual.situacao !== 'EM_ATRASO'))
            return manter(null);
        if (!ciclo)
            return manter('CICLO_DESCONHECIDO');
        const vencidas = validos
            .filter((p) => p.status === 'OVERDUE' && inicioDoDia(p.dueDate) < agora && (!ultimoPago || p.dueDate > ultimoPago.dueDate))
            .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        // TESTE → EM_ATRASO não existe na 068: quem pagou e já tem nova cobrança vencida passa primeiro a ATIVA (com o
        // período vencido, acesso.ts já aplica a regularização) e vai a EM_ATRASO na sincronização seguinte.
        if (vencidas.length && !periodoVigente && atual.situacao !== 'TESTE') {
            const desde = atual.situacao === 'EM_ATRASO' && atual.emAtrasoDesde ? atual.emAtrasoDesde : iso(inicioDoDia(vencidas[0].dueDate));
            return proposto({ situacao: 'EM_ATRASO', ciclo, periodoAtualFim: iso(fim), emAtrasoDesde: desde, canceladaEm: null, encerradaEm: null });
        }
        // Período pago vigente, ou terminado com a próxima cobrança ainda não vencida: ATIVA (acesso.ts aplica a
        // regularização quando o período passou sem renovação confirmada).
        return proposto({ situacao: 'ATIVA', ciclo, periodoAtualFim: iso(fim), emAtrasoDesde: null, canceladaEm: null, encerradaEm: null });
    }

    // Inativa, expirada ou removida no provedor.
    if (atual.situacao === 'TESTE')
        return manter(null);
    if (periodoVigente && atual.situacao !== 'ENCERRADA')
        return proposto({ situacao: 'CANCELADA_FIM_PERIODO', ciclo: ciclo ?? atual.ciclo, periodoAtualFim: iso(fim), emAtrasoDesde: null, canceladaEm: atual.canceladaEm ?? iso(agora), encerradaEm: null });
    if (atual.situacao === 'ENCERRADA')
        return manter(null);
    const encerradaEm = atual.situacao === 'CANCELADA_FIM_PERIODO' && temPeriodo ? iso(fim) : iso(agora);
    return proposto({ situacao: 'ENCERRADA', ciclo: ciclo ?? atual.ciclo, periodoAtualFim: temPeriodo ? iso(fim) : atual.periodoAtualFim, emAtrasoDesde: null, canceladaEm: atual.canceladaEm, encerradaEm });
}

/** Cobrança aberta mais antiga (PENDING ou OVERDUE) com página de pagamento — o "checkout" a continuar. */
export function cobrancaEmAberto(pagamentos: readonly CobrancaProvedor[]) {
    return pagamentos
        .filter((p) => !p.deleted && (p.status === 'PENDING' || p.status === 'OVERDUE') && p.invoiceUrl)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
}
