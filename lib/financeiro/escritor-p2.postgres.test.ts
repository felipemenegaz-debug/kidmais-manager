import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "../comercial/postgres-descartavel.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { criarContaPagar, criarEntradaManual, pagarConta } from "./servico.ts";
import { confirmarAbertura, conferirPendencias, leituraAbertura, liquidarEntradaManual, reverterPagamentoConta } from "./escritor-p2.ts";

/**
 * P2 fase B — concorrência real no PostgreSQL descartável (estado declarado "121": 120 e 121 já aplicadas pelo runner).
 * Duas conexões disputam a mesma trava; uma terceira só observa pg_stat_activity para provar que a segunda ESPEROU
 * (sem isso o teste passaria por sorte de ordem). Nada aqui roda sem autorização explícita de PostgreSQL.
 *
 *   1. Duas liquidações da mesma entrada: a segunda espera a trava da entrada e é recusada pelo saldo já baixado.
 *   2. Mesma chave em duas conexões: a segunda espera e devolve o registro da primeira (reutilizado), sem duplicar.
 *   3. Reversão × pagamento: o pagamento espera a trava da conta e enxerga o saldo devolvido pela reversão.
 *   4. Duas reversões do mesmo pagamento: a soma nunca passa do valor pago.
 *   5. Conferência × troca de revisão: a conferência da v1 espera a trava da abertura e recebe VERSAO_DIVERGENTE.
 */

const FLAGS = ["FINANCEIRO_LIQUIDACAO_ATIVA", "FINANCEIRO_REVERSAO_ATIVA", "FINANCEIRO_ABERTURA_ATIVA"] as const;
const HOJE = "2026-11-10";
const ONTEM = "2026-11-09";

