import { avaliarIntegracao, decisoesSchema, hashResumo } from "../../contratos/integracao-importados/modelo.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { executarImportacao } from "../../importacao-contrato/motor.ts";
import type { PlanoImportacao } from "../../importacao-contrato/plano.ts";
import type { ImportacaoLida } from "../../importacao-contrato/repositorio-importacao.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { criarRepositorioOperacoesEmMemoria } from "../acoes/memoria.ts";
import { criarModuloAcoes } from "../acoes/modulo.ts";
import { atenderOperacao } from "../acoes/operacoes.ts";
import type { AIResponse, RascunhoPublico } from "../contratos.ts";
import { LINHAS, bancoTenant, documentosMemoria, empresaA, empresaB, pdf, sequencia, usuario } from "../documentos/apoio.test.ts";
import { atenderDocumento, type DocumentoPublico } from "../documentos/upload.ts";
import type { RastreioInteligencia } from "../rastreio.ts";
import { criarAcaoImportacao, type PortaImportacao } from "./acao.ts";
import { atenderImportacao, type DependenciasImportacao, type ImportacaoPublica, type PlanoPublico } from "./revisao.ts";

const ENV = { INTELIGENCIA_ENABLED: "true", AI_CONTRACT_IMPORT_ENABLED: "true" };

/** Importação em memória sobre o repositório de documentos, com o Import Engine real e CRM falso. */
function importacaoMemoria(documentos: ReturnType<typeof documentosMemoria>, novoId: () => string) {
  const importacoes = new Map<string, ImportacaoLida & { empresaId: string }>();
  /** Importações cujo contrato integrado foi cancelado (simula contrato_importacoes → contratos.status = CANCELADO). */
  const contratosCancelados = new Set<string>();
  const clientesCriados: Array<{ empresaId: string; dados: object }> = [];
  const executados: PlanoImportacao[] = [];
  const porta: PortaImportacao = {
    async disponivel() { return true; },
    ultimaExtracao: documentos.porta.ultimaExtracao,
    async abrirImportacao(_tx, e) {
      // Mesmo contrato do repositório: uma ativa por documento; a descartada é histórico.
      const existente = [...importacoes.values()].find((x) => x.documentoId === e.documentoId && x.empresaId === e.empresaId && x.status !== "DESCARTADA");
      if (existente) return structuredClone(existente);
      const nova = { id: novoId(), documentoId: e.documentoId, extracaoId: e.extracaoId, status: "EM_REVISAO" as const, versao: 1, dados: structuredClone(e.dados), clienteId: null, resultado: null, criadoPor: e.usuarioId, empresaId: e.empresaId };
      importacoes.set(nova.id, nova);
      return structuredClone(nova);
    },
    async lerImportacao(_tx, empresaId, idImportacao) { const i = importacoes.get(idImportacao); return i && i.empresaId === empresaId ? structuredClone(i) : null; },
    // Mesmo contrato do repositório: ativa do documento; sem ativa, a última descartada.
    async importacaoPorDocumento(_tx, empresaId, documentoId) {
      const doDocumento = [...importacoes.values()].filter((x) => x.documentoId === documentoId && x.empresaId === empresaId);
      const escolhida = doDocumento.find((x) => x.status !== "DESCARTADA") ?? doDocumento.at(-1);
      return escolhida ? structuredClone(escolhida) : null;
    },
    async atualizarImportacao(_tx, empresaId, i, versao) {
      const atual = importacoes.get(i.id);
      if (!atual || atual.empresaId !== empresaId || atual.versao !== versao) return false;
      if (atual.extracaoId !== i.extracaoId || atual.documentoId !== i.documentoId || atual.criadoPor !== i.criadoPor) throw new Error('Identidade da importação é imutável (055d).');
      if (atual.status !== 'EM_REVISAO' || i.versao <= atual.versao) throw new Error('Transição recusada pela guarda 055d.');
      importacoes.set(i.id, { ...structuredClone(i), empresaId });
      return true;
    },
    // Mesmo contrato da guarda 064: só IMPORTADA, só com contrato cancelado, versão conferida; resultado vai para dados.
    async substituirImportacaoCancelada(_tx, empresaId, i, usuarioId) {
      const atual = importacoes.get(i.id);
      if (!atual || atual.empresaId !== empresaId || atual.status !== "IMPORTADA" || atual.versao !== i.versao || !contratosCancelados.has(i.id)) return false;
      importacoes.set(i.id, { ...atual, status: "DESCARTADA", versao: atual.versao + 1, clienteId: null, resultado: null,
        dados: { ...atual.dados, substituicao: { por: usuarioId, clienteId: atual.clienteId, resultado: atual.resultado } } });
      return true;
    },
    async analisarCliente() { return { cpfExistente: null, possiveisDuplicidades: [] }; },
    async executar(tx, e) {
      executados.push(e.plano);
      return executarImportacao(tx, e, {
        async cadastrarCliente(_tx, empresaId, dados) { clientesCriados.push({ empresaId, dados }); return { clienteId: "cccccccc-0000-4000-8000-00000000000c" }; },
        async conferirCliente() {},
        atualizarImportacao: porta.atualizarImportacao,
      });
    },
  };
  return { porta, importacoes, clientesCriados, executados, contratosCancelados };
}

