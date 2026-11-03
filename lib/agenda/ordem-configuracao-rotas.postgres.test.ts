import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, catalogoNoTurno, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id,
  poolNaTransacao, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { carregarComBanco, porSavepoint, porTransacao } from "../marketing/harness-postgres.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";
import * as pacotesAdmin from "../comercial/pacotes-admin.ts";
import * as pacotePrecos from "../comercial/pacote-precos.ts";
import * as pacoteComercial from "../comercial/pacote-comercial.ts";
import * as configuracaoUnidade from "./configuracao-unidade.ts";
import * as travaConfiguracao from "./trava-configuracao.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";
import type { EmTransacao } from "../comercial/adicionais-admin.ts";
import type { LeituraTabela } from "../comercial/importacao-tabela/esquema.ts";
import { gravarLeitura, publicarImportacao, registrarImportacao, salvarRevisao } from "../comercial/importacao-tabela/servico.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 7, bateria D'', rodada 2 — achado do Astra), no PostgreSQL DESCARTÁVEL
 * (modelo 114): as entradas REAIS de produção que ganharam a trava da configuração na rev. 3 (rotas administrativas, porta
 * da IA, rota pública de fechamento, serviços de fechamento, publicação da tabela importada, cancelamento da festa e o
 * bloqueio do pagamento) são chamadas como em produção e o SQL que ELAS emitem é gravado na conexão. Regra (a mesma de
 * ordem-configuracao-entradas): a primeira trava da configuração (CONFIG) vem antes do primeiro comando AGENDA/LINHA, com a
 * classificação da guarda dinâmica (`classificarComando`).
 *
 * Sem trava herdada (diferença para a rodada 1): o estado é preparado e COMITADO antes (a fixture toma a configuração na
 * própria transação, que termina no COMMIT), e cada entrada roda numa transação NOVA em que, antes dela, só acontece o que
 * a rota/o tenant real faz (`SELECT … FROM empresas … FOR UPDATE`, ou nada quando a própria entrada prova o tenant). Antes
 * de chamar a entrada, pg_locks confirma que a chave `kidmais:agenda-config:<empresa>` NÃO está com este backend.
 * Fluxos com várias transações próprias (rota pública de fechamento, publicação da importação) rodam com BEGIN/COMMIT reais
 * e a regra vale em cada transação que emitir comando classificado.
 * Recusas depois da trava valem: o que importa é a ordem do que a entrada chegou a emitir.
 */
const req = createRequire(import.meta.url);
const { classificarComando } = req("../../scripts/guarda-salao-harness.cjs") as { classificarComando: (texto: string) => "CONFIG" | "AGENDA" | "LINHA" | null };

let a: Client;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "d2-rodada-2" });
const textoDe = (args: unknown[]) => typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
const mensagem = (e: unknown) => e instanceof Error ? e.message : String(e);

type Gravado = { classe: "CONFIG" | "AGENDA" | "LINHA"; texto: string };
/** Executa `corpo` (dentro de uma transação aberta) gravando as classes de cada comando emitido na conexão. */
async function gravando(corpo: () => Promise<unknown>) {
  const original = a.query;
  const gravados: Gravado[] = [];
  a.query = function (this: Client, ...args: unknown[]) {
    const texto = textoDe(args);
    const classe = classificarComando(texto);
    if (classe) gravados.push({ classe, texto: texto.replace(/\s+/g, " ").slice(0, 140) });
    return (original as (...x: unknown[]) => unknown).apply(this, args);
  } as typeof a.query;
  let erro: unknown = null;
  try {
    await a.query("SAVEPOINT entrada_d2_r2");
    await corpo();
    await a.query("RELEASE SAVEPOINT entrada_d2_r2");
  } catch (e) {
    erro = e;
    await (original as (...x: unknown[]) => Promise<unknown>).call(a, "ROLLBACK TO SAVEPOINT entrada_d2_r2");
  } finally {
    a.query = original;
  }
  return { gravados, erro };
}

type Opcoes = { exigirTrava?: boolean; aceitarErro?: RegExp };
const aceito = (erro: unknown, opcoes: Opcoes) => !erro || (opcoes.aceitarErro?.test(mensagem(erro)) ?? false);
const desfecho = (erro: unknown) => erro ? ` (desfecho: ${mensagem(erro).slice(0, 200)})` : "";

/** D'': CONFIG presente e antes do primeiro AGENDA/LINHA; `exigirTrava` = a entrada precisa ter chegado a travar agenda/linha. */
async function ordem(nome: string, corpo: () => Promise<unknown>, opcoes: Opcoes = {}) {
  const { gravados, erro } = await gravando(corpo);
  if (!aceito(erro, opcoes)) throw erro;
  const config = gravados.findIndex((g) => g.classe === "CONFIG");
  const primeira = gravados.findIndex((g) => g.classe !== "CONFIG");
  assert.ok(config >= 0, `${nome}: sem a trava da configuração (${JSON.stringify(gravados.slice(0, 3))})${desfecho(erro)}`);
  if (primeira >= 0) assert.ok(config < primeira, `${nome}: ${gravados[primeira]!.classe} antes da configuração: ${gravados[primeira]!.texto}`);
  if (opcoes.exigirTrava) assert.ok(primeira >= 0, `${nome}: a entrada não chegou a travar agenda/linha; a prova não exercita a ordem${desfecho(erro)}`);
  return { travou: primeira >= 0, erro };
}

