import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import pg from "pg";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from "../comercial/postgres-descartavel.ts";

/**
 * Gates ambientais C1–C3 / Human Gate no PostgreSQL descartável REAL (nunca staging/produção).
 *
 * Roda só pelo `check:v1:postgres` com KIDMAIS_POSTGRES_DESCARTAVEL. Instala um pg.Pool REAL no cluster
 * descartável (identidade conferida) para `withTransaction`/`withTenantTransaction` abrirem transações
 * concorrentes de verdade, e registra o comportamento REAL das travas (quem espera por quem, em qual
 * relação) via pg_stat_activity/pg_locks — não só o resultado final.
 *
 * Deixa no descartável linhas sintéticas (prefixo `gc2`) em tabelas do Core que as guardas não deixam
 * apagar; tabelas da 055 que instala para o Human Gate são removidas no fim.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_t, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};

type Tx = { query<R = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }> };
type Sessao = { usuario_id: string; papel: string };
type Tenant = { empresaComprovada: string; membershipId: string; usuarioId: string; papelAtual: string };
type ComTenant = <T>(s: Sessao, e: string | null, w: (tx: Tx, t: Tenant) => Promise<T>) => Promise<T>;
type Posse = (tx: Tx, empresa: string, id: string) => Promise<boolean>;

const APP = "gates-c2-pool";
const PREFIXO = `gc2${randomBytes(2).toString("hex")}`;
let seq = 0;
const cod = () => `${PREFIXO}${++seq}`;
const CRIADOR = { id: "" };
const SENHA = () => `scrypt$v=1$N=131072$r=8$p=1$${randomBytes(16).toString("base64").replace(/=+$/, "")}==$${randomBytes(64).toString("base64").replace(/=+$/, "")}==`;

// ------------------------------------------------------------------ fixtures (commitadas, sintéticas)

async function empresa(db: Client, nome: string) {
  const id = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [cod(), `${PREFIXO} ${nome}`])).rows[0].id;
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function ator(db: Client, empresaId: string, papel = "REPRESENTANTE_AUTORIZADO") {
  const usuarioId = (await db.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id::text AS id`,
    [`${cod()}@example.test`, `${PREFIXO} ator`, SENHA(), papel],
  )).rows[0].id;
  const membershipId = (await db.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id::text AS id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membershipId]);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`,
    [usuarioId, hashToken(token), hashToken(randomBytes(32).toString("base64url"))],
  );
  return { usuarioId, membershipId, token, sessao: { usuario_id: usuarioId, papel } as Sessao };
}

async function cliente(db: Client, empresaId: string | null) {
  return (await db.query<{ id: string }>(`INSERT INTO clientes (nome_completo, empresa_id) VALUES ($1, $2::uuid) RETURNING id::text AS id`, [`${PREFIXO} Cliente`, empresaId])).rows[0].id;
}

/** empresa → pacote → tabela/preço → cliente → fechamento → contrato (aguardando assinatura) → versão ATIVA → pagamento → plano → parcela → recebimento → alocação. */
async function cadeia(db: Client, empresaId: string, recebido = 40) {
  const criador = CRIADOR.id;
  const pacote = (await db.query<{ id: string }>(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Pacote gates', 1, true, true) RETURNING id::text AS id`, [empresaId, cod().toUpperCase()])).rows[0].id;
  const tabela = (await db.query<{ id: string }>(`INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela gates', '2026-01-01', false, $2::uuid) RETURNING id::text AS id`, [cod(), empresaId])).rows[0].id;
  const preco = (await db.query<{ id: string }>(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id::text AS id`, [tabela, pacote])).rows[0].id;
  const agenda = (await db.query<{ id: string }>(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda gates', '10:00', '18:00', 9) RETURNING id::text AS id`, [cod()])).rows[0].id;
  const clienteId = await cliente(db, empresaId);
  const fechamento = (await db.query<{ id: string }>(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela,
       origem_fechamento, cliente_id, status, empresa_id)
     VALUES ('2026-03-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100,
       'ATENDIMENTO_KIDMAIS', $5::uuid, 'RASCUNHO', $6::uuid) RETURNING id::text AS id`,
    [agenda, pacote, tabela, preco, clienteId, empresaId],
  )).rows[0].id;
  // Contrato em elaboração, como o serviço cria: contrato + versão ATIVA + edição + fluxo NA MESMA transação
  // (as guardas diferidas da 013/019 conferem o conjunto no commit). Não exige formalização/assinatura.
  await db.query("BEGIN");
  const contrato = (await db.query<{ id: string }>(`INSERT INTO contratos (fechamento_id, status) VALUES ($1::uuid, 'AGUARDANDO_ASSINATURA') RETURNING id::text AS id`, [fechamento])).rows[0].id;
  const versao = (await db.query<{ id: string }>(
    `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash)
     VALUES ($1::uuid, 1, 'ATIVA', '{"comercial":{"valorFinalContrato":100}}'::jsonb, $2) RETURNING id::text AS id`,
    [contrato, "a".repeat(64)],
  )).rows[0].id;
  await db.query(
    `INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'EM_ELABORACAO', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid)`,
    [versao, contrato, criador],
  );
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_em_preparacao_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  await db.query("COMMIT");
  const pagamento = (await db.query<{ id: string }>(`INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 100) RETURNING id::text AS id`, [versao])).rows[0].id;
  const plano = (await db.query<{ id: string }>(`INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas) VALUES ($1::uuid, 1, 'PIX', 'AVISTA', 1) RETURNING id::text AS id`, [pagamento])).rows[0].id;
  const parcela = (await db.query<{ id: string }>(`INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento) VALUES ($1::uuid, 1, 100, '2026-03-01') RETURNING id::text AS id`, [plano])).rows[0].id;
  const recebimento = (await db.query<{ id: string }>(
    `INSERT INTO pagamento_recebimentos (pagamento_id, status, meio_pagamento, valor_bruto, recebido_em, confirmado_em, chave_idempotencia, metadata_provedor)
     VALUES ($1::uuid, 'CONFIRMADO', 'PIX', $2, '2026-03-01', now(), $3, '{"forma":"PIX"}'::jsonb) RETURNING id::text AS id`,
    [pagamento, recebido, randomUUID()],
  )).rows[0].id;
  const alocacao = (await db.query<{ id: string }>(`INSERT INTO pagamento_recebimento_alocacoes (recebimento_id, parcela_id, valor_alocado) VALUES ($1::uuid, $2::uuid, $3) RETURNING id::text AS id`, [recebimento, parcela, recebido])).rows[0].id;
  return { pacote, fechamento, contrato, versao, pagamento, plano, parcela, recebimento, alocacao, cliente: clienteId };
}

// ------------------------------------------------------------------ observação das travas

type Espera = { pid: number; bloqueadores: number[]; locktype: string | null; relacao: string | null; esperaMs: number; consulta: string };

/** Espera até um backend ficar bloqueado por `bloqueador` (ou por qualquer pool, se null); devolve o que o PG mostra. */
async function esperarBloqueio(adm: Client, filtro: { bloqueador?: number; bloqueado?: number }, limiteMs = 10_000): Promise<Espera> {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    const r = await adm.query<{ pid: number; bloqueadores: number[]; locktype: string | null; relacao: string | null; espera_ms: number; consulta: string }>(
      `SELECT a.pid, pg_blocking_pids(a.pid) AS bloqueadores, l.locktype, l.relation::regclass::text AS relacao,
              left(regexp_replace(a.query, '[[:space:]]+', ' ', 'g'), 110) AS consulta,
              (extract(epoch FROM clock_timestamp() - a.state_change) * 1000)::int AS espera_ms
         FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
        WHERE a.wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(a.pid)) > 0
          AND ($1::int IS NULL OR $1 = ANY(pg_blocking_pids(a.pid)))
          AND ($2::int IS NULL OR a.pid = $2)`,
      [filtro.bloqueador ?? null, filtro.bloqueado ?? null],
    );
    if (r.rows[0]) return { pid: r.rows[0].pid, bloqueadores: r.rows[0].bloqueadores, locktype: r.rows[0].locktype, relacao: r.rows[0].relacao, esperaMs: r.rows[0].espera_ms, consulta: r.rows[0].consulta };
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`nenhum bloqueio observado em ${limiteMs} ms (${JSON.stringify(filtro)})`);
}

/** Relações travadas (granted) por um backend: mostra a ordem real do que está preso até o commit. */
async function travasDe(adm: Client, pid: number) {
  const r = await adm.query<{ rel: string; modo: string }>(
    `SELECT c.relname AS rel, string_agg(DISTINCT l.mode, ',' ORDER BY l.mode) AS modo
       FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = $1 AND l.granted AND c.relkind = 'r' AND c.relname IN ('usuarios_administrativos','empresas','memberships','pagamentos','pagamento_recebimentos','fechamentos','contratos','ia_operacoes')
      GROUP BY c.relname ORDER BY c.relname`,
    [pid],
  );
  return r.rows.map((x) => `${x.rel}:${x.modo}`);
}

/** Transações abertas do pool da aplicação: prova que o serviço NÃO abriu transação paralela. */
async function transacoesDoPool(adm: Client) {
  return Number((await adm.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL`, [APP])).rows[0].n);
}

