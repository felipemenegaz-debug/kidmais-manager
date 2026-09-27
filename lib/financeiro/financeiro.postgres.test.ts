import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import {
  criarContaPagar,
  editarContaPagar,
  financeiroDaFesta,
  fluxoCaixa,
  listarContasPagar,
  listarRecebiveis,
  pagarConta,
  prepararBaixa,
  relatorio,
} from "./servico.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration = readFileSync(resolve(root, "database/migrations/20260927_052_financeiro_gerencial.sql"), "utf8");
const precheck = readFileSync(resolve(root, "database/checks/20260927_052_financeiro_precheck.sql"), "utf8");
const postcheck = readFileSync(resolve(root, "database/checks/20260927_052_financeiro_postcheck.sql"), "utf8");
const down = readFileSync(resolve(root, "database/rollback/20260927_052_financeiro_gerencial_down.sql"), "utf8");

function codigo() {
  return `fin${randomBytes(4).toString("hex")}`;
}

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
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
     VALUES ($1, 'Financeiro teste', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`],
  )).rows[0].id;
}

test("financeiro gerencial no postgres descartável", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const outro = await conectarDescartavel({ travar: false });
  const db2 = outro as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);
    await db.query(precheck);
    const existe = await db.query("SELECT to_regclass('public.financeiro_contas_pagar') AS nome");
    if (!existe.rows[0].nome) await db.query(migration);
    await db.query(postcheck);

    await db.query("BEGIN");
    const empresaA = await empresa(db, "Empresa financeira A");
    const empresaB = await empresa(db, "Empresa financeira B");
    const ator = await usuario(db);
    const tx = executor(db);
    const categorias = await tx.query<{ id: string }>(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Aluguel') RETURNING id`,
      [empresaA],
    );
    const categoriaId = categorias.rows[0].id;
    const hoje = "2026-03-18";
    const contaId = await criarContaPagar(tx, empresaA, ator, {
      descricao: "Aluguel da casa",
      favorecido: "Imobiliária",
      categoriaId,
      valor: 100,
      vencimento: "2026-03-01",
    });
    await editarContaPagar(tx, empresaA, ator, contaId, {
      descricao: "Aluguel da casa de festas",
      favorecido: "Imobiliária",
      categoriaId,
      valor: 120,
      vencimento: "2026-03-01",
    });
    const antes = await listarContasPagar(tx, empresaA, hoje);
    assert.equal(antes.find((item) => item.id === contaId)?.status, "Vencido");
    assert.equal((await listarContasPagar(tx, empresaB, hoje)).some((item) => item.id === contaId), false);
    await assert.rejects(
      () => pagarConta(tx, empresaB, ator, { contaId, valor: 10, data: hoje, forma: "PIX", chave: randomUUID() }),
      (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 404,
    );
    const chave = randomUUID();
    const pago = await pagarConta(tx, empresaA, ator, { contaId, valor: 40, data: hoje, forma: "PIX", chave });
    const deNovo = await pagarConta(tx, empresaA, ator, { contaId, valor: 40, data: hoje, forma: "PIX", chave });
    assert.equal(pago.reutilizado, false);
    assert.equal(deNovo.reutilizado, true);
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM financeiro_saidas WHERE conta_id = $1::uuid", [contaId])).rows[0].n, 1);
    await assert.rejects(
      () => pagarConta(tx, empresaA, ator, { contaId, valor: 90, data: hoje, forma: "PIX", chave: randomUUID() }),
      (error: unknown) => error instanceof PacoteAdminError,
    );
    const parcial = (await listarContasPagar(tx, empresaA, hoje)).find((item) => item.id === contaId);
    assert.equal(parcial?.saldoCentavos, 8000);
    await assert.rejects(() => editarContaPagar(tx, empresaA, ator, contaId, {
      descricao: "Não edita", favorecido: null, categoriaId, valor: 120, vencimento: "2026-03-01",
    }));
    const recorrente = await criarContaPagar(tx, empresaA, ator, {
      descricao: "Energia", categoriaId, valor: 30, vencimento: "2026-01-31", recorrente: true,
    });
    const ocorrencias = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM financeiro_contas_pagar WHERE recorrencia_id = (SELECT recorrencia_id FROM financeiro_contas_pagar WHERE id = $1::uuid)`,
      [recorrente],
    );
    assert.equal(ocorrencias.rows[0].n, 12);
    const fluxo = await fluxoCaixa(tx, empresaA, "2026-03-01", "2026-03-31", hoje);
    assert.ok(fluxo.saidasCentavos >= 4000);
    assert.ok(fluxo.linhas.some((linha) => linha.tipo === "realizado" && linha.saida > 0));
    const leitura = await relatorio(tx, empresaA, hoje);
    assert.equal(leitura.aPagarCentavos > 0, true);
    await db.query("ROLLBACK");

    await db.query("BEGIN");
    const dona = await empresa(db, "Empresa concorrencia");
    const ator2 = await usuario(db);
    const categoria = (await db.query<{ id: string }>(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Água') RETURNING id`,
      [dona],
    )).rows[0].id;
    const conta = await criarContaPagar(executor(db), dona, ator2, {
      descricao: "Água", categoriaId: categoria, valor: 100, vencimento: "2026-04-01",
    });
    await pagarConta(executor(db), dona, ator2, { contaId: conta, valor: 60, data: "2026-04-01", forma: "DINHEIRO", chave: randomUUID() });
    await db2.query("BEGIN");
    const corrida = pagarConta(executor(db2), dona, ator2, { contaId: conta, valor: 50, data: "2026-04-01", forma: "PIX", chave: randomUUID() });
    await db.query("COMMIT");
    await assert.rejects(corrida, (error: unknown) => error instanceof PacoteAdminError);
    await db2.query("ROLLBACK");
    await db.query("DELETE FROM financeiro_saidas WHERE empresa_id = $1::uuid", [dona]);
    await db.query("DELETE FROM financeiro_auditoria WHERE empresa_id = $1::uuid", [dona]);
    await db.query("DELETE FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid", [dona]);
    await db.query("DELETE FROM financeiro_categorias WHERE empresa_id = $1::uuid", [dona]);

    await db.query("BEGIN");
    const comDado = await empresa(db, "Empresa down");
    const ator3 = await usuario(db);
    const categoriaDown = (await db.query<{ id: string }>(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Outros') RETURNING id`,
      [comDado],
    )).rows[0].id;
    await criarContaPagar(executor(db), comDado, ator3, {
      descricao: "Não apagar", categoriaId: categoriaDown, valor: 10, vencimento: "2026-05-01",
    });
    await db.query("COMMIT");
    await assert.rejects(() => db.query(down));
    await db.query("ROLLBACK");
    await db.query("DELETE FROM financeiro_auditoria WHERE empresa_id = $1::uuid", [comDado]);
    await db.query("DELETE FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid", [comDado]);
    await db.query("DELETE FROM financeiro_categorias WHERE empresa_id = $1::uuid", [comDado]);
  } finally {
    await encerrarDescartavel(db2, false);
    await encerrarDescartavel(db);
  }
});

