import type { DbExecutor } from "../../db/contracts.ts";
import type { TenantComprovado } from "../../saas/provar-tenant.ts";
import type { AIResponse, HumanGateDraft, RascunhoPublico } from "../contratos.ts";
import { InteligenciaError, autorizarAcao } from "../politica.ts";
import { exigirPolitica, type CaminhoPolitica } from "../politica-v1.ts";
import { manifestoAcao } from "../registro-ferramentas.ts";
import { hashPayload } from "./hash.ts";
import type { ContextoAcao, FerramentaAcao, RepositorioOperacoes } from "./tipos.ts";

/**
 * Motor do Human Gate.
 *
 * rascunho (COLETANDO) → pergunta só o que falta → preview (AGUARDANDO_CONFIRMACAO, payloadHash, expiraEm)
 * → clique humano → confirmação revalida TUDO na mesma transação da escrita:
 *   tenant (já reprovado pela rota) · RBAC atual · flag · estado · expiração · versão · hash · schema ·
 *   pré-condições do domínio → serviço de domínio → EXECUTADA (CAS).
 *
 * Nada aqui é chamado pelo modelo. Texto livre só produz/edita rascunho; confirmar exige operacaoId,
 * versão e hash devolvidos no preview, enviados pelo clique.
 */
export const TTL_COLETA_SEGUNDOS = 30 * 60;
export const TTL_CONFIRMACAO_PADRAO = 10 * 60;

/** Erro de validação que devolve a pergunta ao operador, limpando os campos inválidos. */
export class ErroCampo extends InteligenciaError {
  readonly campos: readonly string[];
  constructor(campos: readonly string[], mensagem: string) {
    super("DADOS_INVALIDOS", mensagem, 422);
    this.name = "ErroCampo";
    this.campos = campos;
  }
}

export type DependenciasHumanGate = {
  repositorio: RepositorioOperacoes;
  agora(): Date;
  novoId(): string;
  ttlConfirmacaoSegundos: number;
};

/** Mesmo formato do `ContextoExtensao` do CORE: a conversa passa o dela direto. */
export type ContextoGate = {
  tx: DbExecutor;
  tenant: TenantComprovado;
  sessao: { usuario_id: string; papel: string };
  correlationId: string;
};

function somarSegundos(data: Date, segundos: number) {
  return new Date(data.getTime() + segundos * 1000).toISOString();
}

/** RBAC do gate: papel da membership comprovada NESTA transação (056/F1), nunca o papel global da sessão. */
function papelNaEmpresa(ctx: ContextoGate) {
  return { papel: ctx.tenant.papelAtual };
}

/**
 * Autoridade AGORA, em cada passo (abrir, responder, confirmar, cancelar): papel da membership comprovada, classe,
 * manifesto do Tool Registry, origem e flag. Nada do que foi aprovado antes vale como autorização permanente.
 */
function autorizarNoGate(ctx: ContextoGate, acao: FerramentaAcao, caminho: CaminhoPolitica, flagNaEmpresa: boolean | null) {
  autorizarAcao(papelNaEmpresa(ctx), acao);
  exigirPolitica({
    papel: ctx.tenant.papelAtual,
    manifesto: manifestoAcao({ ferramenta: acao.nome, capacidade: acao.capacidade, classe: acao.classe, grupo: acao.grupo, papeis: acao.papeis }),
    caminho,
    origem: "HUMAN_GATE",
    grupoAtivo: true,
    grupoAtivoNaEmpresa: flagNaEmpresa,
  });
}

function contextoAcao(draft: HumanGateDraft, ctx: ContextoGate): ContextoAcao {
  return { usuarioId: ctx.sessao.usuario_id, operacaoId: draft.operacaoId, correlationId: draft.correlationId };
}

export function publico(acao: FerramentaAcao, draft: HumanGateDraft, avisos: string[] = []): RascunhoPublico {
  return {
    operacaoId: draft.operacaoId,
    capacidade: draft.capacidade,
    estado: draft.estado,
    versao: draft.versao,
    payloadHash: draft.payloadHash,
    expiraEm: draft.expiraEm,
    titulo: acao.titulo,
    campos: acao.apresentar(draft.payload),
    avisos,
  };
}

type Avanco = { draft: HumanGateDraft; resposta: AIResponse };

