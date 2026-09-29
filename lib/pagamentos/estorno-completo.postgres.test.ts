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
import { chaveIdempotenciaNoPagamento } from "./services/idempotencia.ts";

/**
 * E4 — estorno completo pelas ROTAS reais (sessão, CSRF, Tenant Context, posse, serviços reais):
 * contrato com versão ASSINADA → recebimento → estorno → auditoria/evento → replay → payload diferente →
 * outra empresa com a MESMA chave → falha injetada depois da escrita (rollback).
 *
 * Tudo roda numa transação externa nunca confirmada (as transações dos serviços viram SAVEPOINTs, como na
 * suíte da baixa). Por isso as guardas DIFERIDAS de formalização (019: duas assinaturas + Festa) não são
 * exercitadas aqui — a formalização real continua gate pré-produção. O resto (tenant, posse, locks,
 * idempotência, posição financeira, auditoria e rollback) é o código de produção sobre o schema atual.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};

type Corpo = { ok: boolean; data?: { reutilizado?: boolean; estorno?: { id: string; status: string }; recebimento?: { id: string; status: string } }; erro?: string; codigo?: string };
type Resposta = { status: number; json: () => Promise<Corpo> };
type Rota = { POST: (request: unknown, contexto: { params: Promise<{ pagamentoId: string }> }) => Promise<Resposta> };

const cod = () => `e4${randomBytes(3).toString("hex")}`;

function instalarPool(db: Client) {
  const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao", COMMIT: "RELEASE SAVEPOINT operacao", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao" };
  (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
    query: (sql: string, values?: unknown[]) => db.query(sql, values),
    connect: async () => ({ query: (sql: string, values?: unknown[]) => db.query(troca[sql] ?? sql, values), release() {} }),
  };
}

function pedido(url: string, acesso: { token: string; csrf: string }, body: unknown) {
  const { NextRequest } = exigir("next/server") as { NextRequest: new (url: string, init: { method: string; headers: Headers; body: string }) => unknown };
  const headers = new Headers({ origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json", "x-csrf-token": acesso.csrf, cookie: `kidmais_admin_dev=${acesso.token}` });
  return new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function id(db: Client, sql: string, v: unknown[]) {
  return (await db.query<{ id: string }>(sql, v)).rows[0].id;
}

async function ator(db: Client, empresaId: string) {
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Estorno E4', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${cod()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`, [empresaId, usuario]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [usuario, hashToken(token), hashToken(csrf)]);
  return { usuario, token, csrf };
}

/** Empresa ativa → pacote/tabela/preço → cliente → fechamento → contrato ASSINADO + versão ASSINADA vigente → pagamento/plano/parcela. */
async function cadeiaAssinada(db: Client) {
  const empresa = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa E4', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa E4', 1, true, true) RETURNING id`, [empresa, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela E4', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresa]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda E4', '10:00', '18:00', 9) RETURNING id`, [cod()]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente E4', $1::uuid) RETURNING id`, [empresa]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2026-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresa, pacote, tabela, preco, cliente]);
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-09-01" }, contratante: { clienteId: cliente } };
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`, [contrato, JSON.stringify(snapshot), hashSnapshotContrato(snapshot), "d".repeat(64)]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  const pagamento = await id(db, `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 100) RETURNING id`, [versao]);
  const plano = await id(db, `INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas) VALUES ($1::uuid, 1, 'PIX', 'AVISTA', 1) RETURNING id`, [pagamento]);
  const parcela = await id(db, `INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento, confirma_reserva) VALUES ($1::uuid, 1, 100, '2026-09-01', false) RETURNING id`, [plano]);
  return { empresa, pagamento, parcela, contrato };
}

test("E4: estorno completo pelas rotas reais — recebimento, estorno, auditoria, replay, chave por tenant e rollback", { timeout: 120_000 }, async (t) => {
  const anterior = { NODE_ENV: process.env.NODE_ENV, ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN, RENDER: process.env.RENDER, KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV };
  (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
  process.env.ADMIN_AUTH_ORIGIN = "http://localhost:3000";
  delete process.env.RENDER;
  delete process.env.KIDMAIS_DEPLOY_ENV;
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = (await db.query<{ db: string }>("SELECT current_database() AS db")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    await db.query("BEGIN");
    const A = await cadeiaAssinada(db);
    const B = await cadeiaAssinada(db);
    const atorA = await ator(db, A.empresa);
    const atorB = await ator(db, B.empresa);
    instalarPool(db);
    const recebimentos = exigir(resolve(root, "app/api/admin/pagamentos/[pagamentoId]/recebimentos/route.ts")) as Rota;
    const estornos = exigir(resolve(root, "app/api/admin/pagamentos/[pagamentoId]/estornos/route.ts")) as Rota;
    const chamar = async (rota: Rota, caminho: string, acesso: { token: string; csrf: string }, pagamentoId: string, body: unknown) => {
      const r = await rota.POST(pedido(`/api/admin/pagamentos/${pagamentoId}/${caminho}`, acesso, body), { params: Promise.resolve({ pagamentoId }) });
      return { status: r.status, corpo: await r.json() };
    };
    const contar = async (sql: string, v: unknown[]) => Number((await db.query<{ n: number }>(sql, v)).rows[0].n);

    // ---------------------------------------------------------------- recebimento (A e B com a MESMA chave)
    const K = "pedido-recebimento-0001";
    const recebA = await chamar(recebimentos, "recebimentos", atorA, A.pagamento, { meioPagamento: "PIX", valorBruto: 40, alocacoes: [{ parcelaId: A.parcela, valor: 40 }], chaveIdempotencia: K });
    assert.equal(recebA.status, 201, JSON.stringify(recebA.corpo));
    const recebimentoA = recebA.corpo.data!.recebimento!;
    assert.equal(recebimentoA.status, "CONFIRMADO");
    const recebB = await chamar(recebimentos, "recebimentos", atorB, B.pagamento, { meioPagamento: "PIX", valorBruto: 40, alocacoes: [{ parcelaId: B.parcela, valor: 40 }], chaveIdempotencia: K });
    assert.equal(recebB.status, 201, `a mesma chave em outra empresa não colide nem revela nada: ${JSON.stringify(recebB.corpo)}`);
    const replayReceb = await chamar(recebimentos, "recebimentos", atorA, A.pagamento, { meioPagamento: "PIX", valorBruto: 40, alocacoes: [{ parcelaId: A.parcela, valor: 40 }], chaveIdempotencia: K });
    assert.equal(replayReceb.status, 200);
    assert.equal(replayReceb.corpo.data?.reutilizado, true);
    assert.equal(replayReceb.corpo.data?.recebimento?.id, recebimentoA.id);
    const gravada = (await db.query<{ c: string }>("SELECT chave_idempotencia AS c FROM pagamento_recebimentos WHERE id = $1::uuid", [recebimentoA.id])).rows[0].c;
    assert.equal(gravada, chaveIdempotenciaNoPagamento(A.empresa, A.pagamento, "recebimento", K), "gravada escopada, nunca a chave crua");

    // ---------------------------------------------------------------- estorno
    const K2 = "pedido-estorno-0001";
    const corpoEstorno = (pagamentoId: string, recebimentoId: string, parcelaId: string, valor: number, chave: string) => ({ recebimentoId, parcelaId, valor, chaveIdempotencia: chave, motivo: "Devolução parcial ao cliente" });
    const estA = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 10, K2));
    assert.equal(estA.status, 201, JSON.stringify(estA.corpo));
    const estornoA = estA.corpo.data!.estorno!;
    assert.equal(estornoA.status, "CONFIRMADO");
    const auditoriaDo = async (entidade: string) => contar("SELECT count(*)::int AS n FROM auditoria WHERE entidade_id = $1::uuid", [entidade]);
    const eventosDo = async (movimento: string) => contar("SELECT count(*)::int AS n FROM pagamento_eventos WHERE tipo LIKE 'ESTORNO%' AND resultado->>'movimentoId' = $1", [movimento]);
    const auditoria1 = await auditoriaDo(estornoA.id);
    const eventos1 = await eventosDo(estornoA.id);
    assert.ok(auditoria1 >= 1, "auditoria do estorno gravada");
    assert.equal(eventos1, 1, "um evento financeiro do estorno");
    t.diagnostic(`E4 estorno ${estornoA.id}: auditoria=${auditoria1} eventos=${eventos1}`);

    // Replay: mesma chave, mesmo pagamento, mesmo payload ⇒ o mesmo estorno, sem nova auditoria/evento.
    const replay = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 10, K2));
    assert.equal(replay.status, 200, JSON.stringify(replay.corpo));
    assert.equal(replay.corpo.data?.reutilizado, true);
    assert.equal(replay.corpo.data?.estorno?.id, estornoA.id);
    assert.equal(await auditoriaDo(estornoA.id), auditoria1);
    assert.equal(await eventosDo(estornoA.id), eventos1);
    // Mesma chave com payload diferente ⇒ recusa, sem nada novo.
    const diverge = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 11, K2));
    assert.equal(diverge.status, 409);
    assert.equal(diverge.corpo.codigo, "ESTORNO_INVALIDO");
    assert.equal(await contar("SELECT count(*)::int AS n FROM pagamento_estornos WHERE recebimento_id = $1::uuid", [recebimentoA.id]), 1);

    // Outra empresa com a MESMA chave de estorno: independente (nada de colisão global nem oráculo).
    const recebimentoB = recebB.corpo.data!.recebimento!;
    const estB = await chamar(estornos, "estornos", atorB, B.pagamento, corpoEstorno(B.pagamento, recebimentoB.id, B.parcela, 10, K2));
    assert.equal(estB.status, 201, JSON.stringify(estB.corpo));
    assert.notEqual(estB.corpo.data?.estorno?.id, estornoA.id);

    // Cross-tenant: B no pagamento de A ⇒ 404 da posse, antes de qualquer leitura.
    const cruzado = await chamar(estornos, "estornos", atorB, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 1, "pedido-cruzado-0001"));
    assert.equal(cruzado.status, 404);
    // Recebimento de B num pagamento de A (filho estrangeiro) ⇒ o mesmo erro de recebimento inexistente.
    const filho = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoB.id, A.parcela, 1, "pedido-filho-0001"));
    const inexistente = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, randomUUID(), A.parcela, 1, "pedido-inex-0001"));
    assert.deepEqual([filho.status, filho.corpo.erro], [inexistente.status, inexistente.corpo.erro], "não enumerável");

    // ---------------------------------------------------------------- rollback: falha DEPOIS da escrita do estorno
    await db.query(`
      CREATE OR REPLACE FUNCTION e4_evento_falha() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha injetada E4'; END $$;
      CREATE TRIGGER e4_evento_falha_trg BEFORE INSERT ON pagamento_eventos FOR EACH ROW WHEN (NEW.tipo LIKE 'ESTORNO%') EXECUTE FUNCTION e4_evento_falha();`);
    const antes = await contar("SELECT count(*)::int AS n FROM pagamento_estornos WHERE recebimento_id = $1::uuid", [recebimentoA.id]);
    const falha = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 5, "pedido-falha-0001"));
    assert.equal(falha.status, 500);
    assert.equal(await contar("SELECT count(*)::int AS n FROM pagamento_estornos WHERE recebimento_id = $1::uuid", [recebimentoA.id]), antes, "nenhum estorno parcial");
    await db.query("DROP TRIGGER e4_evento_falha_trg ON pagamento_eventos; DROP FUNCTION e4_evento_falha();");
    // Depois da falha, a mesma chave funciona (nada ficou gravado com ela).
    const depois = await chamar(estornos, "estornos", atorA, A.pagamento, corpoEstorno(A.pagamento, recebimentoA.id, A.parcela, 5, "pedido-falha-0001"));
    assert.equal(depois.status, 201, JSON.stringify(depois.corpo));
  } finally {
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    for (const [k, v] of Object.entries(anterior)) {
      if (v == null) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
    await encerrarDescartavel(client);
  }
});

test("E4: PDF revisado e persistido — aquisição na transação da prova, bytes íntegros, materialização sem consulta depois do commit", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    await db.query("BEGIN");
    const A = await cadeiaAssinada(db);
    const B = await cadeiaAssinada(db);
    const atorA = await ator(db, A.empresa);
    // Versão ATIVA com edição cujo documento revisado está gravado (bytes reais, hash e tamanho conferidos pelo banco).
    const fechamento = (await db.query<{ f: string }>("SELECT fechamento_id AS f FROM contratos WHERE id = $1::uuid", [A.contrato])).rows[0].f;
    // A versão vigente (fluxo) recebe a edição com o documento revisado; o hash do snapshot é o gravado na versão.
    const vig = (await db.query<{ id: string; h: string }>("SELECT v.id, v.snapshot_hash AS h FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1::uuid", [A.contrato])).rows[0];
    const versao = vig.id;
    const hash = vig.h;
    const pdf = Buffer.from(`%PDF-1.4\n% E4 documento revisado ${randomUUID()}\n%%EOF\n`);
    const { guardarDocumento } = exigir(resolve(root, "lib/contratos/storage/postgres.ts")) as { guardarDocumento: (tx: unknown, i: Record<string, unknown>) => Promise<{ id: string; pdf_hash: string }> };
    const doc = await guardarDocumento(db, { versaoId: versao, categoria: "CONTRATO", revisao: 1, snapshotHash: hash, templateCodigo: "CONTRATO_E4", templateVersao: 1, usuarioId: atorA.usuario, pdf });
    await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
       VALUES ($1::uuid, $2::uuid, 'INICIAL', 'EM_ELABORACAO', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, A.contrato, atorA.usuario, doc.id]);

    // Pool por SAVEPOINT (como na suíte da baixa), contando toda consulta depois do COMMIT da transação do tenant.
    const uso = { depoisDoCommit: 0, commitou: false };
    const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao", COMMIT: "RELEASE SAVEPOINT operacao", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao" };
    const q = (sql: string, values?: unknown[]) => { if (uso.commitou) uso.depoisDoCommit += 1; if (sql === "COMMIT") uso.commitou = true; return db.query(troca[sql] ?? sql, values); };
    (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = { query: q, connect: async () => ({ query: q, release() {} }) };
    const { withTenantTransaction } = exigir(resolve(root, "lib/saas/provar-tenant.ts")) as { withTenantTransaction: unknown };
    const publico = exigir(resolve(root, "lib/contratos/services/contrato-publico.service.ts")) as { adquirirPdfContratoAdmin: unknown; renderizarPdfContratoAdmin: (d: unknown) => { pdf: Buffer; pdfHash: string; contrato: { id: string }; versao: { id: string } } };
    const exportacao = exigir(resolve(root, "lib/contratos/services/exportacao-tenant.ts")) as { exportarContratoDoTenant: (s: unknown, e: string | null, f: string, d: unknown) => Promise<{ pdf: Buffer; pdfHash: string; contrato: { id: string }; versao: { id: string } }> };
    const sessao = { usuario_id: atorA.usuario, papel: "REPRESENTANTE_AUTORIZADO" };
    let usoNaRenderizacao = -1;
    const r = await exportacao.exportarContratoDoTenant(sessao, null, fechamento, {
      withTenantTransaction,
      adquirir: publico.adquirirPdfContratoAdmin,
      renderizar: (d: unknown) => { const antes = uso.depoisDoCommit; assert.equal(uso.commitou, true, "renderiza depois do commit"); const saida = publico.renderizarPdfContratoAdmin(d); usoNaRenderizacao = uso.depoisDoCommit - antes; return saida; },
    });
    assert.equal(Buffer.compare(Buffer.from(r.pdf), pdf), 0, "bytes do documento persistido");
    assert.equal(r.pdfHash, doc.pdf_hash);
    assert.equal(r.versao.id, versao);
    assert.equal(r.contrato.id, A.contrato);
    assert.equal(usoNaRenderizacao, 0, "materialização sem nenhuma consulta");
    assert.equal(uso.depoisDoCommit, 0, "nenhuma consulta depois do commit da prova");
    // Outra empresa pedindo o fechamento de A ⇒ 404 da posse; o documento não é lido.
    const atorB = await ator(db, B.empresa);
    await assert.rejects(exportacao.exportarContratoDoTenant({ usuario_id: atorB.usuario, papel: "REPRESENTANTE_AUTORIZADO" }, null, fechamento, { withTenantTransaction, adquirir: publico.adquirirPdfContratoAdmin, renderizar: publico.renderizarPdfContratoAdmin }),
      (e: unknown) => (e as { httpStatus?: number }).httpStatus === 404);
  } finally {
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    await encerrarDescartavel(client);
  }
});
