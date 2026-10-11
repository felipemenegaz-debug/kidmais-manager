import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { lerEstadoComercial } from "../assinatura/estado.ts";
import { criarHashSenha } from "../autenticacao/senha.ts";
import { criarCategoriaBuffet, criarItemBuffet } from "./catalogo-buffet.ts";
import { escopoCotacaoPublica } from "./cotacao-publica.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";
import { definirCategoriasPacoteAdmin, definirDisponibilidadePacoteAdmin } from "./pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";

/**
 * F-L (docs/ATUALIZACAO_STAGING_20261011.md §12): o script REAL de fixtures (scripts/fixture-atualizacao-staging.cjs) no
 * PostgreSQL DESCARTÁVEL com o schema de staging (modelo "078": inventário inteiro até a 078) e os serviços de domínio reais.
 * O endereço público é o das ROTAS reais (/api/fechamentos/pacotes e /catalogo), carregadas com o banco descartável.
 *
 * Substituição de teste (única): o cliente recebe a trava do staging (conferida aqui) mas conversa com o banco descartável, e a
 * consulta de identidade responde a identidade do staging. A identidade real do staging é conferida pelo próprio script no
 * servidor (F3); aqui se prova o caminho de escrita: gatilhos, índices da 078, auditoria, elegibilidade e encerramento.
 */
const exigir = createRequire(import.meta.url);
type Fixture = { chave: string; empresa: string; usuario: string; codigo: string; nome: string; email: string; valor: string; dias: number[];
  composicao: Array<[string, string, number, string[]]> };
const script = exigir("../../scripts/fixture-atualizacao-staging.cjs") as {
  FIXTURES: Fixture[]; ARQUIVO: string;
  criar: (a: Record<string, unknown>) => Promise<Record<string, unknown> & { resultado: string; falha: { mensagem: string } | null }>;
  encerrar: (a: Record<string, unknown>) => Promise<{ resultado: string; encerramento: string; empresas: Array<{ codigo: string; status: string }> }>;
};
const { SQL_IDENTIDADE } = exigir("../../scripts/conexao-staging.cjs") as { SQL_IDENTIDADE: string };
const [A, B] = script.FIXTURES;
const IDS = script.FIXTURES.map((f) => f.empresa);

const ENV = {
  RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", ASAAS_AMBIENTE: "sandbox",
  DATABASE_SSL: "false", COTACAO_PUBLICA_POR_EMPRESA: "true",
  DATABASE_URL: "postgresql://sintetico:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91",
};
const servicos = { criarHashSenha, gravarFaixasPacote, definirDisponibilidadePacoteAdmin, criarCategoriaBuffet, criarItemBuffet, definirCategoriasPacoteAdmin };
const sem = () => {};

let client: Client;
let tx: DbExecutor;
let flagAnterior: string | undefined;
const alvos: string[] = [];
let dirRodada: string;
let outra: string;
let antesOutra: string;
let rotas: { pacotes: (url: string) => Promise<{ status: number; body: Record<string, unknown> }>; catalogo: (url: string) => Promise<{ status: number; body: Record<string, unknown> }> };

/** Cliente com a trava do staging: guarda o alvo pedido, delega ao descartável; só a identidade é a do staging. */
function ClienteStaging(this: unknown, opts: { connectionString: string }) { alvos.push(opts.connectionString); }
ClienteStaging.prototype.connect = async () => {};
ClienteStaging.prototype.end = async () => {};
ClienteStaging.prototype.query = async (t: string, v?: unknown[]) => t === SQL_IDENTIDADE
  ? { rows: [{ db: "kidmais_staging_1z91", tls: false, servidor_privado: true }], rowCount: 1 }
  : client.query(t, v);

