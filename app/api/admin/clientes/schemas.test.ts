import assert from "node:assert/strict";
import test from "node:test";
import { aniversarianteSchema } from "./schemas.ts";

test("cadastro independente de aniversariante aceita os campos mínimos e opcionais", () => {
  assert.equal(aniversarianteSchema.safeParse({ nome: "Criança Fictícia" }).success, true);
  assert.equal(aniversarianteSchema.safeParse({
    nome: "Criança Fictícia",
    dataNascimento: "2023-09-12",
    temaPadrao: "Tema sintético",
    observacoes: null,
  }).success, true);
});

test("cadastro de aniversariante recusa nome curto, data inválida e campos inesperados", () => {
  assert.equal(aniversarianteSchema.safeParse({ nome: "A" }).success, false);
  assert.equal(aniversarianteSchema.safeParse({ nome: "Criança Fictícia", dataNascimento: "12/09/2023" }).success, false);
  assert.equal(aniversarianteSchema.safeParse({ nome: "Criança Fictícia", clienteId: "forjado" }).success, false);
});
