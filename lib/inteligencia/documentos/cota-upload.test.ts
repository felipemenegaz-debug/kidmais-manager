import assert from "node:assert/strict";
import test from "node:test";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { cotaImportacaoDispensada, SERVICOS_DISPENSA_COTA_IMPORTACAO } from "../flags.ts";
import { LINHAS, bancoTenant, documentosMemoria, empresaA, pdf, sequencia, usuario, type OpcoesCota } from "./apoio.test.ts";
import { lerPdfEmProcesso, type LeitorPdf } from "./extrair.ts";
import { atenderDocumento, type DependenciasDocumento, type DocumentoPublico } from "./upload.ts";

/**
 * L2 no fluxo real do envio (atenderDocumento), com a cota em memória da apoio (semântica de posse e identidade da 118;
 * prazo, período, janela e concorrência estão no PostgreSQL descartável). Vale para o envio único e para o lote, que usa
 * a mesma rota.
 *   - R2-2: sem controle de cota, sem leitura (matriz grupo × tabelas × dispensa), antes de gravar o documento;
 *   - reserva antes de ler; conclusão com/sem dados na transação da extração; falha libera; posse perdida não grava;
 *   - cota esgotada e leitura em andamento recusam antes de ler; reenvio com dados não reserva;
 *   - rollback pelo grupo com reserva em voo: a leitura em voo termina pelas regras de posse; o envio novo é recusado.
 */
const STAGING = "srv-daif418ae00c73e8k2gg";
const DISPENSA = { RENDER: "true", RENDER_SERVICE_ID: STAGING, IMPORTACAO_COTA_DISPENSADA: STAGING };

function ambiente(opcoes: { env?: Record<string, string>; cota?: OpcoesCota; semPortaCota?: boolean } = {}) {
  const documentos = documentosMemoria(sequencia(), opcoes.cota);
  if (opcoes.semPortaCota) delete (documentos.porta as { cota?: unknown }).cota;
  const leituras = { n: 0 };
  const env: Record<string, string> = { INTELIGENCIA_ENABLED: "true", AI_CONTRACT_IMPORT_ENABLED: "true", ...opcoes.env };
  const sessao = { usuario_id: usuario, papel: "ADMINISTRATIVO" } as SessaoParaTenant;
  const tx = bancoTenant(() => sessao.papel);
  let seq = 0;
  const contar: LeitorPdf = async (bytes, o) => { leituras.n += 1; return lerPdfEmProcesso(bytes, o); };
  const deps: DependenciasDocumento = {
    env,
    autenticar: async () => sessao,
    withTenantTransaction: (s, empresa, work) => executarNoTenant(tx, s, empresa, work),
    agora: () => new Date("2026-11-04T15:00:00Z"),
    requestId: () => `req-${++seq}`,
    registrar: () => {},
    relogio: () => 0,
    documentos: documentos.porta,
    roteador: null,
    lerPdf: contar,
  };
  const enviar = (bytes: Uint8Array) => atenderDocumento({ empresaSolicitada: empresaA, lerArquivo: async () => ({ nome: "contrato.pdf", tipo: "application/pdf", bytes }) }, deps);
  return { deps, env, documentos, leituras, enviar };
}
const codigo = (r: { status: number; corpo: unknown }) => [r.status, (r.corpo as { codigo?: string }).codigo ?? "OK"];
const dados = (r: { corpo: unknown }) => (r.corpo as { data: DocumentoPublico }).data;
const CONTRATO = () => pdf(LINHAS);
const SEM_DADOS = () => pdf([["Documento sem nenhum campo de contrato."]]);
const OUTRO = (n: number) => pdf([[...LINHAS[0], `Observação ${n}`], ...LINHAS.slice(1)]);

