import type { DbExecutor } from "../db/contracts.ts";

/**
 * Salões combinados: estado da instalação no banco (plano "Retomada 098", rev. 2.1; pareceres do Astra de 29/10).
 * - AUSENTE: nenhum objeto da 098/108 (funções kidmais098_*, colunas, gatilhos _098_, marcador);
 * - NOVA: a 108 COMPLETA E ÍNTEGRA — as 10 funções com o corpo da 108, colunas, CHECK dos membros validado e com a
 *   definição da 108, os 6 gatilhos com a definição da 108 (função, momento, eventos, nível, diferimento, colunas, sem
 *   WHEN nem argumentos, ligados), as validações no conjunto '098' do manifesto, a regra de conflito da 108 e o marcador;
 * - ANTIGA: a 098 histórica íntegra (regra de conflito da 098, sem marcador). Decisão de Felipe (29/10/2026, P2-1b):
 *   o código NÃO a suporta — ela nunca foi aplicada em staging nem em produção;
 * - PARCIAL: qualquer outra combinação (objeto faltando, definição divergente, corpo divergente).
 * Só NOVA habilita os combinados. ANTIGA e PARCIAL RECUSAM (ErroCombinadosParcial): nenhum caminho trata um combinado
 * como salão simples nem tira os conjuntos das ocupações. `coluna` diz se agenda_saloes.combinado existe (em qualquer
 * estado), para a leitura pública filtrar com segurança.
 */
export type EstadoCombinados = "AUSENTE" | "ANTIGA" | "NOVA" | "PARCIAL";

/** Corpos (sha256 do prosrc sem \r) que distinguem a 098 da 108; as validações são idênticas nas duas (conjunto '098'). */
export const HASHES_COMBINADOS = {
  conflito098: "a3b9bcb198adbe4cd0595c56a5def99aff8463f96f0c192554f42099029ca05a",
  conflito108: "06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537",
  contrato: "13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21",
  revisao: "8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24",
} as const;

/** As 10 funções da 108 (corpos idênticos aos da 098) e o sha256 do corpo de cada uma. */
export const FUNCOES_COMBINADOS: Readonly<Record<string, string>> = {
  kidmais098_hoje: "3a4b2df59eb38d2a5e6f4894fb6dd891f8ef6f793d302b6699184adba825c121",
  kidmais098_membros_canonicos: "a28f25f25ca6fde6a8687f86ae7a76f557d19e2404a708906c916bd1dbc34fa4",
  kidmais098_conjunto: "a9c7277cc298fb6307f5cfce64a7fe1eea8a0dc2d8a610f5d44bfa9d470d38dc",
  kidmais098_saloes_cruzam: "5fa4a47206e773b5a91028b5c7649e2c6317bc67e3ed548a899448fa6d3a19fe",
  kidmais098_salao_elegivel: "9f6e7b59f5ecd89c1a6bf0b67098da041600691979d2e98ae56e8ab3badce4e2",
  kidmais098_validar_elegibilidade: "f54b73da9bf4685524f88971878bb9792d5f6442432f23cf7f3001dc64b99c05",
  kidmais098_salao_guarda: "9a587402acfe1a1c537b0a7c1a8c3d77e5a1782f2c9e721b32108fde611124c7",
  kidmais098_combinado_validar: "0d5a2713f41f68b53a6a0bd22b5189cc7e31fcc9b6a7649b59cd9671ee1045ba",
  kidmais098_proibir_truncate: "b6fc1e418cc21bdf78952e9ae8ac8aeff89f257c9a9ab92bccba9850d28099df",
  kidmais098_contrato_guarda: "0ae5abc6372e3edf997bab5b4ab7f213a4d8bb0ff2708c4c4c5db72a5fc74e04",
};

/**
 * Gatilhos obrigatórios e a definição de cada um (P2-1a): nome, tabela, função, tgtype (ROW=1, BEFORE=2, INSERT=4,
 * DELETE=8, UPDATE=16, TRUNCATE=32), diferido (DEFERRABLE INITIALLY DEFERRED) e a única coluna de UPDATE OF (ou null).
 */