function ambiente(opcoes: { env?: Record<string, string>; papel?: string } = {}) {
  const novoId = sequencia();
  const documentos = documentosMemoria(novoId);
  const importacao = importacaoMemoria(documentos, novoId);
  const rastros: RastreioInteligencia[] = [];
  let seq = 0;
  const estado = { sessao: { usuario_id: usuario, papel: opcoes.papel ?? "ADMINISTRATIVO" } as SessaoParaTenant, transacoes: 0 };
  const tx = bancoTenant(() => estado.sessao.papel);
  const acao = criarAcaoImportacao(importacao.porta);
  const gate = { repositorio: criarRepositorioOperacoesEmMemoria(), agora: () => new Date("2026-09-28T15:00:00Z"), novoId: sequencia("2222-4222-8222-222222222222"), ttlConfirmacaoSegundos: 600 };
  const base = {
    env: { ...ENV, ...opcoes.env },
    autenticar: async () => estado.sessao,
    withTenantTransaction: <T>(s: SessaoParaTenant, empresa: string | null | undefined, work: Parameters<typeof executarNoTenant<T>>[3]) => { estado.transacoes += 1; return executarNoTenant(tx, s, empresa, work); },
    agora: () => new Date("2026-09-28T15:00:00Z"),
    requestId: () => `req-${++seq}`,
    registrar: (r: RastreioInteligencia) => rastros.push(structuredClone(r)),
    relogio: () => 0,
  };
  const deps: DependenciasImportacao = { ...base, importacao: importacao.porta, gate, acao };
  const enviar = async (empresa: string | null = empresaA) => {
    const r = await atenderDocumento({ empresaSolicitada: empresa, lerArquivo: async () => ({ nome: "contrato.pdf", tipo: "application/pdf", bytes: pdf(LINHAS) }) }, { ...base, documentos: documentos.porta, roteador: null });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    return (r.corpo as { data: DocumentoPublico }).data;
  };
  const importar = (corpo: object, empresa: string | null = empresaA) => atenderImportacao({ lerCorpo: async () => corpo, empresaSolicitada: empresa }, deps);
  const modulo = criarModuloAcoes([acao], gate);
  const decidir = (r: RascunhoPublico, decisao = "confirmar") => atenderOperacao({ lerCorpo: async () => ({ operacaoId: r.operacaoId, versao: r.versao, payloadHash: r.payloadHash, decisao }), empresaSolicitada: empresaA }, { ...base, acoes: modulo });
  const abrir = async (empresa: string | null = empresaA) => {
    const documento = await enviar(empresa);
    return dados(await importar({ acao: "abrir", documentoId: documento.documentoId }, empresa)).importacao;
  };
  return { deps, importacao, documentos, rastros, estado, enviar, importar, decidir, abrir, gate };
}

