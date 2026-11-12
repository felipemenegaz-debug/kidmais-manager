/**
 * Regras PURAS da apresentação do salão (102): sem banco, testáveis isoladamente. Plano rev. 4 (25/10/2026):
 * pronto para o cliente, idade sugerida, reordenação de fotos e tradução dos erros do banco.
 */
export const GRUPOS_ITEM = ["BRINCADEIRAS", "ADULTOS", "CONFORTO", "ESPACO"] as const;
export type GrupoItem = (typeof GRUPOS_ITEM)[number];
export const NOMES_GRUPO: Record<GrupoItem, string> = {
  BRINCADEIRAS: "Brincadeiras",
  ADULTOS: "Para os adultos",
  CONFORTO: "Conforto",
  ESPACO: "Espaço",
};
export const EXCLUSIVOS = ["ENTRADA", "BRINQUEDOS", "BANHEIROS", "MESA_BOLO", "SOM", "ESTACIONAMENTO"] as const;
export type Exclusivo = (typeof EXCLUSIVOS)[number];
export const NOMES_EXCLUSIVO: Record<Exclusivo, string> = {
  ENTRADA: "entrada",
  BRINQUEDOS: "brinquedos",
  BANHEIROS: "banheiros",
  MESA_BOLO: "mesa do bolo",
  SOM: "som",
  ESTACIONAMENTO: "estacionamento",
};
export const MAX_FOTOS = 8;
export const MIN_FOTOS_PUBLICAR = 6;
export const MAX_DESTAQUES = 4;
export const ORDEM_MAXIMA = 32000;

export type Pendencia =
  | "SALAO_INATIVO"
  | "SEM_CAPACIDADE"
  | "POUCAS_FOTOS"
  | "SEM_MES_DAS_FOTOS"
  | "SEM_OUTRA_FESTA"
  | "SEM_DECLARACAO";

export const TEXTO_PENDENCIA: Record<Pendencia, string> = {
  SALAO_INATIVO: "O salão está desativado na agenda.",
  SEM_CAPACIDADE: "Informe o máximo de convidados na agenda.",
  POUCAS_FOTOS: `Envie pelo menos ${MIN_FOTOS_PUBLICAR} fotos com legenda.`,
  SEM_MES_DAS_FOTOS: "Informe o mês em que as fotos foram tiradas.",
  SEM_OUTRA_FESTA: "Diga se o outro salão pode ter festa no mesmo horário.",
  SEM_DECLARACAO: "Confirme que fotos, capacidade e itens mostram o salão como está hoje.",
};

export type EstadoPublicacao = {
  ativo: boolean;
  capacidade: number | null;
  fotosAtivas: number;
  fotosReferencia: string | null; // YYYY-MM-01
  outraFestaSimultanea: boolean | null;
  conteudoVersao: number;
  declaracaoVersao: number | null;
};

/** Pendências para o salão aparecer ao cliente. `semDeclaracao` lista só o que falta ANTES de poder declarar. */
export function pendenciasPublicacao(e: EstadoPublicacao, opcoes: { semDeclaracao?: boolean } = {}): Pendencia[] {
  const p: Pendencia[] = [];
  if (!e.ativo) p.push("SALAO_INATIVO");
  if (e.capacidade === null) p.push("SEM_CAPACIDADE");
  if (e.fotosAtivas < MIN_FOTOS_PUBLICAR) p.push("POUCAS_FOTOS");
  if (!e.fotosReferencia) p.push("SEM_MES_DAS_FOTOS");
  if (e.outraFestaSimultanea === null) p.push("SEM_OUTRA_FESTA");
  if (!opcoes.semDeclaracao && e.declaracaoVersao !== e.conteudoVersao) p.push("SEM_DECLARACAO");
  return p;
}

/** Mês corrente em São Paulo (YYYY-MM-01), com relógio injetável. */
export function mesAtualSaoPaulo(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(agora);
  const ano = partes.find((x) => x.type === "year")?.value;
  const mes = partes.find((x) => x.type === "month")?.value;
  return `${ano}-${mes}-01`;
}

/** Fotos com mais de 12 meses geram aviso (não bloqueio). */
export function fotosAntigas(fotosReferencia: string | null, agora: Date = new Date()): boolean {
  if (!fotosReferencia) return false;
  const [a, m] = mesAtualSaoPaulo(agora).split("-").map(Number);
  const [ra, rm] = fotosReferencia.split("-").map(Number);
  return (a - ra) * 12 + (m - rm) > 12;
}

/** "AAAA-MM" → "AAAA-MM-01"; mês futuro (em São Paulo) ou formato inválido devolvem null. */
export function mesDasFotos(texto: string, agora: Date = new Date()): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(texto);
  if (!m) return null;
  const valor = `${m[1]}-${m[2]}-01`;
  return valor > mesAtualSaoPaulo(agora) ? null : valor;
}

/** Idade sugerida: UNIÃO das dicas dos itens marcados (menor mínimo, maior máximo). Sem dica, sem sugestão. */
export function idadeSugerida(dicas: { idadeMin: number | null; idadeMax: number | null }[]): { min: number; max: number } | null {
  const validas = dicas.filter((d): d is { idadeMin: number; idadeMax: number } => d.idadeMin !== null && d.idadeMax !== null);
  if (validas.length === 0) return null;
  return { min: Math.min(...validas.map((d) => d.idadeMin)), max: Math.max(...validas.map((d) => d.idadeMax)) };
}

