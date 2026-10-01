import type { AIResponse, EntidadeRef, OrigemChamada, RespostaLeitura } from "../contratos.ts";
import type { CapacidadeCatalogo, Intencao } from "../intencao.ts";
import { InteligenciaError } from "../politica.ts";
import type { OrigemEntrada, PlanoRastreio, ResultadoPasso } from "../contratos.ts";
import type { PassoPlano, Plano } from "./plano.ts";

/**
 * Executor de plano (PR 6). Passo a passo, pelas portas guardadas (Policy + Tenant Context em CADA leitura):
 *   1. resolve a entrada do passo (entidade do passo anterior ou âncora de tela/foco revalidada — nunca literal);
 *   2. valida os parâmetros contra o schema de entrada da própria ferramenta;
 *   3. executa a leitura; a saída já foi validada pelo outputSchema no gateway;
 *   4. extrai SÓ as entidades estruturadas (tipo + id + rótulo + relações do Core) para o passo seguinte;
 *   5. para no primeiro SEM_DADOS / AMBIGUO / NEGADO / ERRO — o passo seguinte nunca executa.
 * O último passo não é executado aqui: vira uma Intencao que segue o caminho atual (leitura, navegação ou proposta
 * sob Human Gate). Sem laço, sem recursão: no máximo `plano.passos.length` leituras.
 */
export type LerPlano = (capacidade: string, parametros: Record<string, unknown>) => Promise<AIResponse>;

export type DependenciasExecutor = {
  ler: LerPlano;
  /** Âncora de tela/foco já revalidada no Core (para `entradaDe: CONTEXTO`). */
  ancoraContexto: EntidadeRef | null;
  /** Catálogo usado na validação (tipo leitura/ação da capacidade final). */
  catalogo: readonly CapacidadeCatalogo[];
  /** Schema de entrada da ferramenta registrada (null ⇒ capacidade inexistente). */
  entradaDe(capacidade: string): { safeParse(v: unknown): { success: boolean } } | null;
  origem: OrigemChamada;
  relogio(): number;
};

export type PassoExecutado = PlanoRastreio["passos"][number];

/** PR 6.4: resultado COMPLETO (já validado pelo outputSchema no gateway) de um passo marcado `resposta`. */
export type ParteResposta = { passoId: string; capacidade: string; dados: RespostaLeitura };

export type ResultadoExecucao =
  | { estado: "FINAL"; intencao: Intencao; passos: PassoExecutado[]; entradas: Map<string, EntidadeRef>; entradaFinal: EntidadeRef | null; partes: ParteResposta[] }
  | { estado: "SEM_DADOS" | "AMBIGUO" | "NEGADO" | "ERRO"; passoId: string; candidatos: EntidadeRef[]; passos: PassoExecutado[]; entradas: Map<string, EntidadeRef> };

type Selecao = { ok: true; entidade: EntidadeRef } | { ok: false; estado: "SEM_DADOS" | "AMBIGUO" | "ERRO"; candidatos: EntidadeRef[] };

/** Data e hora do rótulo de festa ("Festa de X — 01/10/2026 às 14:00"): empate real ⇒ ambíguo. */
const instante = (e: EntidadeRef) => e.rotulo.split(" — ").at(-1) ?? e.rotulo;

function selecionar(entidades: readonly EntidadeRef[], tipo: EntidadeRef["tipo"], modo: PassoPlano["selecao"]): Selecao {
  const doTipo = entidades.filter((e) => e.tipo === tipo);
  if (!doTipo.length) return { ok: false, estado: "SEM_DADOS", candidatos: [] };
  const unicos = [...new Map(doTipo.map((e) => [e.id, e])).values()];
  if (unicos.length === 1) return { ok: true, entidade: unicos[0] };
  if (modo === "PRIMEIRA" && instante(unicos[0]) !== instante(unicos[1])) return { ok: true, entidade: unicos[0] };
  return { ok: false, estado: "AMBIGUO", candidatos: unicos };
}

/** De onde veio a entrada do passo, para o trace: id do passo, CONTEXTO ou null (só parâmetros). */
const fonteDe = (passo: PassoPlano): string | null => (passo.entradaDe ? (passo.entradaDe.de === "CONTEXTO" ? "CONTEXTO" : passo.entradaDe.passo) : null);

const negada = (erro: unknown) => erro instanceof InteligenciaError && (erro.httpStatus === 403 || erro.httpStatus === 404);