function codigo() {
  return `p2b${randomBytes(4).toString("hex")}`;
}

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function pid(db: Client) {
  return Number((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
}

/** Espera até a conexão `alvo` ficar parada numa trava (wait_event_type = Lock). Falha se não acontecer. */
async function esperarTrava(observador: Client, alvo: number) {
  for (let i = 0; i < 400; i++) {
    const r = await observador.query<{ tipo: string | null }>("SELECT wait_event_type AS tipo FROM pg_stat_activity WHERE pid = $1", [alvo]);
    if (r.rows[0]?.tipo === "Lock") return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail("a segunda transação não esperou a trava");
}

/** A abre e executa `primeira` (fica com a trava); B começa `segunda`, que precisa esperar; A confirma; B termina. */
async function disputa<A, B>(
  a: Client, b: Client, observador: Client,
  primeira: (tx: DbExecutor) => Promise<A>,
  segunda: (tx: DbExecutor) => Promise<B>,
) {
  const pidB = await pid(b);
  await a.query("BEGIN");
  await b.query("BEGIN");
  let resultadoA: A;
  try {
    resultadoA = await primeira(executor(a));
  } catch (erro) {
    await a.query("ROLLBACK");
    await b.query("ROLLBACK");
    throw erro;
  }
  const pendente = segunda(executor(b)).then((valor) => ({ valor, erro: null as unknown }), (erro: unknown) => ({ valor: null as B | null, erro }));
  await esperarTrava(observador, pidB);
  await a.query("COMMIT");
  const resultadoB = await pendente;
  await b.query(resultadoB.erro ? "ROLLBACK" : "COMMIT");
  return { a: resultadoA, b: resultadoB };
}

function codigoDoErro(erro: unknown) {
  assert.ok(erro instanceof PacoteAdminError, `esperado PacoteAdminError, veio ${String(erro)}`);
  return erro.code;
}

async function semear(db: Client) {
  await db.query("BEGIN");
  try {
    const empresa = (await db.query<{ id: string }>(
      `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'P2 fase B concorrência', 'PROVISIONAMENTO') RETURNING id`,
      [codigo()],
    )).rows[0].id;
    await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
    const ator = (await db.query<{ id: string }>(
      `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
       VALUES ($1, 'Financeiro P2B', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`],
    )).rows[0].id;
    const tx = executor(db);
    const categoria = (await tx.query<{ id: string }>(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Aluguel') RETURNING id`,
      [empresa],
    )).rows[0].id;
    await db.query("COMMIT");
    return { empresa, ator, categoria };
  } catch (erro) {
    await db.query("ROLLBACK");
    throw erro;
  }
}

async function emTransacao<T>(db: Client, work: (tx: DbExecutor) => Promise<T>) {
  await db.query("BEGIN");
  try {
    const r = await work(executor(db));
    await db.query("COMMIT");
    return r;
  } catch (erro) {
    await db.query("ROLLBACK");
    throw erro;
  }
}

test("P2 fase B: concorrência do escritor no postgres descartável", { timeout: 180_000 }, async (t) => {
  const antes = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) process.env[f] = "true";
  const clienteA = await conectarDescartavel();
  const a = clienteA as unknown as Client;
  const b = (await conectarDescartavel({ travar: false })) as unknown as Client;
  const observador = (await conectarDescartavel({ travar: false })) as unknown as Client;
  try {
    const ident = await a.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    const esquema = (await a.query<{ mov: boolean; ab: boolean }>(
      `SELECT to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL AS mov,
              to_regclass('public.financeiro_aberturas') IS NOT NULL AS ab`,
    )).rows[0];
    assert.ok(esquema.mov && esquema.ab, "estado declarado 121: 120 e 121 precisam estar aplicadas");

    const { empresa, ator, categoria } = await semear(a);

    await t.test("1. duas liquidações da mesma entrada: a segunda espera e é recusada pelo saldo", async () => {
      const entrada = await emTransacao(a, (tx) => criarEntradaManual(tx, empresa, ator, HOJE, {
        descricao: "Entrada avulsa", valor: 100, vencimento: ONTEM, status: "A receber", chave: randomUUID(),
      }));
      const r = await disputa(a, b, observador,
        (tx) => liquidarEntradaManual(tx, empresa, ator, HOJE, { entradaId: entrada.id, valor: 70, data: ONTEM, forma: "PIX", chave: randomUUID() }),
        (tx) => liquidarEntradaManual(tx, empresa, ator, HOJE, { entradaId: entrada.id, valor: 70, data: ONTEM, forma: "PIX", chave: randomUUID() }),
      );
      assert.equal(r.a.reutilizado, false);
      assert.equal(codigoDoErro(r.b.erro), "VALOR_EXCEDE_SALDO");
      const soma = await a.query<{ total: string }>(
        "SELECT COALESCE(SUM(valor), 0)::text AS total FROM financeiro_entradas_liquidacoes WHERE entrada_id = $1::uuid",
        [entrada.id],
      );
      assert.equal(Number(soma.rows[0].total), 70);
    });

    await t.test("2. mesma chave em duas conexões: a segunda espera e reaproveita, sem duplicar", async () => {
      const entrada = await emTransacao(a, (tx) => criarEntradaManual(tx, empresa, ator, HOJE, {
        descricao: "Entrada avulsa 2", valor: 100, vencimento: ONTEM, status: "A receber", chave: randomUUID(),
      }));
      const chave = randomUUID();
      const pedido = { entradaId: entrada.id, valor: 30, data: ONTEM, forma: "PIX" as const, chave };
      const r = await disputa(a, b, observador,
        (tx) => liquidarEntradaManual(tx, empresa, ator, HOJE, pedido),
        (tx) => liquidarEntradaManual(tx, empresa, ator, HOJE, pedido),
      );
      assert.equal(r.b.erro, null, String(r.b.erro));
      assert.equal(r.a.reutilizado, false);
      assert.equal(r.b.valor?.reutilizado, true);
      const n = await a.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM financeiro_entradas_liquidacoes WHERE empresa_id = $1::uuid AND chave_idempotencia = $2",
        [empresa, chave],
      );
      assert.equal(n.rows[0].n, 1);
    });

    await t.test("3. reversão × pagamento: o pagamento espera a conta e vê o saldo devolvido", async () => {
      const contaId = await emTransacao(a, (tx) => criarContaPagar(tx, empresa, ator, { descricao: "Fornecedor", categoriaId: categoria, valor: 160, vencimento: ONTEM }));
      const pago = await emTransacao(a, (tx) => pagarConta(tx, empresa, ator, HOJE, { contaId, valor: 100, data: ONTEM, forma: "PIX", chave: randomUUID() }));
      // Saldo antes: 60. Sem a trava, o pagamento de 100 leria 60 e seria recusado; serializado, lê 120 e passa.
      const r = await disputa(a, b, observador,
        (tx) => reverterPagamentoConta(tx, empresa, ator, HOJE, { contaId, saidaId: pago.id, valor: 60, data: HOJE, motivo: "Pago em duplicidade", chave: randomUUID() }),
        (tx) => pagarConta(tx, empresa, ator, HOJE, { contaId, valor: 100, data: HOJE, forma: "PIX", chave: randomUUID() }),
      );
      assert.equal(r.a.reutilizado, false);
      assert.equal(r.b.erro, null, String(r.b.erro));
      const liquido = await a.query<{ pago: string; revertido: string }>(
        `SELECT (SELECT COALESCE(SUM(valor), 0) FROM financeiro_saidas WHERE conta_id = $1::uuid)::text AS pago,
                (SELECT COALESCE(SUM(r.valor), 0) FROM financeiro_saidas_reversoes r JOIN financeiro_saidas s ON s.id = r.saida_id
                  WHERE s.conta_id = $1::uuid)::text AS revertido`,
        [contaId],
      );
      assert.equal(Number(liquido.rows[0].pago) - Number(liquido.rows[0].revertido), 140);
    });

    await t.test("4. duas reversões do mesmo pagamento: a soma não passa do valor pago", async () => {
      const contaId = await emTransacao(a, (tx) => criarContaPagar(tx, empresa, ator, { descricao: "Fornecedor 2", categoriaId: categoria, valor: 100, vencimento: ONTEM }));
      const pago = await emTransacao(a, (tx) => pagarConta(tx, empresa, ator, HOJE, { contaId, valor: 100, data: ONTEM, forma: "PIX", chave: randomUUID() }));
      const reverter = (tx: DbExecutor) =>
        reverterPagamentoConta(tx, empresa, ator, HOJE, { contaId, saidaId: pago.id, valor: 60, data: HOJE, motivo: "Estorno do banco", chave: randomUUID() });
      const r = await disputa(a, b, observador, reverter, reverter);
      assert.equal(r.a.reutilizado, false);
      assert.equal(codigoDoErro(r.b.erro), "VALOR_EXCEDE_PAGAMENTO");
      const soma = await a.query<{ total: string }>(
        "SELECT COALESCE(SUM(valor), 0)::text AS total FROM financeiro_saidas_reversoes WHERE saida_id = $1::uuid",
        [pago.id],
      );
      assert.equal(Number(soma.rows[0].total), 60);
    });

    await t.test("5. conferência × troca de revisão: a conferência da v1 espera e recebe VERSAO_DIVERGENTE", async () => {
      const inicial = await emTransacao(a, (tx) => leituraAbertura(tx, empresa, null));
      assert.equal(inicial.vigente, null);
      const v1 = await emTransacao(a, (tx) => confirmarAbertura(tx, empresa, ator, {
        dataBase: inicial.previa.dataBase, saldo: 1000, justificativa: "Saldo do extrato", versaoEsperada: 0,
        conjuntoHash: inicial.previa.conjuntoHash, chave: randomUUID(),
      }));
      assert.equal(v1.versao, 1);
      const atual = await emTransacao(a, (tx) => leituraAbertura(tx, empresa, null));
      const r = await disputa(a, b, observador,
        (tx) => confirmarAbertura(tx, empresa, ator, {
          dataBase: atual.previa.dataBase, saldo: 1200, justificativa: "Correção do saldo", versaoEsperada: 1,
          conjuntoHash: atual.previa.conjuntoHash, chave: randomUUID(),
        }),
        (tx) => conferirPendencias(tx, empresa, ator, {
          versaoAbertura: 1, itens: [{ tipo: "ENTRADA_MANUAL", origemId: randomUUID(), atributosHash: "0".repeat(64) }], chave: randomUUID(),
        }),
      );
      assert.equal(r.a.versao, 2);
      assert.equal(codigoDoErro(r.b.erro), "VERSAO_DIVERGENTE");
      const conferidos = await a.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM financeiro_abertura_conferencias WHERE empresa_id = $1::uuid AND modo = 'CONFERIDO'",
        [empresa],
      );
      assert.equal(conferidos.rows[0].n, 0);
    });
  } finally {
    for (const f of FLAGS) {
      if (antes[f] === undefined) delete process.env[f];
      else process.env[f] = antes[f];
    }
    await encerrarDescartavel(observador, false);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(clienteA);
  }
});
