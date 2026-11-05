import test from "node:test";
import assert from "node:assert/strict";
import type { DbExecutor } from "../db/contracts.ts";
import { contarInstrucoes, escreverSalao, md5Sql } from "./escrever-salao.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 7, P2-1): contrato do helper sem banco. A correlação com
 * current_query(), o KD901 e o rollback da marca são provados no PostgreSQL descartável (bateria da guarda dinâmica).
 */
function executor(opcoes: { aberta?: boolean; falha?: Error; falhaLimpeza?: Error } = {}) {
  const sqls: Array<{ sql: string; valores: readonly unknown[] }> = [];
  const tx = {
    async query(sql: string, valores: readonly unknown[] = []) {
      sqls.push({ sql, valores });
      if (sql.includes("WHERE coalesce(current_setting('kidmais.escritor_salao'")) return { rows: opcoes.aberta ? [] : [{ ok: String(valores[0]) }], rowCount: 1 };
      if (sql.includes("set_config('kidmais.escritor_salao', '', true)")) {
        if (opcoes.falhaLimpeza) throw opcoes.falhaLimpeza;
        return { rows: [{}], rowCount: 1 };
      }
      if (opcoes.falha) throw opcoes.falha;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as DbExecutor;
  return { tx, sqls };
}
const SQL = "UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid";
const MARCA = { escritor: "B1" as const, caminho: "FORMALIZACAO_POS_ASSINATURA" as const, origem: "RECONCILIACAO_OPERACIONAL" as const };

test("instruções: literais, identificadores, dollar-quotes e comentários não contam; ';' final não abre outra", () => {
  assert.equal(contarInstrucoes(SQL), 1);
  assert.equal(contarInstrucoes(SQL + ";  \n"), 1);
  assert.equal(contarInstrucoes(SQL + "; SELECT 1"), 2);
  assert.equal(contarInstrucoes("UPDATE t SET a = 'x;y' WHERE b = 'it''s;'"), 1);
  assert.equal(contarInstrucoes(`UPDATE "t;x" SET a = E'\\';' WHERE true`), 1);
  assert.equal(contarInstrucoes("SELECT $f$ ; $f$, $$;$$ -- ; comentário\n /* ; /* ; */ */"), 1);
  assert.equal(contarInstrucoes("SELECT 1 /* ; */ ; SELECT 2 -- fim"), 2);
  assert.equal(contarInstrucoes(" ; ; "), 0);
});

test("marca logo antes da instrução, no mesmo comando que confere marca vazia; limpeza logo depois", async () => {
  const { tx, sqls } = executor();
  await escreverSalao(tx, MARCA, SQL, ["f", "s"]);
  assert.equal(sqls.length, 3);
  assert.match(sqls[0]!.sql, /set_config\('kidmais\.escritor_salao', \$1, true\).*WHERE coalesce\(current_setting\('kidmais\.escritor_salao', true\), ''\) = ''/s);
  assert.equal(sqls[0]!.valores[0], `B1:FORMALIZACAO_POS_ASSINATURA:RECONCILIACAO_OPERACIONAL:${md5Sql(SQL)}`);
  assert.equal(sqls[1]!.sql, SQL);
  assert.deepEqual(sqls[1]!.valores, ["f", "s"]);
  assert.match(sqls[2]!.sql, /set_config\('kidmais\.escritor_salao', '', true\)/);
});

test("recusas sem SQL: lote, texto vazio e escrita sem parâmetros (protocolo estendido)", async () => {
  for (const [sql, params] of [[SQL + "; DELETE FROM fechamentos", ["f", "s"]], ["  ", ["f"]], [SQL, []]] as const) {
    const { tx, sqls } = executor();
    await assert.rejects(escreverSalao(tx, MARCA, sql, params), /escreverSalao/);
    assert.equal(sqls.length, 0, sql);
  }
});

test("marcas não se aninham: com marca aberta, recusa antes da escrita", async () => {
  const { tx, sqls } = executor({ aberta: true });
  await assert.rejects(escreverSalao(tx, MARCA, SQL, ["f", "s"]), /não se aninham/);
  assert.equal(sqls.length, 1, "só a tentativa de marcar");
});

test("falha da instrução: o MESMO erro sobe e nenhuma SQL de limpeza é enviada (a transação abortada aceita só ROLLBACK)", async () => {
  const original = Object.assign(new Error("salão indisponível"), { code: "23514" });
  const { tx, sqls } = executor({ falha: original });
  await assert.rejects(escreverSalao(tx, MARCA, SQL, ["f", "s"]), (e) => e === original && (e as { code?: string }).code === "23514");
  assert.equal(sqls.length, 2, "marca e instrução, nada depois");
});

test("falha da limpeza depois do sucesso propaga", async () => {
  const limpeza = new Error("limpeza");
  const { tx } = executor({ falhaLimpeza: limpeza });
  await assert.rejects(escreverSalao(tx, MARCA, SQL, ["f", "s"]), (e) => e === limpeza);
});