type Transacao = { comandos: Gravado[]; fim: string | null };
/** Fluxo com transações PRÓPRIAS (BEGIN/COMMIT reais na conexão, fora de qualquer transação do teste): grava por transação. */
async function gravandoTransacoes(corpo: () => Promise<unknown>) {
  const original = a.query;
  const transacoes: Transacao[] = [];
  let atual = null as Transacao | null;
  a.query = function (this: Client, ...args: unknown[]) {
    const texto = textoDe(args);
    const t = texto.trim().toUpperCase();
    if (/^(BEGIN|START TRANSACTION)\b/.test(t)) {
      atual = { comandos: [], fim: null };
      transacoes.push(atual);
    } else if (t === "COMMIT" || t === "ROLLBACK") {
      if (atual) atual.fim = t;
      atual = null;
    } else {
      const classe = classificarComando(texto);
      if (classe && atual) atual.comandos.push({ classe, texto: texto.replace(/\s+/g, " ").slice(0, 140) });
    }
    return (original as (...x: unknown[]) => unknown).apply(this, args);
  } as typeof a.query;
  let erro: unknown = null;
  try {
    await corpo();
  } catch (e) {
    erro = e;
  } finally {
    a.query = original;
  }
  return { transacoes, erro };
}

/** D'' por transação: em cada transação com comando classificado, CONFIG existe e vem antes do primeiro AGENDA/LINHA. */
async function ordemPorTransacao(nome: string, corpo: () => Promise<unknown>, opcoes: Opcoes & { minimoComConfig?: number } = {}) {
  const { transacoes, erro } = await gravandoTransacoes(corpo);
  if (!aceito(erro, opcoes)) throw erro;
  const relevantes = transacoes.filter((t) => t.comandos.length > 0);
  relevantes.forEach((t, i) => {
    const config = t.comandos.findIndex((g) => g.classe === "CONFIG");
    const primeira = t.comandos.findIndex((g) => g.classe !== "CONFIG");
    assert.ok(config >= 0, `${nome}, transação ${i + 1}: sem a trava da configuração (${JSON.stringify(t.comandos.slice(0, 3))})`);
    if (primeira >= 0) assert.ok(config < primeira, `${nome}, transação ${i + 1}: ${t.comandos[primeira]!.classe} antes da configuração: ${t.comandos[primeira]!.texto}`);
  });
  const comConfig = relevantes.filter((t) => t.comandos.some((g) => g.classe === "CONFIG")).length;
  assert.ok(comConfig >= (opcoes.minimoComConfig ?? 1),
    `${nome}: ${comConfig} transação(ões) com a configuração (esperado ≥ ${opcoes.minimoComConfig ?? 1}; ${transacoes.length} abertas)${desfecho(erro)}`);
  if (opcoes.exigirTrava) {
    assert.ok(relevantes.some((t) => t.comandos.some((g) => g.classe !== "CONFIG")), `${nome}: nenhuma transação chegou a travar agenda/linha${desfecho(erro)}`);
  }
  return { transacoes: relevantes, erro };
}

/** Preparação COMITADA (BEGIN … COMMIT): as travas da fixture terminam no COMMIT e não chegam à transação da entrada. */
async function comCommit<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query("COMMIT");
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

/** A configuração da empresa NÃO está com este backend (nem a variável da entrada): nada herdado. */
async function semTravaHerdada(empresa: string) {
  const r = (await a.query<{ n: number; empresa: string | null }>(
    `SELECT (SELECT count(*)::int FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.objsubid = 1
               AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('kidmais:agenda-config:' || $1::text, 0)) AS n,
            nullif(current_setting('kidmais.agenda_config_empresa', true), '') AS empresa`, [empresa])).rows[0]!;
  assert.deepEqual(r, { n: 0, empresa: null }, "a transação da entrada começou com a configuração já travada (herdada)");
}

/**
 * Transação NOVA para uma entrada: BEGIN, pool global e ambiente apontados para ela; com `tenant`, a linha da empresa sob
 * FOR UPDATE como executarComPosseNoTenant/withTenantTransaction (entradas que provam o tenant sozinhas dispensam);
 * confere que nada da configuração foi herdado e SEMPRE desfaz no fim.
 */
async function transacaoNova<T>(empresa: string, corpo: () => Promise<T>, opcoes: { tenant?: boolean } = {}) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    if (opcoes.tenant) await a.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [empresa]);
    await semTravaHerdada(empresa);
    return await corpo();
  } finally {
    await a.query("ROLLBACK");
    restaurarAmbiente();
    restaurarPool();
  }
}

// ---------- Fixtures (como documental-ida-saloes.postgres.test.ts) ----------
const travar = (c: Cenario) => travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const adm = () => carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
const operar = () => adm().operarContrato as unknown as Operar;

async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato D''", contratada: { nome: "Buffet D Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}
const salao = (c: Cenario, nome: string, ordem: number, capacidade: number | null) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, $4) RETURNING id`, [c.empresa, nome, ordem, capacidade]);

async function empresaNativa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  await travar(c);
  const nativo = await catalogoNativo(a, c);
  await modeloContrato(c);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
  return { c, nativo };
}

async function clienteCompleto(c: Cenario) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente D', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante D') RETURNING id`, [cliente]);
  return { cpf, cliente, aniversariante };
}

