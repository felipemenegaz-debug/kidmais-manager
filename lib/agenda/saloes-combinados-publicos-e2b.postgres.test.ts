import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { catalogoNativo, catalogoNoTurno, cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { normalizarWebp } from "../imagens/normalizar-webp.ts";
import { adicionarFoto, confirmarDeclaracao, salvarApresentacao, type CamposInformados } from "./salao-apresentacao.ts";
import { fotoPublica, listarSaloesPublicos, nomeDoSalaoPublico, SalaoPublicoIndisponivel, saloesProntosPublicos } from "./salao-publico.ts";
import { estadoCombinados } from "./estado-combinados.ts";
import { combinadosPublicos } from "./combinados-publicos.ts";
import { decidirPreferencia } from "./preferencia-salao.ts";
import { desativarSalao } from "./configuracao-unidade.ts";
import { escolherSalaoParaEmissao } from "./salao-festa.ts";
import { adquirirLockConfirmacaoAgenda } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { carregarComBanco, executor, porTransacao } from "../marketing/harness-postgres.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";

/**
 * E2b (plano técnico rev. 2.1, D-E2b-1..5) no PostgreSQL DESCARTÁVEL, modelo 107 (a 108 é aplicada aqui):
 *   * combinações de flag × estado: só SALOES_PUBLICOS, as duas flags com AUSENTE e com NOVA — só o último publica;
 *     desligado, a lista é a da E2a (sem combinado e sem os campos novos);
 *   * mínimo de 2 SIMPLES prontos (D-E2b-2): um simples + um combinado prontos = etapa fora do ar;
 *   * papéis: simples livre recomendado; simples ocupado = combinado livre como alternativa, sem recomendado; nenhum
 *     simples comporta = combinado recomendado;
 *   * universo (D-E2b-4): combinado sem pacote da oferta pública que o sirva some da lista;
 *   * POST real: (a) combinado aceito grava a preferência; (b) acima da capacidade = 409 com motivo; (c) membro ocupado
 *     = 409 OCUPADO_OU_LIMITE; (d) helper desligado = 409 da E2a sem voltarParaSaloes; R2-P2-1: só um simples pronto =
 *     recusa genérica mesmo com o combinado servindo; e, com AB ocupado, recusa com motivo e zero efeitos;
 *   * concorrência (P2-C2 da revisão de código): matriz com os serviços reais e três conexões — desativação → confirmação
 *     (espera na compartilhada, INELEGIVEL), confirmação → desativação (espera a exclusiva até o COMMIT; emissão
 *     PREFERIDO_NAO_SERVE), confirmação → reserva de A e reserva de A → confirmação (trava da data), DELETE direto de AB
 *     (espera de linha, não de configuração); chave e modo conferidos em pg_locks;
 *   * lacunas da revisão de código: PARCIAL com as flags, HORARIO_NAO_PERMITE/PACOTE_NAO_PERMITE/ABAIXO_DO_MINIMO, unidade
 *     concreta × NULL e outra empresa (genérica), antecipação ACEITA = erro original, contagens inalteradas em todas as tabelas;
 *   * recuperação: flag desligada de novo = lista da E2a.
 * Não roda no CI (precisa do cluster descartável autorizado).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
let a: Client;
let tx: DbExecutor;
const SO_E2A = { SALOES_PUBLICOS: "true" };
const LIGADO = { SALOES_PUBLICOS: "true", SALOES_COMBINADOS_PUBLICOS: "true" };
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: crypto.randomUUID() });
const escopo = (c: Cenario) => ({ empresaId: c.empresa, estabelecimentoId: null });
const consulta = (data: string, cfg: string, convidados: number) => ({ data, configuracaoId: cfg, inicio: "15:00", fim: "19:00", convidados });

async function emTransacao<T>(fn: () => Promise<T>, db: Client = a): Promise<T> {
  await db.query("BEGIN");
  try { const r = await fn(); await db.query("COMMIT"); return r; } catch (e) { await db.query("ROLLBACK"); throw e; }
}
async function imagem() {
  const cor = { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! };
  return normalizarWebp(await sharp({ create: { width: 40, height: 30, channels: 3, background: cor } }).png().toBuffer());
}
/** Deixa um salão (simples ou combinado) PRONTO pelos serviços reais da 102: campos, 6 fotos, mês e declaração. */
const camposDe = (nome: string, extra: Partial<CamposInformados> = {}): CamposInformados => ({ convidadosMinimo: null, convidadosSentados: null, areaM2: 100,
  idadeMin: 3, idadeMax: 10, frase: `Salão ${nome}`, outraFestaSimultanea: true, exclusivos: ["ENTRADA"], fotosReferencia: "2026-09", ...extra });
const versaoDe = async (s: string) => (await a.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [s])).rows[0]!.v;
async function publicar(c: Cenario, s: string, nome: string) {
  let r = await emTransacao(async () => salvarApresentacao(tx, ctx(c), s, await versaoDe(s), camposDe(nome), []));
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
}
/** `prefixo` fixa o 1º caractere do id (ordem dos ids ≠ ordem do cadastro, sem depender do acaso). */
async function simples(c: Cenario, nome: string, capacidade: number, ordem: number, pronto = true, prefixo?: string) {
  const s = await id(a, `INSERT INTO agenda_saloes (id, empresa_id, nome, capacidade_convidados, ordem) VALUES ($5::uuid, $1::uuid, $2, $3, $4) RETURNING id`,
    [c.empresa, nome, capacidade, ordem, prefixo ? prefixo + crypto.randomUUID().slice(1) : crypto.randomUUID()]);
  if (pronto) await publicar(c, s, nome);
  return s;
}
async function combinado(c: Cenario, nome: string, capacidade: number, ordem: number, membros: string[]) {
  const s = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem, combinado, membros) VALUES ($1::uuid, $2, $3, $4, true, $5::uuid[]) RETURNING id`,
    [c.empresa, nome, capacidade, ordem, [...membros].sort()]);
  await publicar(c, s, nome);
  return s;
}
/** Buffet POR_SALAO com horário 15–19 e catálogo cotável (pacote COMPLETA, faixa 1+). */
async function buffet(codigo: string) {
  const c = await cenario(a, 0);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($2, 'Tarde', '15:00', '19:00', 0, 30, 1, $1::uuid, 1) RETURNING id`, [c.empresa, codigo]);
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, tarde);
  return { c, tarde };
}
/** Festa confirmada no salão (ocupação), na transação já aberta de `db`. */
async function ocuparNaTransacao(db: Client, c: Cenario, data: string, cfg: string, salao: string) {
  const f = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 40, 40, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, cfg, c.empresa, c.pacote, salao]);
  await db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
}
const ocupar = (c: Cenario, data: string, cfg: string, salao: string) => emTransacao(() => ocuparNaTransacao(a, c, data, cfg, salao));

