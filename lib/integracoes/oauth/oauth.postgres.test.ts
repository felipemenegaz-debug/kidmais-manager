import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { executarNoTenant } from "../../saas/provar-tenant.ts";
import { concessaoVigentePostgres, criarRepositorioOAuthPostgres, SchemaMcpAusente } from "./postgres.ts";
import { hashSegredo, novoSegredo } from "./repositorio.ts";

/**
 * A5 (persistência e concorrência REAIS) — cluster postgres-descartavel, estado "105" (e "103" para schema ausente).
 * PREPARADA EM 27/10/2026 E NÃO EXECUTADA: exige autorização específica para o cluster descartável (docs/OPERACAO_AGENTES.md).
 * Roteiro: docs/MCP_ASSINATURAS_TESTES.md. O banco de trabalho é restaurado do modelo a cada suíte: aqui há COMMIT de verdade,
 * porque concorrência só se prova com duas conexões e espera observada no servidor (pg_blocking_pids), nunca com sleeps.
 */
const raiz = join(import.meta.dirname, "..", "..", "..");
const codigo = () => `mcp${randomBytes(4).toString("hex")}`;

function executor(db: Client): DbExecutor {
  return { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await db.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
}

async function transacao<T>(db: Client, work: (tx: DbExecutor) => Promise<T>) {
  await db.query("BEGIN");
  try {
    const r = await work(executor(db));
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

async function instalada(db: Client) {
  return (await db.query<{ ok: boolean }>(`SELECT to_regclass('public.mcp_oauth_concessoes') IS NOT NULL AS ok`)).rows[0].ok;
}

async function semear(db: Client) {
  const empresa = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'MCP teste', 'PROVISIONAMENTO') RETURNING id::text`, [codigo()])).rows[0].id;
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
  const usuario = (await db.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'MCP teste', $2, 'ADMINISTRATIVO', true) RETURNING id::text`,
    [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`])).rows[0].id;
  const m = (await db.query<{ id: string }>(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id::text`, [empresa, usuario])).rows[0].id;
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return { empresa, usuario };
}

const CLIENTE = { clientId: "https://chatgpt.com/oauth/client.json", nome: "ChatGPT", redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], validoAte: new Date(Date.now() + 3_600_000) };
const RECURSO = "https://manager.example.test/api/mcp";
const CHALLENGE = "A".repeat(43);

test("schema ausente (estado 103): toda operação vira SchemaMcpAusente, sem DDL", async () => {
  const db = await conectarDescartavel();
  try {
    if (await instalada(db)) return; // estado 105: coberto pelos demais testes
    const repo = criarRepositorioOAuthPostgres(() => executor(db), (w) => transacao(db, w));
    await assert.rejects(repo.verificarAcesso(hashSegredo(novoSegredo("kma"))), SchemaMcpAusente);
    await assert.rejects(repo.auditar({ evento: "FERRAMENTA", resultado: "OK", codigo: "OK" }), SchemaMcpAusente);
    assert.equal(await instalada(db), false, "nada foi criado");
  } finally {
    await encerrarDescartavel(db);
  }
});

test("105: postcheck passa, gatilho impede reativar concessão revogada", async (t) => {
  const db = await conectarDescartavel();
  try {
    if (!(await instalada(db))) return t.skip("estado sem 105");
    await db.query(readFileSync(join(raiz, "database", "checks", "20261027_105_postcheck.sql"), "utf8"));
    const s = await semear(db);
    const repo = criarRepositorioOAuthPostgres(() => executor(db), (w) => transacao(db, w));
    await repo.guardarCliente(CLIENTE);
    const id = await repo.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    assert.equal(await repo.revogarConcessao(id, "USUARIO", s.usuario), true);
    await assert.rejects(db.query(`UPDATE mcp_oauth_concessoes SET revogada_em = NULL, motivo_revogacao = NULL WHERE id = $1`, [id]), (e: { code?: string }) => e.code === "23514");
    await assert.rejects(db.query(`UPDATE mcp_oauth_concessoes SET empresa_id = gen_random_uuid() WHERE id = $1`, [id]));
  } finally {
    await encerrarDescartavel(db, true);
  }
});