test("parcela de contrato aparece só na empresa dona e a baixa parcial respeita o saldo", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    await db.query("BEGIN");
    const empresaA = await empresa(db, "Empresa receber A");
    const empresaB = await empresa(db, "Empresa receber B");
    const ator = await usuario(db);
    const pacote = (await db.query<{ id: string }>(
      `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
       VALUES ($1::uuid, $2, 'Festa Completa', 1, true, true) RETURNING id`,
      [empresaA, codigo().toUpperCase()],
    )).rows[0].id;
    const tabela = (await db.query<{ id: string }>(
      `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela teste', '2026-01-01', false, $2::uuid) RETURNING id`,
      [codigo(), empresaA],
    )).rows[0].id;
    const preco = (await db.query<{ id: string }>(
      `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario)
       VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`,
      [tabela, pacote],
    )).rows[0].id;
    const agenda = (await db.query<{ id: string }>(
      `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao)
       VALUES ($1, 'Agenda teste', '10:00', '18:00', 9) RETURNING id`,
      [codigo()],
    )).rows[0].id;
    const cliente = (await db.query<{ id: string }>(
      `INSERT INTO clientes (nome_completo) VALUES ('Maria Silva') RETURNING id`,
    )).rows[0].id;
    const fechamento = (await db.query<{ id: string }>(
      `INSERT INTO fechamentos (
         data_evento, horario_inicio, horario_fim, configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id,
         categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
         valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status
       ) VALUES ('2026-03-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, 'RASCUNHO') RETURNING id`,
      [agenda, pacote, tabela, preco, cliente],
    )).rows[0].id;
    const contrato = (await db.query<{ id: string }>(
      `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`,
      [fechamento],
    )).rows[0].id;
    const versao = (await db.query<{ id: string }>(
      `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
       VALUES ($1::uuid, 1, 'ASSINADA', '{}'::jsonb, $2, now(), 1, $3, 'OTP') RETURNING id`,
      [contrato, "a".repeat(64), "c".repeat(64)],
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
      `INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento) VALUES ($1::uuid, 1, 100, '2026-03-01') RETURNING id`,
      [plano],
    )).rows[0].id;
    const tx = executor(db);
    const visivel = await listarRecebiveis(tx, empresaA, "2026-03-18");
    assert.equal(visivel.some((item) => item.id === parcela && item.status === "Vencido"), true);
    assert.equal((await listarRecebiveis(tx, empresaB, "2026-03-18")).length, 0);
    const baixa = await prepararBaixa(tx, empresaA, { parcelaId: parcela, valor: 40, data: "2026-03-18", forma: "PIX", taxa: 1 });
    assert.equal(baixa.liquidoCentavos, 3900);
    await assert.rejects(() => prepararBaixa(tx, empresaA, { parcelaId: parcela, valor: 101, data: "2026-03-18", forma: "PIX" }));
    await assert.rejects(() => prepararBaixa(tx, empresaB, { parcelaId: parcela, valor: 10, data: "2026-03-18", forma: "PIX" }));
    const recebimento = (await db.query<{ id: string }>(
      `INSERT INTO pagamento_recebimentos (pagamento_id, status, meio_pagamento, valor_bruto, confirmado_em, chave_idempotencia, metadata_provedor)
       VALUES ($1::uuid, 'CONFIRMADO', 'PIX', 40, now(), $2, '{"forma":"PIX","taxaCentavos":100}'::jsonb) RETURNING id`,
      [pagamento, randomUUID()],
    )).rows[0].id;
    await db.query(
      `INSERT INTO pagamento_recebimento_alocacoes (recebimento_id, parcela_id, valor_alocado) VALUES ($1::uuid, $2::uuid, 40)`,
      [recebimento, parcela],
    );
    const depois = (await listarRecebiveis(tx, empresaA, "2026-03-18")).find((item) => item.id === parcela);
    assert.equal(depois?.status, "Vencido");
    assert.equal(depois?.saldoCentavos, 6000);
    const categoria = (await db.query<{ id: string }>(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Buffet / insumos') RETURNING id`,
      [empresaA],
    )).rows[0].id;
    await assert.rejects(
      () => criarContaPagar(tx, empresaA, ator, { descricao: "Insumo", categoriaId: categoria, valor: 10, vencimento: "2026-03-10", festaId: randomUUID() }),
      (error: unknown) => error instanceof PacoteAdminError,
    );
    await db.query("ALTER TABLE festas DISABLE TRIGGER festa019_invalidacao");
    const festa = (await db.query<{ id: string }>(
      `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
      [contrato, versao, randomUUID(), "b".repeat(64), ator],
    )).rows[0].id;
    const despesa = await criarContaPagar(tx, empresaA, ator, {
      descricao: "Insumo da festa", categoriaId: categoria, valor: 10, vencimento: "2026-03-10", festaId: festa,
    });
    await pagarConta(tx, empresaA, ator, { contaId: despesa, valor: 10, data: "2026-03-10", forma: "PIX", chave: randomUUID() });
    const daFesta = await financeiroDaFesta(tx, empresaA, festa, "2026-03-18");
    assert.equal(daFesta.recebimentos.some((item) => item.id === parcela), true);
    assert.equal(daFesta.custosCentavos, 1000);
    assert.equal(daFesta.margemEstimadaCentavos, daFesta.recebidoCentavos - 1000);
    assert.equal((await financeiroDaFesta(tx, empresaB, festa, "2026-03-18")).recebimentos.length, 0);
    await db.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(db);
  }
});
