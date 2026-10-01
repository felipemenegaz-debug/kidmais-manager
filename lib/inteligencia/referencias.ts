import type { ContextoTela, EntidadeRef, RespostaLeitura, TipoEntidade } from "./contratos.ts";
import type { FocoEntrada } from "./foco.ts";
import { InteligenciaError } from "./politica.ts";
import { normalizar } from "./texto-pt.ts";

/**
 * Reference Resolver (AI V1.1, PR 5): referências humanas → UMA entidade do Core, deterministicamente.
 *
 * Prioridade: (1) entidade compatível da TELA aberta; (2) entidade principal do FOCO; (3) relação do Core a partir
 * dela; (4) outra entidade compatível do foco, só se for a única; (5) senão AMBÍGUO/NÃO ENCONTRADO — nunca palpite.
 * Temporais ("próxima", "sábado"…) usam `proximas_festas`; nome de cliente usa `buscar_clientes`.
 *
 * Toda leitura é feita por `ler`, que é o gateway (Policy + Tenant Context + posse/capacidade no domínio): o foco e a
 * tela são só dicas, e um id de outra empresa ou sem autoridade vira NEGADA. Nunca aceita id do texto nem do modelo.
 */
export type TipoReferencia = "TEMPORAL" | "DEITICO" | "PRONOME" | "NOME" | "IMPLICITA";
export type OrigemResolucao = "TELA" | "FOCO" | "TEMPORAL" | "RELACAO_CORE" | "BUSCA";
export type ResultadoResolucao = "RESOLVIDA" | "AMBIGUA" | "NAO_ENCONTRADA" | "NEGADA";

/** `ULTIMO_CONTRATO` (PR 6): o contrato mais recente, pelo critério do painel de Contratos (`ultimo_contrato`). */
type Temporal = { seletor: "PROXIMA" | "ULTIMA" | "DIA" | "ULTIMO_CONTRATO"; dia?: string; rotulo: string };
export type Referencia = {
  tipo: TipoReferencia;
  /** Entidade pedida no texto ("o cliente dela" ⇒ CLIENTE); null quando o alvo é a própria âncora ("quem é ele?"). */
  alvo: TipoEntidade | null;
  deitico?: TipoEntidade;
  genero?: "M" | "F";
  temporal?: Temporal;
  nome?: string;
  /** Pergunta financeira (PR 5.5): o alvo é o CONTRATO da entidade referida (ou da tela/foco, se implícita). */
  financeiro?: "SALDO" | "PARCELA";
};

export type Resolucao = {
  referencia: Referencia;
  resultado: ResultadoResolucao;
  origem: OrigemResolucao | null;
  /** Entidade final (alvo) quando RESOLVIDA. */
  entidade: EntidadeRef | null;
  /** Âncora usada (para o foco): a festa de "o cliente dela", por exemplo. */
  ancora: EntidadeRef | null;
  /** Opções quando AMBÍGUA (com rótulo vindo de leitura fresca do Core). */
  candidatos: EntidadeRef[];
  /** Ids do foco negados/inexistentes na revalidação (saem do foco). */
  descartados: string[];
};

/** Leitura pelo gateway. Lança InteligenciaError 403/404 quando a Policy/tenant/domínio recusam. */
export type Leitor = (capacidade: string, parametros: Record<string, unknown>) => Promise<RespostaLeitura>;

// ---------------------------------------------------------------- detecção

const SUBSTANTIVOS: ReadonlyArray<[TipoEntidade, RegExp]> = [
  ["CLIENTE", /\b(clientes?|cadastro|contratante)\b/],
  ["CONTRATO", /\bcontratos?\b/],
  ["FESTA", /\bfestas?\b/],
  ["CATEGORIA", /\bcategorias?\b/],
  ["ITEM", /\bite(m|ns)\b/],
];
const DEITICO = /\b(ess[ae]|est[ae]|aquel[ae]|dess[ae]|dest[ae]|daquel[ae]|ness[ae]|nest[ae]|naquel[ae])\s+(festa|cliente|contrato|item|categoria)\b/;
const PRONOME = /\b(ele|ela|dele|dela|nele|nela)\b/;
const DIAS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"] as const;