/** Festa nativa (10:00–22:00, turno do cenário) sem salão; com `contrato`, emitida e assinada pela Kidmais (sem o cliente). */
async function festaNativa(c: Cenario, nativo: Nativo, data: string, forma: string | null = null) {
  const { cpf, cliente, aniversariante } = await clienteCompleto(c);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status, forma_pagamento_pretendida)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO', $7
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, forma]);
  return { festa, cpf, cliente };
}
async function emitida(c: Cenario, nativo: Nativo, data: string, forma: string | null = null) {
  const f = await festaNativa(c, nativo, data, forma);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: f.festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  await congelarEAssinarKidmais(a, operar(), gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  return { ...f, contrato: gerado.contrato.id, versao: gerado.versao.id };
}

/** Horário próprio da empresa (15:00–19:00, capacidade 1) com o catálogo do cenário: a agenda que a revalidação aceita. */
async function horarioTarde(c: Cenario) {
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($2, 'Tarde', '15:00', '19:00', 0, 30, 1, $1::uuid, 1) RETURNING id`,
  [c.empresa, `TD2_${randomBytes(4).toString("hex").toUpperCase()}`]);
  await catalogoNoTurno(a, c, tarde);
  return tarde;
}

const memo = <T>(fn: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= fn()); };

/** Empresa por salão (S1, S2) com uma festa SEM contrato e sem salão (a troca avulsa B7 é o caminho de hoje). */
const prepSalao = memo(() => comCommit(async () => {
  const { c, nativo } = await empresaNativa("POR_SALAO");
  const s1 = await salao(c, "S1", 1, 50);
  const s2 = await salao(c, "S2", 2, 80);
  const { festa } = await festaNativa(c, nativo, dia(250));
  return { c, nativo, s1, s2, festa };
}));

/** Empresa por horário com horário próprio, catálogo, cliente e aniversariante (criação de fechamento, pacotes, bloqueio). */
const prepAgenda = memo(() => comCommit(async () => {
  const { c, nativo } = await empresaNativa("POR_HORARIO");
  const tarde = await horarioTarde(c);
  const cliente = await clienteCompleto(c);
  return { c, nativo, tarde, ...cliente };
}));

/** Contrato emitido e assinado pelo cliente (festa 019 criada), com pagamento criado e Gestão com FESTA_CORRIGIR. */
const prepContrato = memo(() => comCommit(async () => {
  const { c, nativo } = await empresaNativa("POR_HORARIO");
  const e = await emitida(c, nativo, dia(240), "PIX_AVISTA");
  await assinarComoCliente(e.contrato, e.cpf);
  for (const capacidade of ["FESTA_CORRIGIR", "FESTA_OPERAR"])
    await a.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, $4, $3::uuid, 'Gestão sintética D2')`,
      [c.empresa, c.membership, c.usuario, capacidade]);
  const total = Number((await a.query<{ t: string }>(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' t FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1`, [e.contrato])).rows[0]!.t);
  const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
  const contexto = { token: c.token, usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "d2-r2", executor: executor(a) };
  const criado = await pag.criarPagamentoDoFechamento({ fechamentoId: e.festa, plano: { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: total, vencimento: dia(1), confirmaReserva: true }] } } as never,
    contexto as never) as { detalhe: { pagamento: { id: string } } };
  const festa019 = (await a.query<{ id: string; revisao: number }>(`SELECT id::text AS id, revisao FROM festas WHERE contrato_id = $1::uuid`, [e.contrato])).rows[0];
  assert.ok(festa019, "a assinatura do cliente criou a festa (019)");
  const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text AS v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [e.contrato])).rows[0]!.v;
  return { c, e, total, pagamento: criado.detalhe.pagamento.id, festa019, vigente };
}));

