import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, ctxIntegracao, decisoes, dia, executor, id,
  importacao, integrar, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";
import { escreverSalaoFixture } from "../../scripts/guarda-salao-fixture-test-support.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";

/** Guarda de escritores de salão (camada C): as escritas de salão de fixture desta suíte levam esta marca. */
const ARQUIVO_FIXTURE = "lib/agenda/correlacao-entradas.postgres.test.ts";

/**
 * Plano "liberar agenda com mais de um salão", rev. 7, item P2-2 (expectativa independente). Cada cenário abaixo chama a
 * entrada REAL de produção e compara as escritas de salão observadas pela guarda dinâmica (gatilho de teste → NOTICE →
 * preload `scripts/guarda-salao-preload.cjs` → `globalThis.__kidmaisGuardaSalao.eventos`) com a lista DECLARADA AQUI
 * (escritor:caminho:origem), nunca derivada do código de produção. Escritas de fixture feitas na montagem ficam fora da
 * conta: `i0 = g.eventos.length` é tirado imediatamente antes da chamada da entrada. Sem o preload o cenário reprova.
 *
 * | Entrada | Teste (prefixo "Correlação (rev. 7 P2-2): ")                  | Escritas esperadas (fechamentos / fechamento_revisoes)          |
 * |---------|---------------------------------------------------------------|-----------------------------------------------------------------|
 * | 1       | entrada 1 — emissão (gerarContrato → escolherSalaoParaEmissao) | [] / []                                                         |
 * | 2       | entrada 2 — preparação da proposta inicial                    | [] / []                                                         |
 * | 3       | entrada 3 — aplicarRevisaoInicial                             | [B1:APLICACAO_REVISAO_INICIAL:ACEITE_PUBLICO] / []              |
 * | 4a      | entrada 4a — 1ª assinatura de V3 (pré-assinatura)             | [B1:FORMALIZACAO_PRE_ASSINATURA:ACEITE_PUBLICO] / []            |
 * | 4b, 10  | entrada 4b/10 — concluirPreparacao → aplicarSalaoDaRevisao    | [B3:APLICACAO_REVISAO_OPERACIONAL:ACEITE_PUBLICO] / []          |
 * | 5       | entrada 5 — CRIAR com vigente V3 e festa nula                 | [B1:FORMALIZACAO_POS_ASSINATURA:ACEITE_PUBLICO] / []            |
 * | 5       | entrada 5 — aceite público com vigente sem salão (curinga)    | [] / [] (nem B1 nem B2)                                         |
 * | 6       | entrada 6 — confirmação de pagamento com V3 vigente           | [B1:CONFIRMACAO_PAGAMENTO:PAGAMENTO] / []                       |
 * | 7       | entrada 7 — integração de importado V3                        | [B1:INTEGRACAO_IMPORTADO:IMPORTACAO] / []                       |
 * | 8       | entrada 8 — importação ocupante sem salão em POR_SALAO        | [] / [] (recusa antes de qualquer DML)                          |
 * | 9       | entrada 9 — escolherSalaoDestinoRevisao (editar a revisão)    | [] / [B4:PREPARACAO_REVISAO:EQUIPE]                             |
 * | 11      | entrada 11 — trocarSalaoDaFesta SEM_CONTRATO                  | [B7:ATRIBUICAO_AVULSA:EQUIPE] / []                              |
 * | 12      | entrada 12 — escolherSalaoDaFesta sem chamador de produção    | estática: nenhum arquivo de produção cita o nome                |
 * | 13      | entrada 13 — edição antes da assinatura (data mudada)         | [B6:EDICAO_LIMPA_SALAO:EQUIPE] (valor NULO) / []                |
 * | 14      | entrada 14 — revisão inicial com data mudada                  | [B6:EDICAO_LIMPA_SALAO:ACEITE_PUBLICO, B1:APLICACAO_REVISAO_INICIAL:ACEITE_PUBLICO] / [] |
 * | 15      | entrada 15 — definirSalaoDestinoRevisao (troca com revisão)   | [] / [B5:PREPARACAO_REVISAO:EQUIPE]                             |
 * | 16      | entrada 16 — script RECONCILIAR (processo filho)              | coberta por C''21 em documental-ida-saloes.postgres.test.ts:    |
 * |         |                                                               | [B1:FORMALIZACAO_POS_ASSINATURA:RECONCILIACAO_OPERACIONAL]; aqui  |
 * |         |                                                               | só se confere que a expectativa continua declarada lá           |
 *
 * Notas honestas sobre o mapa:
 * - O "controle da entrada 5" de documental-ida-saloes grava na PRÉ-assinatura: é a entrada 4a. Aqui ele aparece como 4a.
 * - Pela rota pública, a entrada 5 (`contrato-publico.service.ts:615`, CRIAR) nunca chega a gravar num fluxo coerente: a 4a
 *   (ou a 3, na revisão inicial) já gravou o salão exigido antes, e a 5 o encontra igual (UPDATE sem mudança não dispara).
 *   O cenário positivo da 5 chama a mesma função que a `:615` chama (`garantirFestaFormalizada`, modo padrão CRIAR) sobre
 *   uma vigente V3 sem festa e com a festa nula (o legado da C''21, montado sem COMMIT); o outro cenário da 5 prova, pela
 *   rota pública, que ela não escolhe salão quando a vigente não fixa (sem B2).
 * - 4b e 10 são o mesmo ponto (`revisao.repository.ts` → `aplicarSalaoDaRevisao`, só alcançado por `concluirPreparacao`).
 * - 9 e 15 gravam só em fechamento_revisoes; a festa não muda até a aplicação (4b/10).
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "correlacao-p2-2" });
const TURNO = { inicio: "10:00", fim: "22:00" };
const raizRepo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ---------- Expectativa independente (mesmo padrão do "controle da entrada 5" de documental-ida-saloes) ----------
type EventoGuarda = { tipo?: string; tabela?: string; marca?: string; valor?: string; mensagem?: string };
type GuardaSalao = { eventos: EventoGuarda[] };
type Tabela = "fechamentos" | "fechamento_revisoes";
/** Escritas de salão vistas pela guarda dinâmica desde `desde`, na tabela pedida: "escritor:caminho:origem" de cada uma. */
const escritasDesde = (g: GuardaSalao, desde: number, tabela: Tabela = "fechamentos") =>
  g.eventos.slice(desde).filter((e) => e.tipo === "ESCRITA" && e.tabela === tabela).map((e) => String(e.marca).split(":").slice(0, 3).join(":"));