/** Texto do item próprio normalizado como o CHECK do banco: sem espaço nas pontas nem espaços repetidos. */
export function normalizarTexto(texto: string): string {
  return texto.trim().replace(/\s+/g, " ");
}

export type PlanoReordenacao = { temporarias: { id: string; ordem: number }[]; finais: { id: string; ordem: number }[] };

/**
 * Reordenação completa (R4-3): `finais` precisa ser exatamente o conjunto das fotos ativas, sem faltar, sobrar ou
 * repetir. Temporárias = os n menores inteiros em [n+1, 32000] fora das ordens atuais (sempre existem: n ≤ 8);
 * finais = 1..n, livres porque todas as temporárias são maiores que n. Lista divergente devolve null (409 na rota).
 */
export function planejarReordenacao(atuais: { id: string; ordem: number }[], finais: string[]): PlanoReordenacao | null {
  const n = atuais.length;
  if (finais.length !== n || new Set(finais).size !== n) return null;
  const ids = new Set(atuais.map((f) => f.id));
  if (!finais.every((id) => ids.has(id))) return null;
  const ocupadas = new Set(atuais.map((f) => f.ordem));
  const livres: number[] = [];
  for (let v = n + 1; v <= ORDEM_MAXIMA && livres.length < n; v++) if (!ocupadas.has(v)) livres.push(v);
  if (livres.length < n) return null;
  return {
    temporarias: atuais.map((f, i) => ({ id: f.id, ordem: livres[i] })),
    finais: finais.map((id, i) => ({ id, ordem: i + 1 })),
  };
}

/** Ordem de uma foto nova: n+1 se livre; senão é preciso compactar antes (devolve null). */
export function ordemDaNovaFoto(atuais: { ordem: number }[]): number | null {
  const n = atuais.length + 1;
  return atuais.some((f) => f.ordem === n) || n > ORDEM_MAXIMA ? null : n;
}

/** Frase do cliente sobre o outro salão, gerada dos campos (nunca escondida quando há outra festa possível). */
export function fraseConvivencia(outraFesta: boolean | null, exclusivos: readonly Exclusivo[]): string | null {
  if (outraFesta === null) return null;
  if (!outraFesta) return "Nenhuma outra festa no buffet no mesmo horário.";
  const proprios = exclusivos.map((e) => NOMES_EXCLUSIVO[e]);
  const lista = proprios.length <= 1 ? proprios.join("") : `${proprios.slice(0, -1).join(", ")} e ${proprios.at(-1)}`;
  return proprios.length > 0
    ? `O outro salão pode receber outra festa no mesmo horário. Esta festa tem ${lista} próprios.`
    : "O outro salão pode receber outra festa no mesmo horário.";
}

type ErroPg = { code?: string; constraint?: string };

const MENSAGENS_CONSTRAINT: Record<string, string> = {
  agenda_saloes_102_minimo_ck: "O mínimo de convidados precisa ser menor ou igual ao máximo do salão.",
  agenda_saloes_102_sentados_ck: "Os convidados sentados precisam caber no máximo do salão. Ajuste sentados antes de reduzir o máximo.",
  agenda_saloes_102_area_ck: "Informe a área entre 1 e 5000 m².",
  agenda_saloes_102_idade_ck: "Informe a idade com início e fim, entre 0 e 17 anos.",
  agenda_saloes_102_frase_ck: "A frase precisa ter de 1 a 80 caracteres.",
  agenda_saloes_102_exclusivos_ck: "Revise o que é só da festa deste salão.",
  agenda_saloes_102_fotos_referencia_ck: "Informe um mês que já passou ou o mês atual.",
  agenda_saloes_102_declaracao_ck: "O salão mudou desde a prévia. Recarregue e confirme de novo.",
  agenda_saloes_102_versao_ck: "O salão mudou. Recarregue a página.",
  agenda_salao_itens_destaques_ck: `Escolha no máximo ${MAX_DESTAQUES} destaques.`,
  agenda_salao_itens_catalogo_fk: "Esse item não está mais disponível para escolha.",
  agenda_salao_itens_tipo_ck: "Para trocar um item, remova e adicione outro.",
  agenda_salao_itens_proprio_ck: "O item precisa ter de 1 a 60 caracteres.",
  agenda_salao_itens_codigo_uk: "Esse item já está marcado neste salão.",
  agenda_salao_itens_proprio_uk: "Esse item já está marcado neste grupo.",
  agenda_salao_fotos_limite_ck: `No máximo ${MAX_FOTOS} fotos por salão. Remova alguma antes de enviar outra.`,
  agenda_salao_fotos_ordem_uk: "As fotos mudaram. Recarregue a página.",
};

/**
 * Tradução por SQLSTATE E nome da constraint (parecer do Astra): só os erros conhecidos da 102 viram mensagem
 * amigável; qualquer outro devolve null e segue para o tratamento padrão (500, sem mascarar).
 */
export function mensagemErroSalao(erro: unknown): string | null {
  const e = erro as ErroPg | null;
  if (!e || typeof e !== "object" || !e.code || !e.constraint) return null;
  if (!["23514", "23505", "23503"].includes(e.code)) return null;
  return MENSAGENS_CONSTRAINT[e.constraint] ?? null;
}
