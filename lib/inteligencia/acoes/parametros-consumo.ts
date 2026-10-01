import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import type { CampoRascunho } from "../contratos.ts";
import { categoriasCitadas, extrairParametros, formatar, litros, type CategoriaConsumo, type ParametroPerguntado } from "../operacional/consumo.ts";
import { InteligenciaError } from "../politica.ts";
import type { DefinicaoCampo, FerramentaAcao } from "./tipos.ts";

/**
 * Salvar parâmetro de consumo como PADRÃO da empresa (IA operacional, marco B) — proposta SEPARADA do cálculo.
 *
 * O parâmetro informado num cálculo vale só para ele; tornar padrão exige este pedido explícito, prévia com escopo e
 * efeito ("vale para toda a empresa nos próximos cálculos") e a confirmação humana. Grava pelo serviço de domínio
 * (`registrarParametroConsumo`, migration 059): nova versão, versão anterior substituída, autoria, idempotência pela
 * operação do Human Gate e recusa se a regra mudou desde a prévia. Papel: o mesmo de configurações comerciais.
 */
const PAPEIS = ["REPRESENTANTE_AUTORIZADO"] as const;

export type RegraVigente = { versao: number; porConvidado: number | null; mlPorConvidado: number | null; embalagemMl: number | null; margemPercentual: number | null };
export type PortaParametrosAcao = {
  disponivel(tx: DbExecutor): Promise<boolean>;
  vigente(tx: DbExecutor, empresaId: string, categoria: CategoriaConsumo): Promise<RegraVigente | null>;
  registrar(tx: DbExecutor, entrada: {
    empresaId: string; usuarioId: string; categoria: CategoriaConsumo; porConvidado: number | null; mlPorConvidado: number | null;
    embalagemMl: number | null; margemPercentual: number | null; versaoEsperada: number | null; operacaoId: string;
  }): Promise<{ versao: number; repetido: boolean }>;
};

const CAMPOS: readonly DefinicaoCampo[] = [
  { id: "categoria", rotulo: "Categoria", obrigatorio: true, perguntar: true, pergunta: "É a regra de doces ou de refrigerantes?" },
  { id: "porConvidado", rotulo: "Docinhos por convidado", obrigatorio: true, perguntar: true, pergunta: "Quantos docinhos por convidado a empresa utiliza?" },
  { id: "mlPorConvidado", rotulo: "Refrigerante por convidado", obrigatorio: true, perguntar: true, pergunta: "Quantos mL de refrigerante por convidado?" },
  { id: "embalagemMl", rotulo: "Embalagem", obrigatorio: true, perguntar: true, pergunta: "Qual é o tamanho da embalagem (ex.: garrafa de 2 L)?" },
];

const PERGUNTADO: Partial<Record<string, ParametroPerguntado>> = { porConvidado: "POR_CONVIDADO", mlPorConvidado: "ML_POR_CONVIDADO", embalagemMl: "EMBALAGEM" };

const schema = z.object({
  categoria: z.enum(["DOCES", "REFRIGERANTES"]),
  porConvidado: z.number().int().min(1).max(100).nullable().default(null),
  mlPorConvidado: z.number().int().min(1).max(5000).nullable().default(null),
  embalagemMl: z.number().int().min(50).max(20000).nullable().default(null),
  margemPercentual: z.number().int().min(0).max(100).nullable().default(null),
  /** Versão vigente vista na prévia (preenchida pela verificação no domínio). */
  versaoAtual: z.number().int().min(1).nullable().default(null),
}).strict();
export type PayloadParametro = z.infer<typeof schema>;

function faltando(p: Record<string, unknown>): string[] {
  if (p.categoria !== "DOCES" && p.categoria !== "REFRIGERANTES") return ["categoria"];
  if (p.categoria === "DOCES") return typeof p.porConvidado === "number" ? [] : ["porConvidado"];
  return [...(typeof p.mlPorConvidado === "number" ? [] : ["mlPorConvidado"]), ...(typeof p.embalagemMl === "number" ? [] : ["embalagemMl"])];
}

