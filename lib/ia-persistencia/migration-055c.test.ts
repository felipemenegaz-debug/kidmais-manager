import assert from "node:assert/strict";
import test from "node:test";
import { corpoTabela, ler, verificarDown, verificarSomenteLeitura, verificarUp } from "./migracao-apoio.test.ts";

/** 055c (DOCUMENT): Document Foundation. Prova o texto, sem banco. */
const up = ler("database/migrations/20260928_055c_inteligencia_documentos.sql");
const down = ler("database/rollback/20260928_055c_inteligencia_documentos_down.sql");
const TABELAS = ["ia_documentos", "ia_documento_originais", "ia_extracoes", "ia_evidencias"];

test("055c: transacional, exige a 055a, recusa reaplicação, não toca o Core", () => {
  assert.deepEqual(verificarUp(up, "055c", TABELAS), ["kidmais_055_documento_guarda"]);
  assert.match(up, /to_regprocedure\('public\.kidmais_055_somente_insercao\(\)'\) IS NULL THEN\s+RAISE EXCEPTION/);
  // Status de documento não carrega estados da importação (feature IMPORT separada).
  assert.doesNotMatch(corpoTabela(up, "ia_documentos"), /IMPORTADO|DESCARTADO/);
});

test("055c: filhos presos à empresa do pai; original privado, imutável, hash conferido, upload idempotente", () => {
  assert.match(corpoTabela(up, "ia_documento_originais"), /FOREIGN KEY \(documento_id, empresa_id\)\s+REFERENCES ia_documentos \(id, empresa_id\)/);
  assert.match(corpoTabela(up, "ia_extracoes"), /FOREIGN KEY \(original_id, documento_id, empresa_id\)\s+REFERENCES ia_documento_originais \(id, documento_id, empresa_id\)/, "original do mesmo documento");
  assert.match(corpoTabela(up, "ia_evidencias"), /FOREIGN KEY \(extracao_id, empresa_id\)\s+REFERENCES ia_extracoes \(id, empresa_id\)/);
  const originais = corpoTabela(up, "ia_documento_originais");
  assert.match(originais, /conteudo bytea NOT NULL/);
  assert.match(originais, /sha256 = encode\(sha256\(conteudo\), 'hex'\)/);
  assert.match(originais, /UNIQUE \(empresa_id, sha256\)/);
  assert.doesNotMatch(originais, /url|publico|public_/i);
  for (const tabela of ["ia_documento_originais", "ia_extracoes", "ia_evidencias"]) {
    assert.match(up, new RegExp(`CREATE TRIGGER ${tabela}_055_imutavel_trg BEFORE UPDATE OR DELETE ON ${tabela}\\s+FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao\\(\\)`), tabela);
  }
});

test("055c: invariantes de documento e extração (estado final, tempo, chaves compostas)", () => {
  const documentos = corpoTabela(up, "ia_documentos");
  assert.match(documentos, /CHECK \(status IN \('RECEBIDO', 'EXTRAIDO', 'PRECISA_REVISAO', 'FALHOU'\)\)/);
  assert.doesNotMatch(up, /EXTRAINDO/, "estado nunca gravado removido");
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_055_documento_guarda"), up.indexOf("CREATE TRIGGER ia_documentos_055_guarda_trg"));
  assert.match(guarda, /IF OLD\.status <> 'RECEBIDO' AND NEW\.status <> OLD\.status THEN\s+RAISE EXCEPTION/);
  assert.match(corpoTabela(up, "ia_documento_originais"), /UNIQUE \(id, documento_id, empresa_id\)/);
  const extracoes = corpoTabela(up, "ia_extracoes");
  assert.match(extracoes, /UNIQUE \(id, documento_id, empresa_id\)/);
  assert.match(extracoes, /CHECK \(concluido_em >= iniciado_em\)/);
  assert.match(extracoes, /CHECK \(\(provedor IS NULL\) = \(modelo IS NULL\)\)/);
});

test("055c rollback (H8): trava as quatro tabelas antes de conferir; exige 055d removida; nunca apaga documento", () => {
  verificarDown(down, "055c", TABELAS, /^(ia_|kidmais_055_documento_guarda$)/);
  assert.match(down, /to_regclass\('public\.ia_importacoes'\) IS NOT NULL THEN\s+RAISE EXCEPTION/);
  assert.match(down, /EXISTS \(SELECT 1 FROM ia_documentos\)/);
  assert.doesNotMatch(down, /DROP FUNCTION kidmais_055_somente_insercao/, "a função compartilhada é da 055a");
  for (const arquivo of ["postcheck", "rollback_precheck", "rollback_postcheck"]) verificarSomenteLeitura(ler(`database/checks/20260928_055c_${arquivo}.sql`), arquivo);
});
