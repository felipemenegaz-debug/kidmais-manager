import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * B-5 (conferência antes do E3), leitura das migrations 110, 111 e 115 pelo catálogo com identidade por objeto, no
 * PostgreSQL descartável dos modelos 109 (antes da 110), 110, 111 e 115. Prova que as definições esperadas (md5 dos corpos
 * e dos CHECKs, tgtype dos gatilhos, forma dos índices) são as que as migrations produzem, objeto a objeto, e que as
 * divergências apontadas na revisão (gatilho desabilitado, CHECK/função com a definição da 086, gatilho duplicado, índice
 * fora de forma, homônimo de outro tipo) saem como "parcial". Mutações só dentro de transações desfeitas.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const b5 = createRequire(import.meta.url)(resolve(root, "scripts/conferencia-b5-producao.cjs")) as {
  SQL_ESTADO_SATISFACAO: string;
  IDS_SATISFACAO: ReadonlyArray<readonly [string, string]>;
  CHECKS_SATISFACAO: ReadonlyArray<readonly [string, string, string, string]>;
  CHECKS_REDEFINIDOS: ReadonlyArray<readonly [string, string, string, string, string]>;
  lerEstadoSatisfacao(l: unknown): Record<"110" | "111" | "115", string>;
};
const M086 = readFileSync(resolve(root, "database/migrations/20261018_086_marketing_automacoes.sql"), "utf8");

type Estado = Record<"110" | "111" | "115", "ausente" | "presente" | "parcial">;
const ESPERADO: Record<string, Estado> = {
  "109": { "110": "ausente", "111": "ausente", "115": "ausente" },
  "110": { "110": "presente", "111": "ausente", "115": "ausente" },
  "111": { "110": "presente", "111": "presente", "115": "ausente" },
  "115": { "110": "presente", "111": "presente", "115": "presente" },
};

async function ler(c: Client) {
  const linha = (await c.query(b5.SQL_ESTADO_SATISFACAO)).rows[0];
  return { linha, estado: b5.lerEstadoSatisfacao(linha), objetos: linha.objetos as Record<string, string> };
}
/** md5 das definições atuais dos CHECKs lidos (diagnóstico nas mensagens de falha). */
async function definicoes(c: Client) {
  const nomes = [...b5.CHECKS_SATISFACAO.map((x) => x[2]), ...b5.CHECKS_REDEFINIDOS.map((x) => x[2])];
  return (await c.query(`SELECT conname, md5(pg_get_constraintdef(oid)) AS h FROM pg_constraint WHERE conname = ANY ($1::text[]) ORDER BY conname`, [nomes])).rows
    .map((r) => `${r.conname}=${r.h}`).join(" ");
}
/** Uma mutação numa transação desfeita: devolve o estado lido dentro dela. */
async function comMutacao(c: Client, sql: string[]) {
  await c.query("BEGIN");
  try {
    for (const s of sql) await c.query(s);
    return await ler(c);
  } finally {
    await c.query("ROLLBACK");
  }
}