/** Valor gravado (SALAO/NULO) de cada escrita de um escritor desde `desde`. */
const valoresDesde = (g: GuardaSalao, desde: number, escritor: string) =>
  g.eventos.slice(desde).filter((e) => e.tipo === "ESCRITA" && String(e.marca).startsWith(`${escritor}:`)).map((e) => e.valor);
const violacoesDesde = (g: GuardaSalao, desde: number) => g.eventos.slice(desde).filter((e) => e.tipo === "KD901").map((e) => e.mensagem ?? "");
function guarda(): GuardaSalao {
  const g = (globalThis as { __kidmaisGuardaSalao?: GuardaSalao }).__kidmaisGuardaSalao;
  assert.ok(g, "preload ausente: a guarda dinâmica não está instalada e o cenário não pode conferir a origem");
  return g;
}
/** Confere as duas tabelas e a ausência de KD901 contra a expectativa DECLARADA pelo cenário. */
function conferir(g: GuardaSalao, i0: number, entrada: string, esperado: { fechamentos: string[]; revisoes: string[] }) {
  assert.deepEqual(violacoesDesde(g, i0), [], `entrada ${entrada}: nenhuma KD901`);
  assert.deepEqual(escritasDesde(g, i0), esperado.fechamentos, `entrada ${entrada}: escritas em fechamentos`);
  assert.deepEqual(escritasDesde(g, i0, "fechamento_revisoes"), esperado.revisoes, `entrada ${entrada}: escritas em fechamento_revisoes`);
}

// ---------- Fixtures (copiadas de documental-ida-saloes / salao-contrato-se) ----------
async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}
const adm = () => carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
const operar = () => adm().operarContrato as unknown as Operar;
const troca = () => carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");

