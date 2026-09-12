import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabasePool, db } from "../lib/db/postgres";
import {
  calcularResumoComercial,
  precificarPacote,
  PricingServiceError,
} from "../lib/comercial/services";

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

type ConfiguracaoRow = {
  id: string;
  codigo: string;
};

type PacoteRow = {
  id: string;
  codigo: string;
};

async function carregarReferencias() {
  const [configsResult, pacotesResult] = await Promise.all([
    db().query<ConfiguracaoRow>(
      `SELECT id, codigo
         FROM configuracao_agenda
        WHERE ativo = true
          AND codigo IN ('TURNO_1', 'TURNO_2')`,
    ),
    db().query<PacoteRow>(
      `SELECT id, codigo
         FROM pacotes
        WHERE ativo = true
          AND codigo IN (
            'POCKET',
            'MINI_FESTA',
            'COMPACTA',
            'COMPLETA',
            'PREMIUM',
            'PIZZA_PARTY'
          )`,
    ),
  ]);

  const configs = new Map(configsResult.rows.map((item) => [item.codigo, item.id]));
  const pacotes = new Map(pacotesResult.rows.map((item) => [item.codigo, item.id]));

  for (const codigo of ["TURNO_1", "TURNO_2"]) {
    assert.ok(configs.get(codigo), `Configuração ${codigo} não encontrada.`);
  }

  for (const codigo of [
    "POCKET",
    "MINI_FESTA",
    "COMPACTA",
    "COMPLETA",
    "PREMIUM",
    "PIZZA_PARTY",
  ]) {
    assert.ok(pacotes.get(codigo), `Pacote ${codigo} não encontrado.`);
  }

  return {
    turno1: configs.get("TURNO_1")!,
    turno2: configs.get("TURNO_2")!,
    pocket: pacotes.get("POCKET")!,
    mini: pacotes.get("MINI_FESTA")!,
    compacta: pacotes.get("COMPACTA")!,
    completa: pacotes.get("COMPLETA")!,
    premium: pacotes.get("PREMIUM")!,
    pizzaParty: pacotes.get("PIZZA_PARTY")!,
  };
}

let falhas = 0;

async function testar(
  nome: string,
  executar: () => Promise<void>,
): Promise<void> {
  try {
    await executar();
    console.log(`✅ ${nome}`);
  } catch (error) {
    falhas += 1;
    console.error(`❌ ${nome}`);
    console.error(error);
  }
}

async function esperarErro(
  nome: string,
  codigoEsperado: string,
  executar: () => Promise<unknown>,
): Promise<void> {
  await testar(nome, async () => {
    try {
      await executar();
      assert.fail(`Era esperado o erro ${codigoEsperado}, mas a operação foi aceita.`);
    } catch (error) {
      assert.ok(
        error instanceof PricingServiceError,
        "O erro retornado não é PricingServiceError.",
      );
      assert.equal(error.code, codigoEsperado);
    }
  });
}

