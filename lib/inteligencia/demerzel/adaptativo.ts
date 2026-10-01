import type { AIResponse, ContextoTela } from "../contratos.ts";
import type { PortasAdaptativas, ResultadoAdaptativo, ResumoOrquestracao } from "../extensoes.ts";
import type { Entendimento } from "../luna/entendimento.ts";
import { LIMITES_ADAPTATIVOS, LimiteDemerzel, VERSAO_DEMERZEL, type MotivoParada } from "./contrato.ts";
import { criarJuizJev, type RastroJevV1 } from "../jev/v1/juiz.ts";
import { EXPLICACAO_PROIBIDA, ExecucaoDemerzel, INJECAO, motivosDe } from "./orquestradora.ts";

/**
 * Demerzel — ciclo da conversa adaptativa (coordena; não entende nem autoriza).
 *
 *   risco (JEV por regras) → Luna entende a mensagem inteira → execução pelas portas guardadas (rascunho, consumo,
 *   consulta, proposta sob Human Gate) → Luna analisa o resultado e redige; se ela apontar uma lacuna que uma consulta
 *   autorizada cobre, complemento contado e nova redação.
 *
 * Limites desta rota (LIMITES_ADAPTATIVOS), conferidos ANTES de cada passo: chamadas de modelo no pedido inteiro,
 * leituras, prazo e passos; nada se repete (assinatura de passo). Sem entendimento ⇒ null (caminho anterior). Limite
 * atingido depois da execução ⇒ a resposta comprovada sai como está (sem redação), nunca uma tarefa "concluída".
 */
const SUGESTOES = ["O que precisa da minha atenção hoje?", "Quais contratos estão pendentes?", "Como está a agenda de hoje?", "Quanto recebemos este mês?"];

const ehLeitura = (r: AIResponse) => r.tipo === "resposta" && "fatos" in r.dados;