type Dados = { importacao: ImportacaoPublica; plano?: PlanoPublico | null; gate?: AIResponse | null };
const dados = (r: { corpo: unknown }) => (r.corpo as { data: Dados }).data;

test("abrir: importação nasce da extração registrada do documento; reabrir devolve a mesma; outra empresa não abre", async () => {
  const a = ambiente();
  const documento = await a.enviar();
  const aberta = await a.importar({ acao: "abrir", documentoId: documento.documentoId });
  assert.equal(aberta.status, 200, JSON.stringify(aberta.corpo));
  const importacao = dados(aberta).importacao;
  assert.deepEqual(importacao.extracao, documento.extracao);
  assert.equal(importacao.documentoId, documento.documentoId);
  const deNovo = dados(await a.importar({ acao: "abrir", documentoId: documento.documentoId })).importacao;
  assert.equal(deNovo.id, importacao.id);
  // Documento de outra empresa e documento inexistente: mesma resposta.
  const outra = await a.importar({ acao: "abrir", documentoId: documento.documentoId }, empresaB);
  const inexistente = await a.importar({ acao: "abrir", documentoId: "99999999-9999-4999-8999-999999999999" });
  assert.equal(outra.status, 404);
  assert.deepEqual(outra.corpo, inexistente.corpo);
});

test("revisão → preparar → Human Gate → Import Engine: grava uma vez, cliente no tenant comprovado, pagamentos só previstos", async () => {
  const a = ambiente();
  let importacao = await a.abrir();
  // Entrada + parcela (2.900 + 5.000) não batem com 8.900 ⇒ entrada/parcela pedem revisão.
  const pendentes = importacao.extracao.secoes.flatMap((s) => s.campos).filter((c) => c.estado === "PRECISA_REVISAO").map((c) => c.id);
  assert.ok(pendentes.length > 0);
  const bloqueado = dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao }));
  assert.equal(bloqueado.gate, null);
  assert.equal(bloqueado.plano?.pronto, false);
  for (const campoId of pendentes) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId, confirmarDivergencia: true })).importacao;
  }
  const invalido = await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: "contratante.cpf", valor: "000" });
  assert.equal(invalido.status, 422);
  const pronto = dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao }));
  assert.equal(pronto.plano?.pronto, true, JSON.stringify(pronto.plano));
  assert.equal(pronto.gate?.tipo, "preview");
  const preview = (pronto.gate as { rascunho: RascunhoPublico }).rascunho;
  const linhas = Object.fromEntries(preview.campos.map((c) => [c.id, c.valor]));
  assert.equal(linhas.cliente, "Criar cliente Mariana Souza Lima");
  assert.match(linhas.pagamento ?? "", /previsto, não pago/);
  assert.equal(JSON.stringify(preview).includes("529.982.247-25"), false, "o registro do gate não carrega CPF");
  assert.equal(a.importacao.executados.length, 0, "nenhuma mutação de negócio antes do clique");
  assert.equal(a.importacao.clientesCriados.length, 0);

  const confirmado = await a.decidir(preview);
  assert.equal(confirmado.status, 200, JSON.stringify(confirmado.corpo));
  assert.equal(a.importacao.clientesCriados.length, 1);
  assert.equal(a.importacao.clientesCriados[0].empresaId, empresaA);
  assert.equal(a.importacao.executados[0].snapshot.pagamentosPrevistos.natureza, "PREVISTO");
  const final = [...a.importacao.importacoes.values()][0];
  assert.equal(final.status, "IMPORTADA");
  assert.equal(final.clienteId, "cccccccc-0000-4000-8000-00000000000c");
  assert.equal(/"(pago|pagoEm|recebido)"\s*:/.test(JSON.stringify(final.resultado)), false);

  // Replay: não cria outro cliente.
  assert.equal((await a.decidir(preview)).status, 200);
  assert.equal(a.importacao.clientesCriados.length, 1);
});

