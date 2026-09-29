import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration = readFileSync(resolve(root, "database/migrations/20260927_052_financeiro_gerencial.sql"), "utf8");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};

type Tenant = { empresaComprovada: string; membershipId: string; usuarioId: string };
type Executor = { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> };
const { baixarRecebimentoNoTenant } = exigir(resolve(root, "lib/financeiro/baixa.ts")) as {
  baixarRecebimentoNoTenant: (
    tx: Executor,
    tenant: Tenant,
    input: { parcelaId: string; valor: number; data: string; forma: "PIX"; chave: string },
    context: { token: string; usuarioId: string; origem: string; requestId: string },
  ) => Promise<unknown>;
};
const { withTenantTransaction } = exigir(resolve(root, "lib/saas/provar-tenant.ts")) as {
  withTenantTransaction: <T>(
    sessao: { usuario_id: string; papel: string },
    empresa: string | null,
    work: (tx: Executor, tenant: Tenant) => Promise<T>,
  ) => Promise<T>;
};

type Corpo = { ok: boolean; data?: { reutilizado: boolean; liquidoCentavos: number }; erro?: string; codigo?: string };
type Resposta = { status: number; json: () => Promise<Corpo> };
type Rota = { POST: (request: unknown) => Promise<Resposta> };

function recusaTenant(error: unknown) {
  if (!(error instanceof Error) || error.name !== "PacoteAdminError") return false;
  return (error as { httpStatus?: number }).httpStatus === 403;
}

function codigo() {
  return `baixa${randomBytes(3).toString("hex")}`;
}

function instalarPool(db: Client) {
  const troca: Record<string, string> = {
    BEGIN: "SAVEPOINT operacao",
    COMMIT: "RELEASE SAVEPOINT operacao",
    ROLLBACK: "ROLLBACK TO SAVEPOINT operacao",
  };
  (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
    query: (sql: string, values?: unknown[]) => db.query(sql, values),
    connect: async () => ({
      query: (sql: string, values?: unknown[]) => db.query(troca[sql] ?? sql, values),
      release() {},
    }),
  };
}

