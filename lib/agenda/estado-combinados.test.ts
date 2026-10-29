import assert from "node:assert/strict";
import test from "node:test";
import {
  classificarCombinados, combinadosHabilitados, combinadosHabilitadosOuRecusa, ErroCombinadosParcial, estadoCombinados,
  GATILHOS_COMBINADOS, HASHES_COMBINADOS, TOTAL_FUNCOES_COMBINADOS, type CatalogoCombinados,
} from "./estado-combinados.ts";

const vazio: CatalogoCombinados = { funcoes: 0, funcoesQualquer: 0, colunaCombinado: false, colunaMembros: false, checkValidado: false, gatilhosOk: 0,
  gatilhosQualquer: 0, conflito: "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb", contrato: "4d46", revisao: "9518", marcador108: false };
const nova: CatalogoCombinados = { funcoes: TOTAL_FUNCOES_COMBINADOS, funcoesQualquer: TOTAL_FUNCOES_COMBINADOS, colunaCombinado: true, colunaMembros: true,
  checkValidado: true, gatilhosOk: GATILHOS_COMBINADOS.length, gatilhosQualquer: GATILHOS_COMBINADOS.length, conflito: HASHES_COMBINADOS.conflito108,
  contrato: HASHES_COMBINADOS.contrato, revisao: HASHES_COMBINADOS.revisao, marcador108: true };
const antiga: CatalogoCombinados = { ...nova, conflito: HASHES_COMBINADOS.conflito098, marcador108: false };

test("estado: ausente, antiga e nova só com a instalação COMPLETA e ÍNTEGRA (pareceres de 29/10, P2-1)", () => {
  assert.equal(classificarCombinados(vazio), "AUSENTE");
  assert.equal(classificarCombinados(nova), "NOVA");
  assert.equal(classificarCombinados(antiga), "ANTIGA");
});

test("parcial: peça faltando, definição ou corpo divergente, CHECK trocado, marcador trocado", () => {
  const casos: Array<[string, Partial<CatalogoCombinados>]> = [
    ["uma função a menos", { funcoes: TOTAL_FUNCOES_COMBINADOS - 1, funcoesQualquer: TOTAL_FUNCOES_COMBINADOS - 1 }],
    ["função com outro corpo", { funcoes: TOTAL_FUNCOES_COMBINADOS - 1 }],
    ["função kidmais098_ a mais", { funcoesQualquer: TOTAL_FUNCOES_COMBINADOS + 1 }],
    ["sem coluna membros", { colunaMembros: false }],
    ["sem coluna combinado", { colunaCombinado: false }],
    ["CHECK não validado ou com outra definição (CHECK (true))", { checkValidado: false }],
    ["gatilho desligado, religado a outra função ou com outra definição (só DELETE)", { gatilhosOk: GATILHOS_COMBINADOS.length - 1 }],
    ["gatilho _098_ a mais", { gatilhosQualquer: GATILHOS_COMBINADOS.length + 1 }],
    ["validação de contrato com outro corpo", { contrato: "x" }],
    ["validação de revisão com outro corpo", { revisao: "x" }],
    ["regra de conflito da 100 com a 108", { conflito: "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb" }],
    ["regra da 098 com o marcador da 108", { conflito: HASHES_COMBINADOS.conflito098 }],
    ["regra da 108 sem o marcador", { marcador108: false }],
  ];
  for (const [nome, delta] of casos) assert.equal(classificarCombinados({ ...nova, ...delta }), "PARCIAL", nome);
  assert.equal(classificarCombinados({ ...vazio, marcador108: true }), "PARCIAL", "só o marcador");
  assert.equal(classificarCombinados({ ...vazio, gatilhosQualquer: 1 }), "PARCIAL", "só um gatilho _098_");
  assert.equal(classificarCombinados({ ...vazio, funcoesQualquer: 1 }), "PARCIAL", "só uma função");
});

test("habilitação: SÓ a 108 completa liga; ANTIGA (098 histórica, decisão de Felipe de 29/10) e PARCIAL recusam; ausente desliga", () => {
  assert.deepEqual((["AUSENTE", "ANTIGA", "NOVA", "PARCIAL"] as const).map(combinadosHabilitados), [false, false, true, false]);
  assert.equal(combinadosHabilitadosOuRecusa("AUSENTE"), false);
  assert.equal(combinadosHabilitadosOuRecusa("NOVA"), true);
  assert.throws(() => combinadosHabilitadosOuRecusa("ANTIGA"), (e: unknown) => e instanceof ErroCombinadosParcial && /instalação antiga/.test(e.message));
  assert.throws(() => combinadosHabilitadosOuRecusa("PARCIAL"), (e: unknown) => e instanceof ErroCombinadosParcial && e.code === "SALOES_COMBINADOS_PARCIAL");
});

test("estadoCombinados lê o catálogo numa consulta só, com as definições, e devolve a coluna para o filtro público", async () => {
  const consultas: string[] = [];
  const db = (linha: Record<string, unknown> | undefined) => ({
    query: async (sql: string) => { consultas.push(sql); return { rows: linha ? [linha] : [], rowCount: linha ? 1 : 0 }; },
  });
  const linhaNova = { funcoes: 10, funcoes_qualquer: 10, combinado: true, membros: true, check_ok: true, gatilhos_ok: 6, gatilhos_qualquer: 6,
    conflito: HASHES_COMBINADOS.conflito108, contrato: HASHES_COMBINADOS.contrato, revisao: HASHES_COMBINADOS.revisao, marcador: true };
  assert.deepEqual(await estadoCombinados(db(linhaNova) as never), { estado: "NOVA", coluna: true });
  assert.deepEqual(await estadoCombinados(db({ ...linhaNova, gatilhos_ok: 5 }) as never), { estado: "PARCIAL", coluna: true });
  assert.deepEqual(await estadoCombinados(db(undefined) as never), { estado: "AUSENTE", coluna: false });
  assert.equal(consultas.length, 3);
  const sql = consultas[0]!;
  assert.match(sql, /kidmais108_instalada\(\)/);
  assert.match(sql, /tgenabled = 'O'/);
  assert.match(sql, /t\.tgtype = g\.tipo AND t\.tgdeferrable = g\.diferido AND t\.tginitdeferred = g\.diferido/);
  assert.match(sql, /t\.tgnargs = 0 AND t\.tgqual IS NULL/);
  assert.match(sql, /CHECKCASEWHENcombinadoTHENkidmais098_membros_canonicosmembrosELSEmembrosISNULLEND/);
  for (const [nome] of GATILHOS_COMBINADOS) assert.match(sql, new RegExp(nome));
});