test("estados terminais: descartada não muda e não bloqueia reabrir o mesmo documento; importada não é reaberta nem reimportada", async () => {
  const a = ambiente();
  const primeira = await a.abrir();
  const descartada = dados(await a.importar({ acao: "descartar", importacaoId: primeira.id, versao: primeira.versao })).importacao;
  assert.equal(descartada.status, "DESCARTADA");
  for (const corpo of [{ acao: "revisar", campoId: "evento.convidados", valor: "90" }, { acao: "preparar" }, { acao: "descartar" }]) {
    const r = await a.importar({ ...corpo, importacaoId: primeira.id, versao: descartada.versao });
    assert.equal((r.corpo as { codigo: string }).codigo, "IMPORTACAO_ENCERRADA");
  }
  // Mesmo arquivo de novo ⇒ mesmo documento (sha256) ⇒ nova importação aberta, sem herdar a revisão descartada.
  const segunda = await a.abrir();
  assert.notEqual(segunda.id, primeira.id);
  assert.equal(segunda.status, "EM_REVISAO");
  assert.equal(segunda.versao, 1);
  assert.equal(segunda.documentoId, primeira.documentoId);

  let importacao = segunda;
  for (const c of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const preview = (dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao })).gate as { rascunho: RascunhoPublico }).rascunho;
  assert.equal((await a.decidir(preview)).status, 200);
  const deNovo = await a.abrir();
  assert.equal(deNovo.id, segunda.id, "importada continua sendo a ativa do documento");
  assert.equal(deNovo.status, "IMPORTADA");
  const reimportar = await a.importar({ acao: "preparar", importacaoId: deNovo.id, versao: deNovo.versao });
  assert.equal((reimportar.corpo as { codigo: string }).codigo, "IMPORTACAO_ENCERRADA");
  assert.equal(a.importacao.clientesCriados.length, 1);
});

test("A6: importação concluída é consultável por documento e por id, com situação e resultado mínimo; nada é gravado na consulta", async () => {
  const a = ambiente();
  const documento = await a.enviar();
  const consultar = (empresa: string | null = empresaA) => a.importar({ acao: "consultar", documentoId: documento.documentoId }, empresa);
  type Consulta = { situacao: string; importacao: ImportacaoPublica | null };
  const consulta = (r: { corpo: unknown }) => (r.corpo as { data: Consulta }).data;

  // Antes de abrir: não iniciada (a consulta não abre importação).
  assert.deepEqual(consulta(await consultar()), { situacao: "NAO_INICIADA", importacao: null });
  assert.equal(a.importacao.importacoes.size, 0, "consultar nunca cria importação");

  let importacao = dados(await a.importar({ acao: "abrir", documentoId: documento.documentoId })).importacao;
  assert.equal(importacao.situacao, "EM_ANDAMENTO");
  assert.equal(importacao.resultado, null);
  assert.equal(consulta(await consultar()).situacao, "EM_ANDAMENTO");
  for (const c of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const preview = (dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao })).gate as { rascunho: RascunhoPublico }).rascunho;
  assert.equal((await a.decidir(preview)).status, 200);

  const final = consulta(await consultar());
  assert.equal(final.situacao, "CONCLUIDA");
  assert.equal(final.importacao!.status, "IMPORTADA");
  assert.deepEqual(final.importacao!.resultado, { clienteId: "cccccccc-0000-4000-8000-00000000000c", clienteAcao: "CRIAR", pendencias: final.importacao!.resultado!.pendencias, importadoEm: final.importacao!.resultado!.importadoEm, destino: "/clientes/cccccccc-0000-4000-8000-00000000000c" });
  assert.ok(final.importacao!.resultado!.importadoEm);
  assert.equal(JSON.stringify(final.importacao!.resultado).includes("529.982.247-25"), false, "resultado sem CPF/snapshot");
  // Por id: mesmo estado final, determinístico.
  const porId = dados(await a.importar({ acao: "ler", importacaoId: importacao.id })).importacao;
  assert.deepEqual([porId.situacao, porId.resultado], [final.importacao!.situacao, final.importacao!.resultado]);
  const versaoAntes = [...a.importacao.importacoes.values()][0].versao;
  await consultar(); await consultar();
  assert.equal([...a.importacao.importacoes.values()][0].versao, versaoAntes, "consulta não altera a importação");

  // Acesso negado: outra empresa (mesma resposta de inexistente), papel sem acesso, flag desligada.
  const outra = await consultar(empresaB);
  const inexistente = await a.importar({ acao: "consultar", documentoId: "99999999-9999-4999-8999-999999999999" });
  assert.equal(outra.status, 404);
  assert.deepEqual(outra.corpo, inexistente.corpo);
  a.estado.sessao = { usuario_id: usuario, papel: "PAPEL_INVENTADO" } as SessaoParaTenant;
  assert.equal((await consultar()).status, 403);
  const semFlag = ambiente({ env: { AI_CONTRACT_IMPORT_ENABLED: "false" } });
  assert.equal((await semFlag.importar({ acao: "consultar", documentoId: documento.documentoId })).status, 503);
});

