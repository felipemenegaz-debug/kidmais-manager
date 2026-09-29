import assert from "node:assert/strict";
import test from "node:test";
import { corpoTabela, ler, verificarDown, verificarSomenteLeitura, verificarUp } from "./migracao-apoio.test.ts";

/** 055a (CORE): uso de modelos e reservas de orçamento. Prova o texto, sem banco. */
const up = ler("database/migrations/20260928_055a_inteligencia_uso.sql");
const down = ler("database/rollback/20260928_055a_inteligencia_uso_down.sql");
const TABELAS = ["ia_orcamento_reservas", "ia_uso_modelo"];

test("055a: transacional, recusa reaplicação, não toca o Core; funções com search_path fixo", () => {
  const funcoes = verificarUp(up, "055a", TABELAS);
  assert.deepEqual(funcoes.sort(), ["kidmais_055_somente_insercao", "kidmais_055a_reserva_guarda"]);
});

test("055a: uso desconhecido é NULL (nunca zero) e consistente; custo por moeda; uso ligado a no máximo uma reserva", () => {
  const uso = corpoTabela(up, "ia_uso_modelo");
  assert.match(uso, /tokens_entrada integer CHECK \(tokens_entrada IS NULL OR tokens_entrada >= 0\)/);
  assert.doesNotMatch(uso, /tokens_entrada integer NOT NULL/);
  assert.match(uso, /CHECK \(\(tokens_entrada IS NULL\) = \(tokens_saida IS NULL\)\)/);
  assert.match(uso, /CHECK \(\(custo_estimado_micros IS NULL\) = \(moeda IS NULL\)\)/);
  assert.match(uso, /reserva_id uuid UNIQUE REFERENCES ia_orcamento_reservas\(id\)/);
  assert.doesNotMatch(uso, /prompt|resposta|conteudo|texto|api_key|secret/i);
  const view = up.slice(up.indexOf("CREATE VIEW ia_uso_diario"));
  assert.match(view, /provedor, modelo, capacidade, workload, tier, moeda,/, "custo agrupado por moeda: moedas não se somam");
  assert.match(view, /chamadas_uso_desconhecido/);
});

test("055a: reserva só sai de ABERTA uma vez, é imutável e nunca apagada", () => {
  const reservas = corpoTabela(up, "ia_orcamento_reservas");
  assert.match(reservas, /estado IN \('ABERTA', 'RECONCILIADA', 'LIBERADA', 'USO_DESCONHECIDO', 'ORFA'\)/);
  assert.match(reservas, /CHECK \(\(estado = 'ABERTA'\) = \(encerrado_em IS NULL\)\)/);
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_055a_reserva_guarda"), up.indexOf("CREATE TRIGGER ia_orcamento_reservas_055a_guarda_trg"));
  assert.match(guarda, /TG_OP = 'DELETE'/);
  assert.match(guarda, /IF NOT \(OLD\.estado = 'ABERTA' OR/);
  assert.match(guarda, /NEW\.tokens_reservados <> OLD\.tokens_reservados/);
  assert.match(up, /CREATE TRIGGER ia_uso_modelo_055_imutavel_trg BEFORE UPDATE OR DELETE ON ia_uso_modelo\s+FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao\(\)/);
});

test("055a rollback (H8): trava antes de conferir, reconfere sob trava, exige 055c removida e decisão explícita sobre o histórico", () => {
  verificarDown(down, "055a", TABELAS, /^(ia_|kidmais_055a?_)/);
  assert.match(down, /to_regclass\('public\.ia_documentos'\) IS NOT NULL THEN\s+RAISE EXCEPTION/);
  assert.match(down, /estado = 'ABERTA'/);
  assert.match(down, /current_setting\('kidmais\.rollback_055a_descartar_uso', true\)/);
  assert.match(down, /EXISTS \(SELECT 1 FROM ia_orcamento_reservas\)/, "reserva encerrada/órfã também é histórico");
  for (const arquivo of ["postcheck", "rollback_precheck", "rollback_postcheck"]) verificarSomenteLeitura(ler(`database/checks/20260928_055a_${arquivo}.sql`), arquivo);
});

test("055a (A5): período contábil fixo na reserva e no uso; ORFA conta e só reconcilia; período imutável", () => {
  const reservas = corpoTabela(up, "ia_orcamento_reservas");
  const usos = corpoTabela(up, "ia_uso_modelo");
  for (const corpo of [reservas, usos]) {
    assert.match(corpo, /periodo_dia date NOT NULL/);
    assert.match(corpo, /periodo_mes char\(7\) NOT NULL/);
    assert.match(corpo, /CHECK \(periodo_mes = to_char\(periodo_dia, 'YYYY-MM'\)\)/);
  }
  assert.match(reservas, /'USO_DESCONHECIDO', 'ORFA'\)/);
  const guarda = up.slice(up.indexOf("CREATE FUNCTION kidmais_055a_reserva_guarda"), up.indexOf("CREATE TRIGGER ia_orcamento_reservas_055a_guarda_trg"));
  assert.match(guarda, /OLD\.estado = 'ORFA' AND NEW\.estado IN \('RECONCILIADA', 'USO_DESCONHECIDO'\)/, "órfã nunca é liberada");
  assert.match(guarda, /NEW\.periodo_dia <> OLD\.periodo_dia/);
  assert.match(up.slice(up.indexOf("CREATE VIEW ia_uso_diario")), /periodo_dia AS dia/, "observabilidade usa o mesmo período do orçamento");
});
