import { z } from "zod";
import { cancelarOperacao, carregar, confirmarOperacao, type ContextoGate } from "./human-gate.ts";
import type { ModuloAcoesCompleto } from "./modulo.ts";
import { grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva } from "../flags.ts";
import { classificar, comEstabelecimento, pedidoInvalido, recursoDesativado, type DependenciasGateway, type PedidoGateway, type RespostaGateway } from "../gateway.ts";
import { InteligenciaError } from "../politica.ts";
import { novoRastreio } from "../rastreio.ts";

/**
 * Human Gate: confirmar ou cancelar um rascunho. Único caminho que executa uma ação CONFIRM.
 *
 * O corpo traz só o que o preview mostrou (operacaoId, versão, payloadHash) e a decisão do clique.
 * Tudo roda numa transação: prova do tenant, trava do rascunho (FOR UPDATE), revalidação, serviço de
 * domínio, marcação EXECUTADA. Qualquer falha desfaz a escrita inteira. Um retry (timeout na volta,
 * clique duplo) encontra EXECUTADA e recebe o resultado gravado, sem executar de novo.
 */
const HASH = z.string().regex(/^[0-9a-f]{64}$/);
const identificacao = { operacaoId: z.string().uuid(), versao: z.number().int().min(1).max(10_000) };
const pedidoSchema = z.discriminatedUnion("decisao", [
  z.object({ ...identificacao, payloadHash: HASH, decisao: z.literal("confirmar") }).strict(),
  // Cancelar também vale durante a coleta (COLETANDO), quando o rascunho ainda não tem payloadHash.
  z.object({ ...identificacao, payloadHash: z.union([HASH, z.literal("")]), decisao: z.literal("cancelar") }).strict(),
]);

const MENSAGEM_FALLBACK = "Não foi possível concluir agora. Nenhuma alteração de cadastro foi feita; tente de novo em instantes.";

/** Feature ACTIONS: o módulo vem da composição, já com as ações de todas as features instaladas. */
export type DependenciasOperacao = DependenciasGateway & { acoes: ModuloAcoesCompleto | null };

export async function atenderOperacao(pedido: PedidoGateway, deps: DependenciasOperacao): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio = novoRastreio("inteligencia.operacao", deps.requestId());
  rastreio.intencao = "HUMAN_GATE";
  try {
    // A flag do grupo da ação (ADMIN_ACTIONS, CONTRACT_IMPORT) é conferida depois de saber qual é a ação.
    if (!inteligenciaAtiva(deps.env)) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;
    deps = comEstabelecimento(deps, pedido, rastreio);
    let entrada: z.infer<typeof pedidoSchema>;
    try {
      entrada = pedidoSchema.parse(await pedido.lerCorpo());
    } catch (error) {
      pedidoInvalido(error);
    }
    if (!deps.acoes) throw new InteligenciaError("ACOES_INDISPONIVEIS", "As ações pelo Kidmais ainda não estão disponíveis neste ambiente.", 503);
    const modulo = deps.acoes;
    const resultado = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      const gate = modulo.gate;
      // B3: a autoridade vem do estado ATUAL, lido com a linha do usuário travada nesta transação
      // (provarTenant), nunca do papel carregado com a sessão antes dela. Sem papel atual ⇒ nega.
      const sessaoAtual = { usuario_id: sessao.usuario_id, papel: tenant.papelAtual ?? "" };
      const ctx: ContextoGate = { tx, tenant, sessao: sessaoAtual, correlationId: rastreio.requestId };
      const draft = await carregar(ctx, gate, entrada.operacaoId, true);
      rastreio.correlationId = draft.correlationId;
      const acao = modulo.registro.acao(draft.capacidade);
      if (!acao || acao.classe !== "CONFIRM") throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
      if (!grupoAtivo(deps.env, acao.grupo)) recursoDesativado();
      rastreio.capacidade = acao.capacidade;
      rastreio.ferramenta = acao.nome;
      rastreio.ferramentasSolicitadas = [acao.nome];
      // Flag e allowlist de AGORA, para a empresa comprovada: valem para confirmar E para cancelar.
      const comAutoridade = { ...ctx, flagAtiva: grupoAtivoParaEmpresa(deps.env, acao.grupo, tenant.empresaComprovada) };
      if (entrada.decisao === "cancelar") {
        const cancelado = await cancelarOperacao(acao, draft, entrada, comAutoridade, gate);
        rastreio.humanGate = "CANCELADO";
        return { resposta: cancelado.resposta, executou: false };
      }
      const confirmado = await confirmarOperacao(acao, draft, entrada, comAutoridade, gate);
      rastreio.humanGate = "CONFIRMADO";
      rastreio.politica = "PERMITIDO";
      if (confirmado.executou) rastreio.ferramentasExecutadas = [acao.nome];
      rastreio.estado = confirmado.repetida ? "repetida" : "executada";
      return { resposta: confirmado.resposta, executou: confirmado.executou };
    });
    return { status: 200, corpo: { ok: true, data: resultado.resposta } };
  } catch (error) {
    const falha = classificar(error, MENSAGEM_FALLBACK);
    rastreio.resultado = falha.resultado;
    rastreio.codigo = falha.codigo;
    rastreio.causa = error instanceof InteligenciaError && /^(CONFIRMACAO|OPERACAO)_/.test(error.code) ? "HUMAN_GATE" : falha.causa;
    if (rastreio.humanGate === null || rastreio.humanGate === "CONFIRMADO") rastreio.humanGate = "RECUSADO";
    rastreio.ferramentasExecutadas = [];
    rastreio.fallback = falha.fallback;
    return { status: falha.status, corpo: { ok: false, erro: falha.erro, codigo: falha.codigo } };
  } finally {
    rastreio.duracaoMs = Math.max(0, Math.round(relogio() - inicio));
    try {
      deps.registrar(rastreio);
    } catch {
      // O trace nunca derruba a resposta.
    }
  }
}
