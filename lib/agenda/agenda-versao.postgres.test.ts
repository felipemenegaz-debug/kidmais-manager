import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, representante, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { combinadosInstalados } from "./salao-festa.ts";
import {
  cancelarDesativacao, desativarHorarioAPartirDe, lerAgendaEscopo, salvarAgendaEscopo, type AgendaEscopo, type SalvarAgenda,
} from "./configuracao-unidade.ts";
import { versaoAgenda, type LinhaHorarioProjecao, type NivelHeranca, type ProjecaoVersao } from "./versao-agenda.ts";
import { lerAgendaReferencia } from "./leitura-agenda-referencia.test-apoio.ts";
import { provarTenant } from "../saas/provar-tenant.ts";

/**
 * Plano "Agenda: concorrência otimista do agregado" (rev. 1.1, seção 8 + R1-2/R1-3), no PostgreSQL DESCARTÁVEL.
 * Cada roteiro declara o protocolo que prova (R1-2):
 * - serviços reais em conexões separadas, SEM a guarda de tenant à frente: advisory (T-B6/T-B9) e fotografia (T-A4);
 * - rota real (withTransaction dublado só para abrir a conexão descartável): janela 1 do assistente, T-B10, guarda (T-D1);
 * - janela 2 do assistente: INJEÇÃO de interleaving defensivo (a configuração é criada dentro da transação da rota,
 *   logo depois de escopoJaConfigurado=false). Não é corrida natural de dois POSTs: a guarda trava a empresa (FOR UPDATE)
 *   e qualquer INSERT concorrente em agenda_escopo_config esperaria pela FK (KEY SHARE).
 * Modelos: 097 (093–097, sem 100 e sem 098), 097 + 100 (variante agenda-versao-100) e 098.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(import.meta.url);
const COM_100 = process.env.KIDMAIS_AGENDA_VERSAO_COM_100 === "1";
const LIBERADA = { maisDeUmSalaoLiberada: true };
const TODOS = [1, 2, 3, 4, 5, 6, 7];
let a: Client;
let v098 = false;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codigo = (e: unknown) => (e as { code?: string })?.code;
const ex = (c: Client): DbExecutor => ({
  async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await c.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  },
});
/** Cópia profunda congelada (P2-1): o código sob teste não consegue alterar o oráculo. */
function congelar<T>(valor: T): T {
  if (valor && typeof valor === "object") {
    for (const v of Object.values(valor)) congelar(v);
    Object.freeze(valor);
  }
  return valor;
}
/** Executor que pausa UMA vez logo depois da primeira consulta que casar com `depois`, guardando CÓPIA congelada do resultado bruto. */
function exComPausa(c: Client, depois: RegExp) {
  let liberar!: () => void;
  let pausou!: () => void;
  const solto = new Promise<void>((fim) => { liberar = fim; });
  const pausado = new Promise<void>((fim) => { pausou = fim; });
  const estado: { bruto: Record<string, unknown> | null; usado: boolean } = { bruto: null, usado: false };
  const executor: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const r = await c.query(text, values as unknown[]);
      if (!estado.usado && depois.test(text)) {
        estado.usado = true;
        estado.bruto = congelar(structuredClone(r.rows[0]) as Record<string, unknown>);
        pausou();
        await solto;
      }
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  };
  return { executor, estado, pausado, liberar };
}
async function emTx<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    const r = await fn();
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
async function resultado<T>(p: Promise<T>): Promise<T | Error> {
  try { return await p; } catch (e) { return e as Error; }
}
async function conexao() { return conectarDescartavel({ travar: false }); }
const pid = async (c: Client) => (await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p;

/** Espera observada no servidor: PID bloqueador correto e o evento esperado; timeout curto (o mutante pode remover o evento). */
async function esperaObservada(esperando: number, segurando: number, eventos: string[], limiteMs = 6000) {
  let ultimo: unknown = null;
  for (const fim = Date.now() + limiteMs; Date.now() < fim;) {
    const r = await a.query<{ bloqueado: boolean; tipo: string | null; evento: string | null }>(
      `SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS bloqueado, wait_event_type AS tipo, wait_event AS evento
         FROM pg_stat_activity WHERE pid = $1::int`, [esperando, segurando]);
    ultimo = r.rows[0];
    const l = r.rows[0];
    if (l?.bloqueado && l.tipo === "Lock" && l.evento && eventos.includes(l.evento)) return l.evento;
    await new Promise((fim) => setTimeout(fim, 20));
  }
  throw new Error(`espera não observada (${eventos.join("/")}) de ${esperando} por ${segurando}: ${JSON.stringify(ultimo)}`);
}

const ctx = (usuario: string) => ({ empresaId: "", usuarioId: usuario, requestId: randomUUID() });
const contexto = (c: Cenario, usuario = c.usuario) => ({ ...ctx(usuario), empresaId: c.empresa });

/** Entrada do salvar a partir da agenda lida (como a tela faz), com mudanças opcionais. */
function entradaDe(agenda: AgendaEscopo, mudar: Partial<SalvarAgenda> = {}): SalvarAgenda {
  const nome = new Map([...agenda.saloes, ...agenda.combinados].map((s) => [s.id, s.nome]));
  return {
    versaoEsperada: agenda.versaoAgenda,
    estabelecimentoId: agenda.escopo.estabelecimentoId,
    modo: agenda.config?.modo ?? "FIXO",
    capacidadeTipo: agenda.config?.capacidadeTipo ?? "POR_HORARIO",
    limiteFestasDia: agenda.config?.limiteFestasDia ?? null,
    intervaloMinimoMinutos: agenda.config?.intervaloMinimoMinutos ?? 60,
    saloes: agenda.saloes.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidadeConvidados })),
    horarios: agenda.horarios.map((h) => ({ ...(h.herdado ? { id: h.id } : { id: h.id }), nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias,
      capacidade: h.capacidade, saloes: h.saloes.map((id) => nome.get(id) ?? id) })),
    ...mudar,
  };
}
const ler = (c: Cenario, unidade: string | null = null, cliente = a) => lerAgendaEscopo(ex(cliente), c.empresa, unidade);

/** Agenda da empresa (sem unidade) com um salão: horários dados, gravada pelo serviço com a versão lida. */
async function agendaUmSalao(c: Cenario, horarios: Array<[string, string, string]> = [["Manhã", "09:00", "12:00"], ["Tarde", "15:00", "19:00"]]) {
  const inicial = await ler(c);
  return emTx(a, () => salvarAgendaEscopo(ex(a), {
    ...entradaDe(inicial), capacidadeTipo: "POR_HORARIO", saloes: [],
    horarios: horarios.map(([nome, inicio, fim]) => ({ nome, inicio, fim, dias: TODOS, capacidade: 1, saloes: [] })),
  }, contexto(c), "CONFIGURACOES"));
}
/** Agenda por salão (liberada só nas provas) com S1/S2 e um horário ligado a S1. */
async function agendaPorSalao(c: Cenario) {
  const inicial = await ler(c);
  return emTx(a, () => salvarAgendaEscopo(ex(a), {
    ...entradaDe(inicial), capacidadeTipo: "POR_SALAO",
    saloes: [{ nome: "S1", capacidadeConvidados: 100 }, { nome: "S2", capacidadeConvidados: 80 }],
    horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: ["S1"] }],
  }, contexto(c), "CONFIGURACOES", LIBERADA));
}

/** Fotografia integral do agregado + regras + auditoria da empresa, com timestamps (R1-2: nunca só o token). */
async function fotografia(c: Cenario) {
  const q = async (sql: string) => (await a.query<{ j: unknown }>(sql, [c.empresa])).rows.map((l) => l.j);
  const horarios = "SELECT id FROM configuracao_agenda WHERE empresa_id = $1::uuid";
  return {
    config: await q(`SELECT to_jsonb(t) AS j FROM agenda_escopo_config t WHERE empresa_id = $1::uuid ORDER BY id`),
    saloes: await q(`SELECT to_jsonb(t) AS j FROM agenda_saloes t WHERE empresa_id = $1::uuid ORDER BY id`),
    horarios: await q(`SELECT to_jsonb(t) AS j FROM configuracao_agenda t WHERE empresa_id = $1::uuid ORDER BY id`),
    vinculos: await q(`SELECT to_jsonb(t) AS j FROM configuracao_agenda_saloes t WHERE configuracao_agenda_id IN (${horarios}) ORDER BY configuracao_agenda_id, salao_id`),
    categorias: await q(`SELECT to_jsonb(t) AS j FROM regras_categoria_horario t WHERE configuracao_agenda_id IN (${horarios}) ORDER BY id`),
    disponibilidade: await q(`SELECT to_jsonb(t) AS j FROM regras_disponibilidade_pacote t WHERE configuracao_agenda_id IN (${horarios}) ORDER BY id`),
    descontos: await q(`SELECT to_jsonb(t) AS j FROM regras_desconto_pacote t WHERE configuracao_agenda_id IN (${horarios}) ORDER BY id`),
    auditoria: await q(`SELECT to_jsonb(t) AS j FROM auditoria t WHERE t.dados_depois->>'empresaId' = $1::text ORDER BY id`),
  };
}

async function recusa(promessa: Promise<unknown>, codigoEsperado: string) {
  const r = await resultado(promessa);
  assert.ok(r instanceof Error, `esperava recusa ${codigoEsperado}`);
  assert.equal(codigo(r), codigoEsperado, msg(r));
}

