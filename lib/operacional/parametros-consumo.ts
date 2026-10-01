import type { DbExecutor } from "../db/contracts.ts";

/**
 * Parâmetros de consumo por empresa (migration 059): fonte de negócio VERSIONADA da regra de doces/refrigerantes por
 * convidado. Somente este serviço lê e grava a tabela; a empresa é sempre a COMPROVADA pelo Tenant Context de quem
 * chama (nunca vinda do pedido). Gravar exige a operação do Human Gate (idempotência por `operacaoId`) e a versão que o
 * operador viu (`versaoEsperada`): outra gravação no meio ⇒ recusa, nada é sobrescrito em silêncio.
 */
export type CategoriaConsumo = "DOCES" | "REFRIGERANTES";

export type ParametroConsumo = {
  categoria: CategoriaConsumo;
  versao: number;
  porConvidado: number | null;
  mlPorConvidado: number | null;
  embalagemMl: number | null;
  margemPercentual: number | null;
  vigenteDesde: string;
};

export class ParametroConsumoError extends Error {
  readonly code: "FONTE_INDISPONIVEL" | "VERSAO_DIVERGENTE" | "DADOS_INVALIDOS";
  readonly status: number;
  constructor(code: ParametroConsumoError["code"], message: string, status = 409) {
    super(message);
    this.name = "ParametroConsumoError";
    this.code = code;
    this.status = status;
  }
}

type Linha = {
  categoria: CategoriaConsumo; versao: number; quantidade_por_convidado: number | null; ml_por_convidado: number | null;
  embalagem_ml: number | null; margem_percentual: number | null; vigente_desde: string;
};

const mapear = (l: Linha): ParametroConsumo => ({
  categoria: l.categoria, versao: Number(l.versao), porConvidado: l.quantidade_por_convidado, mlPorConvidado: l.ml_por_convidado,
  embalagemMl: l.embalagem_ml, margemPercentual: l.margem_percentual, vigenteDesde: new Date(l.vigente_desde).toISOString(),
});

const COLUNAS = "categoria, versao, quantidade_por_convidado, ml_por_convidado, embalagem_ml, margem_percentual, vigente_desde::text";

/** A 059 foi aplicada neste banco? Sem ela: leitura ⇒ sem regra; gravação ⇒ recusa clara. */
export async function fonteParametrosDisponivel(tx: DbExecutor): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.operacional_parametros_consumo') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

export async function parametroVigente(tx: DbExecutor, empresaId: string, categoria: CategoriaConsumo, travar = false): Promise<ParametroConsumo | null> {
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM operacional_parametros_consumo
      WHERE empresa_id = $1::uuid AND categoria = $2 AND substituida_em IS NULL${travar ? " FOR UPDATE" : ""}`,
    [empresaId, categoria],
  );
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export type NovoParametro = {
  empresaId: string;
  usuarioId: string;
  categoria: CategoriaConsumo;
  porConvidado: number | null;
  mlPorConvidado: number | null;
  embalagemMl: number | null;
  margemPercentual: number | null;
  /** Versão vigente que o operador viu na prévia (null = não havia regra). */
  versaoEsperada: number | null;
  /** Operação do Human Gate: a mesma operação nunca grava duas versões. */
  operacaoId: string;
};

function validar(p: NovoParametro) {
  const inteiro = (v: number | null, min: number, max: number) => v === null || (Number.isInteger(v) && v >= min && v <= max);
  const ok = p.categoria === "DOCES"
    ? p.porConvidado !== null && inteiro(p.porConvidado, 1, 100) && p.mlPorConvidado === null && p.embalagemMl === null
    : p.mlPorConvidado !== null && inteiro(p.mlPorConvidado, 1, 5000) && inteiro(p.embalagemMl, 50, 20000) && p.porConvidado === null;
  if (!ok || !inteiro(p.margemPercentual, 0, 100)) throw new ParametroConsumoError("DADOS_INVALIDOS", "Parâmetro de consumo inválido.", 422);
}

/**
 * Grava uma NOVA versão (a anterior é marcada substituída na mesma transação). Repetir a mesma operação devolve a versão
 * já gravada (`repetido`), sem nova linha. A trava da versão vigente serializa gravações concorrentes da mesma regra.
 */
export async function registrarParametroConsumo(tx: DbExecutor, p: NovoParametro): Promise<{ versao: number; repetido: boolean }> {
  validar(p);
  if (!await fonteParametrosDisponivel(tx)) throw new ParametroConsumoError("FONTE_INDISPONIVEL", "A regra de consumo ainda não pode ser salva neste ambiente.", 503);
  const anterior = await tx.query<{ versao: number }>(
    `SELECT versao FROM operacional_parametros_consumo WHERE operacao_id = $1::uuid AND empresa_id = $2::uuid`,
    [p.operacaoId, p.empresaId],
  );
  if (anterior.rows[0]) return { versao: Number(anterior.rows[0].versao), repetido: true };
  const atual = await parametroVigente(tx, p.empresaId, p.categoria, true);
  if ((atual?.versao ?? null) !== p.versaoEsperada) {
    throw new ParametroConsumoError("VERSAO_DIVERGENTE", "A regra mudou desde a revisão. Confira a proposta de novo.");
  }
  const versao = (atual?.versao ?? 0) + 1;
  if (atual) {
    await tx.query(
      `UPDATE operacional_parametros_consumo SET substituida_em = clock_timestamp()
        WHERE empresa_id = $1::uuid AND categoria = $2 AND versao = $3 AND substituida_em IS NULL`,
      [p.empresaId, p.categoria, atual.versao],
    );
  }
  await tx.query(
    `INSERT INTO operacional_parametros_consumo
       (empresa_id, categoria, versao, quantidade_por_convidado, ml_por_convidado, embalagem_ml, margem_percentual, arredondamento, origem, operacao_id, criado_por)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'KIDMAIS_INTELLIGENCE', $9::uuid, $10::uuid)`,
    [p.empresaId, p.categoria, versao, p.porConvidado, p.mlPorConvidado, p.embalagemMl, p.margemPercentual,
      p.categoria === "DOCES" ? "UNIDADE_INTEIRA" : "EMBALAGEM_PARA_CIMA", p.operacaoId, p.usuarioId],
  );
  return { versao, repetido: false };
}
