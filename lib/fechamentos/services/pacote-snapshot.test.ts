import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { DbExecutor, DbQueryResult } from "../../db/contracts.ts";
import type { FechamentoRecord } from "../repositories/models.ts";
import type { ResumoComercial } from "../../comercial/services/models.ts";

const req = createRequire(import.meta.url);

function carregarServico() {
  const cache: Record<string, Record<string, unknown>> = {};
  function load(name: string): Record<string, unknown> {
    const base = resolve(name);
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : base;
    if (cache[file]) return cache[file];
    const exports = (cache[file] = {});
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function("require", "exports", code)(
      (id: string) => (id.startsWith(".") ? load(resolve(dirname(file), id.replace(/\.ts$/, ""))) : req(id)),
      exports,
    );
    return exports;
  }
  const modulo = load(resolve("lib/fechamentos/services/pacote-snapshot"));
  return modulo.gravarFotografiaPacoteFechamento as (
    tx: DbExecutor,
    fechamento: FechamentoRecord,
    resumo: ResumoComercial,
  ) => Promise<string>;
}

carregarServico.corrigir = (() => {
  const cache: Record<string, Record<string, unknown>> = {};
  function load(name: string): Record<string, unknown> {
    const base = resolve(name);
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : base;
    if (cache[file]) return cache[file];
    const exports = (cache[file] = {});
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function("require", "exports", code)(
      (id: string) => (id.startsWith(".") ? load(resolve(dirname(file), id.replace(/\.ts$/, ""))) : req(id)),
      exports,
    );
    return exports;
  }
  return load(resolve("lib/fechamentos/services/pacote-snapshot")).gravarCorrecaoFotografiaPacote as (
    tx: DbExecutor,
    fechamento: FechamentoRecord,
    resumo: ResumoComercial,
    correcao: { motivo: string; atorUsuarioId: string },
  ) => Promise<string | null>;
})();

function fechamento(): FechamentoRecord {
  return {
    id: "fechamento-1",
    clienteId: null,
    aniversarianteId: null,
    dataEvento: "2026-10-10",
    horarioInicio: "14:00",
    horarioFim: "18:00",
    configuracaoAgendaId: "agenda-1",
    pacoteId: "pacote-1",
    tabelaPrecoId: "tabela-1",
    precoPacoteId: "preco-1",
    regraDescontoPacoteId: null,
    categoriaHorario: "PADRAO",
    categoriaPrecoAplicada: "GERAL",
    convidados: 40,
    convidadosFaturados: 40,
    valorPacoteBase: 1000,
    descontoPercentual: 0,
    valorDescontoPacote: 0,
    valorPacoteAplicado: 1000,
    valorAdicionais: 0,
    valorTabela: 1000,
    valorNegociado: null,
    valorAprovado: null,
    motivoNegociacao: null,
    observacoesNegociacao: null,
    status: "AGUARDANDO_CONTRATO",
    origemFechamento: "CLIENTE",
    iniciadoPorUsuarioId: null,
    iniciadoEm: "2026-09-26T00:00:00Z",
    usuarioResponsavelId: null,
    responsavelAdicionalId: null,
    idadeAniversarianteEvento: null,
    temaFesta: null,
    formaPagamentoPretendida: null,
    alteracoesPacote: null,
    observacoesCliente: null,
    observacoesEquipe: null,
    buffetStatus: "PENDENTE",
    buffetSalgados: null,
    buffetBebidas: null,
    buffetDoces: null,
    buffetBolo: null,
    buffetOutros: null,
    criadoEm: "2026-09-26T00:00:00Z",
    atualizadoEm: "2026-09-26T00:00:00Z",
  };
}

