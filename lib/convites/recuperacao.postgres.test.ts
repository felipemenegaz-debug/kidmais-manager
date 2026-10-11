import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "../comercial/postgres-descartavel.ts";

test("schema 079 da recuperação manual existe na cadeia PostgreSQL completa", async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = (await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.port), portaDescartavel());

    const columns = (await db.query<{ column_name: string; data_type: string; udt_name: string }>(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='convite_geracoes'`,
    )).rows;
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    assert.equal(byName.get("resolucao_resultado")?.data_type, "text");
    assert.equal(byName.get("resolucao_por")?.udt_name, "uuid");
    assert.equal(byName.get("resolucao_em")?.data_type, "timestamp with time zone");
    assert.equal(byName.get("resolucao_evidencia")?.data_type, "text");
    assert.equal(byName.get("reserva_microusd")?.udt_name, "int8");

    const constraints = (await db.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='public.convite_geracoes'::regclass AND convalidated`,
    )).rows;
    const state = constraints.find((constraint) => constraint.conname === "convite_geracoes_estado_check");
    const resolution = constraints.find((constraint) => constraint.conname === "convite_geracoes_resolucao_consistente");
    assert.ok(state?.definition.includes("RESOLVIDA_COBRADA"));
    assert.ok(state?.definition.includes("RESOLVIDA_SEM_COBRANCA"));
    assert.ok(resolution?.definition.includes("resolucao_evidencia"));
    assert.ok(constraints.some((constraint) => constraint.conname.includes("resolucao_por") || constraint.definition.includes("REFERENCES usuarios_administrativos")));

    const index = await db.query("SELECT 1 FROM pg_index WHERE indexrelid='public.convite_geracoes_incertas'::regclass AND indisvalid");
    assert.equal(index.rowCount, 1);
  } finally {
    await encerrarDescartavel(client);
  }
});
