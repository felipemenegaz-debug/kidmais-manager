import { createHash } from "node:crypto";
import type { ClientBase, QueryResultRow } from "pg";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 6–7, camada C): fixture de teste que grava fechamentos.salao_id ou
 * fechamento_revisoes.salao_id. Marca `C:<arquivo>:md5(sql)`, aceita pela guarda dinâmica só quando `arquivo` é de
 * teste ou de apoio de teste. Mesma correlação dos escritores B1–B7: o hash tem de ser o do texto exato enviado.
 *
 * Diferente de `escreverSalao`, serve também fora de transação (fixtures em autocommit): a marca é de sessão e é limpa
 * logo depois. Na falha, tenta limpar (em autocommit a marca de sessão sobreviveria) e relança o erro original; numa
 * transação abortada essa limpeza falha e é ignorada, e o ROLLBACK do dono desfaz a marca.
 */
export async function escreverSalaoFixture<R extends QueryResultRow = Record<string, unknown>>(
  db: Pick<ClientBase, "query">, arquivo: string, sql: string, params: unknown[] = [],
) {
  const marca = `C:${arquivo.replace(/\\/g, "/")}:${createHash("md5").update(sql, "utf8").digest("hex")}`;
  await db.query("SELECT set_config('kidmais.escritor_salao', $1, false)", [marca]);
  let r;
  try {
    r = await db.query<R>(sql, params);
  } catch (erro) {
    await db.query("SELECT set_config('kidmais.escritor_salao', '', false)").catch(() => undefined);
    throw erro;
  }
  await db.query("SELECT set_config('kidmais.escritor_salao', '', false)");
  return r;
}

/** Como o `id` do apoio da integração: a fixture devolve o id da linha gravada. */
export async function idSalaoFixture(db: Pick<ClientBase, "query">, arquivo: string, sql: string, params: unknown[]) {
  return (await escreverSalaoFixture<{ id: string }>(db, arquivo, sql, params)).rows[0]!.id;
}