/** Nada disto pode aparecer em NENHUM lugar da resposta serializada da consulta (B5). */
const PROIBIDOS_NA_CONSULTA = ["529.982.247-25", "52998224725", "Mariana", "Souza", "98765-4321", "11987654321", "IGNORE", "8.900", "8900", "contratoHistorico", "\"extracao\"", "\"secoes\"", "\"evidencia\"", "\"revisados\"", "\"decisaoCliente\"", "\"snapshot\""];
function semDadoSensivel(corpo: unknown, estado: string) {
  const texto = JSON.stringify(corpo);
  for (const proibido of PROIBIDOS_NA_CONSULTA) assert.equal(texto.includes(proibido), false, `${estado}: "${proibido}" na resposta completa`);
}

test("B5: consultar devolve só estado/resultado mínimo — resposta COMPLETA sem CPF, nomes, contatos, valores, extração ou snapshot, em todos os estados", async () => {
  const a = ambiente();
  const documento = await a.enviar();
  const consultar = async (estado: string) => {
    const r = await a.importar({ acao: "consultar", documentoId: documento.documentoId });
    assert.equal(r.status, 200, estado);
    semDadoSensivel(r.corpo, estado);
    const data = (r.corpo as { data: { situacao: string; importacao: Record<string, unknown> | null } }).data;
    if (data.importacao) assert.deepEqual(Object.keys(data.importacao).sort(), ["documentoId", "id", "resultado", "situacao", "status", "versao"], estado);
    return data;
  };
  assert.equal((await consultar("NAO_INICIADA")).situacao, "NAO_INICIADA");

  // Múltiplas importações do mesmo documento: a primeira é descartada, a segunda fica ativa.
  const primeira = await a.abrir();
  assert.equal((await consultar("EM_ANDAMENTO")).importacao!.id, primeira.id);
  await a.importar({ acao: "descartar", importacaoId: primeira.id, versao: primeira.versao });
  const cancelada = await consultar("CANCELADA");
  assert.deepEqual([cancelada.situacao, cancelada.importacao!.id], ["CANCELADA", primeira.id]);
  let segunda = await a.abrir();
  assert.notEqual(segunda.id, primeira.id);
  assert.deepEqual([(await consultar("EM_ANDAMENTO 2")).importacao!.id], [segunda.id], "a ativa vence a descartada");
  for (const c of segunda.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    segunda = dados(await a.importar({ acao: "revisar", importacaoId: segunda.id, versao: segunda.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const preview = (dados(await a.importar({ acao: "preparar", importacaoId: segunda.id, versao: segunda.versao })).gate as { rascunho: RascunhoPublico }).rascunho;
  assert.equal((await a.decidir(preview)).status, 200);
  const concluida = await consultar("CONCLUIDA");
  assert.deepEqual([concluida.situacao, concluida.importacao!.id], ["CONCLUIDA", segunda.id], "a importada vence a descartada");
  assert.equal((concluida.importacao!.resultado as { clienteId: string }).clienteId, "cccccccc-0000-4000-8000-00000000000c");

  // FALHOU (sem importação, extração falhou) também sem dado sensível.
  const b = ambiente();
  const doc = await b.enviar();
  b.documentos.extracoes.at(-1)!.status = "FALHOU";
  const falhou = await b.importar({ acao: "consultar", documentoId: doc.documentoId });
  semDadoSensivel(falhou.corpo, "FALHOU");
  assert.deepEqual((falhou.corpo as { data: unknown }).data, { situacao: "FALHOU", importacao: null });
  // Negada (outra empresa): 404 sem nada do documento.
  const negada = await a.importar({ acao: "consultar", documentoId: documento.documentoId }, empresaB);
  assert.equal(negada.status, 404);
  semDadoSensivel(negada.corpo, "negada");
});

test("A6: descartada consulta como CANCELADA; extração que falhou e sem importação consulta como FALHOU", async () => {
  const a = ambiente();
  const aberta = await a.abrir();
  await a.importar({ acao: "descartar", importacaoId: aberta.id, versao: aberta.versao });
  const r = (await a.importar({ acao: "consultar", documentoId: aberta.documentoId })).corpo as { data: { situacao: string; importacao: ImportacaoPublica } };
  assert.equal(r.data.situacao, "CANCELADA");
  assert.equal(r.data.importacao.resultado, null);

  const b = ambiente();
  const documento = await b.enviar();
  b.documentos.extracoes.at(-1)!.status = "FALHOU";
  const falhou = (await b.importar({ acao: "consultar", documentoId: documento.documentoId })).corpo as { data: { situacao: string; importacao: null } };
  assert.deepEqual(falhou.data, { situacao: "FALHOU", importacao: null });
});

test("revisão alterada depois do preview invalida a confirmação; outra empresa não lê a importação", async () => {
  const a = ambiente();
  let importacao = await a.abrir();
  for (const c of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const preview = (dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao })).gate as { rascunho: RascunhoPublico }).rascunho;
  await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: "evento.convidados", valor: "90" });
  const r = await a.decidir(preview);
  assert.equal((r.corpo as { codigo: string }).codigo, "CONFIRMACAO_DESATUALIZADA");
  assert.equal(a.importacao.clientesCriados.length, 0);

  const outra = await a.importar({ acao: "ler", importacaoId: importacao.id }, empresaB);
  assert.equal(outra.status, 404);
});