/** Chave advisory de 64 bits como o pg_locks a mostra (classid = 32 bits altos, objid = 32 baixos, objsubid = 1). */
const MESMA_CHAVE = `l.locktype = 'advisory' AND l.objsubid = 1 AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($3, 0)`;
/**
 * Espera observada em pg_locks (P2-C2): `esperando` aguarda (granted = false) a trava advisory da `chave` no `modoEspera`,
 * `segurando` tem a MESMA chave concedida no `modoSegura` e está entre os bloqueadores de `esperando`. Tenant, FK ou trava
 * de linha não satisfazem esta espera.
 */
async function esperaAdvisory(obs: Client, esperando: number, segurando: number, chave: string,
  modoEspera: "ShareLock" | "ExclusiveLock", modoSegura: "ShareLock" | "ExclusiveLock") {
  for (let i = 0; i < 400; i++) {
    const r = await obs.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = $1 AND NOT l.granted AND l.mode = $4 AND ${MESMA_CHAVE})
          AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = $2 AND l.granted AND l.mode = $5 AND ${MESMA_CHAVE})
          AND $2 = ANY (pg_blocking_pids($1)) AS ok`, [esperando, segurando, chave, modoEspera, modoSegura]);
    if (r.rows[0]!.ok) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  const vistos = await obs.query(`SELECT pid, locktype, mode, granted FROM pg_locks WHERE pid IN ($1, $2) AND locktype <> 'virtualxid'`, [esperando, segurando]);
  assert.fail(`espera advisory não observada (${chave}: ${esperando} ${modoEspera} × ${segurando} ${modoSegura}): ${JSON.stringify(vistos.rows)}`);
}
/** Espera observada que NÃO é advisory (linha/transação): `esperando` bloqueado por `segurando` sem trava advisory pendente. */
async function esperaSemAdvisory(obs: Client, esperando: number, segurando: number) {
  for (let i = 0; i < 400; i++) {
    const r = await obs.query<{ ok: boolean }>(
      `SELECT $2 = ANY (pg_blocking_pids($1))
          AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = $1 AND NOT l.granted AND l.locktype = 'advisory') AS ok`, [esperando, segurando]);
    if (r.rows[0]!.ok) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail(`espera de linha não observada: ${esperando} por ${segurando}`);
}
/** Promessa que roda em paralelo: a rejeição fica tratada desde já; quem der await depois ainda recebe o erro. */
function emFundo<T>(p: Promise<T>): Promise<T> { p.catch(() => undefined); return p; }
const pid = async (cl: Client) => (await cl.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p;
async function tresConexoes<T>(corpo: (b: Client, obs: Client) => Promise<T>) {
  const b = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try { return await corpo(b, obs); } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(obs, false);
  }
}
/**
 * withTransaction real na conexão `a` (BEGIN → trabalho → COMMIT). Armada, PARA antes do COMMIT da transação do envio
 * (a que segura alguma trava advisory: configuração e/ou data), com todas as travas ainda tomadas; `liberar` segue para
 * o COMMIT. A condição não exige a compartilhada de propósito: um mutante que a solte antes do COMMIT ainda para aqui e
 * morre pela espera ausente, não por pausa que nunca chega.
 */
function transacaoPausavel() {
  let pausa: { chegou: () => void; seguir: Promise<void> } | null = null;
  let soltarPendente: (() => void) | null = null;
  const withTransaction = async <T>(trabalho: (t: DbExecutor) => Promise<T>): Promise<T> => {
    await a.query("BEGIN");
    try {
      const r = await trabalho(executor(a));
      const segura = (await a.query<{ s: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
        AND granted) AS s`)).rows[0]!.s;
      if (pausa && segura) { const p = pausa; pausa = null; p.chegou(); await p.seguir; }
      await a.query("COMMIT");
      return r;
    } catch (e) { await a.query("ROLLBACK"); throw e; }
  };
  const armar = () => {
    let chegou!: () => void, liberar!: () => void;
    // A chegada falha com mensagem própria em 30 s (nunca pendura a suíte).
    const chegada = Promise.race([new Promise<void>((r) => { chegou = r; }),
      new Promise<void>((_, falhar) => setTimeout(() => falhar(new Error("a transação do envio não chegou à pausa")), 30_000).unref())]);
    const seguir = new Promise<void>((r) => { liberar = r; });
    pausa = { chegou, seguir };
    soltarPendente = liberar;
    return { chegada, liberar };
  };
  /** Solta qualquer pausa (no finally do teste): a transação do envio segue para o COMMIT/ROLLBACK. */
  const soltar = () => { pausa = null; soltarPendente?.(); soltarPendente = null; };
  return { withTransaction, armar, soltar };
}
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0]! + 1) % 10;
  const dv = (n: number[]) => { const soma = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return soma < 2 ? 0 : 11 - soma; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}