test("105: código, pedido e refresh têm um único vencedor entre duas conexões; revogação vale para outra conexão", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const s = await semear(d1);
    const r1 = criarRepositorioOAuthPostgres(() => executor(d1), (w) => transacao(d1, w));
    const r2 = criarRepositorioOAuthPostgres(() => executor(d2), (w) => transacao(d2, w));
    await r1.guardarCliente(CLIENTE);
    const codigoHash = hashSegredo(novoSegredo("kmc"));
    const id = await r1.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read", "financeiro:read"], recurso: RECURSO }, codigoHash, new Date(Date.now() + 60_000), CHALLENGE);
    assert.deepEqual((await Promise.all([r1.consumirCodigo(codigoHash), r2.consumirCodigo(codigoHash)])).filter(Boolean).length, 1, "código: um vencedor");
    const chave = hashSegredo(novoSegredo("kmp"));
    assert.equal(await r1.criarPedidoNoTeto(chave, { clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], state: null, codeChallenge: CHALLENGE, escopos: ["agenda:read"], recurso: RECURSO, expiraEm: new Date(Date.now() + 300_000) }, 5000), true);
    assert.equal((await Promise.all([r1.consumirPedido(chave), r2.consumirPedido(chave)])).filter(Boolean).length, 1, "pedido: um vencedor");
    const acesso = novoSegredo("kma");
    const atualizacao = novoSegredo("kmr");
    await r1.salvarTokens(id, ["agenda:read", "financeiro:read"], { hash: hashSegredo(acesso), expiraEm: new Date(Date.now() + 3_600_000) }, { hash: hashSegredo(atualizacao), expiraEm: new Date(Date.now() + 86_400_000) });
    const g = await r2.lerAtualizacao(hashSegredo(atualizacao));
    assert.ok(g && !g.revogado);
    assert.equal((await Promise.all([r1.revogarAtualizacao(g!.tokenId), r2.revogarAtualizacao(g!.tokenId)])).filter(Boolean).length, 1, "refresh: um vencedor");
    assert.equal((await r2.lerAtualizacao(hashSegredo(atualizacao)))?.revogado, true, "girado aparece como reuso");
    assert.ok(await r2.verificarAcesso(hashSegredo(acesso)), "outra conexão vê o acesso");
    assert.equal(await r1.revogarConcessao(id, "USUARIO", s.usuario), true);
    assert.equal(await r2.verificarAcesso(hashSegredo(acesso)), null, "revogação persistida vale para outra conexão (multi-instância)");
    await d1.query(`UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() WHERE id = $1`, [s.usuario]);
    const id2 = await r1.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    const ac2 = novoSegredo("kma");
    await r1.salvarTokens(id2, ["agenda:read"], { hash: hashSegredo(ac2), expiraEm: new Date(Date.now() + 3_600_000) }, null);
    assert.ok(await r2.verificarAcesso(hashSegredo(ac2)));
    await d1.query(`UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() WHERE id = $1`, [s.usuario]);
    assert.equal(await r2.verificarAcesso(hashSegredo(ac2)), null, "troca de senha posterior invalida a concessão");
    const ativas = (await d1.query(`SELECT count(*)::int AS n FROM mcp_oauth_concessoes WHERE usuario_id = $1 AND revogada_em IS NULL`, [s.usuario])).rows[0].n;
    assert.equal(ativas, 1, "uma concessão ativa por usuário+empresa+cliente");
  } finally {
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});

test("105: ferramenta em curso (FOR SHARE na concessão) faz a revogação ESPERAR até o commit (pg_blocking_pids)", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const s = await semear(d1);
    const r1 = criarRepositorioOAuthPostgres(() => executor(d1), (w) => transacao(d1, w));
    await r1.guardarCliente(CLIENTE);
    const id = await r1.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    const pid2 = (await d2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await d1.query("BEGIN");
    const principal = { concessaoId: id, usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, escopos: ["agenda:read" as const], papel: "ADMINISTRATIVO" };
    // Mesmo caminho da ferramenta: tenant comprovado + concessão vigente em FOR SHARE dentro da transação.
    await executarNoTenant(executor(d1), { usuario_id: s.usuario, papel: "ADMINISTRATIVO" }, s.empresa, async (tx) => assert.equal(await concessaoVigentePostgres(tx, principal), true));
    const r2 = criarRepositorioOAuthPostgres(() => executor(d2), (w) => transacao(d2, w));
    const revogacao = r2.revogarConcessao(id, "USUARIO", s.usuario);
    let bloqueada = false;
    for (let i = 0; i < 100 && !bloqueada; i += 1) {
      const r = await obs.query<{ n: number }>(`SELECT cardinality(pg_blocking_pids($1))::int AS n`, [pid2]);
      bloqueada = r.rows[0].n > 0;
      if (!bloqueada) await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.equal(bloqueada, true, "revogação esperou a transação da ferramenta");
    await d1.query("COMMIT");
    assert.equal(await revogacao, true);
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});

test("105 (revisão P2-6): espera por trava no Tenant Context termina pelo lock_timeout da transação da ferramenta", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const s = await semear(d1);
    // Outra transação segura a linha da empresa (FOR UPDATE), como uma operação administrativa longa.
    await d2.query("BEGIN");
    await d2.query("SELECT id FROM empresas WHERE id = $1 FOR UPDATE", [s.empresa]);
    const inicio = Date.now();
    await d1.query("BEGIN");
    await d1.query("SET LOCAL statement_timeout = '4500ms'");
    await d1.query("SET LOCAL lock_timeout = '2000ms'");
    await assert.rejects(
      executarNoTenant(executor(d1), { usuario_id: s.usuario, papel: "ADMINISTRATIVO" }, s.empresa, async () => "nunca"),
      (e: { code?: string }) => e.code === "55P03",
    );
    const decorrido = Date.now() - inicio;
    assert.ok(decorrido < 4000, `terminou pelo lock_timeout (${decorrido} ms)`);
    await d1.query("ROLLBACK");
    await d2.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});

