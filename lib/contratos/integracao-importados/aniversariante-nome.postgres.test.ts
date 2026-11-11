import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { aniversarianteDoCliente } from "./repositorio.ts";

// O documento importado costuma vir sem acento ou com espaços a mais: a mesma criança não pode ganhar um segundo cadastro
// por isso. Só vincula sozinho quando há exatamente um cadastro equivalente; com dois ou mais, fica como antes (novo).
test("importação vincula o aniversariante equivalente só quando ele é o único; nome igual continua valendo", { timeout: 180_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const db = await conectarDescartavel();
  try {
    await db.query(`CREATE TEMP TABLE aniversariantes (id uuid PRIMARY KEY, cliente_id uuid NOT NULL, nome text NOT NULL, ativo boolean NOT NULL DEFAULT true, criado_em timestamptz NOT NULL)`);
    const inserir = async (clienteId: string, nome: string, ativo: boolean, criadoEm: string) => {
      const id = randomUUID();
      await db.query(`INSERT INTO aniversariantes (id, cliente_id, nome, ativo, criado_em) VALUES ($1, $2, $3, $4, $5)`, [id, clienteId, nome, ativo, criadoEm]);
      return id;
    };
    const achar = (clienteId: string, nome: string) => aniversarianteDoCliente(db, clienteId, nome);

    // Um único cadastro equivalente: qualquer grafia vincula a ele.
    const cliente = randomUUID(), outroCliente = randomUUID();
    const joao = await inserir(cliente, "João Sintético", true, "2026-01-01T00:00:00Z");
    await inserir(cliente, "Inativa Sintética", false, "2026-01-01T00:00:00Z");
    await inserir(outroCliente, "Só do Outro", true, "2026-01-01T00:00:00Z");
    const nfd = "João Sintético".normalize("NFD");
    assert.notEqual(nfd, "João Sintético", "a fixture tem de estar mesmo decomposta");
    for (const grafia of ["João Sintético", "Joao Sintetico", "JOAO SINTETICO", "  joão   sintético ", "Joao\tSintetico", nfd]) {
      assert.equal(await achar(cliente, grafia), joao, JSON.stringify(grafia));
    }
    assert.equal(await achar(cliente, "Joana Sintetico"), null, "nome diferente continua novo");
    assert.equal(await achar(cliente, "Inativa Sintetica"), null, "inativo não é reaproveitado");
    assert.equal(await achar(cliente, "So do Outro"), null, "outro cliente fica de fora");
    for (const [gravado, lido] of [["Cecília Ávila", "CECILIA AVILA"], ["Ênio Gonçalves", "enio goncalves"], ["Ñandú Ü", "nandu u"]]) {
      const c = randomUUID();
      const id = await inserir(c, gravado, true, "2026-01-01T00:00:00Z");
      assert.equal(await achar(c, lido), id, lido);
    }

    // Dois equivalentes: o nome igual (sem diferenciar maiúsculas, como antes) ainda vincula; uma grafia só equivalente não adivinha.
    const dois = randomUUID();
    const comAcento = await inserir(dois, "Lía Souza", true, "2026-01-01T00:00:00Z");
    const semAcento = await inserir(dois, "Lia  Souza", true, "2026-02-01T00:00:00Z");
    assert.equal(await achar(dois, "lía souza"), comAcento, "igual ao com acento");
    assert.equal(await achar(dois, " LIA  SOUZA "), semAcento, "igual ao sem acento");
    assert.equal(await achar(dois, "Lia Souza"), null, "só equivalente a dois: cria novo, como antes");

    // Comportamento anterior preservado: dois cadastros com o mesmo nome igual vinculam ao mais antigo.
    const repetido = randomUUID();
    const antigo = await inserir(repetido, "Bia", true, "2026-01-01T00:00:00Z");
    await inserir(repetido, "bia", true, "2026-02-01T00:00:00Z");
    assert.equal(await achar(repetido, "BIA"), antigo);

    // Nome gravado em NFD e lido em NFD: a comparação antiga (igual) continua achando, como hoje em production.
    const decomposto = randomUUID();
    const joaoNfd = await inserir(decomposto, "João Decomposto".normalize("NFD"), true, "2026-01-01T00:00:00Z");
    assert.equal(await achar(decomposto, "João Decomposto".normalize("NFD")), joaoNfd, "NFD × NFD pelo nome igual");
    assert.equal(await achar(decomposto, " JOÃO DECOMPOSTO ".normalize("NFD")), joaoNfd, "NFD × NFD com caixa e pontas");

    // O igual mais recente vence o equivalente mais antigo.
    const recente = randomUUID();
    await inserir(recente, "Davi Araújo", true, "2026-01-01T00:00:00Z");
    const igualNovo = await inserir(recente, "Davi Araujo", true, "2026-03-01T00:00:00Z");
    assert.equal(await achar(recente, "davi araujo"), igualNovo);

    // Dois iguais e um terceiro só equivalente: vence o igual mais antigo; a grafia só equivalente não adivinha.
    const tres = randomUUID();
    const igualAntigo = await inserir(tres, "Rui Mendes", true, "2026-01-01T00:00:00Z");
    await inserir(tres, "rui mendes", true, "2026-02-01T00:00:00Z");
    await inserir(tres, "Ruí Mendes", true, "2026-03-01T00:00:00Z");
    assert.equal(await achar(tres, "RUI MENDES"), igualAntigo);
    assert.equal(await achar(tres, "Rui  Mendes"), null);

    // Letra fora da tabela de acentos de production não vira outra (limitação conhecida; só o nome igual vincula).
    const nordico = randomUUID();
    const bjorn = await inserir(nordico, "Bjørn", true, "2026-01-01T00:00:00Z");
    assert.equal(await achar(nordico, "Bjørn"), bjorn);
    assert.equal(await achar(nordico, "Bjorn"), null);
  } finally {
    await encerrarDescartavel(db);
  }
});