/** Leva o rascunho ao próximo passo: próxima pergunta, ou preview validado e verificado no domínio. */
async function avancar(acao: FerramentaAcao, draft: HumanGateDraft, ctx: ContextoGate, deps: DependenciasHumanGate, prefixo = ""): Promise<Avanco> {
  const agora = deps.agora();
  const perguntar = (d: HumanGateDraft, prefixoPergunta: string): Avanco => {
    const faltando = acao.faltando(d.payload);
    const campo = acao.campos.find((c) => c.id === faltando[0]);
    const coletando: HumanGateDraft = { ...d, estado: "COLETANDO", payloadHash: "", expiraEm: somarSegundos(agora, TTL_COLETA_SEGUNDOS), atualizadoEm: agora.toISOString() };
    return {
      draft: coletando,
      resposta: { tipo: "rascunho", rascunho: publico(acao, coletando), pergunta: `${prefixoPergunta}${campo?.pergunta ?? "Complete os dados do rascunho."}`, faltando },
    };
  };
  if (acao.faltando(draft.payload).length) return perguntar(draft, prefixo);
  try {
    const validado = acao.validar(draft.payload);
    const verificado = await acao.verificar(ctx.tx, ctx.tenant, validado, contextoAcao(draft, ctx));
    // O preview só é mostrado se o payload enriquecido também passa no schema: o que se vê é confirmável.
    const payload = acao.validar(verificado.payload as Record<string, unknown>) as Record<string, unknown>;
    const pronto: HumanGateDraft = {
      ...draft,
      payload,
      estado: "AGUARDANDO_CONFIRMACAO",
      expiraEm: somarSegundos(agora, acao.revisao?.ttlSegundos ?? deps.ttlConfirmacaoSegundos),
      atualizadoEm: agora.toISOString(),
      payloadHash: hashPayload({ capacidade: draft.capacidade, ferramenta: draft.ferramenta, empresaId: draft.empresaId, usuarioId: draft.usuarioId, versao: draft.versao, payload }),
    };
    return { draft: pronto, resposta: { tipo: "preview", rascunho: publico(acao, pronto, verificado.avisos) } };
  } catch (erro) {
    if (!(erro instanceof ErroCampo)) throw erro;
    const limpo = { ...draft.payload };
    for (const campo of erro.campos) delete limpo[campo];
    return perguntar({ ...draft, payload: limpo }, `${erro.message} `);
  }
}

export async function iniciarRascunho(acao: FerramentaAcao, texto: string, ctx: ContextoGate, deps: DependenciasHumanGate): Promise<Avanco> {
  if (acao.origem === "TELA") throw new InteligenciaError("ACAO_SOMENTE_TELA", "Esta ação começa pela tela correspondente.", 409);
  return abrir(acao, acao.extrair(texto, null), ctx, deps);
}

/** Fluxos de tela (ex.: importação) abrem o gate com o payload montado pela própria tela. */
export async function iniciarRascunhoComPayload(acao: FerramentaAcao, payload: Record<string, unknown>, ctx: ContextoGate, deps: DependenciasHumanGate): Promise<Avanco> {
  return abrir(acao, payload, ctx, deps);
}

async function abrir(acao: FerramentaAcao, payloadInicial: Record<string, unknown>, ctx: ContextoGate, deps: DependenciasHumanGate): Promise<Avanco> {
  autorizarNoGate(ctx, acao, "HUMAN_GATE", null);
  if (!await deps.repositorio.disponivel(ctx.tx)) {
    throw new InteligenciaError("ACOES_INDISPONIVEIS", "As ações pelo Kidmais ainda não estão disponíveis neste ambiente.", 503);
  }
  const agora = deps.agora().toISOString();
  const operacaoId = deps.novoId();
  const inicial: HumanGateDraft = {
    operacaoId,
    correlationId: ctx.correlationId,
    idempotencyKey: operacaoId,
    capacidade: acao.capacidade,
    ferramenta: acao.nome,
    empresaId: ctx.tenant.empresaComprovada,
    usuarioId: ctx.sessao.usuario_id,
    estado: "COLETANDO",
    versao: 1,
    payload: payloadInicial,
    payloadHash: "",
    expiraEm: agora,
    criadoEm: agora,
    atualizadoEm: agora,
    resultado: null,
  };
  const avanco = await avancar(acao, inicial, ctx, deps);
  await deps.repositorio.criar(ctx.tx, avanco.draft);
  return avanco;
}