// ---------- Rotas reais (carregador de testes com a conexão descartável) ----------
type Sessao = { usuario_id: string; papel: string };
type Rota = Record<string, (...args: unknown[]) => Promise<unknown>>;
/** Rota administrativa real: sessão dublada (como agenda-versao), banco = a transação nova do teste (savepoint por withTransaction). */
function rotaAdmin(arquivo: string, sessao: Sessao) {
  return carregarComBanco(arquivo, a, () => sessao, {
    "db/postgres": { db: () => executor(a), withTransaction: porSavepoint(a) },
    "http/admin-crm-api": {
      exigirApiAdminCrmDisponivel: async () => sessao,
      contextoCrmDaRequest: () => ({ usuarioId: sessao.usuario_id, origem: "CRM_INTERNO", requestId: randomUUID(), ip: null, userAgent: "d2-r2" }),
    },
  }, new Map()) as unknown as Rota;
}
const pedido = (caminho: string, corpo: unknown, metodo = "POST") => {
  const url = `http://localhost${caminho}`;
  return { method: metodo, url, nextUrl: new URL(url), headers: new Headers(), cookies: { get: () => undefined }, json: async () => corpo };
};
type Corpo = { ok?: boolean; codigo?: string; erro?: string; detalhes?: unknown };
async function lerResposta(r: unknown) {
  const x = r as { status: number; json?: () => Promise<unknown>; body?: unknown };
  const corpo = (typeof x.json === "function" ? await x.json() : x.body) as Corpo | undefined;
  return { status: x.status, corpo: corpo ?? {} };
}
/** A rota devolve a recusa como resposta: aqui ela vira exceção, para `ordem` aceitar só as recusas declaradas. */
async function chamar(resposta: Promise<unknown>) {
  const r = await lerResposta(await resposta);
  if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.corpo.codigo ?? ""}: ${r.corpo.erro ?? ""}`);
  return r;
}
const RECUSA_HTTP = /^HTTP [45]\d\d /;

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("D'' (rodada 2): POST /api/admin/agenda/salao (troca de salão) em transação nova sem trava herdada → configuração antes do fechamento", { timeout: 300_000 }, async () => {
  const p = await prepSalao();
  const rota = rotaAdmin("app/api/admin/agenda/salao/route.ts", { usuario_id: p.c.usuario, papel: "ADMINISTRATIVO" });
  await transacaoNova(p.c.empresa, async () => {
    const r = await ordem("POST /api/admin/agenda/salao", () => chamar(rota.POST!(pedido("/api/admin/agenda/salao", { empresaId: p.c.empresa, fechamentoId: p.festa, salaoId: p.s1 }))),
      { exigirTrava: true, aceitarErro: RECUSA_HTTP });
    assert.ok(r.travou);
  });
});

test("D'' (rodada 2): pacotes pela rota (POST criar e PATCH /[id] desativar), cada um em transação nova → a configuração vem antes", { timeout: 300_000 }, async () => {
  const p = await prepAgenda();
  const gestao: Sessao = { usuario_id: p.nativo.representante.usuarioId, papel: "ADMINISTRATIVO" };
  const lista = rotaAdmin("app/api/admin/configuracoes/pacotes/route.ts", gestao);
  const item = rotaAdmin("app/api/admin/configuracoes/pacotes/[id]/route.ts", gestao);
  // Escritores de pacote: só a configuração (pacote_saloes não é trava de agenda); a ordem vale se houver.
  await transacaoNova(p.c.empresa, () => ordem("POST /api/admin/configuracoes/pacotes (criar)", async () => {
    const r = await chamar(lista.POST!(pedido("/api/admin/configuracoes/pacotes", { acao: "criar", empresaId: p.c.empresa, nome: "Festa D2", descricao: null, duracaoMinutos: 240 })));
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
  }));
  await transacaoNova(p.c.empresa, () => ordem("PATCH /api/admin/configuracoes/pacotes/[id] (desativar)", () =>
    chamar(item.PATCH!(pedido(`/api/admin/configuracoes/pacotes/${p.c.pacote}`, { acao: "desativar", empresaId: p.c.empresa, motivo: "Pausa D2" }, "PATCH"),
      { params: Promise.resolve({ id: p.c.pacote }) })), { aceitarErro: RECUSA_HTTP }));
});

test("D'' (rodada 2): POST /api/admin/disponibilidade (criar bloqueio) em transação nova → configuração antes de bloqueios_agenda", { timeout: 300_000 }, async () => {
  const p = await prepAgenda();
  const rota = rotaAdmin("app/api/admin/disponibilidade/route.ts", { usuario_id: p.c.usuario, papel: "ADMINISTRATIVO" });
  await transacaoNova(p.c.empresa, () => ordem("POST /api/admin/disponibilidade (criar_bloqueio)", () =>
    chamar(rota.POST!(pedido("/api/admin/disponibilidade", { empresaId: p.c.empresa, tipo: "criar_bloqueio", data: dia(260), escopo: "personalizado",
      horarioInicio: "15:00", horarioFim: "17:00", motivo: "Bloqueio D2" }))), { exigirTrava: true, aceitarErro: RECUSA_HTTP }));
});

/**
 * Porta REAL de pacotes da IA (app/api/admin/inteligencia/operacoes/composicao.ts), carregada com os serviços de pacote e
 * de agenda reais (mesma técnica de agenda-um-salao-servicos.postgres.test.ts); os demais imports da composition root não
 * participam destas chamadas e entram como módulos vazios.
 */
type PortaIa = {
  criar: (t: DbExecutor, dados: Record<string, unknown>, c: Record<string, unknown>) => Promise<unknown>;
  alterarSituacao: (t: DbExecutor, id: string, situacao: "ativar" | "desativar", c: Record<string, unknown>) => Promise<unknown>;
};
function portaIa(): PortaIa {
  const arquivo = "app/api/admin/inteligencia/operacoes/composicao.ts";
  const dubles: Record<string, unknown> = { "lib/agenda/trava-configuracao": travaConfiguracao, "lib/agenda/configuracao-unidade": configuracaoUnidade,
    "lib/comercial/pacote-comercial": pacoteComercial, "lib/comercial/pacote-precos": pacotePrecos, "lib/comercial/pacotes-admin": pacotesAdmin };
  for (const [, origem] of readFileSync(arquivo, "utf8").matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)) {
    const chave = origem!.startsWith("@/") ? origem!.slice(2) : origem!.replace(/^(\.\.\/)+/, "");
    if (!(chave in dubles) && !origem!.startsWith("node:")) dubles[chave] = {};
  }
  return (carregarModulo(arquivo, dubles) as { portaPacotes: PortaIa }).portaPacotes;
}

test("D'' (rodada 2): porta de pacotes da IA (criar, desativar) sob o tenant, em transação nova → a configuração vem antes", { timeout: 300_000 }, async () => {
  const p = await prepAgenda();
  const porta = portaIa();
  const ctx = () => ({ empresaId: p.c.empresa, usuarioId: p.c.usuario, requestId: randomUUID(), motivo: "Prova D2" });
  await transacaoNova(p.c.empresa, () => ordem("IA portaPacotes.criar", () => porta.criar(executor(a),
    { nome: "Festa da IA D2", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80, faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }] }, ctx()),
  { aceitarErro: /./ }), { tenant: true });
  await transacaoNova(p.c.empresa, () => ordem("IA portaPacotes.alterarSituacao", () => porta.alterarSituacao(executor(a), p.c.pacote, "desativar", ctx()),
    { aceitarErro: /./ }), { tenant: true });
});

/** Rota pública POST /api/fechamentos real, com transações PRÓPRIAS (BEGIN/COMMIT) na conexão (como e2b/S-D). */
function rotaFechamentos(c: Cenario) {
  const extras = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-d2",
      escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
    "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }),
      escopoPublico: async () => ({ empresaId: c.empresa, estabelecimentoId: null }) },
    "db/postgres": { db: () => executor(a), withTransaction: porTransacao(a) },
  };
  const rota = carregarComBanco("app/api/fechamentos/route.ts", a, () => null, extras, new Map()) as unknown as Rota;
  return (corpo: Record<string, unknown>) => rota.POST!({ url: "http://localhost/api/fechamentos", nextUrl: new URL("http://localhost/api/fechamentos"), headers: new Headers(),
    json: async () => ({
      pacote: "completa", ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00", identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel",
      convidadosPagantes: 40, buffetDefinicao: "depois", adicionaisSelecionados: [], valorCombinado: "100,00", formaPagamento: "pix_avista",
      nomeCliente: "Cliente Sintético D2", cpf: cpfValido(), email: `d2-${randomBytes(3).toString("hex")}@buffet.test`, whatsapp: "11988880004", telefone: "1133330004",
      cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF", nomeAniversariante: "Aniversariante D2", idadeAniversariante: 6,
      ...corpo,
    }) });
}
async function comFlags<T>(flags: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const antes = Object.fromEntries(Object.keys(flags).map((n) => [n, process.env[n]]));
  for (const [n, v] of Object.entries(flags)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  try { return await fn(); } finally {
    for (const [n, v] of Object.entries(antes)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
}

test("D'' (rodada 2): POST /api/fechamentos — criação pública (criarFechamentoPublicoComIdentidade) e diagnóstico SO_LEITURA da preferência, cada transação da rota com a configuração antes", { timeout: 300_000 }, async () => {
  const p = await prepAgenda();
  const enviar = rotaFechamentos(p.c);
  // Criação: a transação da rota (KEY_SHARE → configuração → cliente/fechamento) começa do zero (BEGIN real, nada herdado).
  let criado: Awaited<ReturnType<typeof lerResposta>> | null = null;
  await comFlags({ SALOES_PUBLICOS: undefined, SALOES_COMBINADOS_PUBLICOS: undefined }, () =>
    ordemPorTransacao("POST /api/fechamentos (criação)", async () => {
      criado = await lerResposta(await enviar({ dataFesta: dia(270), configuracaoId: p.tarde, salaoPreferido: null }));
    }, { exigirTrava: true }));
  assert.equal(criado!.status, 201, JSON.stringify(criado!.corpo));
  // SO_LEITURA (route.ts:93): revalidação recusada (horário inexistente) com salão de preferência e os combinados públicos
  // ligados → transação READ ONLY com a configuração antes da trava da data (decidirPreferencia).
  const r = await comFlags({ SALOES_PUBLICOS: "true", SALOES_COMBINADOS_PUBLICOS: "true" }, async () => {
    let resposta: Awaited<ReturnType<typeof lerResposta>> | null = null;
    await ordemPorTransacao("POST /api/fechamentos (preferência, SO_LEITURA)", async () => {
      resposta = await lerResposta(await enviar({ dataFesta: dia(271), configuracaoId: randomUUID(), salaoPreferido: randomUUID() }));
    }, { exigirTrava: true });
    return resposta!;
  });
  assert.equal(r.status, 409, JSON.stringify(r.corpo));
  assert.equal(r.corpo.codigo, "SALAO_INDISPONIVEL", "a recusa veio do diagnóstico da preferência (exige a 108 NOVA no modelo e as duas flags)");
});

test("D'' (rodada 2): criação ADMINISTRATIVA do fechamento (criarFechamentoAdministrativo, sessão e tenant reais) em transação nova → configuração antes de agenda/fechamento", { timeout: 300_000 }, async () => {
  const p = await prepAgenda();
  const svc = carregar<typeof import("../fechamentos/services/fechamento-administrativo.service.ts")>("lib/fechamentos/services/fechamento-administrativo.service.ts");
  const raw = { dataFesta: dia(272), configuracaoId: p.tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00", statusDisponibilidade: "disponivel",
    convidadosPagantes: 40, buffetDefinicao: "depois", adicionaisSelecionados: [], valorCombinado: "100,00", formaPagamento: "pix_avista",
    aniversarianteId: p.aniversariante, idadeAniversariante: 6, pacote: "completa" };
  // A entrada prova o tenant sozinha (consultarSessao → executarNoTenant: empresa FOR UPDATE); nada antes dela.
  await transacaoNova(p.c.empresa, () => ordem("criarFechamentoAdministrativo", () =>
    svc.criarFechamentoAdministrativo(p.cliente, raw, { token: p.c.token, requestId: randomUUID(), userAgent: "d2-r2", empresaSolicitada: p.c.empresa }),
  { exigirTrava: true }));
});

test("D'' (rodada 2): publicarImportacao (tabela de preços) — cada transação da publicação com a configuração antes", { timeout: 300_000 }, async () => {
  const l = (ate: number | null, valor: number) => ({ de: null, ate, valor, rotulo: null });
  const prep = await comCommit(async () => {
    const c = await cenario(a, 0);
    await travar(c);
    await catalogoNativo(a, c);
    const tx = executor(a);
    const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
    const nome = (await a.query<{ nome: string }>(`SELECT nome FROM pacotes WHERE id = $1::uuid`, [c.pacote])).rows[0]!.nome;
    const leitura: LeituraTabela = {
      pacotes: [{ nome, pagina: 1, descricao: "Descrição D2.", selo: null, duracao: null, convidadosMin: null, convidadosMax: null, inclusos: [],
        cobranca: "FAIXAS", grades: [{ horario: "UNICO", linhas: [l(50, 9000), l(150, 15000)] }], valorPorConvidado: null, aPartirDe: null }],
      adicionais: [], comuns: [], horarios: [], informacoes: [], naoImportavel: [],
    };
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n% tabela D2 ${randomUUID()}\n%%EOF`));
    const importacao = await registrarImportacao(tx, ctx, { contentType: "application/pdf", nomeSeguro: "tabela.pdf", tamanhoBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    const lida = await gravarLeitura(tx, ctx, importacao, { ok: true, leitura, modelo: "fake", provedor: "FAKE" });
    assert.ok(lida.revisao, "leitura simulada vira revisão");
    const revisao = { ...lida.revisao, pacotes: lida.revisao.pacotes.map((x) => ({ ...x, pacoteId: x.pacoteId ?? c.pacote, confirmado: true, aplicarDescricao: true })),
      adicionais: lida.revisao.adicionais.map((x) => ({ ...x, confirmado: true })) };
    const revista = await salvarRevisao(tx, ctx, importacao, lida.versao, revisao);
    return { c, ctx, importacao, versao: revista.versao };
  });
  // Como a rota: cada transação da publicação é do tenant (linha da empresa FOR UPDATE primeiro), com BEGIN/COMMIT reais.
  const doTenant: EmTransacao = async (trabalho) => {
    await a.query("BEGIN");
    try {
      await a.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [prep.c.empresa]);
      await semTravaHerdada(prep.c.empresa);
      const r = await trabalho(executor(a));
      await a.query("COMMIT");
      return r;
    } catch (error) {
      await a.query("ROLLBACK");
      throw error;
    }
  };
  // Preparo + preços (+ descrição): ao menos duas transações; publicação recusada depois da trava também vale.
  await ordemPorTransacao("publicarImportacao", () => publicarImportacao(doTenant, { ...prep.ctx, requestId: randomUUID() }, prep.importacao, prep.versao),
    { minimoComConfig: 2, aceitarErro: /./ });
});