/** Unidade agendável (062) do cenário. */
async function habilitar(c: Cenario) {
  const rep = await representante(a, c);
  await a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Agenda versão')`, [c.empresa, c.unidade, rep.usuarioId]);
  return rep;
}

// ---------------------------------------------------------------------------------------------------------------
// Rota real com a conexão descartável (mesma técnica de lib/saas/hg8-catalogo.postgres.test.ts).
type Ganchos = { primeira?: string; depois?: (sql: string, tx: DbExecutor) => Promise<void>; aoConectar?: (pid: number) => void };
function caminhoTs(base: string) {
  for (const ext of [".ts", ".tsx", "/index.ts"]) if (existsSync(`${base}${ext}`)) return `${base}${ext}`;
  return base;
}
function carregarRota(sessao: Record<string, unknown>, ganchos: Ganchos = {}) {
  const cache = new Map<string, Record<string, unknown>>();
  const postgres = {
    db() { throw new Error("DB_FORA_DA_TRANSACAO"); },
    async withTransaction(fn: (tx: DbExecutor) => Promise<unknown>) {
      const client = await conexao();
      ganchos.aoConectar?.(await pid(client));
      try {
        await client.query("BEGIN");
        if (ganchos.primeira) await client.query(ganchos.primeira);
        const tx: DbExecutor = {
          async query<Row extends object>(sql: string, values?: readonly unknown[]) {
            const r = await client.query(sql, values ? [...values] : []);
            if (ganchos.depois) await ganchos.depois(sql, ex(client));
            return { rows: r.rows as Row[], rowCount: r.rowCount };
          },
        };
        const r = await fn(tx);
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        await client.end();
      }
    },
  };
  function load(file: string): Record<string, unknown> {
    const normal = resolve(file).replaceAll("\\", "/");
    const hit = cache.get(normal);
    if (hit) return hit;
    const exportsObj: Record<string, unknown> = {};
    cache.set(normal, exportsObj);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id: string) => {
      if (id === "zod" || id === "next/server" || (!id.startsWith(".") && !id.startsWith("@/"))) return req(id);
      const base = id.startsWith("@/") ? resolve(raiz, id.slice(2)) : resolve(dirname(file), id);
      const alvo = caminhoTs(base.replace(/\.tsx?$/, ""));
      const chave = resolve(alvo).replaceAll("\\", "/");
      if (chave.endsWith("lib/db/postgres.ts")) return postgres;
      if (chave.endsWith("lib/http/admin-crm-api.ts")) return { exigirApiAdminCrmDisponivel: async () => sessao };
      return load(alvo);
    };
    new Function("require", "exports", code)(localRequire, exportsObj);
    return exportsObj;
  }
  return load(resolve(raiz, "app/api/admin/configuracoes/agenda/route.ts")) as {
    GET: (r: unknown) => Promise<Response>; POST: (r: unknown) => Promise<Response>;
  };
}
const URL_AGENDA = "http://localhost/api/admin/configuracoes/agenda";
const pedidoGet = (params = "") => ({ method: "GET", nextUrl: new URL(`${URL_AGENDA}${params}`), headers: { get: () => null }, cookies: { get: () => undefined } });
const pedidoPost = (corpo: unknown, jsonInvalido = false) => ({
  method: "POST", nextUrl: new URL(URL_AGENDA), headers: { get: () => null }, cookies: { get: () => undefined },
  json: async () => { if (jsonInvalido) throw new SyntaxError("Unexpected token"); return corpo; },
});
async function resposta(r: Response) {
  return { status: r.status, json: await r.json() as { ok: boolean; codigo?: string; erro?: string; data?: Record<string, unknown> } };
}
const sessaoDe = (usuario: string, papel = "ADMINISTRATIVO") => ({ usuario_id: usuario, papel });
/** Corpo do salvar como a tela envia (corpoSalvar), com a versão bruta escolhida. */
function corpoSalvar(entrada: SalvarAgenda, origem: "ASSISTENTE" | "CONFIGURACOES", versaoAgenda?: unknown, comChave = true) {
  const { versaoEsperada: _v, ...resto } = entrada;
  void _v;
  return { acao: "salvar", origem, ...resto, ...(comChave ? { versaoAgenda } : {}) };
}

test.before(async () => {
  a = await conectarDescartavel();
  v098 = await combinadosInstalados(ex(a));
  if (COM_100) {
    assert.equal(v098, false, "a variante com a 100 roda sobre o modelo 097 (098+100 não é estado suportado)");
    // Mesmo critério da suíte da 100: o corpo do conflito identifica 094 (aplicar) ou 100 (já aplicada).
    const hash = async () => (await a.query<{ h: string }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc
      WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')`)).rows[0]?.h;
    const H100 = "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb";
    if ((await hash()) !== H100) await a.query(readFileSync(resolve(raiz, "database/migrations/20261025_100_agenda_um_salao.sql"), "utf8"));
    assert.equal(await hash(), H100, "100 aplicada");
  }
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("ambiente: transação padrão do wrapper em READ COMMITTED (R1-2) e modelo declarado", async () => {
  await a.query("BEGIN");
  const r = await a.query<{ nivel: string }>("SELECT current_setting('transaction_isolation') AS nivel");
  await a.query("ROLLBACK");
  assert.equal(r.rows[0]?.nivel, "read committed");
  const fonte = readFileSync(resolve(raiz, "lib/db/postgres.ts"), "utf8");
  assert.match(fonte, /await client\.query\("BEGIN"\);/, "o wrapper global continua com BEGIN simples");
  console.log(`modelo: ${v098 ? "098" : COM_100 ? "097 + 100" : "097"}`);
});

// ---------------------------------------------------------------------------------------------------------------
// A. Token e projeção

test("T-A1 (PG): mesmo estado, mesma versão em conexões com DateStyle, TimeZone e extra_float_digits diferentes", async () => {
  const c = await cenario(a, 0);
  await agendaPorSalao(c);
  const b = await conexao();
  try {
    await b.query("SET DateStyle = 'SQL, DMY'; SET TimeZone = 'Pacific/Kiritimati'; SET extra_float_digits = 0; SET IntervalStyle = 'sql_standard'");
    const [v1, v2] = [(await ler(c)).versaoAgenda, (await ler(c, null, b)).versaoAgenda];
    assert.match(v1, /^va1:[0-9a-f]{64}$/);
    assert.equal(v2, v1);
    // Data de desativação (to_char) não depende do DateStyle.
    const agenda = await ler(c);
    await emTx(a, () => desativarHorarioAPartirDe(ex(a), contexto(c), agenda.horarios[0]!.id, "2099-12-31"));
    assert.equal((await ler(c, null, b)).versaoAgenda, (await ler(c)).versaoAgenda);
    assert.equal((await ler(c, null, b)).horarios[0]!.desativadoAPartirDe, "2099-12-31");
  } finally {
    await encerrarDescartavel(b, false);
  }
});

/** Oráculos independentes sobre a projeção bruta S0 (R1-2): projeção → versão e DTO editável. */
function projecaoDoBruto(bruto: Record<string, unknown>, empresaId: string, estabelecimentoId: string | null): ProjecaoVersao {
  const proprios = bruto.proprios as LinhaHorarioProjecao[];
  const efetivos = bruto.efetivos as Array<LinhaHorarioProjecao & { nivel: number }>;
  const temProprios = proprios.some((h) => h.ativo && !h.horario_livre);
  const nivel: NivelHeranca = temProprios ? "PROPRIO" : efetivos.length === 0 ? "NENHUM" : efetivos[0]!.nivel === 1 ? "EMPRESA" : "GLOBAL";
  return {
    empresaId, estabelecimentoId, v098, config: bruto.config as ProjecaoVersao["config"], saloes: bruto.saloes as ProjecaoVersao["saloes"], proprios, nivel,
    herdados: temProprios ? [] : efetivos.map(({ nivel: _n, ...h }) => { void _n; return h; }),
    vinculos: bruto.vinculos as ProjecaoVersao["vinculos"],
  };
}
type SalaoBruto = { id: string; nome: string; capacidade_convidados: number | null; ativo: boolean; combinado: boolean | null; membros_info: unknown };
type ConfigBruta = { modo: string; capacidade_tipo: string; limite_festas_dia: number | null; intervalo_minimo_minutos: number };
/**
 * DTO EDITÁVEL inteiro a partir de S0 (P2-1): configuração, salões, combinados e horários com todos os campos que a tela
 * edita/reenvia. Ficam fora só os informativos (festas futuras, quem/quando configurou, nome do escopo).
 */
function editavelDoBruto(bruto: Record<string, unknown>) {
  const c = bruto.config as ConfigBruta | null;
  const saloes = bruto.saloes as SalaoBruto[];
  const proprios = bruto.proprios as LinhaHorarioProjecao[];
  const efetivos = bruto.efetivos as LinhaHorarioProjecao[];
  const vinculos = bruto.vinculos as ProjecaoVersao["vinculos"];
  const temProprios = proprios.some((h) => h.ativo && !h.horario_livre);
  const horario = (h: LinhaHorarioProjecao, herdado: boolean) => ({
    id: h.id, codigo: h.codigo, nome: h.nome, inicio: h.inicio.slice(0, 5), fim: h.fim.slice(0, 5), dias: h.dias_semana ?? TODOS,
    capacidade: herdado ? 1 : h.capacidade, desativadoAPartirDe: h.desativado_a_partir_de, herdado,
    saloes: herdado ? [] : vinculos.filter((v) => v.configuracao_agenda_id === h.id).map((v) => v.salao_id).sort(),
  });
  return {
    config: c && { modo: c.modo, capacidadeTipo: c.capacidade_tipo, limiteFestasDia: c.limite_festas_dia, intervaloMinimoMinutos: c.intervalo_minimo_minutos },
    saloes: saloes.filter((s) => s.ativo && !(v098 && s.combinado)).map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidade_convidados })),
    combinados: v098 ? saloes.filter((s) => s.ativo && s.combinado).map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidade_convidados, membros: s.membros_info })) : [],
    combinadosDisponiveis: v098,
    horarios: temProprios ? proprios.filter((h) => h.ativo && !h.horario_livre).map((h) => horario(h, false)) : efetivos.map((h) => horario(h, true)),
  };
}
const editavel = (agenda: AgendaEscopo) => ({
  config: agenda.config && { modo: agenda.config.modo, capacidadeTipo: agenda.config.capacidadeTipo, limiteFestasDia: agenda.config.limiteFestasDia,
    intervaloMinimoMinutos: agenda.config.intervaloMinimoMinutos },
  saloes: agenda.saloes.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidadeConvidados })),
  combinados: agenda.combinados.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidadeConvidados, membros: s.membros })),
  combinadosDisponiveis: agenda.combinadosDisponiveis ?? false,
  horarios: agenda.horarios.map((h) => ({ id: h.id, codigo: h.codigo, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: h.capacidade,
    desativadoAPartirDe: h.desativadoAPartirDe, herdado: h.herdado, saloes: [...h.saloes].sort() })),
});