async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato P2-2", contratada: { nome: "Buffet P2-2 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}
const salao = (c: Cenario, nome: string, ordem: number, capacidade: number | null) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, $4) RETURNING id`, [c.empresa, nome, ordem, capacidade]);

/** A 114 exige a trava da configuração: a fixture a toma como a entrada administrativa (os serviços também tomam). */
const travar = (c: Cenario) => travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });

async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  await travar(c);
  const nativo = await catalogoNativo(a, c);
  await modeloContrato(c);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
  return { c, nativo };
}
/** Ida montada pela fixture: a regra passa a POR_SALAO e a empresa ganha S1 e S2 (sem mexer nas festas). */
async function ida(c: Cenario) {
  await a.query(`UPDATE agenda_escopo_config SET capacidade_tipo = 'POR_SALAO' WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [c.empresa]);
  return { s1: await salao(c, "S1", 1, 50), s2: await salao(c, "S2", 2, 80) };
}

/** Proposta nativa (10:00–22:00) SEM contrato. */
async function novaFesta(c: Cenario, nativo: Nativo, data: string, convidados = 30, forma: string | null = null) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente P2-2', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante P2-2') RETURNING id`, [cliente]);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status, forma_pagamento_pretendida)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $7, $7, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO', $8
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, convidados, forma]);
  return { festa, cpf, cliente };
}
/** Emissão real (gerarContrato) de uma festa já criada; ainda sem nenhuma assinatura. */
async function gerar(c: Cenario, festa: string) {
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  return { contrato: gerado.contrato.id, versao: gerado.versao.id };
}
/** Proposta nativa + contrato emitido + assinado pela Kidmais; ainda sem a assinatura do cliente. */
async function emitida(c: Cenario, nativo: Nativo, data: string, convidados = 30, forma: string | null = null) {
  const f = await novaFesta(c, nativo, data, convidados, forma);
  const g = await gerar(c, f.festa);
  await congelarEAssinarKidmais(a, operar(), g.versao, c.empresa, c.token, nativo.tokenRepresentante);
  return { ...f, ...g };
}
type Emitida = Awaited<ReturnType<typeof emitida>>;

const schemaDe = async (versao: string) => (await a.query<{ n: number; salao: string | null }>(
  `SELECT (snapshot->>'schemaVersao')::int n, snapshot->'evento'->'salao'->>'id' salao FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0]!;