function somarDias(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const dataCurta = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** "Evento" é sinônimo de festa nas expressões temporais (PR 6.3): "próximo evento", "último evento", "evento de sábado". */
const FESTA_OU_EVENTO = /\b(festas?|eventos?)\b/;

function temporalDe(n: string, hoje: string): Temporal | null {
  if (!FESTA_OU_EVENTO.test(n)) return null;
  if (/\bproxima festa\b|\bfesta seguinte\b|\bproximo evento\b|\bevento seguinte\b/.test(n)) return { seletor: "PROXIMA", rotulo: "a próxima festa" };
  if (/\bultima festa\b|\bfesta anterior\b|\bultimo evento\b|\bevento anterior\b/.test(n)) return { seletor: "ULTIMA", rotulo: "a última festa" };
  if (/\bdepois de amanha\b/.test(n)) { const dia = somarDias(hoje, 2); return { seletor: "DIA", dia, rotulo: `festa de ${dataCurta(dia)}` }; }
  if (/\bamanha\b/.test(n)) { const dia = somarDias(hoje, 1); return { seletor: "DIA", dia, rotulo: "festa de amanhã" }; }
  if (/\bhoje\b/.test(n)) return { seletor: "DIA", dia: hoje, rotulo: "festa de hoje" };
  const semana = DIAS.findIndex((d) => new RegExp(`\\b${d}(-feira)?\\b`).test(n));
  if (semana >= 0) {
    const atual = new Date(`${hoje}T12:00:00Z`).getUTCDay();
    const dia = somarDias(hoje, (semana - atual + 7) % 7);
    return { seletor: "DIA", dia, rotulo: `festa de ${DIAS[semana] === "sabado" ? "sábado" : DIAS[semana] === "terca" ? "terça" : DIAS[semana]} (${dataCurta(dia)})` };
  }
  const data = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/.exec(n);
  if (data) {
    const [, d, m, a] = data;
    const dia = `${a ?? hoje.slice(0, 4)}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(`${dia}T00:00:00Z`)) && Number(m) <= 12 && Number(d) <= 31) return { seletor: "DIA", dia, rotulo: `festa de ${dataCurta(dia)}` };
  }
  return null;
}

/** Nome próprio depois de "cadastro/cliente da|do|de" no texto ORIGINAL (só letras). */
function nomeDe(texto: string): string | null {
  const m = /\b(?:cadastro|cliente|contratante)\s+d[aoe]\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][\p{L}'-]+){0,4})/u.exec(texto);
  return m && m[1].length >= 3 && m[1].length <= 60 ? m[1] : null;
}

/** Entidades citadas no texto, na ordem, fora do trecho da âncora. */
function substantivos(n: string, exceto: [number, number] | null): TipoEntidade[] {
  return SUBSTANTIVOS.flatMap(([tipo, r]) => {
    const g = new RegExp(r.source, "g");
    const achados: number[] = [];
    for (let m = g.exec(n); m; m = g.exec(n)) if (!exceto || m.index < exceto[0] || m.index >= exceto[1]) achados.push(m.index);
    return achados.map((i) => ({ tipo, i }));
  }).sort((a, b) => a.i - b.i).map((x) => x.tipo);
}

/** "quanto falta pagar", "saldo", "em aberto" ⇒ SALDO; "próxima parcela" ⇒ PARCELA. */
function financeiroDe(n: string): Referencia["financeiro"] {
  if (/\bproxima parcela\b/.test(n)) return "PARCELA";
  if (/\bquanto (ainda )?(falta|resta)\w* (pagar|receber|quitar)\b|\bsaldo\b|\bem aberto\b|\bfalta (pagar|receber)\b/.test(n)) return "SALDO";
  return undefined;
}

/** Referência no pedido (ou null). Não lê dado nenhum. */
export function detectarReferencia(texto: string, hoje: string): Referencia | null {
  const financeiro = financeiroDe(normalizar(texto));
  const ref = detectarAncora(texto, hoje);
  if (!financeiro) return ref;
  // Financeiro: o alvo é sempre o contrato; sem âncora explícita, a da tela/foco (IMPLICITA).
  return ref ? { ...ref, alvo: "CONTRATO", financeiro } : { tipo: "IMPLICITA", alvo: "CONTRATO", financeiro };
}

/** Tipos de entidade citados no texto, na ordem (sem repetição). Não lê dado nenhum. */
export function entidadesCitadas(texto: string): TipoEntidade[] {
  return [...new Set(substantivos(normalizar(texto), null))];
}

const ULTIMO_CONTRATO = /\b(ultimo|mais recente) contrato\b/;

function detectarAncora(texto: string, hoje: string): Referencia | null {
  const n = normalizar(texto);
  const ultimo = ULTIMO_CONTRATO.exec(n);
  if (ultimo) {
    const alvo = substantivos(n, [ultimo.index, ultimo.index + ultimo[0].length])[0] ?? "CONTRATO";
    return { tipo: "TEMPORAL", alvo, temporal: { seletor: "ULTIMO_CONTRATO", rotulo: "o último contrato" } };
  }
  const temporal = temporalDe(n, hoje);
  if (temporal) {
    const festa = FESTA_OU_EVENTO.exec(n)!;
    const alvo = substantivos(n, [festa.index, festa.index + festa[0].length])[0] ?? "FESTA";
    return { tipo: "TEMPORAL", alvo, temporal };
  }
  const deitico = DEITICO.exec(n);
  if (deitico) {
    const tipo = SUBSTANTIVOS.find(([, r]) => r.test(deitico[2]))![0];
    const alvo = substantivos(n, [deitico.index, deitico.index + deitico[0].length])[0] ?? tipo;
    return { tipo: "DEITICO", alvo, deitico: tipo };
  }
  const nome = nomeDe(texto);
  if (nome) return { tipo: "NOME", alvo: "CLIENTE", nome };
  const pronome = PRONOME.exec(n);
  if (pronome) {
    const alvo = substantivos(n, null)[0] ?? null;
    return { tipo: "PRONOME", alvo, genero: /^(n|d)?ela$/.test(pronome[1]) ? "F" : "M" };
  }
  return null;
}

// ---------------------------------------------------------------- resolução

/** Relações que o Core fornece (nunca inferidas por texto). */
export const RELACOES: Readonly<Record<TipoEntidade, readonly TipoEntidade[]>> = {
  FESTA: ["CLIENTE", "CONTRATO"],
  CONTRATO: ["CLIENTE", "FESTA"],
  CLIENTE: [],
  ITEM: ["CATEGORIA"],
  CATEGORIA: [],
};
export const LEITURA_DE_RELACAO: Partial<Record<TipoEntidade, string>> = { FESTA: "relacoes_festa", CONTRATO: "relacoes_contrato" };
const TELA_DE: Partial<Record<TipoEntidade, ContextoTela["tela"]>> = { FESTA: "festa", CLIENTE: "cliente", CONTRATO: "contrato" };

function compativel(tipo: TipoEntidade, ref: Referencia): boolean {
  if (ref.genero === "F" && (tipo === "CONTRATO" || tipo === "ITEM")) return false;
  if (ref.genero === "M" && (tipo === "FESTA" || tipo === "CATEGORIA")) return false;
  if (ref.deitico) return tipo === ref.deitico;
  if (!ref.alvo) return tipo === "CLIENTE" || tipo === "FESTA" || tipo === "CONTRATO";
  return tipo === ref.alvo || RELACOES[tipo].includes(ref.alvo);
}

const negada = (erro: unknown) => erro instanceof InteligenciaError && (erro.httpStatus === 403 || erro.httpStatus === 404);

/** Revalida uma entidade do foco/tela no Core e devolve a referência com rótulo fresco (ou null se negada). */
async function revalidar(ler: Leitor, e: { tipo: TipoEntidade; id: string }): Promise<EntidadeRef | null> {
  try {
    const capacidade = e.tipo === "FESTA" ? "relacoes_festa" : e.tipo === "CONTRATO" ? "relacoes_contrato" : e.tipo === "CLIENTE" ? "resumir_cliente" : "buscar_catalogo";
    const parametros = e.tipo === "ITEM" || e.tipo === "CATEGORIA" ? { tipo: e.tipo, limite: 30 } : { id: e.id };
    const r = await ler(capacidade, parametros);
    return r.entidades?.find((x) => x.tipo === e.tipo && x.id === e.id) ?? null;
  } catch (erro) {
    if (negada(erro)) return null;
    throw erro;
  }
}

export type DependenciasResolucao = { contexto: ContextoTela | null; foco: FocoEntrada | null; hoje: string; ler: Leitor };

/**
 * Âncora de TELA/FOCO (dêitico, pronome, implícita): (1) tela aberta compatível; (2) principal do foco; (4) única
 * compatível no foco. Cada uma revalidada no Core; nunca palpite. RESOLVIDA traz `ancora` (com relações do Core).
 */
export async function resolverAncoraContexto(ref: Referencia, deps: DependenciasResolucao): Promise<Resolucao> {
  const base = { referencia: ref, entidade: null, ancora: null, candidatos: [] as EntidadeRef[], descartados: [] as string[] };
  const fim = (resultado: ResultadoResolucao, origem: OrigemResolucao | null, extra: Partial<Resolucao> = {}): Resolucao => ({ ...base, resultado, origem, ...extra });
  const tela = deps.contexto?.entidadeId ? (Object.entries(TELA_DE).find(([, v]) => v === deps.contexto!.tela)?.[0] as TipoEntidade | undefined) : undefined;
  if (tela && compativel(tela, ref)) {
    const ancora = await revalidar(deps.ler, { tipo: tela, id: deps.contexto!.entidadeId! });
    return ancora ? fim("RESOLVIDA", "TELA", { ancora, entidade: ancora }) : fim("NEGADA", "TELA");
  }
  const foco = deps.foco?.entidades ?? [];
  // Principal só se a UI o reenviou (resposta com UMA entidade principal; lista não tem principal).
  const principal = deps.foco?.principal != null ? foco[deps.foco.principal] : undefined;
  const compativeis = foco.filter((e) => compativel(e.tipo, ref));
  const ordem = principal && compativel(principal.tipo, ref) ? [principal] : compativeis;
  if (!ordem.length) return fim("NAO_ENCONTRADA", "FOCO");
  const validas: EntidadeRef[] = [];
  const descartados: string[] = [];
  for (const e of ordem.slice(0, 5)) {
    const v = await revalidar(deps.ler, e);
    if (v) validas.push(v); else descartados.push(e.id);
  }
  if (!validas.length) return fim("NEGADA", "FOCO", { descartados });
  if (validas.length > 1) return fim("AMBIGUA", "FOCO", { candidatos: validas, descartados });
  return fim("RESOLVIDA", "FOCO", { ancora: validas[0], entidade: validas[0], descartados });
}

export async function resolverReferencia(ref: Referencia, deps: DependenciasResolucao): Promise<Resolucao> {
  const base = { referencia: ref, entidade: null, ancora: null, candidatos: [] as EntidadeRef[], descartados: [] as string[] };
  const fim = (resultado: ResultadoResolucao, origem: OrigemResolucao | null, extra: Partial<Resolucao> = {}): Resolucao => ({ ...base, resultado, origem, ...extra });

  // 1. Âncora.
  let ancora: EntidadeRef | null = null;
  let origem: OrigemResolucao | null = null;
  if (ref.tipo === "TEMPORAL" && ref.temporal?.seletor === "ULTIMO_CONTRATO") {
    const contratos = (await deps.ler("ultimo_contrato", {})).entidades ?? [];
    if (!contratos.length) return fim("NAO_ENCONTRADA", "TEMPORAL");
    // Empate no instante de criação: o Core devolve os dois ⇒ ambíguo, nunca escolhe.
    if (contratos.length > 1) return fim("AMBIGUA", "TEMPORAL", { candidatos: contratos });
    ancora = contratos[0];
    origem = "TEMPORAL";
  } else if (ref.tipo === "TEMPORAL" && ref.temporal) {
    const t = ref.temporal;
    const parametros = t.seletor === "DIA" ? { ordem: "ASC", inicio: t.dia, fim: t.dia, limite: 5 } : { ordem: t.seletor === "PROXIMA" ? "ASC" : "DESC", limite: 2 };
    const festas = (await deps.ler("proximas_festas", parametros)).entidades ?? [];
    if (!festas.length) return fim("NAO_ENCONTRADA", "TEMPORAL");
    // Empate real (mesma data e hora) ou mais de uma no dia ⇒ ambíguo, nunca escolhe.
    const empate = t.seletor !== "DIA" && festas.length > 1 && festas[0].rotulo.split(" — ")[1] === festas[1].rotulo.split(" — ")[1];
    if ((t.seletor === "DIA" && festas.length > 1) || empate) return fim("AMBIGUA", "TEMPORAL", { candidatos: festas });
    ancora = festas[0];
    origem = "TEMPORAL";
  } else if (ref.tipo === "NOME" && ref.nome) {
    const clientes = (await deps.ler("buscar_clientes", { termo: ref.nome })).entidades ?? [];
    if (!clientes.length) return fim("NAO_ENCONTRADA", "BUSCA");
    if (clientes.length > 1) return fim("AMBIGUA", "BUSCA", { candidatos: clientes });
    ancora = clientes[0];
    origem = "BUSCA";
  } else {
    const r = await resolverAncoraContexto(ref, deps);
    if (r.resultado !== "RESOLVIDA" || !r.ancora) return r;
    ancora = r.ancora;
    origem = r.origem;
    base.descartados = r.descartados;
  }

  // 2. Alvo: a própria âncora ou uma relação do Core a partir dela.
  if (!ref.alvo || ref.alvo === ancora.tipo) return fim("RESOLVIDA", origem, { entidade: ancora, ancora });
  const leitura = RELACOES[ancora.tipo].includes(ref.alvo) ? LEITURA_DE_RELACAO[ancora.tipo] : undefined;
  if (!leitura) return fim("NAO_ENCONTRADA", origem, { ancora });
  try {
    const relacionada = (await deps.ler(leitura, { id: ancora.id })).entidades?.find((e) => e.tipo === ref.alvo) ?? null;
    return relacionada ? fim("RESOLVIDA", "RELACAO_CORE", { entidade: relacionada, ancora }) : fim("NAO_ENCONTRADA", "RELACAO_CORE", { ancora });
  } catch (erro) {
    if (negada(erro)) return fim("NEGADA", "RELACAO_CORE", { ancora });
    throw erro;
  }
}