export async function atenderAdaptativo(
  entrada: { texto: string; contexto: ContextoTela | null },
  portas: PortasAdaptativas,
  opcoes: { limites?: Partial<typeof LIMITES_ADAPTATIVOS>; registrarJev?: (rastro: RastroJevV1) => void } = {},
): Promise<ResultadoAdaptativo> {
  const limites = { ...LIMITES_ADAPTATIVOS, ...opcoes.limites };
  const exec = new ExecucaoDemerzel(
    { maxPassos: limites.maxPassos, maxPassosModelo: limites.chamadasModelo, maxPropostas: 1, maxCustoMicros: null, prazoMs: limites.prazoMs },
    { relogio: () => portas.relogio(), usosDeModelo: () => [...portas.usosDeModelo()] },
  );
  const inicio = portas.relogio();
  let parada: MotivoParada | string = "ADAPTATIVO";
  let entendimento: Entendimento | null = null;
  let redacao: ResultadoAdaptativo["redacao"] = "NENHUMA";
  const resumo = (): ResumoOrquestracao => ({
    versao: `${VERSAO_DEMERZEL}+adaptativo`,
    passos: [...exec.passos],
    parada: String(parada),
    chamadasModelo: portas.usosDeModelo().length,
    custoEstimadoMicros: exec.custo(),
    julgamento: null,
    skills: [],
  });
  const fim = (resposta: AIResponse | null): ResultadoAdaptativo => ({ resposta, entendimento, parada: String(parada), redacao, resumo: resumo() });
  // Teto de chamadas no PEDIDO INTEIRO (inclui o planner por modelo que a execução possa ter usado) e folga de prazo.
  const podeModelo = () => portas.usosDeModelo().length < limites.chamadasModelo && limites.prazoMs - (portas.relogio() - inicio) > limites.folgaRedacaoMs;

  // 1. Risco pelo JEV (regras, sem modelo): injeção, segredo, SQL, outro tenant, exclusão… recusa explicada sem gastar
  //    modelo. Incerteza linguística NUNCA é risco: quem entende a mensagem é a Luna, no passo seguinte.
  const juiz = criarJuizJev({ modelo: null, registrar: opcoes.registrarJev });
  const recusa = await exec.passo("RISCO", "", async () => {
    const { julgamento } = await juiz.julgar({ texto: entrada.texto, tela: entrada.contexto?.tela ?? "geral", temEntidade: Boolean(entrada.contexto?.entidadeId) });
    const motivos = motivosDe(julgamento);
    if (INJECAO.some((m) => motivos.has(m))) return "Não sigo instruções para ignorar regras ou mudar o meu funcionamento. Reformule o que você quer saber ou fazer.";
    if (julgamento.actionSensitivity.classification !== "FORBIDDEN") return null;
    return (EXPLICACAO_PROIBIDA.find(([m]) => motivos.has(m)) ?? ["", "Esse pedido não é feito pelo Kidmais."])[1];
  }, (r) => (r ? "RECUSA" : "OK"));
  if (recusa) {
    parada = "RECUSA_JULGAMENTO";
    return fim({ tipo: "nao_suportado", mensagem: recusa, sugestoes: SUGESTOES, entendimento: "NEGADO_POLITICA" });
  }

  // 2. Luna entende. Sem entendimento (indisponível, prazo, saída inválida) ⇒ o caminho anterior responde.
  try {
    entendimento = await exec.passo("ENTENDIMENTO_MODELO", "", () => portas.entender(), (e) => e?.objetivo ?? "INDISPONIVEL");
  } catch (erro) {
    if (!(erro instanceof LimiteDemerzel)) throw erro;
    entendimento = null;
  }
  if (!entendimento) {
    parada = "ENTENDIMENTO_INDISPONIVEL";
    return fim(null);
  }
  const ent = entendimento;

  // 3. Execução pelas portas guardadas (Policy, Tenant Context, Core e Human Gate lá dentro).
  let resposta: AIResponse;
  try {
    resposta = await exec.passo("EXECUCAO", ent.objetivo, () => portas.executar(ent), (r) => r.tipo);
  } catch (erro) {
    if (!(erro instanceof LimiteDemerzel)) throw erro;
    parada = erro.motivo;
    return fim({ tipo: "nao_suportado", mensagem: "Não consegui concluir este pedido com segurança no tempo disponível. Tente de novo com um pedido mais simples.", sugestoes: SUGESTOES });
  }
  if (!ehLeitura(resposta)) return fim(resposta);

  // 4. Luna analisa o resultado (lacunas) e redige. 5. Lacuna coberta por consulta autorizada ⇒ complemento + redação.
  try {
    if (!podeModelo()) {
      parada = "LIMITE_MODELO";
      redacao = "DETERMINISTICA";
      return fim(resposta);
    }
    const possiveis = portas.complementosPossiveis(resposta);
    const primeira = await exec.passo("REDACAO_MODELO", "1", () => portas.redigir(resposta, ent, possiveis), (r) => (r.resposta.redacao === "MODELO" ? "REDIGIDA" : "DETERMINISTICA"));
    resposta = primeira.resposta;
    redacao = resposta.redacao === "MODELO" ? "MODELO" : "DETERMINISTICA";
    const restantes = limites.leituras - portas.leiturasFeitas();
    if (primeira.complementos.length && restantes > 0 && podeModelo()) {
      const ids = primeira.complementos;
      const completa = await exec.passo("COMPLEMENTO_LUNA", ids.join(","), () => portas.complementar(resposta, ids, restantes), (r) => r.tipo);
      if (ehLeitura(completa)) {
        // A resposta complementada já vale (determinística) mesmo que a nova redação não aconteça.
        resposta = completa;
        redacao = "DETERMINISTICA";
        const segunda = await exec.passo("REDACAO_MODELO", "2", () => portas.redigir(completa, ent, []), (r) => (r.resposta.redacao === "MODELO" ? "REDIGIDA" : "DETERMINISTICA"));
        resposta = segunda.resposta;
        redacao = resposta.redacao === "MODELO" ? "MODELO" : "DETERMINISTICA";
      }
    }
  } catch (erro) {
    if (!(erro instanceof LimiteDemerzel)) throw erro;
    // Limite na análise/redação: a resposta já comprovada sai como está (determinística).
    parada = erro.motivo;
    if (redacao === "NENHUMA") redacao = "DETERMINISTICA";
  }
  return fim(resposta);
}
