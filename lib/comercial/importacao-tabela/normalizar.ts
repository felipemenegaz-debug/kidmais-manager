import type { LeituraTabela, LinhaLida } from "./esquema.ts";

/**
 * Leitura do PDF → revisão editável (puro, sem banco). Nada aqui grava: produz a proposta que a pessoa confere.
 *
 * - Faixas contínuas: cada linha vale até o seu "ate"; o começo é o fim da anterior + 1 (a primeira começa no "de"
 *   lido ou no mínimo do pacote). Buraco ou sobreposição no PDF vira pendência explicada, nunca preço inventado.
 * - Casamento por nome com o cadastro da empresa; sem par seguro, o pacote é ignorado e o adicional vira "novo".
 */
export type CategoriaPreco = "PADRAO" | "NOBRE" | "GERAL";
export type Faixa = { min: number; max: number | null; valor: number; rotulo: string | null };
export type UnidadeImportada = "PACOTE" | "UNIDADE" | "CENTO" | "CONVIDADO" | "HORA";

export type PacoteCadastro = { id: string; codigo: string; nome: string; descricao: string | null; convidadosMin: number | null; convidadosMax: number | null };
export type AdicionalCadastro = { id: string; codigo: string; nome: string; categoria: string; unidade: string; faixasAtuais: Faixa[] };
export type PacoteAtualPrecos = { pacoteId: string; grades: Array<{ categoria: CategoriaPreco; faixas: Faixa[]; porConvidado: boolean }> };

export type RevisaoPacote = {
  chave: string;
  nomePdf: string;
  pagina: number | null;
  pacoteId: string | null;
  convidadosMin: number | null;
  convidadosMax: number | null;
  cobranca: "FAIXAS" | "POR_CONVIDADO" | "SOB_CONSULTA";
  grades: Array<{ categoria: CategoriaPreco; faixas: Faixa[] }>;
  porConvidado: number | null;
  aPartirDe: number | null;
  descricao: string | null;
  selo: string | null;
  duracao: string | null;
  aplicarDescricao: boolean;
  inclusos: Array<{ texto: string; adicionalId: string | null }>;
  aplicarInclusos: boolean;
  atual: { descricao: string | null; grades: Array<{ categoria: CategoriaPreco; faixas: Faixa[] }> } | null;
  pendencias: string[];
  confirmado: boolean;
};

export type RevisaoAdicional = {
  chave: string;
  nomePdf: string;
  pagina: number | null;
  destino: { tipo: "EXISTENTE"; adicionalId: string } | { tipo: "NOVO"; nome: string } | { tipo: "IGNORAR" };
  categoria: string;
  unidade: UnidadeImportada;
  faixas: Faixa[];
  atual: Faixa[] | null;
  pendencias: string[];
  confirmado: boolean;
};

export type RevisaoTabela = {
  esquema: 1;
  pacotes: RevisaoPacote[];
  adicionais: RevisaoAdicional[];
  comuns: string[];
  horarios: Array<{ horario: "PROMOCIONAL" | "NOBRE"; descricao: string }>;
  informacoes: string[];
  naoImportavel: Array<{ texto: string; pagina: number | null; motivo: string }>;
  conferencias: Array<{ ok: boolean; texto: string }>;
};

const PALAVRAS_VAZIAS = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "com", "em", "para", "por", "festa", "kidmais"]);

export function tokens(nome: string): string[] {
  return nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((t) => t && !PALAVRAS_VAZIAS.has(t));
}

/** Semelhança de Jaccard entre os conjuntos de palavras (sem acento, sem palavras vazias). */
export function semelhanca(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let comum = 0;
  for (const t of x) if (y.has(t)) comum++;
  return comum / (x.size + y.size - comum);
}

function melhor<T extends { nome: string }>(nome: string, lista: readonly T[], minimo: number): T | null {
  let achado: T | null = null;
  let nota = 0;
  for (const item of lista) {
    const n = semelhanca(nome, item.nome);
    if (n > nota) { nota = n; achado = item; }
  }
  return nota >= minimo ? achado : null;
}

