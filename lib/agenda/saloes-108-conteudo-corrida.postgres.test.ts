import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, executor, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { normalizarWebp, type WebpNormalizado } from "../imagens/normalizar-webp.ts";
import {
  adicionarFoto, confirmarDeclaracao, lerApresentacao, listarSaloesComApresentacao, salvarApresentacao, type CamposInformados,
} from "./salao-apresentacao.ts";
import { SalaoPublicoIndisponivel, saloesProntosPublicos } from "./salao-publico.ts";
import { estadoCombinados } from "./estado-combinados.ts";

/**
 * Retomada 098 (108, D-R3): o combinado tem conteúdo PRÓPRIO sob as mesmas regras da 102. PostgreSQL DESCARTÁVEL, modelo
 * 108 (108 aplicada, sem a 098 histórica), pelos serviços reais da apresentação (`salvarApresentacao`, `adicionarFoto`,
 * `confirmarDeclaracao`), para um combinado A+B:
 *   * CORRIDA conteúdo × declaração sob duas conexões reais, nas duas ordens, com espera observada (pg_blocking_pids) e
 *     sem deadlock: (a) a mudança segura o salão e a declaração da versão antiga espera e é recusada depois do commit
 *     (versão andou); (b) a declaração segura e a mudança espera e, depois do commit, anula a declaração;
 *   * conteúdo PRÓPRIO: mudar o membro (A) não anula a declaração do combinado, e vice-versa (inclusive em corrida);
 *   * E2a: o combinado nunca entra em `saloesProntosPublicos` (SALOES_PUBLICOS ligada), em nenhum estado, nem PRONTO, e
 *     nem completa o mínimo de 2 salões; os simples A e B entram quando prontos. O painel prepara o combinado.
 */
let a: Client;
let tx: DbExecutor;
const LIGADO = { SALOES_PUBLICOS: "true" };
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: crypto.randomUUID() });
let frases = 0;

async function emTransacao<T>(fn: () => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  try { const r = await fn(); await a.query("COMMIT"); return r; } catch (e) { await a.query("ROLLBACK"); throw e; }
}
async function imagem() {
  const cor = { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! };
  return normalizarWebp(await sharp({ create: { width: 40, height: 30, channels: 3, background: cor } }).png().toBuffer());
}
/** Campos completos com uma frase nova a cada chamada (mudança pública real, nunca no-op). */
function campos(nome: string): CamposInformados {
  frases += 1;
  return { convidadosMinimo: null, convidadosSentados: null, areaM2: 100, idadeMin: 3, idadeMax: 10, frase: `Salão ${nome} ${frases}`,
    outraFestaSimultanea: true, exclusivos: ["ENTRADA"], fotosReferencia: "2026-09" };
}
type Estado = { conteudo_versao: number; declaracao_versao: number | null; declaracao_em: string | null };
const estado = async (s: string): Promise<Estado> => (await a.query<Estado>(
  `SELECT conteudo_versao, declaracao_versao, declaracao_em::text FROM agenda_saloes WHERE id = $1::uuid`, [s])).rows[0]!;
const versao = async (s: string) => (await estado(s)).conteudo_versao;
const fotos = async (s: string) => (await a.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM agenda_salao_fotos WHERE salao_id = $1::uuid AND removida_em IS NULL`, [s])).rows[0]!.n;

/** Campos + 6 fotos (o mínimo para publicar), SEM declaração. Devolve a versão vigente. */
async function preparar(c: Cenario, s: string, nome: string) {
  let r = await emTransacao(async () => salvarApresentacao(tx, ctx(c), s, await versao(s), campos(nome), []));
  for (let i = 0; i < 6; i++) {
    const img = await imagem();
    r = await emTransacao(() => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, img, `Ambiente ${i + 1}`));
  }
  return r.conteudoVersao;
}
async function declarar(c: Cenario, s: string) {
  const v = await versao(s);
  await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, v));
  assert.equal((await estado(s)).declaracao_versao, v, "declarado na versão vigente");
}
async function publicar(c: Cenario, s: string, nome: string) {
  await preparar(c, s, nome);
  await declarar(c, s);
}

/** Empresa POR_SALAO com A e B simples PRONTOS e o combinado A+B recém-criado (sem conteúdo). */
async function base() {
  const c = await cenario(a, 0);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const A = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'A', 60, 1) RETURNING id`, [c.empresa]);
  const B = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'B', 60, 2) RETURNING id`, [c.empresa]);
  await publicar(c, A, "A");
  await publicar(c, B, "B");
  const AB = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem, combinado, membros)
                          VALUES ($1::uuid, 'A+B', 120, 3, true, $2::uuid[]) RETURNING id`, [c.empresa, [A, B].sort()]);
  return { c, A, B, AB, escopo: { empresaId: c.empresa, estabelecimentoId: null } };
}

