import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import {
  closeDatabasePool,
  db,
  withTransaction,
} from "../lib/db/postgres";
import type { DbExecutor } from "../lib/db/contracts";
import { criarIdentityService } from "../lib/identidade/services";
import { criarFechamentoPublicoComIdentidade } from "../lib/fechamentos/services";

const BANCO_HOMOLOGACAO = "kidmais_v1_homologacao";
const OTP_PEPPER_SINTETICO =
  "kidmais-identidade-fechamento-homologacao-2026";

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
  if (!existsSync(arquivo)) throw new Error(".env.local não encontrado.");

  for (const linhaOriginal of readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    const linha = linhaOriginal.trim();
    if (!linha || linha.startsWith("#")) continue;
    const i = linha.indexOf("=");
    if (i <= 0) continue;
    const chave = linha.slice(0, i).trim();
    let valor = linha.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) valor = valor.slice(1, -1);
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
}

class RollbackIntencional extends Error {}

type ClienteRow = {
  id: string;
  nome_completo: string;
  cpf: string;
  telefone: string | null;
  whatsapp: string | null;
  email: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  cidade: string;
  uf: string;
};

type RefRow = { id: string; codigo: string };

type ContagensOperacionais = {
  clientes: number;
  aniversariantes: number;
  fechamentos: number;
  aprovacoes_negociacao: number;
  contratos: number;
  contrato_versoes: number;
  pagamentos: number;
  validacoes_identidade_cliente: number;
};