test("T-A4: leitura pausada depois da projeção; escritor confirma; DTO editável INTEIRO e versão continuam da MESMA fotografia S0 (cópia congelada)", async () => {
  const c = await cenario(a, 0);
  const inicial = await agendaPorSalao(c);
  const L = await conexao();
  const W = await conexao();
  try {
    const leitor = exComPausa(L, /WITH cfg AS/);
    await L.query("BEGIN");
    const lendo = lerAgendaEscopo(leitor.executor, c.empresa, null);
    await leitor.pausado;
    // Escritor de serviço (sem a guarda) muda configuração, salões e todos os campos do horário, inclusive o vínculo.
    await emTx(W, () => salvarAgendaEscopo(ex(W), {
      ...entradaDe(inicial), limiteFestasDia: 4, intervaloMinimoMinutos: 30,
      saloes: [{ id: inicial.saloes[0]!.id, nome: "S1 novo", capacidadeConvidados: 120 }, { id: inicial.saloes[1]!.id, nome: "S2", capacidadeConvidados: 90 }],
      horarios: [{ id: inicial.horarios[0]!.id, nome: "Tarde nova", inicio: "15:00", fim: "20:00", dias: [5, 6, 7], capacidade: 2, saloes: ["S1 novo", "S2"] }],
    }, contexto(c), "CONFIGURACOES", LIBERADA));
    leitor.liberar();
    const lida = await lendo;
    await L.query("COMMIT");
    const bruto = leitor.estado.bruto!;
    assert.ok(bruto && Object.isFrozen(bruto), "S0 é uma cópia profunda congelada, separada do objeto entregue à implementação");
    assert.equal(lida.versaoAgenda, versaoAgenda(projecaoDoBruto(bruto, c.empresa, null)), "versão = hash(T(S0))");
    assert.deepEqual(editavel(lida), editavelDoBruto(bruto), "DTO editável = DTO(S0)");
    assert.deepEqual(editavel(lida), editavel(inicial), "S0 é literalmente o estado anterior ao escritor");
    const atual = await ler(c);
    assert.notEqual(atual.versaoAgenda, lida.versaoAgenda);
    assert.notDeepEqual(editavel(atual).config, editavel(lida).config, "configuração mudou depois de S0");
    assert.notDeepEqual(editavel(atual).saloes, editavel(lida).saloes, "salões mudaram depois de S0");
    assert.notDeepEqual(editavel(atual).horarios, editavel(lida).horarios, "horário/vínculo mudou depois de S0");
    // A versão de S0 não grava mais.
    await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(lida), contexto(c), "CONFIGURACOES", LIBERADA)), "AGENDA_MUDOU");
  } finally {
    await encerrarDescartavel(L, false);
    await encerrarDescartavel(W, false);
  }
});

