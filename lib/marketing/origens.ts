import type { DbExecutor } from "../db/contracts.ts";
import { MarketingError } from "./erros.ts";

/**
 * Origem de AQUISIÇÃO (como a pessoa conheceu o buffet). Separada de:
 *   - canal de atendimento (por onde o contato chegou: formulário, WhatsApp, telefone…);
 *   - campanha (ação específica com link rastreável);
 *   - método de identificação (CAPTURADO por link/UTM, INFORMADO por alguém, HERDADO do contato, DESCONHECIDO).
 * DESCONHECIDA não é opção de lista: é a ausência de evidência, nunca inventada nem trocada por "outro".
 * NAO_INFORMADO é escolha explícita da equipe ("perguntamos e a pessoa não disse").
 */
export const ORIGENS_PADRAO = [
  { codigo: "GOOGLE", rotulo: "Google" },
  { codigo: "INSTAGRAM", rotulo: "Instagram" },
  { codigo: "FACEBOOK", rotulo: "Facebook" },
  { codigo: "INDICACAO", rotulo: "Indicação" },
  { codigo: "CLIENTE_RECORRENTE", rotulo: "Já era cliente" },
  { codigo: "PASSAGEM_FRENTE", rotulo: "Passou em frente" },
  { codigo: "OUTRO", rotulo: "Outro" },
  { codigo: "NAO_INFORMADO", rotulo: "Não informado" },
] as const;

export const ORIGEM_DESCONHECIDA = "DESCONHECIDA";
export const ROTULO_DESCONHECIDA = "Desconhecida (sem evidência)";

export const CANAIS_ATENDIMENTO = ["FORMULARIO_SITE", "WHATSAPP", "TELEFONE", "PRESENCIAL", "EMAIL", "OUTRO"] as const;
export type CanalAtendimento = (typeof CANAIS_ATENDIMENTO)[number];
export const ROTULO_CANAL_ATENDIMENTO: Record<CanalAtendimento, string> = {
  FORMULARIO_SITE: "Formulário do site",
  WHATSAPP: "WhatsApp",
  TELEFONE: "Telefone",
  PRESENCIAL: "Presencial",
  EMAIL: "E-mail",
  OUTRO: "Outro",
};

export const METODOS = ["CAPTURADO", "INFORMADO", "HERDADO", "DESCONHECIDO"] as const;
export type MetodoAtribuicao = (typeof METODOS)[number];
export const ROTULO_METODO: Record<MetodoAtribuicao, string> = {
  CAPTURADO: "Capturado pelo link",
  INFORMADO: "Informado pela equipe",
  HERDADO: "Herdado do contato",
  DESCONHECIDO: "Sem evidência",
};

export const CODIGO_ORIGEM = /^[A-Z][A-Z0-9_]{1,39}$/;

export type OpcaoOrigem = { codigo: string; rotulo: string; ativa: boolean; ordem: number; personalizada: boolean };

/** Lista efetiva: padrão + ajustes da empresa (rótulo, ordem, desativação) + personalizadas (P_...). */
export function mesclarOrigens(linhas: Array<{ codigo: string; rotulo: string; ativa: boolean; ordem: number; personalizada: boolean }>): OpcaoOrigem[] {
  const porCodigo = new Map(linhas.map((l) => [l.codigo, l]));
  const padrao = ORIGENS_PADRAO.map((o, i) => {
    const ajuste = porCodigo.get(o.codigo);
    return { codigo: o.codigo, rotulo: ajuste?.rotulo ?? o.rotulo, ativa: ajuste?.ativa ?? true, ordem: ajuste?.ordem ?? (i + 1) * 10, personalizada: false };
  });
  const extras = linhas.filter((l) => l.personalizada && !ORIGENS_PADRAO.some((o) => o.codigo === l.codigo))
    .map((l) => ({ codigo: l.codigo, rotulo: l.rotulo, ativa: l.ativa, ordem: l.ordem, personalizada: true }));
  return [...padrao, ...extras].sort((a, b) => a.ordem - b.ordem || a.rotulo.localeCompare(b.rotulo, "pt-BR"));
}

export function rotuloOrigem(codigo: string, opcoes: OpcaoOrigem[]) {
  if (codigo === ORIGEM_DESCONHECIDA) return ROTULO_DESCONHECIDA;
  return opcoes.find((o) => o.codigo === codigo)?.rotulo ?? ORIGENS_PADRAO.find((o) => o.codigo === codigo)?.rotulo ?? codigo;
}

export async function lerOrigens(tx: DbExecutor, empresaId: string): Promise<OpcaoOrigem[]> {
  const r = await tx.query<{ codigo: string; rotulo: string; ativa: boolean; ordem: number; personalizada: boolean }>(
    `SELECT codigo, rotulo, ativa, ordem, personalizada FROM marketing_origens_opcoes WHERE empresa_id = $1::uuid`,
    [empresaId],
  );
  return mesclarOrigens(r.rows);
}

/**
 * Origem escolhida manualmente precisa existir na lista da empresa. Desativada ainda vale para correção de histórico
 * (`permitirInativa`), nunca para novo registro.
 */
export async function exigirOrigemValida(tx: DbExecutor, empresaId: string, codigo: string, opcoes: { permitirInativa?: boolean } = {}) {
  if (!CODIGO_ORIGEM.test(codigo) || codigo === ORIGEM_DESCONHECIDA) {
    throw new MarketingError("MARKETING_ORIGEM_INVALIDA", "Escolha uma origem da lista.", 400);
  }
  const lista = await lerOrigens(tx, empresaId);
  const item = lista.find((o) => o.codigo === codigo);
  if (!item || (!item.ativa && !opcoes.permitirInativa)) throw new MarketingError("MARKETING_ORIGEM_INVALIDA", "Escolha uma origem da lista.", 400);
  return item;
}

export function codigoPersonalizado(rotulo: string) {
  const base = rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
  if (base.length < 2) throw new MarketingError("MARKETING_ORIGEM_INVALIDA", "Use pelo menos duas letras no nome da origem.", 400);
  return `P_${base}`;
}

/** Ajusta uma padrão (rótulo/ordem/ativa) ou cria/ajusta uma personalizada. Nunca apaga (histórico continua legível). */
export async function salvarOrigem(
  tx: DbExecutor, empresaId: string,
  input: { codigo?: string | null; rotulo: string; ativa: boolean; ordem?: number | null },
) {
  const padrao = input.codigo ? ORIGENS_PADRAO.find((o) => o.codigo === input.codigo) : undefined;
  const codigo = padrao ? padrao.codigo : input.codigo ?? codigoPersonalizado(input.rotulo);
  if (!padrao && !/^P_[A-Z0-9_]{2,37}$/.test(codigo)) throw new MarketingError("MARKETING_ORIGEM_INVALIDA", "Origem inválida.", 400);
  const r = await tx.query<{ codigo: string }>(
    `INSERT INTO marketing_origens_opcoes (empresa_id, codigo, rotulo, ativa, ordem, personalizada)
     VALUES ($1::uuid, $2, $3, $4, COALESCE($5::int, 100), $6)
     ON CONFLICT (empresa_id, codigo) DO UPDATE
       SET rotulo = EXCLUDED.rotulo, ativa = EXCLUDED.ativa, ordem = COALESCE($5::int, marketing_origens_opcoes.ordem), atualizado_em = clock_timestamp()
     RETURNING codigo`,
    [empresaId, codigo, input.rotulo.trim(), input.ativa, input.ordem ?? null, !padrao],
  );
  return { codigo: r.rows[0].codigo };
}
