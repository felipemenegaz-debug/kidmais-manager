import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import {
  criarCategoriaBuffet,
  criarItemBuffet,
  editarItemBuffet,
  excluirCategoriaBuffet,
  excluirItemBuffet,
} from "./catalogo-buffet.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { definirCategoriasPacoteAdmin, definirItensEspecificosPacoteAdmin } from "./pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration050 = resolve(root, "database/migrations/20260927_050_item_sem_categoria.sql");
const down050 = resolve(root, "database/rollback/20260927_050_item_sem_categoria_down.sql");

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`.slice(0, 80);
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

test("catálogo do buffet no postgres descartável", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    const coluna = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'buffet_itens' AND column_name = 'categoria_id'`,
    );
    if (coluna.rows[0]?.is_nullable !== "YES") {
      await db.query(readFileSync(migration050, "utf8"));
    }
    await db.query("BEGIN");
    const empresaId = (await db.query<{ id: string }>(
      `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa catalogo ux', 'PROVISIONAMENTO') RETURNING id`,
      [codigo("uxc")],
    )).rows[0].id;
    await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresaId]);
    const usuarioId = (await db.query<{ id: string }>(
      `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
       VALUES ($1, 'Catalogo UX', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${codigo("uxc")}@example.test`, senhaFalsa()],
    )).rows[0].id;
    const tx = executor(db);
    const categoriaId = await criarCategoriaBuffet(tx, "Salgados UX");
    const categoriaLivre = await criarCategoriaBuffet(tx, "Bolo UX");
    const comCategoria = await criarItemBuffet(tx, "Coxinha UX", categoriaId);
    const semCategoria = await criarItemBuffet(tx, "Taxa de rolha UX", null);
    await editarItemBuffet(tx, semCategoria, "Taxa de rolha UX", null, true);
    const pacoteId = (await db.query<{ id: string }>(
      `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
       VALUES ($1::uuid, $2, 'Pacote UX', 1, true, true) RETURNING id`,
      [empresaId, codigo("UXP").toUpperCase()],
    )).rows[0].id;
    const ctx = { empresaId, usuarioId, requestId: randomUUID(), motivo: "PACOTE_EDITADO" };
    await definirCategoriasPacoteAdmin(tx, pacoteId, [{ categoriaId, escolhas: 1 }], ctx);
    await definirItensEspecificosPacoteAdmin(tx, pacoteId, [semCategoria, comCategoria]);
    const ligados = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pacote_itens_especificos WHERE pacote_id = $1::uuid`,
      [pacoteId],
    );
    assert.equal(ligados.rows[0].n, 2);
    await definirCategoriasPacoteAdmin(tx, pacoteId, [], ctx);
    await definirItensEspecificosPacoteAdmin(tx, pacoteId, []);
    assert.equal((await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pacote_buffet_categorias WHERE pacote_id = $1::uuid AND ativo`,
      [pacoteId],
    )).rows[0].n, 0);
    assert.equal((await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pacote_itens_especificos WHERE pacote_id = $1::uuid`,
      [pacoteId],
    )).rows[0].n, 0);
    await definirItensEspecificosPacoteAdmin(tx, pacoteId, [semCategoria]);
    await assert.rejects(
      () => excluirItemBuffet(tx, semCategoria),
      (error: unknown) => error instanceof PacoteAdminError && error.message === "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.",
    );
    await definirItensEspecificosPacoteAdmin(tx, pacoteId, []);
    await excluirItemBuffet(tx, semCategoria);
    await excluirItemBuffet(tx, comCategoria);
    await assert.rejects(
      () => excluirCategoriaBuffet(tx, categoriaId),
      (error: unknown) => error instanceof PacoteAdminError && /não pode ser excluída ainda/.test(error.message),
    );
    await excluirCategoriaBuffet(tx, categoriaLivre);
    const categoriaTodos = await criarCategoriaBuffet(tx, "Doces UX");
    const itemTodos = await criarItemBuffet(tx, "Brigadeiro UX", categoriaTodos, true);
    await definirCategoriasPacoteAdmin(tx, pacoteId, [{ categoriaId: categoriaTodos, escolhas: 1 }], ctx);
    const bloqueia = (error: unknown) => error instanceof PacoteAdminError
      && error.message === "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.";
    await assert.rejects(() => excluirItemBuffet(tx, itemTodos), bloqueia);
    await db.query(`UPDATE pacotes SET ativo = false, arquivado_em = NULL WHERE id = $1::uuid`, [pacoteId]);
    await assert.rejects(() => excluirItemBuffet(tx, itemTodos), bloqueia);
    await db.query(`UPDATE pacotes SET ativo = true, arquivado_em = clock_timestamp() WHERE id = $1::uuid`, [pacoteId]);
    await assert.rejects(() => excluirItemBuffet(tx, itemTodos), bloqueia);
    await db.query(`UPDATE pacotes SET ativo = false, arquivado_em = clock_timestamp() WHERE id = $1::uuid`, [pacoteId]);
    await assert.rejects(() => excluirItemBuffet(tx, itemTodos), bloqueia);
    assert.equal((await db.query("SELECT id FROM buffet_itens WHERE id = $1::uuid", [itemTodos])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM buffet_itens WHERE id = $1::uuid", [semCategoria])).rowCount, 0);
    await db.query("ROLLBACK");
    const solto = codigo("UXN").toUpperCase();
    await db.query(
      `INSERT INTO buffet_itens (categoria_id, codigo, nome) VALUES (NULL, $1, 'Item solto UX')`,
      [solto],
    );
    await assert.rejects(
      () => db.query(readFileSync(down050, "utf8")),
      (error: unknown) => /ainda há item sem categoria/.test(error instanceof Error ? error.message : String(error)),
    );
    await db.query("ROLLBACK");
    assert.equal((await db.query<{ ok: boolean }>(
      `SELECT to_regclass('public.pacote_itens_especificos') IS NOT NULL AS ok`,
    )).rows[0].ok, true);
    await db.query(`DELETE FROM buffet_itens WHERE codigo = $1`, [solto]);
    const outro = await conectarDescartavel({ travar: false });
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('kidmais-050-down'))");
      await db.query("LOCK TABLE public.buffet_itens IN SHARE ROW EXCLUSIVE MODE");
      await db.query("LOCK TABLE public.pacote_itens_especificos IN SHARE ROW EXCLUSIVE MODE");
      await outro.query("SET lock_timeout = '1500ms'");
      await assert.rejects(
        () => outro.query(
          `INSERT INTO buffet_itens (categoria_id, codigo, nome) VALUES (NULL, $1, 'Corrida UX')`,
          [codigo("UXR").toUpperCase()],
        ),
        (error: unknown) => /lock timeout|tempo limite/i.test(error instanceof Error ? error.message : String(error)),
      );
      await db.query("ROLLBACK");
    } finally {
      await encerrarDescartavel(outro, false);
    }
  } finally {
    await encerrarDescartavel(client);
  }
});
