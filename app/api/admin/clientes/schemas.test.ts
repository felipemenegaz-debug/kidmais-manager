import assert from "node:assert/strict";
import test from "node:test";
import { aniversarianteSchema, analiseCadastroSchema, clienteCadastroSchema, clientePatchSchema } from "./schemas.ts";

test("cliente PF/PJ: tipo só PF ou PJ; campos de PJ aceitos no cadastro, na edição e o CNPJ na análise", () => {
  const pj = { tipoPessoa: "PJ", nomeCompleto: "Escola Pequeno Saber Ltda", cnpj: "11.222.333/0001-81", nomeFantasia: "Pequeno Saber",
    representanteNome: "Ana Diretora", representanteCpf: "111.444.777-35", telefone: "62998765432" };
  assert.deepEqual(clienteCadastroSchema.parse(pj), pj);
  assert.equal(clienteCadastroSchema.safeParse({ ...pj, tipoPessoa: "MEI" }).success, false);
  assert.equal(clienteCadastroSchema.safeParse({ ...pj, cnpj: "1".repeat(21) }).success, false);
  assert.deepEqual(clientePatchSchema.parse({ tipoPessoa: "PF" }), { tipoPessoa: "PF" });
  assert.equal(analiseCadastroSchema.parse({ nomeCompleto: "Escola Ltda", cnpj: "11222333000181" }).cnpj, "11222333000181");
});

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