// ---------------------------------------------------------------- rodada 2 da revisão (achados 2, 3 e 4) — NÃO EXECUTADOS

test("105 (rodada 2, achado 2): admissão de pedido é serializada por cliente entre conexões; o teto nunca é ultrapassado", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const r1 = criarRepositorioOAuthPostgres(() => executor(d1), (w) => transacao(d1, w));
    const r2 = criarRepositorioOAuthPostgres(() => executor(d2), (w) => transacao(d2, w));
    await r1.guardarCliente(CLIENTE);
    const pedido = () => ({ clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], state: null, codeChallenge: CHALLENGE, escopos: ["agenda:read" as const], recurso: RECURSO, expiraEm: new Date(Date.now() + 300_000) });
    const pid2 = (await d2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // d1 simula uma admissão em curso: trava o cliente, grava o último pedido permitido e ainda não deu COMMIT.
    await d1.query("BEGIN");
    await d1.query("SELECT 1 FROM mcp_oauth_clientes WHERE client_id = $1 FOR NO KEY UPDATE", [CLIENTE.clientId]);
    const p = pedido();
    await d1.query(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, expira_em) VALUES ($1, $2, 'ChatGPT', $3, $4, $5::text[], $6, $7)`,
      [hashSegredo(novoSegredo("kmp")), p.clientId, p.redirectUri, p.codeChallenge, p.escopos, p.recurso, p.expiraEm]);
    const concorrente = r2.criarPedidoNoTeto(hashSegredo(novoSegredo("kmp")), pedido(), 1);
    let bloqueada = false;
    for (let i = 0; i < 100 && !bloqueada; i += 1) {
      bloqueada = (await obs.query<{ n: number }>(`SELECT cardinality(pg_blocking_pids($1))::int AS n`, [pid2])).rows[0].n > 0;
      if (!bloqueada) await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.equal(bloqueada, true, "a segunda admissão esperou a primeira");
    await d1.query("COMMIT");
    assert.equal(await concorrente, false, "depois do COMMIT ela vê o teto e não grava");
    const n = (await d1.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_pedidos WHERE client_id = $1 AND consumido_em IS NULL`, [CLIENTE.clientId])).rows[0].n;
    assert.equal(n, 1, "teto respeitado entre conexões");
    // FK de outras tabelas não fica bloqueada pela trava de admissão (NO KEY UPDATE × KEY SHARE).
    await d1.query("BEGIN");
    await d1.query("SELECT 1 FROM mcp_oauth_clientes WHERE client_id = $1 FOR NO KEY UPDATE", [CLIENTE.clientId]);
    const s = await semear(d2);
    await r2.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    await d1.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});

