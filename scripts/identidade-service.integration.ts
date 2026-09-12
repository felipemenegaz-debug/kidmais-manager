import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buscarClientePorId,
  criarCliente,
} from "../lib/clientes/repositories";
import {
  buscarValidacaoPorId,
} from "../lib/identidade/repositories";
import {
  criarIdentityService,
  IdentityServiceError,
  type OtpDelivery,
} from "../lib/identidade/services";
import {
  closeDatabasePool,
  db,
  withTransaction,
} from "../lib/db/postgres";
import type { DbExecutor } from "../lib/db/contracts";

const BANCO_HOMOLOGACAO = "kidmais_v1_homologacao";

function validarAmbienteHomologacao() {
  if (process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO !== "SIM") return;

  const homologacaoUrl = process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;

  if (!homologacaoUrl || !databaseUrl) {
    throw new Error(
      "Homologação exige KIDMAIS_HOMOLOGACAO_DATABASE_URL e DATABASE_URL explícitas.",
    );
  }

  if (homologacaoUrl !== databaseUrl) {
    throw new Error(
      "DATABASE_URL deve ser exatamente a URL validada de homologação.",
    );
  }

  if (databaseUrl.toLowerCase().includes("kidmais_manager")) {
    throw new Error("A suíte de homologação recusa acesso a kidmais_manager.");
  }

  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase();
  const banco = url.pathname.replace(/^\/+|\/+$/g, "");

  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("A suíte de homologação aceita somente PostgreSQL local.");
  }

  if (banco !== BANCO_HOMOLOGACAO) {
    throw new Error(
      `A suíte de homologação aceita somente o banco ${BANCO_HOMOLOGACAO}.`,
    );
  }
}