export const GATILHOS_COMBINADOS = [
  ["agenda_saloes_098_guarda_trg", "agenda_saloes", "kidmais098_salao_guarda", 27, false, null],
  ["agenda_saloes_098_combinado_trg", "agenda_saloes", "kidmais098_combinado_validar", 7, false, null],
  ["agenda_saloes_098_combinado_diferido", "agenda_saloes", "kidmais098_combinado_validar", 5, true, null],
  ["agenda_saloes_098_truncate_trg", "agenda_saloes", "kidmais098_proibir_truncate", 34, false, null],
  ["contratos_098_guarda_trg", "contratos", "kidmais098_contrato_guarda", 27, false, "fechamento_id"],
  ["contratos_098_truncate_trg", "contratos", "kidmais098_proibir_truncate", 34, false, null],
] as const;

/** Texto do CHECK dos membros sem espaços nem parênteses (o deparse muda a quebra de linha, não os termos). */
export const CHECK_MEMBROS_NORMALIZADO = "CHECKCASEWHENcombinadoTHENkidmais098_membros_canonicosmembrosELSEmembrosISNULLEND";

export type CatalogoCombinados = {
  /** Quantas das 10 funções existem com o corpo esperado. */
  funcoes: number;
  /** Quantas das 10 funções existem (com qualquer corpo). */
  funcoesQualquer: number;
  colunaCombinado: boolean;
  colunaMembros: boolean;
  /** CHECK dos membros validado e com a definição esperada. */
  checkValidado: boolean;
  /** Quantos dos 6 gatilhos existem com a definição esperada e ligados ('O'). */
  gatilhosOk: number;
  /** Qualquer gatilho _098_ (ligado ou não), para distinguir ausente de parcial. */
  gatilhosQualquer: number;
  conflito: string | null;
  contrato: string | null;
  revisao: string | null;
  marcador108: boolean;
};

export const TOTAL_FUNCOES_COMBINADOS = Object.keys(FUNCOES_COMBINADOS).length;

export function classificarCombinados(c: CatalogoCombinados): EstadoCombinados {
  const algum = c.funcoesQualquer > 0 || c.colunaCombinado || c.colunaMembros || c.gatilhosQualquer > 0 || c.marcador108;
  if (!algum) return "AUSENTE";
  const nucleo = c.funcoes === TOTAL_FUNCOES_COMBINADOS && c.funcoesQualquer === TOTAL_FUNCOES_COMBINADOS && c.colunaCombinado && c.colunaMembros
    && c.checkValidado && c.gatilhosOk === GATILHOS_COMBINADOS.length && c.gatilhosQualquer === GATILHOS_COMBINADOS.length
    && c.contrato === HASHES_COMBINADOS.contrato && c.revisao === HASHES_COMBINADOS.revisao;
  if (nucleo && c.marcador108 && c.conflito === HASHES_COMBINADOS.conflito108) return "NOVA";
  if (nucleo && !c.marcador108 && c.conflito === HASHES_COMBINADOS.conflito098) return "ANTIGA";
  return "PARCIAL";
}

/** Combinados habilitados: SÓ a 108 completa e íntegra (decisão de Felipe, 29/10/2026). */
export const combinadosHabilitados = (estado: EstadoCombinados) => estado === "NOVA";

export class ErroCombinadosParcial extends Error {
  readonly code = "SALOES_COMBINADOS_PARCIAL";
  constructor(antiga = false) {
    super(antiga
      ? "Este ambiente tem a instalação antiga dos salões combinados (098), que não é mais suportada; a operação foi recusada para não reservar errado. Avise o suporte."
      : "A instalação dos salões combinados está incompleta neste ambiente; a operação foi recusada para não reservar errado. Avise o suporte.");
    this.name = "ErroCombinadosParcial";
  }
}

/** false para AUSENTE; true para NOVA; ANTIGA e PARCIAL recusam (falha fechada). */
export function combinadosHabilitadosOuRecusa(estado: EstadoCombinados) {
  if (estado === "PARCIAL" || estado === "ANTIGA") throw new ErroCombinadosParcial(estado === "ANTIGA");
  return combinadosHabilitados(estado);
}

