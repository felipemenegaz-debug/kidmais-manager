import test from "node:test";
import assert from "node:assert/strict";
import {
  fotosAntigas, fraseConvivencia, idadeSugerida, mensagemErroSalao, mesAtualSaoPaulo, mesDasFotos, normalizarTexto, ordemDaNovaFoto,
  pendenciasPublicacao, planejarReordenacao, ORDEM_MAXIMA, type EstadoPublicacao,
} from "./salao-apresentacao-regras.ts";

const pronto: EstadoPublicacao = {
  ativo: true, capacidade: 120, fotosAtivas: 6, fotosReferencia: "2026-03-01", outraFestaSimultanea: true, conteudoVersao: 7, declaracaoVersao: 7,
};

test("pendências: cada requisito isolado, declaração na versão vigente e lista sem a declaração", () => {
  assert.deepEqual(pendenciasPublicacao(pronto), []);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, ativo: false }), ["SALAO_INATIVO"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, capacidade: null }), ["SEM_CAPACIDADE"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, fotosAtivas: 5 }), ["POUCAS_FOTOS"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, fotosReferencia: null }), ["SEM_MES_DAS_FOTOS"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, outraFestaSimultanea: null }), ["SEM_OUTRA_FESTA"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, outraFestaSimultanea: false }), []);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, declaracaoVersao: 6 }), ["SEM_DECLARACAO"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, declaracaoVersao: null }), ["SEM_DECLARACAO"]);
  assert.deepEqual(pendenciasPublicacao({ ...pronto, declaracaoVersao: null, fotosAtivas: 0 }, { semDeclaracao: true }), ["POUCAS_FOTOS"]);
});

test("mês em São Paulo com relógio injetado: virada de mês e de fuso; mês futuro recusado; fotos antigas só avisam", () => {
  // 01/11 01:30 UTC ainda é 31/10 22:30 em São Paulo.
  assert.equal(mesAtualSaoPaulo(new Date("2026-11-01T01:30:00Z")), "2026-10-01");
  assert.equal(mesAtualSaoPaulo(new Date("2026-11-01T03:30:00Z")), "2026-11-01");
  const agora = new Date("2026-11-01T01:30:00Z");
  assert.equal(mesDasFotos("2026-10", agora), "2026-10-01");
  assert.equal(mesDasFotos("2026-11", agora), null);
  assert.equal(mesDasFotos("2026-13", agora), null);
  assert.equal(mesDasFotos("26-10", agora), null);
  assert.equal(fotosAntigas("2025-10-01", new Date("2026-10-15T12:00:00Z")), false); // 12 meses
  assert.equal(fotosAntigas("2025-09-01", new Date("2026-10-15T12:00:00Z")), true);
  assert.equal(fotosAntigas(null), false);
});

test("idade sugerida: união das dicas; itens sem dica não contam", () => {
  assert.equal(idadeSugerida([]), null);
  assert.equal(idadeSugerida([{ idadeMin: null, idadeMax: null }]), null);
  assert.deepEqual(idadeSugerida([{ idadeMin: 4, idadeMax: 12 }, { idadeMin: 0, idadeMax: 3 }, { idadeMin: null, idadeMax: null }]), { min: 0, max: 12 });
});

test("texto normalizado como o CHECK do banco", () => {
  assert.equal(normalizarTexto("  Tirolesa   gigante \n"), "Tirolesa gigante");
});

/** Aplica um plano sobre um mapa de ordens e confere unicidade a cada passo (como o índice parcial do banco). */
function aplicar(atuais: { id: string; ordem: number }[], plano: NonNullable<ReturnType<typeof planejarReordenacao>>) {
  const ordem = new Map(atuais.map((f) => [f.id, f.ordem]));
  for (const passo of [...plano.temporarias, ...plano.finais]) {
    ordem.set(passo.id, passo.ordem);
    const valores = [...ordem.values()];
    assert.equal(new Set(valores).size, valores.length, "duas fotos ativas na mesma ordem durante a reordenação");
    assert.ok(passo.ordem >= 1 && passo.ordem <= ORDEM_MAXIMA);
  }
  return ordem;
}