test("105 (rodada 2, achados 3 e 4): retenção na gravação, teto duro de emissões e refresh girado vencido ainda detectável", async (t) => {
  const db = await conectarDescartavel();
  try {
    if (!(await instalada(db))) return t.skip("estado sem 105");
    const s = await semear(db);
    const repo = criarRepositorioOAuthPostgres(() => executor(db), (w) => transacao(db, w));
    await repo.guardarCliente(CLIENTE);
    const id = await repo.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    const par = () => ({ acesso: { hash: hashSegredo(novoSegredo("kma")), expiraEm: new Date(Date.now() + 3_600_000) }, refresh: novoSegredo("kmr") });
    const girados: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const p = par();
      await repo.salvarTokens(id, ["agenda:read"], p.acesso, { hash: hashSegredo(p.refresh), expiraEm: new Date(Date.now() + 86_400_000) });
      const g = await repo.lerAtualizacao(hashSegredo(p.refresh));
      assert.equal(await repo.revogarAtualizacao(g!.tokenId), true);
      girados.push(p.refresh);
    }
    await repo.salvarTokens(id, ["agenda:read"], par().acesso, null); // a poda roda na gravação
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE concessao_id = $1 AND tipo = 'ATUALIZACAO' AND revogado_em IS NOT NULL`, [id])).rows[0].n;
    assert.equal(n, 20, "só os últimos 20 girados ficam");
    assert.equal(await repo.lerAtualizacao(hashSegredo(girados[0])), null, "fora da janela de detecção");
    assert.equal((await repo.lerAtualizacao(hashSegredo(girados[24])))?.revogado, true, "dentro da janela: reuso");

    // Girado e VENCIDO continua detectável (achado 4).
    const velho = novoSegredo("kmr");
    await db.query(`INSERT INTO mcp_oauth_tokens (concessao_id, tipo, token_hash, escopos, criado_em, expira_em, revogado_em)
                    VALUES ($1, 'ATUALIZACAO', $2, ARRAY['agenda:read'], clock_timestamp() - interval '3 days', clock_timestamp() - interval '1 day', clock_timestamp() - interval '2 days')`, [id, hashSegredo(velho)]);
    assert.equal((await repo.lerAtualizacao(hashSegredo(velho)))?.revogado, true, "girado vencido ainda é reuso");
    const naoGirado = novoSegredo("kmr");
    await db.query(`INSERT INTO mcp_oauth_tokens (concessao_id, tipo, token_hash, escopos, criado_em, expira_em)
                    VALUES ($1, 'ATUALIZACAO', $2, ARRAY['agenda:read'], clock_timestamp() - interval '3 days', clock_timestamp() - interval '1 day')`, [id, hashSegredo(naoGirado)]);
    assert.equal(await repo.lerAtualizacao(hashSegredo(naoGirado)), null, "vencido nunca girado: só inválido");

    // Teto duro de emissões por concessão por hora.
    const recentes = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE concessao_id = $1 AND tipo = 'ACESSO' AND criado_em > clock_timestamp() - interval '1 hour'`, [id])).rows[0].n;
    for (let i = recentes; i < 60; i += 1) await repo.salvarTokens(id, ["agenda:read"], par().acesso, null);
    await assert.rejects(repo.salvarTokens(id, ["agenda:read"], par().acesso, null), (e: { name?: string }) => e.name === "temporarily_unavailable");
    assert.equal(await repo.emissoesRecentes(id), 60);
  } finally {
    await encerrarDescartavel(db, true);
  }
});

