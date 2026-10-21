/**
 * Encerramento com devolução pela tela Assinatura (L1, 21/10/2026): arrependimento em 7 dias (integral) e encerramento
 * antecipado do anual (proporcional). Só a Gestão, com senha confirmada há ≤ 5 min; exige a 089.
 *
 *   consultarEncerramento   opções e valores calculados AGORA a partir da cobrança paga lida no provedor (só leitura) e
 *                           os últimos pedidos (protocolos) da empresa;
 *   solicitarEncerramento   A. leitura curta (tenant)  B. leitura no provedor (cobranças)  C. transação curta (tenant) que
 *                           trava a assinatura, RECALCULA com o relógio do banco, confere o valor mostrado, grava o pedido
 *                           (protocolo) e ENCERRA o período pago na mesma transação (ENCERRADA, encerrada_em = agora →
 *                           60 dias de somente leitura). Daí em diante o pedido existe, qualquer que seja o provedor;
 *                           D. efeitos no provedor, cada um registrado no pedido: remoção da assinatura (sem repetir em
 *                           resultado desconhecido) e, só com ASSINATURA_ESTORNO_ATIVO=true e Pix/cartão, o estorno
 *                           (registro prévio EM_CURSO; resultado desconhecido → SEM_CONFIRMACAO, nunca repetido);
 *                           E. e-mail de confirmação (melhor esforço).
 * Sem a flag (padrão), o estorno fica AGUARDANDO_MANUAL: Felipe processa no painel do Asaas e registra a conclusão
 * (docs/CANCELAMENTO_DEVOLUCAO_20261021.md). A sincronização ignora a cobrança devolvida (sincronizacao.ts), então nem o
 * webhook nem a reconciliação reabrem o período ou alarmam por causa dela.
 */
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import type { EnviarEmail } from '../acessos/email.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { AsaasFalhou, type ClienteAsaas, type CobrancaProvedor, type ProvedorEstorno } from './asaas.ts';
import { STATUS_PAGO } from './provedor-estado.ts';
import { removerComResultado } from './reconciliacao-contratacao.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';
import { travarEmpresaComercial } from './ofertas.ts';
import { dataBrasilia, opcoesDeEncerramento, REGRA_DEVOLUCAO, type Opcoes, type PagamentoBase, type TipoDevolucao } from './devolucao-calculo.ts';
import { atualizarCancelamentoProvedor, chaveDoPedido, emailDoSolicitante, encerramentosInstalados, enviarConfirmacao, marcarEstornoEmCurso, mensagemConfirmacao,
    pedidoPorChave, pedidosDaEmpresa, registrarPedido, registrarResultadoEstorno, type CancelamentoProvedor, type PedidoResumo, type SituacaoEstorno } from './devolucao-registro.ts';

const GESTAO = 'REPRESENTANTE_AUTORIZADO';
/** Formas com estorno pela API (POST /payments/{id}/refund). Boleto exige dados bancários do pagador: sempre manual. */
const FORMAS_ESTORNO_API = new Set(['PIX', 'CREDIT_CARD']);

export type ProvedorDevolucao = Pick<ClienteAsaas, 'listarCobrancasDaAssinatura' | 'removerAssinatura'> & Partial<Pick<ProvedorEstorno, 'estornarCobranca'>>;
export type DepsDevolucao = {
    withTenantTransaction: <T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) => Promise<T>;
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    provedor: () => ProvedorDevolucao | null;
    env?: Record<string, string | undefined>;
    enviarEmail?: EnviarEmail | null;
};
export type Contexto = { requestId: string; ip?: string | null };

/** Chamada automática de estorno: desligada por padrão; só `true` liga. */
export const estornoAutomaticoLigado = (env: Record<string, string | undefined> = process.env) => env.ASSINATURA_ESTORNO_ATIVO?.trim() === 'true';

const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const naoInstalado = () => erroAcesso('COBRANCA_NAO_CONFIGURADA', 'O encerramento com devolução ainda não está disponível neste ambiente. Fale com o atendimento: contato@demerzellabs.com.br.', 503);

function exigirGestao(tenant: TenantComprovado) {
    if (tenant.papelAtual !== GESTAO)
        throw erroAcesso('COBRANCA_SEM_PERMISSAO', 'Somente a Gestão desta empresa cancela a assinatura ou pede devolução.', 403);
}

