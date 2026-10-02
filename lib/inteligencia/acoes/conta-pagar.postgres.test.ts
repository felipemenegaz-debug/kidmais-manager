import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { criarContaPagar, garantirCategorias, listarCategoriasDespesa } from "../../financeiro/servico.ts";
import { repositorioOperacoesPostgres } from "../../ia-persistencia/operacoes.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import type { AIResponse } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";
import { criarAcaoContaPagar, type PortaContaPagar } from "./conta-pagar.ts";
import { criarModuloAcoes } from "./modulo.ts";
import { atenderOperacao } from "./operacoes.ts";

/**
 * Conta a pagar pela IA no PostgreSQL descartável REAL (nunca staging/produção): Human Gate gravado em `ia_operacoes`
 * (055b instalada só dentro desta transação) e o serviço oficial do financeiro. Os mocks da suíte de aceite não
 * provam a gravação; aqui: nada grava antes do clique, flag/allowlist de agora barram o clique, a recorrência cria
 * 12 contas numa série, e replay/retry com a mesma chave não duplica. Tudo é desfeito no fim (ROLLBACK).
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP_055B = ler("database/migrations/20260928_055b_inteligencia_operacoes.sql");
const PORTA: PortaContaPagar = { categorias: listarCategoriasDespesa, criar: criarContaPagar };
const LIGADO: Ambiente = { INTELIGENCIA_ENABLED: "true", AI_ADMIN_ACTIONS_ENABLED: "true" };
const codigo = () => `cp${randomBytes(4).toString("hex")}`;

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function empresa(db: Client, nome: string) {
  const id = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [codigo(), nome])).rows[0].id;
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function usuarioDa(db: Client, empresaId: string) {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Conta a pagar teste', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id`,
    [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`],
  )).rows[0].id;
  const m = (await db.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, id],
  )).rows[0].id;
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return id;
}

test("conta a pagar pela IA: Human Gate em ia_operacoes, recorrência de 12 meses e idempotência no PostgreSQL", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number; cluster: string }>("SELECT current_database() AS db, inet_server_port() AS port, current_setting('cluster_name') AS cluster");
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    assert.equal(ident.rows[0].cluster, "kidmais_descartavel");

    await db.query("BEGIN");
    await db.query(semTransacaoExplicita(UP_055B));
    const empresaA = await empresa(db, "Conta a pagar A");
    const empresaB = await empresa(db, "Conta a pagar B");
    const usuarioA = await usuarioDa(db, empresaA);
    const usuarioB = await usuarioDa(db, empresaB);
    const tx = executor(db);
    await garantirCategorias(tx, empresaA);

    const modulo = criarModuloAcoes([criarAcaoContaPagar(PORTA)], { repositorio: repositorioOperacoesPostgres, agora: () => new Date(), novoId: randomUUID, ttlConfirmacaoSegundos: 600 });
    const sessaoA: SessaoParaTenant = { usuario_id: usuarioA, papel: "ADMINISTRATIVO" };
    const sessaoB: SessaoParaTenant = { usuario_id: usuarioB, papel: "ADMINISTRATIVO" };
    const noTenant = <T>(sessao: SessaoParaTenant, fn: (ctx: Parameters<typeof modulo.iniciar>[2]) => Promise<T>) =>
      executarNoTenant(tx, sessao, null, (t, tenant) => fn({ tx: t, tenant, sessao, correlationId: randomUUID() }));
    const iniciar = (texto: string) => noTenant(sessaoA, (ctx) => modulo.iniciar("criar_conta_pagar", texto, ctx)).then((r) => r.resposta);
    const responder = (id: string, texto: string) => noTenant(sessaoA, (ctx) => modulo.responder(id, texto, ctx)).then((r) => r.resposta);
    async function decidir(sessao: SessaoParaTenant, d: { operacaoId: string; versao: number; payloadHash: string }, decisao: "confirmar" | "cancelar", env: Ambiente = LIGADO) {
      await db.query("SAVEPOINT clique");
      const r = await atenderOperacao(
        { lerCorpo: async () => ({ operacaoId: d.operacaoId, versao: d.versao, payloadHash: d.payloadHash, decisao }), empresaSolicitada: null },
        { env, autenticar: async () => sessao, withTenantTransaction: (s, e, work) => executarNoTenant(tx, s, e, work), agora: () => new Date(), requestId: () => randomUUID(), registrar: () => {}, acoes: modulo },
      );
      await db.query(r.status === 200 ? "RELEASE SAVEPOINT clique" : "ROLLBACK TO SAVEPOINT clique");
      return r;
    }
    const contas = async (descricao: string) => (await db.query<{ id: string; vencimento: string; valor: string; categoria: string; recorrencia_id: string | null; chave_criacao: string | null; criado_por: string }>(
      `SELECT c.id::text, c.vencimento::text, c.valor::text, cat.nome AS categoria, c.recorrencia_id::text, c.chave_criacao, c.criado_por::text
         FROM financeiro_contas_pagar c JOIN financeiro_categorias cat ON cat.id = c.categoria_id
        WHERE c.empresa_id = $1::uuid AND c.descricao = $2 ORDER BY c.vencimento`, [empresaA, descricao])).rows;
    const operacao = async (id: string) => (await db.query<{ estado: string; versao: number; payload_hash: string; resultado: { entidadeId?: string } | null }>(
      `SELECT estado, versao, payload_hash, resultado FROM ia_operacoes WHERE id = $1::uuid`, [id])).rows[0];
    const auditorias = async (entidadeId: string) => Number((await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM financeiro_auditoria WHERE empresa_id = $1::uuid AND acao = 'CONTA_PAGAR_CRIADA' AND entidade_id = $2::uuid`, [empresaA, entidadeId])).rows[0].n);

    // ------------------------------------------------ recorrente: coleta → revisão, nada gravado antes do clique
    const r1 = await iniciar("adicione conta a pagar todos mes dia 10 do Chat-gpt pro 550 rais.");
    assert.equal(r1.tipo, "rascunho");
    const id = (r1 as Extract<AIResponse, { tipo: "rascunho" }>).rascunho.operacaoId;
    assert.equal((await operacao(id)).estado, "COLETANDO");
    assert.equal((await responder(id, "10/10/2026")).tipo, "rascunho");
    const revisao = await responder(id, "Outros");
    assert.equal(revisao.tipo, "preview");
    const draft = (revisao as Extract<AIResponse, { tipo: "preview" }>).rascunho;
    assert.equal(draft.campos.find((c) => c.id === "recorrente")?.valor, "Mensal — 12 ocorrências");
    assert.equal((await operacao(id)).estado, "AGUARDANDO_CONFIRMACAO");
    assert.deepEqual(await contas("Chat-gpt pro"), [], "revisão não grava");

    // Flag e allowlist de AGORA barram o clique, sem gravar; outra empresa nem enxerga o rascunho.
    assert.equal((await decidir(sessaoA, draft, "confirmar", { INTELIGENCIA_ENABLED: "true" })).status, 503);
    assert.equal((await decidir(sessaoA, draft, "confirmar", { ...LIGADO, AI_TENANT_ALLOWLIST: empresaB })).status, 503);
    assert.equal((await decidir(sessaoB, draft, "confirmar")).status, 404);
    assert.deepEqual(await contas("Chat-gpt pro"), []);
    assert.equal((await operacao(id)).estado, "AGUARDANDO_CONFIRMACAO");

    // ------------------------------------------------ clique: 12 contas numa série, chave = operação
    const ok = await decidir(sessaoA, draft, "confirmar", { ...LIGADO, AI_TENANT_ALLOWLIST: empresaA });
    assert.equal(ok.status, 200);
    const serie = await contas("Chat-gpt pro");
    assert.deepEqual(serie.map((c) => c.vencimento), [
      "2026-10-10", "2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10", "2027-03-10",
      "2027-04-10", "2027-05-10", "2027-06-10", "2027-07-10", "2027-08-10", "2027-09-10",
    ]);
    assert.ok(serie.every((c) => c.valor === "550.00" && c.categoria === "Outros" && c.criado_por === usuarioA && c.chave_criacao === null));
    assert.equal(new Set(serie.map((c) => c.recorrencia_id)).size, 1);
    const recorrencia = (await db.query<{ empresa_id: string; horizonte_meses: number; chave_idempotencia: string }>(
      `SELECT empresa_id::text, horizonte_meses, chave_idempotencia FROM financeiro_recorrencias WHERE id = $1::uuid`, [serie[0].recorrencia_id])).rows[0];
    assert.deepEqual(recorrencia, { empresa_id: empresaA, horizonte_meses: 12, chave_idempotencia: id });
    const executada = await operacao(id);
    assert.equal(executada.estado, "EXECUTADA");
    assert.equal(executada.resultado?.entidadeId, serie[0].id);
    assert.equal(await auditorias(serie[0].id), 1);

    // Replay do clique (duplo clique / retry) e retry do serviço com a mesma chave: nada duplica.
    assert.equal((await decidir(sessaoA, draft, "confirmar")).status, 200);
    assert.equal(await criarContaPagar(tx, empresaA, usuarioA, { descricao: "Chat-gpt pro", valor: 550, vencimento: "2026-10-10", categoriaId: (await listarCategoriasDespesa(tx, empresaA)).find((c) => c.nome === "Outros")!.id, recorrente: true, chave: id }), serie[0].id);
    assert.equal((await contas("Chat-gpt pro")).length, 12);
    assert.equal(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_recorrencias WHERE empresa_id = $1::uuid`, [empresaA])).rows[0].n), 1);
    assert.equal(await auditorias(serie[0].id), 1);

    // ------------------------------------------------ conta única: idempotente pela chave_criacao
    const unica = await iniciar("adicione conta a pagar do Contador 300 reais em 15/10/2026, categoria Outros");
    assert.equal(unica.tipo, "preview");
    const draftUnica = (unica as Extract<AIResponse, { tipo: "preview" }>).rascunho;
    assert.deepEqual(await contas("Contador"), []);
    assert.equal((await decidir(sessaoA, draftUnica, "confirmar")).status, 200);
    assert.equal((await decidir(sessaoA, draftUnica, "confirmar")).status, 200);
    const contador = await contas("Contador");
    assert.deepEqual(contador.map((c) => [c.vencimento, c.valor, c.recorrencia_id, c.chave_criacao]), [["2026-10-15", "300.00", null, draftUnica.operacaoId]]);

    // ------------------------------------------------ cancelada: o clique depois não grava
    const cancelar = await iniciar("adicione conta a pagar do Aluguel extra 120 reais em 20/10/2026, categoria Outros");
    assert.equal(cancelar.tipo, "preview");
    const draftCancelar = (cancelar as Extract<AIResponse, { tipo: "preview" }>).rascunho;
    assert.equal((await decidir(sessaoA, draftCancelar, "cancelar")).status, 200);
    assert.equal((await operacao(draftCancelar.operacaoId)).estado, "CANCELADA");
    assert.notEqual((await decidir(sessaoA, draftCancelar, "confirmar")).status, 200);
    assert.deepEqual(await contas("Aluguel extra"), []);
  } finally {
    await encerrarDescartavel(client);
  }
});