test("T-A5 + O-2: DTO inteiro igual ao leitor de origin/staging (a590d247) nos estados da agenda", async () => {
  const comparar = async (rotulo: string, c: Cenario, unidade: string | null = null) => {
    const nova = await ler(c, unidade);
    const { versaoAgenda: _v, ...semVersao } = nova;
    void _v;
    const ref = await lerAgendaReferencia(ex(a), c.empresa, unidade, nova.escopo);
    // A ordem dos salões de cada horário não era definida pela consulta antiga (sem ORDER BY): compara como conjunto.
    const normal = (x: Omit<AgendaEscopo, "versaoAgenda">) => ({ ...x, horarios: x.horarios.map((h) => ({ ...h, saloes: [...h.saloes].sort() })) });
    assert.deepEqual(normal(semVersao), normal(ref), rotulo);
  };
  const c = await cenario(a, 0);
  await comparar("sem configuração: herdados globais", c);
  await agendaUmSalao(c);
  await comparar("um salão", c);
  const d = await cenario(a, 0);
  const porSalao = await agendaPorSalao(d);
  await comparar("por salão com vínculos", d);
  // Horário inativo + dias NULL + capacidade NULL por SQL direto; desativação datada.
  await a.query(`UPDATE configuracao_agenda SET dias_semana = NULL WHERE id = $1::uuid`, [porSalao.horarios[0]!.id]);
  await a.query(`UPDATE agenda_saloes SET capacidade_convidados = NULL WHERE id = $1::uuid`, [porSalao.saloes[1]!.id]);
  await emTx(a, () => desativarHorarioAPartirDe(ex(a), contexto(d), porSalao.horarios[0]!.id, "2099-12-31"));
  await comparar("dias NULL, capacidade NULL, desativação datada", d);
  const comInativo = await ler(d);
  await emTx(a, () => salvarAgendaEscopo(ex(a), {
    ...entradaDe(comInativo), horarios: [...entradaDe(comInativo).horarios, { nome: "Noite", inicio: "20:00", fim: "23:00", dias: [5, 6], capacidade: 1, saloes: ["S2"] }],
  }, contexto(d), "CONFIGURACOES", LIBERADA));
  const comNoite = await ler(d);
  await emTx(a, () => salvarAgendaEscopo(ex(a), { ...entradaDe(comNoite), horarios: entradaDe(comNoite).horarios.filter((h) => h.nome !== "Noite") }, contexto(d), "CONFIGURACOES", LIBERADA));
  await comparar("horário removido (inativo)", d);
  const livre = await ler(d);
  await emTx(a, () => salvarAgendaEscopo(ex(a), { ...entradaDe(livre), modo: "LIVRE" }, contexto(d), "CONFIGURACOES", LIBERADA));
  await comparar("modo livre (horário técnico fora da lista)", d);
  // Unidade herdando da empresa (horários da empresa por SQL: com unidade agendável, a empresa não é escopo do app).
  const e = await cenario(a, 1);
  await habilitar(e);
  await comparar("unidade herdando os globais", e, e.unidade);
  await a.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                   ordem_exibicao, empresa_id, dias_semana) VALUES ('TURNO_1', 'Da empresa', '10:00', '14:00', 30, 30, 1, $1::uuid, '{6,7}')`, [e.empresa]);
  await comparar("unidade herdando a empresa", e, e.unidade);
  if (v098) {
    const f = await cenario(a, 0);
    const agenda = await agendaPorSalao(f);
    const { criarSalaoCombinado } = await import("./configuracao-unidade.ts");
    await emTx(a, () => criarSalaoCombinado(ex(a), contexto(f), { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 180, membros: agenda.saloes.map((s) => s.id) }));
    await comparar("098: combinado com membros e elegibilidade", f);
  }
});

test("T-A5: herdados da projeção = listarConfiguracoesAgendaAtivas nos níveis", async () => {
  const { listarConfiguracoesAgendaAtivas } = await import("../disponibilidade/repositories/disponibilidade.repository.ts");
  const e = await cenario(a, 1);
  await habilitar(e);
  const conferir = async (rotulo: string, unidade: string | null, nivelEsperado: string) => {
    const agenda = await ler(e, unidade);
    const lista = await listarConfiguracoesAgendaAtivas(ex(a), { empresaId: e.empresa, estabelecimentoId: unidade });
    if (nivelEsperado === "PROPRIO") assert.ok(agenda.horarios.every((h) => !h.herdado), rotulo);
    else assert.deepEqual(agenda.horarios.map((h) => [h.id, h.herdado]), lista.map((h) => [h.id, true]), rotulo);
  };
  await conferir("unidade sem próprios nem empresa: globais", e.unidade, "GLOBAL");
  await a.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_1', 'Empresa', '10:00', '14:00', 1, $1::uuid)`, [e.empresa]);
  await conferir("unidade sem próprios: empresa", e.unidade, "EMPRESA");
  await a.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id, estabelecimento_id) VALUES ('TURNO_1', 'Unidade', '10:00', '14:00', 1, $1::uuid, $2::uuid)`, [e.empresa, e.unidade]);
  await conferir("unidade com próprios", e.unidade, "PROPRIO");
});

// ---------------------------------------------------------------------------------------------------------------
// B. Save e concorrência (serviços reais; sem guarda à frente quando o alvo é o advisory)

async function duasAbas(c: Cenario, mudarPrimeira: (ag: AgendaEscopo) => SalvarAgenda, mudarSegunda: (ag: AgendaEscopo) => SalvarAgenda, opcoes: { maisDeUmSalaoLiberada?: boolean } = LIBERADA) {
  const aba = await ler(c);
  await emTx(a, () => salvarAgendaEscopo(ex(a), mudarPrimeira(aba), contexto(c), "CONFIGURACOES", opcoes));
  const depoisDoVencedor = await fotografia(c);
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), mudarSegunda(aba), contexto(c), "CONFIGURACOES", opcoes)), "AGENDA_MUDOU");
  assert.deepEqual(await fotografia(c), depoisDoVencedor, "nada gravado pela aba desatualizada (fotografia após o vencedor = após a recusa)");
}

test("T-B1: duas abas alterando só um horário — a segunda recebe AGENDA_MUDOU e nada grava", async () => {
  const c = await cenario(a, 0);
  await agendaUmSalao(c);
  await duasAbas(c,
    (ag) => entradaDe(ag, { horarios: entradaDe(ag).horarios.map((h, i) => (i === 0 ? { ...h, nome: "Manhã cedo" } : h)) }),
    (ag) => entradaDe(ag, { horarios: entradaDe(ag).horarios.map((h, i) => (i === 1 ? { ...h, inicio: "14:00" } : h)) }), {});
});

test("T-B2: duas abas alterando só um vínculo — a segunda recebe AGENDA_MUDOU", async () => {
  const c = await cenario(a, 0);
  await agendaPorSalao(c);
  await duasAbas(c,
    (ag) => entradaDe(ag, { horarios: entradaDe(ag).horarios.map((h) => ({ ...h, saloes: ["S1", "S2"], capacidade: 2 })) }),
    (ag) => entradaDe(ag, { horarios: entradaDe(ag).horarios.map((h) => ({ ...h, saloes: ["S2"] })) }));
});

test("T-B3: só tolerância ou passo (herdado e próprio, por SQL direto) dão AGENDA_MUDOU; com a versão certa, o horário leva o valor da projeção", async () => {
  // Herdado (global): o assistente lê; a tolerância do modelo muda por SQL (simulando migration); o save é recusado.
  const c = await cenario(a, 0);
  const lida = await ler(c);
  const herdado = lida.horarios.find((h) => h.herdado)!;
  const antes = (await a.query<{ t: number; p: number }>(`SELECT tolerancia_inicio_minutos t, passo_inicio_minutos p FROM configuracao_agenda WHERE id = $1::uuid`, [herdado.id])).rows[0]!;
  const novoPasso = [15, 30, 60, 10, 5].find((p) => p !== antes.p && antes.t % p === 0)!;
  const assistente = () => entradaDe(lida, { horarios: [{ id: herdado.id, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: TODOS, capacidade: 1, saloes: [] }] });
  try {
    await a.query(`UPDATE configuracao_agenda SET tolerancia_inicio_minutos = $2 WHERE id = $1::uuid`, [herdado.id, antes.t + antes.p]);
    await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), assistente(), contexto(c), "ASSISTENTE")), "AGENDA_MUDOU");
    await a.query(`UPDATE configuracao_agenda SET tolerancia_inicio_minutos = $2, passo_inicio_minutos = $3 WHERE id = $1::uuid`, [herdado.id, antes.t, novoPasso]);
    await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), assistente(), contexto(c), "ASSISTENTE")), "AGENDA_MUDOU");
    // Versão certa (releitura): o horário criado leva tolerância/passo da projeção conferida.
    const relida = await ler(c);
    const agenda = await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(relida, { horarios: [{ id: herdado.id, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: TODOS, capacidade: 1, saloes: [] }] }), contexto(c), "ASSISTENTE"));
    const criado = (await a.query<{ t: number; p: number }>(`SELECT tolerancia_inicio_minutos t, passo_inicio_minutos p FROM configuracao_agenda WHERE id = $1::uuid`, [agenda.horarios[0]!.id])).rows[0]!;
    assert.deepEqual(criado, { t: antes.t, p: novoPasso });
  } finally {
    await a.query(`UPDATE configuracao_agenda SET tolerancia_inicio_minutos = $2, passo_inicio_minutos = $3 WHERE id = $1::uuid`, [herdado.id, antes.t, antes.p]);
  }
  // Próprio: tolerância alterada por SQL entre o GET e o save.
  const d = await cenario(a, 0);
  const propria = await agendaUmSalao(d);
  await a.query(`UPDATE configuracao_agenda SET passo_inicio_minutos = 60 WHERE id = $1::uuid`, [propria.horarios[0]!.id]);
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(propria), contexto(d), "CONFIGURACOES")), "AGENDA_MUDOU");
});

test("T-B4: lista antiga omitindo salão ou horário criado depois — AGENDA_MUDOU e o criado continua ativo", async () => {
  const c = await cenario(a, 0);
  const aba = await agendaPorSalao(c);
  const outra = await ler(c);
  await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(outra, { saloes: [...entradaDe(outra).saloes, { nome: "S3", capacidadeConvidados: null }] }), contexto(c), "CONFIGURACOES", LIBERADA));
  const depois = await fotografia(c);
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(aba, { intervaloMinimoMinutos: 30 }), contexto(c), "CONFIGURACOES", LIBERADA)), "AGENDA_MUDOU");
  assert.deepEqual(await fotografia(c), depois);
  assert.equal((await a.query(`SELECT 1 FROM agenda_saloes WHERE empresa_id = $1::uuid AND nome = 'S3' AND ativo`, [c.empresa])).rowCount, 1);
  const d = await cenario(a, 0);
  const abaD = await agendaUmSalao(d, [["Tarde", "15:00", "19:00"]]);
  const outraD = await ler(d);
  await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(outraD, { horarios: [...entradaDe(outraD).horarios, { nome: "Noite", inicio: "20:00", fim: "23:00", dias: TODOS, capacidade: 1, saloes: [] }] }), contexto(d), "CONFIGURACOES"));
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(abaD), contexto(d), "CONFIGURACOES")), "AGENDA_MUDOU");
  assert.equal((await a.query(`SELECT 1 FROM configuracao_agenda WHERE empresa_id = $1::uuid AND nome = 'Noite' AND ativo`, [d.empresa])).rowCount, 1);
});

test("T-B5: herança — unidade com globais passa a herdar da empresa; modelo global alterado; o assistente recebe AGENDA_MUDOU", async () => {
  const e = await cenario(a, 1);
  await habilitar(e);
  const lida = await ler(e, e.unidade);
  assert.ok(lida.horarios.length > 0 && lida.horarios.every((h) => h.herdado));
  // Horário da empresa criado por SQL (com unidade agendável a empresa não é escopo do app; simula a origem da herança).
  await a.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_1', 'Empresa', '10:00', '14:00', 1, $1::uuid)`, [e.empresa]);
  const entrada = entradaDe(lida, { horarios: [{ id: lida.horarios[0]!.id, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: TODOS, capacidade: 1, saloes: [] }] });
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entrada, contexto(e), "ASSISTENTE")), "AGENDA_MUDOU");
  // Empresa sem unidade, herdando os globais: modelo global alterado por SQL.
  const c = await cenario(a, 0);
  const global = await ler(c);
  const alvo = global.horarios.find((h) => h.herdado)!;
  const nome = (await a.query<{ n: string }>(`SELECT nome n FROM configuracao_agenda WHERE id = $1::uuid`, [alvo.id])).rows[0]!.n;
  try {
    await a.query(`UPDATE configuracao_agenda SET nome = nome || ' (novo)' WHERE id = $1::uuid`, [alvo.id]);
    await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(global, { horarios: [{ id: alvo.id, nome: "X", inicio: "11:00", fim: "15:00", dias: TODOS, capacidade: 1, saloes: [] }] }), contexto(c), "ASSISTENTE")), "AGENDA_MUDOU");
  } finally {
    await a.query(`UPDATE configuracao_agenda SET nome = $2 WHERE id = $1::uuid`, [alvo.id, nome]);
  }
});

