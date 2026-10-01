import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exigirMesmaEmpresa, filtroEmpresa, mesmaEmpresa } from "./tenant.ts";

const migration = readFileSync("database/migrations/20260926_031_empresas_comercial.sql", "utf8");

test("empresa diferente e pacote legado sem empresa são recusados", () => {
  assert.equal(mesmaEmpresa("empresa-a", "empresa-a"), true);
  assert.equal(mesmaEmpresa("empresa-a", "empresa-b"), false);
  assert.equal(mesmaEmpresa(null, "empresa-a"), false);
  assert.throws(() => exigirMesmaEmpresa("empresa-b", "empresa-a"));
  assert.throws(() => exigirMesmaEmpresa(null, "empresa-a"));
  assert.equal(filtroEmpresa.includes("IS NULL"), false);
});

test("fundação comercial nasce vazia e não associa os pacotes atuais", () => {
  assert.match(migration, /CREATE TABLE empresas/);
  assert.match(migration, /empresa nova começa em PROVISIONAMENTO/);
  assert.match(migration, /exclusão física de empresa recusada/);
  assert.equal(migration.includes("INSERT INTO empresas"), false);
  assert.match(migration, /fundação SaaS já existe/);
  assert.equal(/CREATE TABLE (estabelecimentos|memberships|membership_estabelecimentos)/.test(migration), false);
  assert.equal(/unidade_id uuid/.test(migration), false);
  assert.equal(/UPDATE pacotes|UPDATE tabelas_preco|UPDATE adicionais/.test(migration), false);
  assert.match(migration, /ADD COLUMN empresa_id uuid/);
  assert.match(migration, /WHERE empresa_id IS NULL/);
});
