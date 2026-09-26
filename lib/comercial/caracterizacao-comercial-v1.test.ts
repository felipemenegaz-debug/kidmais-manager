import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { LIMITES_PIZZA_PARTY, PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";
import { MODELOS_OFICIAIS } from "../contratos/documento/oficial/configuracao.ts";

const migrations = readdirSync("database/migrations").filter((nome) => nome.endsWith(".sql"));

test("characterização: sete pacotes no seed, sem duração persistida e sem empresa", () => {
  const seed = readFileSync("database/migrations/20260907_006_comercial_base.sql", "utf8");
  const insert = seed.slice(seed.indexOf("INSERT INTO pacotes"));
  assert.match(insert, /'POCKET'/);
  assert.match(insert, /'MINI_FESTA'/);
  assert.match(insert, /'COMPACTA'/);
  assert.match(insert, /'ESSENCIAL'/);
  assert.match(insert, /'COMPLETA'/);
  assert.match(insert, /'PREMIUM'/);
  assert.match(insert, /'PIZZA_PARTY'/);
  assert.doesNotMatch(insert.slice(0, insert.indexOf("VALUES")), /duracao_minutos/);
  assert.doesNotMatch(seed.slice(seed.indexOf("CREATE TABLE pacotes"), seed.indexOf("CREATE INDEX pacotes_ativos_idx")), /empresa_id/);
  assert.deepEqual(
    PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.codigo),
    ["POCKET", "MINI_FESTA", "COMPACTA", "ESSENCIAL", "COMPLETA", "PREMIUM", "PIZZA_PARTY"],
  );
});

test("characterização: 020 e 026–028 continuam ausentes; a 029 não faz backfill", () => {
  assert.equal(migrations.some((nome) => nome.includes("_020_")), false);
  assert.equal(migrations.some((nome) => /_02[6-8]_/.test(nome)), false);
  const fotografia = readFileSync("database/migrations/20260926_029_fechamento_pacote_snapshot.sql", "utf8");
  assert.match(fotografia, /CREATE TRIGGER fechamento_pacote_snapshots_imutavel/);
  assert.match(fotografia, /CREATE TRIGGER fechamento_pacote_composicao_imutavel/);
  assert.equal(fotografia.includes("UPDATE fechamentos"), false);
  assert.equal(fotografia.includes("240"), false);
});

test("characterização: schema 1 ainda lê o cadastro vivo; schema 2 preserva o nome congelado", () => {
  const repositorio = readFileSync("lib/contratos/repositories/contrato.repository.ts", "utf8");
  assert.match(repositorio, /JOIN pacotes p ON p\.id = f\.pacote_id/);
  assert.match(repositorio, /JOIN tabelas_preco tp ON tp\.id = f\.tabela_preco_id/);
  const pdf = readFileSync("lib/contratos/documento/oficial/festas-v2.ts", "utf8");
  assert.match(pdf, /schemaVersao === 2 \? snapshot\.pacoteAplicado\.nome/);
  assert.match(pdf, /if \(!nomeCongelado\) snapshot\.evento\.pacote\.nome = perfil\.pacoteNome/);
  assert.equal(MODELOS_OFICIAIS.COMPLETA.pacoteNome, "Festa Completa");
  assert.equal(Object.keys(MODELOS_OFICIAIS).length, 7);
});

test("characterização: troca administrativa pré-assinatura cria nova fotografia", () => {
  const edicao = readFileSync("lib/fechamentos/services/edicao-administrativa.service.ts", "utf8");
  const fechamento = readFileSync("lib/fechamentos/services/fechamento.service.ts", "utf8");
  assert.match(edicao, /const pacoteMudou = f\.pacoteId !== input\.pacoteId/);
  assert.match(edicao, /gravarCorrecaoFotografiaPacote/);
  assert.match(edicao, /Após assinatura, prepare a alteração em uma nova versão pelo painel de Contratos/);
  assert.match(fechamento, /await gravarFotografiaPacoteFechamento\(tx, fechamento, resumoComercial\)/);
  assert.match(edicao, /Após assinatura, prepare a alteração em uma nova versão pelo painel de Contratos/);
});

test("characterização: inclusos vêm da composição e a 023 não inclui salada premium na Completa", () => {
  const edicao = readFileSync("lib/fechamentos/services/edicao-administrativa.service.ts", "utf8");
  assert.match(edicao, /listarCodigosInclusos/);
  assert.equal(edicao.includes("const completa = ["), false);
  const matriz = readFileSync("database/migrations/20260923_023_adicionais_por_pacote.sql", "utf8");
  assert.match(matriz, /WHEN a\.codigo = 'SALADA_PREMIUM' AND p\.codigo = 'PREMIUM' THEN 'INCLUSO'/);
  assert.equal(/SALADA_PREMIUM' AND p\.codigo = 'COMPLETA' THEN 'INCLUSO'/.test(matriz), false);
  assert.match(matriz, /COMBO_ADULTOS','COMBO_LANCHINHOS'\)\s+AND p\.codigo = 'COMPLETA' THEN 'INDISPONIVEL'/);
});

test("characterização: Pizza 20–100 e duração de marketing não são histórico persistido", () => {
  assert.deepEqual(LIMITES_PIZZA_PARTY, { minimo: 20, maximo: 100 });
  const catalogo = readFileSync("components/fechamento/data.ts", "utf8");
  assert.match(catalogo, /duracao: "3 horas de festa \+ 30 minutos de tolerância sem buffet e sem subsolo\."/);
  assert.equal(catalogo.includes("duracaoMinutos: 240"), false);
  const precos = readFileSync("lib/comercial/services/pricing.service.ts", "utf8");
  assert.match(precos, /A Festa Compacta possui preço automático somente para a condição comercial configurada/);
});
