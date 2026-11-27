import assert from "node:assert/strict";
import test from "node:test";
import { esquemaAcaoCampanha, executarAcaoCampanha, listarCampanhas, temDestinoExterno } from "./campanhas.ts";

/**
 * r2 (P2 do Astra r1, decisão de Felipe em 24/11/2026: "quero que funcione com os dois ao mesmo tempo"): destino externo
 * explícito por campanha (136). Banco dublado: só o SQL e os parâmetros que o domínio envia.
 */
const EMPRESA = "5e5e5e5e-0000-4000-8000-000000000001";
const OUTRA = "5e5e5e5e-0000-4000-8000-000000000002";
const USUARIO = "6f6f6f6f-0000-4000-8000-000000000001";
const SITE = "7a7a7a7a-0000-4000-8000-000000000001";
const CAMPANHA = "8b8b8b8b-0000-4000-8000-000000000001";

function banco(comColuna: boolean) {
  const chamadas: Array<{ sql: string; v: unknown[] }> = [];
  const linha = (destino: unknown) => ({ id: CAMPANHA, codigo: "camp-sintetica", nome: "Sintética", canal: "INSTAGRAM", origem_codigo: "INSTAGRAM", objetivo: null,
    inicio: "2026-11-01", fim: null, orcamento_centavos: null, utm_source: "instagram", utm_medium: "social", status: "ATIVA", estabelecimento_id: null,
    site_id: null, destino_externo: destino, versao: 1, criada_em: "x", atualizada_em: "x" });
  const tx = {
    async query(sql: string, v: unknown[] = []) {
      chamadas.push({ sql, v });
      if (sql.includes("pg_attribute") && sql.includes("destino_externo")) return { rows: [{ ok: comColuna }] };
      if (sql.includes("FROM marketing_sites")) return { rows: [{ id: v[0] }] };
      if (sql.startsWith("INSERT INTO marketing_campanhas")) return { rows: [linha(comColuna ? v[14] : false)] };
      if (sql.startsWith("UPDATE marketing_campanhas") || sql.startsWith("SELECT")) return { rows: [linha(comColuna ? true : false)] };
      throw new Error("SQL inesperado: " + sql.slice(0, 60));
    },
  };
  return { tx: tx as never, chamadas };
}
const criar = (extra: Record<string, unknown>) => esquemaAcaoCampanha.parse({ acao: "criar", codigo: "camp-sintetica", nome: "Sintética", canal: "INSTAGRAM",
  origemCodigo: "INSTAGRAM", inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", ...extra });
const editar = (extra: Record<string, unknown>) => esquemaAcaoCampanha.parse({ acao: "editar", id: CAMPANHA, versao: 1, nome: "Sintética", canal: "INSTAGRAM",
  origemCodigo: "INSTAGRAM", inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", ...extra });
async function comEmpresaDoSite(valor: string | undefined, corpo: () => Promise<void>) {
  const antes = process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID;
  if (valor === undefined) delete process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID; else process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = valor;
  try { await corpo(); } finally { if (antes === undefined) delete process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID; else process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = antes; }
}
const codigo = (code: string) => (e: { code?: string }) => e.code === code;

test("136 domínio: destino externo só na empresa da integração, com a coluna, e sem site do iA.Fest", async () => {
  await comEmpresaDoSite(EMPRESA, async () => {
    const ok = banco(true);
    const c = await executarAcaoCampanha(ok.tx, EMPRESA, USUARIO, criar({ destinoExterno: true }));
    assert.equal(c.destinoExterno, true);
    const ins = ok.chamadas.find((x) => x.sql.startsWith("INSERT"))!;
    assert.match(ins.sql, /, destino_externo\)/);
    assert.equal(ins.v[14], true, "grava destino_externo = true");
    assert.equal(ins.v[12], null, "sem site do iA.Fest");

    await assert.rejects(executarAcaoCampanha(banco(true).tx, OUTRA, USUARIO, criar({ destinoExterno: true })), codigo("MARKETING_DESTINO_EXTERNO_INDISPONIVEL"), "outra empresa");
    await assert.rejects(executarAcaoCampanha(banco(false).tx, EMPRESA, USUARIO, criar({ destinoExterno: true })), codigo("MARKETING_DESTINO_EXTERNO_INDISPONIVEL"), "sem a 136");
    const comSite = banco(true);
    await assert.rejects(executarAcaoCampanha(comSite.tx, EMPRESA, USUARIO, criar({ destinoExterno: true, siteId: SITE })), codigo("MARKETING_DESTINO_EXTERNO_COM_SITE"));
    assert.equal(comSite.chamadas.some((x) => x.sql.startsWith("INSERT")), false, "recusa sem escrita");
    await assert.rejects(executarAcaoCampanha(banco(true).tx, EMPRESA, USUARIO, editar({ destinoExterno: true, siteId: SITE })), codigo("MARKETING_DESTINO_EXTERNO_COM_SITE"), "edição também");

    // Interna (com site ou sem nada) na mesma empresa: convive, grava false.
    for (const extra of [{ siteId: SITE }, {}, { destinoExterno: false }]) {
      const b = banco(true);
      await executarAcaoCampanha(b.tx, EMPRESA, USUARIO, criar(extra));
      assert.equal(b.chamadas.find((x) => x.sql.startsWith("INSERT"))!.v[14], false, JSON.stringify(extra));
    }
  });
  await comEmpresaDoSite("empresa-sintetica", async () => {
    await assert.rejects(executarAcaoCampanha(banco(true).tx, EMPRESA, USUARIO, criar({ destinoExterno: true })), codigo("MARKETING_DESTINO_EXTERNO_INDISPONIVEL"), "variável fora do formato");
  });
});

test("136 domínio: sem a coluna o SQL não a cita e nenhuma campanha é externa; edição sem o campo mantém a escolha", async () => {
  await comEmpresaDoSite(EMPRESA, async () => {
    const sem = banco(false);
    assert.equal(await temDestinoExterno(sem.tx), false);
    const c = await executarAcaoCampanha(sem.tx, EMPRESA, USUARIO, criar({}));
    assert.equal(c.destinoExterno, false);
    for (const x of sem.chamadas.filter((y) => !y.sql.includes("pg_attribute"))) assert.doesNotMatch(x.sql.replace("false AS destino_externo", ""), /destino_externo/, x.sql.slice(0, 40));
    assert.match(sem.chamadas.find((x) => x.sql.startsWith("INSERT"))!.sql, /false AS destino_externo/);
    const lista = banco(false);
    assert.deepEqual((await listarCampanhas(lista.tx, EMPRESA)).map((x) => x.destinoExterno), [false]);

    const ed = banco(true);
    await executarAcaoCampanha(ed.tx, EMPRESA, USUARIO, editar({}));
    const up = ed.chamadas.find((x) => x.sql.startsWith("UPDATE"))!;
    assert.match(up.sql, /destino_externo = CASE WHEN \$13::uuid IS NOT NULL THEN false ELSE COALESCE\(\$16::boolean, destino_externo\) END/);
    assert.equal(up.v[15], null, "sem o campo: COALESCE mantém o gravado");
    const ed2 = banco(true);
    await executarAcaoCampanha(ed2.tx, EMPRESA, USUARIO, editar({ destinoExterno: false }));
    assert.equal(ed2.chamadas.find((x) => x.sql.startsWith("UPDATE"))!.v[15], false);
    const ed3 = banco(false);
    await executarAcaoCampanha(ed3.tx, EMPRESA, USUARIO, editar({}));
    assert.doesNotMatch(ed3.chamadas.find((x) => x.sql.startsWith("UPDATE"))!.sql.replace("false AS destino_externo", ""), /destino_externo/);
    assert.equal(ed3.chamadas.find((x) => x.sql.startsWith("UPDATE"))!.v.length, 15);
  });
});

test("136 cliques do site externo: sem a coluna nada grava (nem lê o plano); com ela o INSERT exige c.destino_externo", async () => {
  const { registrarCliqueSiteKidmais } = await import("./site-kidmais.ts");
  await comEmpresaDoSite(EMPRESA, async () => {
    const sem = banco(false);
    await registrarCliqueSiteKidmais(sem.tx, EMPRESA, CAMPANHA, "CLIQUE_LINK_CAMPANHA");
    assert.deepEqual(sem.chamadas.map((x) => x.sql.trim().slice(0, 30)), ["SELECT id FROM empresas WHERE ", "SELECT EXISTS(SELECT 1 FROM pg"]);
    assert.match(sem.chamadas[0].sql, /FOR SHARE$/, "trava que espera FOR UPDATE e FOR NO KEY UPDATE");
  });
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync("lib/marketing/site-kidmais.ts", "utf8");
  assert.match(fonte, /c\.status <> 'ARQUIVADA' AND c\.destino_externo`/, "INSERT só para campanha externa");
  assert.match(fonte, /campanha\.status === 'ARQUIVADA' \|\| !campanha\.destinoExterno\) return;/, "atribuição só para campanha externa");
});
