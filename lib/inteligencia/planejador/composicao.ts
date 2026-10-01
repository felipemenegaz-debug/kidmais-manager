import type { EntidadeRef, RespostaLeitura } from "../contratos.ts";
import { saidaLeituraSchema } from "../registro-ferramentas.ts";
import { normalizar } from "../texto-pt.ts";
import { detectarConsumo } from "../operacional/consumo.ts";
import type { ParteResposta } from "./executor.ts";

/**
 * Composição DETERMINÍSTICA de respostas de leitura de um plano (AI V1.1, PR 6.4). Sem modelo, sem linguagem natural.
 *
 * - Fatos pedidos no texto (cliente, situação do contrato, posição financeira) são conferidos contra o que as leituras
 *   do Core EFETIVAMENTE devolveram — não contra recursos citados, entidades presentes ou a marca \`resposta\`.
 * - Todas as leituras da resposta têm de falar da MESMA festa / do MESMO contrato / do MESMO cliente.
 * - A resposta composta usa o mesmo contrato de \`RespostaLeitura\` e é revalidada pelo schema de saída: se não couber,
 *   é recusada inteira — nunca truncada, nunca com fato, fonte ou aviso descartado.
 * - Forma de pagamento, contrato assinado ou valor contratado NUNCA cobrem "pago": só a posição financeira oficial.
 */
export type FatoSolicitado = "CLIENTE" | "SITUACAO_CONTRATO" | "POSICAO_FINANCEIRA" | "CONVIDADOS" | "BUFFET" | "CONSUMO_DOCES" | "CONSUMO_REFRIGERANTES";

const ROTULO: Readonly<Record<FatoSolicitado, string>> = {
  CLIENTE: "cliente",
  SITUACAO_CONTRATO: "situação do contrato",
  POSICAO_FINANCEIRA: "posição financeira (pago, saldo, em aberto)",
  CONVIDADOS: "convidados da festa",
  BUFFET: "escolhas do buffet",
  CONSUMO_DOCES: "quantidade de doces",
  CONSUMO_REFRIGERANTES: "quantidade de refrigerantes",
};

const PEDE_CLIENTE = /\b(clientes?|contratante)\b/;
const PEDE_POSICAO = /\b(pag[oa]s?|pagamentos?|quitad[oa]s?|quitacao|saldo|em aberto|falta (pagar|receber)|quanto (ainda )?(falta|resta)\w*)\b/;
const PEDE_SITUACAO = /\b(situacao|status|assinad[oa]s?|vigente|como esta)\b/;
/** IA operacional: convidados e escolhas do buffet da festa (só com a flag; sem ela, os fatos de antes). */
const PEDE_CONVIDADOS = /\b(convidad[oa]s?|numero de convidados)\b/;
const PEDE_BUFFET = /\b(buffet|cardapio|doces?|docinhos?|salgad\w*|bebidas?|bolo|sabor(es)?)\b/;

/**
 * Fatos que o operador pediu. Contrato como OBJETO do pedido ("o contrato", "situação do contrato") pede a situação
 * contratual; contrato só como âncora ("a parcela do último contrato", "se o contrato está pago") não pede.
 */
export function fatosSolicitados(texto: string, operacional = false): FatoSolicitado[] {
  const n = normalizar(texto);
  const posicao = PEDE_POSICAO.test(n);
  const contrato = /\bcontratos?\b/.test(n);
  const consumo = operacional ? detectarConsumo(n) : null;
  const situacao = contrato && (PEDE_SITUACAO.test(n) || (/\b(o|os|um) contratos?\b/.test(n) && !posicao));
  return [
    ...(PEDE_CLIENTE.test(n) ? ["CLIENTE" as const] : []),
    ...(situacao ? ["SITUACAO_CONTRATO" as const] : []),
    ...(posicao ? ["POSICAO_FINANCEIRA" as const] : []),
    // "por convidado" é a unidade de um parâmetro, não um pedido dos convidados.
    ...(operacional && PEDE_CONVIDADOS.test(n.replace(/\bpor convidad\w*/g, "")) ? ["CONVIDADOS" as const] : []),
    // Quantidade de doces/refrigerantes é cálculo (CONSUMO_*); a palavra "doces" numa pergunta de quantidade não pede as
    // escolhas do buffet, a menos que o pedido cite escolhas/tipos/sabores.
    ...(operacional && PEDE_BUFFET.test(n) && (!consumo || /(escolhw*|quais|tipos?|sabor(es)?|cardapio|buffet)/.test(n)) ? ["BUFFET" as const] : []),
    ...(consumo?.categorias.includes("DOCES") ? ["CONSUMO_DOCES" as const] : []),
    ...(consumo?.categorias.includes("REFRIGERANTES") ? ["CONSUMO_REFRIGERANTES" as const] : []),
  ];
}

