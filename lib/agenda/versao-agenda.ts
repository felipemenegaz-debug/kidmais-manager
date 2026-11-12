import { createHash } from "node:crypto";

/**
 * Versão do agregado da agenda de um escopo (plano "Agenda: concorrência otimista do agregado", rev. 1.1, 25/10/2026).
 * `va1:` + SHA-256 de tuplas posicionais (sem objetos: a ordem das chaves não interfere), montadas a partir das linhas
 * da projeção única (`projecaoAgenda` em configuracao-unidade.ts). Listas ordenadas por id em comparação de unidades de
 * código, sem collation do banco nem localeCompare. Ficam fora: auditoria, nomes de usuários, festas e as regras
 * copiadas (decisão (b): derivadas do estado atual na gravação).
 */
export const PREFIXO_VERSAO_AGENDA = "va1:";
export const FORMATO_VERSAO_AGENDA = /^va1:[0-9a-f]{64}$/;

export type LinhaConfigProjecao = { modo: string; capacidade_tipo: string; limite_festas_dia: number | null; intervalo_minimo_minutos: number };
export type LinhaSalaoProjecao = {
  id: string; nome: string; capacidade_convidados: number | null; ordem: number; ativo: boolean;
  /** Só com a 098; sem ela, null. */
  combinado: boolean | null; membros: string[] | null;
};
export type LinhaHorarioProjecao = {
  id: string; codigo: string; nome: string; inicio: string; fim: string; dias_semana: number[] | null; capacidade: number;
  ordem_exibicao: number; ativo: boolean; horario_livre: boolean; desativado_a_partir_de: string | null;
  tolerancia_inicio_minutos: number; passo_inicio_minutos: number;
};
export type NivelHeranca = "PROPRIO" | "EMPRESA" | "GLOBAL" | "NENHUM";
export type ProjecaoVersao = {
  empresaId: string;
  estabelecimentoId: string | null;
  v098: boolean;
  config: LinhaConfigProjecao | null;
  saloes: LinhaSalaoProjecao[];
  /** Todas as linhas próprias do escopo: ativas, inativas e o horário livre. */
  proprios: LinhaHorarioProjecao[];
  nivel: NivelHeranca;
  /** Herdados efetivos (vazio quando o nível é PROPRIO ou NENHUM). */
  herdados: LinhaHorarioProjecao[];
  vinculos: Array<{ configuracao_agenda_id: string; salao_id: string }>;
};

/** A projeção agrega em JSON: smallint/integer chegam como número. Texto, booleano ou NULL fora do lugar recusam. */
function inteiro(valor: unknown, campo: string): number {
  if (typeof valor !== "number" || !Number.isInteger(valor)) throw new Error(`versão da agenda: ${campo} não é inteiro`);
  return valor;
}
const inteiroOuNulo = (valor: unknown, campo: string) => (valor === null || valor === undefined ? null : inteiro(valor, campo));
function texto(valor: unknown, campo: string): string {
  if (typeof valor !== "string") throw new Error(`versão da agenda: ${campo} não é texto`);
  return valor;
}
const textoOuNulo = (valor: unknown, campo: string) => (valor === null || valor === undefined ? null : texto(valor, campo));
function booleano(valor: unknown, campo: string): boolean {
  if (typeof valor !== "boolean") throw new Error(`versão da agenda: ${campo} não é booleano`);
  return valor;
}
const porId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const textoCrescente = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function tuplaSalao(s: LinhaSalaoProjecao, v098: boolean) {
  return [
    texto(s.id, "salão.id"), texto(s.nome, "salão.nome"), inteiroOuNulo(s.capacidade_convidados, "salão.capacidade"),
    inteiro(s.ordem, "salão.ordem"), booleano(s.ativo, "salão.ativo"),
    v098 ? booleano(s.combinado, "salão.combinado") : null,
    v098 && s.membros != null ? s.membros.map((m) => texto(m, "salão.membro")).sort(textoCrescente) : null,
  ];
}

function tuplaHorario(h: LinhaHorarioProjecao) {
  return [
    texto(h.id, "horário.id"), texto(h.codigo, "horário.codigo"), texto(h.nome, "horário.nome"),
    texto(h.inicio, "horário.inicio"), texto(h.fim, "horário.fim"),
    // NULL = todos os dias (distinto de {1..7}); array ordenado sem remover repetidos.
    h.dias_semana == null ? null : h.dias_semana.map((d) => inteiro(d, "horário.dia")).sort((a, b) => a - b),
    inteiro(h.capacidade, "horário.capacidade"), inteiro(h.ordem_exibicao, "horário.ordem"), booleano(h.ativo, "horário.ativo"),
    booleano(h.horario_livre, "horário.livre"), textoOuNulo(h.desativado_a_partir_de, "horário.desativado"),
    inteiro(h.tolerancia_inicio_minutos, "horário.tolerancia"), inteiro(h.passo_inicio_minutos, "horário.passo"),
  ];
}

/** Tuplas canônicas (exportadas para os testes). */
export function tuplasVersaoAgenda(p: ProjecaoVersao) {
  const config = p.config == null ? null : [
    texto(p.config.modo, "config.modo"), texto(p.config.capacidade_tipo, "config.capacidade_tipo"),
    inteiroOuNulo(p.config.limite_festas_dia, "config.limite"), inteiro(p.config.intervalo_minimo_minutos, "config.intervalo"),
  ];
  const heranca = p.nivel === "PROPRIO" ? ["PROPRIO"] : [p.nivel, [...p.herdados].sort(porId).map(tuplaHorario)];
  const vinculos = p.vinculos
    .map((v) => [texto(v.configuracao_agenda_id, "vínculo.horário"), texto(v.salao_id, "vínculo.salão")] as const)
    .sort((a, b) => textoCrescente(a[0], b[0]) || textoCrescente(a[1], b[1]));
  return [
    "kidmais.agenda.versao", 1,
    texto(p.empresaId, "empresa"), textoOuNulo(p.estabelecimentoId, "estabelecimento"), p.v098,
    config,
    [...p.saloes].sort(porId).map((s) => tuplaSalao(s, p.v098)),
    [...p.proprios].sort(porId).map(tuplaHorario),
    heranca,
    vinculos,
  ];
}

export function versaoAgenda(p: ProjecaoVersao): string {
  return PREFIXO_VERSAO_AGENDA + createHash("sha256").update(JSON.stringify(tuplasVersaoAgenda(p)), "utf8").digest("hex");
}

/** Normalização da rota (P2-1 do parecer): só uma string no formato exato é candidata; qualquer outro valor vira null. */
export function versaoInformada(valor: unknown): string | null {
  return typeof valor === "string" && FORMATO_VERSAO_AGENDA.test(valor) ? valor : null;
}