/** Save pausado DEPOIS da comparação (no corte), segurando o advisory. */
function salvarPausado(c: Client, entrada: SalvarAgenda, contextoSave: ReturnType<typeof contexto>, opcoes: object = {}) {
  let liberar!: () => void;
  let pausou!: () => void;
  const solto = new Promise<void>((fim) => { liberar = fim; });
  const pausado = new Promise<void>((fim) => { pausou = fim; });
  const fim = (async () => {
    await c.query("BEGIN");
    try {
      const r = await salvarAgendaEscopo(ex(c), entrada, contextoSave, "CONFIGURACOES", {
        ...opcoes,
        lerCorte: async (tx: DbExecutor) => { pausou(); await solto; return (await tx.query<{ d: string }>("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")).rows[0]!.d; },
      });
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  })();
  return { pausado, liberar, fim };
}

test("T-B6: cancelamento datado concorrente — muda a versão; cancelar e salvar se serializam no ADVISORY nas duas ordens; desativar primeiro também", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c);
  const h = agenda.horarios[0]!.id;
  // Aba aberta; outra desativa: o save da aba recebe AGENDA_MUDOU; cancelar também muda a versão.
  await emTx(a, () => desativarHorarioAPartirDe(ex(a), contexto(c), h, "2099-12-31"));
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(agenda), contexto(c), "CONFIGURACOES")), "AGENDA_MUDOU");
  const comDesativacao = await ler(c);
  await emTx(a, () => cancelarDesativacao(ex(a), contexto(c), h));
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(comDesativacao), contexto(c), "CONFIGURACOES")), "AGENDA_MUDOU");
  await emTx(a, () => desativarHorarioAPartirDe(ex(a), contexto(c), h, "2099-12-31"));
  const X = await conexao();
  const Y = await conexao();
  const [pX, pY] = [await pid(X), await pid(Y)];
  try {
    // 1) SAVE primeiro: pausado depois da comparação, segura o advisory; o cancelamento espera NO ADVISORY.
    const save = salvarPausado(X, entradaDe(await ler(c), { intervaloMinimoMinutos: 30 }), contexto(c));
    await save.pausado;
    await Y.query("BEGIN");
    const cancelando = resultado(cancelarDesativacao(ex(Y), contexto(c), h));
    assert.equal(await esperaObservada(pY, pX, ["advisory"]), "advisory");
    save.liberar();
    await save.fim;
    assert.equal(await cancelando, undefined);
    await Y.query("COMMIT");
    // 2) CANCELAR primeiro: segura o advisory (sem commit); o save com a versão anterior espera e recebe AGENDA_MUDOU.
    await emTx(a, () => desativarHorarioAPartirDe(ex(a), contexto(c), h, "2099-12-31"));
    const vistaAntesDoCancelamento = await ler(c);
    await Y.query("BEGIN");
    await cancelarDesativacao(ex(Y), contexto(c), h);
    await X.query("BEGIN");
    const salvandoDepois = resultado(salvarAgendaEscopo(ex(X), entradaDe(vistaAntesDoCancelamento, { intervaloMinimoMinutos: 90 }), contexto(c), "CONFIGURACOES"));
    assert.equal(await esperaObservada(pX, pY, ["advisory"]), "advisory");
    await Y.query("COMMIT");
    const r2 = await salvandoDepois;
    await X.query("ROLLBACK");
    assert.equal(codigo(r2), "AGENDA_MUDOU", msg(r2));
    // 3) DESATIVAR primeiro: idem.
    const vista = await ler(c);
    await Y.query("BEGIN");
    await desativarHorarioAPartirDe(ex(Y), contexto(c), h, "2099-12-30");
    await X.query("BEGIN");
    const salvando = resultado(salvarAgendaEscopo(ex(X), entradaDe(vista, { intervaloMinimoMinutos: 60 }), contexto(c), "CONFIGURACOES"));
    assert.equal(await esperaObservada(pX, pY, ["advisory"]), "advisory");
    await Y.query("COMMIT");
    const r = await salvando;
    await X.query("ROLLBACK");
    assert.equal(codigo(r), "AGENDA_MUDOU", msg(r));
  } finally {
    await encerrarDescartavel(X, false);
    await encerrarDescartavel(Y, false);
  }
});

/** Festa confirmada (dia +30) no horário e, com a 098, no salão: os gatilhos diferidos conferem a agenda no COMMIT. */
async function festaConfirmada(c: Cenario, cfg: string, inicio: string, fim: string, salao: string | null = null) {
  return emTx(a, async () => {
    const f = (await a.query<{ id: string }>(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status${salao ? ", salao_id" : ""})
        SELECT CURRENT_DATE + 30, $1::time, $2::time, $3::uuid, $4::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO'${salao ? ", $6::uuid" : ""} FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $5::uuid RETURNING fechamentos.id::text AS id`,
    [inicio, fim, cfg, c.empresa, c.pacote, ...(salao ? [salao] : [])])).rows[0]!.id;
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    return f;
  });
}

test("T-B8: 409 sem nenhuma escrita e com precedência sobre as recusas de estado (festas, tipo bloqueado; com a 098, combinado repetido e salão com festas)", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c);
  const h = agenda.horarios[0]!;
  // Festa futura no horário: mudar início daria HORARIO_COM_FESTAS.
  await festaConfirmada(c, h.id, "09:00", "12:00");
  const comFesta = await ler(c);
  const mudarInicio = (ag: AgendaEscopo) => entradaDe(ag, { horarios: entradaDe(ag).horarios.map((x, i) => (i === 0 ? { ...x, inicio: "08:00" } : x)) });
  const porSalaoBloqueado = (ag: AgendaEscopo) => entradaDe(ag, { capacidadeTipo: "POR_SALAO", saloes: [{ nome: "S1", capacidadeConvidados: null }],
    horarios: entradaDe(ag).horarios.map((x) => ({ ...x, saloes: ["S1"] })) });
  // Controle: com a versão certa, as recusas de estado aparecem.
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), mudarInicio(comFesta), contexto(c), "CONFIGURACOES")), "HORARIO_COM_FESTAS");
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), porSalaoBloqueado(comFesta), contexto(c), "CONFIGURACOES")), "DADOS_INVALIDOS");
  // Uma festa não muda a versão (não é conteúdo sobrescrito pelo save).
  assert.equal(comFesta.versaoAgenda, agenda.versaoAgenda);
  // Versão desatualizada de verdade: outra aba muda o limite; a aba antiga (comFesta) recebe AGENDA_MUDOU antes das recusas de estado.
  await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(comFesta, { limiteFestasDia: 5 }), contexto(c), "CONFIGURACOES"));
  const antes = await fotografia(c);
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), mudarInicio(comFesta), contexto(c), "CONFIGURACOES")), "AGENDA_MUDOU");
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), porSalaoBloqueado(comFesta), contexto(c), "CONFIGURACOES")), "AGENDA_MUDOU");
  assert.deepEqual(await fotografia(c), antes);
  if (!v098) return;
  // 098: combinado com nome repetido (validação antes do DML) e salão com festa omitido (SALAO_COM_FESTAS, no laço).
  const d = await cenario(a, 0);
  const porSalao = await agendaPorSalao(d);
  const { criarSalaoCombinado } = await import("./configuracao-unidade.ts");
  await emTx(a, () => criarSalaoCombinado(ex(a), contexto(d), { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 180, membros: porSalao.saloes.map((s) => s.id) }));
  await festaConfirmada(d, porSalao.horarios[0]!.id, "15:00", "19:00", porSalao.saloes[0]!.id);
  const vista = await ler(d);
  const repetido = (ag: AgendaEscopo) => entradaDe(ag, { saloes: [...entradaDe(ag).saloes, { nome: "Salão inteiro", capacidadeConvidados: null }] });
  const semS1 = (ag: AgendaEscopo) => entradaDe(ag, { saloes: entradaDe(ag).saloes.filter((s) => s.nome !== "S1"),
    horarios: entradaDe(ag).horarios.map((x) => ({ ...x, saloes: ["S2"] })) });
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), repetido(vista), contexto(d), "CONFIGURACOES", LIBERADA)), "DADOS_INVALIDOS");
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), semS1(vista), contexto(d), "CONFIGURACOES", LIBERADA)), "SALAO_COM_FESTAS");
  await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(vista, { limiteFestasDia: 6 }), contexto(d), "CONFIGURACOES", LIBERADA));
  const antesD = await fotografia(d);
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), repetido(vista), contexto(d), "CONFIGURACOES", LIBERADA)), "AGENDA_MUDOU");
  await recusa(emTx(a, () => salvarAgendaEscopo(ex(a), semS1(vista), contexto(d), "CONFIGURACOES", LIBERADA)), "AGENDA_MUDOU");
  assert.deepEqual(await fotografia(d), antesD);
});

test("T-B9: comparação DEPOIS do advisory — o segundo save com a mesma versão espera no advisory e recebe AGENDA_MUDOU", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c);
  const X = await conexao();
  const Y = await conexao();
  const [pX, pY] = [await pid(X), await pid(Y)];
  try {
    const save = salvarPausado(X, entradaDe(agenda, { intervaloMinimoMinutos: 30 }), contexto(c));
    await save.pausado;
    await Y.query("BEGIN");
    const segundo = resultado(salvarAgendaEscopo(ex(Y), entradaDe(agenda, { intervaloMinimoMinutos: 90 }), contexto(c), "CONFIGURACOES"));
    assert.equal(await esperaObservada(pY, pX, ["advisory"]), "advisory");
    save.liberar();
    await save.fim;
    const depoisDoVencedor = await fotografia(c);
    const r = await segundo;
    await Y.query("ROLLBACK");
    assert.ok(r instanceof Error, "o segundo save gravou por cima (sem 409)");
    assert.equal(codigo(r), "AGENDA_MUDOU", msg(r));
    assert.deepEqual(await fotografia(c), depoisDoVencedor);
    assert.equal((await ler(c)).config?.intervaloMinimoMinutos, 30, "o vencedor fica; nada sobrescrito");
  } finally {
    await encerrarDescartavel(X, false);
    await encerrarDescartavel(Y, false);
  }
});

