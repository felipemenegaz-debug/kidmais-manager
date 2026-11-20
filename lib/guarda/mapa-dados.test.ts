import assert from "node:assert/strict";
import test from "node:test";
import { CLASSES, CLASSES_POR_MEDIDA, colunasDaClasse, conferirMapa, MAPA } from "./mapa-dados.ts";
import { MEDIDAS } from "./plano-lote.ts";

/** Guarda fase 3 (20/11/2026): invariantes do mapa dos dados pessoais (a cobertura do schema é da suíte .postgres). */
test("classes válidas e colunas-chave do cliente, do contrato e das campanhas no lugar certo", () => {
  for (const [t, cs] of Object.entries(MAPA)) for (const [c, k] of Object.entries(cs)) assert.ok(CLASSES.includes(k), `${t}.${c}: ${k}`);
  for (const c of ["nome_completo", "cpf", "rg", "email", "telefone", "whatsapp", "logradouro", "cnpj"]) assert.equal(MAPA.clientes[c], "CLIENTE", c);
  for (const c of ["nome", "observacoes"]) assert.equal(MAPA.aniversariantes[c], "CLIENTE");
  for (const c of ["cpf", "nome", "email", "telefone"]) assert.equal(MAPA.responsaveis_adicionais[c], "CLIENTE");
  assert.equal(MAPA.contrato_versoes.snapshot, "CONTRATO");
  assert.equal(MAPA.contrato_documentos.conteudo_pdf, "CONTRATO");
  assert.equal(MAPA.contrato_assinaturas.identidade_snapshot, "CONTRATO");
  assert.equal(MAPA.pagamento_devolucoes.beneficiario_snapshot, "CONTRATO");
  assert.equal(MAPA.festa_pessoas.nome, "CONTRATO");
  assert.equal(MAPA.convite_familias.nome, "CONTRATO");
  for (const c of ["nome", "email", "telefone", "mensagem"]) assert.equal(MAPA.marketing_contatos[c], "CAMPANHA");
  assert.equal(MAPA.whatsapp_atendimento_conversas.contato, "CAMPANHA");
  assert.equal(MAPA.whatsapp_atendimento_mensagens.texto, "CAMPANHA");
  assert.equal(MAPA.satisfacao_respostas.comentario, "CAMPANHA");
  assert.equal(MAPA.usuarios_administrativos.email, "EMPRESA");
});

test("marca de saída é a única coisa preservada; cada medida alcança só as suas classes", () => {
  assert.deepEqual(colunasDaClasse("PRESERVAR_SAIDA"), [{ tabela: "marketing_saidas_contato", coluna: "valor" }]);
  assert.deepEqual(Object.keys(CLASSES_POR_MEDIDA).sort(), [...MEDIDAS].sort());
  for (const m of MEDIDAS) for (const k of ["EMPRESA", "SEM_DADO_PESSOAL", "PRESERVAR_SAIDA"] as const) assert.ok(!CLASSES_POR_MEDIDA[m].includes(k), `${m} ${k}`);
  assert.ok(!CLASSES_POR_MEDIDA.PARAR_CAMPANHA.includes("CONTRATO") && !CLASSES_POR_MEDIDA.PARAR_CAMPANHA.includes("CLIENTE"));
  assert.ok(!CLASSES_POR_MEDIDA.ELIMINAR_SO_CONTRATO.includes("CAMPANHA") && !CLASSES_POR_MEDIDA.ELIMINAR_SO_CONTRATO.includes("CLIENTE"));
  for (const k of ["CLIENTE", "CONTRATO", "CAMPANHA", "HISTORICO"] as const) assert.ok(CLASSES_POR_MEDIDA.ANONIMIZAR_TUDO.includes(k));
});

test("conferirMapa aponta coluna nova sem classe e coluna citada que sumiu", () => {
  const todas = Object.entries(MAPA).flatMap(([tabela, cs]) => Object.keys(cs).map((coluna) => ({ tabela, coluna })));
  assert.deepEqual(conferirMapa(todas), { faltam: [], sobram: [] });
  const r = conferirMapa([...todas.filter((x) => !(x.tabela === "clientes" && x.coluna === "rg")), { tabela: "clientes", coluna: "apelido" }]);
  assert.deepEqual(r, { faltam: ["clientes.apelido"], sobram: ["clientes.rg"] });
});