export async function executarPlano(plano: Plano, deps: DependenciasExecutor): Promise<ResultadoExecucao> {
  const passos: PassoExecutado[] = [];
  const saidas = new Map<string, readonly EntidadeRef[]>();
  const entradas = new Map<string, EntidadeRef>();
  // Resultados conservados para a resposta (só passos marcados `resposta`), na ordem do plano.
  const partes: ParteResposta[] = [];
  const parar = (estado: "SEM_DADOS" | "AMBIGUO" | "NEGADO" | "ERRO", passo: PassoPlano, origemEntrada: OrigemEntrada, candidatos: EntidadeRef[] = [], duracaoMs = 0): ResultadoExecucao => {
    passos.push({ capacidade: passo.capacidade, origemEntrada, fonte: fonteDe(passo), resultado: estado, duracaoMs });
    return { estado, passoId: passo.id, candidatos, passos, entradas };
  };

  /** Entrada do passo: sempre uma entidade que o Core devolveu (passo anterior) ou revalidou (tela/foco). */
  const entradaDo = (passo: PassoPlano): Selecao | null => {
    const de = passo.entradaDe;
    if (!de) return null;
    if (de.de === "CONTEXTO") {
      return deps.ancoraContexto && deps.ancoraContexto.tipo === de.entidade ? { ok: true, entidade: deps.ancoraContexto } : { ok: false, estado: "ERRO", candidatos: [] };
    }
    const fonte = plano.passos.find((p) => p.id === de.passo);
    const saida = saidas.get(de.passo);
    if (!fonte || !saida) return { ok: false, estado: "ERRO", candidatos: [] };
    return selecionar(saida, de.entidade, fonte.selecao);
  };

  const parametrosDo = (passo: PassoPlano, entrada: EntidadeRef | null): Record<string, unknown> | null => {
    const parametros: Record<string, unknown> = { ...(passo.parametros ?? {}) };
    if (entrada) {
      parametros.id = entrada.id;
      // Navegação: a tela vem da própria entidade do Core, nunca do plano.
      if (passo.capacidade === "abrir_tela") {
        if (!entrada.tela || entrada.tela === "festa") return null;
        parametros.tela = entrada.tela;
      }
    }
    const schema = deps.entradaDe(passo.capacidade);
    return schema && schema.safeParse(parametros).success ? parametros : null;
  };

  for (const [i, passo] of plano.passos.entries()) {
    const origemEntrada: OrigemEntrada = passo.entradaDe ? (passo.entradaDe.de === "CONTEXTO" ? "CONTEXTO" : "PASSO") : "PARAMETROS";
    const selecao = entradaDo(passo);
    if (selecao && !selecao.ok) return parar(selecao.estado, passo, origemEntrada, selecao.candidatos);
    const entrada = selecao?.ok ? selecao.entidade : null;
    if (entrada) entradas.set(passo.id, entrada);
    const ultimo = i === plano.passos.length - 1;
    const item = ultimo ? deps.catalogo.find((c) => c.id === passo.capacidade) : undefined;
    if (ultimo && !item) return parar("ERRO", passo, origemEntrada);
    // Ação: sem parâmetros do plano — o rascunho sob Human Gate nasce do texto e é validado pelo próprio módulo.
    if (item?.tipo === "acao" && Object.keys(passo.parametros ?? {}).length) return parar("ERRO", passo, origemEntrada);
    const parametros = item?.tipo === "acao" ? {} : parametrosDo(passo, entrada);
    if (!parametros) return parar("ERRO", passo, origemEntrada);

    if (ultimo && item) {
      // Resultado do passo final é preenchido depois do despacho (leitura, navegação ou Human Gate).
      passos.push({ capacidade: passo.capacidade, origemEntrada, fonte: fonteDe(passo), resultado: "NAO_EXECUTADO", duracaoMs: 0 });
      const intencao: Intencao = item.tipo === "acao"
        ? { tipo: "acao", capacidade: passo.capacidade, origem: deps.origem }
        : { tipo: "leitura", capacidade: passo.capacidade, parametros, origem: deps.origem };
      return { estado: "FINAL", intencao, passos, entradas, entradaFinal: entrada, partes };
    }

    const inicio = deps.relogio();
    let resposta: AIResponse;
    try {
      resposta = await deps.ler(passo.capacidade, parametros);
    } catch (erro) {
      const duracao = Math.max(0, Math.round(deps.relogio() - inicio));
      // Policy / tenant / posse recusaram: para aqui (fail-closed). Outros erros seguem o tratamento seguro da conversa.
      if (negada(erro)) return parar("NEGADO", passo, origemEntrada, [], duracao);
      passos.push({ capacidade: passo.capacidade, origemEntrada, fonte: fonteDe(passo), resultado: "ERRO", duracaoMs: duracao });
      throw erro;
    }
    const duracaoMs = Math.max(0, Math.round(deps.relogio() - inicio));
    // Qualquer leitura com fatos serve de passo (composição: "contratos pendentes e recebimentos"); sem entidades, a saída
    // é vazia e um passo que dependa dela para (SEM_DADOS) — nunca o plano inteiro por falta de entidade.
    if (resposta.tipo !== "resposta" || !("fatos" in resposta.dados)) return parar("ERRO", passo, origemEntrada, [], duracaoMs);
    saidas.set(passo.id, (resposta.dados as RespostaLeitura).entidades ?? []);
    if (passo.resposta) partes.push({ passoId: passo.id, capacidade: passo.capacidade, dados: resposta.dados as RespostaLeitura });
    passos.push({ capacidade: passo.capacidade, origemEntrada, fonte: fonteDe(passo), resultado: "SUCESSO", duracaoMs });
  }
  // Inalcançável: o schema exige ao menos um passo e o último sempre retorna acima.
  return { estado: "ERRO", passoId: "p1", candidatos: [], passos, entradas };
}

/** Resultado do passo final a partir da resposta do despacho (para o trace). */
export function resultadoFinal(resposta: AIResponse): ResultadoPasso {
  if (resposta.tipo === "resposta" || resposta.tipo === "navegacao" || resposta.tipo === "agente") return "SUCESSO";
  if (resposta.tipo === "rascunho" || resposta.tipo === "preview") return "PRECISA_CONFIRMACAO";
  if (resposta.entendimento === "NEGADO_POLITICA") return "NEGADO";
  if (resposta.entendimento === "AMBIGUO") return "AMBIGUO";
  return "ERRO";
}