function resumo(): ResumoComercial {
  return {
    pacote: {
      pacote: {
        id: "pacote-1",
        codigo: "COMPACTA",
        nome: "Festa Compacta",
        descricao: null,
        convidadosMinimos: 40,
        convidadosMaximos: null,
        duracaoMinutos: null,
        ordemExibicao: 3,
        ativo: true,
      },
      tabelaPreco: {
        id: "tabela-1",
        codigo: "COMERCIAL_2026_09",
        nome: "Comercial 2026-09",
        vigenciaInicio: "2026-09-07",
        vigenciaFim: null,
        ativa: true,
      },
      categoriaHorario: "PADRAO",
      elegibilidade: "DISPONIVEL",
      convidadosInformados: 40,
      convidadosFaturados: 40,
      minimoFaturavelAplicado: false,
      precoRegra: {
        id: "preco-1",
        tabelaPrecoId: "tabela-1",
        pacoteId: "pacote-1",
        convidadosMin: 40,
        convidadosMax: 40,
        tipoCalculo: "FIXO",
        valor: 1000,
        categoriaHorario: "GERAL",
        observacoes: null,
      },
      valorTabelaBase: 1000,
      desconto: { aplicado: false, regraId: null, codigo: null, titulo: null, percentual: 0, valor: 0 },
      valorTabelaAplicado: 1000,
    },
    adicionais: {
      tabelaPreco: {
        id: "tabela-1",
        codigo: "COMERCIAL_2026_09",
        nome: "Comercial 2026-09",
        vigenciaInicio: "2026-09-07",
        vigenciaFim: null,
        ativa: true,
      },
      convidados: 40,
      itens: [],
      valorTotal: 0,
    },
    valorTabelaPacoteBase: 1000,
    valorDescontoPacote: 0,
    valorTabelaPacoteAplicado: 1000,
    valorAdicionais: 0,
    valorTotalTabela: 1000,
  };
}

test("fotografia nasce com duração nula, incluso e buffet, sem extra pago", async () => {
  const gravar = carregarServico();
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.startsWith("INSERT INTO fechamento_pacote_snapshots")) {
        assert.equal(values?.[5], null);
        assert.equal(values?.[16], "GERAL");
        assert.equal(JSON.stringify(values).includes("240"), false);
        return { rows: [{ id: "snap-1" } as Row], rowCount: 1 };
      }
      if (text.includes("pa.modalidade = 'INCLUSO'")) {
        return { rows: [{ id: "ad-1", codigo: "PENNE", nome: "Penne" } as Row], rowCount: 1 };
      }
      if (text.includes("FROM pacote_buffet_categorias")) {
        return {
          rows: [{ id: "cat-1", codigo: "SALGADOS", nome: "Salgados", modo_itens: "TODOS_ATIVOS", escolhas_min: 0, escolhas_max: 8 } as Row],
          rowCount: 1,
        };
      }
      if (text.startsWith("INSERT INTO fechamento_pacote_composicao")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("UPDATE fechamentos")) {
        assert.deepEqual(values, ["snap-1", "fechamento-1"]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };

  assert.equal(await gravar(tx, fechamento(), resumo()), "snap-1");
  const inclusos = chamadas.filter((sql) => sql.startsWith("INSERT INTO fechamento_pacote_composicao") && sql.includes("'INCLUSO'"));
  const buffet = chamadas.filter((sql) => sql.startsWith("INSERT INTO fechamento_pacote_composicao") && sql.includes("'BUFFET'"));
  assert.equal(inclusos.length, 1);
  assert.equal(buffet.length, 1);
  assert.equal(chamadas[0].includes("INSERT INTO fechamento_pacote_snapshots"), true);
  assert.equal(chamadas.at(-1)?.startsWith("UPDATE fechamentos"), true);
  assert.equal(chamadas.some((sql) => sql.includes("fechamento_adicionais")), false);
});

test("troca explícita cria outra fotografia e preserva a anterior", async () => {
  const corrigir = carregarServico.corrigir;
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.includes("to_regclass")) return { rows: [{ rel: "fechamento_pacote_snapshots" } as Row], rowCount: 1 };
      if (text.includes("SELECT pacote_snapshot_vigente_id")) {
        return { rows: [{ pacote_snapshot_vigente_id: "snap-anterior" } as Row], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO fechamento_pacote_snapshots")) {
        assert.equal(values?.[28], "Troca autorizada");
        assert.equal(values?.[29], "usuario-1");
        assert.equal(values?.[30], "snap-anterior");
        return { rows: [{ id: "snap-nova" } as Row], rowCount: 1 };
      }
      if (text.includes("pa.modalidade = 'INCLUSO'") || text.includes("FROM pacote_buffet_categorias")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("UPDATE fechamentos")) {
        assert.match(text, /IS NOT DISTINCT FROM/);
        assert.deepEqual(values, ["snap-nova", "fechamento-1", "snap-anterior"]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  assert.equal(
    await corrigir(tx, fechamento(), resumo(), { motivo: "Troca autorizada", atorUsuarioId: "usuario-1" }),
    "snap-nova",
  );
  assert.equal(chamadas.some((sql) => /UPDATE fechamento_pacote_snapshots|DELETE FROM fechamento_pacote_snapshots/.test(sql)), false);
});