/** fetch das conferências do script → rotas reais com o banco descartável (status e corpo). */
async function fetcher(url: string) {
  const u = new URL(url);
  const r = u.pathname.endsWith("/pacotes") ? await rotas.pacotes(url) : await rotas.catalogo(url);
  return { status: r.status, json: async () => r.body };
}
/** Impressão das linhas de OUTRA empresa (e do catálogo dela): igual antes e depois da rodada inteira. */
async function impressaoOutra() {
  const linhas = await client.query(`SELECT 'empresa' AS t, to_jsonb(e)::text AS l FROM empresas e WHERE id=$1::uuid
    UNION ALL SELECT 'pacote', to_jsonb(p)::text FROM pacotes p WHERE empresa_id=$1::uuid
    UNION ALL SELECT 'categoria', to_jsonb(c)::text FROM buffet_categorias c WHERE empresa_id=$1::uuid
    UNION ALL SELECT 'item', to_jsonb(i)::text FROM buffet_itens i WHERE empresa_id=$1::uuid
    UNION ALL SELECT 'kidmais', to_jsonb(k)::text FROM buffet_categorias k WHERE empresa_id=(SELECT id FROM empresas WHERE codigo='kidmais')
    ORDER BY 1, 2`, [outra]);
  return JSON.stringify(linhas.rows);
}

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
  // A rota lê a chave do processo (como no servidor): ligada só nesta suíte, restaurada ao final.
  flagAnterior = process.env.COTACAO_PUBLICA_POR_EMPRESA;
  process.env.COTACAO_PUBLICA_POR_EMPRESA = "true";
  const dubles: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "lib/db/postgres": { db: () => tx },
    "lib/http/limite-publico": { limitarPublico: () => null },
    "lib/http/api-response": { apiErrorResponse: (e: { httpStatus?: number; code?: string }) => ({ status: e?.httpStatus ?? 500, body: { codigo: e?.code ?? "ERRO" } }) },
  };
  const cache = new Map();
  // O carregador não resolve pasta (index.ts): o módulo real da pasta, com os mesmos dublês.
  dubles["lib/comercial/repositories"] = carregarModulo("lib/comercial/repositories/index.ts", dubles, cache);
  type Get = { GET: (r: unknown) => Promise<{ status: number; body: Record<string, unknown> }> };
  const pacotes = carregarModulo("app/api/fechamentos/pacotes/route.ts", dubles, cache) as Get;
  const catalogo = carregarModulo("app/api/fechamentos/catalogo/route.ts", dubles, cache) as Get;
  rotas = { pacotes: (url) => pacotes.GET({ nextUrl: new URL(url) }), catalogo: (url) => catalogo.GET({ nextUrl: new URL(url) }) };
});
test.after(async () => {
  if (flagAnterior === undefined) delete process.env.COTACAO_PUBLICA_POR_EMPRESA; else process.env.COTACAO_PUBLICA_POR_EMPRESA = flagAnterior;
  if (client) await encerrarDescartavel(client);
});

test("schema 078 e uma OUTRA empresa ativa com Pocket e catálogo próprio (a preservar)", async () => {
  const s = (await client.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL AS isencoes,
      to_regclass('public.empresa_regras_pagamento') IS NOT NULL AS regras,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='buffet_categorias' AND column_name='empresa_id') AS m078`)).rows[0];
  assert.deepEqual(s, { isencoes: true, regras: true, m078: true });
  outra = (await client.query(`INSERT INTO empresas (codigo, nome, status) VALUES ('outra-fl', 'Outra empresa F-L', 'PROVISIONAMENTO') RETURNING id::text AS id`)).rows[0].id;
  await client.query(`UPDATE empresas SET status='ATIVA' WHERE id=$1::uuid`, [outra]);
  await client.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
    VALUES ($1::uuid, 'POCKET', 'Pocket da outra', 1, true, true, 20, 30)`, [outra]);
  const cat = await criarCategoriaBuffet(tx, outra, "Salgados da outra", true, "SALGADOS");
  await criarItemBuffet(tx, outra, "Coxinha da outra", cat);
  antesOutra = await impressaoOutra();
});

test("criar: PASS no schema de staging — fixtures ATIVAS, isentas (COMPLETO), elegíveis para pedido; rotas reais conferidas", async () => {
  dirRodada = mkdtempSync(join(tmpdir(), "fixture-fl-"));
  const r = await script.criar({ env: ENV, Client: ClienteStaging, servicos, dir: dirRodada, disco: sem, fetcher });
  assert.equal(r.resultado, "PASS", JSON.stringify(r.falha));
  assert.ok(alvos.length >= 1 && alvos.every((a) => a.includes("dpg-daidko3m8hqs73ce4jt0-a") && a.includes("kidmais_staging_1z91")), "trava do staging aplicada");
  assert.equal(r.preservacao, "IGUAL");
  const publico = r.publico as Record<string, { dias: number[]; categorias: string[]; itens: number; preco: number }>;
  assert.deepEqual(publico.A.dias, A.dias); assert.deepEqual(publico.B.dias, B.dias);
  assert.equal(publico.A.preco, Number(A.valor)); assert.equal(publico.B.preco, Number(B.valor));
  for (const f of [A, B]) {
    assert.equal((await client.query(`SELECT status FROM empresas WHERE id=$1::uuid`, [f.empresa])).rows[0].status, "ATIVA");
    assert.equal((await lerEstadoComercial(tx, f.empresa)).acesso.nivel, "COMPLETO", `acesso ${f.chave}`);
    const escopo = await escopoCotacaoPublica(() => tx, f.codigo, { escrita: true }, { COTACAO_PUBLICA_POR_EMPRESA: "true" });
    assert.equal(escopo.empresaId, f.empresa, `pedido permitido em ${f.chave}`);
  }
});