export async function carregar(ctx: ContextoGate, deps: DependenciasHumanGate, operacaoId: string, travar: boolean) {
  const draft = await deps.repositorio.buscar(ctx.tx, { operacaoId, empresaId: ctx.tenant.empresaComprovada, usuarioId: ctx.sessao.usuario_id }, travar);
  // Outra empresa, outra pessoa ou inexistente: mesma resposta.
  if (!draft) throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
  return draft;
}

function expirado(draft: HumanGateDraft, agora: Date) {
  return Date.parse(draft.expiraEm) <= agora.getTime();
}

/** Resposta do operador a uma pergunta, ou edição de um campo depois do preview (gera nova versão). */
export async function responderRascunho(acao: FerramentaAcao, draft: HumanGateDraft, texto: string, ctx: ContextoGate, deps: DependenciasHumanGate): Promise<Avanco> {
  autorizarNoGate(ctx, acao, "HUMAN_GATE", null);
  if (draft.estado !== "COLETANDO" && draft.estado !== "AGUARDANDO_CONFIRMACAO") {
    throw new InteligenciaError("OPERACAO_ENCERRADA", "Este rascunho já foi encerrado. Comece um novo pedido.", 409);
  }
  if (expirado(draft, deps.agora())) throw new InteligenciaError("OPERACAO_EXPIRADA", "Este rascunho expirou. Comece um novo pedido.", 409);
  const perguntado = acao.faltando(draft.payload)[0] ?? null;
  const novos = acao.extrair(texto, perguntado);
  const semNovidade = Object.keys(novos).length === 0;
  const atualizado: HumanGateDraft = { ...draft, payload: { ...draft.payload, ...novos }, versao: draft.versao + 1 };
  const avanco = await avancar(acao, atualizado, ctx, deps, semNovidade ? "Não consegui entender a resposta. " : "");
  if (!await deps.repositorio.atualizar(ctx.tx, avanco.draft, { versao: draft.versao, estado: draft.estado })) {
    throw new InteligenciaError("OPERACAO_CONCORRENTE", "O rascunho mudou em outra aba. Atualize e tente de novo.", 409);
  }
  return avanco;
}

export type PedidoConfirmacao = { versao: number; payloadHash: string };

export type ResultadoConfirmacao = { draft: HumanGateDraft; resposta: AIResponse; repetida: boolean; executou: boolean };

/**
 * Confirmação humana. `draft` já vem travado (FOR UPDATE) pela mesma transação da escrita.
 * `flagAtiva` é reavaliada pela rota para o tenant comprovado agora.
 */