type ComTransacao = <T>(trabalho: (t: DbExecutor) => Promise<T>) => Promise<T>;
const extrasDasRotas = (c: Cenario, withTransaction: ComTransacao = porTransacao(a)) => ({
  "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
  "http/limite-publico": { limitarPublico: async () => null },
  "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-e2b",
    escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
  "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }),
    escopoPublico: async () => ({ empresaId: c.empresa, estabelecimentoId: null }) },
  "db/postgres": { db: () => executor(a), withTransaction },
});
/** GET /api/disponibilidade e POST /api/fechamentos/cotacao reais, com o banco descartável. */
function rotasPublicas(c: Cenario) {
  type Rota = Record<string, (r: unknown) => Promise<{ status: number; body: Record<string, unknown> }>>;
  const cache = new Map();
  const carregar = (arquivo: string) => carregarComBanco(arquivo, a, () => null, extrasDasRotas(c), cache) as unknown as Rota;
  const disp = carregar("app/api/disponibilidade/route.ts");
  const cot = carregar("app/api/fechamentos/cotacao/route.ts");
  const url = (caminho: string) => `http://localhost${caminho}`;
  return {
    disponibilidade: (consulta: string) => disp.GET({ url: url(`/api/disponibilidade${consulta}`), nextUrl: new URL(url(`/api/disponibilidade${consulta}`)) }),
    cotacao: (corpo: unknown) => cot.POST({ url: url("/api/fechamentos/cotacao"), nextUrl: new URL(url("/api/fechamentos/cotacao")), json: async () => corpo, headers: new Headers() }),
  };
}

/** Rota POST /api/fechamentos real, com o banco descartável e as flags do processo pedidas. */
function rotaFechamentos(c: Cenario, tarde: string, withTransaction?: ComTransacao) {
  const rota = carregarComBanco("app/api/fechamentos/route.ts", a, () => null, extrasDasRotas(c, withTransaction), new Map()) as unknown as {
    POST: (r: unknown) => Promise<{ status: number; body: { codigo?: string; detalhes?: { motivo?: string; voltarParaSaloes?: boolean } } }> };
  return (data: string, convidados: number, salaoPreferido: string, fim = "19:00") => rota.POST({ url: "http://localhost/api/fechamentos", nextUrl: new URL("http://localhost/api/fechamentos"),
    headers: new Headers(), json: async () => ({
      pacote: "completa", dataFesta: data, configuracaoId: tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: fim,
      identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel", convidadosPagantes: convidados, buffetDefinicao: "depois", adicionaisSelecionados: [],
      valorCombinado: "100,00", formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético E2b", cpf: cpfValido(), email: `e2b-${randomBytes(3).toString("hex")}@buffet.test`,
      whatsapp: "11988880003", telefone: "1133330003", cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF",
      nomeAniversariante: "Aniversariante E2b", idadeAniversariante: 6, salaoPreferido,
    }) });
}
async function comFlags<T>(flags: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const nomes = ["SALOES_PUBLICOS", "SALOES_COMBINADOS_PUBLICOS"];
  const antes = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
  for (const n of nomes) { if (flags[n] === undefined) delete process.env[n]; else process.env[n] = flags[n]; }
  try { return await fn(); } finally {
    for (const n of nomes) { if (antes[n] === undefined) delete process.env[n]; else process.env[n] = antes[n]; }
  }
}

