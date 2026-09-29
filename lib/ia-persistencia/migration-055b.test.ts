import assert from "node:assert/strict";
import test from "node:test";
import { corpoTabela, ler, verificarDown, verificarSomenteLeitura, verificarUp } from "./migracao-apoio.test.ts";

/** 055b (ACTIONS): registro do Human Gate. Prova o texto, sem banco. */
const up = ler("database/migrations/20260928_055b_inteligencia_operacoes.sql");
const down = ler("database/rollback/20260928_055b_inteligencia_operacoes_down.sql");

test("055b: transacional, recusa reaplicação, não toca o Core", () => {
  assert.deepEqual(verificarUp(up, "055b", ["ia_operacoes"]), ["kidmais_055_operacao_guarda"]);
});

test("055b: estado terminal não muda, identidade imutável, versão não retrocede, idempotência única", () => {
  const operacoes = corpoTabela(up, "ia_operacoes");
  assert.match(operacoes, /CONSTRAINT ia_operacoes_idempotencia_uk UNIQUE \(idempotency_key\)/);
  assert.match(operacoes, /estado <> 'AGUARDANDO_CONFIRMACAO' OR payload_hash <> ''/);
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_055_operacao_guarda"), up.indexOf("CREATE TRIGGER ia_operacoes_055_guarda_trg"));
  assert.match(guarda, /OLD\.estado IN \('EXECUTADA', 'CANCELADA', 'EXPIRADA', 'FALHOU'\)/);
  assert.match(guarda, /NEW\.versao < OLD\.versao/);
  assert.match(guarda, /NEW\.empresa_id <> OLD\.empresa_id/);
});

test("055b rollback (H8): trava antes de conferir; recusa operação executada e rascunho ainda válido", () => {
  verificarDown(down, "055b", ["ia_operacoes"], /^(ia_|kidmais_055_)/);
  assert.match(down, /estado = 'EXECUTADA'/);
  assert.match(down, /estado IN \('COLETANDO', 'AGUARDANDO_CONFIRMACAO'\) AND expira_em > now\(\)/);
  for (const arquivo of ["postcheck", "rollback_precheck", "rollback_postcheck"]) verificarSomenteLeitura(ler(`database/checks/20260928_055b_${arquivo}.sql`), arquivo);
});
