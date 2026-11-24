import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, empresa, executor, SENHA_FALSA, vincular } from "./harness-postgres.ts";

/**
 * 136 (LOCAL 24/11/2026, Astra r1 P2, decisão de Felipe "quero que funcione com os dois ao mesmo tempo"): coluna
 * marketing_campanhas.destino_externo. Pré, migration e pós; reaplicação recusada; campanha antiga fica interna (sem
 * backfill); a restrição recusa externa com site; o gatilho da 085 segue; o código lê com e sem a coluna; o down exige a
 * confirmação, remove só o que a 136 criou e permite reaplicar. PostgreSQL descartável (modelo 131), opt-in.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const [PRE, MIG, POS] = ["database/checks/20261124_136_precheck.sql", "database/migrations/20261124_136_campanha_destino_externo.sql", "database/checks/20261124_136_postcheck.sql"].map(ler);
const DOWN = ler("database/rollback/20261124_136_campanha_destino_externo_down.sql");

test("136: destino externo da campanha — aplicar, reaplicar, restrição, leitura com e sem a coluna e down", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const variavelAntes = process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID;
  const falha = async (sql: string, v: unknown[], padrao: RegExp, rotulo: string) => {
    await assert.rejects(c.query(sql, v), (e: { message?: string }) => padrao.test(String(e.message)), rotulo);
    await c.query("ROLLBACK").catch(() => undefined);
  };
  try {
    const A = await empresa(c, "Sintético Buffet 136");
    const u = (await c.query(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Sintético 136', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text`,
      [`${cod("u136")}@example.test`, SENHA_FALSA])).rows[0].id as string;
    await vincular(c, A, u, "REPRESENTANTE_AUTORIZADO");
    const site = (await c.query(`INSERT INTO marketing_sites (empresa_id, slug, rascunho, criado_por, atualizado_por) VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING id::text`, [A, cod("s136-"), u])).rows[0].id as string;
    const campanha = async (codigo: string, siteId: string | null) => (await c.query(`INSERT INTO marketing_campanhas (empresa_id, codigo, nome, canal, origem_codigo, inicio, utm_source, utm_medium, site_id, criada_por, atualizada_por)
      VALUES ($1, $2, 'Sintética', 'INSTAGRAM', 'INSTAGRAM', '2026-11-01', 'instagram', 'social', $3, $4, $4) RETURNING id::text`, [A, codigo, siteId, u])).rows[0].id as string;
    const antiga = await campanha("antiga-136", null);
    const comSite = await campanha("com-site-136", site);

    process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = A;
    const campanhas = carregarComBanco("lib/marketing/campanhas.ts", c, () => null) as unknown as typeof import("./campanhas.ts");
    const tx = executor(c);
    assert.equal(await campanhas.temDestinoExterno(tx), false, "antes da 136");
    assert.deepEqual((await campanhas.listarCampanhas(tx, A)).map((x) => x.destinoExterno), [false, false], "sem a coluna: nenhuma externa");
    await assert.rejects(campanhas.executarAcaoCampanha(tx, A, u, { acao: "criar", codigo: "externa-sem-136", nome: "Sintética", canal: "INSTAGRAM", origemCodigo: "INSTAGRAM",
      inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", destinoExterno: true } as never), (e: { code?: string }) => e.code === "MARKETING_DESTINO_EXTERNO_INDISPONIVEL");

    await c.query(PRE);
    await c.query(MIG);
    await c.query(POS);
    assert.equal(await campanhas.temDestinoExterno(tx), true);
    assert.deepEqual((await c.query("SELECT id::text, destino_externo FROM marketing_campanhas WHERE empresa_id=$1 ORDER BY codigo", [A])).rows,
      [{ id: antiga, destino_externo: false }, { id: comSite, destino_externo: false }], "sem backfill: as campanhas existentes ficam internas");

    await falha(PRE, [], /136 já presente/, "precheck recusa a reaplicação");
    await falha(MIG, [], /destino_externo já existe/, "a migration recusa a reaplicação");
    await c.query(POS);

    await falha("UPDATE marketing_campanhas SET destino_externo = true WHERE id = $1", [comSite], /kidmais_136_destino_externo_sem_site/, "externa com site: recusada");
    await c.query("UPDATE marketing_campanhas SET destino_externo = true WHERE id = $1", [antiga]);
    await falha("UPDATE marketing_campanhas SET site_id = $2 WHERE id = $1", [antiga, site], /kidmais_136_destino_externo_sem_site/, "site numa externa: recusado");
    await falha("UPDATE marketing_campanhas SET codigo = 'outro' WHERE id = $1", [antiga], /imutáveis/, "gatilho da 085 segue");

    const lidas = await campanhas.listarCampanhas(tx, A);
    const porId = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    assert.deepEqual(lidas.map((x) => [x.id, x.destinoExterno, x.siteId]).sort(porId), [[antiga, true, null], [comSite, false, site]].sort(porId));
    const criada = await campanhas.executarAcaoCampanha(tx, A, u, { acao: "criar", codigo: "externa-136", nome: "Sintética externa", canal: "INSTAGRAM", origemCodigo: "INSTAGRAM",
      inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", destinoExterno: true } as never);
    assert.equal(criada.destinoExterno, true);
    const mantida = await campanhas.executarAcaoCampanha(tx, A, u, { acao: "editar", id: criada.id, versao: criada.versao, nome: "Renomeada", canal: "INSTAGRAM", origemCodigo: "INSTAGRAM",
      inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social" } as never);
    assert.equal(mantida.destinoExterno, true, "edição sem o campo mantém");
    const paraSite = await campanhas.executarAcaoCampanha(tx, A, u, { acao: "editar", id: criada.id, versao: mantida.versao, nome: "Renomeada", canal: "INSTAGRAM", origemCodigo: "INSTAGRAM",
      inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", siteId: site } as never);
    assert.deepEqual([paraSite.destinoExterno, paraSite.siteId], [false, site], "ganhar site do iA.Fest tira o destino externo (sem violar a restrição)");

    await falha(DOWN, [], /confirme com SET kidmais.rollback_136/, "down sem confirmação");
    assert.equal(await campanhas.temDestinoExterno(tx), true, "down recusado não mexe");
    await c.query("SET kidmais.rollback_136 = 'descartar-destino-externo'");
    await c.query(DOWN);
    await c.query("RESET kidmais.rollback_136");
    assert.equal(await campanhas.temDestinoExterno(tx), false, "down remove a coluna");
    assert.equal((await c.query("SELECT count(*)::int n FROM pg_constraint WHERE conname LIKE 'kidmais\\_136\\_%'")).rows[0].n, 0, "e a restrição");
    assert.equal((await c.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='public.marketing_campanhas'::regclass AND NOT tgisinternal")).rows[0].n, 1, "gatilho da 085 intacto");
    assert.deepEqual((await campanhas.listarCampanhas(tx, A)).map((x) => x.destinoExterno), [false, false, false], "depois do down: nenhuma externa");
    await falha(POS, [], /forma divergente/, "postcheck acusa a ausência");
    await c.query(PRE);
    await c.query(MIG);
    await c.query(POS);
  } finally {
    if (variavelAntes === undefined) delete process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID; else process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = variavelAntes;
    await c.end();
  }
});