const salaoDaFesta = async (f: string) => (await a.query<{ salao: string | null }>(`SELECT salao_id::text salao FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0]!.salao;
const salaoDaRevisao = async (v: string) => (await a.query<{ salao: string | null }>(`SELECT salao_id::text salao FROM fechamento_revisoes WHERE contrato_versao_id = $1::uuid`, [v])).rows[0]?.salao ?? null;
const edicaoDe = async (v: string) => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v])).rows[0]!.revisao;
const vigenteDe = async (contrato: string) => (await a.query<{ v: string | null }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [contrato])).rows[0]?.v ?? null;
const emPreparacaoDe = async (contrato: string) => (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [contrato])).rows[0]!.id;

async function comCommit<T>(corpo: () => Promise<T>, fim: "COMMIT" | "ROLLBACK" = "COMMIT") {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query(fim);
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

/** Payload de editar_festa (o mesmo da tela) sobre a fonte indicada. */
const payloadEdicao = (c: Cenario, nativo: Nativo, revisao: number, fonte: { fonteHash: string; adicionais: unknown }, data: string, convidados: number, motivo: string) => ({
  acao: "editar_festa", revisao, motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados,
  dataEvento: data, configuracaoAgendaId: nativo.turno, horarioInicio: TURNO.inicio, horarioFim: TURNO.fim, adicionais: fonte.adicionais, idadeAniversarianteEvento: 6, temaFesta: "Circo",
  buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: motivo,
});

/** Entrada 2 (preparação da proposta inicial, antes da 1ª assinatura do cliente): nova versão em preparação editada. */
async function prepararRevisaoInicial(c: Cenario, nativo: Nativo, e: Emitida, data: string, convidados: number) {
  const op = operar();
  const nova = await op(e.versao, { acao: "substituir_preparacao", motivo: "Mais convidados", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa) as { versaoId: string };
  const v2 = nova.versaoId;
  const fonte = await adm().fontesEdicao(e.festa, executor(a));
  await op(v2, payloadEdicao(c, nativo, await edicaoDe(v2), fonte, data, convidados, "Revisão inicial P2-2"), c.token, ctxOp(), c.empresa);
  return v2;
}

/** Contrato V3 assinado pelas duas partes (festa no salão do documento) e uma revisão operacional aberta (nova_versao). */
async function revisaoOperacionalAberta(c: Cenario, nativo: Nativo, data: string, convidados = 30) {
  const e = await emitida(c, nativo, data, convidados);
  await assinarComoCliente(e.contrato, e.cpf);
  await validarAgora(a);
  await travar(c);
  await operar()(e.versao, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "P2-2", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  return { e, v2: await emPreparacaoDe(e.contrato) };
}
/** Entrada 9: editar a festa da revisão operacional (revalida o destino → escolherSalaoDestinoRevisao). */
async function editarRevisaoOperacional(c: Cenario, nativo: Nativo, v2: string, data: string, convidados: number) {
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
  await operar()(v2, payloadEdicao(c, nativo, await edicaoDe(v2), fonte, data, convidados, "Revisão operacional P2-2"), c.token, ctxOp(), c.empresa);
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

// ---------------------------------------------------------------------------------------------------------------------

test("Correlação (rev. 7 P2-2): entrada 1 — emissão em POR_SALAO (gerarContrato → escolherSalaoParaEmissao) fixa a V3 e não grava salão", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 80);
    const f = await novaFesta(c, nativo, dia(180));
    await travar(c);
    const i0 = g.eventos.length;
    const r = await gerar(c, f.festa);
    conferir(g, i0, "1", { fechamentos: [], revisoes: [] });
    assert.deepEqual(await schemaDe(r.versao), { n: 3, salao: s1 }, "a emissão fixa o salão só no documento");
    assert.equal(await salaoDaFesta(f.festa), null, "emitir não grava a festa");
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 2 — preparação da proposta inicial (V3 com salão do destino) é só leitura", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 35), s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, dia(181));
    assert.equal((await schemaDe(e.versao)).salao, s1);
    const i0 = g.eventos.length;
    const v2 = await prepararRevisaoInicial(c, nativo, e, dia(181), 45);
    conferir(g, i0, "2", { fechamentos: [], revisoes: [] });
    assert.deepEqual(await schemaDe(v2), { n: 3, salao: s2 }, "S1 (35) não comporta 45: a proposta fixa S2 só no documento");
    assert.equal(await salaoDaFesta(e.festa), null);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 3 — aceite da proposta inicial V3 → aplicarRevisaoInicial grava B1 com APLICACAO_REVISAO_INICIAL", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    await salao(c, "S1", 1, 35);
    const s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, dia(182));
    const v2 = await prepararRevisaoInicial(c, nativo, e, dia(182), 45);
    await congelarEAssinarKidmais(a, operar(), v2, c.empresa, c.token, nativo.tokenRepresentante);
    const i0 = g.eventos.length;
    await assinarComoCliente(e.contrato, e.cpf);
    // Mesma data: a edição (B6) não muda o salão (nulo → nulo, não dispara); a pré-assinatura da revisão inicial só trava;
    // o CRIAR (entrada 5) encontra a festa já em S2 e não escreve de novo.
    conferir(g, i0, "3", { fechamentos: ["B1:APLICACAO_REVISAO_INICIAL:ACEITE_PUBLICO"], revisoes: [] });
    await validarAgora(a);
    assert.equal(await vigenteDe(e.contrato), v2);
    assert.equal(await salaoDaFesta(e.festa), s2);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 4a — 1ª assinatura de V3 pelo aceite público grava na PRÉ-assinatura (ACEITE_PUBLICO)", { timeout: 300_000 }, async () => {
  // É o mesmo caso do "controle da entrada 5" de documental-ida-saloes: lá o rótulo é 5, mas a escrita é a da 4a.
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, dia(183));
    assert.equal((await schemaDe(e.versao)).salao, s1);
    const i0 = g.eventos.length;
    await assinarComoCliente(e.contrato, e.cpf);
    // Uma única escrita: a 4a (contrato-publico :565 → formalizacao.ts). O CRIAR da :615 (entrada 5) não escreve de novo.
    conferir(g, i0, "4a", { fechamentos: ["B1:FORMALIZACAO_PRE_ASSINATURA:ACEITE_PUBLICO"], revisoes: [] });
    await validarAgora(a);
    assert.equal(await salaoDaFesta(e.festa), s1);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 4b/10 — aceite da revisão operacional → concluirPreparacao → aplicarSalaoDaRevisao (B3)", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 80);
    const D = dia(184);
    const { e, v2 } = await revisaoOperacionalAberta(c, nativo, D);
    assert.equal(await salaoDaFesta(e.festa), s1);
    await editarRevisaoOperacional(c, nativo, v2, D, 60);
    assert.equal(await salaoDaRevisao(v2), s2, "S1 (50) não comporta 60: destino S2");
    await congelarEAssinarKidmais(a, operar(), v2, c.empresa, c.token, nativo.tokenRepresentante);
    const i0 = g.eventos.length;
    await assinarComoCliente(e.contrato, e.cpf);
    // 4a com a base (S1, capacidade:false): a festa já está em S1, nada a gravar. 4b/10: B3 copia o destino.
    // A revisão está CONGELADA: a revalidação do destino não grava (B4 não aparece). A festa já existe: CRIAR reaproveita.
    conferir(g, i0, "4b/10", { fechamentos: ["B3:APLICACAO_REVISAO_OPERACIONAL:ACEITE_PUBLICO"], revisoes: [] });
    await validarAgora(a);
    assert.equal(await salaoDaFesta(e.festa), s2);
  }, "ROLLBACK");
});

/** Contrato legado: V emitida e assinada pelo cliente SEM a pré-assinatura da agenda e sem criar a festa (como C''21). */
async function legadoSemFesta(c: Cenario, nativo: Nativo, data: string) {
  const e = await emitida(c, nativo, data);
  type Formalizacao = typeof import("../festas/formalizacao.ts");
  const formalizacao = carregar<Formalizacao>("lib/festas/formalizacao.ts") as Pick<Formalizacao, "garantirFestaFormalizada" | "bloquearAgendaFormalizacao">;
  const garantir = formalizacao.garantirFestaFormalizada;
  const bloquear = formalizacao.bloquearAgendaFormalizacao;
  formalizacao.garantirFestaFormalizada = (async () => ({ festaId: "", reutilizado: false })) as typeof garantir;
  formalizacao.bloquearAgendaFormalizacao = (async () => undefined) as typeof bloquear;
  try {
    await assinarComoCliente(e.contrato, e.cpf);
  } finally {
    formalizacao.garantirFestaFormalizada = garantir;
    formalizacao.bloquearAgendaFormalizacao = bloquear;
  }
  return e;
}

test("Correlação (rev. 7 P2-2): entrada 5 — CRIAR (garantirFestaFormalizada, como a :615) com vigente V3 e festa nula grava B1 POS_ASSINATURA/ACEITE_PUBLICO", { timeout: 300_000 }, async () => {
  const g = guarda();
  // Termina em ROLLBACK: o legado sem festa (montado como na C''21) seria recusado pelos gatilhos diferidos da 019 no COMMIT.
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    await ida(c);
    const e = await legadoSemFesta(c, nativo, dia(185));
    const salaoV3 = (await schemaDe(e.versao)).salao;
    assert.ok(salaoV3, "emitida depois da ida: V3 com salão");
    assert.equal(await vigenteDe(e.contrato), e.versao, "legado: vigente com dupla prova");
    assert.equal(await salaoDaFesta(e.festa), null, "legado: festa nula");
    const { garantirFestaFormalizada } = carregar<typeof import("../festas/formalizacao.ts")>("lib/festas/formalizacao.ts");
    await travar(c);
    const i0 = g.eventos.length;
    // Sem o argumento `modo`: exatamente a chamada de contrato-publico.service.ts:615 (CRIAR → origem ACEITE_PUBLICO).
    const r = await garantirFestaFormalizada(executor(a), e.contrato, e.versao, { requestId: randomUUID() });
    conferir(g, i0, "5", { fechamentos: ["B1:FORMALIZACAO_POS_ASSINATURA:ACEITE_PUBLICO"], revisoes: [] });
    assert.equal(r.reutilizado, false);
    assert.equal(await salaoDaFesta(e.festa), salaoV3);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 5 — aceite público com vigente sem salão (V1 emitida antes da ida) não escolhe salão (sem B1 nem B2)", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, dia(186));
    assert.notEqual((await schemaDe(e.versao)).n, 3, "emitida em POR_HORARIO: sem V3");
    await ida(c);
    const i0 = g.eventos.length;
    await assinarComoCliente(e.contrato, e.cpf);
    // 4a e 5 correm (pré e pós-assinatura) com documento sem salão: curinga, nenhuma escrita.
    conferir(g, i0, "5 (curinga)", { fechamentos: [], revisoes: [] });
    await validarAgora(a);
    assert.equal(await salaoDaFesta(e.festa), null);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 6 — confirmação de pagamento com V3 vigente e festa nula grava B1 CONFIRMACAO_PAGAMENTO/PAGAMENTO", { timeout: 300_000 }, async () => {
  const g = guarda();
  // Termina em ROLLBACK: a festa formalizada sem salão é um estado montado pela fixture só para alcançar a escrita da 6.
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 50);
    const e = await emitida(c, nativo, dia(187), 30, "PIX_AVISTA");
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal(await salaoDaFesta(e.festa), s1);
    await escreverSalaoFixture(a, ARQUIVO_FIXTURE, `UPDATE fechamentos SET salao_id = NULL WHERE id = $1::uuid`, [e.festa]);
    const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
    const tx = executor(a);
    const total = Number((await a.query<{ t: string }>(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' t FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1`, [e.contrato])).rows[0]!.t);
    const contexto = { token: c.token, usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "correlacao-p2-2", executor: tx };
    await travar(c);
    const i0 = g.eventos.length;
    const criado = await pag.criarPagamentoDoFechamento({ fechamentoId: e.festa, plano: { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: total, vencimento: dia(1), confirmaReserva: true }] } } as never, contexto as never) as { detalhe: { pagamento: { id: string } } };
    const pagamento = criado.detalhe.pagamento.id;
    const parcela = (await a.query<{ id: string }>(`SELECT pp.id FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1`, [pagamento])).rows[0]!.id;
    await pag.registrarRecebimentoPagamento({ pagamentoId: pagamento, meioPagamento: "PIX", valorBruto: total, confirmarAgora: true, chaveIdempotencia: randomUUID(),
      alocacoes: [{ parcelaId: parcela, valor: total }] } as never, contexto as never);
    conferir(g, i0, "6", { fechamentos: ["B1:CONFIRMACAO_PAGAMENTO:PAGAMENTO"], revisoes: [] });
    const reserva = (await a.query<{ r: string }>(`SELECT reserva_status r FROM pagamentos WHERE id = $1`, [pagamento])).rows[0]!.r;
    assert.equal(reserva, "CONFIRMADA");
    assert.equal(await salaoDaFesta(e.festa), s1, "o salão exigido pela vigente, sem substituto");
  }, "ROLLBACK");
});

