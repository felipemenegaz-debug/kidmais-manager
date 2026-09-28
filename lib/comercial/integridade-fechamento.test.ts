import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";
import { listarAdicionaisAtivosComPreco, listarPacotesAtivosComElegibilidade } from "./repositories/comercial.repository.ts";
import { listarCodigosInclusos } from "./composicao.ts";

const req = createRequire(import.meta.url);
const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";
const pacoteB = "33333333-3333-4333-8333-333333333333";
const PAROU = "PAROU_DEPOIS_DA_GUARDA";

function pacoteRow(empresaId: string | null) {
  return {
    id: pacoteB, codigo: "COMPLETA", nome: "Completa", descricao: null, convidados_minimos: 20,
    convidados_maximos: 80, duracao_minutos: 240, ordem_exibicao: 1, ativo: true, vigente: true, empresa_id: empresaId,
  };
}

/** Responde só à busca do pacote; qualquer consulta seguinte prova que a guarda deixou passar. */
function bancoDoPacote(pacote: object | null) {
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string): Promise<DbQueryResult<Row>> {
      consultas.push(sql);
      if (consultas.length === 1) {
        assert.match(sql, /FROM pacotes/);
        return { rows: pacote ? [pacote as Row] : [], rowCount: pacote ? 1 : 0 };
      }
      throw new Error(PAROU);
    },
  };
  return { tx, consultas };
}

const base = { data: "2031-03-01", configuracaoAgendaId: "44444444-4444-4444-8444-444444444444", pacoteId: pacoteB, convidados: 20 };

function erroObservavel(error: unknown) {
  assert.ok(error instanceof PricingServiceError);
  return JSON.stringify({ code: error.code, httpStatus: error.httpStatus, message: error.message, details: error.details });
}

test("pacote de outra empresa é recusado antes de resolver tabela, preço ou adicionais, igual a inexistente", async () => {
  const inexistente = bancoDoPacote(null);
  const esperado = await calcularResumoComercial({ ...base, empresaEsperada: empresaA }, inexistente.tx).then(
    () => assert.fail("deveria recusar"), erroObservavel);
  for (const [empresaPacote, esperada] of [[empresaB, empresaA], [empresaA, null], [null, empresaA]] as const) {
    const { tx, consultas } = bancoDoPacote(pacoteRow(empresaPacote));
    const obtido = await calcularResumoComercial({ ...base, empresaEsperada: esperada }, tx).then(
      () => assert.fail("deveria recusar"), erroObservavel);
    assert.equal(obtido, esperado, `a resposta não distingue outro tenant de inexistente: ${empresaPacote} x ${esperada}`);
    assert.equal(consultas.length, 1, "nenhuma consulta depois da recusa");
  }
  assert.match(esperado, /"code":"PACOTE_NAO_ENCONTRADO","httpStatus":404/);
});

test("mesma empresa, legado NULL/NULL e cálculo sem empresa esperada seguem para a resolução", async () => {
  for (const [empresaPacote, esperada] of [[empresaA, empresaA], [null, null], [empresaA, undefined]] as const) {
    const { tx } = bancoDoPacote(pacoteRow(empresaPacote));
    await assert.rejects(
      () => calcularResumoComercial({ ...base, empresaEsperada: esperada }, tx),
      (error: unknown) => error instanceof Error && error.message === PAROU,
      `${empresaPacote} x ${esperada}`,
    );
  }
});

test("pacote inexistente ou inativo continua PACOTE_NAO_ENCONTRADO, mesmo com empresa esperada", async () => {
  const { tx, consultas } = bancoDoPacote(null);
  await assert.rejects(
    () => calcularResumoComercial({ ...base, empresaEsperada: empresaA }, tx),
    (error: unknown) => error instanceof PricingServiceError && error.code === "PACOTE_NAO_ENCONTRADO",
  );
  assert.equal(consultas.length, 1);
  assert.match(consultas[0], /ativo = true/);
});

function capturar() {
  const chamadas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
      chamadas.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, chamadas };
}