export async function confirmarOperacao(
  acao: FerramentaAcao,
  draft: HumanGateDraft,
  pedido: PedidoConfirmacao,
  ctx: ContextoGate & { flagAtiva: boolean },
  deps: DependenciasHumanGate,
): Promise<ResultadoConfirmacao> {
  // Tudo de AGORA, antes de qualquer caminho (inclusive o replay): uma aprovação antiga não concede
  // autoridade permanente. Tenant e dono do rascunho, Policy + RBAC, flag e allowlist da empresa.
  if (draft.empresaId !== ctx.tenant.empresaComprovada || draft.usuarioId !== ctx.sessao.usuario_id) {
    throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
  }
  autorizarNoGate(ctx, acao, "CONFIRMACAO", null);
  if (!ctx.flagAtiva) throw new InteligenciaError("INTELIGENCIA_DESATIVADA", "Kidmais Intelligence indisponível neste ambiente.", 503);
  // Aprovação pela revisão oficial (ex.: contratação): o clique do chat nunca executa — um só caminho de escrita.
  if (acao.revisao) throw new InteligenciaError("CONFIRMAR_NA_REVISAO", "Esta proposta é concluída na revisão oficial, não pelo chat.", 409);
  // Replay (clique duplo, retry após timeout): devolve o resultado gravado, sem executar de novo.
  if (draft.estado === "EXECUTADA") {
    if (draft.versao !== pedido.versao || draft.payloadHash !== pedido.payloadHash) {
      throw new InteligenciaError("CONFIRMACAO_INVALIDA", "Esta confirmação não corresponde à ação executada.", 409);
    }
    const resultado = draft.resultado as { mensagem?: string; destino?: string } | null;
    return { draft, repetida: true, executou: false, resposta: { tipo: "resultado_acao", rascunho: publico(acao, draft), mensagem: resultado?.mensagem ?? "Ação já concluída.", ...(resultado?.destino ? { destino: resultado.destino } : {}) } };
  }
  if (draft.estado !== "AGUARDANDO_CONFIRMACAO") {
    throw new InteligenciaError("CONFIRMACAO_INVALIDA", "Este rascunho não está pronto para confirmação.", 409);
  }
  const agora = deps.agora();
  if (expirado(draft, agora)) throw new InteligenciaError("CONFIRMACAO_EXPIRADA", "A confirmação expirou. Revise o rascunho de novo.", 409);
  if (draft.versao !== pedido.versao || draft.payloadHash !== pedido.payloadHash) {
    throw new InteligenciaError("CONFIRMACAO_DESATUALIZADA", "O rascunho mudou depois da revisão. Confira o preview de novo.", 409);
  }
  const esperado = hashPayload({ capacidade: draft.capacidade, ferramenta: draft.ferramenta, empresaId: draft.empresaId, usuarioId: draft.usuarioId, versao: draft.versao, payload: draft.payload });
  if (esperado !== draft.payloadHash || draft.capacidade !== acao.capacidade || draft.ferramenta !== acao.nome) {
    throw new InteligenciaError("CONFIRMACAO_INVALIDA", "O rascunho não passou na verificação de integridade.", 409);
  }

  let validado;
  try {
    validado = acao.validar(draft.payload);
  } catch {
    throw new InteligenciaError("CONFIRMACAO_INVALIDA", "O rascunho deixou de ser válido. Revise de novo.", 409);
  }
  const contexto = contextoAcao(draft, ctx);
  let verificado;
  try {
    verificado = await acao.verificar(ctx.tx, ctx.tenant, validado, contexto);
  } catch (erro) {
    if (erro instanceof ErroCampo) throw new InteligenciaError("CONFIRMACAO_DESATUALIZADA", `${erro.message} Revise o rascunho de novo.`, 409);
    throw erro;
  }
  // O estado do domínio mudou entre o preview e o clique: a confirmação vale para o que foi visto, não para o novo.
  if (hashPayload({ capacidade: draft.capacidade, ferramenta: draft.ferramenta, empresaId: draft.empresaId, usuarioId: draft.usuarioId, versao: draft.versao, payload: verificado.payload as Record<string, unknown> }) !== draft.payloadHash) {
    throw new InteligenciaError("CONFIRMACAO_DESATUALIZADA", "Os dados mudaram desde a revisão. Confira o preview de novo.", 409);
  }
  const resultado = await acao.executar(ctx.tx, ctx.tenant, verificado.payload, contexto);
  const executada: HumanGateDraft = {
    ...draft,
    estado: "EXECUTADA",
    atualizadoEm: agora.toISOString(),
    resultado: { entidadeId: resultado.entidadeId, mensagem: resultado.mensagem, ...(resultado.destino ? { destino: resultado.destino } : {}) },
  };
  if (!await deps.repositorio.atualizar(ctx.tx, executada, { versao: draft.versao, estado: "AGUARDANDO_CONFIRMACAO" })) {
    // A transação inteira é desfeita pela rota: a escrita de domínio não fica sem registro.
    throw new InteligenciaError("OPERACAO_CONCORRENTE", "A operação mudou durante a confirmação. Nenhuma alteração foi feita.", 409);
  }
  return { draft: executada, repetida: false, executou: true, resposta: { tipo: "resultado_acao", rascunho: publico(acao, executada), mensagem: resultado.mensagem, ...(resultado.destino ? { destino: resultado.destino } : {}) } };
}

/**
 * Cancelamento (B4): mesma autoridade ATUAL da confirmação (dono e tenant, Policy + RBAC do papel atual,
 * flag e allowlist da empresa) e a versão/hash que o operador está vendo. Payload antigo nunca cancela uma
 * versão mais nova; repetir o MESMO cancelamento válido é idempotente.
 */