const pid = async (db: Client) => (await db.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p;
/** Espera até `bloqueada` estar bloqueada pela sessão `segura` (pg_blocking_pids), sem sleep fixo como prova. */
async function esperarBloqueio(pidSegura: number, pidBloqueada: number) {
  for (let i = 0; i < 200; i++) {
    const r = await a.query<{ ok: boolean }>(`SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS ok`, [pidSegura, pidBloqueada]);
    if (r.rows[0]?.ok) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail("a segunda conexão não ficou esperando a primeira");
}
/** "ok" ou o código do erro (do serviço ou SQLSTATE): deadlock apareceria como 40P01 e reprova a igualdade. */
const resultado = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => String(e.code));

/**
 * A conexão `a` faz `primeira` e segura (sem commit); a `b` começa `segunda`, que precisa ESPERAR; `a` faz commit e
 * devolve o desfecho da segunda (a `b` fica com a transação aberta para o chamador decidir commit ou rollback).
 */
async function corrida(primeira: (db: DbExecutor) => Promise<unknown>, segunda: (db: DbExecutor) => Promise<unknown>,
  depois: (b: Client, desfecho: string) => Promise<void>) {
  const b = await conectarDescartavel({ travar: false });
  try {
    const pidA = await pid(a);
    const pidB = await pid(b);
    await a.query("BEGIN");
    await primeira(tx);
    await b.query("BEGIN");
    const desfecho = resultado(segunda(executor(b)));
    await esperarBloqueio(pidA, pidB);
    await a.query("COMMIT");
    await depois(b, await desfecho);
  } finally {
    await b.end();
  }
}

type Mudanca = { nome: string; fazer: (db: DbExecutor, c: Cenario, s: string, v: number, img: WebpNormalizado) => Promise<unknown> };
const MUDANCAS: Mudanca[] = [
  { nome: "edição dos campos", fazer: (db, c, s, v) => salvarApresentacao(db, ctx(c), s, v, campos("A+B"), []) },
  { nome: "foto nova", fazer: (db, c, s, v, img) => adicionarFoto(db, ctx(c), s, v, img, "Ambiente extra") },
];

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
  assert.equal((await estadoCombinados(tx)).estado, "NOVA", "modelo 108: 108 aplicada (sem a 098 histórica)");
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("108: combinado — mudança de conteúdo segura o salão; a declaração da versão antiga espera e é recusada", async () => {
  const { c, AB } = await base();
  await preparar(c, AB, "A+B");
  for (const m of MUDANCAS) {
    const v = await versao(AB);
    assert.equal((await estado(AB)).declaracao_versao, null, `${m.nome}: combinado preparado e ainda sem declaração`);
    const img = await imagem();
    await corrida((db) => m.fazer(db, c, AB, v, img), (db) => confirmarDeclaracao(db, ctx(c), AB, v), async (b, desfecho) => {
      assert.equal(desfecho, "SALAO_MUDOU", `${m.nome}: declaração da versão ${v} recusada depois do commit (sem deadlock)`);
      await b.query("ROLLBACK");
    });
    const depois = await estado(AB);
    assert.ok(depois.conteudo_versao > v, `${m.nome}: a versão do combinado andou`);
    assert.equal(depois.declaracao_versao, null, `${m.nome}: nada declarado`);
    assert.equal(depois.declaracao_em, null, `${m.nome}: sem data de declaração`);
  }
  assert.equal(await fotos(AB), 7);
});

test("108: combinado — declaração segura o salão; a mudança de conteúdo espera e, depois do commit, anula a declaração", async () => {
  const { c, AB } = await base();
  await preparar(c, AB, "A+B");
  for (const m of MUDANCAS) {
    const v = await versao(AB);
    const img = await imagem();
    await corrida((db) => confirmarDeclaracao(db, ctx(c), AB, v), (db) => m.fazer(db, c, AB, v, img), async (b, desfecho) => {
      assert.equal(desfecho, "ok", `${m.nome}: a mudança passa depois do commit da declaração (sem deadlock)`);
      assert.equal((await estado(AB)).declaracao_versao, v, `${m.nome}: declaração da versão ${v} gravada antes da mudança`);
      await b.query("COMMIT");
    });
    const depois = await estado(AB);
    assert.ok(depois.conteudo_versao > v, `${m.nome}: a versão do combinado andou`);
    assert.equal(depois.declaracao_versao, null, `${m.nome}: a mudança anulou a declaração`);
    assert.equal(depois.declaracao_em, null, `${m.nome}: sem data de declaração`);
  }
  assert.equal(await fotos(AB), 7);
});

test("108: conteúdo próprio (D-R3) — mudar o membro não anula a declaração do combinado, e vice-versa", async () => {
  const { c, A, B, AB } = await base();
  await publicar(c, AB, "A+B");
  const combinado = await estado(AB);
  assert.equal(combinado.declaracao_versao, combinado.conteudo_versao);

  // Membro A muda (campos, foto e capacidade da agenda): só A perde a declaração.
  await emTransacao(async () => salvarApresentacao(tx, ctx(c), A, await versao(A), campos("A"), []));
  assert.equal((await estado(A)).declaracao_versao, null, "campos de A anulam a declaração de A");
  await declarar(c, A);
  const img = await imagem();
  await emTransacao(async () => adicionarFoto(tx, ctx(c), A, await versao(A), img, "Ambiente extra"));
  assert.equal((await estado(A)).declaracao_versao, null, "foto de A anula a declaração de A");
  await a.query(`UPDATE agenda_saloes SET capacidade_convidados = 70 WHERE id = $1::uuid`, [A]);
  assert.deepEqual(await estado(AB), combinado, "nada do membro muda a versão nem a declaração do combinado");
  await declarar(c, A);

  // O combinado muda (campos e foto): A e B continuam declarados.
  const membroA = await estado(A);
  const membroB = await estado(B);
  await emTransacao(async () => salvarApresentacao(tx, ctx(c), AB, await versao(AB), campos("A+B"), []));
  const img2 = await imagem();
  await emTransacao(async () => adicionarFoto(tx, ctx(c), AB, await versao(AB), img2, "Ambiente extra"));
  assert.equal((await estado(AB)).declaracao_versao, null, "o combinado perdeu a própria declaração");
  assert.deepEqual(await estado(A), membroA, "A intacto");
  assert.deepEqual(await estado(B), membroB, "B intacto");

  // Em corrida (mesma trava da empresa, então há espera), nas duas ordens: a declaração do OUTRO salão passa.
  const vAB = await versao(AB);
  await corrida(async (db) => salvarApresentacao(db, ctx(c), A, await versao(A), campos("A"), []),
    (db) => confirmarDeclaracao(db, ctx(c), AB, vAB), async (b, desfecho) => {
      assert.equal(desfecho, "ok", "declaração do combinado passa depois da mudança do membro");
      await b.query("COMMIT");
    });
  assert.equal((await estado(AB)).declaracao_versao, vAB, "combinado declarado na própria versão");
  assert.equal((await estado(A)).declaracao_versao, null);
  const vA = await versao(A);
  await corrida(async (db) => salvarApresentacao(db, ctx(c), AB, await versao(AB), campos("A+B"), []),
    (db) => confirmarDeclaracao(db, ctx(c), A, vA), async (b, desfecho) => {
      assert.equal(desfecho, "ok", "declaração do membro passa depois da mudança do combinado");
      await b.query("COMMIT");
    });
  assert.equal((await estado(A)).declaracao_versao, vA, "membro declarado na própria versão");
  assert.equal((await estado(AB)).declaracao_versao, null, "a mudança do combinado anulou só a dele");
});

test("108 (E2a): o combinado fica fora de saloesProntosPublicos em todos os estados, mesmo PRONTO", async () => {
  const { c, A, B, AB, escopo } = await base();
  const prontos = async () => (await saloesProntosPublicos(tx, escopo, LIGADO)).map((s) => s.id);
  const painel = async () => (await listarSaloesComApresentacao(tx, c.empresa)).find((s) => s.id === AB);

  assert.deepEqual(await prontos(), [A, B], "combinado vazio");
  assert.equal((await painel())?.pronto, false, "o painel lista o combinado para preparar");

  await preparar(c, AB, "A+B");
  assert.deepEqual(await prontos(), [A, B], "combinado com campos e fotos, sem declaração");

  await declarar(c, AB);
  assert.equal((await lerApresentacao(tx, c.empresa, AB)).publicavel.ok, true, "combinado PRONTO pelas regras da 102");
  assert.equal((await painel())?.pronto, true);
  assert.deepEqual(await prontos(), [A, B], "combinado pronto continua fora");

  await emTransacao(async () => salvarApresentacao(tx, ctx(c), AB, await versao(AB), campos("A+B"), []));
  assert.equal((await estado(AB)).declaracao_versao, null);
  assert.deepEqual(await prontos(), [A, B], "combinado com declaração anulada");
  await declarar(c, AB);

  // A deixa de estar pronto: o combinado PRONTO não completa o mínimo de 2 salões.
  await emTransacao(async () => salvarApresentacao(tx, ctx(c), A, await versao(A), campos("A"), []));
  await assert.rejects(saloesProntosPublicos(tx, escopo, LIGADO), SalaoPublicoIndisponivel, "só B e o combinado prontos");
  await declarar(c, A);
  assert.deepEqual(await prontos(), [A, B], "A pronto de novo");

  // Sem B pronto, idem (ordem simétrica).
  await emTransacao(async () => salvarApresentacao(tx, ctx(c), B, await versao(B), campos("B"), []));
  await assert.rejects(saloesProntosPublicos(tx, escopo, LIGADO), SalaoPublicoIndisponivel, "só A e o combinado prontos");
  await declarar(c, B);
  assert.deepEqual(await prontos(), [A, B], "fim: só os simples, com o combinado pronto");
  assert.equal((await lerApresentacao(tx, c.empresa, AB)).publicavel.ok, true);
});