function gerarCpfValido() {
  const base = Array.from({ length: 9 }, () => randomInt(0, 10));
  const dv = (nums: number[], pesoInicial: number) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (pesoInicial - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = dv(base, 10);
  const d2 = dv([...base, d1], 11);
  return [...base, d1, d2].join("");
}

async function cpfNovo(tx: DbExecutor) {
  for (let i = 0; i < 50; i += 1) {
    const cpf = gerarCpfValido();
    const existe = await tx.query<{ existe: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM clientes
          WHERE cpf = $1
            AND status <> 'MESCLADO'
       ) AS existe`,
      [cpf],
    );
    if (!existe.rows[0]?.existe) return cpf;
  }
  throw new Error("Não foi possível gerar CPF livre para teste.");
}

async function criarClienteCompletoSintetico(
  tx: DbExecutor,
): Promise<ClienteRow> {
  const cpf = await cpfNovo(tx);
  const resultado = await tx.query<ClienteRow>(
    `INSERT INTO clientes (
       nome_completo, cpf, telefone, whatsapp, email,
       cep, logradouro, numero, complemento, bairro, cidade, uf
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, NULL, $9, $10, $11
     ) RETURNING id, nome_completo, cpf, telefone, whatsapp, email,
                 cep, logradouro, numero, complemento, bairro, cidade, uf`,
    [
      `Cliente Sintético Identidade Fechamento ${randomUUID()}`,
      cpf,
      "00000000000",
      "00000000001",
      `identidade.fechamento.${randomUUID()}@example.invalid`,
      "00000000",
      "Rua Sintética de Homologação",
      "100",
      "Bairro Sintético",
      "Cidade de Homologação",
      "SP",
    ],
  );

  return resultado.rows[0];
}

async function contarDadosOperacionais(): Promise<ContagensOperacionais> {
  const resultado = await db().query<ContagensOperacionais>(
    `SELECT
       (SELECT COUNT(*)::int FROM clientes) AS clientes,
       (SELECT COUNT(*)::int FROM aniversariantes) AS aniversariantes,
       (SELECT COUNT(*)::int FROM fechamentos) AS fechamentos,
       (SELECT COUNT(*)::int FROM aprovacoes_negociacao)
         AS aprovacoes_negociacao,
       (SELECT COUNT(*)::int FROM contratos) AS contratos,
       (SELECT COUNT(*)::int FROM contrato_versoes) AS contrato_versoes,
       (SELECT COUNT(*)::int FROM pagamentos) AS pagamentos,
       (SELECT COUNT(*)::int FROM validacoes_identidade_cliente)
         AS validacoes_identidade_cliente`,
  );

  return resultado.rows[0];
}

async function main() {
  carregarEnvLocal();
  if (process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO === "SIM") {
    process.env.IDENTIDADE_OTP_PEPPER = OTP_PEPPER_SINTETICO;
  }
  assert.ok(process.env.IDENTIDADE_OTP_PEPPER, "IDENTIDADE_OTP_PEPPER ausente.");

  console.log("\nKidmais Manager — Identidade/CRM no Fechamento / integração\n");

  const contagensAntes = await contarDadosOperacionais();
  let fechamentoExistenteId: string | null = null;
  let fechamentoNovoId: string | null = null;
  let clienteExistenteId: string | null = null;
  let novoClienteId: string | null = null;

  try {
    await withTransaction(async (tx) => {
      const cliente = await criarClienteCompletoSintetico(tx);
      clienteExistenteId = cliente.id;
      const novoCpf = await cpfNovo(tx);

      const [configs, pacotes] = await Promise.all([
        tx.query<RefRow>(
          `SELECT id, codigo FROM configuracao_agenda
            WHERE ativo = true AND codigo = 'TURNO_1' LIMIT 1`,
        ),
        tx.query<RefRow>(
          `SELECT id, codigo FROM pacotes
            WHERE ativo = true AND codigo = 'COMPLETA' LIMIT 1`,
        ),
      ]);
      const config = configs.rows[0];
      const pacote = pacotes.rows[0];
      assert.ok(config && pacote, "Referências comerciais não encontradas.");

      const codigo = "940081";
      const token = "prova-integration-kidmais-" + "x".repeat(40);
      const identity = criarIdentityService({
        otpPepper: OTP_PEPPER_SINTETICO,
        enviarOtp: async () => {},
        gerarOtp: () => codigo,
        gerarProvaToken: () => token,
      });

      const canal = cliente.whatsapp ? "WHATSAPP" as const : "SMS" as const;
      const desafio = await identity.iniciarDesafio(
        { cpf: cliente.cpf, canal },
        tx,
      );
      const prova = await identity.confirmarCodigo(
        { validacaoId: desafio.validacaoId, codigo },
        tx,
      );

      const existente = await criarFechamentoPublicoComIdentidade(
        {
          dataEvento: "2098-09-12",
          horarioInicio: "11:00",
          horarioFim: "15:00",
          configuracaoAgendaId: config.id,
          pacoteId: pacote.id,
          convidados: 50,
          adicionais: [],
          valorProposto: 8990,
          buffetStatus: "PENDENTE",
          identidade: {
            tipo: "CLIENTE_EXISTENTE",
            provaToken: prova.provaToken,
            atualizarCadastro: false,
          },
          cliente: {
            nomeCompleto: cliente.nome_completo,
            cpf: cliente.cpf,
            telefone: cliente.telefone,
            whatsapp: cliente.whatsapp,
            email: cliente.email,
            cep: cliente.cep,
            logradouro: cliente.logradouro,
            numero: cliente.numero,
            complemento: cliente.complemento,
            bairro: cliente.bairro,
            cidade: cliente.cidade,
            uf: cliente.uf,
          },
          aniversariante: {
            nome: "Teste Identidade Kidmais",
            temaPadrao: "Teste",
          },
        },
        tx,
      );

      fechamentoExistenteId = existente.fechamento.id;
      assert.equal(existente.fechamento.clienteId, cliente.id);
      assert.ok(existente.fechamento.aniversarianteId);
      assert.equal(existente.fechamento.origemFechamento, "CLIENTE");
      assert.equal(existente.cliente.novo, false);
      assert.equal(existente.aniversariante.novo, true);
      console.log("✅ Cliente existente reutilizado via prova e aniversariante novo vinculado");

      const provaReutilizada = await identity.resolverClientePorProva(
        prova.provaToken,
        tx,
      ).then(() => true).catch(() => false);
      assert.equal(provaReutilizada, false);
      console.log("✅ Prova consumida não pode ser reutilizada");

      const novo = await criarFechamentoPublicoComIdentidade(
        {
          dataEvento: "2098-09-12",
          horarioInicio: "11:00",
          horarioFim: "15:00",
          configuracaoAgendaId: config.id,
          pacoteId: pacote.id,
          convidados: 50,
          adicionais: [],
          valorProposto: 8990,
          buffetStatus: "PENDENTE",
          identidade: { tipo: "NOVO_CLIENTE" },
          cliente: {
            nomeCompleto: "Cliente Novo Sintético Identidade Fechamento",
            cpf: novoCpf,
            telefone: "00000000002",
            whatsapp: "00000000003",
            email: `identidade.novo.${novoCpf}@example.invalid`,
            cep: "00000000",
            logradouro: "Avenida Sintética de Homologação",
            numero: "100",
            complemento: null,
            bairro: "Bairro Sintético",
            cidade: "Cidade de Homologação",
            uf: "SP",
          },
          aniversariante: {
            nome: "Aniversariante Teste",
            temaPadrao: "Teste",
          },
        },
        tx,
      );

      fechamentoNovoId = novo.fechamento.id;
      novoClienteId = novo.fechamento.clienteId;
      assert.ok(novoClienteId);
      assert.ok(novo.fechamento.aniversarianteId);
      assert.equal(novo.cliente.novo, true);
      assert.equal(novo.cliente.cadastroCompletoParaContrato, true);
      console.log("✅ CPF novo cria Cliente e aniversariante sem duplicar CRM existente");

      const duplicado = await criarFechamentoPublicoComIdentidade(
        {
          dataEvento: "2098-09-12",
          horarioInicio: "11:00",
          horarioFim: "15:00",
          configuracaoAgendaId: config.id,
          pacoteId: pacote.id,
          convidados: 50,
          adicionais: [],
          valorProposto: 8990,
          buffetStatus: "PENDENTE",
          identidade: { tipo: "NOVO_CLIENTE" },
          cliente: {
            nomeCompleto: "Outro Nome",
            cpf: novoCpf,
            whatsapp: "00000000004",
            email: `identidade.duplicado.${novoCpf}@example.invalid`,
            cep: "00000000",
            logradouro: "Outro endereço sintético",
            numero: "200",
            bairro: "Bairro Sintético",
            cidade: "Cidade de Homologação",
            uf: "SP",
          },
          aniversariante: { nome: "Outro" },
        },
        tx,
      ).then(() => null).catch((error) => error);

      assert.ok(duplicado instanceof Error);
      console.log("✅ CPF já existente não cria segundo Cliente automaticamente");

      throw new RollbackIntencional();
    });
  } catch (error) {
    if (!(error instanceof RollbackIntencional)) throw error;
  }

  assert.ok(
    fechamentoExistenteId &&
      fechamentoNovoId &&
      clienteExistenteId &&
      novoClienteId,
  );
  const checks = await Promise.all([
    db().query<{ total: string }>("SELECT count(*)::text AS total FROM fechamentos WHERE id = $1", [fechamentoExistenteId]),
    db().query<{ total: string }>("SELECT count(*)::text AS total FROM fechamentos WHERE id = $1", [fechamentoNovoId]),
    db().query<{ total: string }>("SELECT count(*)::text AS total FROM clientes WHERE id = $1", [clienteExistenteId]),
    db().query<{ total: string }>("SELECT count(*)::text AS total FROM clientes WHERE id = $1", [novoClienteId]),
  ]);
  checks.forEach((result) => assert.equal(result.rows[0].total, "0"));

  const contagensDepois = await contarDadosOperacionais();
  assert.deepEqual(
    contagensDepois,
    contagensAntes,
    "A suíte alterou contagens operacionais após o rollback.",
  );
  console.log("✅ ROLLBACK confirmado — nenhum dado de teste permaneceu");
  console.log("✅ Contagens operacionais preservadas:", contagensDepois);

  console.log("\n✅ Integração Identidade / CRM / Fechamento validada.\n");
}

main()
  .catch((error) => {
    console.error("\n❌ Falha na integração Identidade / CRM / Fechamento.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
