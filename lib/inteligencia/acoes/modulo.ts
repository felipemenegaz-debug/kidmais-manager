import type { AIResponse } from "../contratos.ts";
import { chaveExtensao, type ContextoExtensao, type DescricaoAcao, type ModuloAcoes } from "../extensoes.ts";
import { InteligenciaError } from "../politica.ts";
import { carregar, iniciarRascunho, responderRascunho, type DependenciasHumanGate } from "./human-gate.ts";
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

export function criarModuloAcoes(lista: readonly FerramentaAcao[], gate: DependenciasHumanGate): ModuloAcoesCompleto {
  const registro = criarRegistroAcoes(lista);
  const descricoes = Object.freeze(registro.todas().map(descricao));
  return {
    registro,
    gate,
    descrever: (capacidade) => descricoes.find((d) => d.capacidade === capacidade) ?? null,
    todas: () => descricoes,
    async iniciar(capacidade, texto, ctx: ContextoExtensao): Promise<Resultado> {
      const acao = registro.acao(capacidade);
      if (!acao || acao.classe !== "CONFIRM") throw new InteligenciaError("ACAO_NEGADA", "Essa ação não é feita pelo Kidmais.", 403);
      const avanco = await iniciarRascunho(acao, texto, ctx, gate);
      return { resposta: avanco.resposta, capacidade: acao.capacidade, ferramenta: acao.nome };
    },
    async responder(operacaoId, texto, ctx: ContextoExtensao): Promise<Resultado> {
      const draft = await carregar(ctx, gate, operacaoId, true);
      const acao = registro.acao(draft.capacidade);
      // Rascunho de ação que não está (mais) registrada: mesma resposta de inexistente.
      if (!acao || acao.classe !== "CONFIRM" || acao.origem === "TELA") throw new InteligenciaError("OPERACAO_NAO_ENCONTRADA", "Rascunho não encontrado.", 404);
      const avanco = await responderRascunho(acao, draft, texto, ctx, gate);
      return { resposta: avanco.resposta, capacidade: acao.capacidade, ferramenta: acao.nome };
    },
  };
}
