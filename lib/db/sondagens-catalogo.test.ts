import test from "node:test";
import assert from "node:assert/strict";
import { comSondagensDeCatalogoReutilizadas, ehSondagemDeCatalogo } from "./sondagens-catalogo.ts";
import type { DbExecutor } from "./contracts.ts";

const S062 = "SELECT to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS instalada";
const S094 = "SELECT to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok";
const S133 = "SELECT to_regprocedure('public.kidmais133_ocupacoes_escopo(date,date,uuid,uuid)') IS NOT NULL AS ok";
const SPRE = "SELECT to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL AS instalada";
const SDEV = "SELECT to_regclass('public.plataforma_desenvolvedores') IS NOT NULL AS instalada";

function bancoContado(falhar = new Set<string>()) {
  const idas: string[] = [];
  const banco: DbExecutor = {
    async query<Row extends object>(sql: string) {
      idas.push(sql);
      if (falhar.has(sql)) { falhar.delete(sql); throw new Error("falhou"); }
      return { rows: [{ instalada: true, ok: true, n: idas.length }] as unknown as Row[], rowCount: 1 };
    },
  };
  return { banco, idas };
}

test("F1: as sondagens que a Agenda repete são reconhecidas; consulta com dado, parâmetro ou duas sondagens não", () => {
  for (const sql of [S062, S094, S133, SPRE, SDEV]) assert.equal(ehSondagemDeCatalogo(sql), true, sql);
  assert.equal(ehSondagemDeCatalogo(S062, []), true);
  assert.equal(ehSondagemDeCatalogo(S062, ["x"]), false, "com parâmetro vai ao banco");
  for (const sql of [
    "SELECT id FROM empresas WHERE codigo = 'kidmais'",
    "SELECT codigo FROM public.empresas WHERE id = $1::uuid",
    "SELECT to_regclass('public.a') IS NOT NULL AND to_regclass('public.b') IS NOT NULL AS ok",
    "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes')) AS ok",
    "SELECT to_regprocedure('x'); DROP TABLE y; --') IS NOT NULL AS ok",
    `${S062} FOR UPDATE`,
  ]) assert.equal(ehSondagemDeCatalogo(sql), false, sql);
});

test("F1: na mesma requisição cada sondagem vai ao banco uma vez; o resto sempre vai", async () => {
  const { banco, idas } = bancoContado();
  const tx = comSondagensDeCatalogoReutilizadas(banco);
  const respostas: unknown[] = [];
  for (let i = 0; i < 7; i++) respostas.push(await tx.query(S062));
  await tx.query(S094); await tx.query(S094); await tx.query(S133); await tx.query(S133);
  await tx.query("SELECT codigo FROM public.empresas WHERE id = $1::uuid", ["a"]);
  await tx.query("SELECT codigo FROM public.empresas WHERE id = $1::uuid", ["a"]);
  await tx.query(S062, ["com parâmetro"]);
  assert.deepEqual(idas, [S062, S094, S133,
    "SELECT codigo FROM public.empresas WHERE id = $1::uuid", "SELECT codigo FROM public.empresas WHERE id = $1::uuid", S062]);
  assert.ok(respostas.every((r) => r === respostas[0]), "a mesma resposta para as 7 chamadas");
});

test("F1: chamadas simultâneas esperam a mesma ida; nada passa de uma requisição para outra", async () => {
  const { banco, idas } = bancoContado();
  const a = comSondagensDeCatalogoReutilizadas(banco);
  await Promise.all([a.query(S062), a.query(S062), a.query(S062)]);
  assert.equal(idas.length, 1);
  const b = comSondagensDeCatalogoReutilizadas(banco);
  await b.query(S062);
  assert.equal(idas.length, 2, "requisição nova sonda de novo (migration aplicada vale na próxima)");
});

test("F1: falha não fica guardada", async () => {
  const { banco, idas } = bancoContado(new Set([S062]));
  const tx = comSondagensDeCatalogoReutilizadas(banco);
  await assert.rejects(tx.query(S062), /falhou/);
  const r = await tx.query<{ instalada: boolean }>(S062);
  assert.equal(r.rows[0].instalada, true);
  assert.equal(idas.length, 2);
});

test("F1/F2: a rota da Agenda usa o executor só no GET e reaproveita escopo, unidades, dona e código da empresa", async () => {
  const { readFileSync } = await import("node:fs");
  const rota = readFileSync("app/api/admin/disponibilidade/route.ts", "utf8");
  const get = rota.slice(rota.indexOf("export async function GET"), rota.indexOf("export async function POST"));
  const post = rota.slice(rota.indexOf("export async function POST"));
  assert.match(get, /const tx = comSondagensDeCatalogoReutilizadas\(transacao\);/);
  assert.doesNotMatch(post, /comSondagensDeCatalogoReutilizadas/, "gravação não usa o executor de leitura");
  assert.match(get, /montarConfigAdmin\(tx, escopo, tenant\.empresaComprovada, \{ dona, porEscopo: lido\.porEscopo, unidades: lido\.unidades \}\)/);
  assert.match(get, /podeResolverLegado: lido\.porEscopo && await podeResolverBloqueioLegado/);
  assert.doesNotMatch(get, /agendaPorEscopoInstalada\(/);
  assert.equal((get.match(/ehDonaDaConfigLegada\(/g) ?? []).length, 1);
  assert.equal((rota.match(/SELECT codigo FROM/g) ?? []).length, 1, "código da empresa lido uma vez");
});