test("dispensa só no web de staging da lista, com valor igual ao RENDER_SERVICE_ID e RENDER=true; NODE_ENV não conta", () => {
  assert.deepEqual(SERVICOS_DISPENSA_COTA_IMPORTACAO, [STAGING]);
  assert.equal(cotaImportacaoDispensada(DISPENSA), true);
  assert.equal(cotaImportacaoDispensada({ ...DISPENSA, RENDER_SERVICE_ID: "srv-outro", IMPORTACAO_COTA_DISPENSADA: "srv-outro" }), false, "copiada para outro serviço");
  assert.equal(cotaImportacaoDispensada({ ...DISPENSA, IMPORTACAO_COTA_DISPENSADA: "srv-dak77m2d0e5s73b8rkkg" }), false, "valor de outro serviço");
  assert.equal(cotaImportacaoDispensada({ ...DISPENSA, IMPORTACAO_COTA_DISPENSADA: "true" }), false);
  assert.equal(cotaImportacaoDispensada({ ...DISPENSA, RENDER: undefined }), false, "fora do Render");
  assert.equal(cotaImportacaoDispensada({ RENDER_SERVICE_ID: STAGING, IMPORTACAO_COTA_DISPENSADA: STAGING, NODE_ENV: "development" }), false);
  assert.equal(cotaImportacaoDispensada({ RENDER: "true", RENDER_SERVICE_ID: STAGING }), false, "sem a variável");
  assert.equal(cotaImportacaoDispensada({ RENDER: "true", RENDER_SERVICE_ID: "", IMPORTACAO_COTA_DISPENSADA: "" }), false);
});

test("R2-2 matriz: sem tabelas (ou sem porta) e sem dispensa válida ⇒ COTA_INDISPONIVEL 503 antes de gravar o documento e de ler", async () => {
  for (const [nome, opcoes] of [
    ["tabelas ausentes", { cota: { instalada: false } }],
    ["porta ausente", { semPortaCota: true }],
    ["dispensa copiada para outro serviço", { cota: { instalada: false }, env: { RENDER: "true", RENDER_SERVICE_ID: "srv-outro", IMPORTACAO_COTA_DISPENSADA: "srv-outro" } }],
    ["dispensa fora do Render", { cota: { instalada: false }, env: { RENDER_SERVICE_ID: STAGING, IMPORTACAO_COTA_DISPENSADA: STAGING } }],
  ] as const) {
    const a = ambiente(opcoes as Parameters<typeof ambiente>[0]);
    assert.deepEqual(codigo(await a.enviar(CONTRATO())), [503, "COTA_INDISPONIVEL"], nome);
    assert.equal(a.documentos.documentos.size, 0, `${nome}: nenhum documento gravado`);
    assert.equal(a.leituras.n, 0, `${nome}: nada lido`);
    assert.deepEqual(a.documentos.cota.eventos, [], nome);
  }
});

test("R2-2 matriz: grupo desligado ⇒ recusa antes de tudo; dispensa válida sem tabelas lê sem reservar; com tabelas a cota vale mesmo com a dispensa", async () => {
  for (const env of [{ AI_CONTRACT_IMPORT_ENABLED: "false" }, { INTELIGENCIA_ENABLED: "false" }, { AI_TENANT_ALLOWLIST: "22222222-2222-4222-8222-222222222222" }] as Record<string, string>[]) {
    const a = ambiente({ env });
    assert.deepEqual(codigo(await a.enviar(CONTRATO())), [503, "INTELIGENCIA_DESATIVADA"]);
    assert.equal(a.leituras.n, 0);
    assert.deepEqual(a.documentos.cota.eventos, []);
  }
  const dispensada = ambiente({ cota: { instalada: false }, env: DISPENSA });
  const r = await dispensada.enviar(CONTRATO());
  assert.deepEqual(codigo(r), [200, "OK"]);
  assert.deepEqual(dispensada.documentos.cota.eventos, []);
  const comTabelas = ambiente({ env: DISPENSA, cota: { limite: 1 } });
  assert.deepEqual(codigo(await comTabelas.enviar(CONTRATO())), [200, "OK"]);
  assert.deepEqual(codigo(await comTabelas.enviar(OUTRO(2))), [409, "COTA_IMPORTACAO_ESGOTADA"]);
});

test("leitura com dados: reserva antes de ler, consome na transação da extração; reenvio não reserva", async () => {
  const a = ambiente({ cota: { limite: 10 } });
  const r = await a.enviar(CONTRATO());
  assert.deepEqual(codigo(r), [200, "OK"]);
  assert.deepEqual(a.documentos.cota.eventos, ["reservar", "concluir:com-dados"]);
  assert.deepEqual(a.documentos.cota.usos.map((u) => u.estado), ["CONSUMIDA"]);
  assert.equal("cota" in dados(r), false, "a situação da cota vem da abertura da revisão, depois da conclusão");
  const reenvio = await a.enviar(CONTRATO());
  assert.deepEqual(dados(reenvio).avisos, ["DOCUMENTO_JA_ENVIADO"]);
  assert.deepEqual(a.documentos.cota.eventos, ["reservar", "concluir:com-dados"], "reenvio com extração útil não reserva");
  assert.equal(a.leituras.n, 1);
});