function carregarEnvLocal() {
  validarAmbienteHomologacao();

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

function gerarCpfValido() {
  const base = Array.from({ length: 9 }, () => randomInt(0, 10)).join("");

  const calcular = (parcial: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < parcial.length; i += 1) {
      soma += Number(parcial[i]) * (pesoInicial - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const d1 = calcular(base, 10);
  const d2 = calcular(`${base}${d1}`, 11);
  return `${base}${d1}${d2}`;
}

type FechamentoTesteRow = { id: string };

type FechamentoBaseFromCatalogoRow = {
  configuracaoAgendaId: string;
  pacoteId: string;
  tabelaPrecoId: string;
  precoPacoteId: string;
  convidadosMin: number;
  valor: string;
};

type ContagensOperacionais = {
  clientes: number;
  fechamentos: number;
  contratos: number;
  contrato_versoes: number;
  pagamentos: number;
  validacoes_identidade_cliente: number;
};

async function contarDadosOperacionais(): Promise<ContagensOperacionais> {
  const resultado = await db().query<ContagensOperacionais>(
    `SELECT
       (SELECT COUNT(*)::int FROM clientes) AS clientes,
       (SELECT COUNT(*)::int FROM fechamentos) AS fechamentos,
       (SELECT COUNT(*)::int FROM contratos) AS contratos,
       (SELECT COUNT(*)::int FROM contrato_versoes) AS contrato_versoes,
       (SELECT COUNT(*)::int FROM pagamentos) AS pagamentos,
       (SELECT COUNT(*)::int FROM validacoes_identidade_cliente)
         AS validacoes_identidade_cliente`,
  );

  return resultado.rows[0];
}

async function criarFechamentoSintetico(
  tx: DbExecutor,
  clienteId: string,
): Promise<FechamentoTesteRow> {
  const fromCatalogo = await tx.query<FechamentoBaseFromCatalogoRow>(
    `SELECT
       (SELECT id FROM configuracao_agenda ORDER BY ordem_exibicao LIMIT 1)
         AS "configuracaoAgendaId",
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
    "Não foi possível montar fechamento sintético com os catálogos preservados.",
  );

  const modelo = fromCatalogo.rows[0];
  const convidados = Math.max(1, modelo.convidadosMin);
  const resultado = await tx.query<FechamentoTesteRow>(
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
       origem_fechamento,
       observacoes_equipe
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
       'ATENDIMENTO_KIDMAIS',
       'Fixture sintética da regressão identidade-service'
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

  return resultado.rows[0];
}

async function main() {
  carregarEnvLocal();

  console.log("\nKidmais Manager — IdentityService / teste de integração\n");

  const contagensAntes = await contarDadosOperacionais();

  let delivery: OtpDelivery | null = null;
  let clienteTesteId: string | null = null;
  let fechamentoTesteId: string | null = null;
  let validacaoTesteId: string | null = null;

  const service = criarIdentityService({
    otpPepper: "kidmais-integration-test-pepper-2026",
    enviarOtp: async (payload) => {
      delivery = payload;
    },
  });

  try {
    await withTransaction(async (tx) => {
      let cpf = gerarCpfValido();
      while (
        (
          await tx.query<{ existe: boolean }>(
            `SELECT EXISTS(
               SELECT 1
                 FROM clientes
                WHERE cpf = $1
                  AND status <> 'MESCLADO'
             ) AS existe`,
            [cpf],
          )
        ).rows[0]?.existe
      ) {
        cpf = gerarCpfValido();
      }

      const cliente = await criarCliente(
        {
          nomeCompleto: `Cliente Sintético IdentityService ${randomUUID()}`,
          cpf,
          whatsapp: "00000000000",
          email: `identidade.service.${randomInt(100000, 999999)}@example.invalid`,
        },
        tx,
      );

      clienteTesteId = cliente.id;

      const fechamento = await criarFechamentoSintetico(tx, cliente.id);
      fechamentoTesteId = fechamento.id;

      // ---------------------------------------------------------
      // 1. CPF existente: resposta pública sem PII do CRM
      // ---------------------------------------------------------
      const consulta = await service.consultarCpfPublico(cpf, tx);

      assert.equal(consulta.situacao, "CLIENTE_EXISTENTE");
      assert.ok(consulta.canais.length >= 1);
      assert.equal("clienteId" in consulta, false);
      assert.equal("nomeCompleto" in consulta, false);
      assert.equal("endereco" in consulta, false);

      const jsonConsulta = JSON.stringify(consulta);
      assert.equal(jsonConsulta.includes(cliente.id), false);
      assert.equal(jsonConsulta.includes(cliente.nomeCompleto), false);
      assert.equal(jsonConsulta.includes(cliente.whatsapp ?? "__sem_whatsapp__"), false);
      assert.equal(jsonConsulta.includes(cliente.email ?? "__sem_email__"), false);

      console.log("✅ consultarCpfPublico protege dados pessoais");

      // ---------------------------------------------------------
      // 2. CPF novo
      // ---------------------------------------------------------
      let cpfNovo = gerarCpfValido();
      while (cpfNovo === cpf) cpfNovo = gerarCpfValido();

      const consultaNovo = await service.consultarCpfPublico(cpfNovo, tx);
      assert.equal(consultaNovo.situacao, "NOVO_CLIENTE");
      assert.deepEqual(consultaNovo.canais, []);

      console.log("✅ CPF inexistente segue como NOVO_CLIENTE");

      // ---------------------------------------------------------
      // 3. Iniciar desafio e capturar OTP somente no sender fake
      // ---------------------------------------------------------
      const desafio = await service.iniciarDesafio(
        { cpf, canal: "WHATSAPP" },
        tx,
      );

      validacaoTesteId = desafio.validacaoId;

      assert.ok(delivery);
      const enviado = delivery as OtpDelivery;
      assert.equal(enviado.validacaoId, desafio.validacaoId);
      assert.equal(enviado.canal, "WHATSAPP");
      assert.equal(enviado.destino, cliente.whatsapp);
      assert.match(enviado.codigo, /^\d{6}$/);
      assert.equal("clienteId" in desafio, false);
      assert.equal(JSON.stringify(desafio).includes(cliente.whatsapp ?? ""), false);

      const aposEnvio = await buscarValidacaoPorId(desafio.validacaoId, tx);
      assert.ok(aposEnvio);
      assert.equal(aposEnvio.envios, 1);
      assert.ok(aposEnvio.ultimoEnvioEm);

      console.log("✅ iniciarDesafio envia OTP sem expor destino real na resposta");
      console.log("✅ envio do OTP registrado no PostgreSQL");

      // ---------------------------------------------------------
      // 4. Código inválido incrementa tentativa
      // ---------------------------------------------------------
      let erroCodigoInvalido: unknown;
      try {
        await service.confirmarCodigo(
          { validacaoId: desafio.validacaoId, codigo: "000000" === enviado.codigo ? "000001" : "000000" },
          tx,
        );
      } catch (error) {
        erroCodigoInvalido = error;
      }

      assert.ok(erroCodigoInvalido instanceof IdentityServiceError);
      assert.equal(erroCodigoInvalido.code, "CODIGO_INVALIDO");

      const aposErro = await buscarValidacaoPorId(desafio.validacaoId, tx);
      assert.ok(aposErro);
      assert.equal(aposErro.tentativas, 1);

      console.log("✅ código inválido incrementa tentativa");

      // ---------------------------------------------------------
      // 5. Código correto gera prova opaca sem cliente_id
      // ---------------------------------------------------------
      const prova = await service.confirmarCodigo(
        { validacaoId: desafio.validacaoId, codigo: enviado.codigo },
        tx,
      );

      assert.ok(prova.provaToken.length >= 32);
      assert.equal("clienteId" in prova, false);
      assert.equal(JSON.stringify(prova).includes(cliente.id), false);

      console.log("✅ código correto gera prova opaca");

      // ---------------------------------------------------------
      // 6. Backend resolve Cliente canônico pela prova
      // ---------------------------------------------------------
      const resolvida = await service.resolverClientePorProva(
        prova.provaToken,
        tx,
      );

      assert.equal(resolvida.clienteId, cliente.id);
      assert.equal(resolvida.validacaoId, desafio.validacaoId);

      console.log("✅ backend resolve cliente_id sem confiar no navegador");

      // ---------------------------------------------------------
      // 7. Consumir prova para Fechamento
      // ---------------------------------------------------------
      const consumida = await service.consumirProvaParaFechamento(
        prova.provaToken,
        fechamento.id,
        tx,
      );

      assert.equal(consumida.clienteId, cliente.id);
      assert.equal(consumida.fechamentoId, fechamento.id);

      let erroReuso: unknown;
      try {
        await service.resolverClientePorProva(prova.provaToken, tx);
      } catch (error) {
        erroReuso = error;
      }

      assert.ok(erroReuso instanceof IdentityServiceError);
      assert.equal(erroReuso.code, "PROVA_INVALIDA_OU_EXPIRADA");

      console.log("✅ prova consumida não pode ser reutilizada");

      // ---------------------------------------------------------
      // 8. Recuperação pendente
      // ---------------------------------------------------------
      const recuperacao = await service.solicitarRecuperacao(cpf, tx);
      assert.deepEqual(recuperacao, { situacao: "RECUPERACAO_PENDENTE" });

      console.log("✅ recuperação pendente sem criar Cliente duplicado");

      throw new RollbackIntencional();
    });
  } catch (error) {
    if (!(error instanceof RollbackIntencional)) throw error;
  }

  assert.ok(clienteTesteId);
  assert.ok(fechamentoTesteId);
  assert.ok(validacaoTesteId);

  const clienteDepoisRollback = await buscarClientePorId(clienteTesteId);
  const validacaoDepoisRollback = await buscarValidacaoPorId(validacaoTesteId);

  const fechamentoDepoisRollback = await db().query<{ existe: number }>(
    "SELECT 1 AS existe FROM fechamentos WHERE id = $1",
    [fechamentoTesteId],
  );

  assert.equal(clienteDepoisRollback, null);
  assert.equal(validacaoDepoisRollback, null);
  assert.equal(fechamentoDepoisRollback.rows.length, 0);

  const contagensDepois = await contarDadosOperacionais();
  assert.deepEqual(
    contagensDepois,
    contagensAntes,
    "A suíte alterou contagens operacionais após o rollback.",
  );

  console.log("✅ ROLLBACK confirmado — nenhum dado de teste permaneceu");
  console.log("✅ Contagens operacionais preservadas:", contagensDepois);
  console.log("\n✅ IdentityService validado no clone de homologação.\n");
}

main()
  .catch((error) => {
    console.error("\n❌ Falha no teste de integração do IdentityService.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