/** Linhas lidas → faixas contínuas a partir de `inicio`. Devolve as pendências encontradas. */
export function faixasContinuas(linhas: readonly LinhaLida[], inicio: number): { faixas: Faixa[]; pendencias: string[] } {
  const pendencias: string[] = [];
  if (!linhas.length) return { faixas: [], pendencias };
  const unicas = linhas.length === 1 && linhas[0].de == null && linhas[0].ate == null;
  if (unicas) return { faixas: [{ min: Math.max(1, inicio), max: null, valor: linhas[0].valor, rotulo: linhas[0].rotulo }], pendencias };
  const ordenadas = [...linhas].sort((a, b) => (a.ate ?? Number.MAX_SAFE_INTEGER) - (b.ate ?? Number.MAX_SAFE_INTEGER));
  const faixas: Faixa[] = [];
  let proximo = Math.max(1, ordenadas[0].de ?? inicio);
  for (const l of ordenadas) {
    if (l.de != null && l.de > proximo) pendencias.push(`Faixa "${l.de} a ${l.ate ?? "…"}" começa em ${l.de}; o sistema cobre a partir de ${proximo}.`);
    if (l.de != null && l.de < proximo && faixas.length) pendencias.push(`Faixa "${l.de} a ${l.ate ?? "…"}" sobrepõe a anterior; o sistema começa em ${proximo}.`);
    const max = l.ate;
    if (max != null && max < proximo) { pendencias.push(`Linha "${max}" repetida ou fora de ordem foi ignorada.`); continue; }
    faixas.push({ min: proximo, max, valor: l.valor, rotulo: l.rotulo });
    if (max == null) break;
    proximo = max + 1;
  }
  return { faixas, pendencias };
}

const CATEGORIA: Record<string, CategoriaPreco> = { PROMOCIONAL: "PADRAO", NOBRE: "NOBRE", UNICO: "GERAL" };
const UNIDADE: Record<string, UnidadeImportada> = { VALOR_FECHADO: "PACOTE", UNIDADE: "UNIDADE", CENTO: "CENTO", CONVIDADO: "CONVIDADO", HORA: "HORA" };