/** O fato pedido foi obtido do Core por esta leitura? */
function cobre(fato: FatoSolicitado, p: Pick<ParteResposta, "capacidade" | "dados">): boolean {
  if (fato === "CLIENTE") {
    // Relações cobrem a IDENTIFICAÇÃO do cliente só quando devolvem esse fato (e a entidade CLIENTE).
    if (p.capacidade === "relacoes_festa" || p.capacidade === "relacoes_contrato") {
      return p.dados.fatos.some((f) => f.natureza === "FATO" && f.texto.startsWith("Cliente: ")) && (p.dados.entidades ?? []).some((e) => e.tipo === "CLIENTE");
    }
    return p.capacidade === "resumir_cliente" && p.dados.estado !== "sem_dados";
  }
  // IA operacional: convidados da versão vigente e escolhas efetivas do buffet vêm da projeção operacional da festa.
  if (fato === "CONVIDADOS") return (p.capacidade === "contexto_operacional_festa" || p.capacidade === "calcular_consumo") && p.dados.estado !== "sem_dados";
  if (fato === "CONSUMO_DOCES" || fato === "CONSUMO_REFRIGERANTES") return p.capacidade === "calcular_consumo" && categoriaDoCalculo(p.dados) === (fato === "CONSUMO_DOCES" ? "DOCES" : "REFRIGERANTES");
  if (fato === "BUFFET") return p.capacidade === "contexto_operacional_festa" && p.dados.estado !== "sem_dados";
  // Relação com CONTRATO não cobre a situação contratual: só o resumo do contrato.
  if (fato === "SITUACAO_CONTRATO") return p.capacidade === "resumir_contrato";
  // Só a posição financeira OFICIAL (inclusive a ausência explícita de plano financeiro). proxima_parcela não basta.
  return p.capacidade === "saldo_contrato";
}

/** Categoria do cálculo, pela evidência estruturada da leitura (nunca pelo texto). */
export function categoriaDoCalculo(d: Pick<RespostaLeitura, "evidencias">): string | null {
  return d.evidencias.find((e) => e.rotulo === "Categoria do cálculo")?.valor ?? null;
}

export function faltando(solicitados: readonly FatoSolicitado[], partes: ReadonlyArray<Pick<ParteResposta, "capacidade" | "dados">>): FatoSolicitado[] {
  return solicitados.filter((f) => !partes.some((p) => cobre(f, p)));
}

/** Todas as leituras falam da mesma festa, do mesmo contrato e do mesmo cliente (ids do Core, nunca do texto). */
export function mesmaAncora(partes: ReadonlyArray<{ dados: RespostaLeitura }>): boolean {
  for (const tipo of ["FESTA", "CONTRATO", "CLIENTE"] as const) {
    const ids = new Set(partes.flatMap((p) => (p.dados.entidades ?? []).filter((e) => e.tipo === tipo).map((e) => e.id)));
    if (ids.size > 1) return false;
  }
  return true;
}

const ORDEM_ESTADO: ReadonlyArray<RespostaLeitura["estado"]> = ["atencao", "sem_dados", "informativo", "em_dia"];
export const FONTE_COMPLETUDE = "planejador.completude";

export type Composicao =
  | { ok: true; dados: RespostaLeitura; faltando: FatoSolicitado[] }
  | { ok: false; motivo: "ANCORA_DIVERGENTE" | "COMPOSICAO_LIMITE" };

/**
 * Junta as leituras (na ordem do plano; a final por último) numa única RespostaLeitura. Estado = o mais restritivo;
 * fato pedido e não obtido ⇒ ausência explícita + estado "atencao" (nunca apresentado como concluído).
 */
/** Primeira ocorrência de cada chave, na ordem. */
function unicos<T>(lista: readonly T[], chave: (x: T) => string): T[] {
  const vistas = new Set<string>();
  return lista.filter((x) => !vistas.has(chave(x)) && Boolean(vistas.add(chave(x))));
}

export function compor(partes: readonly ParteResposta[], solicitados: readonly FatoSolicitado[]): Composicao {
  if (!mesmaAncora(partes)) return { ok: false, motivo: "ANCORA_DIVERGENTE" };
  const sem = faltando(solicitados, partes);
  const final = partes.at(-1)!.dados;
  const estados = new Set(partes.map((p) => p.dados.estado));
  const estado = sem.length ? "atencao" : ORDEM_ESTADO.find((e) => estados.has(e)) ?? final.estado;
  const aviso = sem.length ? `Não consegui obter: ${sem.map((f) => ROTULO[f]).join("; ")}.` : null;
  const entidades = [...new Map(partes.flatMap((p) => p.dados.entidades ?? []).map((e): [string, EntidadeRef] => [`${e.tipo}:${e.id}`, e])).values()];
  const dados: RespostaLeitura = {
    capacidade: final.capacidade,
    estado,
    resumo: [...partes.map((p) => p.dados.resumo), ...(aviso ? [aviso] : [])].join(" "),
    // O mesmo fato da mesma fonte em duas leituras da MESMA âncora (ex.: convidados nos dois cálculos) aparece uma vez.
    fatos: [...unicos(partes.flatMap((p) => p.dados.fatos), (x) => `${x.natureza}|${x.fonte}|${x.texto}`), ...sem.map((f) => ({ natureza: "AUSENCIA" as const, texto: `Não consegui obter: ${ROTULO[f]}.`, fonte: FONTE_COMPLETUDE }))],
    // Ids de item prefixados pelo passo: duas leituras podem ter um item "contrato".
    itens: partes.flatMap((p) => p.dados.itens.map((i) => ({ ...i, id: `${p.passoId}_${i.id}`.slice(0, 80) }))),
    evidencias: unicos(partes.flatMap((p) => p.dados.evidencias), (x) => JSON.stringify(x)),
    referencia: { hoje: final.referencia.hoje, geradoEm: final.referencia.geradoEm, fontes: [...new Set([...partes.flatMap((p) => p.dados.referencia.fontes), ...(sem.length ? [FONTE_COMPLETUDE] : [])])] },
    ...(entidades.length ? { entidades } : {}),
  };
  // Mesmos limites do schema de saída das leituras: não cabe ⇒ recusa inteira (nada é cortado em silêncio).
  if (!saidaLeituraSchema.safeParse(dados).success) return { ok: false, motivo: "COMPOSICAO_LIMITE" };
  return { ok: true, dados, faltando: sem };
}