test("D'' (rodada 2): cancelamento da contratação pela festa (comandarFesta 'cancelar_contratacao') em transação nova → configuração antes de fechamento/contrato", { timeout: 300_000 }, async () => {
  const p = await prepContrato();
  const festas = carregar<typeof import("../festas/service.ts")>("lib/festas/service.ts");
  // A entrada prova sessão e tenant sozinha (provarTenant: empresa FOR UPDATE); nada antes dela.
  await transacaoNova(p.c.empresa, () => ordem("comandarFesta cancelar_contratacao", () =>
    festas.comandarFesta(p.festa019.id, { acao: "cancelar_contratacao", chave: randomUUID(), revisao: Number(p.festa019.revisao), versaoId: p.vigente, motivo: "Cancelamento D2" },
      { token: p.c.token, requestId: randomUUID(), userAgent: "d2-r2", empresaSolicitada: p.c.empresa }),
  { exigirTrava: true, aceitarErro: /./ }));
});

test("D'' (rodada 2): bloquearPagamento pelo chamador real (substituirPlanoPagamento) sob o tenant, em transação nova → configuração antes de pagamento/fechamento", { timeout: 300_000 }, async () => {
  const p = await prepContrato();
  const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
  await transacaoNova(p.c.empresa, () => ordem("substituirPlanoPagamento → bloquearPagamento", () =>
    pag.substituirPlanoPagamento(p.pagamento, { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: p.total, vencimento: dia(2), confirmaReserva: true }] } as never, "Troca do vencimento D2",
      { token: p.c.token, usuarioId: p.c.usuario, origem: "ADMIN_FINANCEIRO", ...ctxOp(), executor: executor(a) } as never),
  { exigirTrava: true, aceitarErro: /./ }), { tenant: true });
});