export function normalizarLeitura(
  leitura: LeituraTabela,
  cadastro: { pacotes: readonly PacoteCadastro[]; adicionais: readonly AdicionalCadastro[]; precosPacotes: readonly PacoteAtualPrecos[] },
): RevisaoTabela {
  const conferencias: RevisaoTabela["conferencias"] = [];
  const usados = new Set<string>();
  const pacotes = leitura.pacotes.map((p, i): RevisaoPacote => {
    const par = melhor(p.nome, cadastro.pacotes.filter((c) => !usados.has(c.id)), 0.5);
    if (par) usados.add(par.id);
    const pendencias: string[] = [];
    if (!par) pendencias.push("Nenhum pacote do cadastro com este nome: escolha o correspondente ou ignore.");
    const minimo = p.convidadosMin ?? par?.convidadosMin ?? 1;
    const grades: RevisaoPacote["grades"] = [];
    if (p.cobranca === "FAIXAS") {
      for (const g of p.grades) {
        const { faixas, pendencias: pg } = faixasContinuas(g.linhas, minimo);
        if (faixas.length) grades.push({ categoria: CATEGORIA[g.horario], faixas });
        pendencias.push(...pg.map((t) => `${g.horario === "UNICO" ? "" : `${g.horario === "NOBRE" ? "Nobre" : "Promocional"}: `}${t}`));
      }
      const linhasPorGrade = p.grades.map((g) => g.linhas.length);
      if (linhasPorGrade.length > 1 && new Set(linhasPorGrade).size > 1) pendencias.push("As grades por horário têm quantidades de linhas diferentes.");
      if (grades.some((g) => g.faixas.length > 1 && g.faixas.some((f, k) => k > 0 && f.max != null && f.max - f.min > 0)))
        pendencias.push("Entre duas linhas da grade vale o preço da linha seguinte (ex.: 55 convidados usa o preço de 60).");
      if (!grades.length) pendencias.push("Nenhum preço lido para este pacote.");
    }
    if (p.cobranca === "POR_CONVIDADO" && p.valorPorConvidado == null) pendencias.push("Cobrança por convidado sem valor lido.");
    const ultimo = grades[0]?.faixas.at(-1);
    const convidadosMax = p.convidadosMax ?? (ultimo?.max ?? par?.convidadosMax ?? null);
    const menor = Math.min(...grades.flatMap((g) => g.faixas.map((f) => f.valor)), p.cobranca === "POR_CONVIDADO" && p.valorPorConvidado != null ? p.valorPorConvidado * minimo : Infinity);
    if (p.aPartirDe != null && Number.isFinite(menor)) {
      conferencias.push(menor === p.aPartirDe
        ? { ok: true, texto: `${p.nome}: "a partir de R$ ${p.aPartirDe}" bate com o menor valor da tabela.` }
        : { ok: false, texto: `${p.nome}: "a partir de R$ ${p.aPartirDe}" não bate com o menor valor lido (R$ ${menor}).` });
    }
    const atual = par ? cadastro.precosPacotes.find((x) => x.pacoteId === par.id) : undefined;
    return {
      chave: `p${i}`,
      nomePdf: p.nome,
      pagina: p.pagina,
      pacoteId: par?.id ?? null,
      convidadosMin: minimo,
      convidadosMax,
      cobranca: p.cobranca,
      grades,
      porConvidado: p.cobranca === "POR_CONVIDADO" ? p.valorPorConvidado : null,
      aPartirDe: p.aPartirDe,
      descricao: p.descricao,
      selo: p.selo,
      duracao: p.duracao,
      aplicarDescricao: Boolean(par && p.descricao && p.descricao !== par.descricao),
      inclusos: p.inclusos.map((texto) => ({ texto, adicionalId: melhor(texto, cadastro.adicionais, 0.5)?.id ?? null })),
      aplicarInclusos: false,
      atual: par ? { descricao: par.descricao, grades: (atual?.grades ?? []).map((g) => ({ categoria: g.categoria, faixas: g.faixas })) } : null,
      pendencias,
      confirmado: false,
    };
  });

  const adicionaisUsados = new Set<string>();
  const adicionais = leitura.adicionais.map((a, i): RevisaoAdicional => {
    const par = melhor(a.nome, cadastro.adicionais.filter((c) => !adicionaisUsados.has(c.id)), 0.5);
    if (par) adicionaisUsados.add(par.id);
    const { faixas, pendencias } = faixasContinuas(a.linhas, 1);
    if (!faixas.length) pendencias.push("Nenhum preço lido para este adicional.");
    return {
      chave: `a${i}`,
      nomePdf: a.nome,
      pagina: a.pagina,
      destino: par ? { tipo: "EXISTENTE", adicionalId: par.id } : { tipo: "NOVO", nome: a.nome },
      categoria: par?.categoria ?? a.grupo,
      unidade: UNIDADE[a.cobranca],
      faixas,
      atual: par ? par.faixasAtuais : null,
      pendencias,
      confirmado: false,
    };
  });

  return {
    esquema: 1,
    pacotes,
    adicionais,
    comuns: leitura.comuns,
    horarios: leitura.horarios,
    informacoes: leitura.informacoes,
    naoImportavel: leitura.naoImportavel,
    conferencias,
  };
}

/** Pendências que ainda bloqueiam a publicação (itens não ignorados e não confirmados). */
export function bloqueiosDaRevisao(r: RevisaoTabela): string[] {
  const b: string[] = [];
  for (const p of r.pacotes) if (p.pacoteId && !p.confirmado) b.push(`Confirme o pacote "${p.nomePdf}".`);
  for (const a of r.adicionais) if (a.destino.tipo !== "IGNORAR" && !a.confirmado) b.push(`Confirme o adicional "${a.nomePdf}".`);
  if (!r.pacotes.some((p) => p.pacoteId) && !r.adicionais.some((a) => a.destino.tipo !== "IGNORAR")) b.push("Nada a publicar.");
  return b;
}