const servico = () => carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
const coreImportado = () => carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts").coreNativo;
async function empresaImportacao(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  await travar(c);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
  return c;
}

test("Correlação (rev. 7 P2-2): entrada 7 — integração de importado V3 (futuro, POR_SALAO, salão escolhido) grava B1 INTEGRACAO_IMPORTADO/IMPORTACAO", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const c = await empresaImportacao("POR_SALAO");
    const A = await salao(c, "Salão A", 1, null);
    const ev = { data: dia(188), inicio: "14:00", fim: "18:00" };
    const imp = await importacao(a, c, ev);
    const d = decisoes(c, ev, PARCIAL(), null, undefined, A);
    const i0 = g.eventos.length;
    const r = await integrar(servico(), coreImportado(), a, c, imp.id, d);
    conferir(g, i0, "7", { fechamentos: ["B1:INTEGRACAO_IMPORTADO:IMPORTACAO"], revisoes: [] });
    await validarAgora(a);
    const f = (await a.query<{ salao: string | null }>(`SELECT f.salao_id::text salao FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1::uuid`, [r.contratoId])).rows[0]!;
    assert.equal(f.salao, A);
  }, "ROLLBACK");
});

/** Executor que registra cada comando (a sequência prova "recusa antes do primeiro DML"). */
function registrando(): { tx: DbExecutor; comandos: string[] } {
  const comandos: string[] = [];
  const base = executor(a);
  return { comandos, tx: { query: (sql: string, v?: readonly unknown[]) => { comandos.push(sql.replace(/\s+/g, " ").trim()); return base.query(sql, v as unknown[]); } } as DbExecutor };
}
const DML = /^(WITH\b[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|MERGE)\b/i;

test("Correlação (rev. 7 P2-2): entrada 8 — importação ocupante sem salão em POR_SALAO é recusada sem nenhuma escrita de salão", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    // Como a C''14: simulação pronta em POR_HORARIO, a ida acontece antes da confirmação.
    const c = await empresaImportacao("POR_HORARIO");
    const ev = { data: dia(189), inicio: "14:00", fim: "18:00" };
    const imp = await importacao(a, c, ev);
    const d = decisoes(c, ev, PARCIAL());
    const s = servico();
    const sim = await s.simularIntegracao(executor(a), c.tenant as never, imp.id, d, dia(0));
    assert.ok(!sim.integrada && sim.pronto, `em POR_HORARIO a simulação fica pronta: ${JSON.stringify(sim)}`);
    await ida(c);
    const { tx, comandos } = registrando();
    const i0 = g.eventos.length;
    let erro: unknown;
    try {
      await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp.id, { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), coreImportado());
    } catch (e) { erro = e; }
    assert.ok(erro, "a confirmação precisa ser recusada");
    conferir(g, i0, "8", { fechamentos: [], revisoes: [] });
    assert.deepEqual(comandos.filter((q) => DML.test(q)), [], "nenhum INSERT/UPDATE/DELETE antes da recusa");
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 9 — editar a revisão operacional revalida o destino (escolherSalaoDestinoRevisao) e grava só B4 na revisão", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 80);
    const D = dia(190);
    const { e, v2 } = await revisaoOperacionalAberta(c, nativo, D);
    const i0 = g.eventos.length;
    await editarRevisaoOperacional(c, nativo, v2, D, 60);
    conferir(g, i0, "9", { fechamentos: [], revisoes: ["B4:PREPARACAO_REVISAO:EQUIPE"] });
    assert.equal(await salaoDaRevisao(v2), s2, "S1 (50) não comporta 60: destino S2");
    assert.equal(await salaoDaFesta(e.festa), s1, "a festa continua no salão vigente até a aplicação");
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 11 — trocarSalaoDaFesta numa festa SEM_CONTRATO grava B7 ATRIBUICAO_AVULSA/EQUIPE", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    await salao(c, "S1", 1, 50);
    const s2 = await salao(c, "S2", 2, 80);
    const f = await novaFesta(c, nativo, dia(191));
    await travar(c);
    const i0 = g.eventos.length;
    await troca().trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, f.festa, s2);
    conferir(g, i0, "11", { fechamentos: ["B7:ATRIBUICAO_AVULSA:EQUIPE"], revisoes: [] });
    assert.equal(await salaoDaFesta(f.festa), s2);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 11 — com contrato que não fixa salão a troca avulsa é recusada sem escrita", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, dia(192));
    const { s1 } = await ida(c);
    await travar(c);
    const i0 = g.eventos.length;
    await recusa(troca().trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, e.festa, s1), /contrato sem salão definido/);
    conferir(g, i0, "11 (recusa)", { fechamentos: [], revisoes: [] });
  }, "ROLLBACK");
});