export async function cancelarOperacao(acao: FerramentaAcao, draft: HumanGateDraft, pedido: PedidoConfirmacao, ctx: ContextoGate & { flagAtiva: boolean }, deps: DependenciasHumanGate): Promise<Avanco> {
  if (draft.empresaId !== ctx.tenant.empresaComprovada || draft.usuarioId !== ctx.sessao.usuario_id) {
    throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
  }
  autorizarNoGate(ctx, acao, "HUMAN_GATE", null);
  if (!ctx.flagAtiva) throw new InteligenciaError("INTELIGENCIA_DESATIVADA", "Kidmais Intelligence indisponível neste ambiente.", 503);
  // COLETANDO ainda não tem hash ("" nos dois lados); AGUARDANDO_CONFIRMACAO e CANCELADA têm o do preview.
  if (draft.versao !== pedido.versao || draft.payloadHash !== pedido.payloadHash) {
    throw new InteligenciaError("CONFIRMACAO_DESATUALIZADA", "O rascunho mudou desde a última vez que você o viu. Atualize antes de cancelar.", 409);
  }
  if (draft.estado === "CANCELADA") return { draft, resposta: { tipo: "resultado_acao", rascunho: publico(acao, draft), mensagem: "Rascunho cancelado. Nenhuma alteração foi feita." } };
  if (draft.estado !== "COLETANDO" && draft.estado !== "AGUARDANDO_CONFIRMACAO") {
    throw new InteligenciaError("OPERACAO_ENCERRADA", "Este rascunho já foi encerrado.", 409);
  }
  const cancelada: HumanGateDraft = { ...draft, estado: "CANCELADA", atualizadoEm: deps.agora().toISOString() };
  if (!await deps.repositorio.atualizar(ctx.tx, cancelada, { versao: draft.versao, estado: draft.estado })) {
    throw new InteligenciaError("OPERACAO_CONCORRENTE", "O rascunho mudou em outra aba. Atualize e tente de novo.", 409);
  }
  return { draft: cancelada, resposta: { tipo: "resultado_acao", rascunho: publico(acao, cancelada), mensagem: "Rascunho cancelado. Nenhuma alteração foi feita." } };
}

// ---------------------------------------------------------------- IA operacional: coordenação do rascunho

/** Rascunho ainda aberto (coletando ou aguardando revisão) e dentro do prazo. */
export function rascunhoAberto(draft: HumanGateDraft, agora: Date) {
  return (draft.estado === "COLETANDO" || draft.estado === "AGUARDANDO_CONFIRMACAO") && !expirado(draft, agora);
}

/**
 * Encerra o rascunho SEM executar nada: cancelamento pedido em texto ou substituição por outro objetivo
 * ("quero criar uma festa, não um pacote"). Compare-and-set na versão atual; o motivo (e o substituto) ficam
 * registrados em `resultado`, de forma auditável. A prévia antiga deixa de ser confirmável.
 */
export async function abandonarRascunho(
  acao: FerramentaAcao, draft: HumanGateDraft, motivo: "CANCELADO_NA_CONVERSA" | "SUBSTITUIDO", ctx: ContextoGate, deps: DependenciasHumanGate, substituto: string | null = null,
): Promise<HumanGateDraft> {
  autorizarNoGate(ctx, acao, "HUMAN_GATE", null);
  if (!rascunhoAberto(draft, deps.agora())) throw new InteligenciaError("OPERACAO_ENCERRADA", "Este rascunho já foi encerrado.", 409);
  const encerrado: HumanGateDraft = {
    ...draft, estado: "CANCELADA", atualizadoEm: deps.agora().toISOString(),
    resultado: { motivo, ...(substituto ? { substitutoId: substituto } : {}) },
  };
  if (!await deps.repositorio.atualizar(ctx.tx, encerrado, { versao: draft.versao, estado: draft.estado })) {
    throw new InteligenciaError("OPERACAO_CONCORRENTE", "O rascunho mudou em outra aba. Atualize e tente de novo.", 409);
  }
  return encerrado;
}

/** Reapresenta o passo atual (próxima pergunta ou prévia) sem nova versão nem escrita. */
export function reapresentar(acao: FerramentaAcao, draft: HumanGateDraft): AIResponse {
  if (draft.estado === "AGUARDANDO_CONFIRMACAO") return { tipo: "preview", rascunho: publico(acao, draft) };
  const faltando = acao.faltando({ ...draft.payload });
  const campo = acao.campos.find((c) => c.id === faltando[0]);
  return { tipo: "rascunho", rascunho: publico(acao, draft), pergunta: campo?.pergunta ?? "Complete os dados do rascunho.", faltando };
}
