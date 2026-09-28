import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { DbExecutor, DbQueryResult } from "../../db/contracts.ts";
import { lerFotografiaPacoteVigente } from "../../contratos/services/fotografia-pacote.ts";
import { gerarPdfContratoOficial, renderizarContratoOficial } from "../../contratos/documento/index.ts";
import type { ContratoSnapshot } from "../../contratos/repositories/models.ts";

const req = createRequire(import.meta.url);
const nomeRevisao = "Nome da revisão operacional";

function caminhoTs(base: string) {
  const sem = base.replace(/\.tsx?$/, "");
  if (existsSync(`${sem}.ts`)) return `${sem}.ts`;
  if (existsSync(`${sem}.tsx`)) return `${sem}.tsx`;
  if (existsSync(`${sem}/index.ts`)) return `${sem}/index.ts`;
  return base;
}

function carregar(arquivo: string, mocks: Record<string, unknown>) {
  const cache = new Map<string, Record<string, unknown>>();
  function load(file: string): Record<string, unknown> {
    const normal = resolve(file).replaceAll("\\", "/");
    const hit = cache.get(normal);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(normal, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id: string) => {
      if (!id.startsWith(".") && !id.startsWith("@/")) return req(id);
      const base = id.startsWith("@/") ? resolve(id.slice(2)) : resolve(dirname(file), id);
      const alvo = caminhoTs(base);
      const chave = resolve(alvo).replaceAll("\\", "/");
      for (const [sufixo, mock] of Object.entries(mocks)) {
        if (chave.endsWith(sufixo)) return mock;
      }
      return load(alvo);
    };
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return load(resolve(arquivo));
}

test("mudança de convidados sem trocar o pacote também cria fotografia", async () => {
  let fotografias = 0;
  const auditoria: Record<string, unknown>[] = [];
  const modulo = carregar("lib/fechamentos/services/edicao-administrativa.service.ts", {
    "lib/comercial/services/index.ts": { calcularResumoComercial: async () => ({
      pacote: { pacote: { id: "11111111-1111-4111-8111-111111111111", convidadosMinimos: 1 }, tabelaPreco: { id: "tabela-1" }, precoRegra: { id: "preco-1", categoriaHorario: "PADRAO" }, desconto: { regraId: null, percentual: 0 }, categoriaHorario: "PADRAO", convidadosFaturados: 50 },
      adicionais: { itens: [] }, valorTabelaPacoteBase: 1000, valorDescontoPacote: 0, valorTabelaPacoteAplicado: 1200, valorAdicionais: 0, valorTotalTabela: 1200,
    }) },
    "lib/comercial/condicao-pagamento.ts": {},
    "lib/disponibilidade/services/index.ts": {},
    "lib/disponibilidade/repositories/index.ts": {},
    "lib/fechamentos/repositories/index.ts": {
      buscarFechamentoPorIdParaAtualizacao: async () => ({
        id: "fechamento-1", clienteId: "cliente-1", status: "APROVADO", pacoteId: "11111111-1111-4111-8111-111111111111",
        dataEvento: "2026-10-10", horarioInicio: "14:00:00", horarioFim: "18:00:00", configuracaoAgendaId: "22222222-2222-4222-8222-222222222222",
        convidados: 40, valorTabela: 1000, valorNegociado: null, formaPagamentoPretendida: null, condicaoPagamento: null,
      }),
      listarAdicionaisDoFechamento: async () => [],
      criarAprovacaoNegociacao: async () => {},
      empresaDoFechamentoComTrava: async () => null,
    },
    "lib/fechamentos/repositories/edicao.repository.ts": { persistirEdicaoFechamento: async () => {} },
    "lib/clientes/repositories/index.ts": { registrarAuditoria: async (evento: Record<string, unknown>) => { auditoria.push(evento); } },
    "lib/fechamentos/services/errors.ts": { FechamentoServiceError: class extends Error { code: string; httpStatus: number; constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.httpStatus = status; } } },
    "lib/fechamentos/services/pacote-snapshot.ts": { fotografarEstadoFechamento: async () => { fotografias += 1; return { id: "snap-nova", empresaId: null }; } },
    "lib/comercial/composicao.ts": { listarCodigosInclusos: async () => [] },
  });
  const editar = modulo.editarFechamentoAdministrativo as (id: string, raw: object, usuarioId: string, requestId: string, tx: DbExecutor) => Promise<unknown>;
  const tx: DbExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
  await editar("fechamento-1", {
    acao: "editar_festa", revisao: 1, motivo: "Mais convidados", fonteHash: "a".repeat(64),
    pacoteId: "11111111-1111-4111-8111-111111111111", convidados: 50,
    dataEvento: "2026-10-10", configuracaoAgendaId: "22222222-2222-4222-8222-222222222222",
    horarioInicio: "14:00", horarioFim: "18:00", adicionais: [],
    idadeAniversarianteEvento: null, temaFesta: "", buffetStatus: "PENDENTE",
    buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
    observacoesEquipe: "",
  }, "usuario-1", "req-1", tx);
  assert.equal(fotografias, 1);
  assert.equal((auditoria[0].dadosDepois as { pacoteSnapshotId: string }).pacoteSnapshotId, "snap-nova");
});

