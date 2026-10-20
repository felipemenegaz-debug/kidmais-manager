import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { lerEstadoComercial } from "./estado.ts";
import { decidirPaywall } from "./paywall.ts";
import { consultarOfertas, prepararOferta } from "./ofertas.ts";
import { recursoIncluido } from "./recursos-plano.ts";
import { exigirVaga, planoConfirmado } from "./limites-usuarios.ts";
import { createRequire } from "node:module";

const { conferirKidmais } = createRequire(import.meta.url)("../../scripts/assinatura-reconciliar.cjs") as { conferirKidmais: (c: unknown) => Promise<{ violada: boolean; empresas: number; assinaturas: number }> };

/**
 * Gratuidade da Kidmais com as chaves de PRODUÇÃO ligadas (PostgreSQL descartável, modelo "079" = schema vigente):
 * a empresa `kidmais` (criada pela 046), sem linha em empresa_assinaturas, tem acesso COMPLETO sem cobrança, nenhuma oferta,
 * nenhum checkout, todos os recursos de plano e vagas ilimitadas. Controle negativo: uma empresa com teste vencido é
 * restringida (o teste falharia se a regra não existisse). E o único INSERT de assinatura do produto é o do cadastro.
 */
const PRODUCAO = { ASSINATURA_PLANOS_ATIVOS: "true", ASAAS_AMBIENTE: "producao", KIDMAIS_DEPLOY_ENV: "production" };
let client: Client;
let tx: DbExecutor;
let kidmais: string;

const codigo = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? "ERRO"; } };

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("a Kidmais existe (046), única, e não tem situação comercial registrada", async () => {
  const k = (await client.query<{ id: string; n: number }>(
    `SELECT min(id::text) AS id, count(*)::int AS n FROM empresas WHERE codigo = 'kidmais'`)).rows[0];
  assert.equal(k.n, 1);
  kidmais = k.id;
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid AND status <> 'ATIVA'`, [kidmais]);
  const linhas = (await client.query(`SELECT
      (SELECT count(*) FROM empresa_assinaturas WHERE empresa_id = $1::uuid)::int AS assinatura,
      (SELECT count(*) FROM assinatura_contratacoes WHERE empresa_id = $1::uuid)::int AS contratacao,
      (SELECT count(*) FROM assinatura_fundadores WHERE empresa_id = $1::uuid)::int AS fundador`, [kidmais])).rows[0];
  assert.deepEqual(linhas, { assinatura: 0, contratacao: 0, fundador: 0 });
});

test("com as chaves de produção: acesso COMPLETO sem cobrança, nenhuma oferta, checkout recusado, recursos e vagas sem limite", async () => {
  const estado = await lerEstadoComercial(tx, kidmais);
  assert.equal(estado.acesso.nivel, "COMPLETO");
  for (const [metodo, caminho] of [["GET", "/api/admin/festas"], ["POST", "/api/admin/clientes"], ["POST", "/api/admin/financeiro/contas-pagar"]] as const)
    assert.equal(decidirPaywall(estado.acesso, metodo, caminho).permitido, true, `${metodo} ${caminho}`);
  const ofertas = await consultarOfertas(tx, kidmais, PRODUCAO);
  assert.equal(ofertas?.habilitado, false, "nenhuma oferta de plano para a Kidmais");
  await client.query("BEGIN");
  try {
    assert.equal(await codigo(prepararOferta(tx, kidmais, "00000000-0000-0000-0000-000000000000",
      { plano: "essencial", ciclo: "MENSAL", valorEsperadoCentavos: 19700 } as never)), "EMPRESA_SEM_COBRANCA");
  } finally { await client.query("ROLLBACK"); }
  assert.equal(await planoConfirmado(tx, kidmais), null);
  for (const recurso of ["FINANCEIRO_COMPLETO", "ORCAMENTO_ONLINE"] as const) assert.equal(await recursoIncluido(tx, kidmais, recurso), true, recurso);
  assert.equal(await codigo(exigirVaga(tx, kidmais, 1)), "OK", "vagas ilimitadas");
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM empresa_assinaturas WHERE empresa_id = $1::uuid`, [kidmais])).rows[0].n, 0, "nada criado");
});

test("controle negativo: empresa com teste vencido é restringida (a regra existe e é exercida)", async () => {
  const outra = (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ('gratuidade-controle', 'Controle gratuidade', 'PROVISIONAMENTO') RETURNING id::text AS id`)).rows[0].id;
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [outra]);
  await client.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste)
    VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '100 days', clock_timestamp() - interval '85 days', '81467890000163')`, [outra]);
  const estado = await lerEstadoComercial(tx, outra);
  assert.notEqual(estado.acesso.nivel, "COMPLETO");
  assert.equal(decidirPaywall(estado.acesso, "POST", "/api/admin/clientes").permitido, false);
});

test("o produto só cria assinatura no cadastro público (iniciarTeste), nunca para empresa existente", () => {
  const raiz = process.cwd();
  const arquivos: string[] = [];
  const varrer = (dir: string) => { for (const e of readdirSync(join(raiz, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) varrer(p); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) arquivos.push(p);
  } };
  for (const dir of ["lib", "app"]) varrer(dir);
  const insercoes = arquivos.filter((f) => /INSERT INTO empresa_assinaturas/.test(readFileSync(join(raiz, f), "utf8")));
  assert.deepEqual(insercoes, ["lib/assinatura/servico.ts"]);
  const chamadas = arquivos.filter((f) => /\biniciarTeste\(/.test(readFileSync(join(raiz, f), "utf8")) && f !== "lib/assinatura/servico.ts");
  assert.deepEqual(chamadas, ["lib/cadastro/publico.ts"]);
});

test("conferência diária (scripts/assinatura-reconciliar.cjs): SQL real aprova a Kidmais e reprova uma assinatura criada para ela", async () => {
  const atual = await conferirKidmais(client);
  assert.equal(atual.violada, false);
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste)
      VALUES ($1::uuid, 'TESTE', clock_timestamp(), clock_timestamp() + interval '15 days', '81578901000107')`, [kidmais]);
    const violada = await conferirKidmais(client);
    assert.equal(violada.violada, true); assert.equal(violada.assinaturas, 1);
  } finally { await client.query("ROLLBACK"); }
  assert.equal((await conferirKidmais(client)).violada, false, "nada ficou gravado");
});