// ---------- Rodada 2 (regressão completa): travas de linha compartilhadas sem a configuração ----------
// A guarda da regressão completa apontou `contrato(tx, id, true)` (festas/convites) travando o fechamento sem a configuração;
// a mesma forma estava em `bloquearFinanceiro` (primeiro passo de cronograma, devolução e alteração financeira, que com a 114
// alteram contrato/fechamento). As duas passam a tomar empresa → configuração COMPARTILHADA antes da primeira trava de linha.

test("D'' (rodada 2): festa — ação comum (observação) pelo comandarFesta em transação nova → configuração antes do fechamento", { timeout: 300_000 }, async () => {
  const p = await prepContrato();
  const festas = carregar<typeof import("../festas/service.ts")>("lib/festas/service.ts");
  await transacaoNova(p.c.empresa, () => ordem("comandarFesta observacao → contrato(tx, id, true)", () =>
    festas.comandarFesta(p.festa019.id, { acao: "observacao", chave: randomUUID(), revisao: Number(p.festa019.revisao), versaoId: p.vigente, descricao: "Observação D2" },
      { token: p.c.token, requestId: randomUUID(), userAgent: "d2-r2", empresaSolicitada: p.c.empresa }),
  { exigirTrava: true, aceitarErro: /./ }));
});

