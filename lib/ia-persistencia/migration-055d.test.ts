import assert from "node:assert/strict";
import test from "node:test";
import { corpoTabela, ler, verificarDown, verificarSomenteLeitura, verificarUp } from "./migracao-apoio.test.ts";

/** 055d (IMPORT): rascunho de importação. Prova o texto, sem banco. */
const up = ler("database/migrations/20260928_055d_inteligencia_importacoes.sql");
const down = ler("database/rollback/20260928_055d_inteligencia_importacoes_down.sql");

test("055d: transacional, exige a 055c, recusa reaplicação, não toca o Core", () => {
  assert.deepEqual(verificarUp(up, "055d", ["ia_importacoes"]), ["kidmais_055_importacao_guarda"]);
  assert.match(up, /to_regclass\('public\.ia_documentos'\) IS NULL OR to_regclass\('public\.ia_extracoes'\) IS NULL THEN\s+RAISE EXCEPTION/);
  assert.match(corpoTabela(up, "ia_importacoes"), /FOREIGN KEY \(extracao_id, documento_id, empresa_id\)\s+REFERENCES ia_extracoes \(id, documento_id, empresa_id\)/, "extração do mesmo documento");
  assert.doesNotMatch(corpoTabela(up, "ia_importacoes"), /UNIQUE \(documento_id\)/, "descartada não bloqueia o documento");
  assert.match(up, /CREATE UNIQUE INDEX ia_importacoes_documento_ativa_uk ON ia_importacoes \(documento_id\) WHERE status <> 'DESCARTADA';/);
});

test("055d: estados terminais e invariantes do resultado", () => {
  const tabela = corpoTabela(up, "ia_importacoes");
  assert.match(tabela, /CHECK \(status IN \('EM_REVISAO', 'IMPORTADA', 'DESCARTADA'\)\)/);
  assert.doesNotMatch(up, /AGUARDANDO_CONFIRMACAO/, "estado morto removido: a confirmação vive no Human Gate");
  assert.match(tabela, /status = 'IMPORTADA' AND resultado IS NOT NULL AND cliente_id IS NOT NULL/);
  assert.match(tabela, /status <> 'IMPORTADA' AND resultado IS NULL AND cliente_id IS NULL/);
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_055_importacao_guarda"), up.indexOf("CREATE TRIGGER"));
  assert.match(guarda, /TG_OP = 'DELETE'[\s\S]*RAISE EXCEPTION/);
  assert.match(guarda, /NEW\.extracao_id <> OLD\.extracao_id/);
  assert.match(guarda, /IF OLD\.status <> 'EM_REVISAO' THEN\s+RAISE EXCEPTION/);
  assert.match(guarda, /IF NEW\.versao <= OLD\.versao THEN\s+RAISE EXCEPTION/);
});

test("055d: repositório segue o índice parcial (ativa por documento)", () => {
  const repo = ler("lib/importacao-contrato/repositorio-importacao.ts");
  assert.match(repo, /ON CONFLICT \(documento_id\) WHERE status <> 'DESCARTADA' DO NOTHING/);
  assert.match(repo, /AND status <> 'DESCARTADA'`/);
  assert.doesNotMatch(repo, /AGUARDANDO_CONFIRMACAO/);
});

test("055d rollback (H8): trava antes de conferir; qualquer importação registrada recusa", () => {
  verificarDown(down, "055d", ["ia_importacoes"], /^(ia_importacoes|kidmais_055_importacao_guarda)$/);
  assert.match(down, /EXISTS \(SELECT 1 FROM ia_importacoes\)/);
  for (const arquivo of ["postcheck", "rollback_precheck", "rollback_postcheck"]) verificarSomenteLeitura(ler(`database/checks/20260928_055d_${arquivo}.sql`), arquivo);
});