test("105 (rodada 2, achados 3 e 4): expurgo drena em lotes e preserva a evidência de reuso da concessão ativa", async (t) => {
  const db = await conectarDescartavel();
  try {
    if (!(await instalada(db))) return t.skip("estado sem 105");
    const s = await semear(db);
    const repo = criarRepositorioOAuthPostgres(() => executor(db), (w) => transacao(db, w));
    await repo.guardarCliente(CLIENTE);
    await db.query(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, criado_em, expira_em)
                    SELECT encode(sha256(g::text::bytea), 'hex'), $1, 'ChatGPT', $2, $3, ARRAY['agenda:read'], $4, clock_timestamp() - interval '3 hours', clock_timestamp() - interval '2 hours 55 minutes'
                      FROM generate_series(1, 1200) g`, [CLIENTE.clientId, CLIENTE.redirectUris[0], CHALLENGE, RECURSO]);
    const codigoUsado = hashSegredo(novoSegredo("kmc"));
    const ativa = await repo.criarConcessaoComCodigo({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read"], recurso: RECURSO }, codigoUsado, new Date(Date.now() + 60_000), CHALLENGE);
    assert.equal(await repo.consumirCodigo(codigoUsado), true);
    await db.query(`UPDATE mcp_oauth_codigos SET criado_em = clock_timestamp() - interval '3 hours', expira_em = clock_timestamp() - interval '2 hours 55 minutes' WHERE codigo_hash = $1`, [codigoUsado]);
    const r = await repo.expurgarExpirados();
    assert.equal(r.pedidos, 1200, "drenou além de um lote");
    assert.equal(r.completo, true);
    assert.ok(r.lotes >= 3);
    const lido = await repo.lerCodigo(codigoUsado);
    assert.equal(lido?.usado, true, "código usado de concessão ativa fica (reapresentação ainda revoga)");
    assert.equal(lido?.concessaoId, ativa);
  } finally {
    await encerrarDescartavel(db, true);
  }
});

// ---------------------------------------------------------------- rodada 3 da revisão (achados 1 e 2) — NÃO EXECUTADOS

test("105 (rodada 3, achado 2): renovação × reconexão seguem a mesma ordem de travas (concessão antes de tokens): sem deadlock", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const s = await semear(d1);
    const r1 = criarRepositorioOAuthPostgres(() => executor(d1), (w) => transacao(d1, w));
    const r2 = criarRepositorioOAuthPostgres(() => executor(d2), (w) => transacao(d2, w));
    await r1.guardarCliente(CLIENTE);
    const nova = () => ({ usuarioId: s.usuario, empresaId: s.empresa, clientId: CLIENTE.clientId, clienteNome: "ChatGPT", redirectUri: CLIENTE.redirectUris[0], escopos: ["agenda:read" as const], recurso: RECURSO });
    const id = await r1.criarConcessaoComCodigo(nova(), hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    // Acesso antigo VENCIDO (candidato à poda de salvarTokens) e ainda não revogado (alvo do UPDATE da reconexão).
    await d1.query(`INSERT INTO mcp_oauth_tokens (concessao_id, tipo, token_hash, escopos, criado_em, expira_em)
                    VALUES ($1, 'ACESSO', $2, ARRAY['agenda:read'], clock_timestamp() - interval '3 hours', clock_timestamp() - interval '2 hours')`, [id, hashSegredo(novoSegredo("kma"))]);
    const pid2 = (await d2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // d1 reproduz salvarTokens até a trava da concessão e para antes da poda.
    await d1.query("BEGIN");
    await d1.query("SELECT 1 FROM mcp_oauth_concessoes WHERE id = $1 FOR NO KEY UPDATE", [id]);
    const reconexao = r2.criarConcessaoComCodigo(nova(), hashSegredo(novoSegredo("kmc")), new Date(Date.now() + 60_000), CHALLENGE);
    let bloqueada = false;
    for (let i = 0; i < 100 && !bloqueada; i += 1) {
      bloqueada = (await obs.query<{ n: number }>(`SELECT cardinality(pg_blocking_pids($1))::int AS n`, [pid2])).rows[0].n > 0;
      if (!bloqueada) await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.equal(bloqueada, true, "a reconexão espera na CONCESSÃO");
    const travasDeToken = (await obs.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = $1 AND c.relname = 'mcp_oauth_tokens'`, [pid2])).rows[0].n;
    assert.equal(travasDeToken, 0, "e ainda não tocou em tokens");
    await d1.query("SET LOCAL lock_timeout = '2000ms'");
    await d1.query(`DELETE FROM mcp_oauth_tokens WHERE concessao_id = $1 AND tipo = 'ACESSO' AND expira_em < clock_timestamp()`, [id]); // a poda não espera
    await d1.query("COMMIT");
    assert.ok(await reconexao, "a reconexão termina depois, sem deadlock (40P01)");
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});

test("105 (rodada 3, achado 1): expurgo pula linha travada (SKIP LOCKED) e não espera", async (t) => {
  const d1 = await conectarDescartavel();
  const d2 = await conectarDescartavel({ travar: false });
  try {
    if (!(await instalada(d1))) return t.skip("estado sem 105");
    const r2 = criarRepositorioOAuthPostgres(() => executor(d2), (w) => transacao(d2, w));
    await r2.guardarCliente(CLIENTE);
    await d2.query(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, criado_em, expira_em)
                    SELECT encode(sha256(('r3-' || g)::bytea), 'hex'), $1, 'ChatGPT', $2, $3, ARRAY['agenda:read'], $4, clock_timestamp() - interval '3 hours', clock_timestamp() - interval '2 hours 55 minutes'
                      FROM generate_series(1, 2) g`, [CLIENTE.clientId, CLIENTE.redirectUris[0], CHALLENGE, RECURSO]);
    await d1.query("BEGIN");
    await d1.query(`SELECT 1 FROM mcp_oauth_pedidos WHERE chave_hash = encode(sha256('r3-1'::bytea), 'hex') FOR UPDATE`);
    const inicio = Date.now();
    const r = await r2.expurgarExpirados();
    assert.ok(Date.now() - inicio < 1500, "não esperou a linha travada");
    assert.ok(r.pedidos >= 1, "apagou a livre");
    const resta = (await d2.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_pedidos WHERE chave_hash = encode(sha256('r3-1'::bytea), 'hex')`)).rows[0].n;
    assert.equal(resta, 1, "pulou a travada");
    await d1.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(d2, false);
    await encerrarDescartavel(d1, true);
  }
});
