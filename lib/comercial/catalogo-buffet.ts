import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * Catálogo do buffet POR EMPRESA (078): toda operação recebe a empresa comprovada pelo servidor (sessão ou endereço
 * público) e só enxerga/altera linhas dessa empresa. Registro de outra empresa responde como inexistente (404), sem
 * revelar que existe. O código da categoria é único dentro da empresa; duas empresas podem ter a mesma categoria (ex.:
 * SALGADOS) com itens diferentes.
 */

const ITEM_EM_USO = "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.";
const CATEGORIA_EM_USO = "Esta categoria está sendo usada por um ou mais pacotes e não pode ser excluída ainda.";

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

function exigirEmpresa(empresaId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(empresaId ?? "")) {
    recusar("EMPRESA_OBRIGATORIA", "O catálogo do buffet exige a empresa comprovada.", 403);
  }
}

function codigoDe(nome: string) {
  const base = nome.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  return `${base || "ITEM"}_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`.slice(0, 80);
}

async function referencias(tx: DbExecutor, sql: string, id: string) {
  const resultado = await tx.query<{ n: number }>(sql, [id]);
  return Number(resultado.rows[0]?.n ?? 0);
}

async function categoriaDaEmpresa(tx: DbExecutor, empresaId: string, categoriaId: string) {
  const categoria = await tx.query(`SELECT id FROM buffet_categorias WHERE id = $1::uuid AND empresa_id = $2::uuid`, [categoriaId, empresaId]);
  if (!categoria.rowCount) recusar("DADOS_INVALIDOS", "Escolha uma categoria cadastrada ou deixe sem categoria.", 409);
}

/** Leitura do catálogo da empresa (categorias e itens), para as telas administrativas. */
export async function lerCatalogoBuffet(tx: DbExecutor, empresaId: string, somenteAtivos = false) {
  exigirEmpresa(empresaId);
  const filtro = somenteAtivos ? "AND ativo" : "";
  const categorias = await tx.query<{ id: string; codigo: string; nome: string; descricao: string | null; ordem_exibicao: number; ativo: boolean }>(
    `SELECT id::text AS id, codigo, nome, descricao, ordem_exibicao, ativo FROM buffet_categorias
      WHERE empresa_id = $1::uuid ${filtro} ORDER BY ordem_exibicao, nome`, [empresaId]);
  const itens = await tx.query<{ id: string; categoria_id: string | null; codigo: string; nome: string; descricao: string | null; ordem_exibicao: number; ativo: boolean }>(
    `SELECT id::text AS id, categoria_id::text AS categoria_id, codigo, nome, descricao, ordem_exibicao, ativo FROM buffet_itens
      WHERE empresa_id = $1::uuid ${filtro} ORDER BY ordem_exibicao, nome`, [empresaId]);
  return { categorias: categorias.rows, itens: itens.rows };
}

