/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { URL } = require("node:url");
const { closeDatabasePool, db, withTransaction } = require("../lib/db/postgres.ts");
const { cadastrarAniversarianteInterno, editarAniversarianteInterno } = require("../lib/clientes/services/aniversariante.service.ts");

class RollbackIntencional extends Error {}

function validarDestino() {
  if (process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO !== "SIM")
    throw new Error("Teste CRM exige KIDMAIS_REGRESSAO_HOMOLOGACAO=SIM.");
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL do clone é obrigatória.");
  if (raw.includes("kidmais_manager")) throw new Error("Banco real recusado.");
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Somente loopback é permitido.");
  if (url.pathname.replace(/\/+$/, "") !== "/kidmais_v1_homologacao") throw new Error("Somente kidmais_v1_homologacao é permitido.");
}

async function contagens() {
  const result = await db().query(`SELECT
    (SELECT count(*)::int FROM clientes) AS clientes,
    (SELECT count(*)::int FROM aniversariantes) AS aniversariantes,
    (SELECT count(*)::int FROM eventos_historico_cliente) AS historico,
    (SELECT count(*)::int FROM auditoria) AS auditoria`);
  return result.rows[0];
}

async function main() {
  validarDestino();
  const antes = await contagens();
  try {
    await withTransaction(async (tx) => {
      const cliente = await tx.query(
        `INSERT INTO clientes(nome_completo, cpf, telefone, email)
         VALUES ('Cliente Sintético CRM Aniversariante', '11144477735', '61990000000', 'crm.aniversariante@example.invalid')
         RETURNING id`,
      );
      const clienteId = cliente.rows[0].id;
      const contexto = { origem: "SISTEMA", requestId: "77777777-7777-4777-8777-777777777777" };

      const primeiro = await cadastrarAniversarianteInterno(
        clienteId,
        { nome: "Criança Sintética Um", dataNascimento: "2023-09-12", temaPadrao: "Tema A", observacoes: null },
        contexto,
        tx,
      );
      assert.equal(primeiro.clienteId, clienteId);

      await assert.rejects(
        () => cadastrarAniversarianteInterno(clienteId, { nome: "  criança sintética um  " }, contexto, tx),
        (error) => error?.code === "DADOS_INVALIDOS" && error?.httpStatus === 409,
      );

      const segundo = await cadastrarAniversarianteInterno(
        clienteId,
        { nome: "Criança Sintética Dois" },
        contexto,
        tx,
      );
      const editado = await editarAniversarianteInterno(
        clienteId,
        segundo.id,
        { nome: "Criança Sintética Dois Editada", dataNascimento: null, temaPadrao: "Tema B", observacoes: "Observação sintética" },
        contexto,
        tx,
      );
      assert.equal(editado.nome, "Criança Sintética Dois Editada");
      assert.equal(editado.temaPadrao, "Tema B");
      assert.equal(editado.observacoes, "Observação sintética");

      const quantidade = await tx.query("SELECT count(*)::int AS total FROM aniversariantes WHERE cliente_id=$1", [clienteId]);
      assert.equal(quantidade.rows[0].total, 2);
      throw new RollbackIntencional();
    });
  } catch (error) {
    if (!(error instanceof RollbackIntencional)) throw error;
  }
  assert.deepEqual(await contagens(), antes);
  console.log("PASS aniversariante CRM: criar, editar, múltiplos cadastros, duplicidade recusada e rollback completo.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(closeDatabasePool);