function barreira() {
  let soltar!: () => void;
  const aberta = new Promise<void>((ok) => { soltar = ok; });
  return { aberta, soltar };
}

const recusaTenant = (e: unknown) => (e as { code?: string; httpStatus?: number }).httpStatus === 403;
const recusa404 = (e: unknown) => (e as { httpStatus?: number; status?: number }).httpStatus === 404 || (e as { status?: number }).status === 404;

// ------------------------------------------------------------------ o gate

test("gates C1–C3 + Human Gate em PostgreSQL real: concorrência, travas, rollback e cross-tenant", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: gate PostgreSQL não executado");
    return;
  }
  const admCliente = await conectarDescartavel();
  const adm = admCliente as unknown as Client;
  const porta = portaDescartavel();
  const pool = new pg.Pool({ host: "127.0.0.1", port: porta, user: "kidmais_descartavel", database: "kidmais_pacotes_v1_descartavel", password: senhaRecusada, max: 8, application_name: APP });
  const c2 = new pg.Client({ host: "127.0.0.1", port: porta, user: "kidmais_descartavel", database: "kidmais_pacotes_v1_descartavel", password: senhaRecusada, application_name: "gates-c2-concorrente" });
  await c2.connect();
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const poolAnterior = g.__kidmaisPgPool;
  let instalou055 = false;
  try {
    // Identidade do pool ANTES de qualquer uso pelos serviços.
    const ident = (await pool.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.port), porta);
    t.diagnostic(`alvo: 127.0.0.1:${ident.port}/${ident.db} (pool ${APP})`);
    g.__kidmaisPgPool = pool;

    const { withTenantTransaction } = exigir(resolve(root, "lib/saas/provar-tenant.ts")) as { withTenantTransaction: ComTenant };
    const ct = exigir(resolve(root, "lib/contratos/services/contrato-tenant.ts")) as {
      executarComPosseNoTenant: <T>(s: Sessao, e: string | null, id: string, p: Posse, d: { withTenantTransaction: ComTenant }, w: (tx: Tx, t: Tenant) => Promise<T>, papeis?: readonly string[]) => Promise<T>;
      pagamentoNoTenant: Posse; fechamentoNoTenant: Posse; contratoNoTenant: Posse;
    };
    const pag = exigir(resolve(root, "lib/pagamentos/services/pagamento.service.ts")) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const deps = { withTenantTransaction };
    const naPosse = <T>(s: Sessao, id: string, posse: Posse, w: (tx: Tx, t: Tenant) => Promise<T>) => ct.executarComPosseNoTenant(s, null, id, posse, deps, w);
    const comprovante = (pagamentoId: string, recebimentoId: string, tx: Tx, usuarioId: string) => pag.registrarComprovantePagamento(
      { pagamentoId, recebimentoId, nomeArquivo: "gates.pdf", mimeType: "application/pdf", tamanhoBytes: 10, sha256: randomBytes(32).toString("hex"), localizadorArquivo: `gates/${randomUUID()}` },
      { origem: "PAGAMENTO_INTERNO_DEV", usuarioId, executor: tx },
    );
    const contar = async (sql: string, v: unknown[]) => Number((await adm.query<{ n: number }>(sql, v)).rows[0].n);
    const comprovantesDe = (pagamentoId: string) => contar(`SELECT count(*)::int AS n FROM pagamento_comprovantes c JOIN pagamento_recebimentos r ON r.id = c.recebimento_id WHERE r.pagamento_id = $1::uuid`, [pagamentoId]);

    // ---------------------------------------------------------------- fixtures
    CRIADOR.id = (await adm.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'ADMINISTRATIVO', true) RETURNING id::text AS id`, [`${cod()}@example.test`, `${PREFIXO} criador`, SENHA()])).rows[0].id;
    const A = await empresa(adm, "A");
    const B = await empresa(adm, "B");
    const cA = await cadeia(adm, A);
    const cB = await cadeia(adm, B);
    t.diagnostic(`fixtures: empresas A/B e cadeias de pagamento (prefixo ${PREFIXO})`);

    // ================================================================ 6 / Caso A — membership revogada
    await t.test("Caso A1: operação primeiro — a revogação ESPERA a escrita; depois dela, nova operação é recusada", async () => {
      const u = await ator(adm, A);
      const b = barreira();
      let pidOp = 0;
      const antes = await comprovantesDe(cA.pagamento);
      const op = naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => {
        await comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId);
        pidOp = Number((await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
        await b.aberta;
      });
      while (!pidOp) await new Promise((ok) => setTimeout(ok, 10));
      assert.equal(await transacoesDoPool(adm), 1, "serviço com executor não abriu transação paralela");
      t.diagnostic(`A1 travas da operação até o commit: ${(await travasDe(adm, pidOp)).join(" ")}`);
      const revogar = c2.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [u.membershipId]);
      const espera = await esperarBloqueio(adm, { bloqueador: pidOp });
      t.diagnostic(`A1 revogação bloqueada: pid ${espera.pid} espera ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
      b.soltar();
      await op;
      await revogar;
      assert.equal(await comprovantesDe(cA.pagamento), antes + 1, "escrita com autoridade válida no momento");
      await assert.rejects(naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId)), recusaTenant);
      assert.equal(await comprovantesDe(cA.pagamento), antes + 1, "autoridade revogada não escreve");
    });

    await t.test("Caso A2: revogação primeiro (sem commit) — a operação ESPERA e, após o commit, é recusada sem escrever", async () => {
      const u = await ator(adm, A);
      const antes = await comprovantesDe(cA.pagamento);
      await c2.query("BEGIN");
      await c2.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [u.membershipId]);
      const pidRev = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
      const op = naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId)).then(() => "escreveu", (e) => e);
      const espera = await esperarBloqueio(adm, { bloqueador: pidRev });
      t.diagnostic(`A2 operação bloqueada: pid ${espera.pid} espera ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
      await c2.query("COMMIT");
      const r = await op;
      assert.ok(recusaTenant(r), `esperado 403, veio ${String(r)}`);
      assert.equal(await comprovantesDe(cA.pagamento), antes);
    });

    // ================================================================ Caso B — empresa suspensa
    await t.test("Caso B: suspensão concorrente da empresa — nas duas ordens, nenhuma escrita com empresa suspensa", async () => {
      for (const ordem of ["operacao-primeiro", "suspensao-primeiro"] as const) {
        const C = await empresa(adm, `C ${ordem}`);
        const cC = await cadeia(adm, C);
        const u = await ator(adm, C);
        const antes = await comprovantesDe(cC.pagamento);
        if (ordem === "operacao-primeiro") {
          const b = barreira();
          let pidOp = 0;
          const op = naPosse(u.sessao, cC.pagamento, ct.pagamentoNoTenant, async (tx) => {
            await comprovante(cC.pagamento, cC.recebimento, tx, u.usuarioId);
            pidOp = Number((await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
            await b.aberta;
          });
          while (!pidOp) await new Promise((ok) => setTimeout(ok, 10));
          const suspender = c2.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [C]);
          const espera = await esperarBloqueio(adm, { bloqueador: pidOp });
          t.diagnostic(`B ${ordem}: suspensão bloqueada pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
          b.soltar();
          await op;
          await suspender;
          assert.equal(await comprovantesDe(cC.pagamento), antes + 1);
          await assert.rejects(naPosse(u.sessao, cC.pagamento, ct.pagamentoNoTenant, async (tx) => comprovante(cC.pagamento, cC.recebimento, tx, u.usuarioId)), recusaTenant);
        } else {
          await c2.query("BEGIN");
          await c2.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [C]);
          const pidSus = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
          const op = naPosse(u.sessao, cC.pagamento, ct.pagamentoNoTenant, async (tx) => comprovante(cC.pagamento, cC.recebimento, tx, u.usuarioId)).then(() => "escreveu", (e) => e);
          const espera = await esperarBloqueio(adm, { bloqueador: pidSus });
          t.diagnostic(`B ${ordem}: operação bloqueada pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
          await c2.query("COMMIT");
          assert.ok(recusaTenant(await op));
          assert.equal(await comprovantesDe(cC.pagamento), antes);
        }
      }
    });

    // ================================================================ Caso C — usuário desativado (papel: ver Caso D)
    await t.test("Caso C: usuário desativado concorrentemente — a operação em curso segura a linha; depois, recusa", async () => {
      const u = await ator(adm, A);
      const antes = await comprovantesDe(cA.pagamento);
      await c2.query("BEGIN");
      await c2.query(`UPDATE usuarios_administrativos SET ativo = false WHERE id = $1::uuid`, [u.usuarioId]);
      const pidDes = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
      const op = naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId)).then(() => "escreveu", (e) => e);
      const espera = await esperarBloqueio(adm, { bloqueador: pidDes });
      t.diagnostic(`C operação bloqueada pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
      await c2.query("COMMIT");
      assert.ok(recusaTenant(await op));
      assert.equal(await comprovantesDe(cA.pagamento), antes);
    });

    // ================================================================ 7 — cross-tenant real
    await t.test("C1/C3 cross-tenant real: pagamento, recebimento, parcela, comprovante, estorno, plano, recebimento e GET de outra empresa", async () => {
      const u = await ator(adm, A);
      const antesB = await comprovantesDe(cB.pagamento);
      const contarB = () => contar(
        `SELECT (SELECT count(*) FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id = e.recebimento_id WHERE r.pagamento_id = $1::uuid)
              + (SELECT count(*) FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid)
              + (SELECT count(*) FROM pagamento_planos WHERE pagamento_id = $1::uuid) AS n`, [cB.pagamento]);
      const linhasB = await contarB();
      // Pagamento de outra empresa: a posse recusa antes de qualquer leitura/trava do recurso.
      for (const [nome, w] of [
        ["comprovante", (tx: Tx) => comprovante(cB.pagamento, cB.recebimento, tx, u.usuarioId)],
        ["estorno", (tx: Tx) => pag.registrarEstornoPagamento({ pagamentoId: cB.pagamento, recebimentoId: cB.recebimento, parcelaId: cB.parcela, valor: "1.00", confirmarAgora: false, chaveIdempotencia: randomUUID() }, { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx })],
        ["plano", (tx: Tx) => pag.substituirPlanoPagamento(cB.pagamento, { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: 100, vencimento: "2026-12-01" }] }, "troca", { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx })],
        ["recebimento", (tx: Tx) => pag.registrarRecebimentoPagamento({ pagamentoId: cB.pagamento, meioPagamento: "PIX", valorBruto: "1.00", confirmarAgora: false, alocacoes: [{ parcelaId: cB.parcela, valor: "1.00" }] }, { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx })],
      ] as const) {
        await assert.rejects(naPosse(u.sessao, cB.pagamento, ct.pagamentoNoTenant, w), recusa404, nome);
      }
      await assert.rejects(naPosse(u.sessao, cB.fechamento, ct.fechamentoNoTenant, (tx) => pag.obterPagamentoPorFechamento(cB.fechamento, tx)), recusa404, "GET por fechamento");
      assert.equal(await comprovantesDe(cB.pagamento), antesB);
      assert.equal(await contarB(), linhasB, "nada escrito no pagamento da outra empresa");
      // Vínculos filhos estrangeiros num pagamento PRÓPRIO: o serviço recusa (recebimento/parcela/alocação de B).
      const antesA = await comprovantesDe(cA.pagamento);
      await assert.rejects(naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, (tx) => comprovante(cA.pagamento, cB.recebimento, tx, u.usuarioId)), "recebimento estrangeiro");
      await assert.rejects(naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, (tx) => pag.registrarEstornoPagamento({ pagamentoId: cA.pagamento, recebimentoId: cA.recebimento, parcelaId: cB.parcela, valor: "1.00", confirmarAgora: false, chaveIdempotencia: randomUUID() }, { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx })), (e: unknown) => (e as { code?: string }).code === "PARCELA_NAO_ENCONTRADA", "parcela estrangeira no estorno");
      await assert.rejects(naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, (tx) => pag.registrarRecebimentoPagamento({ pagamentoId: cA.pagamento, meioPagamento: "PIX", valorBruto: "1.00", confirmarAgora: false, alocacoes: [{ parcelaId: cB.parcela, valor: "1.00" }] }, { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx })), "parcela estrangeira na alocação");
      assert.equal(await comprovantesDe(cA.pagamento), antesA);
    });

    await t.test("C3 real: a checagem do beneficiário (SQL exata do serviço) só aceita cliente da empresa do contrato, na transação do tenant", async () => {
      // O fluxo completo de devolução exige contrato ASSINADO (posição financeira); formalizar um contrato no
      // descartável exige a 019 (duas assinaturas + Festa) — fora do alcance de fixture. Aqui roda-se, em dados
      // REAIS e dentro da transação real do tenant, a MESMA consulta que o serviço usa antes do INSERT.
      const fonte = readFileSync(resolve(root, "lib/pagamentos/services/devolucao.service.ts"), "utf8");
      const sql = (fonte.match(/'(SELECT cl\.id FROM clientes cl [^']+)'/) ?? [])[1];
      assert.ok(sql, "consulta do beneficiário encontrada no serviço");
      const u = await ator(adm, A);
      const clienteA = await cliente(adm, A);
      const clienteB = await cliente(adm, B);
      const clienteLegado = await cliente(adm, null);
      const aceita = (beneficiario: string) => naPosse(u.sessao, cA.contrato, ct.contratoNoTenant, async (tx) => (await tx.query(sql, [cA.contrato, beneficiario])).rows.length === 1);
      assert.equal(await aceita(clienteA), true, "mesma empresa");
      assert.equal(await aceita(cA.cliente), true, "o próprio cliente do fechamento");
      assert.equal(await aceita(clienteB), false, "outra empresa (a FK global aceitaria)");
      assert.equal(await aceita(clienteLegado), false, "legado sem empresa");
      assert.equal(await aceita(randomUUID()), false, "inexistente");
      assert.equal(Number((await adm.query<{ n: number }>("SELECT count(*)::int AS n FROM clientes WHERE id = $1::uuid", [clienteB])).rows[0].n), 1, "o cliente estrangeiro existe: só a empresa o recusa");
      // Tenant incorreto: a posse do contrato de B nem abre.
      await assert.rejects(naPosse(u.sessao, cB.contrato, ct.contratoNoTenant, async (tx) => (await tx.query(sql, [cB.contrato, clienteB])).rows.length), recusa404);
    });

    // ================================================================ D1 — leitura sensível na transação da prova
    const adminSvc = exigir(resolve(root, "lib/contratos/services/administrativo.service.ts")) as { detalheAdministrativo(id: string, tx?: Tx): Promise<{ contrato: { id: string }; versoes: unknown[]; financeiro: unknown[] }> };
    const contratoSvc = exigir(resolve(root, "lib/contratos/services/contrato.service.ts")) as { obterContratoPorFechamento(f: string, tx?: Tx): Promise<{ contrato: { id: string }; versao: { id: string } }> };
    const publicoSvc = exigir(resolve(root, "lib/contratos/services/contrato-publico.service.ts")) as {
      adquirirPdfContratoAdmin(f: string, tx: Tx): Promise<unknown>;
      adquirirResumoContratoAdmin(f: string, tx: Tx): Promise<{ contrato: { id: string }; versao: { id: string } }>;
    };
    const exportacao = exigir(resolve(root, "lib/contratos/services/exportacao-tenant.ts")) as {
      exportarContratoDoTenant<A, R>(s: Sessao, e: string | null, f: string, d: { withTenantTransaction: ComTenant; adquirir(f: string, tx: Tx): Promise<A>; renderizar(a: A): R }): Promise<R>;
    };
    const resumoTenant = exigir(resolve(root, "lib/contratos/services/resumo-tenant.ts")) as {
      resumoContratacaoDoTenant<P, F>(s: Sessao, e: string | null, id: string, d: { withTenantTransaction: ComTenant; painel(id: string, tx: Tx): Promise<P>; financeiro(id: string, tx: Tx): Promise<F> }): Promise<{ painel: P; financeiro: F | null }>;
    };
    /** Uso do pool da aplicação (connect/query): prova que a renderização depois do commit não consulta. */
    const uso = { n: 0 };
    const poolConnect = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
    const poolQuery = pool.query.bind(pool) as (...a: unknown[]) => unknown;
    (pool as unknown as { connect: (...a: unknown[]) => unknown }).connect = (...a: unknown[]) => { uso.n += 1; return poolConnect(...a); };
    (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => { uso.n += 1; return poolQuery(...a); };
    const leituras = {
      painel: (u: { sessao: Sessao }, contrato: string) => naPosse(u.sessao, contrato, ct.contratoNoTenant, (tx) => adminSvc.detalheAdministrativo(contrato, tx)),
      contrato: (u: { sessao: Sessao }, fechamento: string) => naPosse(u.sessao, fechamento, ct.fechamentoNoTenant, (tx) => contratoSvc.obterContratoPorFechamento(fechamento, tx)),
      resumoDados: (u: { sessao: Sessao }, contrato: string) => resumoTenant.resumoContratacaoDoTenant(u.sessao, null, contrato, { withTenantTransaction, painel: (id, tx) => adminSvc.detalheAdministrativo(id, tx), financeiro: async (_id, tx) => ({ mesmoTx: Boolean(tx) }) }),
      resumoPdf: (u: { sessao: Sessao }, fechamento: string, renderizar: (d: { contrato: { id: string }; versao: { id: string } }) => unknown = (d) => d) =>
        exportacao.exportarContratoDoTenant(u.sessao, null, fechamento, { withTenantTransaction, adquirir: publicoSvc.adquirirResumoContratoAdmin, renderizar }),
      pdf: (u: { sessao: Sessao }, fechamento: string) => exportacao.exportarContratoDoTenant(u.sessao, null, fechamento, { withTenantTransaction, adquirir: publicoSvc.adquirirPdfContratoAdmin, renderizar: (d) => d }),
    };

    await t.test("D1 real: leitura própria (painel, contrato por fechamento, Resumo dados/PDF, PDF) acontece dentro da prova; outra empresa ⇒ 404", async () => {
      const u = await ator(adm, A);
      assert.equal((await leituras.painel(u, cA.contrato)).contrato.id, cA.contrato);
      assert.equal((await leituras.contrato(u, cA.fechamento)).contrato.id, cA.contrato);
      assert.equal((await leituras.resumoDados(u, cA.contrato)).painel.contrato.id, cA.contrato);
      // /pdf: o documento é adquirido NA transação; a edição da fixture não foi revisada ⇒ o mesmo 409 de antes.
      await assert.rejects(leituras.pdf(u, cA.fechamento), (e: unknown) => (e as { httpStatus?: number; message?: string }).httpStatus === 409 && /não revisado/.test(String((e as Error).message)));
      // Resumo em PDF: aquisição no tx; renderização depois do COMMIT, sem transação aberta e sem nenhum uso do pool.
      let visto: { transacoes: number; usoDurante: number } | undefined;
      const r = await leituras.resumoPdf(u, cA.fechamento, (d) => {
        const antes = uso.n;
        const dados = { contrato: d.contrato.id, versao: d.versao.id };
        visto = { transacoes: -1, usoDurante: uso.n - antes };
        return dados;
      }) as { contrato: string };
      assert.equal(r.contrato, cA.contrato);
      assert.equal(visto?.usoDurante, 0, "renderizar não consulta o banco");
      assert.equal(await transacoesDoPool(adm), 0, "nenhuma transação ficou aberta para a renderização");
      for (const [nome, leitura] of [
        ["painel", () => leituras.painel(u, cB.contrato)], ["contrato", () => leituras.contrato(u, cB.fechamento)], ["resumo", () => leituras.resumoDados(u, cB.contrato)],
        ["resumo pdf", () => leituras.resumoPdf(u, cB.fechamento)], ["pdf", () => leituras.pdf(u, cB.fechamento)],
      ] as const) await assert.rejects(leitura(), recusa404, `outra empresa: ${nome}`);
    });

    await t.test("D1 real: membership revogada antes, empresa suspensa antes e papel atual ⇒ recusa antes de qualquer leitura", async () => {
      const revogado = await ator(adm, A);
      await adm.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [revogado.membershipId]);
      const E = await empresa(adm, "D1 suspensa");
      const cE = await cadeia(adm, E);
      const suspenso = await ator(adm, E);
      await adm.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [E]);
      for (const [nome, leitura] of [
        ["revogada: painel", () => leituras.painel(revogado, cA.contrato)], ["revogada: resumo pdf", () => leituras.resumoPdf(revogado, cA.fechamento)],
        ["suspensa: painel", () => leituras.painel(suspenso, cE.contrato)], ["suspensa: contrato", () => leituras.contrato(suspenso, cE.fechamento)],
      ] as const) await assert.rejects(leitura(), recusaTenant, nome);
      // Papel: a sessão diz REPRESENTANTE, o banco diz ADMINISTRATIVO (trocado e confirmado) ⇒ vale o banco.
      const u = await ator(adm, A);
      await adm.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [u.membershipId]);
      let leu = false;
      await assert.rejects(ct.executarComPosseNoTenant(u.sessao, null, cA.contrato, ct.contratoNoTenant, deps, async (tx) => { leu = true; return adminSvc.detalheAdministrativo(cA.contrato, tx); }, ["REPRESENTANTE_AUTORIZADO"]), (e: unknown) => (e as { code?: string }).code === "PAPEL_NAO_AUTORIZADO");
      assert.equal(leu, false, "nenhuma leitura com papel atual não autorizado");
    });

    await t.test("D1 real: revogação/troca de papel concorrente não intercala com a leitura (nas duas ordens)", async () => {
      // Leitura primeiro: a revogação ESPERA o commit da leitura; depois dela, nova leitura é recusada.
      const u = await ator(adm, A);
      const b = barreira();
      let pidLeitura = 0;
      const leitura = naPosse(u.sessao, cA.contrato, ct.contratoNoTenant, async (tx) => {
        const painel = await adminSvc.detalheAdministrativo(cA.contrato, tx);
        pidLeitura = Number((await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
        await b.aberta;
        return painel;
      });
      while (!pidLeitura) await new Promise((ok) => setTimeout(ok, 10));
      assert.equal(await transacoesDoPool(adm), 1, "a leitura usa a transação da prova (nenhuma paralela)");
      t.diagnostic(`D1 travas da leitura até o commit: ${(await travasDe(adm, pidLeitura)).join(" ")}`);
      const revogar = c2.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [u.membershipId]);
      const espera = await esperarBloqueio(adm, { bloqueador: pidLeitura });
      t.diagnostic(`D1 revogação bloqueada: pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
      b.soltar();
      assert.equal((await leitura).contrato.id, cA.contrato, "leitura com autoridade válida no momento");
      await revogar;
      await assert.rejects(leituras.painel(u, cA.contrato), recusaTenant, "depois da revogação");

      // Revogação primeiro (sem commit): a leitura ESPERA e, após o commit, é recusada sem ler nada.
      const v = await ator(adm, A);
      await c2.query("BEGIN");
      await c2.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [v.membershipId]);
      const pidRev = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
      let leu = false;
      const bloqueada = naPosse(v.sessao, cA.contrato, ct.contratoNoTenant, async (tx) => { leu = true; return adminSvc.detalheAdministrativo(cA.contrato, tx); }).then(() => "leu", (e) => e);
      const espera2 = await esperarBloqueio(adm, { bloqueador: pidRev });
      t.diagnostic(`D1 leitura bloqueada pela revogação: pid ${espera2.pid} ← ${JSON.stringify(espera2.bloqueadores)} (${espera2.locktype})`);
      await c2.query("COMMIT");
      assert.ok(recusaTenant(await bloqueada));
      assert.equal(leu, false, "nada lido depois da revogação");

      // Troca de papel concorrente: a linha do usuário está travada pela prova; a troca espera o commit da leitura.
      const w = await ator(adm, A);
      const b2 = barreira();
      let pidL2 = 0;
      const leitura2 = naPosse(w.sessao, cA.fechamento, ct.fechamentoNoTenant, async (tx) => {
        const dados = await contratoSvc.obterContratoPorFechamento(cA.fechamento, tx);
        pidL2 = Number((await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
        await b2.aberta;
        return dados;
      });
      while (!pidL2) await new Promise((ok) => setTimeout(ok, 10));
      const trocar = c2.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [w.membershipId]);
      const espera3 = await esperarBloqueio(adm, { bloqueador: pidL2 });
      t.diagnostic(`D1 troca de papel bloqueada: pid ${espera3.pid} ← ${JSON.stringify(espera3.bloqueadores)} (${espera3.locktype}) aguardando: ${espera3.consulta}`);
      b2.soltar();
      assert.equal((await leitura2).contrato.id, cA.contrato);
      await trocar;
    });

    // ================================================================ D2 — lock do recebimento escopado pelo pagamento
    await t.test("D2 real: recebimento de outro pagamento/empresa nunca é travado; o próprio é travado pelo lock escopado", async () => {
      const u = await ator(adm, A);
      const cA2 = await cadeia(adm, A);
      const estorno = (tx: Tx, recebimentoId: string) => pag.registrarEstornoPagamento(
        { pagamentoId: cA.pagamento, recebimentoId, parcelaId: cA.parcela, valor: 1, confirmarAgora: false, chaveIdempotencia: randomUUID() },
        { origem: "PAGAMENTO_INTERNO_DEV", usuarioId: u.usuarioId, executor: tx },
      );
      // c2 segura FOR UPDATE nos recebimentos estrangeiros: se o estorno tentasse travá-los, esperaria (lock_timeout ⇒ 55P03).
      await c2.query("BEGIN");
      await c2.query("SELECT id FROM pagamento_recebimentos WHERE id = ANY($1::uuid[]) FOR UPDATE", [[cA2.recebimento, cB.recebimento]]);
      const respostas: string[] = [];
      try {
        for (const [nome, recebimentoId] of [["outro pagamento da mesma empresa", cA2.recebimento], ["outra empresa", cB.recebimento], ["inexistente", randomUUID()]] as const) {
          const inicio = Date.now();
          const r = await naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => {
            await tx.query("SET LOCAL lock_timeout = '2s'");
            return estorno(tx, recebimentoId);
          }).then(() => ({ code: "PASSOU", message: "" }), (e) => e as { code?: string; message?: string });
          assert.equal(r.code, "ESTORNO_INVALIDO", `${nome}: ${r.code} ${r.message}`);
          assert.ok(Date.now() - inicio < 2000, `${nome}: não esperou trava alheia`);
          respostas.push(`${r.code}|${r.message}`);
        }
      } finally {
        await c2.query("ROLLBACK");
      }
      assert.equal(new Set(respostas).size, 1, "não enumerável: outro pagamento, outra empresa e inexistente respondem igual");

      // Recebimento PRÓPRIO: o lock escopado trava a linha (espera quem a segura) e depois segue a validação.
      await c2.query("BEGIN");
      await c2.query("SELECT id FROM pagamento_recebimentos WHERE id = $1::uuid FOR UPDATE", [cA.recebimento]);
      const pidC2 = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
      const op = naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, (tx) => estorno(tx, cA.recebimento)).then(() => "passou", (e) => e as Error & { code?: string });
      try {
        const espera = await esperarBloqueio(adm, { bloqueador: pidC2 });
        const consulta = (await adm.query<{ q: string }>("SELECT query AS q FROM pg_stat_activity WHERE pid = $1", [espera.pid])).rows[0].q;
        t.diagnostic(`D2 estorno do recebimento próprio espera a linha: pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype})`);
        assert.match(consulta, /FROM pagamento_recebimentos\s+WHERE id = \$1::uuid\s+AND pagamento_id = \$2::uuid\s+LIMIT 1\s+FOR UPDATE/, "a trava que espera é a escopada pelo pagamento");
      } finally {
        await c2.query("ROLLBACK");
      }
      // Liberada a linha, o estorno passa pela validação do recebimento (próprio, confirmado) e chega à posição
      // financeira, que exige versão ASSINADA — a fixture não formaliza contrato (019: duas assinaturas + Festa;
      // ver C3). Nada é gravado: o erro de domínio desfaz a transação.
      const fim = await op as Error & { code?: string };
      assert.notEqual(fim.message, "O estorno exige recebimento confirmado deste Pagamento.", "o recebimento próprio é aceito pelo lock escopado");
      assert.equal(fim.message, "Versão assinada não encontrada.", `parou depois do recebimento: ${fim.message}`);
      assert.equal(await contar(`SELECT count(*)::int AS n FROM pagamento_estornos WHERE recebimento_id = $1::uuid`, [cA.recebimento]), 0, "nada gravado");
    });

    // ================================================================ 8 — rollback
    await t.test("rollback: falha controlada depois da escrita dentro da transação do tenant não deixa escrita parcial", async () => {
      const u = await ator(adm, A);
      const antes = await comprovantesDe(cA.pagamento);
      const audit = () => contar(`SELECT count(*)::int AS n FROM auditoria WHERE entidade_tipo LIKE 'PAGAMENTO%' AND usuario_id = $1::uuid`, [u.usuarioId]);
      const auditAntes = await audit();
      await assert.rejects(naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, async (tx) => {
        await comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId);
        throw new Error("falha controlada depois da escrita");
      }), /falha controlada/);
      assert.equal(await comprovantesDe(cA.pagamento), antes, "comprovante desfeito");
      assert.equal(await audit(), auditAntes, "auditoria desfeita junto");
      assert.equal(await transacoesDoPool(adm), 0, "nenhuma transação ficou aberta");
    });

    // ================================================================ Caso D — Human Gate real (055a+055b)
    await t.test("Caso D: Human Gate real — replay duplicado concorrente executa uma vez; troca de papel concorrente e rollback", async () => {
      const ler = (f: string) => readFileSync(resolve(root, f), "utf8");
      await adm.query(ler("database/migrations/20260928_055a_inteligencia_uso.sql"));
      await adm.query(ler("database/migrations/20260928_055b_inteligencia_operacoes.sql"));
      instalou055 = true;
      const { criarModuloAcoes } = exigir(resolve(root, "lib/inteligencia/acoes/modulo.ts")) as { criarModuloAcoes: (l: unknown[], g: unknown) => { iniciar: (c: string, t: string, ctx: unknown) => Promise<{ resposta: { tipo: string; rascunho: { operacaoId: string; versao: number; payloadHash: string } } }> } };
      const { atenderOperacao } = exigir(resolve(root, "lib/inteligencia/acoes/operacoes.ts")) as { atenderOperacao: (p: unknown, d: unknown) => Promise<{ status: number; corpo: { codigo?: string } }> };
      const { repositorioOperacoesPostgres } = exigir(resolve(root, "lib/ia-persistencia/operacoes.ts")) as { repositorioOperacoesPostgres: unknown };
      let pausa: { aberta: Promise<void> } | null = null;
      let falhar = false;
      let pidExec = 0;
      // Ação SINTÉTICA de teste (o motor do Human Gate, o repositório e as travas são os reais). Desde a Policy V1 toda
      // ação precisa de manifesto no Tool Registry (sem ele: recusa fail-closed); a sintética usa a capacidade CONFIRM
      // manifestada `criar_pacote` (mesmo papel e grupo), sem registrar manifesto novo em tempo de execução.
      const acao = {
        nome: "gates.categoria", capacidade: "criar_pacote", classe: "CONFIRM", grupo: "ADMIN_ACTIONS", papeis: ["REPRESENTANTE_AUTORIZADO"],
        descricao: "gate", titulo: "Categoria de teste", origem: "CONVERSA", campos: [],
        extrair: () => ({ nome: `${PREFIXO} categoria ${randomUUID().slice(0, 6)}` }), faltando: () => [],
        validar: (p: Record<string, unknown>) => p, verificar: async (_tx: Tx, _t: Tenant, p: Record<string, unknown>) => ({ payload: p, avisos: [] }),
        apresentar: (p: Record<string, unknown>) => [{ id: "nome", rotulo: "Nome", valor: String(p.nome ?? ""), obrigatorio: true }],
        async executar(tx: Tx, tenant: Tenant, p: Record<string, unknown>) {
          const id = (await tx.query<{ id: string }>(`INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', $2) RETURNING id::text AS id`, [tenant.empresaComprovada, p.nome])).rows[0].id;
          pidExec = Number((await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
          if (pausa) await pausa.aberta;
          if (falhar) throw new Error("falha controlada no domínio");
          return { mensagem: "ok", entidadeId: id };
        },
      };
      const modulo = criarModuloAcoes([acao], { repositorio: repositorioOperacoesPostgres, agora: () => new Date(), novoId: randomUUID, ttlConfirmacaoSegundos: 600 });
      const env = { INTELIGENCIA_ENABLED: "true", AI_ADMIN_ACTIONS_ENABLED: "true" };
      const preview = async (s: Sessao) => (await withTenantTransaction(s, null, (tx, tenant) => modulo.iniciar("criar_pacote", "criar", { tx, tenant, sessao: s, correlationId: randomUUID() }))).resposta.rascunho;
      const confirmar = (s: Sessao, r: { operacaoId: string; versao: number; payloadHash: string }) => atenderOperacao(
        { lerCorpo: async () => ({ operacaoId: r.operacaoId, versao: r.versao, payloadHash: r.payloadHash, decisao: "confirmar" }), empresaSolicitada: null },
        { env, autenticar: async () => s, withTenantTransaction, agora: () => new Date(), requestId: randomUUID, registrar: () => {}, acoes: modulo },
      );
      const categorias = () => contar(`SELECT count(*)::int AS n FROM financeiro_categorias WHERE nome LIKE $1`, [`${PREFIXO} categoria%`]);
      const estado = async (id: string) => (await adm.query<{ estado: string }>(`SELECT estado FROM ia_operacoes WHERE id = $1::uuid`, [id])).rows[0]?.estado;

      // D1: duplo clique concorrente — um executa; o outro espera a trava do rascunho e devolve o gravado.
      const u1 = await ator(adm, A);
      const r1 = await preview(u1.sessao);
      const antes = await categorias();
      pausa = barreira();
      const p1 = confirmar(u1.sessao, r1);
      while (!pidExec) await new Promise((ok) => setTimeout(ok, 10));
      const p2 = confirmar(u1.sessao, r1);
      const espera = await esperarBloqueio(adm, { bloqueador: pidExec });
      t.diagnostic(`D1 replay concorrente bloqueado: pid ${espera.pid} ← ${JSON.stringify(espera.bloqueadores)} (${espera.locktype}) aguardando: ${espera.consulta}`);
      (pausa as unknown as { soltar: () => void }).soltar();
      const [s1, s2] = await Promise.all([p1, p2]);
      pausa = null;
      assert.deepEqual([s1.status, s2.status], [200, 200]);
      assert.equal(await categorias(), antes + 1, "domínio executado UMA vez");
      assert.equal(await estado(r1.operacaoId), "EXECUTADA");

      // D2: papel trocado depois da execução ⇒ replay recusado (autoridade atual), nada re-executa.
      await adm.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [u1.membershipId]);
      assert.equal((await confirmar(u1.sessao, r1)).status, 403, "sessão diz representante; papel persistido manda");
      assert.equal(await categorias(), antes + 1);

      // D3: troca de papel concorrente ANTES da confirmação (sem commit) ⇒ a confirmação espera e é recusada.
      const u2 = await ator(adm, A);
      const r2 = await preview(u2.sessao);
      await c2.query("BEGIN");
      await c2.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [u2.membershipId]);
      const pidPapel = Number((await c2.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
      const conf = confirmar(u2.sessao, r2);
      const esperaPapel = await esperarBloqueio(adm, { bloqueador: pidPapel });
      t.diagnostic(`D3 confirmação bloqueada pela troca de papel: pid ${esperaPapel.pid} ← ${JSON.stringify(esperaPapel.bloqueadores)} (${esperaPapel.locktype}) aguardando: ${esperaPapel.consulta}`);
      await c2.query("COMMIT");
      assert.equal((await conf).status, 403);
      assert.equal(await estado(r2.operacaoId), "AGUARDANDO_CONFIRMACAO", "Human Gate não fica em estado impossível");
      assert.equal(await categorias(), antes + 1);

      // D4: falha do domínio depois do INSERT ⇒ tudo desfeito; o rascunho continua confirmável.
      const u3 = await ator(adm, A);
      const r3 = await preview(u3.sessao);
      falhar = true;
      const falha = await confirmar(u3.sessao, r3);
      falhar = false;
      assert.notEqual(falha.status, 200);
      assert.equal(await estado(r3.operacaoId), "AGUARDANDO_CONFIRMACAO");
      assert.equal(await categorias(), antes + 1, "nenhum commit parcial");
      assert.equal((await confirmar(u3.sessao, r3)).status, 200, "depois da falha a mesma confirmação executa uma vez");
      assert.equal(await categorias(), antes + 2);
      assert.equal(await transacoesDoPool(adm), 0);
    });

    // ================================================================ 9 — deadlocks
    await t.test("sem deadlock: operações concorrentes da mesma empresa serializam na ordem usuário → empresa → membership", async () => {
      // Fixtures em sequência: o cliente administrativo é um só (consultas paralelas nele são depreciadas no pg).
      const us = [await ator(adm, A), await ator(adm, A), await ator(adm, A)];
      const antes = await comprovantesDe(cA.pagamento);
      const deadlocksAntes = Number((await adm.query<{ n: number }>("SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()")).rows[0].n);
      await Promise.all(us.flatMap((u) => [1, 2].map(() => naPosse(u.sessao, cA.pagamento, ct.pagamentoNoTenant, (tx) => comprovante(cA.pagamento, cA.recebimento, tx, u.usuarioId)))));
      assert.equal(await comprovantesDe(cA.pagamento), antes + 6);
      const deadlocksDepois = Number((await adm.query<{ n: number }>("SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()")).rows[0].n);
      t.diagnostic(`deadlocks no banco: antes ${deadlocksAntes}, depois ${deadlocksDepois}`);
      assert.equal(deadlocksDepois, deadlocksAntes, "nenhum deadlock");
    });
  } finally {
    if (instalou055) {
      for (const sql of [
        "DROP VIEW IF EXISTS ia_operacoes_resumo", "DROP TABLE IF EXISTS ia_operacoes", "DROP FUNCTION IF EXISTS kidmais_055_operacao_guarda()",
        "DROP VIEW IF EXISTS ia_uso_diario", "DROP TABLE IF EXISTS ia_uso_modelo", "DROP TABLE IF EXISTS ia_orcamento_reservas",
        "DROP FUNCTION IF EXISTS kidmais_055a_reserva_guarda()", "DROP FUNCTION IF EXISTS kidmais_055_somente_insercao()",
      ]) await adm.query(sql).catch(() => undefined);
    }
    await c2.query("ROLLBACK").catch(() => undefined);
    await c2.end().catch(() => undefined);
    g.__kidmaisPgPool = poolAnterior;
    await pool.end().catch(() => undefined);
    await encerrarDescartavel(admCliente);
  }
});