test("reordenação: todas as permutações de até 4 fotos em ordens adversariais (inclusive 31999/32000) sem colisão", () => {
  const conjuntosDeOrdens = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 1001, 1002, 32000], [31997, 31998, 31999, 32000], [2, 3, 4, 5]];
  const permutar = <T,>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutar([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));
  let casos = 0;
  for (const ordens of conjuntosDeOrdens) {
    for (let n = 0; n <= 4; n++) {
      const atuais = ordens.slice(0, n).map((o, i) => ({ id: `f${i}`, ordem: o }));
      for (const finais of permutar(atuais.map((f) => f.id))) {
        const plano = planejarReordenacao(atuais, finais);
        assert.ok(plano);
        const fim = aplicar(atuais, plano);
        assert.deepEqual(finais.map((id) => fim.get(id)), finais.map((_, i) => i + 1));
        casos++;
      }
    }
  }
  assert.ok(casos > 100);
  // 8 fotos com as maiores ordens possíveis.
  const oito = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, ordem: ORDEM_MAXIMA - i }));
  const plano = planejarReordenacao(oito, oito.map((f) => f.id).reverse());
  assert.ok(plano);
  aplicar(oito, plano);
});

test("reordenação: lista incompleta, com sobra, repetida ou alheia é recusada (null)", () => {
  const atuais = [{ id: "a", ordem: 1 }, { id: "b", ordem: 2 }];
  assert.equal(planejarReordenacao(atuais, ["a"]), null);
  assert.equal(planejarReordenacao(atuais, ["a", "b", "c"]), null);
  assert.equal(planejarReordenacao(atuais, ["a", "a"]), null);
  assert.equal(planejarReordenacao(atuais, ["a", "x"]), null);
  assert.deepEqual(planejarReordenacao([], []), { temporarias: [], finais: [] });
});

test("ordem da foto nova: n+1 se livre; ocupado pede compactação", () => {
  assert.equal(ordemDaNovaFoto([]), 1);
  assert.equal(ordemDaNovaFoto([{ ordem: 1 }, { ordem: 32000 }]), 3);
  assert.equal(ordemDaNovaFoto([{ ordem: 1 }, { ordem: 3 }]), null);
});

test("frase de convivência: nunca esconde a outra festa possível", () => {
  assert.equal(fraseConvivencia(null, []), null);
  assert.equal(fraseConvivencia(false, []), "Nenhuma outra festa no buffet no mesmo horário.");
  assert.equal(fraseConvivencia(true, []), "O outro salão pode receber outra festa no mesmo horário.");
  assert.match(fraseConvivencia(true, ["ENTRADA", "BRINQUEDOS", "BANHEIROS"]) ?? "", /outra festa.*entrada, brinquedos e banheiros próprios/);
});

test("tradução de erro: só SQLSTATE + constraint conhecidos da 102; o resto segue intacto", () => {
  assert.match(mensagemErroSalao({ code: "23514", constraint: "agenda_saloes_102_sentados_ck" }) ?? "", /sentados/);
  assert.match(mensagemErroSalao({ code: "23514", constraint: "agenda_salao_fotos_limite_ck" }) ?? "", /8 fotos/);
  assert.equal(mensagemErroSalao({ code: "23514", constraint: "outra_tabela_ck" }), null);
  assert.equal(mensagemErroSalao({ code: "40P01", constraint: "agenda_saloes_102_sentados_ck" }), null);
  assert.equal(mensagemErroSalao({ code: "23514" }), null);
  assert.equal(mensagemErroSalao(new Error("x")), null);
  assert.equal(mensagemErroSalao(null), null);
});
