import { z } from "zod";
import type { Fato, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta, RegraConsumoDominio } from "../ferramentas.ts";
import { CATEGORIAS_CONSUMO, calcularDoces, calcularRefrigerantes, formatar, litros, type CategoriaConsumo, type DistribuicaoInformada } from "../operacional/consumo.ts";
import { PAPEIS_ADMIN, UUID, ausencia, calculo, comEntidade, dataCurta, fato, montarResposta } from "./comum.ts";

/**
 * IA operacional (marco B): `contexto_operacional_festa` e `calcular_consumo`.
 *
 * Fonte única da festa: `consultarFestas` (porta), que prova o tenant, exige FESTA_CONSULTAR e responde festa de outra
 * empresa como inexistente. Projeção MÍNIMA: data, pacote, convidados e escolhas efetivas do buffet da versão
 * contratual VIGENTE (nunca da versão em preparação), com a origem de cada dado. Escolhas em texto livre são exibidas
 * como estão (dado do cliente, não instrução) e nunca viram quantidade estruturada.
 *
 * Cálculo: só com a regra VIGENTE da empresa (fonte versionada, 059) ou com o parâmetro que o operador escreveu NESTE
 * pedido — que vale só para este cálculo e nunca é gravado por aqui. Sem regra ⇒ pergunta; nada é presumido.
 */
const FONTE = "festas.detalhe";
const FONTE_VIGENTE = "festas.contrato_vigente";
const FONTE_BUFFET = "festas.buffet_efetivo";
const FONTE_REGRA = "empresa.parametros_consumo";
const FONTE_INFORMADO = "operador.informado";
const FONTE_CALCULO = "operacional.calculo";
/** Marca de "falta parâmetro": a conversa devolve à UI a continuação da pergunta (dica, revalidada no servidor). */
export const FONTE_PARAMETRO_AUSENTE = "operacional.parametro_ausente";

export const PERGUNTA_DOCES = "Quantos docinhos por convidado a empresa utiliza?";
export const PERGUNTA_TAXA_REFRIGERANTE = "Quantos mL de refrigerante por convidado a empresa considera?";
export const PERGUNTA_EMBALAGEM = "Qual é o tamanho da embalagem (ex.: garrafa de 2 L)?";

const CAMPOS_BUFFET = ["salgados", "doces", "bolo", "bebidas", "lembrancinha", "empratado", "bombom"] as const;
type CampoBuffet = (typeof CAMPOS_BUFFET)[number];
const ROTULO_BUFFET: Readonly<Record<CampoBuffet, [string, string]>> = {
  salgados: ["Salgados escolhidos", "Tipos de salgados ainda não escolhidos pelo cliente."],
  doces: ["Doces escolhidos", "Tipos de doces ainda não escolhidos pelo cliente."],
  bolo: ["Bolo escolhido", "Bolo ainda não escolhido pelo cliente."],
  bebidas: ["Bebidas escolhidas", "Bebidas ainda não escolhidas pelo cliente."],
  lembrancinha: ["Lembrancinha escolhida", "Lembrancinha ainda não escolhida pelo cliente."],
  empratado: ["Empratado escolhido", "Empratado ainda não escolhido pelo cliente."],
  bombom: ["Bombom escolhido", "Bombom ainda não escolhido pelo cliente."],
};

const detalheSchema = z.object({
  festa: z.object({ id: z.string(), estado: z.string() }).passthrough(),
  contrato: z.object({
    status: z.string(),
    numero_versao: z.number().optional(),
    snapshot: z.object({
      evento: z.object({ data: z.string(), convidados: z.number().int().optional(), pacote: z.object({ nome: z.string() }).passthrough().optional() }).passthrough(),
    }).passthrough(),
  }).passthrough(),
  buffet: z.object({ campos: z.array(z.string()), valores: z.record(z.string(), z.string().nullable().optional()) }).passthrough().nullable().optional(),
  versoes: z.array(z.object({ numero_versao: z.coerce.number(), em_preparacao: z.boolean().nullable().optional() }).passthrough()).optional(),
}).passthrough();

/** Projeção operacional da festa: só o que o cálculo e a resposta usam, com a versão de origem. */
export type ContextoOperacional = {
  festaId: string;
  data: string;
  pacote: string | null;
  convidados: number | null;
  versaoVigente: number | null;
  versaoEmPreparacao: number | null;
  /** Campos do buffet que se aplicam ao pacote; valor vazio ⇒ ainda não escolhido. Texto livre, limitado. */
  escolhas: Partial<Record<CampoBuffet, string | null>>;
  buffetInformado: boolean;
};