function pedido(token: string | null, csrf: string, body: unknown) {
  const { NextRequest } = exigir("next/server") as { NextRequest: new (url: string, init: { method: string; headers: Headers; body: string }) => unknown };
  const headers = new Headers({
    origin: "http://localhost:3000",
    host: "localhost:3000",
    "content-type": "application/json",
    "x-csrf-token": csrf,
  });
  if (token) headers.set("cookie", `kidmais_admin_dev=${token}`);
  return new NextRequest("http://localhost:3000/api/admin/financeiro/contas-receber", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function empresa(db: Client, nome: string) {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo(), nome],
  )).rows[0].id;
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function usuario(db: Client) {
  return (await db.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
     VALUES ($1, 'Baixa teste', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`],
  )).rows[0].id;
}

async function membership(db: Client, empresaId: string, usuarioId: string) {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
}

async function sessao(db: Client, usuarioId: string) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`,
    [usuarioId, hashToken(token), hashToken(csrf)],
  );
  return { token, csrf };
}

test("a rota de baixa usa o token e confirma auditoria na mesma transação", { timeout: 120_000 }, async () => {
  const anterior = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN,
    RENDER: process.env.RENDER,
    KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
  };
  const ambiente = process.env as { NODE_ENV?: string };
  ambiente.NODE_ENV = "test";
  process.env.ADMIN_AUTH_ORIGIN = "http://localhost:3000";
  delete process.env.RENDER;
  delete process.env.KIDMAIS_DEPLOY_ENV;
  let conexao: Client | undefined;
  try {
    const client = await conectarDescartavel();
    const db = client as unknown as Client;
    conexao = db;
    await db.query(migration);
    await db.query("BEGIN");
    const empresaA = await empresa(db, "Empresa baixa A");
    const empresaB = await empresa(db, "Empresa baixa B");
    const usuarioA = await usuario(db);
    const usuarioB = await usuario(db);
    await membership(db, empresaA, usuarioA);
    await membership(db, empresaB, usuarioB);
    const acessoA = await sessao(db, usuarioA);
    const acessoB = await sessao(db, usuarioB);
    const pacote = (await db.query<{ id: string }>(
      `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
       VALUES ($1::uuid, $2, 'Festa Completa', 1, true, true) RETURNING id`,
      [empresaA, codigo().toUpperCase()],
    )).rows[0].id;
    const tabela = (await db.query<{ id: string }>(
      `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela baixa', '2026-01-01', false, $2::uuid) RETURNING id`,
      [codigo(), empresaA],
    )).rows[0].id;
    const preco = (await db.query<{ id: string }>(
      `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario)
       VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`,
      [tabela, pacote],
    )).rows[0].id;
    const agenda = (await db.query<{ id: string }>(
      `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao)
       VALUES ($1, 'Agenda baixa', '10:00', '18:00', 9) RETURNING id`,
      [codigo()],
    )).rows[0].id;
    const cliente = (await db.query<{ id: string }>(
      `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente baixa', $1::uuid) RETURNING id`,
      [empresaA],
    )).rows[0].id;
    // 054: cliente pertence a uma empresa; o fechamento da empresa B usa um cliente da B.
    const clienteB = (await db.query<{ id: string }>(
      `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente baixa B', $1::uuid) RETURNING id`,
      [empresaB],
    )).rows[0].id;
    const fechamento = (await db.query<{ id: string }>(
      `INSERT INTO fechamentos (
         data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
         categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
         valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status
       ) VALUES ('2026-09-01', '14:00', '18:00', $1::uuid, (SELECT p.empresa_id FROM pacotes p WHERE p.id = $2::uuid), $2::uuid, $3::uuid, $4::uuid,
         'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
      [agenda, pacote, tabela, preco, cliente],
    )).rows[0].id;
    const contrato = (await db.query<{ id: string }>(
      `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`,
      [fechamento],
    )).rows[0].id;
    const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-09-01" } };
    const versao = (await db.query<{ id: string }>(
      `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
       VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`,
      [contrato, JSON.stringify(snapshot), hashSnapshotContrato(snapshot), "d".repeat(64)],
    )).rows[0].id;
    const pagamento = (await db.query<{ id: string }>(
      `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 100) RETURNING id`,
      [versao],
    )).rows[0].id;
    const plano = (await db.query<{ id: string }>(
      `INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas)
       VALUES ($1::uuid, 1, 'PIX', 'AVISTA', 1) RETURNING id`,
      [pagamento],
    )).rows[0].id;
    const parcela = (await db.query<{ id: string }>(
      `INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento, confirma_reserva)
       VALUES ($1::uuid, 1, 100, '2026-09-01', false) RETURNING id`,
      [plano],
    )).rows[0].id;
    const pacoteB = (await db.query<{ id: string }>(
      `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
       VALUES ($1::uuid, $2, 'Festa B', 1, true, true) RETURNING id`,
      [empresaB, codigo().toUpperCase()],
    )).rows[0].id;
    const tabelaB = (await db.query<{ id: string }>(
      `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela B', '2026-01-01', false, $2::uuid) RETURNING id`,
      [codigo(), empresaB],
    )).rows[0].id;
    const precoB = (await db.query<{ id: string }>(
      `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario)
       VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`,
      [tabelaB, pacoteB],
    )).rows[0].id;
    const fechamentoB = (await db.query<{ id: string }>(
      `INSERT INTO fechamentos (
         data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
         categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
         valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status
       ) VALUES ('2026-09-02', '15:00', '19:00', $1::uuid, (SELECT p.empresa_id FROM pacotes p WHERE p.id = $2::uuid), $2::uuid, $3::uuid, $4::uuid,
         'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
      [agenda, pacoteB, tabelaB, precoB, clienteB],
    )).rows[0].id;
    const contratoB = (await db.query<{ id: string }>(
      `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`,
      [fechamentoB],
    )).rows[0].id;
    const versaoB = (await db.query<{ id: string }>(
      `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
       VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`,
      [contratoB, JSON.stringify(snapshot), hashSnapshotContrato(snapshot), "e".repeat(64)],
    )).rows[0].id;
    const pagamentoB = (await db.query<{ id: string }>(
      `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 100) RETURNING id`,
      [versaoB],
    )).rows[0].id;
    const planoB = (await db.query<{ id: string }>(
      `INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas)
       VALUES ($1::uuid, 1, 'PIX', 'AVISTA', 1) RETURNING id`,
      [pagamentoB],
    )).rows[0].id;
    const parcelaB = (await db.query<{ id: string }>(
      `INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento, confirma_reserva)
       VALUES ($1::uuid, 1, 100, '2026-09-01', false) RETURNING id`,
      [planoB],
    )).rows[0].id;
    instalarPool(db);
    const { POST } = exigir(resolve(root, "app/api/admin/financeiro/contas-receber/route.ts")) as Rota;
    const contar = async () => (await db.query<{ recebimentos: number; auditorias: number }>(
      `SELECT
         (SELECT count(*)::int FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid) AS recebimentos,
         (SELECT count(*)::int FROM financeiro_auditoria WHERE entidade_id = $2::uuid AND acao = 'RECEBIMENTO_REGISTRADO') AS auditorias`,
      [pagamento, parcela],
    )).rows[0];
    const contexto = { token: acessoA.token, usuarioId: usuarioA, origem: "financeiro", requestId: randomUUID() };
    const sessaoTenant = { usuario_id: usuarioA, papel: "REPRESENTANTE_AUTORIZADO" as const };
    await assert.rejects(
      () => withTenantTransaction(sessaoTenant, null, async (tx, tenant) => {
        await baixarRecebimentoNoTenant(tx, tenant, { parcelaId: parcela, valor: 40, data: "2026-09-01", forma: "PIX", chave: randomUUID() }, contexto);
        await tx.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [tenant.membershipId]);
      }),
      (error: unknown) => recusaTenant(error),
    );
    assert.deepEqual(await contar(), { recebimentos: 0, auditorias: 0 });
    await assert.rejects(
      () => withTenantTransaction(sessaoTenant, null, async (tx, tenant) => {
        await baixarRecebimentoNoTenant(tx, tenant, { parcelaId: parcela, valor: 40, data: "2026-09-01", forma: "PIX", chave: randomUUID() }, contexto);
        await tx.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [tenant.empresaComprovada]);
      }),
      (error: unknown) => recusaTenant(error),
    );
    assert.deepEqual(await contar(), { recebimentos: 0, auditorias: 0 });
    const corpo = (
      valor: number,
      chave: string,
      extra: { taxa?: number; data?: string; observacao?: string; parcelaId?: string } = {},
    ) => ({
      parcelaId: extra.parcelaId ?? parcela,
      valor,
      data: extra.data ?? "2026-09-01",
      forma: "PIX" as const,
      chave,
      ...(extra.taxa != null ? { taxa: extra.taxa } : {}),
      ...(extra.observacao != null ? { observacao: extra.observacao } : {}),
    });

    await db.query(`
      CREATE OR REPLACE FUNCTION financeiro_auditoria_falha_teste() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'auditoria teste falhou'; END $$;
      CREATE TRIGGER financeiro_auditoria_falha_trg
      BEFORE INSERT ON financeiro_auditoria
      FOR EACH ROW EXECUTE FUNCTION financeiro_auditoria_falha_teste();
    `);
    const falha = await POST(pedido(acessoA.token, acessoA.csrf, corpo(40, randomUUID())));
    assert.equal(falha.status, 500);
    assert.deepEqual(await contar(), { recebimentos: 0, auditorias: 0 });
    await db.query("DROP TRIGGER financeiro_auditoria_falha_trg ON financeiro_auditoria");

    const chave = randomUUID();
    const parcial = await POST(pedido(acessoA.token, acessoA.csrf, corpo(40, chave)));
    const parcialCorpo = await parcial.json();
    assert.equal(parcial.status, 200, JSON.stringify(parcialCorpo));
    assert.equal(parcialCorpo.data?.reutilizado, false);
    assert.equal(parcialCorpo.data?.liquidoCentavos, 4000);
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });
    assert.equal((await db.query<{ status: string }>(
      "SELECT status FROM pagamento_parcelas WHERE id = $1::uuid",
      [parcela],
    )).rows[0].status, "PARCIALMENTE_PAGA");

    const deNovo = await POST(pedido(acessoA.token, acessoA.csrf, corpo(40, chave)));
    const deNovoCorpo = await deNovo.json();
    assert.equal(deNovo.status, 200, JSON.stringify(deNovoCorpo));
    assert.equal(deNovoCorpo.data?.reutilizado, true);
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });

    const conflito = await POST(pedido(acessoA.token, acessoA.csrf, corpo(50, chave)));
    const conflitoCorpo = await conflito.json();
    assert.equal(conflito.status, 409);
    assert.equal(conflitoCorpo.codigo, "IDEMPOTENCIA_CONFLITANTE");
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });

    const chaveAlheia = await POST(pedido(acessoB.token, acessoB.csrf, corpo(40, chave)));
    assert.equal(chaveAlheia.status, 404);
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });

    const reciboB = {
      taxa: 1,
      observacao: "entrada",
      parcelaId: parcelaB,
    };
    const baixaB = await POST(pedido(acessoB.token, acessoB.csrf, corpo(100, chave, reciboB)));
    const baixaBCorpo = await baixaB.json();
    assert.equal(baixaB.status, 200, JSON.stringify(baixaBCorpo));
    assert.equal(baixaBCorpo.data?.reutilizado, false);
    assert.equal(baixaBCorpo.data?.liquidoCentavos, 9900);
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });
    assert.equal((await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid",
      [pagamentoB],
    )).rows[0].n, 1);

    const retryB = await POST(pedido(acessoB.token, acessoB.csrf, corpo(100, chave, reciboB)));
    const retryBCorpo = await retryB.json();
    assert.equal(retryB.status, 200, JSON.stringify(retryBCorpo));
    assert.equal(retryBCorpo.data?.reutilizado, true);
    assert.equal((await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid",
      [pagamentoB],
    )).rows[0].n, 1);

    const outraData = await POST(pedido(acessoB.token, acessoB.csrf, corpo(100, chave, { ...reciboB, data: "2026-09-02" })));
    const outraDataCorpo = await outraData.json();
    assert.equal(outraData.status, 409);
    assert.equal(outraDataCorpo.codigo, "IDEMPOTENCIA_CONFLITANTE");
    const outraObs = await POST(pedido(acessoB.token, acessoB.csrf, corpo(100, chave, { ...reciboB, observacao: "outra" })));
    const outraObsCorpo = await outraObs.json();
    assert.equal(outraObs.status, 409);
    assert.equal(outraObsCorpo.codigo, "IDEMPOTENCIA_CONFLITANTE");
    assert.equal((await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid",
      [pagamentoB],
    )).rows[0].n, 1);

    const acima = await POST(pedido(acessoA.token, acessoA.csrf, corpo(70, randomUUID())));
    assert.equal(acima.status, 409);
    assert.deepEqual(await contar(), { recebimentos: 1, auditorias: 1 });

    const total = await POST(pedido(acessoA.token, acessoA.csrf, corpo(60, randomUUID())));
    const totalCorpo = await total.json();
    assert.equal(total.status, 200, JSON.stringify(totalCorpo));
    assert.equal(totalCorpo.data?.reutilizado, false);
    assert.equal((await db.query<{ status: string }>(
      "SELECT status FROM pagamento_parcelas WHERE id = $1::uuid",
      [parcela],
    )).rows[0].status, "PAGA");
    assert.deepEqual(await contar(), { recebimentos: 2, auditorias: 2 });

    const aposQuitar = await POST(pedido(acessoA.token, acessoA.csrf, corpo(40, chave)));
    const aposQuitarCorpo = await aposQuitar.json();
    assert.equal(aposQuitar.status, 200, JSON.stringify(aposQuitarCorpo));
    assert.equal(aposQuitarCorpo.data?.reutilizado, true);
    assert.deepEqual(await contar(), { recebimentos: 2, auditorias: 2 });

    const excedente = await POST(pedido(acessoA.token, acessoA.csrf, corpo(1, randomUUID())));
    assert.equal(excedente.status, 404);
    assert.deepEqual(await contar(), { recebimentos: 2, auditorias: 2 });

    const outraEmpresa = await POST(pedido(acessoB.token, acessoB.csrf, corpo(10, randomUUID())));
    assert.equal(outraEmpresa.status, 404);
    assert.deepEqual(await contar(), { recebimentos: 2, auditorias: 2 });

    const semSessao = await POST(pedido(null, acessoA.csrf, corpo(10, randomUUID())));
    assert.equal(semSessao.status, 401);
    assert.deepEqual(await contar(), { recebimentos: 2, auditorias: 2 });
  } finally {
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    ambiente.NODE_ENV = anterior.NODE_ENV;
    if (anterior.ADMIN_AUTH_ORIGIN == null) delete process.env.ADMIN_AUTH_ORIGIN;
    else process.env.ADMIN_AUTH_ORIGIN = anterior.ADMIN_AUTH_ORIGIN;
    if (anterior.RENDER == null) delete process.env.RENDER;
    else process.env.RENDER = anterior.RENDER;
    if (anterior.KIDMAIS_DEPLOY_ENV == null) delete process.env.KIDMAIS_DEPLOY_ENV;
    else process.env.KIDMAIS_DEPLOY_ENV = anterior.KIDMAIS_DEPLOY_ENV;
    if (conexao) await encerrarDescartavel(conexao);
  }
});
