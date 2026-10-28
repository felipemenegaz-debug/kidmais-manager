import type { CobrancaProvedor } from './asaas.ts';
import type { Ciclo } from './configuracao.ts';
import { somarCiclo, STATUS_PAGO } from './provedor-estado.ts';
import type { Leitura } from './recuperacao-caso.ts';
import type { Caso, ModoRecuperacao } from './recuperacao-casos.ts';
import { semEfeito, type Fotografia, type Linha } from './recuperacao-efeitos.ts';
import type { Efeito } from './recuperacao-hash.ts';

/**
 * B-14 (plano rev. 8.1, §3.6.1, §4): recusas comerciais e classe de cada caso. Função pura sobre a proposta do inventário
 * (fotografia "antes", efeitos e leituras gravadas do provedor) e o retorno do serviço.
 *   - As recusas são aplicadas ANTES da classe; uma proposta com recusa nunca é RECONCILIADA.
 *   - JANELA: só as recusas do próprio serviço (a ferramenta segue as regras da candidata). RESTORE: também as da §4.
 *   - `SEM_EFEITO` (nada a gravar) ≠ RECONCILIADA (vínculo e coerência comprovados).
 */
export const CLASSES = ['RECONCILIADA', 'PROPOSTA', 'CORRELACIONADA_NAO_COMPROVADA', 'ORFA_CREDITOS', 'ORFA_ASSINATURA', 'INDETERMINADA'] as const;
export type Classe = (typeof CLASSES)[number];

export const RECUSAS = [
    'PERIODO_LOCAL_MAIOR',
    'QUEDA_SITUACAO',
    'DATA_DO_INSTANTE',
    'OFERTA_FUNDADOR',
    'ENCERRAMENTO_089_097',
    'ESTORNO_CHARGEBACK',
    'CREDITOS_ESTORNO_DISPUTA_DEVOLUCAO',
] as const;
export type Recusa = (typeof RECUSAS)[number] | `SERVICO:${string}` | `FALHA:${string}`;

/** Códigos de domínio da oferta/Fundador (ofertas.ts) que o serviço lança ao confirmar a oferta paga. */
const OFERTA = /^ERRO_INTERNO: (FUNDADOR_[A-Z_]+|PAGAMENTO_OFERTA_DIVERGENTE|OFERTA_[A-Z_]+)$/;
const ESTORNO_REMOTO = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);
/** Ordem de gravidade da situação comercial: subir na lista é queda (§4). */
const GRAVIDADE_SITUACAO: Record<string, number> = { TESTE: 0, ATIVA: 0, CANCELADA_FIM_PERIODO: 1, EM_ATRASO: 2, ENCERRADA: 3 };

export type EntradaClasse = {
    modo: ModoRecuperacao;
    /** Caso do inventário, ou item sem registro local (só RESTORE). */
    tipo: Caso['tipo'] | 'ORFA_CREDITOS' | 'ORFA_ASSINATURA' | 'INDETERMINADA';
    /** Id interno do caso (pedido, evento ou empresa). */
    id?: string;
    empresaId?: string | null;
    falha?: string | null;
    resultado?: unknown;
    antes?: Fotografia | null;
    efeitos?: readonly Efeito[];
    leituras?: readonly Leitura[];
    /** EVENTO: o objeto ligado (assinatura ou pedido) foi RECONCILIADA no próprio caso — calculado pelo inventário. */
    relacionadoReconciliado?: boolean;
};
export type Classificacao = { classe: Classe; recusas: Recusa[]; semEfeito: boolean; comprovado: boolean; motivo: string | null };

const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