export function projetarContexto(bruto: unknown): ContextoOperacional | null {
  const lido = detalheSchema.safeParse(bruto);
  if (!lido.success) return null;
  const d = lido.data;
  const vigente = d.contrato.numero_versao ?? null;
  const preparacao = (d.versoes ?? []).find((v) => v.em_preparacao === true && v.numero_versao !== vigente)?.numero_versao ?? null;
  const escolhas: ContextoOperacional["escolhas"] = {};
  for (const campo of CAMPOS_BUFFET) {
    if (!d.buffet?.campos.includes(campo)) continue;
    const valor = d.buffet.valores[campo]?.replace(/\s+/g, " ").trim() ?? "";
    escolhas[campo] = valor ? valor.slice(0, 200) : null;
  }
  const convidados = d.contrato.snapshot.evento.convidados;
  return {
    festaId: d.festa.id,
    data: d.contrato.snapshot.evento.data,
    pacote: d.contrato.snapshot.evento.pacote?.nome ?? null,
    convidados: typeof convidados === "number" && convidados > 0 ? convidados : null,
    versaoVigente: vigente,
    versaoEmPreparacao: preparacao,
    escolhas,
    buffetInformado: Boolean(d.buffet),
  };
}

const rotuloVersao = (c: ContextoOperacional) => (c.versaoVigente ? `contrato vigente V${c.versaoVigente}` : "contrato vigente");

function fatosBase(c: ContextoOperacional, campos: readonly CampoBuffet[]): Fato[] {
  const fatos: Fato[] = [fato(`Festa em ${dataCurta(c.data)}${c.pacote ? `, pacote ${c.pacote}` : ""}.`, FONTE)];
  fatos.push(c.convidados ? fato(`Convidados contratados: ${formatar(c.convidados)} (${rotuloVersao(c)}).`, FONTE_VIGENTE) : ausencia("O contrato vigente não informa o número de convidados.", FONTE_VIGENTE));
  if (c.versaoEmPreparacao) fatos.push(fato(`Há uma versão V${c.versaoEmPreparacao} do contrato em preparação; os dados acima são da versão vigente${c.versaoVigente ? ` V${c.versaoVigente}` : ""}.`, FONTE_VIGENTE));
  if (!c.buffetInformado) {
    fatos.push(ausencia("Buffet não informado para esta festa.", FONTE_BUFFET));
    return fatos;
  }
  for (const campo of campos) {
    if (!(campo in c.escolhas)) continue;
    const valor = c.escolhas[campo];
    const [rotulo, falta] = ROTULO_BUFFET[campo];
    fatos.push(valor ? fato(`${rotulo} (como registrado): ${valor}.`, FONTE_BUFFET) : ausencia(falta, FONTE_BUFFET));
  }
  return fatos;
}

function entidade(c: ContextoOperacional) {
  return UUID.test(c.festaId) ? [{ tipo: "FESTA" as const, id: c.festaId, rotulo: `Festa — ${dataCurta(c.data)}`, tela: "festa" as const }] : [];
}

function indisponivel(capacidade: string, contexto: ContextoFerramenta, motivo: string): RespostaLeitura {
  return montarResposta(capacidade, contexto, { estado: "sem_dados", resumo: "Não há dados suficientes para responder sobre esta festa.", fatos: [ausencia(motivo, FONTE)], fontes: [FONTE] });
}

async function lerContexto(id: string, capacidade: string, contexto: ContextoFerramenta): Promise<ContextoOperacional | RespostaLeitura> {
  if (!contexto.portas.festas) return indisponivel(capacidade, contexto, "Serviço de festas indisponível para a IA.");
  const c = projetarContexto(await contexto.portas.festas.consultarDetalhe(id));
  return c ?? indisponivel(capacidade, contexto, "O detalhe da festa não trouxe os campos necessários.");
}

export const contextoOperacionalFesta: Ferramenta<RespostaLeitura> = {
  nome: "festas.contexto_operacional",
  capacidade: "contexto_operacional_festa",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  descricao: "Data, convidados (versão contratual vigente) e escolhas efetivas do buffet da festa, com a origem de cada dado.",
  entidade: "festa",
  modo: "SERVICO_PROPRIO",
  preparar(parametros) {
    const { id } = comEntidade.parse(parametros);
    return async (_tenant, contexto) => {
      const c = await lerContexto(id, "contexto_operacional_festa", contexto);
      if ("capacidade" in c) return c;
      const fatos = fatosBase(c, CAMPOS_BUFFET);
      const faltam = fatos.filter((f) => f.natureza === "AUSENCIA").length;
      return montarResposta("contexto_operacional_festa", contexto, {
        estado: faltam ? "atencao" : "informativo",
        resumo: `Festa em ${dataCurta(c.data)}: ${c.convidados ? `${formatar(c.convidados)} convidados` : "convidados não informados"}${faltam ? `, ${faltam} ${faltam === 1 ? "item sem definição" : "itens sem definição"}` : ""}.`,
        fatos,
        fontes: [FONTE, FONTE_VIGENTE, FONTE_BUFFET],
        entidades: entidade(c),
      });
    };
  },
};