test("D'' (rodada 2): financeiro — reprogramar cronograma e solicitar devolução (bloquearFinanceiro) sob o tenant, em transação nova → configuração antes", { timeout: 300_000 }, async () => {
  const p = await prepContrato();
  const cronograma = carregar<typeof import("../pagamentos/services/cronograma.service.ts")>("lib/pagamentos/services/cronograma.service.ts");
  const devolucao = carregar<typeof import("../pagamentos/services/devolucao.service.ts")>("lib/pagamentos/services/devolucao.service.ts");
  const contexto = () => ({ token: p.c.token, requestId: randomUUID(), ip: null, userAgent: "d2-r2", executor: executor(a), papelNoTenant: "REPRESENTANTE_AUTORIZADO" });
  // Pedidos sintéticos: a recusa (hash da posição, valores) vem DEPOIS da trava; o que se prova é a ordem do que foi emitido.
  await transacaoNova(p.c.empresa, () => ordem("reprogramarCronograma → bloquearFinanceiro", () =>
    cronograma.reprogramarCronograma(p.e.contrato, { posicaoHash: "0".repeat(64) } as never, randomUUID(), contexto() as never),
  { exigirTrava: true, aceitarErro: /./ }), { tenant: true });
  await transacaoNova(p.c.empresa, () => ordem("solicitarDevolucao → bloquearFinanceiro", () =>
    devolucao.solicitarDevolucao(p.e.contrato, { posicaoHash: "0".repeat(64), valorCentavos: "100", beneficiario: { nome: "Cliente" }, motivo: "D2", origens: [] } as never,
      randomUUID(), contexto() as never),
  { exigirTrava: true, aceitarErro: /./ }), { tenant: true });
});