test("leitura sem dados libera a reserva (não conta) e grava a extração; reenviar o mesmo arquivo lê e reserva de novo", async () => {
  const a = ambiente({ cota: { limite: 1 } });
  assert.deepEqual(codigo(await a.enviar(SEM_DADOS())), [200, "OK"]);
  assert.deepEqual(a.documentos.cota.eventos, ["reservar", "concluir:sem-dados"]);
  assert.deepEqual(a.documentos.cota.usos.map((u) => u.estado), ["LIBERADA"]);
  assert.equal(a.documentos.extracoes.length, 1);
  assert.deepEqual(codigo(await a.enviar(SEM_DADOS())), [200, "OK"]);
  assert.equal(a.documentos.cota.usos.length, 2);
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [200, "OK"], "as vazias não ocuparam o limite de 1");
});

test("falha entre reservar e concluir (Worker, erro inesperado) libera só a própria reserva; nada é gravado", async () => {
  const a = ambiente({ cota: { limite: 1 } });
  a.deps.lerPdf = async () => ({ paginas: [], avisos: ["WORKER_FALHOU"], interrompido: null });
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [503, "LEITURA_PDF_INDISPONIVEL"]);
  assert.deepEqual(a.documentos.cota.eventos, ["reservar", "liberar"]);
  assert.deepEqual(a.documentos.cota.usos.map((u) => u.estado), ["LIBERADA"]);
  a.deps.lerPdf = async () => { throw new Error("leitor caiu"); };
  assert.equal((await a.enviar(CONTRATO())).status, 503);
  assert.deepEqual(a.documentos.cota.usos.map((u) => u.estado), ["LIBERADA", "LIBERADA"]);
  assert.equal(a.documentos.extracoes.length, 0);
  a.deps.lerPdf = undefined;
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [200, "OK"], "as falhas não ocuparam o limite de 1");
});

test("posse perdida na conclusão ⇒ LEITURA_EXPIRADA 409 e a extração não é gravada", async () => {
  const a = ambiente({ cota: { expirarNaConclusao: true } });
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [409, "LEITURA_EXPIRADA"]);
  assert.equal(a.documentos.extracoes.length, 0);
  assert.deepEqual(a.documentos.cota.eventos, ["reservar", "concluir:com-dados", "liberar"]);
});

test("cota esgotada ⇒ COTA_IMPORTACAO_ESGOTADA 409 antes de ler, com a mensagem da cota", async () => {
  const a = ambiente({ cota: { limite: 1 } });
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [200, "OK"]);
  const r = await a.enviar(OUTRO(2));
  assert.deepEqual(codigo(r), [409, "COTA_IMPORTACAO_ESGOTADA"]);
  assert.match((r.corpo as { erro: string }).erro, /Nenhum arquivo foi lido/);
  assert.equal(a.leituras.n, 1, "o segundo arquivo não foi lido");
});

test("mesmo arquivo em dois envios simultâneos: o segundo recebe LEITURA_EM_ANDAMENTO sem ler; rollback pelo grupo não interrompe a leitura em voo e recusa o envio novo", async () => {
  const a = ambiente();
  let soltar!: () => void;
  const portao = new Promise<void>((r) => { soltar = r; });
  a.deps.lerPdf = async (bytes, o) => { await portao; return lerPdfEmProcesso(bytes, o); };
  const primeiro = a.enviar(CONTRATO());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(codigo(await a.enviar(CONTRATO())), [409, "LEITURA_EM_ANDAMENTO"]);
  a.env.AI_CONTRACT_IMPORT_ENABLED = "false";
  assert.deepEqual(codigo(await a.enviar(OUTRO(3))), [503, "INTELIGENCIA_DESATIVADA"]);
  soltar();
  assert.deepEqual(codigo(await primeiro), [200, "OK"]);
  assert.deepEqual(a.documentos.cota.usos.map((u) => u.estado), ["CONSUMIDA"]);
});
