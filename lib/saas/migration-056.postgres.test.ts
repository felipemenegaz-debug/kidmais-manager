import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita, portaDescartavel } from "../comercial/postgres-descartavel.ts";
import { assinaturaEstruturaFesta016, assinaturaEstruturaFestaAtual, estruturaFesta016Sql, tabelasFesta016 } from "../festas/estrutura-016.ts";

/**
 * 056 no PostgreSQL descartável (estado "atual" da receita: a 056 já aplicada): o down recusa o que perderia
 * informação, desfaz inteiro quando seguro (estrutura da Festa volta à assinatura da 016), e a reaplicação com
 * precheck/postcheck refaz o backfill — capacidade global vira capacidade de cada membership não revogada; área
 * de dono ambíguo aborta o precheck. O banco é restaurado pela receita antes da suíte (pode confirmar).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ler = (p: string) => readFileSync(resolve(root, p), "utf8");
const UP = "database/migrations/20260929_056_membership_papel_festa_tenant.sql";
const DOWN = "database/rollback/20260929_056_membership_papel_festa_tenant_down.sql";
const PRE = "database/checks/20260929_056_precheck.sql";
const POST = "database/checks/20260929_056_postcheck.sql";
// 057 depende de memberships.papel: o down da 056 recusa enquanto ela está aplicada; o ciclo desfaz e refaz a 057.
const UP57 = "database/migrations/20260929_057_assinatura_contrato_empresa.sql";
const DOWN57 = "database/rollback/20260929_057_assinatura_contrato_empresa_down.sql";
const PRE57 = "database/checks/20260929_057_precheck.sql";
const POST57 = "database/checks/20260929_057_postcheck.sql";
const cod = () => `m56${randomBytes(3).toString("hex")}`;
const senha = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

async function erro(db: Client, sql: string, params: unknown[] = []) {
  await db.query("SAVEPOINT tentativa");
  try {
    await db.query(sql, params);
    return "passou";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT tentativa");
  }
}

async function assinatura(db: Client) {
  return (await db.query<{ assinatura: string }>(estruturaFesta016Sql, [tabelasFesta016])).rows[0].assinatura;
}

async function empresa(db: Client) {
  const id = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 056', 'PROVISIONAMENTO') RETURNING id`, [cod()])).rows[0].id;
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function usuario(db: Client, empresas: string[]) {
  const u = (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Usuário 056', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [`${cod()}@example.test`, senha])).rows[0].id;
  for (const e of empresas) {
    const m = (await db.query<{ id: string }>(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`, [e, u])).rows[0].id;
    await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  }
  return u;
}

test("migration 056 no postgres descartável: recusas do down, rollback seguro e reaplicação com backfill", { timeout: 120_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = (await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.port), portaDescartavel());
    assert.equal(await assinatura(db), assinaturaEstruturaFestaAtual, "estado atual = 016 + 056");
    const A = await empresa(db);
    const B = await empresa(db);

    await t.test("down recusa papel por empresa, concessão por empresa e área por empresa/unidade (nada muda)", async () => {
      const down = semTransacaoExplicita(ler(DOWN));
      await db.query("BEGIN");
      try {
        assert.match(await erro(db, down), /056 down: a 057 está aplicada/);
        await db.query(semTransacaoExplicita(ler(DOWN57)));
        const u = await usuario(db, [A]);
        await db.query("UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE usuario_id = $1::uuid", [u]);
        assert.match(await erro(db, down), /056 down: há papel por empresa diferente/);
        await db.query("UPDATE memberships SET papel = 'REPRESENTANTE_AUTORIZADO' WHERE usuario_id = $1::uuid", [u]);
        const m = (await db.query<{ id: string }>("SELECT id FROM memberships WHERE usuario_id = $1::uuid", [u])).rows[0].id;
        await db.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1, $2, 'FESTA_OPERAR', $3, 'Concessão por empresa')`, [A, m, u]);
        assert.match(await erro(db, down), /056 down: há concessão ou revogação de capacidade feita por empresa/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await db.query(semTransacaoExplicita(ler(DOWN57)));
        const criador = await usuario(db, [A, B]);
        await db.query(`INSERT INTO festa_areas (nome, ativo, criado_por, empresa_id) VALUES ('Salão', true, $1, $2), ('Salão', true, $1, $3)`, [criador, A, B]);
        assert.match(await erro(db, down), /056 down: áreas por empresa\/estabelecimento não cabem/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(await assinatura(db), assinaturaEstruturaFestaAtual, "nada foi desfeito");
    });

    await t.test("down seguro desfaz a 056 inteira; reaplicação refaz o backfill por membership; área ambígua aborta o precheck", async () => {
      await db.query(ler(DOWN57));
      await db.query(ler(DOWN));
      assert.equal(await assinatura(db), assinaturaEstruturaFesta016, "estrutura da Festa volta à 016");
      const objetos = (await db.query<{ papel: boolean; fmc: string | null; area: boolean; nome_uk: string | null }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memberships' AND column_name = 'papel') AS papel,
                to_regclass('public.festa_membership_capacidades')::text AS fmc,
                EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'festa_areas' AND column_name = 'empresa_id') AS area,
                to_regclass('public.festa_areas_nome_uk')::text AS nome_uk`,
      )).rows[0];
      assert.deepEqual(objetos, { papel: false, fmc: null, area: false, nome_uk: "festa_areas_nome_uk" });

      // Estado pré-056: capacidade GLOBAL de um usuário com memberships em A e B; área criada por quem só é de A.
      const compartilhado = await usuario(db, [A, B]);
      await db.query(`INSERT INTO festa_usuario_capacidades (usuario_id, capacidade, concedido_por, motivo) VALUES ($1, 'FESTA_OPERAR', $1, 'Global antiga')`, [compartilhado]);
      const soA = await usuario(db, [A]);
      const areaA = (await db.query<{ id: string }>(`INSERT INTO festa_areas (nome, ativo, criado_por) VALUES ($1, true, $2) RETURNING id`, [cod(), soA])).rows[0].id;

      // Área de criador com vínculo em duas empresas: dono ambíguo ⇒ precheck aborta (a migration não inventa dono).
      await db.query("BEGIN");
      await db.query(`INSERT INTO festa_areas (nome, ativo, criado_por) VALUES ($1, true, $2)`, [cod(), compartilhado]);
      assert.match(await erro(db, ler(PRE)), /056 precheck: 1 área\(s\) de Festa sem empresa única/);
      await db.query("ROLLBACK");

      await db.query(ler(PRE));
      await db.query(ler(UP));
      await db.query(ler(POST));
      await db.query(ler(PRE57));
      await db.query(ler(UP57));
      await db.query(ler(POST57));
      assert.equal(await assinatura(db), assinaturaEstruturaFestaAtual, "reaplicada = estrutura atual");
      const caps = (await db.query<{ empresa_id: string }>(
        `SELECT n.empresa_id::text FROM festa_membership_capacidades n JOIN memberships m ON m.id = n.membership_id WHERE m.usuario_id = $1::uuid AND n.capacidade = 'FESTA_OPERAR' AND n.revogado_em IS NULL`,
        [compartilhado],
      )).rows.map((r) => r.empresa_id).sort();
      assert.deepEqual(caps, [A, B].sort(), "uma capacidade por membership (A e B separadas)");
      assert.equal((await db.query<{ e: string }>("SELECT empresa_id::text AS e FROM festa_areas WHERE id = $1::uuid", [areaA])).rows[0].e, A, "área vai para a empresa única do criador");
      await db.query("BEGIN");
      try {
        assert.match(await erro(db, `INSERT INTO festa_usuario_capacidades (usuario_id, capacidade, concedido_por, motivo) VALUES ($1, 'FESTA_CONSULTAR', $1, 'Nova global')`, [compartilhado]), /056: capacidade global de Festa encerrada/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal((await db.query<{ papel: string }>("SELECT papel FROM memberships WHERE usuario_id = $1::uuid LIMIT 1", [compartilhado])).rows[0].papel, "REPRESENTANTE_AUTORIZADO", "papel da membership veio da identidade");
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