// ---------- Rodada 3 (P1 do Astra): revisão comercial do fechamento ----------
/** Fechamento AGUARDANDO_APROVACAO com negociação de valor e solicitação PENDENTE (como fechamento.service cria). */
async function revisaoPendente(c: Cenario, nativo: Nativo, data: string) {
  const { cliente, aniversariante } = await clienteCompleto(c);
  const condicao = { schemaVersao: 1, forma: "PIX_AVISTA", pretendida: null, aprovada: null, revisaoStatus: "PENDENTE" };
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, valor_negociado, origem_fechamento,
        cliente_id, aniversariante_id, status, forma_pagamento_pretendida, condicao_pagamento)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 90, 'ATENDIMENTO_KIDMAIS',
        $5::uuid, $6::uuid, 'AGUARDANDO_APROVACAO', 'PIX_AVISTA', $7::jsonb
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
  [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, JSON.stringify(condicao)]);
  const solicitacao = await id(a, `INSERT INTO aprovacoes_negociacao (fechamento_id, valor_informado, valor_aprovado, status, motivo, condicao_pagamento)
      VALUES ($1::uuid, 90, NULL, 'PENDENTE', 'Desconto D2', $2::jsonb) RETURNING id`, [festa, JSON.stringify(condicao)]);
  return { festa, solicitacao };
}
/** Quatro revisões pendentes COMITADAS (aprovar e recusar pela rota; aprovar pelo serviço sem customDb, em savepoint e com COMMIT real). */
const prepRevisao = memo(() => comCommit(async () => {
  const { c, nativo } = await empresaNativa("POR_HORARIO");
  return { c, aprovar: await revisaoPendente(c, nativo, dia(281)), recusar: await revisaoPendente(c, nativo, dia(282)), propria: await revisaoPendente(c, nativo, dia(283)),
    aprovarPropria: await revisaoPendente(c, nativo, dia(284)) };
}));
/** Decisão persistida na transação (antes do ROLLBACK da transação nova), com as verificações diferidas disparadas. */
async function decisaoGravada(festa: string, solicitacao: string, status: "AGUARDANDO_CONTRATO" | "RECUSADO") {
  await a.query("SET CONSTRAINTS ALL IMMEDIATE");
  const f = (await a.query<{ status: string; revisao: string }>(`SELECT status, condicao_pagamento->>'revisaoStatus' AS revisao FROM fechamentos WHERE id = $1::uuid`, [festa])).rows[0]!;
  assert.deepEqual(f, { status, revisao: status === "RECUSADO" ? "RECUSADA" : "APROVADA" });
  const d = (await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM aprovacoes_negociacao WHERE fechamento_id = $1::uuid AND condicao_pagamento->>'solicitacaoId' = $2`, [festa, solicitacao])).rows[0]!;
  assert.equal(d.n, 1, "a decisão foi gravada em aprovacoes_negociacao");
}

test("D'' (rodada 3, P1 do Astra): POST /api/admin/fechamentos/[id]/revisao — APROVAR e RECUSAR válidos, cada um em transação nova sem trava herdada → configuração antes do fechamento, decisão gravada, sem KD114", { timeout: 300_000 }, async () => {
  const p = await prepRevisao();
  const rota = rotaAdmin("app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts", { usuario_id: p.c.usuario, papel: "ADMINISTRATIVO" });
  const casos = [
    { r: p.aprovar, corpo: { solicitacaoId: p.aprovar.solicitacao, decisao: "APROVAR", valorBaseAprovado: 90, motivo: "Aprovação D2" }, status: "AGUARDANDO_CONTRATO" as const },
    { r: p.recusar, corpo: { solicitacaoId: p.recusar.solicitacao, decisao: "RECUSAR", motivo: "Recusa D2" }, status: "RECUSADO" as const },
  ];
  for (const caso of casos) {
    await transacaoNova(p.c.empresa, async () => {
      await ordem(`POST revisão ${caso.corpo.decisao}`, async () => {
        const r = await chamar(rota.POST!(pedido(`/api/admin/fechamentos/${caso.r.festa}/revisao?empresaId=${p.c.empresa}`, caso.corpo),
          { params: Promise.resolve({ fechamentoId: caso.r.festa }) }));
        assert.equal(r.status, 201, JSON.stringify(r.corpo));
      }, { exigirTrava: true });
      await decisaoGravada(caso.r.festa, caso.corpo.solicitacaoId, caso.status);
    });
  }
});

test("D'' (rodada 3, P1 do Astra): revisarComercial sem customDb (transação própria do serviço) em transação nova → configuração antes do fechamento, decisão gravada", { timeout: 300_000 }, async () => {
  const p = await prepRevisao();
  const svc = carregar<typeof import("../fechamentos/services/revisao-comercial.service.ts")>("lib/fechamentos/services/revisao-comercial.service.ts");
  await transacaoNova(p.c.empresa, async () => {
    await ordem("revisarComercial (APROVAR, sem customDb)", () => svc.revisarComercial(p.propria.festa, p.c.empresa,
      { solicitacaoId: p.propria.solicitacao, decisao: "APROVAR", valorBaseAprovado: 90, motivo: "Aprovação própria D2" }, { usuarioId: p.c.usuario, origem: "CRM_INTERNO" }),
    { exigirTrava: true });
    await decisaoGravada(p.propria.festa, p.propria.solicitacao, "AGUARDANDO_CONTRATO");
  });
});

test("D'' (rodada 3.1, P3-1 do Astra): revisarComercial sem customDb com BEGIN/COMMIT REAIS numa conexão própria → configuração antes do fechamento, COMMIT real e decisão lida por outra conexão", { timeout: 300_000 }, async () => {
  const p = await prepRevisao();
  const svc = carregar<typeof import("../fechamentos/services/revisao-comercial.service.ts")>("lib/fechamentos/services/revisao-comercial.service.ts");
  // Pool global sem conversão em SAVEPOINT: o withTransaction real abre e confirma a própria transação na conexão `b`.
  // Conexão extra SEM a trava de exclusividade do banco (que a conexão do teste já tem).
  const b = await conectarDescartavel({ travar: false });
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const anterior = g.__kidmaisPgPool;
  const sequencia: { classe: string | null; texto: string }[] = [];
  g.__kidmaisPgPool = {
    query: (sql: string, v?: unknown[]) => b.query(sql, v),
    connect: async () => ({
      query: (sql: string, v?: unknown[]) => {
        const t = textoDe([sql]).trim();
        sequencia.push({ classe: /^(BEGIN|COMMIT|ROLLBACK)$/i.test(t) ? t.toUpperCase() : classificarComando(t), texto: t.replace(/\s+/g, " ").slice(0, 140) });
        return b.query(sql, v);
      },
      release() {},
    }),
  };
  // A conexão extra fecha em qualquer desfecho (asserção falhando não pode deixar a suíte presa).
  try {
    try {
      // Conexão nova, fora de transação: nada da configuração herdado.
      const herdada = (await b.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)).rows[0]!;
      assert.equal(herdada.n, 0, "a conexão do serviço começou sem advisory");
      await svc.revisarComercial(p.aprovarPropria.festa, p.c.empresa,
        { solicitacaoId: p.aprovarPropria.solicitacao, decisao: "APROVAR", valorBaseAprovado: 90, motivo: "Aprovação com COMMIT real" }, { usuarioId: p.c.usuario, origem: "CRM_INTERNO" });
    } finally {
      g.__kidmaisPgPool = anterior;
    }
    const marcos = sequencia.filter((s) => s.classe);
    assert.equal(marcos[0]?.classe, "BEGIN", JSON.stringify(marcos.slice(0, 4)));
    assert.equal(marcos.at(-1)?.classe, "COMMIT", "a transação própria do serviço terminou em COMMIT real");
    const config = marcos.findIndex((s) => s.classe === "CONFIG");
    const primeira = marcos.findIndex((s) => s.classe === "AGENDA" || s.classe === "LINHA");
    assert.ok(config > 0 && primeira > config, `configuração antes do primeiro lock de linha/agenda: ${JSON.stringify(marcos.slice(0, 6))}`);
    const depois = (await b.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)).rows[0]!;
    assert.equal(depois.n, 0, "a advisory da configuração terminou com o COMMIT");
  } finally {
    await encerrarDescartavel(b).catch(() => undefined);
  }
  // Leitura independente, por OUTRA conexão (a do teste, fora de transação): a decisão persistiu após o COMMIT próprio.
  const f = (await a.query<{ status: string; revisao: string }>(`SELECT status, condicao_pagamento->>'revisaoStatus' AS revisao FROM fechamentos WHERE id = $1::uuid`, [p.aprovarPropria.festa])).rows[0]!;
  assert.deepEqual(f, { status: "AGUARDANDO_CONTRATO", revisao: "APROVADA" });
  const d = (await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM aprovacoes_negociacao WHERE fechamento_id = $1::uuid AND condicao_pagamento->>'solicitacaoId' = $2`,
    [p.aprovarPropria.festa, p.aprovarPropria.solicitacao])).rows[0]!;
  assert.equal(d.n, 1, "a decisão persistida é vista por outra conexão");
});