test("adicionais por código só da empresa dona da tabela: mesmo código em outra empresa não entra", async () => {
  const { tx, chamadas } = capturar();
  await listarAdicionaisAtivosComPreco({ tabelaPrecoId: "55555555-5555-4555-8555-555555555555", convidados: 20, codigos: ["decoracao"] }, tx);
  const sql = chamadas[0].sql.replace(/\s+/g, " ");
  // JOIN (não subconsulta): tabela inexistente não devolve nada, em vez de virar legado NULL.
  assert.match(sql, /JOIN tabelas_preco tabela ON tabela\.id = \$1::uuid AND a\.empresa_id IS NOT DISTINCT FROM tabela\.empresa_id/);
  assert.doesNotMatch(sql, /IS NOT DISTINCT FROM \( SELECT/);
  assert.deepEqual(chamadas[0].values, ["55555555-5555-4555-8555-555555555555", 20, ["DECORACAO"]]);
});

test("composição escopada: com empresa esperada, pacote e adicional têm de ser dessa empresa", async () => {
  for (const empresa of [empresaA, null]) {
    const { tx, chamadas } = capturar();
    await listarCodigosInclusos(tx, pacoteB, empresa);
    const sql = chamadas[0].sql.replace(/\s+/g, " ");
    assert.match(sql, /JOIN pacotes p ON p\.id = pa\.pacote_id AND p\.empresa_id IS NOT DISTINCT FROM \$2::uuid/);
    assert.match(sql, /JOIN adicionais a ON a\.id = pa\.adicional_id AND a\.empresa_id IS NOT DISTINCT FROM \$2::uuid/);
    assert.deepEqual(chamadas[0].values, [pacoteB, empresa]);
  }
  const { tx, chamadas } = capturar();
  await listarCodigosInclusos(tx, pacoteB);
  assert.deepEqual(chamadas[0].values, [pacoteB], "sem empresa esperada, chamadores antigos não mudam");
});

test("a listagem de pacotes da prévia é da empresa informada, e null é só o legado", async () => {
  for (const empresaId of [empresaA, null]) {
    const { tx, chamadas } = capturar();
    await listarPacotesAtivosComElegibilidade({ data: "2031-03-01", configuracaoAgendaId: base.configuracaoAgendaId, empresaId }, tx);
    assert.match(chamadas[0].sql.replace(/\s+/g, " "), /p\.empresa_id IS NOT DISTINCT FROM \$3::uuid/);
    assert.equal(chamadas[0].values[2], empresaId);
  }
});

/** Carrega o módulo transpilado com dependências substituídas pelo especificador; sem banco. */
function carregar(arquivo: string, mocks: Record<string, unknown>) {
  const cache = new Map<string, Record<string, unknown>>();
  const caminho = (base: string) => [`${base}.ts`, `${base}/index.ts`, base].find(existsSync) ?? base;
  function load(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id: string) => {
      if (id in mocks) return mocks[id];
      if (!id.startsWith(".")) return req(id);
      return load(caminho(resolve(dirname(file), id).replace(/\.ts$/, "")));
    };
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return load(resolve(arquivo));
}

function edicao(pacoteId: string) {
  return {
    acao: "editar_festa", revisao: 1, motivo: "Troca adulterada", fonteHash: "a".repeat(64), pacoteId, convidados: 20,
    dataEvento: "2031-03-01", configuracaoAgendaId: base.configuracaoAgendaId, horarioInicio: "14:00", horarioFim: "18:00",
    adicionais: [], idadeAniversarianteEvento: null, temaFesta: "", buffetStatus: "PENDENTE", buffetSalgados: "",
    buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "",
  };
}

function servicoDeEdicao(empresaGravada: string | null | undefined) {
  const estado = { entradas: [] as Array<Record<string, unknown>>, empresaConsultada: [] as string[] };
  const recusaDoPreco = new PricingServiceError("PACOTE_NAO_ENCONTRADO", "O pacote informado não existe ou está inativo.", 404);
  const modulo = carregar("lib/fechamentos/services/edicao-administrativa.service.ts", {
    "../repositories": {
      empresaDoFechamento: async (id: string) => { estado.empresaConsultada.push(id); return empresaGravada; },
      buscarFechamentoPorIdParaAtualizacao: async () => { throw new Error("não usado"); },
      criarAprovacaoNegociacao: async () => { throw new Error("não usado"); },
      listarAdicionaisDoFechamento: async () => [],
    },
    "../../comercial/services": {
      calcularResumoComercial: async (entrada: Record<string, unknown>) => {
        estado.entradas.push(entrada);
        throw recusaDoPreco;
      },
    },
    "../../comercial/condicao-pagamento": {},
    "../../disponibilidade/services": {},
    "../../disponibilidade/repositories": {},
    "../repositories/edicao.repository": {},
    "../../clientes/repositories": {},
    "./pacote-snapshot": {},
    "../../comercial/composicao": {},
  });
  return { calcular: modulo.calcularEdicaoFechamento as (f: object, raw: unknown, tx: DbExecutor) => Promise<unknown>, estado, recusaDoPreco };
}

const fechamentoGravado = { id: "66666666-6666-4666-8666-666666666666", pacoteId: "77777777-7777-4777-8777-777777777777" };
const semBanco: DbExecutor = { query: async () => { throw new Error("DB_NAO_DEVE_RODAR"); } };

test("edição: a empresa esperada vem do fechamento gravado, nunca do pacote do pedido", async () => {
  const { calcular, estado, recusaDoPreco } = servicoDeEdicao(empresaA);
  await assert.rejects(() => calcular(fechamentoGravado, edicao(pacoteB), semBanco), (error: unknown) => error === recusaDoPreco);
  assert.deepEqual(estado.empresaConsultada, [fechamentoGravado.id]);
  assert.equal(estado.entradas.length, 1);
  assert.equal(estado.entradas[0].empresaEsperada, empresaA);
  assert.equal(estado.entradas[0].pacoteId, pacoteB);
});

test("edição: fechamento que some entre a leitura e o cálculo é recusado antes do preço", async () => {
  const { calcular, estado } = servicoDeEdicao(undefined);
  await assert.rejects(() => calcular(fechamentoGravado, edicao(pacoteB), semBanco), /Fechamento não encontrado/);
  assert.equal(estado.entradas.length, 0);
});

test("edição legado: fechamento sem empresa exige pacote também sem empresa (null, não undefined)", async () => {
  const { calcular, estado } = servicoDeEdicao(null);
  await assert.rejects(() => calcular(fechamentoGravado, edicao(pacoteB), semBanco));
  assert.equal(estado.entradas[0].empresaEsperada, null);
});

test("revisão operacional e prévia da edição passam a empresa do fechamento gravado", () => {
  const revisao = readFileSync("lib/fechamentos/services/revisao-operacional.service.ts", "utf8");
  assert.match(revisao, /const empresaEsperada = await empresaDoFechamento\(r\.fechamento_id, tx\);/);
  assert.match(revisao, /calcularResumoComercial\(\{[^}]*empresaEsperada \}, tx\)/);
  const rota = readFileSync("app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts", "utf8");
  assert.match(rota, /const empresaId = await empresaDoFechamento\(v\.snapshot\.fechamento\.id, db\(\)\);/);
  assert.match(rota, /listarPacotesComerciais\(\{ data, configuracaoAgendaId, empresaId \}\)/);
  assert.match(rota, /listarCatalogoAdicionais\(\{ data, convidados, empresaId \}\)/);
  assert.match(rota, /empresaEsperada: empresaId/);
  // A5: a composição é escopada pela empresa e lida antes do cálculo; não depende do erro do preço.
  assert.match(rota, /const incluidos = await listarCodigosInclusos\(db\(\), pacoteId, empresaId\);/);
  assert.ok(rota.indexOf("listarCodigosInclusos(db(), pacoteId, empresaId)") < rota.indexOf("calcularResumoComercial("));
  assert.doesNotMatch(rota, /listarCodigosInclusos\(db\(\), pacoteId\)/);
  for (const servico of ["lib/fechamentos/services/edicao-administrativa.service.ts", "lib/fechamentos/services/revisao-operacional.service.ts"]) {
    assert.match(readFileSync(servico, "utf8"), /listarCodigosInclusos\(tx, resumo\.pacote\.pacote\.id, empresaEsperada\)/, servico);
  }
  for (const fonte of [revisao, rota]) {
    assert.doesNotMatch(fonte, /empresaEsperada:\s*(input|q|body|request)\b/);
  }
});
