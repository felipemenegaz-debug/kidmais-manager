import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  closeDatabasePool,
  db,
  withTransaction,
} from "../lib/db/postgres";
import type { DbExecutor } from "../lib/db/contracts";

import {
  buscarProvaConfirmadaPorTokenHash,
  buscarValidacaoPorId,
  confirmarValidacao,
  consumirProvaIdentidade,
  criarDesafioIdentidade,
  criarRecuperacaoPendente,
  registrarTentativaInvalida,
} from "../lib/identidade/repositories";

function carregarEnvLocal() {
  if (process.env.DATABASE_URL) return;

  const arquivo = resolve(process.cwd(), ".env.local");

  if (!existsSync(arquivo)) {
    throw new Error(".env.local não encontrado na raiz do projeto.");
  }

  const conteudo = readFileSync(arquivo, "utf8");

  for (const linhaOriginal of conteudo.split(/\r?\n/)) {
    const linha = linhaOriginal.trim();

    if (!linha || linha.startsWith("#")) continue;

    const posicao = linha.indexOf("=");

    if (posicao <= 0) continue;

    const chave = linha.slice(0, posicao).trim();
    let valor = linha.slice(posicao + 1).trim();

    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }

    if (process.env[chave] === undefined) {
      process.env[chave] = valor;
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não encontrada no .env.local.");
  }
}

class RollbackIntencional extends Error {}

type ClienteTesteRow = {
  id: string;
  nomeCompleto: string;
  cpf: string;
  whatsapp: string | null;
  telefone: string | null;
  email: string | null;
};

type FechamentoTesteRow = {
  id: string;
};

type FechamentoBaseFromCatalogoRow = {
  configuracaoAgendaId: string;
  pacoteId: string;
  tabelaPrecoId: string;
  precoPacoteId: string;
  convidadosMin: number;
  valor: string;
};

