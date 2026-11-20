import test from "node:test";
import assert from "node:assert/strict";
import { abrirGeracao, desligando, DRENAGEM_RESPOSTA_MS, esperarGeracoes, geracoesAbertas, instalarDesligamento, PRAZO_DESLIGAMENTO_MS } from "./desligamento.ts";
import { LIMITE_PROVEDOR_SEGUNDOS } from "./progresso-geracao.ts";

/**
 * Desligamento que espera as gerações de convite (vault "Convites geracao sobrevive ao deploy 20261120"): contagem por
 * processo, encerrar idempotente, recusa depois do sinal, espera até a última fechar, prazo e handler só com
 * NEXT_MANUAL_SIG_HANDLE. O estado mora no globalThis (rotas e instrumentation em pacotes separados); cada teste o zera.
 */
const zerar = () => { delete (globalThis as Record<symbol, unknown>)[Symbol.for("kidmais.convites.desligamento")]; };

test("prazo cobre o limite do provedor com folga; prazo + drenagem cabem na carência de 150 s", () => {
  assert.equal(PRAZO_DESLIGAMENTO_MS, (LIMITE_PROVEDOR_SEGUNDOS + 10) * 1000);
  assert.ok(DRENAGEM_RESPOSTA_MS > 0 && PRAZO_DESLIGAMENTO_MS + DRENAGEM_RESPOSTA_MS < 150_000);
});

test("abrir e encerrar contam por processo; encerrar duas vezes conta uma", () => {
  zerar();
  const a = abrirGeracao(), b = abrirGeracao();
  assert.ok(a && b);
  assert.equal(geracoesAbertas(), 2);
  a(); a();
  assert.equal(geracoesAbertas(), 1);
  b();
  assert.equal(geracoesAbertas(), 0);
});

test("depois do sinal: geração nova recusada; a espera termina quando a última aberta fecha", async () => {
  zerar();
  const a = abrirGeracao()!, b = abrirGeracao()!;
  const espera = esperarGeracoes(5_000);
  assert.equal(desligando(), true);
  assert.equal(abrirGeracao(), null, "recusa antes de reservar crédito");
  let terminou = false;
  void espera.then(() => { terminou = true; });
  a();
  await new Promise((r) => setImmediate(r));
  assert.equal(terminou, false, "ainda há uma aberta");
  b();
  assert.deepEqual(await espera, { resultado: "vazio", abertas: 0 });
});

test("sem gerações abertas a espera resolve na hora; com uma presa, o prazo vence", async () => {
  zerar();
  assert.deepEqual(await esperarGeracoes(10), { resultado: "vazio", abertas: 0 });
  zerar();
  const presa = abrirGeracao()!;
  assert.deepEqual(await esperarGeracoes(20), { resultado: "prazo", abertas: 1 });
  presa();
});

test("handler só com NEXT_MANUAL_SIG_HANDLE; ouvinte permanente; SIGTERM espera, drena e sai com 143 uma vez só", async () => {
  zerar();
  const ouvintes = new Map<string, () => void>();
  const saidas: number[] = [];
  const processo = { on: (s: string, f: () => void) => { ouvintes.set(s, f); return processo; }, exit: (c?: number) => { saidas.push(c ?? 0); } };
  assert.equal(instalarDesligamento({}, processo as never, 50, () => undefined), false);
  assert.equal(ouvintes.size, 0, "sem a variável o Next cuida do sinal");

  const linhas: string[] = [];
  assert.equal(instalarDesligamento({ NEXT_MANUAL_SIG_HANDLE: "true" }, processo as never, 1_000, (l) => linhas.push(l), 60), true);
  assert.deepEqual([...ouvintes.keys()].sort(), ["SIGINT", "SIGTERM"]);
  const aberta = abrirGeracao()!;
  ouvintes.get("SIGTERM")!();
  ouvintes.get("SIGTERM")!();
  ouvintes.get("SIGINT")!();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(saidas, [], "espera a geração aberta; sinais repetidos não saem");
  aberta();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(saidas, [], "drenagem: a resposta ainda está sendo enviada");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(saidas, [143]);
  assert.match(linhas[0], /SIGTERM: recusando gerações novas; 1 em curso/);
  assert.ok(linhas.some((l) => /repetido; a espera continua/.test(l)));
  assert.match(linhas.at(-1)!, /terminaram; encerrando em/);
  zerar();
});

test("prazo vencido: sai na hora, sem drenagem", async () => {
  zerar();
  const ouvintes = new Map<string, () => void>();
  const saidas: number[] = [];
  const processo = { on: (s: string, f: () => void) => { ouvintes.set(s, f); return processo; }, exit: (c?: number) => { saidas.push(c ?? 0); } };
  instalarDesligamento({ NEXT_MANUAL_SIG_HANDLE: "true" }, processo as never, 20, () => undefined, 10_000);
  const presa = abrirGeracao()!;
  ouvintes.get("SIGINT")!();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(saidas, [130]);
  presa();
  zerar();
});
