import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { abrirAcao, acaoInicial, confirmarAcao, finalizarAcao } from "./submissao.ts";

test("FestaFinanceiro não dispara segunda baixa durante o envio de R$40", () => {
  const pedidos: Array<{ valor: number; chave: string }> = [];
  let gerouOutraChave = false;
  let acao = abrirAcao(acaoInicial(), () => "chave-festa");
  const envio = confirmarAcao(acao);
  assert.ok(envio);
  acao = envio;
  pedidos.push({ valor: 40, chave: acao.chave ?? "" });

  const durante = abrirAcao(acao, () => {
    gerouOutraChave = true;
    return "chave-nova";
  });
  assert.equal(durante, acao);
  assert.equal(durante.fase, "submitting");
  assert.equal(durante.chave, "chave-festa");
  assert.equal(confirmarAcao(durante), null);
  assert.equal(gerouOutraChave, false);
  assert.deepEqual(pedidos, [{ valor: 40, chave: "chave-festa" }]);

  const falha = finalizarAcao(acao, "erro");
  assert.equal(falha.fase, "error");
  assert.equal(falha.chave, "chave-festa");
  const retry = confirmarAcao(falha);
  assert.equal(retry?.fase, "submitting");
  assert.equal(retry?.chave, "chave-festa");
});

test("a tela da festa usa a mesma máquina e desabilita a ação enquanto envia", () => {
  const fonte = readFileSync(new URL("../../components/festas/FestaFinanceiro.tsx", import.meta.url), "utf8");
  assert.match(fonte, /abrirAcao/);
  assert.match(fonte, /confirmarAcao/);
  assert.match(fonte, /disabled=\{acao\.fase === 'submitting'\}/);
});