/** Arquivos de produção (lib/, app/, scripts/ fora de teste e de apoio de teste). */
function arquivosDeProducao(): string[] {
  const teste = /(\.test\.(ts|tsx|cjs|mjs|js)|test-support\.ts|test-apoio\.(ts|cjs)|-ui\.cjs)$/;
  const fonte = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
  const lista: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      if (nome === "node_modules" || nome.startsWith(".")) continue;
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (fonte.test(nome) && !teste.test(nome)) lista.push(caminho);
    }
  };
  for (const raiz of ["lib", "app", "scripts"]) andar(join(raizRepo, raiz));
  return lista;
}

test("Correlação (rev. 7 P2-2): entrada 12 — escolherSalaoDaFesta não tem chamador (nem definição) em código de produção", () => {
  // Estática: a entrada 12 não tem chamador de produção, então não há escrita a observar. O nome só pode aparecer em teste.
  const citam = arquivosDeProducao()
    .filter((f) => /\bescolherSalaoDaFesta\b/.test(readFileSync(f, "utf8")))
    .map((f) => relative(raizRepo, f).replace(/\\/g, "/"));
  assert.deepEqual(citam, [], "escolherSalaoDaFesta citado em produção");
  assert.ok(arquivosDeProducao().some((f) => relative(raizRepo, f).replace(/\\/g, "/") === "lib/agenda/salao-festa.ts"), "varredura alcança salao-festa.ts");
});