test("aplicar a revisão operacional e a revisão inicial fotografam o estado persistido", async () => {
  const fotos: string[] = [];
  const fotoMock = { fotografarEstadoFechamento: async (_tx: unknown, id: string) => { fotos.push(id); return { id: "snap-op", empresaId: null }; } };
  const repositorio = carregar("lib/fechamentos/repositories/revisao.repository.ts", {
    "lib/fechamentos/services/pacote-snapshot.ts": fotoMock,
  });
  const aplicar = repositorio.aplicarOperacaoPreparada as (tx: DbExecutor, r: { id: string; fechamento_id: string; motivo: string }) => Promise<string | null>;
  const sqls: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      sqls.push(text);
      if (text.includes("information_schema.columns")) return { rows: [{ ok: false } as Row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  assert.equal(await aplicar(tx, { id: "rev-1", fechamento_id: "fechamento-op", motivo: "Revisão operacional" }), "snap-op");
  assert.equal(fotos[0], "fechamento-op");
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE fechamentos")), true);
  assert.equal(sqls.some((sql) => /UPDATE fechamento_pacote_snapshots|DELETE FROM fechamento_pacote_snapshots/.test(sql)), false);

  const inicial = carregar("lib/contratos/services/revisao-inicial.ts", {
    "lib/db/postgres.ts": { db: () => { throw new Error("db"); } },
    "lib/fechamentos/services/edicao-administrativa.service.ts": {},
    "lib/fechamentos/repositories/edicao.repository.ts": { persistirEdicaoFechamento: async () => {} },
    "lib/fechamentos/services/pacote-snapshot.ts": { fotografarEstadoFechamento: async (_tx: unknown, id: string) => { fotos.push(id); return { id: "snap-inicial", empresaId: "empresa-1" }; } },
    "lib/fechamentos/repositories/index.ts": { buscarFechamentoPorId: async () => ({ id: "fechamento-ini", clienteId: "cliente-1", aniversarianteId: "aniv-1" }), listarAdicionaisDoFechamento: async () => [] },
    "lib/clientes/repositories/index.ts": { registrarAuditoria: async (evento: { dadosDepois: { pacoteSnapshotId: string; empresaId: string } }) => { fotos.push(evento.dadosDepois.pacoteSnapshotId + ":" + evento.dadosDepois.empresaId); }, buscarResponsavelPorId: async () => null },
    "lib/clientes/services/validators.ts": {},
    "lib/disponibilidade/repositories/index.ts": { adquirirLockConfirmacaoAgenda: async () => {} },
    "lib/disponibilidade/services/index.ts": { consultarDisponibilidadeData: async () => ({ periodos: [{ configuracaoId: "agenda-1", horarios: [{ status: "DISPONIVEL", inicio: "14:00", fim: "18:00" }] }] }) },
    "lib/contratos/services/contrato.service.ts": {},
    "lib/contratos/services/snapshot-core.ts": { hashSnapshotContrato: () => "hash-base" },
  });
  const aplicarInicial = inicial.aplicarRevisaoInicial as (tx: DbExecutor, v: object, proposta: object) => Promise<void>;
  const txInicial: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      if (text.includes("versao_vigente_id")) return { rows: [{ versao_vigente_id: null, versao_em_preparacao_id: "versao-1" } as Row], rowCount: 1 };
      if (text.includes("contrato_assinaturas")) return { rows: [{ parte: "KIDMAIS" } as Row, { parte: "CLIENTE" } as Row], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
  };
  await aplicarInicial(txInicial, {
    id: "versao-1", contratoId: "contrato-1", status: "ASSINADA", snapshotHash: "hash", snapshot: { fechamento: { id: "fechamento-ini" } },
  }, {
    baseHash: "hash-base", motivo: "Proposta inicial",
    fechamento: { id: "fechamento-ini", clienteId: "cliente-1", aniversarianteId: "aniv-1", dataEvento: "2026-10-10", horarioInicio: "14:00:00", horarioFim: "18:00:00", configuracaoAgendaId: "agenda-1" },
    resumo: {},
  });
  assert.equal(fotos.includes("fechamento-ini"), true);
  assert.equal(fotos.includes("snap-inicial:empresa-1"), true);
});

test("a fotografia nova preserva a anterior e o schema 2 usa o nome gravado", async () => {
  const gravados: unknown[][] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      if (text.includes("to_regclass")) return { rows: [{ rel: "fechamento_pacote_snapshots" } as Row], rowCount: 1 };
      if (text.includes("FOR UPDATE OF f")) {
        return { rows: [{
          pacote_snapshot_vigente_id: "snap-anterior", pacote_id: "pacote-1", codigo: "COMPLETA", nome: nomeRevisao,
          descricao: null, duracao_minutos: null, tabela_preco_id: "tabela-1", tabela_codigo: "TABELA", tabela_nome: "Tabela",
          preco_pacote_id: "preco-1", tipo_calculo: "FIXO", convidados_min: 40, convidados_max: 80, categoria_preco_linha: "PADRAO",
          valor_linha: "1000", regra_desconto_pacote_id: null, regra_codigo: null, regra_titulo: null,
          categoria_horario: "PADRAO", categoria_preco_aplicada: "PADRAO", convidados: 55, convidados_faturados: 55,
          desconto_percentual: "0", valor_pacote_base: "1000", valor_desconto_pacote: "0", valor_pacote_aplicado: "1000",
          valor_adicionais: "0", valor_tabela: "1000",
        } as Row], rowCount: 1 };
      }
      if (text.includes("column_name = 'empresa_id'")) return { rows: [{ ok: 1 } as Row], rowCount: 1 };
      if (text.includes("SELECT empresa_id")) return { rows: [{ empresa_id: null } as Row], rowCount: 1 };
      if (text.startsWith("INSERT INTO fechamento_pacote_snapshots")) {
        gravados.push([...(values ?? [])]);
        return { rows: [{ id: "snap-nova" } as Row], rowCount: 1 };
      }
      if (text.includes("pa.modalidade = 'INCLUSO'")) return { rows: [{ id: "ad-1", codigo: "PENNE", nome: "Penne" } as Row], rowCount: 1 };
      if (text.includes("FROM pacote_buffet_categorias")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO fechamento_pacote_composicao")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE fechamentos")) {
        assert.deepEqual(values, ["snap-nova", "fechamento-1", "snap-anterior"]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  const fotografarEstadoFechamento = carregar("lib/fechamentos/services/pacote-snapshot.ts", {}).fotografarEstadoFechamento as (
    tx: DbExecutor,
    fechamentoId: string,
    contexto: { motivo: string; atorUsuarioId: string | null },
  ) => Promise<{ id: string; empresaId: string | null } | null>;
  const foto = await fotografarEstadoFechamento(tx, "fechamento-1", { motivo: "Mais convidados", atorUsuarioId: "usuario-1" });
  assert.equal(foto?.id, "snap-nova");
  assert.equal(gravados[0][3], nomeRevisao);
  assert.equal(gravados[0][30], "snap-anterior");
  const leitura = await lerFotografiaPacoteVigente({
    async query(text: string) {
      if (text.includes("to_regclass")) return { rows: [{ rel: "fechamento_pacote_snapshots" }], rowCount: 1 };
      if (text.includes("nome_aplicado")) return { rows: [{ id: "snap-nova", pacote_id: "pacote-1", codigo_aplicado: "COMPLETA", nome_aplicado: gravados[0][3], descricao_aplicada: null, duracao_minutos_aplicada: null, tabela_preco_id: "tabela-1", tabela_codigo_aplicado: "TABELA", tabela_nome_aplicado: "Tabela" }], rowCount: 1 };
      return { rows: [{ tipo: "INCLUSO", codigo_aplicado: "PENNE", nome_aplicado: "Penne", modo_itens: null, escolhas_min: null, escolhas_max: null }], rowCount: 1 };
    },
  } as DbExecutor, "fechamento-1");
  assert.equal(leitura?.nome, nomeRevisao);
  const snapshot = {
    schemaVersao: 2 as const,
    fechamento: { id: "11111111-1111-4111-8111-111111111111", status: "AGUARDANDO_CONTRATO", origem: "CLIENTE" },
    contratante: {
      clienteId: "22222222-2222-4222-8222-222222222222", nomeCompleto: "João da Silva", cpf: "12345678909", rg: null,
      telefone: "61999999999", whatsapp: "61999999999", email: "joao@example.com",
      endereco: { cep: "70800000", logradouro: "SQN 000", numero: "10", complemento: "Bloco A", bairro: "Asa Norte", cidade: "Brasília", uf: "DF" },
    },
    responsavelAdicional: null,
    aniversariante: { id: "33333333-3333-4333-8333-333333333333", nome: "Maria", dataNascimento: "2020-05-10", idadeNoEvento: 6, temaFesta: "Ciência" },
    evento: {
      data: "2026-10-20", horarioInicio: "18:00:00", horarioFim: "22:00:00",
      pacote: { id: "pacote-1", codigo: "COMPLETA", nome: leitura!.nome, duracaoMinutos: leitura!.duracaoMinutos },
      convidados: 55, convidadosFaturados: 55,
    },
    contratacao: { adicionais: [], alteracoesPacote: null, observacoesCliente: null, observacoesEquipe: null, buffet: { status: "PENDENTE", salgados: null, bebidas: null, doces: null, bolo: null, outros: null } },
    comercial: {
      tabelaPreco: { id: "tabela-1", codigo: "TABELA", nome: "Tabela" }, categoriaHorario: "PADRAO", categoriaPrecoAplicada: "PADRAO",
      valorPacoteBase: 1000, descontoPercentual: 0, valorDescontoPacote: 0, valorPacoteAplicado: 1000, valorAdicionais: 0, valorTabela: 1000,
      valorNegociado: null, valorAprovado: null, valorFinalContrato: 1000, formaPagamentoPretendida: "PIX_AVISTA",
    },
    pacoteAplicado: leitura!,
  } satisfies ContratoSnapshot;
  const documento = renderizarContratoOficial({ snapshot, numeroVersao: 1, snapshotHash: "a".repeat(64), templateVersao: 4 });
  assert.ok(documento);
  assert.equal(documento.pacoteNome, nomeRevisao);
  assert.match(documento.clausulas[0].texto, new RegExp(nomeRevisao));
  assert.equal(documento.clausulas[0].texto.includes("Festa Completa"), false);
  const pdf = gerarPdfContratoOficial(documento).toString("latin1");
  assert.match(pdf, /Nome da revis/);
  assert.equal(pdf.includes("Festa Completa"), false);
});

test("o fluxo público aplica a preparação antes de promover a versão", () => {
  const fluxo = readFileSync("lib/contratos/services/fluxo-publico.ts", "utf8");
  const preparar = readFileSync("lib/fechamentos/services/revisao-operacional.service.ts", "utf8");
  assert.match(fluxo, /concluirPreparacao\(tx,preparacao/);
  assert.match(fluxo, /aplicarRevisaoInicial/);
  assert.match(preparar, /aplicarOperacaoPreparada\(tx, r, c\.usuarioId\)/);
  assert.match(readFileSync("lib/fechamentos/services/fechamento.service.ts", "utf8"), /gravarFotografiaPacoteFechamento/);
});