/** Cobranças lidas do provedor (obterCobranca, listas por assinatura, referência ou data), sem repetição por id. */
export function cobrancasLidas(leituras: readonly Leitura[] = []): CobrancaProvedor[] {
    const porId = new Map<string, CobrancaProvedor>();
    const aceitar = (x: unknown) => {
        if (x && typeof x === 'object' && typeof (x as CobrancaProvedor).id === 'string' && typeof (x as CobrancaProvedor).status === 'string') porId.set((x as CobrancaProvedor).id, x as CobrancaProvedor);
    };
    for (const l of leituras) {
        if (l.metodo === 'obterAssinatura' || l.metodo === 'listarWebhooks' || l.metodo === 'listarAssinaturasPorReferencia') continue;
        const r = l.resultado as unknown;
        if (Array.isArray(r)) r.forEach(aceitar);
        else if (r && typeof r === 'object' && Array.isArray((r as { itens?: unknown }).itens)) (r as { itens: unknown[] }).itens.forEach(aceitar);
        else aceitar(r);
    }
    return [...porId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Fim do período pela última cobrança paga da assinatura lida (sem o `max` com o local que o serviço aplica). */
export function periodoCalculado(leituras: readonly Leitura[], ciclo: Ciclo | null): string | null {
    if (!ciclo) return null;
    const pagas = leituras.filter((l) => l.metodo === 'listarCobrancasDaAssinatura').flatMap((l) => (Array.isArray(l.resultado) ? l.resultado as CobrancaProvedor[] : []))
        .filter((p) => !p.deleted && STATUS_PAGO.has(p.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const ultima = pagas.at(-1);
    return ultima ? new Date(somarCiclo(ultima.dueDate, ciclo)).toISOString() : null;
}

const linhas = (f: Fotografia | null | undefined, tabela: string): Linha[] => f?.[tabela] ?? [];
const efeitosDe = (efeitos: readonly Efeito[], tabela: string) => efeitos.filter((e) => e.tabela === tabela);

function recusasDoServico(resultado: unknown): Recusa[] {
    if (!resultado || typeof resultado !== 'object') return [];
    const r = resultado as { resultado?: string; situacao?: string; recusa?: string | null; motivo?: string };
    if (r.recusa) return [`SERVICO:${r.recusa}`];
    if (r.resultado === 'RECUSADA' || r.resultado === 'SEM_CONFIRMACAO') return [`SERVICO:${r.motivo ?? r.resultado}`];
    if (r.situacao === 'IGNORADO' || r.situacao === 'FALHOU') return [`SERVICO:${r.motivo ?? r.situacao}`];
    // Pedido: revisão, estorno e disputa do serviço (ex.: CREDITO_VENCIDO_NA_RECUPERACAO) ficam marcados para a decisão.
    if (r.resultado === 'REVISAO' || r.resultado === 'ESTORNO' || r.resultado === 'DISPUTA') return [`SERVICO:${r.motivo ?? r.resultado}`];
    return [];
}

/** Recusas comerciais da §4 (só RESTORE). */
function recusasDoRestore(e: EntradaClasse): Recusa[] {
    const r = new Set<Recusa>();
    const efeitos = e.efeitos ?? [];
    const assinatura = linhas(e.antes, 'empresa_assinaturas')[0];
    // Período local maior que o calculado pela última cobrança paga: o `max` do serviço preservaria um período sem pagamento.
    if (assinatura) {
        const calculado = periodoCalculado(e.leituras ?? [], (assinatura.ciclo as Ciclo | null) ?? null);
        if (calculado && ms(assinatura.periodo_atual_fim) > ms(calculado)) r.add('PERIODO_LOCAL_MAIOR');
    }
    for (const ef of efeitosDe(efeitos, 'empresa_assinaturas')) {
        const s = ef.colunas.situacao;
        if (s && (GRAVIDADE_SITUACAO[String(s.depois)] ?? 9) > (GRAVIDADE_SITUACAO[String(s.antes)] ?? 9)) r.add('QUEDA_SITUACAO');
        // Datas que nasceriam do instante atual: cancelamento novo; encerramento novo que não é o fim do período.
        if (ef.colunas.cancelada_em && ef.colunas.cancelada_em.antes === null && ef.colunas.cancelada_em.depois !== null) r.add('DATA_DO_INSTANTE');
        const fim = ef.colunas.periodo_atual_fim?.depois ?? assinatura?.periodo_atual_fim ?? null;
        const enc = ef.colunas.encerrada_em;
        if (enc && enc.antes === null && enc.depois !== null && ms(enc.depois) !== ms(fim)) r.add('DATA_DO_INSTANTE');
    }
    if (e.falha && OFERTA.test(e.falha)) r.add('OFERTA_FUNDADOR');
    if (linhas(e.antes, 'assinatura_encerramentos').length || linhas(e.antes, 'assinatura_arrependimentos').length
        || efeitosDe(efeitos, 'assinatura_encerramentos').length || efeitosDe(efeitos, 'assinatura_arrependimentos').length) r.add('ENCERRAMENTO_089_097');
    if (cobrancasLidas(e.leituras).some((p) => ESTORNO_REMOTO.has(p.status) || (p.estornos?.length ?? 0) > 0)) r.add('ESTORNO_CHARGEBACK');
    const cobrancasCredito = [...linhas(e.antes, 'ia_credito_cobrancas'), ...efeitosDe(efeitos, 'ia_credito_cobrancas').map((x) => Object.fromEntries(Object.entries(x.colunas).map(([c, v]) => [c, v.depois])))];
    if (linhas(e.antes, 'ia_credito_devolucoes').length || efeitosDe(efeitos, 'ia_credito_devolucoes').length
        || cobrancasCredito.some((c) => Number(c.estornado_centavos ?? 0) > 0 || (c.disputa !== undefined && c.disputa !== 'NENHUMA')))
        r.add('CREDITOS_ESTORNO_DISPUTA_DEVOLUCAO');
    return [...r];
}

/**
 * Vínculo e coerência comprovados (§3.6.1). Devolve null quando comprovado; senão o motivo. SEM_EFEITO e ids coincidentes
 * não bastam (revisão de 27/10, P1-2/P2-3): ausência de linha, conclusão anterior ou lista vazia nunca viram prova.
 *   - EMPRESA: sincronizada; assinatura lida = a gravada; toda cobrança lida pela assinatura pertence a ela.
 *   - EVENTO: o evento existe, já estava PROCESSADO (IGNORADO e inexistente não provam nada) e o objeto ligado (assinatura ou
 *     pedido) foi comprovado no próprio caso dele (`relacionadoReconciliado`, dado pelo inventário).
 *   - PEDIDO: `coerenciaDoPedido`.
 */
function naoComprovado(e: EntradaClasse, contexto?: { ambiente: string; conta: string }): string | null {
    const r = (e.resultado ?? {}) as { resultado?: string; situacao?: string; motivo?: string };
    if (e.tipo === 'EMPRESA') {
        if (r.resultado !== 'SINCRONIZADA') return `SERVICO_${r.resultado ?? 'SEM_RESULTADO'}`;
        const assinatura = (e.leituras ?? []).find((l) => l.metodo === 'obterAssinatura')?.resultado as { id?: string } | null | undefined;
        const local = linhas(e.antes, 'empresa_assinaturas')[0];
        if (!assinatura?.id || !local || local.provedor_assinatura_id !== assinatura.id) return 'ASSINATURA_NAO_COMPROVADA';
        const listas = (e.leituras ?? []).filter((l) => l.metodo === 'listarCobrancasDaAssinatura');
        if (!listas.length || !listas.every((l) => Array.isArray(l.resultado) && (l.resultado as CobrancaProvedor[]).every((p) => !p.assinaturaId || p.assinaturaId === assinatura.id)))
            return 'COBRANCAS_DA_ASSINATURA_NAO_COMPROVADAS';
        return null;
    }
    if (e.tipo === 'EVENTO') {
        const ev = linhas(e.antes, 'cobranca_eventos').find((l) => l.id === e.id);
        if (!ev) return 'EVENTO_INEXISTENTE';
        if (ev.situacao !== 'PROCESSADO') return `EVENTO_${String(ev.situacao)}`;
        return e.relacionadoReconciliado === true ? null : 'OBJETO_DO_EVENTO_NAO_COMPROVADO';
    }
    // Cobrança não canônica (duplicidade): nunca comprovada automaticamente; o excedente é decisão da pessoa (P2-1, incremento 4).
    if (e.tipo === 'COBRANCA') return 'COBRANCA_NAO_CANONICA';
    if (e.tipo !== 'PEDIDO') return 'TIPO_SEM_COMPROVACAO';
    if (!contexto) return 'SEM_CONTEXTO_DE_CREDITOS';
    if (!r.resultado || ['REVISAO', 'ESTORNO', 'DISPUTA'].includes(r.resultado) || r.motivo) return `SERVICO_${r.motivo ?? r.resultado ?? 'SEM_RESULTADO'}`;
    return coerenciaDoPedido(e, contexto);
}

const n = (v: unknown) => Number(v ?? 0);
/** Variação dos contadores do lote por lançamento (mesma tabela de ledger.ts: disponível, reservado, bloqueado, consumido, expirado, cancelado). */
const NO_LOTE: Record<string, readonly number[]> = {
    CREDITO: [0, 0, 0, 0, 0, 0], RESERVA: [-1, 1, 0, 0, 0, 0], LIBERACAO: [1, -1, 0, 0, 0, 0], CONSUMO: [0, -1, 0, 1, 0, 0],
    BLOQUEIO: [-1, 0, 1, 0, 0, 0], DESBLOQUEIO: [1, 0, -1, 0, 0, 0], EXPIRACAO: [-1, 0, 0, 0, 1, 0], REVERSAO: [0, 0, -1, 0, 0, 1],
};
const CONTADORES = ['disponivel', 'reservado', 'bloqueado', 'consumido', 'expirado', 'cancelado'] as const;

/**
 * Coerência de um pedido de créditos (§3.6.1), toda sobre a fotografia do inventário e as leituras gravadas:
 *   - o pedido existe; tem exatamente uma cobrança, canônica, lida no provedor com o mesmo id, conta e ambiente; o status
 *     local é o lido; sem estorno, disputa ou devolução (esses nunca são comprovados automaticamente);
 *   - estado estável coerente com o status remoto: CREDITADO ⇔ pago; AGUARDANDO_PAGAMENTO ⇔ PENDING; VENCIDO ⇔ OVERDUE;
 *     ENCERRADO ⇔ removida; qualquer outro estado (criação, revisão, falha) não é comprovável;
 *   - CREDITADO: um lote do pedido com a quantidade do pedido, um único CREDITO dessa quantidade, contadores do lote iguais à
 *     reconstrução pelos lançamentos e carteira do recurso igual à soma dos lotes; demais estados: nenhum lote.
 */
export function coerenciaDoPedido(e: EntradaClasse, contexto: { ambiente: string; conta: string }): string | null {
    const pedido = linhas(e.antes, 'ia_credito_pedidos').find((l) => l.id === e.id);
    if (!pedido) return 'PEDIDO_INEXISTENTE';
    const cobrancas = linhas(e.antes, 'ia_credito_cobrancas').filter((c) => c.pedido_id === e.id);
    if (!cobrancas.length) return 'SEM_COBRANCA';
    if (cobrancas.length > 1 || cobrancas[0].canonica !== true) return 'COBRANCA_NAO_CANONICA';
    const c = cobrancas[0];
    if (c.ambiente !== contexto.ambiente || c.conta !== contexto.conta) return 'CONTA_OU_AMBIENTE_DIVERGENTE';
    const remoto = cobrancasLidas(e.leituras).find((p) => p.id === c.pagamento_id);
    if (!remoto) return 'COBRANCA_NAO_LIDA';
    if (c.situacao_provedor !== remoto.status) return 'STATUS_LOCAL_DIVERGENTE';
    if (n(c.estornado_centavos) > 0 || (c.disputa ?? 'NENHUMA') !== 'NENHUMA' || (remoto.estornos?.length ?? 0) > 0 || ESTORNO_REMOTO.has(remoto.status))
        return 'ESTORNO_OU_DISPUTA';
    if (linhas(e.antes, 'ia_credito_devolucoes').some((d) => d.pedido_id === e.id)) return 'DEVOLUCAO';
    const lotes = linhas(e.antes, 'ia_credito_lotes').filter((l) => l.pedido_id === e.id);
    const pago = !remoto.deleted && (remoto.status === 'RECEIVED' || remoto.status === 'CONFIRMED');
    switch (pedido.estado) {
        case 'CREDITADO': {
            if (!pedido.creditado_em || !pago) return 'CREDITADO_SEM_PAGAMENTO';
            if (lotes.length !== 1) return 'CREDITADO_SEM_LOTE';
            const lote = lotes[0];
            if (n(lote.quantidade) !== n(pedido.quantidade) || lote.recurso !== pedido.recurso) return 'LOTE_DIVERGENTE_DO_PEDIDO';
            const lancamentos = linhas(e.antes, 'ia_credito_lancamentos').filter((l) => l.lote_id === lote.id);
            const creditos = lancamentos.filter((l) => l.tipo === 'CREDITO');
            if (creditos.length !== 1 || n(creditos[0].quantidade) !== n(lote.quantidade)) return 'LANCAMENTO_DE_CREDITO_DIVERGENTE';
            const reconstruido = [n(lote.quantidade), 0, 0, 0, 0, 0];
            for (const l of lancamentos) {
                const d = NO_LOTE[String(l.tipo)];
                if (!d) return 'LANCAMENTO_DESCONHECIDO';
                d.forEach((x, i) => { reconstruido[i] += x * n(l.quantidade); });
            }
            if (CONTADORES.some((k, i) => n(lote[k]) !== reconstruido[i])) return 'LOTE_DIVERGENTE_DOS_LANCAMENTOS';
            const carteira = linhas(e.antes, 'ia_credito_carteiras').find((w) => w.recurso === lote.recurso);
            if (!carteira) return 'SEM_CARTEIRA';
            const doRecurso = linhas(e.antes, 'ia_credito_lotes').filter((l) => l.recurso === lote.recurso);
            const soma = (k: string) => doRecurso.reduce((t, l) => t + n(l[k]), 0);
            if (n(carteira.saldo) !== soma('disponivel') + soma('reservado') + soma('bloqueado') || n(carteira.reservado) !== soma('reservado')
                || n(carteira.bloqueado) !== soma('bloqueado'))
                return 'CARTEIRA_DIVERGENTE_DOS_LOTES';
            return null;
        }
        case 'AGUARDANDO_PAGAMENTO':
            return remoto.status === 'PENDING' && !remoto.deleted && !lotes.length && !pedido.creditado_em ? null : 'AGUARDANDO_INCOERENTE';
        case 'VENCIDO':
            return remoto.status === 'OVERDUE' && !remoto.deleted && !lotes.length && !pedido.creditado_em ? null : 'VENCIDO_INCOERENTE';
        case 'ENCERRADO':
            return remoto.deleted && !lotes.length && !pedido.creditado_em ? null : 'ENCERRADO_INCOERENTE';
        default:
            return `ESTADO_NAO_COMPROVAVEL_${String(pedido.estado)}`;
    }
}

export function classificar(e: EntradaClasse, contexto?: { ambiente: string; conta: string }): Classificacao {
    if (e.tipo === 'ORFA_CREDITOS' || e.tipo === 'ORFA_ASSINATURA' || e.tipo === 'INDETERMINADA') {
        if (e.modo !== 'RESTORE') throw new Error(`Classe ${e.tipo} só existe no RESTORE.`);
        return { classe: e.tipo, recusas: [], semEfeito: false, comprovado: false, motivo: e.tipo };
    }
    const recusas: Recusa[] = [];
    if (e.falha) recusas.push(`FALHA:${e.falha}`);
    recusas.push(...recusasDoServico(e.resultado));
    if (e.modo === 'RESTORE') recusas.push(...recusasDoRestore(e));
    const unicas = [...new Set(recusas)].sort();
    const nada = !e.falha && semEfeito(e.efeitos ?? []);
    const falta = e.falha ? 'FALHA' : naoComprovado(e, contexto);
    const ok = falta === null;
    // Efeito a gravar → PROPOSTA (JANELA grava; RESTORE vai para Felipe), com as recusas marcadas para a decisão.
    if (!e.falha && !nada) return { classe: 'PROPOSTA', recusas: unicas, semEfeito: false, comprovado: ok, motivo: unicas[0] ?? null };
    if (unicas.length || !ok) return { classe: 'CORRELACIONADA_NAO_COMPROVADA', recusas: unicas, semEfeito: nada, comprovado: ok, motivo: unicas[0] ?? `NAO_COMPROVADO:${falta}` };
    return { classe: 'RECONCILIADA', recusas: [], semEfeito: true, comprovado: true, motivo: null };
}