// ---------------------------------------------------------------- calcular_consumo

const distribuicaoSchema = z.object({
  tipo: z.string().trim().min(1).max(40).regex(/^[\p{L} ]+$/u),
  percentual: z.number().int().min(1).max(100).optional(),
  quantidade: z.number().int().min(1).max(100_000).optional(),
}).strict();

/** Entrada: festa (id do Core via plano/tela), categoria fechada e, opcionalmente, parâmetros ESCRITOS pelo operador. */
export const entradaConsumo = z.object({
  id: z.string().uuid(),
  categoria: z.enum(CATEGORIAS_CONSUMO),
  porConvidado: z.number().int().min(1).max(100).optional(),
  mlPorConvidado: z.number().int().min(1).max(5000).optional(),
  embalagemMl: z.number().int().min(50).max(20000).optional(),
  margemPercentual: z.number().int().min(0).max(100).optional(),
  distribuicao: z.array(distribuicaoSchema).min(2).max(10).optional(),
}).strict();

type Regra = { origem: "EMPRESA"; versao: number; porConvidado: number | null; mlPorConvidado: number | null; embalagemMl: number | null; margemPercentual: number | null }
  | { origem: "OPERADOR"; porConvidado: number | null; mlPorConvidado: number | null; embalagemMl: number | null; margemPercentual: number | null };

async function regraVigente(empresaId: string, categoria: CategoriaConsumo, contexto: ContextoFerramenta): Promise<RegraConsumoDominio | null> {
  const porta = contexto.portas.parametrosConsumo;
  if (!porta) return null;
  const r = await porta.vigente(empresaId, categoria);
  return r === "INDISPONIVEL" ? null : r;
}

function descreverRegra(regra: Regra, categoria: CategoriaConsumo): Fato {
  const partes = categoria === "DOCES"
    ? [regra.porConvidado ? `${regra.porConvidado} docinhos por convidado` : null]
    : [regra.mlPorConvidado ? `${formatar(regra.mlPorConvidado)} mL por convidado` : null, regra.embalagemMl ? `embalagem de ${litros(regra.embalagemMl)}` : null];
  if (regra.margemPercentual) partes.push(`margem de ${regra.margemPercentual}%`);
  const texto = partes.filter(Boolean).join(", ");
  return regra.origem === "EMPRESA"
    ? fato(`Regra da empresa (versão ${regra.versao}): ${texto}.`, FONTE_REGRA)
    : calculo(`Parâmetro informado por você só para este cálculo: ${texto} (não foi salvo como padrão).`, FONTE_INFORMADO);
}

