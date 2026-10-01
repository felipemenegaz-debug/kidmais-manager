import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Apoio dos testes estáticos das migrations 055a–d (sem banco, sem testes próprios).
 * A execução real depende de autorização (docs/OPERACAO_AGENTES.md); o harness PostgreSQL descartável
 * fica em migration-055.postgres.test.ts (opt-in, não executado sem autorização).
 */
export const ler = (arquivo: string) => readFileSync(arquivo, "utf8").replace(/\r\n/g, "\n");

export function corpoTabela(sql: string, nome: string) {
  const inicio = sql.indexOf(`CREATE TABLE ${nome} (`);
  assert.ok(inicio >= 0, nome);
  return sql.slice(inicio, sql.indexOf("\n);", inicio));
}

/** Up: transacional, recusa reaplicação, não toca o Core, funções sem SECURITY DEFINER e com search_path fixo. */
export function verificarUp(up: string, id: string, tabelas: readonly string[]) {
  assert.match(up, /^--[\s\S]*?\nBEGIN;\n/, id);
  assert.match(up, /\nCOMMIT;\n?$/, id);
  assert.match(up, /NÃO APLICADA/, id);
  assert.match(up, /RAISE EXCEPTION '[^']*já aplicada/, id);
  assert.doesNotMatch(up, /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE (?!ia_))/i, id);
  assert.doesNotMatch(up, /SECURITY DEFINER/i, id);
  for (const tabela of tabelas) assert.match(corpoTabela(up, tabela), /empresa_id uuid NOT NULL/, `${id}: ${tabela}`);
  const funcoes = [...up.matchAll(/CREATE FUNCTION (\w+)\(\)/g)].map((m) => m[1]);
  const fixas = [...up.matchAll(/CREATE FUNCTION (\w+)\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS/g)].map((m) => m[1]);
  assert.deepEqual(fixas, funcoes, `${id}: toda função com search_path fixo`);
  return funcoes;
}

/**
 * Down (H8): uma transação; lock_timeout curto; ACCESS EXCLUSIVE ANTES da reconferência; reconferência
 * que aborta; DROP só depois, e só de objetos da própria migration.
 */
export function verificarDown(down: string, id: string, tabelas: readonly string[], objetos: RegExp) {
  assert.match(down, /NÃO EXECUTAR sem autorização explícita/, id);
  assert.equal((down.match(/^BEGIN;$/gm) ?? []).length, 1, `${id}: uma transação`);
  assert.equal((down.match(/^COMMIT;$/gm) ?? []).length, 1, `${id}: uma transação`);
  assert.match(down, /^SET LOCAL lock_timeout = '\d+s';$/m, id);
  const trava = down.search(/^LOCK TABLE [^;]+ IN ACCESS EXCLUSIVE MODE;$/m);
  assert.ok(trava > 0, `${id}: trava ACCESS EXCLUSIVE`);
  const travadas = down.slice(trava).split(";")[0];
  for (const tabela of tabelas) assert.match(travadas, new RegExp(`\\b${tabela}\\b`), `${id}: trava ${tabela}`);
  const reconferencia = down.indexOf("DO $$", trava);
  assert.ok(reconferencia > trava, `${id}: reconferência DEPOIS da trava`);
  assert.match(down.slice(reconferencia, down.indexOf("END $$;", reconferencia)), /RAISE EXCEPTION/, `${id}: reconferência aborta`);
  const primeiroDrop = down.search(/^DROP /m);
  assert.ok(primeiroDrop > reconferencia, `${id}: DROP só depois da reconferência`);
  for (const m of down.matchAll(/DROP (TABLE|VIEW|FUNCTION) (\w+)/g)) assert.match(m[2], objetos, `${id}: ${m[2]}`);
  assert.doesNotMatch(down, /DELETE FROM|TRUNCATE|CASCADE/i, `${id}: nunca apaga dado nem derruba em cascata`);
}

/** Checks: somente leitura (nada de DDL/DML). */
export function verificarSomenteLeitura(sql: string, nome: string) {
  const codigo = sql.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(codigo, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+\w|ALTER\s+\w|CREATE\s+\w|TRUNCATE|GRANT\s|LOCK\s+TABLE|SET\s+LOCAL)\b/i, nome);
}
