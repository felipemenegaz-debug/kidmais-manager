import type { AIResponse, HumanGateDraft } from "../contratos.ts";
import { chaveExtensao, type ContextoExtensao, type DescricaoAcao, type ModuloAcoes, type SituacaoRascunho } from "../extensoes.ts";
import { InteligenciaError } from "../politica.ts";
import { destinoSeguro } from "../rotas-navegacao.ts";
import { abandonarRascunho, carregar, iniciarRascunho, publico, rascunhoAberto, reapresentar, responderRascunho, type DependenciasHumanGate } from "./human-gate.ts";
import { criarRegistroAcoes, type RegistroAcoes } from "./registro.ts";
import type { FerramentaAcao } from "./tipos.ts";

/**
 * Implementação do `ModuloAcoes` do CORE (feature ACTIONS).
 *
 * Features que trazem ações (pacotes aqui, importação na feature IMPORT) contribuem pela lista
 * `CHAVE_ACOES` do `RegistroExtensoes`; o módulo lê a lista quando é montado, depois de toda a composição.
 */
export const CHAVE_ACOES = chaveExtensao<FerramentaAcao[]>("acoes.ferramentas");
/** Dependências do motor do Human Gate, para features que abrem rascunho pela própria tela. */
export const CHAVE_HUMAN_GATE = chaveExtensao<DependenciasHumanGate>("acoes.human-gate");

export type ModuloAcoesCompleto = ModuloAcoes & { registro: RegistroAcoes; gate: DependenciasHumanGate };
/** O mesmo módulo, com registro e gate expostos para a confirmação (/operacoes) e fluxos de tela. */
export const CHAVE_MODULO_COMPLETO = chaveExtensao<ModuloAcoesCompleto>("acoes.modulo");

function descricao(a: FerramentaAcao): DescricaoAcao {
  return {
    capacidade: a.capacidade,
    ferramenta: a.nome,
    classe: a.classe,
    grupo: a.grupo,
    papeis: a.papeis,
    descricao: a.descricao,
    origem: a.origem ?? "CONVERSA",
    ...(a.mensagemNegada ? { mensagemNegada: a.mensagemNegada } : {}),
    ...(a.indisponivel ? { indisponivel: true } : {}),
  };
}

type Resultado = { resposta: AIResponse; capacidade: string; ferramenta: string };

/**
 * IA operacional: ação aprovada na REVISÃO OFICIAL (ex.: contratação). A prévia pronta vira navegação para a revisão
 * preenchida, com a proposta (versão + hash) para a UI; nunca um botão "Confirmar" que executaria pelo chat.
 */
function paraRevisao(acao: FerramentaAcao, draft: HumanGateDraft, resposta: AIResponse): AIResponse {
  if (!acao.revisao || resposta.tipo !== "preview") return resposta;
  const destino = acao.revisao.destino(draft.payload, draft.operacaoId);
  if (!destino || !destinoSeguro(destino)) return { tipo: "nao_suportado", mensagem: "Preparei os dados, mas não consegui abrir a revisão com segurança agora.", sugestoes: [] };
  return { tipo: "navegacao", tela: "fechamento", recurso: "FECHAMENTO", destino, rotulo: acao.revisao.rotulo, proposta: resposta.rascunho, entendimento: "PRECISA_CONFIRMACAO" };
}

