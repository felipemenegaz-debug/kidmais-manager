import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

const ITEM_EM_USO = "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.";
const CATEGORIA_EM_USO = "Esta categoria está sendo usada por um ou mais pacotes e não pode ser excluída ainda.";

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

function codigoDe(nome: string) {
  const base = nome.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  return `${base || "ITEM"}_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`.slice(0, 80);
}

async function referencias(tx: DbExecutor, sql: string, id: string) {
  const resultado = await tx.query<{ n: number }>(sql, [id]);
  return Number(resultado.rows[0]?.n ?? 0);
}

export async function criarCategoriaBuffet(tx: DbExecutor, nome: string, ativo = true) {
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO buffet_categorias (codigo, nome, ativo, arquivado_em)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN NULL ELSE now() END) RETURNING id`,
    [codigoDe(nome), nome.trim(), ativo],
  );
  return criada.rows[0].id;
}

export async function editarCategoriaBuffet(tx: DbExecutor, id: string, nome: string, ativo: boolean) {
  const atualizada = await tx.query(
    `UPDATE buffet_categorias SET nome = $2, ativo = $3, arquivado_em = CASE WHEN $3 THEN NULL ELSE COALESCE(arquivado_em, now()) END
      WHERE id = $1::uuid RETURNING id`,
    [id, nome.trim(), ativo],
  );
  if (!atualizada.rowCount) recusar("NAO_ENCONTRADO", "Categoria não encontrada.", 404);
}

export async function excluirCategoriaBuffet(tx: DbExecutor, id: string) {
  const uso = await referencias(tx, `
    SELECT (
      (SELECT count(*) FROM buffet_itens WHERE categoria_id = $1::uuid) +
      (SELECT count(*) FROM pacote_buffet_categorias WHERE categoria_id = $1::uuid) +
      (SELECT count(*) FROM fechamento_buffet_escolhas WHERE categoria_id = $1::uuid)
    )::int AS n`, id);
  if (uso > 0) recusar("EM_USO", CATEGORIA_EM_USO, 409);
  const apagada = await tx.query(`DELETE FROM buffet_categorias WHERE id = $1::uuid`, [id]);
  if (!apagada.rowCount) recusar("NAO_ENCONTRADO", "Categoria não encontrada.", 404);
}

export async function criarItemBuffet(tx: DbExecutor, nome: string, categoriaId: string | null, ativo = true) {
  if (categoriaId) {
    const categoria = await tx.query(`SELECT id FROM buffet_categorias WHERE id = $1::uuid`, [categoriaId]);
    if (!categoria.rowCount) recusar("DADOS_INVALIDOS", "Escolha uma categoria cadastrada ou deixe sem categoria.", 409);
  }
  const criado = await tx.query<{ id: string }>(
    `INSERT INTO buffet_itens (categoria_id, codigo, nome, ativo, arquivado_em)
     VALUES ($1::uuid, $2, $3, $4, CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id`,
    [categoriaId, codigoDe(nome), nome.trim(), ativo],
  );
  return criado.rows[0].id;
}

export async function editarItemBuffet(
  tx: DbExecutor,
  id: string,
  nome: string,
  categoriaId: string | null | undefined,
  ativo: boolean,
) {
  const atual = await tx.query<{ categoria_id: string | null }>(
    `SELECT categoria_id FROM buffet_itens WHERE id = $1::uuid`,
    [id],
  );
  if (!atual.rows[0]) recusar("NAO_ENCONTRADO", "Item não encontrado.", 404);
  const proxima = categoriaId === undefined ? atual.rows[0].categoria_id : categoriaId;
  if ((atual.rows[0].categoria_id ?? null) !== (proxima ?? null)) {
    const preso = await referencias(tx, `
      SELECT (
        (SELECT count(*) FROM pacote_buffet_itens WHERE item_id = $1::uuid) +
        (SELECT count(*) FROM fechamento_buffet_escolhas WHERE item_id = $1::uuid)
      )::int AS n`, id);
    if (preso > 0) recusar("EM_USO", ITEM_EM_USO, 409);
  }
  if (proxima) {
    const categoria = await tx.query(`SELECT id FROM buffet_categorias WHERE id = $1::uuid`, [proxima]);
    if (!categoria.rowCount) recusar("DADOS_INVALIDOS", "Escolha uma categoria cadastrada ou deixe sem categoria.", 409);
  }
  await tx.query(
    `UPDATE buffet_itens
        SET nome = $2, categoria_id = $3::uuid, ativo = $4,
            arquivado_em = CASE WHEN $4 THEN NULL ELSE COALESCE(arquivado_em, now()) END
      WHERE id = $1::uuid`,
    [id, nome.trim(), proxima, ativo],
  );
}

export async function excluirItemBuffet(tx: DbExecutor, id: string) {
  const especificos = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.pacote_itens_especificos') IS NOT NULL AS ok`,
  );
  const extra = especificos.rows[0]?.ok
    ? "+ (SELECT count(*) FROM pacote_itens_especificos WHERE item_id = $1::uuid)"
    : "";
  const uso = await referencias(tx, `
    SELECT (
      (SELECT count(*) FROM pacote_buffet_itens WHERE item_id = $1::uuid) +
      (SELECT count(*) FROM fechamento_buffet_escolhas WHERE item_id = $1::uuid) +
      (SELECT count(*)
         FROM buffet_itens i
         JOIN pacote_buffet_categorias r ON r.categoria_id = i.categoria_id AND r.ativo AND r.modo_itens = 'TODOS_ATIVOS'
         JOIN pacotes p ON p.id = r.pacote_id
        WHERE i.id = $1::uuid)
      ${extra}
    )::int AS n`, id);
  if (uso > 0) recusar("EM_USO", ITEM_EM_USO, 409);
  const apagado = await tx.query(`DELETE FROM buffet_itens WHERE id = $1::uuid`, [id]);
  if (!apagado.rowCount) recusar("NAO_ENCONTRADO", "Item não encontrado.", 404);
}
