import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDatabasePool, db } from "../lib/db/postgres";

function carregarEnvLocal() {
  if (process.env.DATABASE_URL) return;

  const arquivo = resolve(process.cwd(), ".env.local");

  if (!existsSync(arquivo)) {
    throw new Error(".env.local não encontrado na raiz do projeto.");
  }

  const conteudo = readFileSync(arquivo, "utf8");

  for (const linhaOriginal of conteudo.split(/\r?\n/)) {
    const linha = linhaOriginal.trim();

    if (!linha || linha.startsWith("#")) continue;

    const posicao = linha.indexOf("=");
    if (posicao <= 0) continue;

    const chave = linha.slice(0, posicao).trim();
    let valor = linha.slice(posicao + 1).trim();

    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }

    if (process.env[chave] === undefined) {
      process.env[chave] = valor;
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não encontrada no .env.local.");
  }
}

type ClienteRow = {
  id: string;
  cpf: string;
  nome_completo: string;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
};

type ApiResponse = {
  ok: boolean;
  situacao?: string;
  canais?: Array<{
    canal: string;
    destinoMascarado: string;
  }>;
  erro?: string;
  codigo?: string;
};

function assertNaoContem(
  respostaSerializada: string,
  valor: string | null,
  descricao: string,
) {
  if (!valor || !valor.trim()) return;

  assert.equal(
    respostaSerializada.includes(valor),
    false,
    `A resposta pública revelou ${descricao}.`,
  );
}

async function main() {
  carregarEnvLocal();

  console.log(
    "\nKidmais Manager — API consultar CPF / teste de privacidade\n",
  );

  const result = await db().query<ClienteRow>(
    `SELECT
       id,
       cpf,
       nome_completo,
       telefone,
       whatsapp,
       email,
       cep,
       logradouro,
       numero,
       bairro,
       cidade,
       uf
     FROM clientes
     WHERE status <> 'MESCLADO'
       AND cpf IS NOT NULL
       AND (
         whatsapp IS NOT NULL
         OR telefone IS NOT NULL
         OR email IS NOT NULL
       )
     ORDER BY criado_em ASC
     LIMIT 1`,
  );

  const cliente = result.rows[0];

  assert.ok(
    cliente,
    "Nenhum Cliente canônico com CPF e contato foi encontrado para o teste.",
  );

  const response = await fetch(
    `${process.env.KIDMAIS_TEST_BASE_URL ?? "http://localhost:3000"}/api/identidade/consultar-cpf`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cpf: cliente.cpf }),
    },
  );

  assert.equal(response.status, 200, `HTTP inesperado: ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = (await response.json()) as ApiResponse;

  assert.equal(body.ok, true);
  assert.equal(body.situacao, "CLIENTE_EXISTENTE");
  assert.ok(Array.isArray(body.canais));
  assert.ok(body.canais.length > 0);

  console.log("✅ CPF existente localizado sem expor cliente_id");
  console.log("✅ resposta HTTP 200 com Cache-Control: no-store");

  const serializada = JSON.stringify(body);

  assertNaoContem(serializada, cliente.id, "cliente_id");
  assertNaoContem(serializada, cliente.cpf, "CPF completo");
  assertNaoContem(serializada, cliente.nome_completo, "nome completo");
  assertNaoContem(serializada, cliente.telefone, "telefone completo");
  assertNaoContem(serializada, cliente.whatsapp, "WhatsApp completo");
  assertNaoContem(serializada, cliente.email, "e-mail completo");
  assertNaoContem(serializada, cliente.cep, "CEP");
  assertNaoContem(serializada, cliente.logradouro, "logradouro");
  assertNaoContem(serializada, cliente.numero, "número do endereço");
  assertNaoContem(serializada, cliente.bairro, "bairro");
  assertNaoContem(serializada, cliente.cidade, "cidade");
  assertNaoContem(serializada, cliente.uf, "UF");

  assert.equal("clienteId" in body, false);
  assert.equal("cliente_id" in body, false);
  assert.equal("nome" in body, false);
  assert.equal("nomeCompleto" in body, false);
  assert.equal("endereco" in body, false);

  for (const canal of body.canais) {
    assert.ok(canal.canal);
    assert.ok(canal.destinoMascarado);

    if (canal.canal === "WHATSAPP" && cliente.whatsapp) {
      assert.notEqual(canal.destinoMascarado, cliente.whatsapp);
    }

    if (canal.canal === "SMS" && cliente.telefone) {
      assert.notEqual(canal.destinoMascarado, cliente.telefone);
    }

    if (canal.canal === "EMAIL" && cliente.email) {
      assert.notEqual(canal.destinoMascarado, cliente.email);
    }
  }

  console.log("✅ nome, CPF e endereço não foram revelados");
  console.log("✅ contatos completos não foram revelados");
  console.log("✅ somente destinos mascarados foram retornados");

  console.log("\nCanais públicos retornados:");
  for (const canal of body.canais) {
    console.log(`  - ${canal.canal}: ${canal.destinoMascarado}`);
  }

  console.log(
    "\n✅ POST /api/identidade/consultar-cpf validado com Cliente existente.\n",
  );
}

main()
  .catch((error) => {
    console.error(
      "\n❌ Falha no teste HTTP de privacidade da consulta de CPF.",
    );
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