export function criarModuloAcoes(lista: readonly FerramentaAcao[], gate: DependenciasHumanGate): ModuloAcoesCompleto {
  const registro = criarRegistroAcoes(lista);
  const descricoes = Object.freeze(registro.todas().map(descricao));

  /** Rascunho do próprio tenant e usuário, de uma ação CONFIRM da conversa (senão: mesma resposta de inexistente). */
  async function doRascunho(operacaoId: string, ctx: ContextoExtensao, travar: boolean) {
    const draft = await carregar(ctx, gate, operacaoId, travar);
    const acao = registro.acao(draft.capacidade);
    if (!acao || acao.classe !== "CONFIRM" || acao.origem === "TELA") throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
    return { draft, acao };
  }

  async function iniciar(capacidade: string, texto: string, ctx: ContextoExtensao) {
    const acao = registro.acao(capacidade);
    if (!acao || acao.classe !== "CONFIRM") throw new InteligenciaError("ACAO_NEGADA", "Essa ação não é feita pelo Kidmais.", 403);
    const avanco = await iniciarRascunho(acao, texto, ctx, gate);
    return { resposta: paraRevisao(acao, avanco.draft, avanco.resposta), capacidade: acao.capacidade, ferramenta: acao.nome, draft: avanco.draft };
  }

  return {
    registro,
    gate,
    descrever: (capacidade) => descricoes.find((d) => d.capacidade === capacidade) ?? null,
    todas: () => descricoes,
    async iniciar(capacidade, texto, ctx: ContextoExtensao): Promise<Resultado> {
      const { resposta, capacidade: c, ferramenta } = await iniciar(capacidade, texto, ctx);
      return { resposta, capacidade: c, ferramenta };
    },
    async responder(operacaoId, texto, ctx: ContextoExtensao): Promise<Resultado> {
      const { draft, acao } = await doRascunho(operacaoId, ctx, true);
      const avanco = await responderRascunho(acao, draft, texto, ctx, gate);
      return { resposta: paraRevisao(acao, avanco.draft, avanco.resposta), capacidade: acao.capacidade, ferramenta: acao.nome };
    },
    async situacao(operacaoId, texto, ctx): Promise<SituacaoRascunho> {
      const { draft, acao } = await doRascunho(operacaoId, ctx, false);
      const aberto = rascunhoAberto(draft, gate.agora());
      const perguntado = draft.estado === "COLETANDO" ? acao.faltando({ ...draft.payload })[0] ?? null : null;
      const pergunta = perguntado ? acao.campos.find((c) => c.id === perguntado)?.pergunta ?? null : null;
      const noCampo = perguntado ? acao.extrair(texto, perguntado) : {};
      const livres = acao.extrair(texto, null);
      return {
        capacidade: acao.capacidade, ferramenta: acao.nome, titulo: acao.titulo, aberto, perguntado, pergunta,
        respondeCampo: perguntado !== null && Object.hasOwn(noCampo, perguntado) || (perguntado === "convidadosMinimos" && Object.hasOwn(noCampo, "convidadosMaximos")),
        trazDados: Object.keys(livres).length > 0,
      };
    },
    async abandonar(operacaoId, ctx): Promise<Resultado> {
      const { draft, acao } = await doRascunho(operacaoId, ctx, true);
      const encerrado = await abandonarRascunho(acao, draft, "CANCELADO_NA_CONVERSA", ctx, gate);
      return { resposta: { tipo: "resultado_acao", rascunho: publico(acao, encerrado), mensagem: "Rascunho cancelado. Nenhuma alteração foi feita." }, capacidade: acao.capacidade, ferramenta: acao.nome };
    },
    async substituir(operacaoId, capacidade, texto, ctx) {
      const { draft, acao } = await doRascunho(operacaoId, ctx, true);
      // Primeiro o novo (se falhar, a transação desfaz tudo e o antigo continua como estava); depois o antigo, auditável.
      const novo = await iniciar(capacidade, texto, ctx);
      await abandonarRascunho(acao, draft, "SUBSTITUIDO", ctx, gate, novo.draft.operacaoId);
      return { resposta: novo.resposta, capacidade: novo.capacidade, ferramenta: novo.ferramenta, anterior: acao.titulo };
    },
    async retomar(operacaoId, ctx): Promise<Resultado> {
      const { draft, acao } = await doRascunho(operacaoId, ctx, false);
      if (!rascunhoAberto(draft, gate.agora())) throw new InteligenciaError("OPERACAO_ENCERRADA", "Este rascunho já foi encerrado ou expirou. Comece um novo pedido.", 409);
      return { resposta: paraRevisao(acao, draft, reapresentar(acao, draft)), capacidade: acao.capacidade, ferramenta: acao.nome };
    },
  };
}