test.before(async () => { a = await conectarDescartavel(); tx = executor(a); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("E2b: flags × estado (AUSENTE → NOVA), mínimo de 2 simples, papéis, universo e recuperação", async () => {
  assert.equal((await estadoCombinados(tx)).estado, "AUSENTE", "modelo 107: sem a 108");
  assert.equal(await combinadosPublicos(tx, LIGADO), false, "AUSENTE: as duas flags não bastam");
  await a.query(arquivo("database/checks/20261028_108_precheck.sql"));
  await a.query(arquivo("database/migrations/20261028_108_saloes_combinados.sql"));
  await a.query(arquivo("database/checks/20261028_108_postcheck.sql"));
  assert.equal(await combinadosPublicos(tx, SO_E2A), false, "só SALOES_PUBLICOS");
  assert.equal(await combinadosPublicos(tx, { SALOES_COMBINADOS_PUBLICOS: "true" }), false, "só SALOES_COMBINADOS_PUBLICOS");
  assert.equal(await combinadosPublicos(tx, LIGADO), true, "NOVA + as duas flags");

  const { c, tarde } = await buffet("TARDE_E2B");
  // Ids em ordem oposta ao cadastro (A = f…, B = 0…): os nomes dos membros têm de seguir o cadastro.
  const A = await simples(c, "A", 60, 1, true, "f");
  const B = await simples(c, "B", 60, 2, false, "0");
  const AB = await combinado(c, "A+B", 120, 3, [A, B]);
  const D = dia(80);
  // D-E2b-2: um simples + um combinado prontos não abrem a etapa.
  await assert.rejects(saloesProntosPublicos(tx, escopo(c), LIGADO), SalaoPublicoIndisponivel);
  await assert.rejects(listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), LIGADO), SalaoPublicoIndisponivel);
  await publicar(c, B, "B");
  // C comporta 100 (para o caso 2 ele está OCUPADO, não "não comporta": a capacidade vem antes da ocupação).
  const C = await simples(c, "C", 100, 4);

  // Desligado (só a E2a): sem combinado e sem os campos novos.
  const e2a = await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), SO_E2A);
  assert.deepEqual(e2a.saloes.map((s) => s.id), [A, B, C]);
  for (const s of e2a.saloes) assert.deepEqual([s.combinado, s.papel, s.precoAPartirDe], [undefined, undefined, undefined], "DTO da E2a");
  // Foto e nome públicos do combinado: só com o helper (desligado, como na E2a: não publicado).
  const fotoAB = (await a.query<{ id: string }>(`SELECT id::text FROM agenda_salao_fotos WHERE salao_id = $1::uuid AND removida_em IS NULL LIMIT 1`, [AB])).rows[0]!.id;
  await assert.rejects(fotoPublica(tx, escopo(c), AB, fotoAB, SO_E2A), SalaoPublicoIndisponivel);
  assert.equal(await nomeDoSalaoPublico(tx, escopo(c), AB, SO_E2A), null);
  assert.ok((await fotoPublica(tx, escopo(c), AB, fotoAB, LIGADO)).sha256);
  assert.equal(await nomeDoSalaoPublico(tx, escopo(c), AB, LIGADO), "A+B");

  // Caso 1: simples livre recomendado; o combinado aparece sem papel.
  const r1 = await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), LIGADO);
  assert.deepEqual(r1.saloes.map((s) => s.id), [A, B, AB, C], "na ordem do cadastro (AB = 3, C = 4)");
  assert.equal(r1.recomendado?.id, A);
  const ab1 = r1.saloes.find((s) => s.id === AB)!;
  assert.deepEqual(ab1.combinado, { membros: ["A", "B"] });
  assert.equal(ab1.papel, null);
  assert.ok(ab1.precoAPartirDe === null || /^\d+\.\d{2}$/.test(ab1.precoAPartirDe!), "preço do pacote, nunca A+B");
  assert.notEqual(ab1.precoAPartirDe, "0.00");
  assert.equal(ab1.convivencia, "C pode receber outra festa no mesmo horário.");

  // Caso 3: nenhum simples comporta 110 e nenhum está ocupado → combinado recomendado.
  const r3 = await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 110), LIGADO);
  assert.equal(r3.recomendado?.id, AB);
  assert.equal(r3.saloes.find((s) => s.id === AB)!.papel, "recomendado");

  // Caso 2: C ocupado (não é membro) → AB livre vira alternativa e ninguém é recomendado.
  const D2 = dia(81);
  await ocupar(c, D2, tarde, C);
  const r2 = await listarSaloesPublicos(tx, escopo(c), consulta(D2, tarde, 100), LIGADO);
  assert.equal(r2.recomendado, null);
  assert.equal(r2.saloes.find((s) => s.id === AB)!.papel, "alternativa");
  assert.equal(r2.saloes.find((s) => s.id === C)!.situacao, "ocupado");

  // Membro ocupado → o combinado fica ocupado (conjuntos), nunca alternativa.
  const D3 = dia(82);
  await ocupar(c, D3, tarde, A);
  const r4 = await listarSaloesPublicos(tx, escopo(c), consulta(D3, tarde, 40), LIGADO);
  assert.equal(r4.saloes.find((s) => s.id === AB)!.situacao, "ocupado");
  assert.equal(r4.recomendado?.id, B);

  // D-E2b-4: o pacote da oferta passa a servir só os simples → combinado sem universo some.
  await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid), ($1::uuid, $4::uuid)`, [c.pacote, A, B, C]);
  assert.deepEqual((await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), LIGADO)).saloes.map((s) => s.id), [A, B, C], "sem universo");
  await a.query(`DELETE FROM pacote_saloes WHERE pacote_id = $1::uuid`, [c.pacote]);
  // Universo pela faixa do pacote: com teto de 100 convidados, nenhum pacote comporta 110 → o combinado some.
  await a.query(`UPDATE pacotes SET convidados_maximos = 100 WHERE id = $1::uuid`, [c.pacote]);
  assert.deepEqual((await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 110), LIGADO)).saloes.map((s) => s.id), [A, B, C], "pacote não comporta");
  await a.query(`UPDATE pacotes SET convidados_maximos = NULL WHERE id = $1::uuid`, [c.pacote]);
  // Membro inativo (B, sem festa futura): o combinado deixa de ser elegível e some da lista; desfeito no ROLLBACK.
  await a.query("BEGIN");
  try {
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [B]);
    assert.deepEqual((await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), LIGADO)).saloes.map((s) => s.id), [A, C], "membro inativo");
    // Foto e nome dependem só do filtro de elegibilidade (a lista também passa pela regra de capacidade).
    await assert.rejects(fotoPublica(tx, escopo(c), AB, fotoAB, LIGADO), SalaoPublicoIndisponivel);
    assert.equal(await nomeDoSalaoPublico(tx, escopo(c), AB, LIGADO), null);
  } finally { await a.query("ROLLBACK"); }
  assert.deepEqual((await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), LIGADO)).saloes.map((s) => s.id), [A, B, AB, C]);

  // Recuperação: desligada a segunda flag, volta a lista da E2a.
  assert.deepEqual((await listarSaloesPublicos(tx, escopo(c), consulta(D, tarde, 40), SO_E2A)).saloes.map((s) => s.id), [A, B, C]);
});

test("E2b: POST real — aceita o combinado; recusa com motivo; E2a sem marcador; mínimo de 2 simples (R2-P2-1)", async () => {
  assert.equal((await estadoCombinados(tx)).estado, "NOVA", "a 108 do teste anterior");
  const { c, tarde } = await buffet("TARDE_E2B_POST");
  const A = await simples(c, "A", 60, 1);
  const B = await simples(c, "B", 60, 2);
  const AB = await combinado(c, "A+B", 120, 3, [A, B]);
  const enviar = rotaFechamentos(c, tarde);
  const contagem = async () => Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0]!.n);

  // D-E2b-5 nas rotas públicas reais: com 100 convidados só o AB comporta. Ligado, a disponibilidade conta a opção e a
  // cotação passa da revalidação; desligado (E2a), nenhuma opção e SEM_SALAO_PARA_CONVIDADOS.
  const rotas = rotasPublicas(c);
  const d0 = dia(189);
  const leitura = async () => ((await rotas.disponibilidade(`?data=${d0}&convidados=100`)).body.data as { periodos: Array<{ configuracaoId: string;
    horarios: Array<{ inicio: string; capacidade?: { opcoes: number } }> }> }).periodos.find((p) => p.configuracaoId === tarde)!.horarios.find((h) => h.inicio === "15:00")!.capacidade;
  const cotar = () => rotas.cotacao({ pacote: "completa", dataFesta: d0, configuracaoId: tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00", convidados: 100 });
  await comFlags(LIGADO, async () => {
    assert.equal((await leitura())?.opcoes, 1);
    const cotacao = await cotar();
    assert.equal(cotacao.status, 200, JSON.stringify(cotacao.body));
  });
  await comFlags(SO_E2A, async () => {
    assert.equal((await leitura())?.opcoes, 0);
    const recusa = await cotar();
    assert.deepEqual([recusa.status, recusa.body.codigo], [409, "SEM_SALAO_PARA_CONVIDADOS"]);
  });

  await comFlags(LIGADO, async () => {
    // (a) aceita: grava a preferência sem ocupar a agenda.
    const d1 = dia(190);
    const ok = await enviar(d1, 100, AB);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await a.query(`SELECT salao_preferido_id::text AS p, salao_id FROM fechamentos WHERE empresa_id = $1::uuid AND data_evento = $2::date`, [c.empresa, d1])).rows,
      [{ p: AB, salao_id: null }]);
    const antes = await contagem();
    // (b) acima da capacidade: nenhum salão comporta 130 (a revalidação falha) e a antecipação diagnostica o motivo.
    const acima = await enviar(dia(191), 130, AB);
    assert.deepEqual([acima.status, acima.body.codigo, acima.body.detalhes], [409, "SALAO_INDISPONIVEL", { motivo: "ACIMA_DA_CAPACIDADE", voltarParaSaloes: true }]);
    // (c) membro ocupado.
    const d3 = dia(192);
    await ocupar(c, d3, tarde, A);
    const ocupado = await enviar(d3, 100, AB);
    assert.deepEqual([ocupado.status, ocupado.body.codigo, ocupado.body.detalhes?.motivo, ocupado.body.detalhes?.voltarParaSaloes],
      [409, "SALAO_INDISPONIVEL", "OCUPADO_OU_LIMITE", true]);
    assert.equal(await contagem(), antes + 1, "só a ocupação de teste entrou");
    // A decisão direta, com a ocupação: recusa com motivo, nunca grava.
    const destino = { data: d3, inicio: "15:00", fim: "19:00", configuracaoId: tarde, pacoteId: c.pacote, empresaId: c.empresa, estabelecimentoId: null, convidados: 100 };
    assert.deepEqual(await emTransacao(() => decidirPreferencia(tx, destino, AB, LIGADO)), { resultado: "RECUSA_COM_MOTIVO", motivo: "OCUPADO_OU_LIMITE" });
    // Salão sem conteúdo próprio pronto (serviria pelo horário e capacidade): recusa genérica, nada gravado.
    const naoPronto = await simples(c, "Sem conteúdo", 120, 4, false);
    const semConteudo = await enviar(dia(196), 100, naoPronto);
    assert.deepEqual([semConteudo.status, semConteudo.body.detalhes], [409, { voltarParaSaloes: true }]);
    // Salão inativo da mesma empresa: o diagnóstico (SALAO_INATIVO_OU_OUTRO_ESCOPO) nunca vira motivo ao cliente.
    const inativo = await simples(c, "Inativo", 120, 5);
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [inativo]);
    const recusaInativo = await enviar(dia(197), 100, inativo);
    assert.deepEqual([recusaInativo.status, recusaInativo.body.detalhes], [409, { voltarParaSaloes: true }]);
    assert.equal(await contagem(), antes + 1, "nenhuma das duas recusas gravou");
  });

  // (d) helper desligado: recusa da E2a (sem voltarParaSaloes), nunca aceita o combinado.
  await comFlags(SO_E2A, async () => {
    const e2a = await enviar(dia(193), 100, AB);
    assert.equal(e2a.status, 409);
    assert.equal(e2a.body.detalhes?.voltarParaSaloes, undefined, "sem o marcador da E2b");
  });

  // R2-P2-1: B deixa de estar pronto → só um simples pronto; o combinado serve, mas a recusa é genérica.
  const v = (await a.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [B])).rows[0]!.v;
  await emTransacao(() => salvarApresentacao(tx, ctx(c), B, v, { convidadosMinimo: null, convidadosSentados: null, areaM2: 90, idadeMin: 3, idadeMax: 10,
    frase: "Mudou", outraFestaSimultanea: true, exclusivos: [], fotosReferencia: "2026-09" }, []));
  await comFlags(LIGADO, async () => {
    const generica = await enviar(dia(194), 100, AB);
    assert.deepEqual([generica.status, generica.body.codigo, generica.body.detalhes], [409, "SALAO_INDISPONIVEL", { voltarParaSaloes: true }]);
    // Cobertura recomendada no parecer rev. 2.1: menos de dois simples + AB ocupado = recusa com motivo, zero efeitos.
    const d6 = dia(195);
    await ocupar(c, d6, tarde, A);
    const antes = await contagem();
    const ocupadoSemMinimo = await enviar(d6, 100, AB);
    assert.deepEqual([ocupadoSemMinimo.status, ocupadoSemMinimo.body.detalhes], [409, { motivo: "OCUPADO_OU_LIMITE", voltarParaSaloes: true }]);
    assert.equal(await contagem(), antes, "nada gravado");
  });
});

test("E2b (P2-C2): matriz concorrente com os serviços reais — chave e modo advisory em pg_locks, trava até o COMMIT, emissão posterior", async () => {
  const { c, tarde } = await buffet("TARDE_E2B_CORRIDA");
  const A = await simples(c, "A", 60, 1);
  const B = await simples(c, "B", 60, 2);
  const AB = await combinado(c, "A+B", 120, 3, [A, B]);
  // C e E: mantêm 2 simples prontos depois das desativações (os portões públicos não mascaram o motivo).
  await simples(c, "C", 40, 4);
  await simples(c, "E", 40, 5);
  const pausavel = transacaoPausavel();
  const enviar = rotaFechamentos(c, tarde, pausavel.withTransaction);
  const config = `kidmais:agenda-config:${c.empresa}`;
  const preferencias = async (d: string) => (await a.query<{ id: string; p: string | null; s: string | null }>(
    `SELECT id::text AS id, salao_preferido_id::text AS p, salao_id::text AS s FROM fechamentos WHERE empresa_id = $1::uuid AND data_evento = $2::date AND origem_fechamento <> 'ATENDIMENTO_KIDMAIS'`,
    [c.empresa, d])).rows;
  const ativo = async (s: string) => (await a.query<{ ativo: boolean }>(`SELECT ativo FROM agenda_saloes WHERE id = $1::uuid`, [s])).rows[0]!.ativo;
  const reativar = (s: string) => a.query(`UPDATE agenda_saloes SET ativo = true WHERE id = $1::uuid`, [s]);

  await comFlags(LIGADO, async () => {
    await tresConexoes(async (b, obs) => { try {
      const [pa, pb] = [await pid(a), await pid(b)];

      // Linha 1 — desativação de membro primeiro (desativarSalao real segura a EXCLUSIVA da configuração): a confirmação
      // espera na COMPARTILHADA da mesma chave, relê depois do COMMIT e recusa com INELEGIVEL, sem gravar.
      const d1 = dia(200);
      await b.query("BEGIN");
      assert.deepEqual(await desativarSalao(executor(b), ctx(c), B), { desativado: true, id: B });
      const confirmacao1 = emFundo(enviar(d1, 100, AB));
      await esperaAdvisory(obs, pa, pb, config, "ShareLock", "ExclusiveLock");
      await b.query("COMMIT");
      const r1 = await confirmacao1;
      assert.deepEqual([r1.status, r1.body.codigo, r1.body.detalhes], [409, "SALAO_INDISPONIVEL", { motivo: "INELEGIVEL", voltarParaSaloes: true }]);
      assert.deepEqual(await preferencias(d1), [], "linha 1: nada gravado");
      await reativar(B);

      // Linha 2 — confirmação primeiro: a transação real do envio para ANTES do COMMIT segurando a compartilhada; a
      // desativação real espera a EXCLUSIVA até o COMMIT e então ocorre (a preferência não reserva). Emissão posterior:
      // PREFERIDO_NAO_SERVE, sem substituto.
      const d2 = dia(201);
      const pausa2 = pausavel.armar();
      const confirmacao2 = emFundo(enviar(d2, 100, AB));
      await pausa2.chegada;
      await b.query("BEGIN");
      const desativacao2 = emFundo(desativarSalao(executor(b), ctx(c), B));
      await esperaAdvisory(obs, pb, pa, config, "ExclusiveLock", "ShareLock");
      assert.equal(await ativo(B), true, "linha 2: a desativação ainda não ocorreu");
      pausa2.liberar();
      const r2 = await confirmacao2;
      assert.equal(r2.status, 201, JSON.stringify(r2.body));
      assert.deepEqual(await desativacao2, { desativado: true, id: B });
      await b.query("COMMIT");
      const [f2] = await preferencias(d2);
      assert.deepEqual([f2?.p, f2?.s], [AB, null], "linha 2: preferência gravada, nada reservado");
      assert.equal(await ativo(B), false);
      assert.deepEqual(await emTransacao(() => escolherSalaoParaEmissao(tx, f2!.id)), { porSalao: true, salao: null, motivo: "PREFERIDO_NAO_SERVE" });
      await reativar(B);

      // Linha 3 — confirmação primeiro × reserva de A: a reserva toma a trava da DATA (adquirirLockConfirmacaoAgenda, a
      // mesma de quem confirma a agenda) e espera o COMMIT; depois ocupa A. A preferência fica indisponível depois,
      // legitimamente, e a emissão recusa sem substituir.
      const d3 = dia(202);
      const pausa3 = pausavel.armar();
      const confirmacao3 = emFundo(enviar(d3, 100, AB));
      await pausa3.chegada;
      await b.query("BEGIN");
      const reserva3 = emFundo((async () => { await adquirirLockConfirmacaoAgenda(d3, executor(b)); await ocuparNaTransacao(b, c, d3, tarde, A); })());
      await esperaAdvisory(obs, pb, pa, `kidmais:agenda:${d3}`, "ExclusiveLock", "ExclusiveLock");
      pausa3.liberar();
      assert.equal((await confirmacao3).status, 201);
      await reserva3;
      await b.query("COMMIT");
      const [f3] = await preferencias(d3);
      assert.deepEqual([f3?.p, f3?.s], [AB, null]);
      assert.deepEqual(await emTransacao(() => escolherSalaoParaEmissao(tx, f3!.id)), { porSalao: true, salao: null, motivo: "PREFERIDO_NAO_SERVE" });

      // Linha 3b — reserva de A primeiro (trava da data + ocupação ainda sem COMMIT): a confirmação espera na DATA (a
      // compartilhada da configuração não conflita com ela), relê e recusa com OCUPADO_OU_LIMITE, sem gravar.
      const d4 = dia(203);
      await b.query("BEGIN");
      await adquirirLockConfirmacaoAgenda(d4, executor(b));
      await ocuparNaTransacao(b, c, d4, tarde, A);
      const confirmacao4 = emFundo(enviar(d4, 100, AB));
      await esperaAdvisory(obs, pa, pb, `kidmais:agenda:${d4}`, "ExclusiveLock", "ExclusiveLock");
      await b.query("COMMIT");
      const r4 = await confirmacao4;
      assert.deepEqual([r4.status, r4.body.codigo, r4.body.detalhes?.motivo], [409, "SALAO_INDISPONIVEL", "OCUPADO_OU_LIMITE"],
        "linha 3b: reserva de A primeiro → a confirmação relê depois do COMMIT e recusa");
      assert.deepEqual(await preferencias(d4), [], "linha 3b: nada gravado");

      // Linha 4 — DELETE direto de AB (SQL de teste) com a confirmação parada antes do COMMIT: a espera é de LINHA (o
      // gatilho da 106 lê AB com FOR SHARE), não de configuração — não conta como prova da compartilhada. Depois do
      // COMMIT, o RESTRICT da 106 recusa o DELETE.
      const d5 = dia(204);
      const pausa5 = pausavel.armar();
      const confirmacao5 = emFundo(enviar(d5, 100, AB));
      await pausa5.chegada;
      await b.query("BEGIN");
      const apagar = b.query(`DELETE FROM agenda_saloes WHERE id = $1::uuid`, [AB]).then(() => "ok", (e: { code?: string }) => e.code);
      await esperaSemAdvisory(obs, pb, pa);
      pausa5.liberar();
      assert.equal((await confirmacao5).status, 201);
      assert.equal(await apagar, "23001", "ON DELETE RESTRICT da 106 (restrict_violation)");
      await b.query("ROLLBACK");
      assert.equal((await preferencias(d5))[0]?.p, AB);
    } finally { pausavel.soltar(); } });
  });
});

test("E2b (revisão de código): PARCIAL com as flags, motivos restantes, escopo NULL × concreto e outra empresa, antecipação e zero efeitos", async () => {
  const { c, tarde } = await buffet("TARDE_E2B_LACUNAS");
  const A = await simples(c, "A", 60, 1);
  const B = await simples(c, "B", 60, 2);
  const AB = await combinado(c, "A+B", 120, 3, [A, B]);
  const fotoAB = (await a.query<{ id: string }>(`SELECT id::text AS id FROM agenda_salao_fotos WHERE salao_id = $1::uuid ORDER BY ordem LIMIT 1`, [AB])).rows[0]!.id;
  const d = dia(210);
  const destino = (extra: Partial<{ convidados: number; estabelecimentoId: string | null; empresaId: string; fim: string }> = {}) => ({
    data: d, inicio: "15:00", fim: "19:00", configuracaoId: tarde, pacoteId: c.pacote, empresaId: c.empresa, estabelecimentoId: null, convidados: 100, ...extra,
  });
  const decidir = (dst = destino(), salao = AB, env = LIGADO) => emTransacao(() => decidirPreferencia(tx, dst, salao, env));
  const dentro = async (sql: string, params: unknown[], prova: () => Promise<void>) => {
    await a.query("BEGIN");
    try { await a.query(sql, params); await prova(); } finally { await a.query("ROLLBACK"); }
  };
  assert.deepEqual(await decidir(), { resultado: "ACEITA" }, "controle");

  // PARCIAL com as duas flags: o helper é falso — nada de combinado, foto/nome nem decisão da E2b (genérica).
  await dentro("ALTER TABLE public.agenda_saloes DISABLE TRIGGER agenda_saloes_098_guarda_trg", [], async () => {
    assert.equal((await estadoCombinados(tx)).estado, "PARCIAL");
    assert.equal(await combinadosPublicos(tx, LIGADO), false);
    assert.deepEqual(await decidirPreferencia(tx, destino(), AB, LIGADO), { resultado: "RECUSA_GENERICA" });
    await assert.rejects(fotoPublica(tx, escopo(c), AB, fotoAB, LIGADO), SalaoPublicoIndisponivel);
    assert.equal(await nomeDoSalaoPublico(tx, escopo(c), AB, LIGADO), null);
  });

  // Motivos restantes, cada um com o resto servindo (desfeito no ROLLBACK).
  await dentro(`INSERT INTO configuracao_agenda_saloes (configuracao_agenda_id, salao_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`, [tarde, A, B], async () => {
    assert.deepEqual(await decidirPreferencia(tx, destino(), AB, LIGADO), { resultado: "RECUSA_COM_MOTIVO", motivo: "HORARIO_NAO_PERMITE" });
  });
  await dentro(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`, [c.pacote, A, B], async () => {
    assert.deepEqual(await decidirPreferencia(tx, destino(), AB, LIGADO), { resultado: "RECUSA_COM_MOTIVO", motivo: "PACOTE_NAO_PERMITE" });
  });
  // Mínimo pelo serviço real (mudar conteúdo anula a declaração; declara de novo) e volta ao original.
  const minimoDoAB = async (m: number | null) => {
    const r = await emTransacao(async () => salvarApresentacao(tx, ctx(c), AB, await versaoDe(AB), camposDe("A+B", { convidadosMinimo: m }), []));
    await emTransacao(() => confirmarDeclaracao(tx, ctx(c), AB, r.conteudoVersao));
  };
  await minimoDoAB(110);
  assert.deepEqual(await decidir(), { resultado: "RECUSA_COM_MOTIVO", motivo: "ABAIXO_DO_MINIMO" });
  await minimoDoAB(null);
  assert.deepEqual(await decidir(), { resultado: "ACEITA" });

  // Universo por endereço (D-E2b-4): o único pacote vira P_ (fora dos sete V1). No endereço atual (só V1) o combinado
  // fica sem universo e some; em /b/<código> (contratáveis da empresa) aparece. Os simples não dependem disso.
  const ids = async (enderecoDaEmpresa: boolean) =>
    (await listarSaloesPublicos(tx, escopo(c), consulta(d, tarde, 40), LIGADO, { enderecoDaEmpresa })).saloes.map((s) => s.id);
  assert.deepEqual(await ids(false), [A, B, AB], "controle: COMPLETA é V1");
  await dentro(`UPDATE pacotes SET codigo = 'P_SO_DA_EMPRESA' WHERE id = $1::uuid`, [c.pacote], async () => {
    assert.deepEqual(await ids(false), [A, B], "endereço atual: sem pacote V1, sem universo");
    assert.deepEqual(await ids(true), [A, B, AB], "/b/<código>: o P_ da empresa serve o combinado");
  });

  // Escopo: unidade concreta × salão da empresa sem unidade (NULL) e outra empresa — genérica, nunca motivo.
  assert.deepEqual(await decidir(destino({ estabelecimentoId: crypto.randomUUID() })), { resultado: "RECUSA_GENERICA" }, "unidade concreta × NULL");
  const outra = await buffet("TARDE_E2B_OUTRA");
  assert.deepEqual(await decidir({ ...destino(), configuracaoId: outra.tarde, pacoteId: outra.c.pacote, empresaId: outra.c.empresa }),
    { resultado: "RECUSA_GENERICA" }, "salão de outra empresa");
  // Mesmo de outra empresa, nem com motivo que ali valeria (acima da capacidade): genérica.
  assert.deepEqual(await decidir({ ...destino({ convidados: 500 }), configuracaoId: outra.tarde, pacoteId: outra.c.pacote, empresaId: outra.c.empresa }),
    { resultado: "RECUSA_GENERICA" });

  // Antecipação na rota: a revalidação falha por OUTRA razão (fim fora do horário fixo) e o salão serviria → ACEITA →
  // vale o erro original, sem marcador nem motivo. Contagens inalteradas em TODAS as tabelas de public, como nas
  // recusas (P3-R2-1 do Astra: prova de cardinalidade, não de conteúdo; o diagnóstico roda em transação READ ONLY).
  const enviar = rotaFechamentos(c, tarde);
  const retrato = async () => {
    const tabelas = (await a.query<{ t: string }>(`SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows;
    const contagens: Record<string, number> = {};
    for (const { t } of tabelas) contagens[t] = Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]!.n);
    return contagens;
  };
  await comFlags(LIGADO, async () => {
    const antes = await retrato();
    const outroErro = await enviar(dia(211), 100, AB, "18:30");
    assert.equal(outroErro.status, 409, JSON.stringify(outroErro.body));
    assert.notEqual(outroErro.body.codigo, "SALAO_INDISPONIVEL", "o erro original da revalidação");
    assert.equal(outroErro.body.detalhes?.voltarParaSaloes, undefined);
    const acima = await enviar(dia(212), 130, AB);
    assert.deepEqual([acima.status, acima.body.detalhes], [409, { motivo: "ACIMA_DA_CAPACIDADE", voltarParaSaloes: true }]);
    const naoServe = await enviar(dia(213), 100, crypto.randomUUID());
    assert.deepEqual([naoServe.status, naoServe.body.codigo, naoServe.body.detalhes], [409, "SALAO_INDISPONIVEL", { voltarParaSaloes: true }], "salão inexistente: genérica");
    assert.deepEqual(await retrato(), antes, "contagens inalteradas em todas as tabelas de public");
  });
});
