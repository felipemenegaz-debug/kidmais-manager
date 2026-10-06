import assert from "node:assert/strict";
import test from "node:test";
import { ler, verificarDown, verificarSomenteLeitura, verificarUp } from "./migracao-apoio.test.ts";

/** 064: reimportação depois do cancelamento do contrato integrado. Prova o texto, sem banco. */
const up = ler("database/migrations/20261006_064_reimportacao_apos_cancelamento.sql");
const down = ler("database/rollback/20261006_064_reimportacao_apos_cancelamento_down.sql");
const guarda055 = ler("database/migrations/20260928_055d_inteligencia_importacoes.sql");

test("064: transacional, exige 055d e 061, recusa reaplicação, não derruba nem altera tabela", () => {
  assert.deepEqual(verificarUp(up, "064", []), ["kidmais_064_importacao_guarda"]);
  assert.match(up, /to_regclass\('public\.ia_importacoes'\) IS NULL OR to_regprocedure\('public\.kidmais_055_importacao_guarda\(\)'\) IS NULL THEN\s+RAISE EXCEPTION '064 exige a 055d/);
  assert.match(up, /to_regclass\('public\.contrato_importacoes'\) IS NULL THEN RAISE EXCEPTION '064 exige a 061/);
  assert.match(up, /tgname = 'ia_importacoes_055_guarda_trg'\)\s+IS DISTINCT FROM 'public\.kidmais_055_importacao_guarda\(\)'::regprocedure THEN\s+RAISE EXCEPTION/, "só reaponta a partir da 055d");
  assert.doesNotMatch(up, /UPDATE ia_importacoes|INSERT INTO/, "nenhuma linha alterada pela migration");
  assert.match(up, /CREATE OR REPLACE TRIGGER ia_importacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_importacoes\s+FOR EACH ROW EXECUTE FUNCTION kidmais_064_importacao_guarda\(\);/);
});

test("064: a guarda mantém as regras da 055d e abre uma única transição", () => {
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_064_importacao_guarda"), up.indexOf("CREATE OR REPLACE TRIGGER"));
  const original = guarda055.slice(guarda055.indexOf("CREATE FUNCTION kidmais_055_importacao_guarda"), guarda055.indexOf("CREATE TRIGGER"));
  for (const regra of [/TG_OP = 'DELETE'[\s\S]*?RAISE EXCEPTION 'ia_importacoes não é apagada\.'/, /NEW\.extracao_id <> OLD\.extracao_id/, /NEW\.criado_por <> OLD\.criado_por/,
    /IF NEW\.versao <= OLD\.versao THEN\s+RAISE EXCEPTION/, /IF OLD\.status <> 'EM_REVISAO' THEN\s+RAISE EXCEPTION 'Importação encerrada não muda\.'/]) {
    assert.match(guarda, regra); assert.match(original, regra);
  }
  assert.match(guarda, /IF OLD\.status = 'IMPORTADA' THEN\s+IF NEW\.status = 'DESCARTADA' AND public\.kidmais064_contrato_cancelado\(OLD\.id\) THEN RETURN NEW; END IF;\s+RAISE EXCEPTION 'Importação encerrada não muda\.'/);
  assert.doesNotMatch(guarda, /NEW\.status = 'EM_REVISAO'|NEW\.status = 'IMPORTADA'/, "IMPORTADA não volta a EM_REVISAO nem é reimportada no lugar");
  const predicado = up.slice(up.indexOf("CREATE FUNCTION kidmais064_contrato_cancelado"), up.indexOf("CREATE FUNCTION kidmais_064_importacao_guarda"));
  assert.match(predicado, /LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp/);
  assert.match(predicado, /FROM public\.contrato_importacoes ci JOIN public\.contratos c ON c\.id = ci\.contrato_id\s+WHERE ci\.importacao_id = importacao AND c\.status = 'CANCELADO'/);
});

test("064: código só substitui com a 064 instalada, contrato cancelado e versão conferida; preserva o resultado em dados", () => {
  const repo = ler("lib/importacao-contrato/repositorio-importacao.ts");
  assert.match(repo, /to_regprocedure\('public\.kidmais064_contrato_cancelado\(uuid\)'\) IS NOT NULL AS ok/);
  const sql = repo.slice(repo.indexOf("UPDATE ia_importacoes SET status = 'DESCARTADA'"), repo.indexOf("RETURNING id", repo.indexOf("UPDATE ia_importacoes SET status = 'DESCARTADA'")));
  assert.match(sql, /cliente_id = NULL, resultado = NULL/, "055d: DESCARTADA sem cliente e resultado");
  assert.match(sql, /'substituicao', jsonb_build_object\([\s\S]*'clienteId', cliente_id::text, 'resultado', resultado,[\s\S]*'contratoId'/);
  assert.match(sql, /WHERE id = \$1::uuid AND empresa_id = \$2::uuid AND status = 'IMPORTADA' AND versao = \$3\s+AND kidmais064_contrato_cancelado\(id\)/);
  // A 055d continua valendo para a ativa por documento (o índice parcial não muda).
  assert.match(repo, /ON CONFLICT \(documento_id\) WHERE status <> 'DESCARTADA' DO NOTHING/);
});

test("064 rollback: trava, reconfere o gatilho e devolve a guarda da 055d sem apagar dado", () => {
  verificarDown(down, "064", ["ia_importacoes"], /^(kidmais_064_importacao_guarda|kidmais064_contrato_cancelado)$/);
  assert.match(down, /CREATE OR REPLACE TRIGGER ia_importacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_importacoes\s+FOR EACH ROW EXECUTE FUNCTION kidmais_055_importacao_guarda\(\);/);
  assert.doesNotMatch(down, /UPDATE ia_importacoes/, "importações já substituídas permanecem como histórico");
  for (const arquivo of ["precheck", "postcheck"]) verificarSomenteLeitura(ler(`database/checks/20261006_064_${arquivo}.sql`), arquivo);
});