async function main() {
  carregarEnvLocal();
  const ref = await carregarReferencias();

  console.log("\nKidmais Manager — PricingService / teste de integração\n");

  await testar("Pocket: R$ 190 por convidado com mínimo faturável de 20", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-07", // segunda-feira
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.pocket,
      convidados: 15,
    });

    assert.equal(resultado.categoriaHorario, "PADRAO");
    assert.equal(resultado.precoRegra.categoriaHorario, "GERAL");
    assert.equal(resultado.convidadosInformados, 15);
    assert.equal(resultado.convidadosFaturados, 20);
    assert.equal(resultado.minimoFaturavelAplicado, true);
    assert.equal(resultado.valorTabelaBase, 3800);
    assert.equal(resultado.desconto.percentual, 0);
    assert.equal(resultado.valorTabelaAplicado, 3800);
  });

  await testar("Mini Festa: sexta TURNO_1 disponível por R$ 170/convidado", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-11", // sexta-feira
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.mini,
      convidados: 30,
    });

    assert.equal(resultado.elegibilidade, "DISPONIVEL");
    assert.equal(resultado.precoRegra.categoriaHorario, "GERAL");
    assert.equal(resultado.valorTabelaBase, 5100);
    assert.equal(resultado.valorTabelaAplicado, 5100);
  });

  await esperarErro(
    "Mini Festa: sexta TURNO_2 deve ser recusada",
    "PACOTE_INDISPONIVEL",
    () =>
      precificarPacote({
        data: "2026-09-11",
        configuracaoAgendaId: ref.turno2,
        pacoteId: ref.mini,
        convidados: 30,
      }),
  );

  await testar("Festa Completa: segunda usa PADRAO e desconto de 15%", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-07",
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.completa,
      convidados: 50,
    });

    assert.equal(resultado.categoriaHorario, "PADRAO");
    assert.equal(resultado.valorTabelaBase, 8990);
    assert.equal(resultado.desconto.percentual, 15);
    assert.equal(resultado.desconto.valor, 1348.5);
    assert.equal(resultado.valorTabelaAplicado, 7641.5);
  });

  await testar("Festa Completa: sábado TURNO_1 continua PADRAO", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-12",
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.completa,
      convidados: 50,
    });

    assert.equal(resultado.categoriaHorario, "PADRAO");
    assert.equal(resultado.valorTabelaBase, 8990);
    assert.equal(resultado.desconto.percentual, 0);
    assert.equal(resultado.valorTabelaAplicado, 8990);
  });

  await testar("Festa Completa: sábado TURNO_2 usa NOBRE", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-12",
      configuracaoAgendaId: ref.turno2,
      pacoteId: ref.completa,
      convidados: 50,
    });

    assert.equal(resultado.categoriaHorario, "NOBRE");
    assert.equal(resultado.valorTabelaBase, 9290);
    assert.equal(resultado.valorTabelaAplicado, 9290);
  });

  await testar("Festa Premium: domingo TURNO_1 usa NOBRE", async () => {
    const resultado = await precificarPacote({
      data: "2026-09-13",
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.premium,
      convidados: 50,
    });

    assert.equal(resultado.categoriaHorario, "NOBRE");
    assert.equal(resultado.valorTabelaBase, 10690);
    assert.equal(resultado.valorTabelaAplicado, 10690);
  });

  await esperarErro(
    "Festa Compacta: sábado TURNO_2 deve ser recusada",
    "PACOTE_INDISPONIVEL",
    () =>
      precificarPacote({
        data: "2026-09-12",
        configuracaoAgendaId: ref.turno2,
        pacoteId: ref.compacta,
        convidados: 40,
      }),
  );

  await esperarErro(
    "Pizza Party deve permanecer SOB_CONSULTA",
    "PACOTE_SOB_CONSULTA",
    () =>
      precificarPacote({
        data: "2026-09-07",
        configuracaoAgendaId: ref.turno1,
        pacoteId: ref.pizzaParty,
        convidados: 50,
      }),
  );

  await testar("Resumo comercial: pacote + desconto + adicional PENNE", async () => {
    const resultado = await calcularResumoComercial({
      data: "2026-09-07",
      configuracaoAgendaId: ref.turno1,
      pacoteId: ref.completa,
      convidados: 60,
      adicionais: [{ codigo: "PENNE" }],
    });

    assert.equal(resultado.valorTabelaPacoteBase, 9790);
    assert.equal(resultado.valorDescontoPacote, 1468.5);
    assert.equal(resultado.valorTabelaPacoteAplicado, 8321.5);
    assert.equal(resultado.valorAdicionais, 650);
    assert.equal(resultado.valorTotalTabela, 8971.5);
    assert.equal(resultado.adicionais.itens[0]?.codigo, "PENNE");
  });

  console.log("\n----------------------------------------");
  if (falhas === 0) {
    console.log("✅ Todos os testes do PricingService passaram.");
  } else {
    console.error(`❌ ${falhas} teste(s) falharam.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("\n❌ Falha ao iniciar o teste de integração.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
