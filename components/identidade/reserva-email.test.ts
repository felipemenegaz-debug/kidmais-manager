// Cronômetro do botão "Não recebeu? Receber por e-mail" (fechamento e contrato). Só funções puras e leitura das telas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatarCronometro, segundosAte, textoBotaoReservaEmail } from "./reserva-email.ts";

test("segundosAte arredonda para cima e nunca fica negativo", () => {
  const alvo = Date.parse("2026-11-14T12:01:00.000Z");
  assert.equal(segundosAte(alvo, alvo - 60_000), 60);
  assert.equal(segundosAte(alvo, alvo - 44_100), 45);
  assert.equal(segundosAte(alvo, alvo - 1), 1);
  assert.equal(segundosAte(alvo, alvo), 0);
  assert.equal(segundosAte(alvo, alvo + 5_000), 0);
  assert.equal(segundosAte(Number.NaN, alvo), 0);
});

test("formatarCronometro mostra minutos e segundos com dois dígitos", () => {
  assert.equal(formatarCronometro(60), "1:00");
  assert.equal(formatarCronometro(45), "0:45");
  assert.equal(formatarCronometro(5), "0:05");
  assert.equal(formatarCronometro(0), "0:00");
  assert.equal(formatarCronometro(-3), "0:00");
});

test("texto do botão: cronômetro enquanto espera, destino quando libera", () => {
  assert.equal(textoBotaoReservaEmail(false, 45, "f***@g***.com"), "Não recebeu? Receber por e-mail em 0:45");
  assert.equal(textoBotaoReservaEmail(true, 0, "f***@g***.com"), "Não recebeu? Receber por e-mail (f***@g***.com)");
  // Sem horário válido (ou relógio no limite) continua a frase neutra, sem número.
  assert.equal(textoBotaoReservaEmail(false, 0, "f***@g***.com"), "Não recebeu? Em instantes você poderá receber por e-mail");
  // O destino mascarado só aparece quando o botão pode ser usado.
  assert.doesNotMatch(textoBotaoReservaEmail(false, 30, "f***@g***.com"), /f\*\*\*/);
});

test("fechamento e contrato usam o cronômetro e o botão segue desabilitado durante a espera", () => {
  const telas = [
    ["components/fechamento/FechamentoWizard.tsx", /disabled=\{processandoIdentidade \|\| !reservaEmailLiberada\}/],
    ["components/contrato/ContratoPublico.tsx", /disabled=\{carregando \|\| !reservaLiberada\}/],
  ] as const;
  for (const [arquivo, desabilitado] of telas) {
    const tela = readFileSync(arquivo, "utf8");
    assert.match(tela, /useReservaEmailEspera\(/, arquivo);
    assert.match(tela, /textoBotaoReservaEmail\(/, arquivo);
    assert.match(tela, desabilitado, arquivo);
    assert.doesNotMatch(tela, /useReservaEmailLiberada/, arquivo);
  }
});
