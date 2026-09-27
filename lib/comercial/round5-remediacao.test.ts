import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { PacoteAdminError, criarRevisaoPacoteAdmin } from "./pacotes-admin.ts";
import { calcularResumoComercial, precificarAdicionais } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";

const empresa = "11111111-1111-4111-8111-111111111111";
const pacote = "22222222-2222-4222-8222-222222222222";
const agenda = "33333333-3333-4333-8333-333333333333";
const tabelaA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tabelaB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "99999999-9999-4999-8999-999999999999", motivo: "PACOTE_EDITADO" };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function pacoteLinha() {
  return {
    id: pacote, empresa_id: empresa, codigo: "P_TESTE", nome: "Festa", descricao: null,
    duracao_minutos: 180, convidados_minimos: 20, convidados_maximos: 30, ordem_exibicao: 1,
    ativo: true, vigente: true, arquivado_em: null, revisao_anterior_id: null, utilizado: true,
  };
}

function tabela(id: string) {
  return {
    id, codigo: "PCOM", nome: "Preços", vigencia_inicio: "2026-09-27", vigencia_fim: null, ativa: false, publicada: true,
  };
}

test("revisão sem preço corrente não é promovida", async () => {
  const sqls: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("AS utilizado")) return { rows: [pacoteLinha() as Row], rowCount: 1 };
    if (text.startsWith("INSERT INTO pacotes")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555" } as Row], rowCount: 1 };
    if (text.startsWith("INSERT INTO pacote_") || text.startsWith("INSERT INTO regras_")) return { rows: [], rowCount: 1 };
    if (text.includes("count(*)::int AS n")) return { rows: [{ n: 0 } as Row], rowCount: 1 };
    if (text.includes("FROM tabelas_preco") || text.includes("pg_advisory") || text.includes("kidmais_")) return { rows: [], rowCount: 0 };
    throw new Error(text);
  } };
  await assert.rejects(
    () => criarRevisaoPacoteAdmin(tx, pacote, { nome: "Festa nova", descricao: null, duracaoMinutos: 180 }, ctx),
    (error: unknown) => error instanceof PacoteAdminError
      && error.message === "Não foi possível preservar o preço atual deste pacote. Nenhuma alteração foi salva.",
  );
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE pacotes SET vigente = true")), false);
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE pacotes SET vigente = false")), false);
});

test("id explícito só passa quando é a corrente, e o fluxo sem id usa essa corrente", async () => {
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("FROM tabelas_preco") && text.includes("WHERE id = $1::uuid") && !text.includes("substituida_em IS NULL")) {
      throw new Error("id arbitrário");
    }
    if (text.includes("FROM pacotes")) return { rows: [pacoteLinha() as Row], rowCount: 1 };
    if (text.includes("substituida_em IS NULL")) return { rows: [tabela(tabelaA) as Row], rowCount: 1 };
    if (text.includes("regras_categoria_horario")) {
      return { rows: [{ id: agenda, dia_semana: 7, configuracao_agenda_id: agenda, categoria_horario: "PADRAO", vigencia_inicio: "2026-09-27", vigencia_fim: null } as Row], rowCount: 1 };
    }
    if (text.includes("regras_disponibilidade_pacote")) {
      return { rows: [{ id: agenda, pacote_id: pacote, dia_semana: 7, configuracao_agenda_id: agenda, estado: "DISPONIVEL", vigencia_inicio: "2026-09-27", vigencia_fim: null, observacoes: null } as Row], rowCount: 1 };
    }
    if (text.includes("FROM precos_pacote")) {
      return { rows: [{ id: agenda, tabela_preco_id: tabelaA, pacote_id: pacote, convidados_min: 20, convidados_max: 30, tipo_calculo: "FIXO", valor: "10000.00", categoria_horario: "GERAL", observacoes: null } as Row], rowCount: 1 };
    }
    if (text.includes("regras_desconto")) return { rows: [], rowCount: 0 };
    throw new Error(text);
  } };
  const semId = await precificarAdicionais({
    data: "2026-09-27", convidados: 20, itens: [], empresaId: empresa,
  }, tx);
  const comId = await precificarAdicionais({
    data: "2026-09-27", convidados: 20, itens: [], empresaId: empresa, tabelaPrecoId: tabelaA,
  }, tx);
  const resumo = await calcularResumoComercial({
    data: "2026-09-27",
    configuracaoAgendaId: agenda,
    pacoteId: pacote,
    convidados: 20,
    adicionais: [],
  }, tx);
  assert.equal(semId.tabelaPreco.id, tabelaA);
  assert.equal(comId.tabelaPreco.id, tabelaA);
  assert.equal(comId.valorTotal, 0);
  assert.equal(resumo.pacote.tabelaPreco.id, tabelaA);
  assert.equal(resumo.adicionais.tabelaPreco.id, tabelaA);
  await assert.rejects(
    () => precificarAdicionais({
      data: "2026-09-27", convidados: 20, itens: [], empresaId: empresa, tabelaPrecoId: tabelaB,
    }, tx),
    (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA",
  );
});

test("sem empresa um id explícito não escolhe tabela de empresa", async () => {
  const tx: DbExecutor = { async query<Row extends object>(): Promise<DbQueryResult<Row>> {
    throw new Error("consulta");
  } };
  await assert.rejects(
    () => precificarAdicionais({
      data: "2026-09-27", convidados: 20, itens: [], tabelaPrecoId: tabelaA,
    }, tx),
    (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA",
  );
});

test("o down da 048 trava por conta própria antes de enumerar e apagar", () => {
  const down = readFileSync(resolve(root, "database/rollback/20260927_048_supersessao_tabela_publicada_down.sql"), "utf8");
  const trava = down.indexOf("pg_advisory_xact_lock(hashtext('kidmais-048-down'))");
  const tabela = down.indexOf("LOCK TABLE public.tabelas_preco IN SHARE ROW EXCLUSIVE MODE");
  const empresas = down.indexOf("SELECT DISTINCT empresa_id");
  const queda = down.indexOf("DROP TRIGGER");
  assert.equal(trava >= 0 && tabela > trava && empresas > tabela && queda > empresas, true);
  assert.equal(down.includes("kidmais-048-supersessao"), false);
});