test("B-5: 110/111/115 pelo catálogo com identidade por objeto (PostgreSQL descartável)", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const modelo = process.env.KIDMAIS_POSTGRES_MODELO ?? "";
  const esperado = ESPERADO[modelo];
  assert.ok(esperado, `modelo sem expectativa: ${modelo}`);
  const c = await conectarDescartavel({ travar: false });
  try {
    await t.test(`modelo ${modelo}: cada objeto no estado da própria migration`, async () => {
      const { estado, objetos } = await ler(c);
      const fora = b5.IDS_SATISFACAO.filter(([id, m]) => objetos[id] !== (esperado[m as keyof Estado] === "presente" ? "conforme" : "ausente"))
        .map(([id]) => `${id}=${objetos[id]}`);
      assert.deepEqual(fora, [], `objetos fora do esperado; CHECKs: ${await definicoes(c)}`);
      assert.deepEqual(estado, esperado);
    });

    if (modelo === "115") {
      const casos: Array<[string, string[], string, Partial<Estado> & Record<string, string>]> = [
        ["gatilho desabilitado", ["ALTER TABLE satisfacao_envios DISABLE TRIGGER satisfacao_envios_guarda"], "110:gatilho:satisfacao_envios_guarda", { "110": "parcial" }],
        ["gatilho homônimo duplicado em outra tabela", [`CREATE TRIGGER satisfacao_envios_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_respostas FOR EACH ROW EXECUTE FUNCTION kidmais110_resposta_guarda()`],
          "110:gatilho:satisfacao_envios_guarda", { "110": "parcial" }],
        ["CHECK redefinido com a definição da 086", ["ALTER TABLE marketing_automacao_execucoes DROP CONSTRAINT marketing_exec_acao, ADD CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP'))"],
          "110:check:marketing_exec_acao", { "110": "parcial" }],
        ["CHECK redefinido sem validar", ["ALTER TABLE marketing_automacao_execucoes DROP CONSTRAINT marketing_exec_acao, ADD CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'PESQUISA_SATISFACAO')) NOT VALID"],
          "110:check:marketing_exec_acao", { "110": "parcial" }],
        ["CHECK novo removido", ["ALTER TABLE marketing_automacao_regras DROP CONSTRAINT marketing_regras_pesquisa_revisada"], "110:check:marketing_regras_pesquisa_revisada", { "110": "parcial" }],
        ["função da 086 com o corpo da 086", [funcao086()], "110:funcao:kidmais086_execucao_tenant()", { "110": "parcial" }],
        ["índice 115 removido (054 já fora)", ["DROP INDEX fechamentos_115_empresa_data_idx"], "115:indice:fechamentos_115_empresa_data_idx", { "115": "parcial" }],
        ["índice 115 com outra forma", ["DROP INDEX fechamentos_115_empresa_data_idx", "CREATE INDEX fechamentos_115_empresa_data_idx ON fechamentos (data_evento, empresa_id)"],
          "115:indice:fechamentos_115_empresa_data_idx", { "115": "parcial" }],
      ];
      for (const [nome, sql, id, parcial] of casos) {
        await t.test(`modelo 115: ${nome} → objeto fora de "conforme", migration parcial`, async () => {
          const { estado, objetos } = await comMutacao(c, sql);
          assert.notEqual(objetos[id], "conforme", id);
          assert.deepEqual(estado, { ...esperado, ...parcial });
        });
      }
    }
    if (modelo === "109") {
      const casos: Array<[string, string[], Partial<Estado> & Record<string, string>]> = [
        ["índice 115 criado antes (054 ainda presente)", ["CREATE INDEX fechamentos_115_empresa_data_idx ON fechamentos (empresa_id, data_evento)"], { "115": "parcial" }],
        ["054 removido sem o 115", ["DROP INDEX fechamentos_054_empresa_idx"], { "115": "parcial" }],
        ["054 com outra forma", ["DROP INDEX fechamentos_054_empresa_idx", "CREATE INDEX fechamentos_054_empresa_idx ON fechamentos (empresa_id)"], { "115": "parcial" }],
        ["homônimo de tabela da 110 que é visão", ["CREATE VIEW satisfacao_saidas AS SELECT 1 AS x"], { "110": "parcial" }],
        ["CHECK da 086 já com a definição da 110", ["ALTER TABLE marketing_automacao_execucoes DROP CONSTRAINT marketing_exec_acao, ADD CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'PESQUISA_SATISFACAO'))"], { "110": "parcial" }],
      ];
      for (const [nome, sql, parcial] of casos) {
        await t.test(`modelo 109: ${nome} → parcial`, async () => {
          assert.deepEqual((await comMutacao(c, sql)).estado, { ...esperado, ...parcial });
        });
      }
    }
  } finally {
    await encerrarDescartavel(c, false);
  }
});

/** A definição de kidmais086_execucao_tenant() como a 086 a cria (CREATE OR REPLACE com o corpo da 086). */
function funcao086() {
  const m = /CREATE (?:OR REPLACE )?FUNCTION kidmais086_execucao_tenant\(\)[\s\S]*?AS \$\$[\s\S]*?\$\$;/.exec(M086);
  assert.ok(m, "086 sem kidmais086_execucao_tenant");
  return m[0].replace(/^CREATE (?:OR REPLACE )?FUNCTION/, "CREATE OR REPLACE FUNCTION");
}