export const calcularConsumo: Ferramenta<RespostaLeitura> = {
  nome: "operacional.calcular_consumo",
  capacidade: "calcular_consumo",
  classe: "READ",
  grupo: "READ",
  entrada: entradaConsumo,
  papeis: PAPEIS_ADMIN,
  descricao: "Quantidade de doces ou refrigerantes para uma festa: convidados do contrato vigente × regra da empresa (ou parâmetro informado), com fórmula e arredondamento.",
  entidade: "festa",
  modo: "SERVICO_PROPRIO",
  preparar(parametros) {
    const p = entradaConsumo.parse(parametros);
    return async (tenant, contexto) => {
      const c = await lerContexto(p.id, "calcular_consumo", contexto);
      if ("capacidade" in c) return c;
      const campos: CampoBuffet[] = p.categoria === "DOCES" ? ["doces"] : ["bebidas"];
      const fatos = fatosBase(c, campos);
      const informado = p.porConvidado !== undefined || p.mlPorConvidado !== undefined || p.embalagemMl !== undefined || p.margemPercentual !== undefined;
      // A regra da empresa é a base; o que o operador escreveu NESTE pedido prevalece só para este cálculo.
      const daEmpresa = await regraVigente(tenant.empresaComprovada, p.categoria, contexto);
      const regraEmpresa: Regra | null = daEmpresa ? { origem: "EMPRESA", versao: daEmpresa.versao, porConvidado: daEmpresa.porConvidado, mlPorConvidado: daEmpresa.mlPorConvidado, embalagemMl: daEmpresa.embalagemMl, margemPercentual: daEmpresa.margemPercentual } : null;
      const regraOperador: Regra | null = informado ? {
        origem: "OPERADOR",
        porConvidado: p.porConvidado ?? null,
        mlPorConvidado: p.mlPorConvidado ?? null,
        embalagemMl: p.embalagemMl ?? null,
        margemPercentual: p.margemPercentual ?? null,
      } : null;
      const porConvidado = p.porConvidado ?? regraEmpresa?.porConvidado ?? null;
      const mlPorConvidado = p.mlPorConvidado ?? regraEmpresa?.mlPorConvidado ?? null;
      const embalagemMl = p.embalagemMl ?? regraEmpresa?.embalagemMl ?? null;
      const margem = p.margemPercentual ?? regraEmpresa?.margemPercentual ?? undefined;
      if (regraEmpresa) fatos.push(descreverRegra(regraEmpresa, p.categoria));
      if (regraOperador) fatos.push(descreverRegra(regraOperador, p.categoria));

      const resposta = (estado: RespostaLeitura["estado"], resumo: string, extras: Fato[]) => montarResposta("calcular_consumo", contexto, {
        estado, resumo, fatos: [...fatos, ...extras], fontes: [FONTE, FONTE_VIGENTE, FONTE_BUFFET, ...(regraEmpresa ? [FONTE_REGRA] : []), ...(regraOperador ? [FONTE_INFORMADO] : []), FONTE_CALCULO], entidades: entidade(c),
      });
      if (!c.convidados) return resposta("sem_dados", "Não consigo calcular: o contrato vigente não informa o número de convidados.", []);

      if (p.categoria === "DOCES") {
        if (!porConvidado) {
          return resposta("atencao", PERGUNTA_DOCES, [ausencia("A empresa ainda não tem regra de docinhos por convidado cadastrada.", FONTE_PARAMETRO_AUSENTE)]);
        }
        const r = calcularDoces(c.convidados, porConvidado, margem, p.distribuicao as DistribuicaoInformada[] | undefined);
        const extras: Fato[] = r.formula.map((f) => calculo(f, FONTE_CALCULO));
        const escolhidos = c.escolhas.doces;
        if (r.tipo === "DISTRIBUICAO_INVALIDA") {
          extras.push(ausencia(`${r.motivo} Informe a divisão de novo para eu calcular cada tipo.`, FONTE_CALCULO));
          return resposta("atencao", `Total: ${formatar(r.total)} docinhos. A divisão informada não fecha.`, extras);
        }
        if (!r.distribuicao && escolhidos) extras.push(ausencia(`Divisão entre os tipos escolhidos não definida: como dividir os ${formatar(r.total)} docinhos? Informe percentuais ou quantidades.`, FONTE_CALCULO));
        if (regraOperador?.porConvidado) extras.push(calculo(`Para usar como padrão da empresa, peça: "salvar ${porConvidado} docinhos por convidado como padrão" (proposta separada, com a sua confirmação).`, FONTE_INFORMADO));
        return resposta(escolhidos && r.distribuicao ? "informativo" : "atencao",`Total: ${formatar(r.total)} docinhos para ${formatar(c.convidados)} convidados.`, extras);
      }

      // REFRIGERANTES: taxa e embalagem só da regra ou do texto; nunca do nome do pacote.
      if (!mlPorConvidado) {
        return resposta("atencao", `${PERGUNTA_TAXA_REFRIGERANTE}${embalagemMl ? "" : ` E ${PERGUNTA_EMBALAGEM.charAt(0).toLowerCase()}${PERGUNTA_EMBALAGEM.slice(1)}`}`, [
          ausencia("A empresa ainda não tem regra de consumo de refrigerante cadastrada.", FONTE_PARAMETRO_AUSENTE),
        ]);
      }
      const r = calcularRefrigerantes(c.convidados, mlPorConvidado, embalagemMl ?? undefined, margem);
      const extras: Fato[] = r.formula.map((f) => calculo(f, FONTE_CALCULO));
      if (r.embalagens === null) {
        extras.push(ausencia("Tamanho da embalagem não informado.", FONTE_PARAMETRO_AUSENTE));
        return resposta("atencao", `Total: ${litros(r.totalMl)} de refrigerante. ${PERGUNTA_EMBALAGEM}`, extras);
      }
      if (regraOperador?.mlPorConvidado) extras.push(calculo(`Para usar como padrão da empresa, peça: "salvar ${formatar(mlPorConvidado)} ml de refrigerante por convidado${embalagemMl ? `, garrafa de ${litros(embalagemMl)}` : ""} como padrão" (proposta separada, com a sua confirmação).`, FONTE_INFORMADO));
      return resposta("informativo", `Total: ${litros(r.totalMl)} = ${r.embalagens} ${r.embalagens === 1 ? "embalagem" : "embalagens"} de ${litros(embalagemMl!)} para ${formatar(c.convidados)} convidados.`, extras);
    };
  },
};