function extrair(texto: string, perguntado: string | null): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const citadas = categoriasCitadas(texto);
  if (citadas.length === 1) v.categoria = citadas[0];
  // A pergunta feita já diz a categoria (docinhos ⇒ DOCES; mL/embalagem ⇒ REFRIGERANTES).
  const daPergunta: CategoriaConsumo | undefined = perguntado === "porConvidado" ? "DOCES" : perguntado === "mlPorConvidado" || perguntado === "embalagemMl" ? "REFRIGERANTES" : undefined;
  const categoria = (v.categoria ?? daPergunta) as CategoriaConsumo | undefined;
  if (!categoria) return v;
  const p = extrairParametros(texto, categoria, perguntado ? PERGUNTADO[perguntado] ?? null : null);
  for (const [k, valor] of Object.entries(p)) if (k !== "distribuicao" && typeof valor === "number") v[k] = valor;
  return v;
}

function descrever(p: Partial<PayloadParametro>): string {
  if (p.categoria === "DOCES") return `${p.porConvidado ?? "?"} docinhos por convidado${p.margemPercentual ? `, margem de ${p.margemPercentual}%` : ""}`;
  return `${p.mlPorConvidado ? formatar(p.mlPorConvidado) : "?"} mL de refrigerante por convidado${p.embalagemMl ? `, embalagem de ${litros(p.embalagemMl)}` : ""}${p.margemPercentual ? `, margem de ${p.margemPercentual}%` : ""}`;
}

export function criarAcaoParametroConsumo(porta: PortaParametrosAcao): FerramentaAcao<PayloadParametro> {
  return {
    nome: "operacional.salvar_parametro_consumo",
    capacidade: "salvar_parametro_consumo",
    classe: "CONFIRM",
    grupo: "ADMIN_ACTIONS",
    papeis: PAPEIS,
    descricao: "Salvar como padrão da empresa a regra de doces ou refrigerantes por convidado (nova versão, com confirmação).",
    titulo: "Regra de consumo da empresa",
    campos: CAMPOS,
    extrair: (texto, perguntado) => extrair(texto, perguntado),
    faltando,
    validar(payload) {
      const lido = schema.safeParse(Object.fromEntries(Object.entries(payload).filter(([k]) => k in schema.shape)));
      if (!lido.success) throw new InteligenciaError("DADOS_INVALIDOS", "Confira os números da regra de consumo.", 422);
      const p = lido.data;
      // Só os campos da categoria: doce não tem embalagem; refrigerante não tem unidades por convidado.
      return p.categoria === "DOCES" ? { ...p, mlPorConvidado: null, embalagemMl: null } : { ...p, porConvidado: null };
    },
    async verificar(tx, tenant, payload) {
      if (!await porta.disponivel(tx)) throw new InteligenciaError("FONTE_INDISPONIVEL", "A regra de consumo ainda não pode ser salva neste ambiente (a fonte de parâmetros não foi instalada). O cálculo continua perguntando o parâmetro.", 503);
      const atual = await porta.vigente(tx, tenant.empresaComprovada, payload.categoria);
      const avisos = [
        "Vale para toda a empresa nos próximos cálculos; respostas já dadas não mudam.",
        atual ? `Substitui a regra atual (versão ${atual.versao}: ${descrever({ categoria: payload.categoria, ...atual })}), que fica no histórico.` : "Primeira regra desta categoria na empresa.",
      ];
      return { payload: { ...payload, versaoAtual: atual?.versao ?? null }, avisos };
    },
    apresentar(p): CampoRascunho[] {
      return [
        { id: "regra", rotulo: "Regra", valor: p.categoria ? descrever(p as Partial<PayloadParametro>) : null, obrigatorio: true },
        { id: "escopo", rotulo: "Escopo", valor: "Empresa atual, conferida na hora de gravar", obrigatorio: false },
        { id: "versao", rotulo: "Versão", valor: typeof p.versaoAtual === "number" ? `Nova versão ${p.versaoAtual + 1}` : "Versão 1", obrigatorio: false },
      ];
    },
    async executar(tx, tenant, p, ctx) {
      const r = await porta.registrar(tx, {
        empresaId: tenant.empresaComprovada, usuarioId: ctx.usuarioId, categoria: p.categoria, porConvidado: p.porConvidado,
        mlPorConvidado: p.mlPorConvidado, embalagemMl: p.embalagemMl, margemPercentual: p.margemPercentual, versaoEsperada: p.versaoAtual, operacaoId: ctx.operacaoId,
      });
      return { mensagem: `Regra salva como padrão da empresa: ${descrever(p)} (versão ${r.versao}).`, entidadeId: `${p.categoria}:${r.versao}` };
    },
  };
}