function gerarCpfValido(): string {
  const base = Array.from({ length: 9 }, () => randomInt(0, 10)).join("");

  const calcularDigito = (valor: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < valor.length; i += 1) {
      soma += Number(valor[i]) * (pesoInicial - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const digito1 = calcularDigito(base, 10);
  const digito2 = calcularDigito(`${base}${digito1}`, 11);

  return `${base}${digito1}${digito2}`;
}

async function criarClienteSintetico(tx: DbExecutor): Promise<ClienteTesteRow> {
  let cpf = gerarCpfValido();

  while (true) {
    const existente = await tx.query<{ existe: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM clientes
          WHERE cpf = $1
            AND status <> 'MESCLADO'
       ) AS existe`,
      [cpf],
    );

    if (!existente.rows[0]?.existe) break;
    cpf = gerarCpfValido();
  }

  const resultado = await tx.query<ClienteTesteRow>(
    `INSERT INTO clientes(
       nome_completo,
       cpf,
       telefone,
       whatsapp,
       email
     ) VALUES ($1, $2, $3, NULL, $4)
       RETURNING id,
                 nome_completo AS "nomeCompleto",
                 cpf,
                 whatsapp,
                 telefone,
                 email`,
    [
      `Cliente sintético identidade ${randomUUID()}`,
      cpf,
      "61990000000",
      `identidade.repository.${randomInt(100000, 999999)}@example.invalid`,
    ],
  );

  return resultado.rows[0];
}

async function criarFechamentoSintetico(
  tx: DbExecutor,
  clienteId: string,
): Promise<FechamentoTesteRow> {
  const fromCatalogo = await tx.query<FechamentoBaseFromCatalogoRow>(
    `SELECT
       (SELECT id FROM configuracao_agenda ORDER BY ordem_exibicao LIMIT 1) AS "configuracaoAgendaId",
       pp.pacote_id AS "pacoteId",
       pp.tabela_preco_id AS "tabelaPrecoId",
       pp.id AS "precoPacoteId",
       pp.convidados_min AS "convidadosMin",
       pp.valor::text AS valor
     FROM precos_pacote pp
     JOIN pacotes p ON p.id = pp.pacote_id
     JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
     ORDER BY pp.valor
     LIMIT 1`,
  );

  assert.ok(
    fromCatalogo.rows[0],
    "Não foi possível montar fechamento sintético sem dados base.",
  );

  const modelo = fromCatalogo.rows[0];
  const convidados = Math.max(1, modelo.convidadosMin);
  const fechamento = await tx.query<FechamentoTesteRow>(
    `INSERT INTO fechamentos (
       cliente_id,
       data_evento,
       horario_inicio,
       horario_fim,
       configuracao_agenda_id,
       pacote_id,
       tabela_preco_id,
       preco_pacote_id,
       categoria_horario,
       categoria_preco_aplicada,
       convidados,
       convidados_faturados,
       valor_pacote_base,
       desconto_percentual,
       valor_desconto_pacote,
       valor_pacote_aplicado,
       valor_adicionais,
       valor_tabela,
       status,
       origem_fechamento
     ) VALUES (
       $1,
       (CURRENT_DATE + INTERVAL '14 days')::date,
       '11:00',
       '15:00',
       $2,
       $3,
       $4,
       $5,
       'PADRAO',
       'PADRAO',
       $6,
       $6,
       $7,
       0,
       0,
       $7,
       0,
       $7,
       'RASCUNHO',
       'ATENDIMENTO_KIDMAIS'
     ) RETURNING id`,
    [
      clienteId,
      modelo.configuracaoAgendaId,
      modelo.pacoteId,
      modelo.tabelaPrecoId,
      modelo.precoPacoteId,
      convidados,
      modelo.valor,
    ],
  );

  return fechamento.rows[0];
}

async function main() {
  carregarEnvLocal();

  console.log(
    "\nKidmais Manager — Repository de Identidade / teste de integração\n",
  );

  const tokenProvaHash = `teste-token-${randomUUID()}`;
  let validacaoId: string | null = null;
  let clienteFixtureId: string | null = null;
  let fechamentoFixtureId: string | null = null;

  try {
    await withTransaction(async (tx) => {
      await tx.query("SAVEPOINT identidade_repository_invalid_cpf");
      await assert.rejects(
        tx.query("INSERT INTO clientes(nome_completo, cpf) VALUES ($1, $2)", [
          "Cliente inválido",
          "123",
        ]),
        (erro) => (erro as { code?: string }).code === "23514",
      );
      await tx.query("ROLLBACK TO SAVEPOINT identidade_repository_invalid_cpf");
      await tx.query("RELEASE SAVEPOINT identidade_repository_invalid_cpf");

      const cliente = await criarClienteSintetico(tx);
      clienteFixtureId = cliente.id;

      const fechamento = await criarFechamentoSintetico(tx, cliente.id);
      fechamentoFixtureId = fechamento.id;

      assert.ok(
        cliente.whatsapp !== null || cliente.telefone !== null || cliente.email !== null,
        "Fixture sintética deve possuir contato para identidade.",
      );

      const canal =
        cliente.whatsapp !== null
          ? "WHATSAPP"
          : cliente.telefone !== null
            ? "SMS"
            : "EMAIL";

      // ---------------------------------------------------------
      // 1. Criar desafio
      // ---------------------------------------------------------

      const desafio = await criarDesafioIdentidade(
        {
          clienteId: cliente.id,
          canal,
          codigoHash: `teste-codigo-${randomUUID()}`,
          codigoExpiraEm: new Date(
            Date.now() + 10 * 60 * 1000,
          ).toISOString(),
        },
        tx,
      );

      validacaoId = desafio.id;

      assert.equal(desafio.clienteId, cliente.id);
      assert.equal(desafio.status, "PENDENTE");
      assert.equal(desafio.canal, canal);
      assert.equal(desafio.tentativas, 0);

      console.log("✅ criarDesafioIdentidade");

      // ---------------------------------------------------------
      // 2. Buscar por ID
      // ---------------------------------------------------------

      const encontrada = await buscarValidacaoPorId(desafio.id, tx);

      assert.ok(encontrada);
      assert.equal(encontrada.id, desafio.id);
      assert.equal(encontrada.status, "PENDENTE");

      console.log("✅ buscarValidacaoPorId");

      // ---------------------------------------------------------
      // 3. Registrar tentativa inválida
      // ---------------------------------------------------------

      const aposTentativa = await registrarTentativaInvalida(
        desafio.id,
        tx,
      );

      assert.ok(aposTentativa);
      assert.equal(aposTentativa.tentativas, 1);
      assert.equal(aposTentativa.status, "PENDENTE");

      console.log("✅ registrarTentativaInvalida");

      // ---------------------------------------------------------
      // 4. Confirmar identidade
      // ---------------------------------------------------------

      const confirmada = await confirmarValidacao(
        {
          validacaoId: desafio.id,
          tokenProvaHash,
          provaExpiraEm: new Date(
            Date.now() + 15 * 60 * 1000,
          ).toISOString(),
        },
        tx,
      );

      assert.ok(confirmada);
      assert.equal(confirmada.status, "CONFIRMADA");
      assert.equal(confirmada.codigoHash, null);
      assert.equal(confirmada.tokenProvaHash, tokenProvaHash);
      assert.ok(confirmada.confirmadoEm);

      console.log("✅ confirmarValidacao");

      // ---------------------------------------------------------
      // 5. Buscar prova confirmada
      // ---------------------------------------------------------

      const prova = await buscarProvaConfirmadaPorTokenHash(
        tokenProvaHash,
        tx,
      );

      assert.ok(prova);
      assert.equal(prova.id, desafio.id);
      assert.equal(prova.clienteId, cliente.id);
      assert.equal(prova.status, "CONFIRMADA");

      console.log("✅ buscarProvaConfirmadaPorTokenHash");

      // ---------------------------------------------------------
      // 6. Consumir prova
      // ---------------------------------------------------------

      const consumida = await consumirProvaIdentidade(
        {
          tokenProvaHash,
          fechamentoId: fechamento.id,
        },
        tx,
      );

      assert.ok(consumida);
      assert.equal(consumida.status, "CONSUMIDA");
      assert.equal(
        consumida.consumidoPorFechamentoId,
        fechamento.id,
      );
      assert.ok(consumida.consumidoEm);

      console.log("✅ consumirProvaIdentidade");

      const provaDepoisDoConsumo =
        await buscarProvaConfirmadaPorTokenHash(
          tokenProvaHash,
          tx,
        );

      assert.equal(provaDepoisDoConsumo, null);

      console.log("✅ prova consumida não pode ser reutilizada");

      // ---------------------------------------------------------
      // 7. Recuperação pendente
      // ---------------------------------------------------------

      const recuperacao = await criarRecuperacaoPendente(
        cliente.id,
        tx,
      );

      assert.equal(
        recuperacao.status,
        "RECUPERACAO_PENDENTE",
      );
      assert.equal(recuperacao.clienteId, cliente.id);
      assert.equal(recuperacao.canal, null);
      assert.equal(recuperacao.codigoHash, null);
      assert.ok(recuperacao.recuperacaoSolicitadaEm);

      console.log("✅ criarRecuperacaoPendente");

      // Não queremos persistir absolutamente nada deste teste.
      throw new RollbackIntencional();
    });
  } catch (error) {
    if (!(error instanceof RollbackIntencional)) {
      throw error;
    }
  }

  // -----------------------------------------------------------
  // 8. Confirmar o ROLLBACK
  // -----------------------------------------------------------

  assert.ok(validacaoId);

  const validacaoDepoisRollback =
    await buscarValidacaoPorId(validacaoId);

  assert.equal(validacaoDepoisRollback, null);

  const provaDepoisRollback =
    await buscarProvaConfirmadaPorTokenHash(tokenProvaHash);

  assert.equal(provaDepoisRollback, null);

  assert.ok(clienteFixtureId);
  assert.ok(fechamentoFixtureId);

  const clienteDepoisRollback = await db().query<{ existe: number }>(
    "SELECT 1 AS existe FROM clientes WHERE id=$1",
    [clienteFixtureId],
  );

  assert.equal(clienteDepoisRollback.rows.length, 0);

  const fechamentoDepoisRollback = await db().query<{ existe: number }>(
    "SELECT 1 AS existe FROM fechamentos WHERE id=$1",
    [fechamentoFixtureId],
  );

  assert.equal(fechamentoDepoisRollback.rows.length, 0);

  console.log("✅ ROLLBACK confirmado — nenhum dado de teste permaneceu");

  console.log(
    "\n✅ Repository de Identidade validado contra o PostgreSQL real.\n",
  );
}

main()
  .catch((error) => {
    console.error(
      "\n❌ Falha no teste de integração do Repository de Identidade.",
    );
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