test("T-B11: sucesso devolve a versão nova, igual à leitura seguinte; auditoria com a versão antes e depois", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c);
  const salvo = await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(agenda, { limiteFestasDia: 3 }), contexto(c), "CONFIGURACOES"));
  assert.notEqual(salvo.versaoAgenda, agenda.versaoAgenda);
  assert.equal((await ler(c)).versaoAgenda, salvo.versaoAgenda);
  const aud = (await a.query<{ antes: Record<string, unknown>; depois: Record<string, unknown> }>(
    `SELECT dados_antes antes, dados_depois depois FROM auditoria WHERE dados_depois->>'empresaId' = $1 AND acao = 'AGENDA_ATUALIZADA' ORDER BY id DESC LIMIT 1`, [c.empresa])).rows[0]!;
  assert.equal(aud.antes.versaoAgenda, agenda.versaoAgenda);
  assert.equal(aud.depois.versaoAgenda, salvo.versaoAgenda);
  // No-op reproduz a versão (versão de conteúdo, não contador).
  const noop = await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(salvo), contexto(c), "CONFIGURACOES"));
  assert.equal(noop.versaoAgenda, salvo.versaoAgenda);
});

// ---------------------------------------------------------------------------------------------------------------
// C. Regras copiadas — decisão (b)

async function regraDosTres(horario: string, pacote: string, inicio: string, fim: string | null) {
  await a.query(`UPDATE regras_categoria_horario SET ativo = false WHERE configuracao_agenda_id = $1::uuid`, [horario]);
  await a.query(`INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio, vigencia_fim, ativo) VALUES (6, $1::uuid, 'NOBRE', $2::date, $3::date, true)`, [horario, inicio, fim]);
  await a.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim, ativo) VALUES ($1::uuid, 6, $2::uuid, 'DISPONIVEL', $3::date, $4::date, true)`, [pacote, horario, inicio, fim]);
  await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, vigencia_fim, ativo)
                 VALUES ($1::uuid, 6, $2::uuid, 10, 'PACOTE', $3, 'Desconto teste', 1, $4::date, $5::date, true)`, [pacote, horario, `D${randomUUID().slice(0, 8)}`, inicio, fim]);
}
const copiadas = async (horario: string) => ({
  categoria: (await a.query(`SELECT categoria_horario c, to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_categoria_horario WHERE configuracao_agenda_id = $1::uuid AND dia_semana = 6 AND ativo ORDER BY vigencia_inicio`, [horario])).rows,
  disponibilidade: (await a.query(`SELECT to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_disponibilidade_pacote WHERE configuracao_agenda_id = $1::uuid AND ativo ORDER BY vigencia_inicio`, [horario])).rows,
  desconto: (await a.query(`SELECT to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_desconto_pacote WHERE configuracao_agenda_id = $1::uuid AND ativo ORDER BY vigencia_inicio`, [horario])).rows,
});
const hojeMais = async (dias: number) => (await a.query<{ d: string }>(`SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') d`, [dias])).rows[0]!.d;

test("T-C1/T-C4: regra de cada família alterada entre o GET e o save do assistente NÃO dá 409; copia o estado atual; origem intacta", async () => {
  // Empresa herdando da empresa-modelo própria (unidade): regras na origem (horário da empresa, por SQL).
  const e = await cenario(a, 1);
  await habilitar(e);
  const origem = (await a.query<{ id: string }>(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_1', 'Empresa', '10:00', '14:00', 1, $1::uuid) RETURNING id::text`, [e.empresa])).rows[0]!.id;
  const lida = await ler(e, e.unidade);
  assert.equal(lida.horarios[0]!.id, origem);
  // Depois do GET: as três famílias mudam na origem (escritor de pacotes, fora do advisory).
  const [inicio, fim] = [await hojeMais(-3), await hojeMais(40)];
  await regraDosTres(origem, e.pacote, inicio, fim);
  const antesOrigem = await copiadas(origem);
  const agenda = await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(lida, { horarios: [{ id: origem, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: [6], capacidade: 1, saloes: [] }] }), contexto(e), "ASSISTENTE"));
  const hoje = await hojeMais(0);
  const novo = agenda.horarios[0]!.id;
  assert.deepEqual(await copiadas(novo), {
    categoria: [{ c: "NOBRE", i: hoje, f: fim }], disponibilidade: [{ i: hoje, f: fim }], desconto: [{ i: hoje, f: fim }],
  }, "copiado o estado atual (vigente no corte), início no corte");
  assert.deepEqual(await copiadas(origem), antesOrigem, "origem intacta");
});

test("T-C2: horário livre criado sintetiza as três famílias do estado atual (regras mudadas depois do GET, sem 409)", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c, [["Tarde", "15:00", "19:00"]]);
  const h = agenda.horarios[0]!.id;
  const vista = await ler(c);
  const fim = await hojeMais(20);
  await regraDosTres(h, c.pacote, await hojeMais(-1), fim);
  await emTx(a, () => salvarAgendaEscopo(ex(a), entradaDe(vista, { modo: "LIVRE" }), contexto(c), "CONFIGURACOES"));
  const livre = (await a.query<{ id: string }>(`SELECT id::text FROM configuracao_agenda WHERE empresa_id = $1::uuid AND horario_livre AND ativo`, [c.empresa])).rows[0]!.id;
  const r = await copiadas(livre);
  const hoje = await hojeMais(0);
  assert.deepEqual(r.disponibilidade, [{ i: hoje, f: fim }]);
  assert.deepEqual(r.desconto, [{ i: hoje, f: fim }]);
  assert.deepEqual(r.categoria[0], { c: "NOBRE", i: hoje, f: fim });
});

/**
 * Regras por dia em torno do corte, nas TRÊS famílias, sem sobreposição de vigência (gatilhos da 006):
 * dia 6 termina na véspera do corte (fica fora); dia 7 começa antes e termina no corte (entra, com início no corte);
 * dia 5 começa depois do corte (início preservado).
 */
async function regrasEmTornoDoCorte(horario: string, pacote: string, corte: string, futuro: string) {
  const vespera = (await a.query<{ d: string }>(`SELECT to_char($1::date - 1, 'YYYY-MM-DD') d`, [corte])).rows[0]!.d;
  await a.query(`UPDATE regras_categoria_horario SET ativo = false WHERE configuracao_agenda_id = $1::uuid`, [horario]);
  const linhas: Array<[number, string, string | null]> = [[6, "2020-01-01", vespera], [7, "2020-01-01", corte], [5, futuro, null]];
  for (const [dia, inicio, fim] of linhas) {
    await a.query(`INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio, vigencia_fim, ativo) VALUES ($1, $2::uuid, 'NOBRE', GREATEST($3::date, CURRENT_DATE - 2), $4::date, true)`, [dia, horario, inicio, fim]);
    await a.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim, ativo) VALUES ($1::uuid, $2, $3::uuid, 'DISPONIVEL', GREATEST($4::date, CURRENT_DATE - 2), $5::date, true)`, [pacote, dia, horario, inicio, fim]);
    await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, vigencia_fim, ativo)
                   VALUES ($1::uuid, $2, $3::uuid, 10, 'PACOTE', $4, 'Desconto corte', 1, GREATEST($5::date, CURRENT_DATE - 2), $6::date, true)`, [pacote, dia, horario, `C${dia}`, inicio, fim]);
  }
}
const regrasPorDia = async (horario: string) => ({
  categoria: (await a.query(`SELECT dia_semana d, categoria_horario c, to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_categoria_horario WHERE configuracao_agenda_id = $1::uuid AND ativo ORDER BY dia_semana, vigencia_inicio`, [horario])).rows,
  disponibilidade: (await a.query(`SELECT dia_semana d, to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_disponibilidade_pacote WHERE configuracao_agenda_id = $1::uuid AND ativo ORDER BY dia_semana, vigencia_inicio`, [horario])).rows,
  desconto: (await a.query(`SELECT dia_semana d, codigo, to_char(vigencia_inicio,'YYYY-MM-DD') i, to_char(vigencia_fim,'YYYY-MM-DD') f FROM regras_desconto_pacote WHERE configuracao_agenda_id = $1::uuid AND ativo ORDER BY dia_semana, vigencia_inicio`, [horario])).rows,
});
/** Espião: ordem dos passos e parâmetros de TODA inserção nas três famílias (P2-2). */
function espiao(cliente: Client) {
  const eventos: string[] = [];
  const insercoes: Array<{ sql: string; params: unknown[] }> = [];
  const executor: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      if (/pg_advisory_xact_lock/.test(text)) eventos.push("advisory");
      if (/WITH cfg AS/.test(text)) eventos.push("projecao");
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(text)) eventos.push("dml");
      if (/^\s*INSERT INTO regras_(categoria_horario|disponibilidade_pacote|desconto_pacote)/.test(text)) insercoes.push({ sql: text, params: [...(values ?? [])] });
      const r = await cliente.query(text, values as unknown[]);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  };
  return { executor, eventos, insercoes };
}
const familia = (sql: string) => /regras_categoria_horario/.test(sql.split("(")[0]!) ? "categoria" : /regras_disponibilidade_pacote/.test(sql.split("(")[0]!) ? "disponibilidade" : "desconto";