type Local = {
    empresaId: string; nome: string; situacao: string; ciclo: 'MENSAL' | 'ANUAL' | null; assinaturaId: string | null; provedorSituacao: string | null;
    periodoFim: string | null; agora: string;
    /** Confirmações locais da oferta (074a): pagamento → instante; usadas para a data de ativação e a "primeira ativação". */
    confirmacoes: { pagamentoId: string; confirmadaEm: string }[];
    devolucoesAnteriores: { cobrancaId: string | null }[];
};

async function lerLocal(tx: DbExecutor, empresaId: string, travar: boolean): Promise<Local | null> {
    if (travar) await travarEmpresaComercial(tx, empresaId);
    const a = (await tx.query<{ situacao: string; ciclo: 'MENSAL' | 'ANUAL' | null; provedor_assinatura_id: string | null; provedor_situacao: string | null;
        periodo_atual_fim: string | null; nome: string; agora: string }>(
        `SELECT a.situacao, a.ciclo, a.provedor_assinatura_id, a.provedor_situacao, ${ISO('a.periodo_atual_fim')} AS periodo_atual_fim, e.nome,
                ${ISO('clock_timestamp()')} AS agora
           FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id WHERE a.empresa_id = $1::uuid ${travar ? 'FOR UPDATE OF a' : ''}`, [empresaId])).rows[0];
    if (!a) return null;
    const planos = (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.assinatura_contratacoes') IS NOT NULL AS ok")).rows[0]?.ok === true;
    const confirmacoes = planos ? (await tx.query<{ pagamentoId: string; confirmadaEm: string }>(
        `SELECT pagamento_confirmacao_id AS "pagamentoId", ${ISO('confirmada_em')} AS "confirmadaEm" FROM assinatura_contratacoes
          WHERE empresa_id = $1::uuid AND estado = 'CONFIRMADA'`, [empresaId])).rows : [];
    const devolucoesAnteriores = (await tx.query<{ cobrancaId: string | null }>(
        `SELECT cobranca_provedor_id AS "cobrancaId" FROM assinatura_encerramentos WHERE empresa_id = $1::uuid AND tipo <> 'CANCELAMENTO_FIM_PERIODO'`, [empresaId])).rows;
    return { empresaId, nome: a.nome, situacao: a.situacao, ciclo: a.ciclo, assinaturaId: a.provedor_assinatura_id, provedorSituacao: a.provedor_situacao,
        periodoFim: a.periodo_atual_fim, agora: a.agora, confirmacoes, devolucoesAnteriores };
}

const pagas = (cobrancas: readonly CobrancaProvedor[]) => cobrancas.filter((c) => !c.deleted && STATUS_PAGO.has(c.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

/**
 * Cobrança paga que sustenta o período (a última paga) e a data de ativação: a mais tardia entre a confirmação no
 * provedor (confirmedDate/paymentDate) e a confirmação local da oferta — o acesso pago começa na liberação, nunca antes.
 */
export function pagamentoDoPeriodo(local: Pick<Local, 'confirmacoes'>, cobrancas: readonly CobrancaProvedor[]): { base: PagamentoBase; pagasNaAssinatura: number } | null {
    const lista = pagas(cobrancas);
    const ultima = lista.at(-1);
    if (!ultima) return null;
    const noProvedor = ultima.confirmedDate ?? ultima.paymentDate ?? ultima.dueDate;
    const local_ = local.confirmacoes.find((c) => c.pagamentoId === ultima.id);
    const localData = local_ ? dataBrasilia(Date.parse(local_.confirmadaEm)) : null;
    const dataAtivacao = localData && localData > noProvedor ? localData : noProvedor;
    return {
        base: { id: ultima.id, valorCentavos: ultima.valorCentavos ?? null, vencimento: ultima.dueDate, dataAtivacao, formaPagamento: ultima.billingType ?? null },
        pagasNaAssinatura: lista.length,
    };
}

function calcular(local: Local, cobrancas: readonly CobrancaProvedor[] | null, agora: number) {
    const periodo = cobrancas ? pagamentoDoPeriodo(local, cobrancas) : null;
    const base = periodo?.base ?? null;
    // Primeira ativação paga: a única cobrança paga desta assinatura, nenhuma oferta confirmada por OUTRO pagamento e
    // nenhum pedido de devolução anterior da empresa.
    const primeiraAtivacao = Boolean(base && periodo!.pagasNaAssinatura === 1 && local.devolucoesAnteriores.length === 0
        && local.confirmacoes.every((c) => c.pagamentoId === base.id));
    const opcoes = opcoesDeEncerramento({
        situacao: local.situacao, ciclo: local.ciclo, agora, pagamento: base, primeiraAtivacao,
        pedidoExistente: Boolean(base && local.devolucoesAnteriores.some((d) => d.cobrancaId === base.id)),
    });
    return { opcoes, base };
}

async function cobrancasDoProvedor(provedor: ProvedorDevolucao, assinaturaId: string) {
    try {
        return await provedor.listarCobrancasDaAssinatura(assinaturaId);
    }
    catch (error) {
        if (error instanceof AsaasFalhou)
            throw erroAcesso('COBRANCA_FALHOU', 'Não foi possível consultar o pagamento no provedor agora. Nada foi alterado; tente novamente em instantes.', 502);
        throw error;
    }
}

/** O id interno do pedido não sai para o navegador (o protocolo identifica o pedido). */
function semId(p: PedidoResumo): Omit<PedidoResumo, 'id'> {
    const copia: Partial<PedidoResumo> = { ...p };
    delete copia.id;
    return copia as Omit<PedidoResumo, 'id'>;
}

export type ConsultaEncerramento = {
    instalado: boolean; estornoAutomatico: boolean; situacao: string | null; ciclo: 'MENSAL' | 'ANUAL' | null;
    opcoes: Opcoes | null; formaPagamento: string | null; pedidos: Omit<PedidoResumo, 'id'>[];
};

/** `calcularOpcoes`: só então o provedor é consultado (a tela pede ao abrir as opções; o histórico não consulta). */
export async function consultarEncerramento(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: DepsDevolucao, calcularOpcoes = true): Promise<ConsultaEncerramento> {
    const env = deps.env ?? process.env;
    const local = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (!await encerramentosInstalados(tx)) return null;
        const l = await lerLocal(tx, tenant.empresaComprovada, false);
        return l ? { l, pedidos: await pedidosDaEmpresa(tx, tenant.empresaComprovada) } : null;
    });
    const vazio: ConsultaEncerramento = { instalado: local !== null, estornoAutomatico: estornoAutomaticoLigado(env), situacao: local?.l.situacao ?? null, ciclo: local?.l.ciclo ?? null,
        opcoes: null, formaPagamento: null, pedidos: (local?.pedidos ?? []).map(semId) };
    if (!local) return vazio;
    const provedor = deps.provedor();
    if (!calcularOpcoes || !provedor || !local.l.assinaturaId || !['ATIVA', 'CANCELADA_FIM_PERIODO'].includes(local.l.situacao)) return vazio;
    const { opcoes, base } = calcular(local.l, await cobrancasDoProvedor(provedor, local.l.assinaturaId), Date.parse(local.l.agora));
    return { ...vazio, opcoes, formaPagamento: base?.formaPagamento ?? null };
}

export type RespostaEncerramento = Omit<PedidoResumo, 'id'> & { repetido: boolean; estornoAutomatico: boolean };
const resposta = (p: PedidoResumo, repetido: boolean, estornoAutomatico: boolean): RespostaEncerramento => {
    const resto = semId(p);
    return { ...resto, repetido, estornoAutomatico };
};

export async function solicitarEncerramento(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown, ctx: Contexto, deps: DepsDevolucao): Promise<RespostaEncerramento> {
    const env = deps.env ?? process.env;
    const corpo = (raw ?? {}) as { tipo?: unknown; confirmar?: unknown; chave?: unknown; valorEsperadoCentavos?: unknown; motivo?: unknown };
    if (corpo.tipo !== 'ARREPENDIMENTO_7_DIAS' && corpo.tipo !== 'ENCERRAMENTO_ANUAL_PROPORCIONAL')
        throw erroAcesso('DADOS_INVALIDOS', 'Escolha o tipo de encerramento.', 400, { campo: 'tipo' });
    if (corpo.confirmar !== true)
        throw erroAcesso('DADOS_INVALIDOS', 'Confirme o encerramento.', 400, { campo: 'confirmar' });
    if (!Number.isSafeInteger(corpo.valorEsperadoCentavos) || (corpo.valorEsperadoCentavos as number) <= 0)
        throw erroAcesso('DADOS_INVALIDOS', 'Valor da devolução ausente: atualize a página.', 400, { campo: 'valorEsperadoCentavos' });
    const tipo: TipoDevolucao = corpo.tipo;
    const valorEsperado = corpo.valorEsperadoCentavos as number;
    const motivo = typeof corpo.motivo === 'string' ? corpo.motivo.trim().slice(0, 500) : '';
    const chave = chaveDoPedido(corpo.chave);
    exigirReautenticacaoRecente(sessao);
    const automatico = estornoAutomaticoLigado(env);

    // A. leitura curta; repetição da mesma chave devolve o pedido já registrado, sem nenhum efeito novo.
    const a = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (!await encerramentosInstalados(tx)) throw naoInstalado();
        const anterior = await pedidoPorChave(tx, tenant.empresaComprovada, chave);
        if (anterior) return { anterior, local: null };
        const l = await lerLocal(tx, tenant.empresaComprovada, false);
        if (!l?.assinaturaId) throw erroAcesso('CONFLITO', 'Não há assinatura paga para encerrar.', 409);
        return { anterior: null, local: l };
    });
    if (a.anterior) return resposta(a.anterior, true, automatico);
    const inicial = a.local!;
    const provedor = deps.provedor();
    if (!provedor) throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A cobrança on-line não está disponível neste ambiente. Fale com o atendimento: contato@demerzellabs.com.br.', 503);

    // B. provedor (só leitura), sem transação aberta.
    const cobrancas = await cobrancasDoProvedor(provedor, inicial.assinaturaId!);

    // C. trava, recalcula com o relógio do banco, grava o pedido e encerra o período pago.
    const c = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (tenant.empresaComprovada !== inicial.empresaId) throw erroAcesso('CONFLITO', 'A empresa da sessão mudou. Atualize a página.', 409);
        const anterior = await pedidoPorChave(tx, tenant.empresaComprovada, chave);
        if (anterior) return { anterior, novo: null };
        const l = await lerLocal(tx, tenant.empresaComprovada, true);
        if (!l || l.assinaturaId !== inicial.assinaturaId)
            throw erroAcesso('CONFLITO', 'A assinatura mudou durante o pedido. Atualize a página e confira as opções.', 409);
        const { opcoes, base } = calcular(l, cobrancas, Date.parse(l.agora));
        const opcao = tipo === 'ARREPENDIMENTO_7_DIAS' ? opcoes.arrependimento : opcoes.anualProporcional;
        if (!opcao.disponivel || !base)
            throw erroAcesso('CONFLITO', 'Esta opção não está disponível para a assinatura agora. Atualize a página para ver as opções atuais.', 409, { motivo: opcao.disponivel ? 'SEM_PAGAMENTO' : opcao.motivo });
        if (opcao.valorCentavos !== valorEsperado)
            throw erroAcesso('OFERTA_ALTERADA', 'O valor da devolução mudou desde que a tela foi aberta (por exemplo, virou o dia). Confira o novo valor e confirme de novo.', 409,
                { valorCentavos: opcao.valorCentavos });
        const pedido = await registrarPedido(tx, {
            empresaId: l.empresaId, tipo, chave, solicitadoPor: sessao.usuario_id, motivo: motivo || null, ciclo: l.ciclo, situacaoAnterior: l.situacao,
            provedorAssinaturaId: l.assinaturaId!, cancelamentoProvedor: l.provedorSituacao === 'DELETED' ? 'JA_REMOVIDA' : 'PENDENTE',
            devolucao: {
                regra: REGRA_DEVOLUCAO, cobrancaId: base.id, formaPagamento: base.formaPagamento, valorPagoCentavos: base.valorCentavos!, inicioCiclo: base.vencimento,
                dataAtivacao: base.dataAtivacao, diasCiclo: opcao.calculo?.diasCiclo ?? null, diasUtilizados: opcao.calculo?.diasUtilizados ?? null,
                valorDevolucaoCentavos: opcao.valorCentavos, prazoProcessamento: opcao.prazoProcessamento, periodoFimAnterior: l.periodoFim, acessoPagoEncerradoEm: l.agora,
            },
        });
        // O estorno antecipado encerra o período correspondente: ENCERRADA agora (68/74a aceitam ATIVA/CANCELADA → ENCERRADA).
        await tx.query(
            `UPDATE empresa_assinaturas SET situacao = 'ENCERRADA', encerrada_em = $2::timestamptz, periodo_atual_fim = $2::timestamptz,
                    cancelada_em = COALESCE(cancelada_em, $2::timestamptz), em_atraso_desde = NULL
              WHERE empresa_id = $1::uuid`, [l.empresaId, l.agora]);
        await auditarCobranca(tx, {
            acao: 'ASSINATURA_ENCERRADA_COM_DEVOLUCAO', empresaId: l.empresaId, origem: { tipo: 'GESTAO', usuarioId: sessao.usuario_id, requestId: ctx.requestId },
            ip: ctx.ip ?? null, justificativa: motivo || null,
            antes: { situacao: l.situacao, periodoAtualFim: l.periodoFim }, depois: { situacao: 'ENCERRADA', encerradaEm: l.agora, protocolo: pedido.protocolo, tipo },
        });
        return { anterior: null, novo: { pedido, local: l, para: await emailDoSolicitante(tx, sessao.usuario_id), forma: base.formaPagamento, valor: opcao.valorCentavos, cobrancaId: base.id } };
    });
    if (c.anterior) return resposta(c.anterior, true, automatico);
    const n = c.novo!;
    let pedido = n.pedido;
    const empresaId = n.local.empresaId;
    const gravar = async (trabalho: (tx: DbExecutor) => Promise<unknown>, oQue: string) => {
        try {
            await deps.withTransaction(trabalho);
            return true;
        }
        catch (error) {
            console.error(`[assinatura] ${oQue} não gravado no pedido (fica para conferência manual)`, error instanceof Error ? error.name : typeof error);
            return false;
        }
    };

    // D1. remoção da assinatura no provedor (uma tentativa; resultado desconhecido nunca é repetido aqui).
    if (pedido.cancelamentoProvedor === 'PENDENTE') {
        const r = await removerComResultado(provedor, n.local.assinaturaId!);
        const resultado: CancelamentoProvedor = r.resultado === 'CONFIRMADA' ? 'CONFIRMADO' : r.resultado === 'AUSENTE' ? 'AUSENTE' : r.resultado === 'RECUSADA' ? 'RECUSADO' : 'SEM_CONFIRMACAO';
        if (await gravar(async (tx) => {
            await atualizarCancelamentoProvedor(tx, empresaId, pedido.id, resultado);
            if (resultado === 'CONFIRMADO' || resultado === 'AUSENTE')
                await tx.query(`UPDATE empresa_assinaturas SET provedor_situacao = 'DELETED', sincronizado_em = clock_timestamp()
                    WHERE empresa_id = $1::uuid AND provedor_assinatura_id = $2`, [empresaId, n.local.assinaturaId]);
        }, 'resultado do cancelamento'))
            pedido = { ...pedido, cancelamentoProvedor: resultado };
    }

    // D2. estorno automático (flag, Pix/cartão); registro prévio antes da chamada.
    if (automatico && provedor.estornarCobranca && FORMAS_ESTORNO_API.has(n.forma ?? '')) {
        let marcado = false;
        await gravar(async (tx) => { marcado = await marcarEstornoEmCurso(tx, empresaId, pedido.id); }, 'registro prévio do estorno');
        if (marcado) {
            let situacao: Extract<SituacaoEstorno, 'SOLICITADO' | 'SEM_CONFIRMACAO' | 'RECUSADO'>;
            let status: string | null = null;
            try {
                status = (await provedor.estornarCobranca(n.cobrancaId, n.valor, `Kidmais Manager - devolucao ${pedido.protocolo}`)).status;
                situacao = 'SOLICITADO';
            }
            catch (error) {
                situacao = error instanceof AsaasFalhou && error.status !== null && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)
                    ? 'RECUSADO' : 'SEM_CONFIRMACAO';
            }
            pedido = { ...pedido, estorno: 'EM_CURSO' };
            if (await gravar((tx) => registrarResultadoEstorno(tx, empresaId, pedido.id, situacao, status), 'resultado do estorno'))
                pedido = { ...pedido, estorno: situacao };
        }
    }

    // E. confirmação por e-mail (o protocolo já está na resposta da tela).
    if (n.para)
        pedido = { ...pedido, email: await enviarConfirmacao(deps, empresaId,
            mensagemConfirmacao({ para: n.para, empresa: n.local.nome, pedido, periodoFim: null, estornoAutomatico: pedido.estorno === 'SOLICITADO' }), pedido.id) };
    return resposta(pedido, false, automatico);
}