/** `codigo` opcional: categorias com significado na tela (SALGADOS, DOCES, …) podem ser criadas pelo código conhecido. */
export async function criarCategoriaBuffet(tx: DbExecutor, empresaId: string, nome: string, ativo = true, codigo?: string) {
  exigirEmpresa(empresaId);
  if (codigo !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(codigo)) recusar("DADOS_INVALIDOS", "Código de categoria inválido.", 400);
  const existente = codigo ? await tx.query(`SELECT 1 FROM buffet_categorias WHERE empresa_id = $1::uuid AND codigo = $2`, [empresaId, codigo]) : null;
  if (existente?.rowCount) recusar("CONFLITO", "Esta empresa já tem uma categoria com este código.", 409);
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO buffet_categorias (empresa_id, codigo, nome, ativo, arquivado_em)
     VALUES ($1::uuid, $2, $3, $4, CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id`,
    [empresaId, codigo ?? codigoDe(nome), nome.trim(), ativo],
  );
  return criada.rows[0].id;
}

export async function editarCategoriaBuffet(tx: DbExecutor, empresaId: string, id: string, nome: string, ativo: boolean) {
  exigirEmpresa(empresaId);
  const atualizada = await tx.query(
    `UPDATE buffet_categorias SET nome = $3, ativo = $4, arquivado_em = CASE WHEN $4 THEN NULL ELSE COALESCE(arquivado_em, now()) END
      WHERE id = $1::uuid AND empresa_id = $2::uuid RETURNING id`,
    [id, empresaId, nome.trim(), ativo],
  );
  if (!atualizada.rowCount) recusar("NAO_ENCONTRADO", "Categoria não encontrada.", 404);
}

export async function excluirCategoriaBuffet(tx: DbExecutor, empresaId: string, id: string) {
  exigirEmpresa(empresaId);
  const dona = await tx.query(`SELECT 1 FROM buffet_categorias WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
  if (!dona.rowCount) recusar("NAO_ENCONTRADO", "Categoria não encontrada.", 404);
  const uso = await referencias(tx, `
    SELECT (
      (SELECT count(*) FROM buffet_itens WHERE categoria_id = $1::uuid) +
      (SELECT count(*) FROM pacote_buffet_categorias WHERE categoria_id = $1::uuid) +
      (SELECT count(*) FROM fechamento_buffet_escolhas WHERE categoria_id = $1::uuid) +
      (SELECT count(*) FROM adicionais WHERE origem_buffet_categoria_id = $1::uuid)
    )::int AS n`, id);
  if (uso > 0) recusar("EM_USO", CATEGORIA_EM_USO, 409);
  await tx.query(`DELETE FROM buffet_categorias WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
}

export async function criarItemBuffet(tx: DbExecutor, empresaId: string, nome: string, categoriaId: string | null, ativo = true) {
  exigirEmpresa(empresaId);
  if (categoriaId) await categoriaDaEmpresa(tx, empresaId, categoriaId);
  const criado = await tx.query<{ id: string }>(
    `INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome, ativo, arquivado_em)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, CASE WHEN $5 THEN NULL ELSE now() END) RETURNING id`,
    [empresaId, categoriaId, codigoDe(nome), nome.trim(), ativo],
  );
  return criado.rows[0].id;
}

export async function editarItemBuffet(
  tx: DbExecutor,
  empresaId: string,
  id: string,
  nome: string,
  categoriaId: string | null | undefined,
  ativo: boolean,
) {
  exigirEmpresa(empresaId);
  const atual = await tx.query<{ categoria_id: string | null }>(
    `SELECT categoria_id FROM buffet_itens WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId],
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
  if (proxima) await categoriaDaEmpresa(tx, empresaId, proxima);
  await tx.query(
    `UPDATE buffet_itens
        SET nome = $3, categoria_id = $4::uuid, ativo = $5,
            arquivado_em = CASE WHEN $5 THEN NULL ELSE COALESCE(arquivado_em, now()) END
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId, nome.trim(), proxima, ativo],
  );
}

export async function excluirItemBuffet(tx: DbExecutor, empresaId: string, id: string) {
  exigirEmpresa(empresaId);
  const dono = await tx.query(`SELECT 1 FROM buffet_itens WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
  if (!dono.rowCount) recusar("NAO_ENCONTRADO", "Item não encontrado.", 404);
  const uso = await referencias(tx, `
    SELECT (
      (SELECT count(*) FROM pacote_buffet_itens WHERE item_id = $1::uuid) +
      (SELECT count(*) FROM fechamento_buffet_escolhas WHERE item_id = $1::uuid) +
      (SELECT count(*) FROM pacote_itens_especificos WHERE item_id = $1::uuid) +
      (SELECT count(*) FROM adicionais WHERE origem_buffet_item_id = $1::uuid) +
      (SELECT count(*)
         FROM buffet_itens i
         JOIN pacote_buffet_categorias r ON r.categoria_id = i.categoria_id AND r.ativo AND r.modo_itens = 'TODOS_ATIVOS'
         JOIN pacotes p ON p.id = r.pacote_id
        WHERE i.id = $1::uuid)
    )::int AS n`, id);
  if (uso > 0) recusar("EM_USO", ITEM_EM_USO, 409);
  await tx.query(`DELETE FROM buffet_itens WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
}