const corpo = (assinatura: string) =>
  `(SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.${assinatura}'))`;

export async function lerCatalogoCombinados(db: DbExecutor): Promise<CatalogoCombinados | null> {
  const funcoes = Object.entries(FUNCOES_COMBINADOS).map(([n, h]) => `('${n}', '${h}')`).join(", ");
  const gatilhos = GATILHOS_COMBINADOS.map(([n, t, f, tipo, dif, col]) => `('${n}', '${t}', '${f}', ${tipo}, ${dif}, ${col ? `'${col}'` : "NULL::text"})`).join(", ");
  const r = (await db.query<{ funcoes: number; funcoes_qualquer: number; combinado: boolean; membros: boolean; check_ok: boolean; gatilhos_ok: number;
    gatilhos_qualquer: number; conflito: string | null; contrato: string | null; revisao: string | null; marcador: boolean }>(
    `SELECT (SELECT count(*)::int FROM (VALUES ${funcoes}) AS e(nome, h) JOIN pg_proc p ON p.proname = e.nome AND p.pronamespace = 'public'::regnamespace
              WHERE encode(sha256(convert_to(replace(p.prosrc, E'\\r', ''), 'UTF8')), 'hex') = e.h) AS funcoes,
            (SELECT count(DISTINCT p.proname)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'kidmais098\\_%') AS funcoes_qualquer,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'combinado' AND NOT attisdropped) AS combinado,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'membros' AND NOT attisdropped) AS membros,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.agenda_saloes') AND conname = 'agenda_saloes_098_membros_check'
                     AND contype = 'c' AND convalidated AND NOT connoinherit
                     AND regexp_replace(replace(pg_get_constraintdef(oid), 'public.', ''), '[\\s()]', '', 'g') = '${CHECK_MEMBROS_NORMALIZADO}') AS check_ok,
            (SELECT count(*)::int FROM (VALUES ${gatilhos}) AS g(nome, tabela, funcao, tipo, diferido, coluna)
              WHERE EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                             WHERE t.tgname = g.nome AND t.tgrelid = to_regclass('public.' || g.tabela) AND NOT t.tgisinternal
                               AND t.tgenabled = 'O' AND p.proname = g.funcao AND p.pronamespace = 'public'::regnamespace
                               AND t.tgtype = g.tipo AND t.tgdeferrable = g.diferido AND t.tginitdeferred = g.diferido
                               AND t.tgnargs = 0 AND t.tgqual IS NULL
                               -- tgattr é int2vector (base 0): compara pelo texto dos números de coluna, não por igualdade de arrays.
                               AND array_to_string(t.tgattr::int2[], ',') = coalesce((SELECT a.attnum::text FROM pg_attribute a
                                     WHERE a.attrelid = t.tgrelid AND a.attname = g.coluna AND NOT a.attisdropped), ''))) AS gatilhos_ok,
            (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_098\\_%') AS gatilhos_qualquer,
            ${corpo("kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)")} AS conflito,
            ${corpo("kidmais019_validar_contrato()")} AS contrato,
            ${corpo("kidmais_validar_agenda_revisao()")} AS revisao,
            to_regprocedure('public.kidmais108_instalada()') IS NOT NULL AS marcador`,
  )).rows[0];
  if (!r) return null;
  return { funcoes: Number(r.funcoes), funcoesQualquer: Number(r.funcoes_qualquer), colunaCombinado: r.combinado, colunaMembros: r.membros,
    checkValidado: r.check_ok, gatilhosOk: Number(r.gatilhos_ok), gatilhosQualquer: Number(r.gatilhos_qualquer), conflito: r.conflito,
    contrato: r.contrato, revisao: r.revisao, marcador108: r.marcador };
}

export async function estadoCombinados(db: DbExecutor): Promise<{ estado: EstadoCombinados; coluna: boolean }> {
  const c = await lerCatalogoCombinados(db);
  if (!c) return { estado: "AUSENTE", coluna: false };
  return { estado: classificarCombinados(c), coluna: c.colunaCombinado };
}