test("T-C3: corte injetado (≠ data do início da transação) em TODAS as cópias do assistente — três famílias e PADRAO; véspera fora, corte entra, futuro preservado", async () => {
  const e = await cenario(a, 1);
  await habilitar(e);
  const origem = (await a.query<{ id: string }>(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_1', 'Empresa', '10:00', '14:00', 1, $1::uuid) RETURNING id::text`, [e.empresa])).rows[0]!.id;
  const [corte, futuro] = [await hojeMais(5), await hojeMais(9)];
  await regrasEmTornoDoCorte(origem, e.pacote, corte, futuro);
  const lida = await ler(e, e.unidade);
  const spy = espiao(a);
  const agenda = await emTx(a, () => salvarAgendaEscopo(spy.executor, entradaDe(lida, { horarios: [{ id: origem, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: [5, 6, 7], capacidade: 1, saloes: [] }] }), contexto(e), "ASSISTENTE", {
    lerCorte: async () => { spy.eventos.push("corte"); return corte; },
  }));
  assert.equal(spy.eventos.filter((x) => x === "corte").length, 1, "uma leitura do corte");
  const pos = (x: string) => spy.eventos.indexOf(x);
  assert.ok(pos("advisory") < pos("projecao") && pos("projecao") < pos("corte") && pos("corte") < pos("dml"), spy.eventos.join(" → "));
  // Parâmetros: as três cópias (INSERT … SELECT) e o PADRAO levam o corte; nenhuma usa CURRENT_DATE.
  assert.equal(spy.insercoes.length, 4, spy.insercoes.map((i) => i.sql.slice(0, 60)).join(" | "));
  for (const i of spy.insercoes) {
    assert.ok(i.params.includes(corte), `${familia(i.sql)} recebeu o corte`);
    assert.doesNotMatch(i.sql, /CURRENT_DATE/, `${familia(i.sql)} sem CURRENT_DATE`);
  }
  assert.deepEqual(spy.insercoes.map((i) => familia(i.sql)).sort(), ["categoria", "categoria", "desconto", "disponibilidade"]);
  const r = await regrasPorDia(agenda.horarios[0]!.id);
  assert.deepEqual(r.categoria, [{ d: 5, c: "NOBRE", i: futuro, f: null }, { d: 6, c: "PADRAO", i: corte, f: null }, { d: 7, c: "NOBRE", i: corte, f: corte }],
    "categoria: futuro preservado, véspera fora (dia 6 recebe o PADRAO no corte), corte entra com início no corte");
  assert.deepEqual(r.disponibilidade, [{ d: 5, i: futuro, f: null }, { d: 7, i: corte, f: corte }]);
  assert.deepEqual(r.desconto, [{ d: 5, codigo: "C5", i: futuro, f: null }, { d: 7, codigo: "C7", i: corte, f: corte }]);
});

test("T-C3: corte injetado na CRIAÇÃO do horário livre — três famílias sintetizadas a partir do corte (nenhuma linha antes dele)", async () => {
  const c = await cenario(a, 0);
  const agenda = await agendaUmSalao(c, [["Tarde", "15:00", "19:00"]]);
  const fixo = agenda.horarios[0]!.id;
  const [corte, futuro] = [await hojeMais(5), await hojeMais(9)];
  await regrasEmTornoDoCorte(fixo, c.pacote, corte, futuro);
  const vista = await ler(c);
  const spy = espiao(a);
  await emTx(a, () => salvarAgendaEscopo(spy.executor, entradaDe(vista, { modo: "LIVRE" }), contexto(c), "CONFIGURACOES", { lerCorte: async () => corte }));
  const livre = (await a.query<{ id: string }>(`SELECT id::text FROM configuracao_agenda WHERE empresa_id = $1::uuid AND horario_livre AND ativo`, [c.empresa])).rows[0]!.id;
  const r = await regrasPorDia(livre);
  assert.deepEqual(r.disponibilidade, [{ d: 5, i: futuro, f: null }, { d: 7, i: corte, f: corte }], "véspera fora, corte entra, futuro preservado");
  assert.deepEqual(r.desconto, [{ d: 5, codigo: "C5", i: futuro, f: null }, { d: 7, codigo: "C7", i: corte, f: corte }]);
  assert.ok(r.categoria.length > 0 && r.categoria.every((x) => String(x.i) >= corte), "nenhuma categoria do livre começa antes do corte");
  assert.equal(r.categoria.map((x) => String(x.i)).sort()[0], corte, "a linha do tempo da categoria começa no corte");
  assert.ok(r.categoria.some((x) => x.d === 7 && x.c === "NOBRE" && x.i === corte && x.f === corte), "dia 7 NOBRE no corte");
  assert.ok(r.categoria.some((x) => x.d === 5 && x.c === "NOBRE" && x.i === futuro), "dia 5 NOBRE a partir do futuro");
  assert.ok(!r.categoria.some((x) => x.d === 6 && x.c === "NOBRE"), "dia 6 (véspera) não vira NOBRE");
  // Parâmetros de todas as sínteses do livre: nenhuma vigência antes do corte.
  const sinteses = spy.insercoes.filter((i) => /'Horário livre por dia da semana \(093\)'/.test(i.sql));
  assert.ok(sinteses.length > 0);
  for (const i of sinteses) {
    const datas = i.params.filter((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p)) as string[];
    assert.ok(datas.length > 0 && datas.every((d) => d >= corte), `${familia(i.sql)}: ${datas.join(",")} ≥ ${corte}`);
  }
});

test("T-C3: leitor PADRÃO do corte usa o relógio, não o início da transação (meia-noite local simulada por fuso POSIX no meio da transação)", async () => {
  const e = await cenario(a, 1);
  await habilitar(e);
  const origem = (await a.query<{ id: string }>(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_1', 'Empresa', '10:00', '14:00', 1, $1::uuid) RETURNING id::text`, [e.empresa])).rows[0]!.id;
  await a.query(`UPDATE regras_categoria_horario SET ativo = false WHERE configuracao_agenda_id = $1::uuid`, [origem]);
  await a.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, ativo) VALUES ($1::uuid, 6, $2::uuid, 'DISPONIVEL', CURRENT_DATE - 30, true)`, [e.pacote, origem]);
  const lida = await ler(e, e.unidade);
  const Z = await conexao();
  try {
    await Z.query("BEGIN");
    // Fuso fixo em MINUTOS inteiros (o PostgreSQL recusa POSIX com segundos: "appears to use leap seconds") com a meia-noite
    // local no primeiro minuto cheio ≥ 2 s depois do início da transação; POSIX: sinal invertido (local = UTC − deslocamento).
    const t0 = Number((await Z.query<{ s: string }>(`SELECT extract(epoch FROM transaction_timestamp())::text AS s`)).rows[0]!.s);
    const meiaNoiteUtc = Math.ceil((t0 + 2) / 60) * 60;
    let local = ((-meiaNoiteUtc % 86400) + 86400) % 86400;
    if (local > 43200) local -= 86400;
    const posix = -local;
    const abs = Math.abs(posix);
    const tz = `XYZ${posix < 0 ? "-" : "+"}${String(Math.floor(abs / 3600)).padStart(2, "0")}:${String(Math.floor(abs / 60) % 60).padStart(2, "0")}`;
    await Z.query(`SET LOCAL TIME ZONE '${tz}'`);
    for (let i = 0; i < 800; i++) {
      const virou = (await Z.query<{ ok: boolean }>(`SELECT (clock_timestamp() AT TIME ZONE current_setting('TimeZone'))::date > CURRENT_DATE AS ok`)).rows[0]!.ok;
      if (virou) break;
      await new Promise((fim) => setTimeout(fim, 100));
    }
    const datas = (await Z.query<{ inicio: string; amanha: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') inicio, to_char(CURRENT_DATE + 1, 'YYYY-MM-DD') amanha`)).rows[0]!;
    const { lerCorteDaAgenda } = await import("./configuracao-unidade.ts");
    const corte = await lerCorteDaAgenda(ex(Z));
    assert.equal(corte, datas.amanha, `relógio já no dia seguinte (${tz}); o início da transação continua em ${datas.inicio}`);
    // Transporte de ponta a ponta com o leitor padrão (sem injeção): a cópia começa no dia do relógio.
    const agenda = await salvarAgendaEscopo(ex(Z), entradaDe(lida, { horarios: [{ id: origem, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: [6], capacidade: 1, saloes: [] }] }), contexto(e), "ASSISTENTE");
    const copia = (await Z.query<{ i: string }>(`SELECT to_char(vigencia_inicio, 'YYYY-MM-DD') i FROM regras_disponibilidade_pacote WHERE configuracao_agenda_id = $1::uuid`, [agenda.horarios[0]!.id])).rows;
    assert.deepEqual(copia, [{ i: datas.amanha }]);
    await Z.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(Z, false);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Rota real: janelas do assistente, versões malformadas e GET pela guarda de tenant

async function sessaoAtiva(c: Cenario, usuario: string) {
  const s = (await a.query<{ id: string }>(`SELECT id::text FROM sessoes_administrativas WHERE usuario_id = $1::uuid AND revogado_em IS NULL ORDER BY criado_em DESC LIMIT 1`, [usuario])).rows[0];
  const id = s?.id ?? (await a.query<{ id: string }>(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours') RETURNING id::text`,
  [usuario, randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")])).rows[0]!.id;
  await a.query(`UPDATE sessoes_administrativas SET empresa_ativa_id = $2::uuid WHERE id = $1::uuid`, [id, c.empresa]);
  return { usuario_id: usuario, papel: "ADMINISTRATIVO", id, empresa_ativa_id: c.empresa };
}

test("T-B7 janela 1 (rota real, dois POSTs normais): sem Gestão → 403; com Gestão → AGENDA_MUDOU (antes sobrescrevia em silêncio)", async () => {
  const c = await cenario(a, 0);
  const rep = await representante(a, c);
  const outro = await representante(a, c);
  await a.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [outro.membershipId]);
  const vista = await ler(c);
  const corpo = corpoSalvar(entradaDe(vista, { horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }), "ASSISTENTE", vista.versaoAgenda);
  const primeiro = await resposta(await carregarRota(sessaoDe(c.usuario)).POST(pedidoPost(corpo)));
  assert.equal(primeiro.status, 201, JSON.stringify(primeiro.json));
  const depois = await fotografia(c);
  const semGestao = await resposta(await carregarRota(sessaoDe(outro.usuarioId)).POST(pedidoPost({ ...corpo, horarios: [{ ...corpo.horarios[0]!, nome: "Outro" }] })));
  assert.deepEqual([semGestao.status, semGestao.json.codigo], [403, "PAPEL_NAO_AUTORIZADO"]);
  const comGestao = await resposta(await carregarRota(sessaoDe(rep.usuarioId)).POST(pedidoPost({ ...corpo, horarios: [{ ...corpo.horarios[0]!, nome: "Outro" }] })));
  assert.deepEqual([comGestao.status, comGestao.json.codigo], [409, "AGENDA_MUDOU"]);
  assert.deepEqual(await fotografia(c), depois, "nenhuma gravação da segunda");
});

/** Injeção da janela 2 (declarada): a configuração nasce DENTRO da transação da rota, logo depois de escopoJaConfigurado. */
const injetarConfiguracao = (c: Cenario, usuario: string): Ganchos => {
  let feito = false;
  return {
    depois: async (sql, tx) => {
      if (feito || !/SELECT EXISTS \(SELECT 1 FROM agenda_escopo_config/.test(sql)) return;
      feito = true;
      await tx.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                      VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 60, $2::uuid)`, [c.empresa, usuario]);
    },
  };
};

test("T-B7 janela 2 (injeção de interleaving defensivo): AGENDA_JA_CONFIGURADA, nunca edição sem Gestão", async () => {
  const c = await cenario(a, 0);
  const rep = await representante(a, c);
  const vista = await ler(c);
  const corpo = corpoSalvar(entradaDe(vista, { horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }), "ASSISTENTE", vista.versaoAgenda);
  const antes = await fotografia(c);
  const r = await resposta(await carregarRota(sessaoDe(c.usuario), injetarConfiguracao(c, rep.usuarioId)).POST(pedidoPost(corpo)));
  assert.deepEqual([r.status, r.json.codigo], [409, "AGENDA_JA_CONFIGURADA"], "janela 2: AGENDA_JA_CONFIGURADA vence");
  assert.deepEqual(await fotografia(c), antes, "a transação inteira voltou (inclusive a configuração injetada)");
});

test("T-B10 (rota real): versão ausente/null/tipo errado/vazia/longa/hex inválido/maiúsculas/va0 → 409 AGENDA_MUDOU sem escrita; JSON e campos inválidos → 400", async () => {
  const c = await cenario(a, 0);
  const rep = await representante(a, c);
  const agenda = await agendaUmSalao(c);
  const rota = carregarRota(sessaoDe(rep.usuarioId));
  const entrada = entradaDe(agenda, { intervaloMinimoMinutos: 30 });
  const antes = await fotografia(c);
  const valores: Array<[string, unknown, boolean]> = [
    ["ausente", undefined, false], ["null", null, true], ["número", 1, true], ["objeto", { v: agenda.versaoAgenda }, true], ["array", [agenda.versaoAgenda], true],
    ["vazia", "", true], ["longa", "x".repeat(81), true], ["hex inválido", `va1:${"g".repeat(64)}`, true], ["maiúsculas", agenda.versaoAgenda.toUpperCase(), true],
    ["prefixo antigo", agenda.versaoAgenda.replace("va1:", "va0:"), true], ["booleano", true, true],
  ];
  for (const [rotulo, valor, comChave] of valores) {
    const r = await resposta(await rota.POST(pedidoPost(corpoSalvar(entrada, "CONFIGURACOES", valor, comChave))));
    assert.deepEqual([r.status, r.json.codigo], [409, "AGENDA_MUDOU"], rotulo);
  }
  assert.deepEqual(await fotografia(c), antes, "nada gravado");
  // Controles: JSON inválido e outro campo inválido continuam 400; a versão certa grava.
  assert.equal((await resposta(await rota.POST(pedidoPost(null, true)))).status, 400);
  const campo = await resposta(await rota.POST(pedidoPost({ ...corpoSalvar(entrada, "CONFIGURACOES", agenda.versaoAgenda), intervaloMinimoMinutos: 999 })));
  assert.deepEqual([campo.status, campo.json.codigo], [400, "DADOS_INVALIDOS"]);
  const ok = await resposta(await rota.POST(pedidoPost(corpoSalvar(entrada, "CONFIGURACOES", agenda.versaoAgenda))));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((ok.json.data as { versaoAgenda?: string }).versaoAgenda, (await ler(c)).versaoAgenda);
  // Precedência: assistente na janela 2 (injeção) com versão inválida → AGENDA_JA_CONFIGURADA.
  const d = await cenario(a, 0);
  const vista = await ler(d);
  const corpo = corpoSalvar(entradaDe(vista, { horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }), "ASSISTENTE", "lixo");
  const r = await resposta(await carregarRota(sessaoDe(d.usuario), injetarConfiguracao(d, d.usuario)).POST(pedidoPost(corpo)));
  assert.deepEqual([r.status, r.json.codigo], [409, "AGENDA_JA_CONFIGURADA"]);
});

test("T-D1/T-D3 (rota real): GET devolve a versão (com e sem Gestão); outra empresa e membership revogada recusam", async () => {
  const c = await cenario(a, 0);
  const rep = await representante(a, c);
  await agendaUmSalao(c);
  const atual = (await ler(c)).versaoAgenda;
  for (const usuario of [c.usuario, rep.usuarioId]) {
    const r = await resposta(await carregarRota(sessaoDe(usuario)).GET(pedidoGet()));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json.data!.agenda as { versaoAgenda: string }).versaoAgenda, atual);
  }
  const b = await cenario(a, 0);
  const alheio = await resposta(await carregarRota(sessaoDe(b.usuario)).GET(pedidoGet(`?empresaId=${c.empresa}`)));
  assert.equal(alheio.status, 403);
  await a.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [rep.membershipId]);
  assert.equal((await resposta(await carregarRota(sessaoDe(rep.usuarioId)).GET(pedidoGet()))).status, 403);
});

/**
 * P3-1: reproduz o PROTOCOLO CRÍTICO da troca de empresa (empresa-ativa.ts:16–17: provarTenant trava o usuário sem UPDATE e a
 * sessão antiga é revogada), não a função selecionarEmpresaAtiva inteira (consulta/rotação/criação de sessão e auditoria).
 * O GET usa a rota e a guarda reais; só a autenticação de entrada e o provedor da conexão são dublados.
 */
test("T-D1: protocolo crítico da troca de empresa concorrente — o GET espera NA LINHA do usuário e recusa a sessão revogada; mutante RR antes da prova a aceita", async () => {
  for (const mutanteRR of [false, true]) {
    const c = await cenario(a, 0);
    await agendaUmSalao(c);
    const sessao = await sessaoAtiva(c, c.usuario);
    const X = await conexao();
    try {
      // "Troca de empresa" (empresa-ativa.ts:16–17): prova de tenant (trava o usuário, sem UPDATE) e revoga a sessão antiga.
      await X.query("BEGIN");
      await provarTenant(ex(X), { usuario_id: c.usuario, papel: "ADMINISTRATIVO" }, c.empresa);
      await X.query(`UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE id = $1::uuid`, [sessao.id]);
      let pidGet = 0;
      const rota = carregarRota(sessao, { aoConectar: (p) => { pidGet = p; }, primeira: mutanteRR ? "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ" : undefined });
      const lendo = rota.GET(pedidoGet());
      for (let i = 0; i < 200 && !pidGet; i++) await new Promise((fim) => setTimeout(fim, 10));
      const evento = await esperaObservada(pidGet, await pid(X), ["tuple", "transactionid"]);
      assert.ok(["tuple", "transactionid"].includes(evento));
      await X.query("COMMIT");
      const r = await resposta(await lendo);
      if (mutanteRR) assert.equal(r.status, 200, "mutante RR antes da prova: a sessão revogada foi aceita (regressão demonstrada)");
      else assert.deepEqual([r.status, r.json.codigo], [403, "TENANT_NAO_COMPROVADO"]);
    } finally {
      await encerrarDescartavel(X, false);
    }
  }
});

test("T-D2: o GET não altera o agregado nem as regras; só chama leitores", async () => {
  const c = await cenario(a, 0);
  await agendaUmSalao(c);
  const antes = await fotografia(c);
  assert.equal((await resposta(await carregarRota(sessaoDe(c.usuario)).GET(pedidoGet()))).status, 200);
  assert.deepEqual(await fotografia(c), antes);
  const fonte = readFileSync(resolve(raiz, "app/api/admin/configuracoes/agenda/route.ts"), "utf8");
  const get = fonte.slice(fonte.indexOf("export async function GET"), fonte.indexOf("export async function POST"));
  for (const escritor of ["salvarAgendaEscopo", "desativarHorarioAPartirDe", "cancelarDesativacao", "criarSalaoCombinado", "desativarSalao"]) {
    assert.doesNotMatch(get, new RegExp(escritor), escritor);
  }
  assert.match(get, /withTenantTransaction\(/, "GET continua na guarda de tenant");
});
