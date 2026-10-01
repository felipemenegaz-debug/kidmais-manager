import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "../comercial/postgres-descartavel.ts";
import { criarEntradaManual } from "../financeiro/servico.ts";
import { executarNoTenant, type SessaoParaTenant } from "../saas/provar-tenant.ts";
import { atenderInteligencia, type DependenciasGateway } from "./gateway.ts";

/**
 * Isolamento por empresa da AI Foundation contra o PostgreSQL descartável.
 * Não aplica DDL: exige o schema já instalado pela suíte do Financeiro (052).
 * Todo dado semeado fica dentro de uma transação desfeita no fim (encerrarDescartavel faz ROLLBACK).
 */

function codigo() {
  return `ia${randomBytes(4).toString("hex")}`;
}

type Consulta = { sql: string };

function executor(db: Client, registro?: Consulta[]): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      registro?.push({ sql: text });
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
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
     VALUES ($1, 'Inteligência teste', $2, 'ADMINISTRATIVO', true) RETURNING id`,
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

type Corpo = {
  ok: boolean;
  codigo?: string;
  data?: { estado: string; itens: Array<{ tipo: string; evidencia: { quantidade: number; valorCentavos: number } }> };
};

test("AI Foundation: atencao_hoje isola recebíveis por empresa no postgres descartável", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    const schema = await db.query<{ ok: boolean }>(
      `SELECT to_regclass('public.financeiro_entradas_manuais') IS NOT NULL
          AND to_regclass('public.memberships') IS NOT NULL AS ok`,
    );
    assert.equal(schema.rows[0].ok, true, "Schema 052/043 ausente no descartável: rode antes a suíte check:v1:postgres.");

    await db.query("BEGIN");
    const empresaA = await empresa(db, "Empresa IA A");
    const empresaB = await empresa(db, "Empresa IA B");
    const usuarioA = await usuario(db);
    const usuarioB = await usuario(db);
    const semVinculo = await usuario(db);
    await membership(db, empresaA, usuarioA);
    await membership(db, empresaB, usuarioB);

    const hoje = "2026-03-18";
    const semear = executor(db);
    const entrada = (empresaId: string, ator: string, valor: number, vencimento: string) => criarEntradaManual(semear, empresaId, ator, hoje, {
      descricao: "Sinal", contraparte: "Cliente Sigiloso 123.456.789-09", valor, vencimento, forma: "PIX", status: "A receber", chave: randomUUID(),
    });
    await entrada(empresaA, usuarioA, 100, "2026-03-10");
    await entrada(empresaA, usuarioA, 50, hoje);
    await entrada(empresaB, usuarioB, 777, "2026-03-01");

    const consultasDaIA: Consulta[] = [];
    async function pedir(sessao: SessaoParaTenant, corpo: unknown, empresaSolicitada: string | null = null) {
      const deps: DependenciasGateway = {
        env: { INTELIGENCIA_ENABLED: "true" },
        autenticar: async () => sessao,
        withTenantTransaction: (s, e, work) => executarNoTenant(executor(db, consultasDaIA), s, e, work),
        agora: () => new Date(`${hoje}T15:00:00Z`),
        requestId: () => randomUUID(),
        registrar: () => {},
      };
      const resposta = await atenderInteligencia({ lerCorpo: async () => corpo, empresaSolicitada }, deps);
      return { status: resposta.status, corpo: resposta.corpo as Corpo, texto: JSON.stringify(resposta.corpo) };
    }
    const sessaoA = { usuario_id: usuarioA, papel: "ADMINISTRATIVO" };
    const sessaoB = { usuario_id: usuarioB, papel: "ADMINISTRATIVO" };
    const pedido = { capacidade: "atencao_hoje" };
    const resumo = (corpo: Corpo) => corpo.data?.itens.map((item) => [item.tipo, item.evidencia.quantidade, item.evidencia.valorCentavos]);

    // Empresa A obtém apenas os recebíveis da empresa A.
    const a = await pedir(sessaoA, pedido);
    assert.equal(a.status, 200);
    assert.deepEqual(resumo(a.corpo), [
      ["RECEBIVEIS_VENCIDOS", 1, 10000],
      ["RECEBIVEIS_VENCEM_HOJE", 1, 5000],
      ["A_RECEBER_EM_ABERTO", 2, 15000],
    ]);
    assert.equal(a.texto.includes("777"), false);

    // Empresa B obtém apenas os recebíveis da empresa B.
    const b = await pedir(sessaoB, pedido);
    assert.equal(b.status, 200);
    assert.deepEqual(resumo(b.corpo), [
      ["RECEBIVEIS_VENCIDOS", 1, 77700],
      ["A_RECEBER_EM_ABERTO", 1, 77700],
    ]);

    // A não seleciona B, nem com o id em outra grafia ou adulterado.
    for (const selecao of [empresaB, empresaA.toUpperCase(), `${empresaB}' OR '1'='1`, "  "]) {
      const r = await pedir(sessaoA, pedido, selecao);
      if (selecao.trim() === "") {
        assert.equal(r.status, 200, "seleção vazia equivale a nenhuma seleção");
        assert.equal(r.texto.includes("777"), false);
        continue;
      }
      assert.equal(r.status, 403, selecao);
      assert.equal(r.corpo.codigo, "TENANT_NAO_COMPROVADO", selecao);
      assert.equal(r.texto.includes("777") || r.texto.includes("100,00"), false, selecao);
    }

    // Empresa no corpo não burla provarTenant: o pedido é recusado antes da transação.
    for (const corpo of [{ ...pedido, empresaId: empresaB }, { ...pedido, parametros: { empresaId: empresaB } }]) {
      const antes = consultasDaIA.length;
      const r = await pedir(sessaoA, corpo);
      assert.equal(r.status, 400);
      assert.equal(consultasDaIA.length, antes);
    }

    // Contexto ausente ou inválido falha fechado.
    for (const sessao of [
      { usuario_id: semVinculo, papel: "ADMINISTRATIVO" },
      { usuario_id: randomUUID(), papel: "ADMINISTRATIVO" },
    ]) {
      const r = await pedir(sessao, pedido);
      assert.equal(r.status, 403);
      assert.equal(r.corpo.codigo, "TENANT_NAO_COMPROVADO");
    }
    const b2 = await pedir(sessaoB, pedido, empresaA);
    assert.equal(b2.status, 403);

    // O caminho da IA só leu.
    assert.ok(consultasDaIA.length > 0);
    assert.equal(consultasDaIA.some((c) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(c.sql)), false);
  } finally {
    await encerrarDescartavel(client);
  }
});
