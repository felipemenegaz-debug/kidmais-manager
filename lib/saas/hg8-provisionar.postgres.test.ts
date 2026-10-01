import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, linhaDeBase, LINHA_DE_BASE_ATUAL } from "../comercial/postgres-descartavel.ts";
import { provisionarTenant, recusarMarcaKidmais } from "./provisionar-tenant.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function codigo() {
  return `hg8v${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function executor(client: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function usuario(client: Client) {
  return (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
     VALUES ($1, 'Operador sintético', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`,
    [`${codigo()}@example.test`, senhaFalsa()],
  )).rows[0].id;
}

test("provisionamento sintético no postgres descartável", { timeout: 60_000 }, async () => {
  const fonte = readFileSync(resolve(root, "scripts/hg8-provisionar-tenant.ts"), "utf8");
  assert.equal(fonte.includes(".env"), false);
  assert.equal(fonte.includes("kidmais_pacotes_v1_descartavel"), true);
  assert.equal(fonte.includes("55498"), true);
  assert.throws(() => recusarMarcaKidmais("kidmais", "Outra"), (error: unknown) => error instanceof PacoteAdminError);

  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    // D3: produto parte do estado canônico ATUAL restaurado pela receita (046 aplicada: legado atribuído à Kidmais).
    assert.deepEqual(await linhaDeBase(db), LINHA_DE_BASE_ATUAL, "estado canônico atual");
    const tx = executor(db);

    await db.query("BEGIN");
    try {
      const usuarioId = await usuario(db);
      const pedido = { codigo: codigo(), nome: "Empresa sintetica", usuarioId, atorUsuarioId: usuarioId };
      const primeiro = await provisionarTenant(tx, pedido);
      const eventos = await db.query<{ n: number; acoes: string[] }>(
        `SELECT count(*)::int AS n, array_agg(acao ORDER BY criado_em) AS acoes
           FROM auditoria
          WHERE entidade_id IN ($1::uuid, $2::uuid)`,
        [primeiro.empresaComprovada, primeiro.membershipId],
      );
      assert.equal(eventos.rows[0].n, 2);
      assert.deepEqual(eventos.rows[0].acoes, ["EMPRESA_TRANSICAO", "MEMBERSHIP_TRANSICAO"]);
      await assert.rejects(
        () => provisionarTenant(tx, pedido),
        (error: unknown) => error instanceof PacoteAdminError && error.code === "FORA_DO_ESCOPO_SINTETICO",
      );
      const deNovo = await db.query<{ n: number; empresas: number }>(
        `SELECT
           (SELECT count(*)::int FROM auditoria WHERE entidade_id IN ($1::uuid, $2::uuid)) AS n,
           (SELECT count(*)::int FROM empresas WHERE codigo = $3) AS empresas`,
        [primeiro.empresaComprovada, primeiro.membershipId, pedido.codigo],
      );
      assert.equal(deNovo.rows[0].n, 2);
      assert.equal(deNovo.rows[0].empresas, 1);
      await db.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [primeiro.membershipId]);
      await assert.rejects(
        () => provisionarTenant(tx, pedido),
        (error: unknown) => error instanceof PacoteAdminError && error.code === "FORA_DO_ESCOPO_SINTETICO",
      );
      const ocupada = await db.query<{ n: number; status: string }>(
        `SELECT count(*)::int AS n, max(status) AS status
           FROM memberships WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid`,
        [primeiro.empresaComprovada, usuarioId],
      );
      assert.equal(ocupada.rows[0].n, 1);
      assert.equal(ocupada.rows[0].status, "REVOGADA");
      await assert.rejects(
        () => provisionarTenant(tx, { ...pedido, codigo: "kidmais", nome: "Empresa sintetica" }),
        (error: unknown) => error instanceof PacoteAdminError && error.code === "MARCA_RECUSADA",
      );
      const codigoReservado = codigo();
      await db.query(
        `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Kidmais', 'PROVISIONAMENTO')`,
        [codigoReservado],
      );
      await assert.rejects(
        () => provisionarTenant(tx, {
          codigo: codigoReservado,
          nome: "Empresa sintetica",
          usuarioId,
          atorUsuarioId: usuarioId,
        }),
        (error: unknown) => error instanceof PacoteAdminError && error.code === "MARCA_RECUSADA",
      );
      const reservada = await db.query<{ status: string; vinculos: number }>(
        `SELECT e.status, (SELECT count(*)::int FROM memberships m WHERE m.empresa_id = e.id) AS vinculos
           FROM empresas e WHERE e.codigo = $1`,
        [codigoReservado],
      );
      assert.equal(reservada.rows[0].status, "PROVISIONAMENTO");
      assert.equal(reservada.rows[0].vinculos, 0);
      const codigoPersistido = codigo();
      await db.query(
        `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet persistido', 'PROVISIONAMENTO')`,
        [codigoPersistido],
      );
      await assert.rejects(
        () => provisionarTenant(tx, {
          codigo: codigoPersistido,
          nome: "Empresa sintetica",
          usuarioId,
          atorUsuarioId: usuarioId,
        }),
        (error: unknown) => error instanceof PacoteAdminError && error.code === "FORA_DO_ESCOPO_SINTETICO",
      );
      const persistida = await db.query<{ status: string; nome: string; vinculos: number }>(
        `SELECT e.status, e.nome, (SELECT count(*)::int FROM memberships m WHERE m.empresa_id = e.id) AS vinculos
           FROM empresas e WHERE e.codigo = $1`,
        [codigoPersistido],
      );
      assert.equal(persistida.rows[0].status, "PROVISIONAMENTO");
      assert.equal(persistida.rows[0].nome, "Buffet persistido");
      assert.equal(persistida.rows[0].vinculos, 0);
    } finally {
      await db.query("ROLLBACK");
    }

    const resto = await db.query<{ empresas: number; legado: number; kidmais: number }>(
      `SELECT
         (SELECT count(*)::int FROM empresas WHERE codigo LIKE 'hg8v%') AS empresas,
         (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
         (SELECT count(*)::int FROM empresas WHERE codigo ILIKE '%kidmais%' OR nome ILIKE '%kidmais%') AS kidmais`,
    );
    assert.equal(resto.rows[0].empresas, 0);
    assert.equal(resto.rows[0].legado, LINHA_DE_BASE_ATUAL.legado);
    assert.equal(resto.rows[0].kidmais, LINHA_DE_BASE_ATUAL.kidmais, "o provisionamento sintético nunca cria outra Kidmais");
    assert.deepEqual(await linhaDeBase(db), LINHA_DE_BASE_ATUAL, "linha de base intacta");
  } finally {
    await encerrarDescartavel(db);
  }
});

test("o comando recusa a marca Kidmais antes de gravar", async () => {
  const script = resolve(root, "scripts/hg8-provisionar-tenant.ts");
  const child = spawn(process.execPath, [script, "--codigo", "kidmais", "--nome", "Kidmais", "--usuario", "00000000-0000-4000-8000-000000000000"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let erro = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    erro += chunk;
  });
  const codigoSaida = await new Promise<number>((resolveSaida, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolveSaida(code ?? 1));
  });
  assert.notEqual(codigoSaida, 0);
  assert.match(erro, /Kidmais/);
});