test("sem a feature ACTIONS instalada, preparar recusa com clareza e nada é executado", async () => {
  const a = ambiente();
  let importacao = await a.abrir();
  for (const c of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const r = await atenderImportacao({ lerCorpo: async () => ({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao }), empresaSolicitada: empresaA }, { ...a.deps, gate: null, acao: null });
  assert.equal(r.status, 503);
  assert.equal(a.importacao.executados.length, 0);
});

test("a conversa nunca abre a importação: ação só de tela", () => {
  const a = ambiente();
  assert.equal(a.deps.acao?.origem, "TELA");
  const modulo = criarModuloAcoes([a.deps.acao!], a.gate);
  assert.equal(modulo.descrever("importar_contrato")?.origem, "TELA");
});

test('reenvio recupera revisão vazia intocada e preserva revisão já editada', async () => {
  for (const editada of [false, true]) {
    const a = ambiente();
    const documento = await a.enviar();
    const aberta = dados(await a.importar({ acao: 'abrir', documentoId: documento.documentoId })).importacao;
    const atual = a.importacao.importacoes.get(aberta.id)!;
    const anteriores = atual.dados as unknown as { extracao: ImportacaoPublica['extracao']; revisados: string[] };
    for (const s of anteriores.extracao.secoes) for (const c of s.campos) { c.valor = null; c.estado = 'NAO_ENCONTRADO'; }
    if (editada) anteriores.revisados.push('contratante.nome');
    const registro = a.documentos.extracoes[0];
    a.documentos.extracoes.push({ ...structuredClone(registro), extracaoId: '99999999-1111-4111-8111-111111111111' });
    const r = await a.importar({ acao: 'abrir', documentoId: documento.documentoId });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const recuperada = dados(r).importacao;
    if (editada) assert.equal(recuperada.id, aberta.id);
    else {
      assert.notEqual(recuperada.id, aberta.id);
      assert.equal(a.importacao.importacoes.get(aberta.id)!.status, 'DESCARTADA');
      assert.equal(a.importacao.importacoes.get(aberta.id)!.extracaoId, atual.extracaoId);
    }
    assert.equal(recuperada.versao, editada ? aberta.versao : 1);
    assert.equal(recuperada.extracao.secoes.some(s => s.campos.some(c => c.valor)), !editada);
  }
});


test('conclusão única: preview sem cliente, mesma transação para CRM e Core, replay não duplica', async () => {
  const a = ambiente();
  let i = await a.abrir();
  for (const c of i.extracao.secoes.flatMap(s => s.campos).filter(c => c.estado === 'PRECISA_REVISAO')) i = dados(await a.importar({ acao: 'revisar', importacaoId: i.id, versao: i.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  let txCliente: unknown, txCore: unknown, concluidas = 0;
  const anterior = a.importacao.porta.executar;
  a.importacao.porta.executar = async (tx, e) => { txCliente = tx; return anterior(tx, e); };
  a.importacao.porta.completa = {
    async opcoes() { return { disponivel: true }; },
    async simular(_tx, _tenant, imp, plano, d) {
      const ref = { cliente: { id: 'cliente', nome: 'Mariana Souza Lima', status: 'ATIVO' }, estabelecimentos: [], pacote: { id: '77777777-7777-4777-8777-777777777777', codigo: 'STANDARD', nome: 'Standard', duracaoMinutos: 240 }, precoReferencia: { tabelaPrecoId: 't', precoPacoteId: 'p', categoria: 'PADRAO' as const }, configuracaoAgendaId: 'g' };
      const v = avaliarIntegracao({ snapshot: plano.snapshot, decisoes: d, referencias: ref, hoje: '2026-09-28' });
      return { integrada: false as const, pronto: true, bloqueios: [], avisos: [], resumo: v.resumo, resumoHash: hashResumo(imp.id, d, v.resumo) };
    },
    async confirmar(tx) { txCore = tx; concluidas++; return { contratoId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', destino: '/admin/contratos?contratoId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }; },
  };
  const integracao = decisoesSchema.parse({ situacaoContrato: 'VIGENTE', estabelecimentoId: null, pacoteReferenciaId: '77777777-7777-4777-8777-777777777777', evento: { data: '2026-11-21', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, valorContratadoCentavos: 890000, financeiro: { situacao: 'NAO_CONFERIDO' }, conferenciaDeclarada: true });
  const sim = await a.importar({ acao: 'simular-completa', importacaoId: i.id, versao: i.versao, integracao });
  assert.equal(sim.status, 200, JSON.stringify(sim.corpo));
  const simulacao = (sim.corpo as { data: { simulacao: { resumoHash: string; planoHash: string } } }).data.simulacao;
  assert.equal(a.importacao.clientesCriados.length, 0);
  const preparado = await a.importar({ acao: 'preparar', importacaoId: i.id, versao: i.versao, integracao, integracaoHash: simulacao.resumoHash, planoHash: simulacao.planoHash });
  assert.equal(preparado.status, 200, JSON.stringify(preparado.corpo));
  const preview = (dados(preparado).gate as { rascunho: RascunhoPublico }).rascunho;
  assert.match(preview.campos.find(c => c.id === 'proximo')!.valor!, /concluídos juntos/);
  assert.equal(a.importacao.clientesCriados.length, 0);
  assert.equal((await a.decidir(preview)).status, 200);
  assert.equal(a.importacao.clientesCriados.length, 1);
  assert.equal(concluidas, 1);
  assert.equal(txCliente, txCore, 'não abre transação separada para Core');
  assert.equal((await a.decidir(preview)).status, 200);
  assert.equal(concluidas, 1);
  assert.equal(a.importacao.clientesCriados.length, 1);
});

test('conclusão única: resumo alterado, falta de declaração e outra empresa não cadastram cliente', async () => {
  const a = ambiente(); let i = await a.abrir();
  for (const c of i.extracao.secoes.flatMap(s => s.campos).filter(c => c.estado === 'PRECISA_REVISAO')) i = dados(await a.importar({ acao: 'revisar', importacaoId: i.id, versao: i.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  const integracao = { situacaoContrato: 'VIGENTE', estabelecimentoId: null, pacoteReferenciaId: null, evento: { data: '2026-11-21', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, valorContratadoCentavos: 890000, financeiro: { situacao: 'NAO_CONFERIDO' }, conferenciaDeclarada: true };
  const pedido = { acao: 'preparar', importacaoId: i.id, versao: i.versao, integracao, integracaoHash: '0'.repeat(64), planoHash: '0'.repeat(64) };
  a.importacao.porta.completa = { async opcoes() { return {}; }, async simular() { throw Error('não deve simular hash de plano diferente'); }, async confirmar() { throw Error('não deve executar'); } };
  const semDeclaracao = await a.deps.acao!.verificar({} as never, { empresaComprovada: empresaA } as never, { importacaoId: i.id, versaoImportacao: i.versao, decisaoCliente: null, integracao: { ...integracao, conferenciaDeclarada: false } } as never, {} as never).then(() => null, e => e);
  assert.equal(semDeclaracao?.code, 'CONFERENCIA_NECESSARIA');
  assert.equal((await a.importar(pedido)).status, 409);
  assert.equal((await a.importar(pedido, empresaB)).status, 404);
  assert.equal(a.importacao.clientesCriados.length, 0);
});

test("064: contrato integrado cancelado libera o documento; o mesmo arquivo abre nova revisão e a antiga vira histórico", async () => {
  const a = ambiente();
  let importacao = await a.abrir();
  for (const c of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = dados(await a.importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: c.id, confirmarDivergencia: true })).importacao;
  }
  const preview = (dados(await a.importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao })).gate as { rascunho: RascunhoPublico }).rascunho;
  assert.equal((await a.decidir(preview)).status, 200);
  const integrada = a.importacao.importacoes.get(importacao.id)!;
  assert.equal(integrada.status, "IMPORTADA");

  // Contrato ativo: reabrir devolve a mesma importação concluída (nada é substituído).
  const mesma = await a.abrir();
  assert.equal(mesma.id, importacao.id);
  assert.equal(mesma.status, "IMPORTADA");

  // Contrato cancelado: reenviar o mesmo arquivo substitui a antiga e abre uma nova revisão limpa.
  a.importacao.contratosCancelados.add(importacao.id);
  const nova = await a.abrir();
  assert.notEqual(nova.id, importacao.id);
  assert.equal(nova.status, "EM_REVISAO");
  assert.equal(nova.versao, 1);
  assert.equal(nova.documentoId, importacao.documentoId);
  assert.deepEqual(nova.revisados, [], "não herda a revisão anterior");
  const antiga = a.importacao.importacoes.get(importacao.id)!;
  assert.equal(antiga.status, "DESCARTADA");
  assert.equal(antiga.versao, integrada.versao + 1);
  assert.equal(antiga.clienteId, null);
  assert.equal(antiga.resultado, null);
  assert.deepEqual((antiga.dados as { substituicao: { clienteId: string | null } }).substituicao.clienteId, integrada.clienteId, "resultado anterior preservado em dados");
  // Depois, a nova é a ativa do documento e a antiga não é reaberta.
  const deNovo = await a.abrir();
  assert.equal(deNovo.id, nova.id);
  type Consulta = { situacao: string; importacao: ImportacaoPublica | null };
  const consulta = (await a.importar({ acao: "consultar", documentoId: importacao.documentoId })).corpo as { data: Consulta };
  assert.equal(consulta.data.importacao?.id, nova.id);
  assert.equal(consulta.data.situacao, "EM_ANDAMENTO");
  assert.equal(a.importacao.clientesCriados.length, 1, "nenhum cliente novo até a nova confirmação");
});