test("Correlação (rev. 7 P2-2): entrada 13 — edição antes da assinatura com data mudada solta o salão (B6 EDICAO_LIMPA_SALAO/EQUIPE, NULO)", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    await salao(c, "S1", 1, 50);
    const s2 = await salao(c, "S2", 2, 80);
    const D = dia(193), D2 = dia(194);
    const f = await novaFesta(c, nativo, D);
    await travar(c);
    // Estado alcançável em produção: a equipe escolheu o salão da festa ainda sem contrato (entrada 11, B7), depois emitiu.
    await troca().trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, f.festa, s2);
    const k = await gerar(c, f.festa);
    assert.equal(await salaoDaFesta(f.festa), s2);
    const fonte = await adm().fontesEdicao(f.festa, executor(a));
    const i0 = g.eventos.length;
    await operar()(k.versao, payloadEdicao(c, nativo, await edicaoDe(k.versao), fonte, D2, 30, "Edição P2-2"), c.token, ctxOp(), c.empresa);
    conferir(g, i0, "13", { fechamentos: ["B6:EDICAO_LIMPA_SALAO:EQUIPE"], revisoes: [] });
    assert.deepEqual(valoresDesde(g, i0, "B6"), ["NULO"], "B6 só limpa");
    assert.equal(await salaoDaFesta(f.festa), null);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 14 — aceite da revisão inicial com data mudada: B6 (ACEITE_PUBLICO, NULO) e depois B1 APLICACAO_REVISAO_INICIAL", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 80);
    const D = dia(195), D2 = dia(196);
    const f = await novaFesta(c, nativo, D);
    await travar(c);
    // Festa com salão antes do contrato (entrada 11, B7) → emissão V3 com esse salão.
    await troca().trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, f.festa, s1);
    const k = await gerar(c, f.festa);
    await congelarEAssinarKidmais(a, operar(), k.versao, c.empresa, c.token, nativo.tokenRepresentante);
    const e: Emitida = { ...f, ...k };
    const v2 = await prepararRevisaoInicial(c, nativo, e, D2, 30);
    const salaoProposta = (await schemaDe(v2)).salao;
    assert.ok(salaoProposta, "proposta V3 com salão");
    await congelarEAssinarKidmais(a, operar(), v2, c.empresa, c.token, nativo.tokenRepresentante);
    assert.equal(await salaoDaFesta(f.festa), s1);
    const i0 = g.eventos.length;
    await assinarComoCliente(e.contrato, e.cpf);
    conferir(g, i0, "14", { fechamentos: ["B6:EDICAO_LIMPA_SALAO:ACEITE_PUBLICO", "B1:APLICACAO_REVISAO_INICIAL:ACEITE_PUBLICO"], revisoes: [] });
    assert.deepEqual(valoresDesde(g, i0, "B6"), ["NULO"], "B6 só limpa");
    await validarAgora(a);
    assert.equal(await salaoDaFesta(f.festa), salaoProposta);
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 15 — troca com contrato que fixa salão e revisão aberta (definirSalaoDestinoRevisao) grava só B5 na revisão", { timeout: 300_000 }, async () => {
  const g = guarda();
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 50);
    const { e, v2 } = await revisaoOperacionalAberta(c, nativo, dia(197));
    assert.equal(await salaoDaFesta(e.festa), s1);
    assert.notEqual(await salaoDaRevisao(v2), s2, "o destino ainda não é S2");
    await travar(c);
    const i0 = g.eventos.length;
    await troca().trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, e.festa, s2);
    conferir(g, i0, "15", { fechamentos: [], revisoes: ["B5:PREPARACAO_REVISAO:EQUIPE"] });
    assert.equal(await salaoDaRevisao(v2), s2);
    assert.equal(await salaoDaFesta(e.festa), s1, "a festa continua no salão do contrato vigente");
  }, "ROLLBACK");
});

test("Correlação (rev. 7 P2-2): entrada 16 — a expectativa da reconciliação continua declarada no cenário C''21 (processo filho)", () => {
  // A entrada 16 roda em processo filho contra kidmais_019_<n> (documental-ida-saloes, C''20–C''22). Não se duplica aqui;
  // só se confere que o cenário positivo mantém a expectativa declarada (origem RECONCILIACAO_OPERACIONAL).
  const fonte = readFileSync(join(raizRepo, "lib/agenda/documental-ida-saloes.postgres.test.ts"), "utf8");
  assert.ok(fonte.includes(`test("C''21:`), "cenário C''21 presente");
  assert.ok(fonte.includes(`assert.deepEqual(ok.escritas, ["B1:FORMALIZACAO_POS_ASSINATURA:RECONCILIACAO_OPERACIONAL"]);`), "expectativa da entrada 16 declarada na C''21");
});