test("catálogo por empresa (078): mesma categoria SALGADOS em A, B e na outra, sem cruzar itens", async () => {
  const sal = (await client.query(`SELECT empresa_id::text AS e, id::text AS id FROM buffet_categorias WHERE codigo='SALGADOS' AND empresa_id = ANY($1::uuid[])`,
    [[...IDS, outra]])).rows;
  assert.equal(new Set(sal.map((x) => x.e)).size, 3); assert.equal(new Set(sal.map((x) => x.id)).size, 3);
  for (const f of [A, B]) {
    const res = await rotas.catalogo(`http://localhost/api/fechamentos/catalogo?pacote=POCKET&empresa=${f.codigo}`);
    assert.equal(res.status, 200);
    const nomes = (res.body.categorias as Array<{ itens: Array<{ nome: string }> }>).flatMap((c) => c.itens.map((i) => i.nome)).sort();
    assert.deepEqual(nomes, f.composicao.flatMap(([, , , itens]) => itens).sort(), `só os itens de ${f.chave}`);
  }
  const misturados = (await client.query(`SELECT count(*)::int AS n FROM pacote_buffet_categorias r JOIN pacotes p ON p.id=r.pacote_id
    JOIN buffet_categorias c ON c.id=r.categoria_id WHERE p.empresa_id = ANY($1::uuid[]) AND c.empresa_id <> p.empresa_id`, [IDS])).rows[0].n;
  assert.equal(misturados, 0);
});

test("repetição recusada sem efeito: fixture preexistente → FALHA no precheck, nada criado nem desativado", async () => {
  const r = await script.criar({ env: ENV, Client: ClienteStaging, servicos, dir: mkdtempSync(join(tmpdir(), "fixture-fl-")), disco: sem, fetcher });
  assert.equal(r.resultado, "FALHA"); assert.match(r.falha!.mensagem, /FIXTURE_PREEXISTENTE_S1/);
  assert.equal(r.encerramento, "NADA_CRIADO_PELA_RODADA");
  const status = (await client.query(`SELECT status FROM empresas WHERE id = ANY($1::uuid[])`, [IDS])).rows.map((x) => x.status);
  assert.deepEqual(status, ["ATIVA", "ATIVA"], "a rodada original continua ativa");
});

test("encerrar: só desativa (empresa, vínculo, usuário); endereço público volta a 404; outra empresa e Kidmais intactas", async () => {
  const r = await script.encerrar({ env: ENV, Client: ClienteStaging, dir: dirRodada, disco: sem });
  assert.equal(r.resultado, "ENCERRADO"); assert.equal(r.encerramento, "DESATIVADAS");
  assert.deepEqual(r.empresas.map((e) => e.status), ["DESATIVADA", "DESATIVADA"]);
  const v = (await client.query(`SELECT
      (SELECT count(*) FROM memberships WHERE empresa_id = ANY($1::uuid[]) AND status <> 'REVOGADA')::int AS vinculos,
      (SELECT count(*) FROM usuarios_administrativos WHERE id = ANY($2::uuid[]) AND ativo)::int AS usuarios,
      (SELECT count(*) FROM pacotes WHERE empresa_id = ANY($1::uuid[]))::int AS pacotes`, [IDS, script.FIXTURES.map((f) => f.usuario)])).rows[0];
  assert.deepEqual(v, { vinculos: 0, usuarios: 0, pacotes: 2 }, "desativa; nada apagado");
  for (const f of [A, B]) assert.equal((await rotas.pacotes(`http://localhost/api/fechamentos/pacotes?empresa=${f.codigo}`)).status, 404);
  assert.equal(await impressaoOutra(), antesOutra);
});
