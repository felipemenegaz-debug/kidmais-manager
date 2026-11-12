import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { aniversariantesDoCliente } from "./repositorio.ts";

// O documento importado costuma vir sem acento: a mesma criança não pode ganhar um segundo cadastro por causa disso.
test("importação acha os aniversariantes equivalentes do cliente sem depender de acento (NFC ou NFD), caixa ou espaços", { timeout: 180_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const db = await conectarDescartavel();
  try {
    await db.query(`CREATE TEMP TABLE aniversariantes (id uuid PRIMARY KEY, cliente_id uuid NOT NULL, nome text NOT NULL, ativo boolean NOT NULL DEFAULT true, criado_em timestamptz NOT NULL)`);
    const cliente = randomUUID(), outroCliente = randomUUID();
    const inserir = async (clienteId: string, nome: string, ativo: boolean, criadoEm: string) => {
      const id = randomUUID();
      await db.query(`INSERT INTO aniversariantes (id, cliente_id, nome, ativo, criado_em) VALUES ($1, $2, $3, $4, $5)`, [id, clienteId, nome, ativo, criadoEm]);
      return id;
    };
    const ids = async (nome: string, clienteId = cliente) => (await aniversariantesDoCliente(db, clienteId, nome)).map((a) => a.id);
    const joao = await inserir(cliente, "João Sintético", true, "2026-01-01T00:00:00Z");
    await inserir(cliente, "Inativa Sintética", false, "2026-01-01T00:00:00Z");
    await inserir(outroCliente, "Só do Outro", true, "2026-01-01T00:00:00Z");

    const nfd = "João Sintético".normalize("NFD");
    assert.notEqual(nfd, "João Sintético", "a fixture tem de estar mesmo decomposta");
    for (const grafia of ["João Sintético", "Joao Sintetico", "JOAO SINTETICO", "  joão   sintético ", nfd]) {
      assert.deepEqual(await ids(grafia), [joao], JSON.stringify(grafia));
    }
    assert.deepEqual(await ids("Joana Sintetico"), [], "nome diferente continua novo");
    assert.deepEqual(await ids("Inativa Sintetica"), [], "inativo não é reaproveitado");
    assert.deepEqual(await ids("So do Outro"), [], "outro cliente fica de fora");

    // Nome já gravado decomposto também é achado, e todos os equivalentes voltam, do mais antigo ao mais novo: a escolha é do operador.
    const decomposto = await inserir(cliente, nfd, true, "2026-02-01T00:00:00Z");
    const semAcento = await inserir(cliente, "Joao  Sintetico", true, "2026-03-01T00:00:00Z");
    for (const grafia of ["João Sintético", "Joao Sintetico", nfd]) {
      assert.deepEqual(await ids(grafia), [joao, decomposto, semAcento], JSON.stringify(grafia));
    }

    // Toda letra latina com decomposição canônica: composta e decomposta dão o mesmo resultado, gravada ou digitada.
    const clienteLatim = randomUUID();
    let letras = 0;
    for (let cp = 0x00c0; cp <= 0x024f; cp++) {
      const letra = String.fromCodePoint(cp);
      const decomposta = letra.normalize("NFD");
      if (decomposta === letra) continue;
      letras++;
      const gravadaNfc = await inserir(clienteLatim, `Nome ${letra}${cp}`, true, "2026-01-01T00:00:00Z");
      const gravadaNfd = await inserir(clienteLatim, `Nome ${decomposta}${cp}`, true, "2026-01-02T00:00:00Z");
      for (const digitado of [`Nome ${letra}${cp}`, `Nome ${decomposta}${cp}`, `nome ${decomposta.normalize("NFD").replace(/[\u0300-\u036f]/g, "")}${cp}`]) {
        assert.deepEqual(await ids(digitado, clienteLatim), [gravadaNfc, gravadaNfd], `U+${cp.toString(16)} ${JSON.stringify(digitado)}`);
      }
    }
    assert.ok(letras > 100, "a varredura precisa cobrir o alfabeto latino estendido");
    for (const [composto, sem] of [["Ýuri", "Yuri"], ["Åsa", "Asa"], ["Šimon", "Simon"]]) {
      const id = await inserir(cliente, composto, true, "2026-01-01T00:00:00Z");
      for (const grafia of [composto, composto.normalize("NFD"), sem]) assert.deepEqual(await ids(grafia), [id], grafia);
    }
    // Letra sem decomposição canônica não vira outra: a política é só a das marcas combinantes.
    const oTracado = await inserir(cliente, "Bjørn", true, "2026-01-01T00:00:00Z");
    assert.deepEqual(await ids("Bjørn"), [oTracado]);
    assert.deepEqual(await ids("Bjorn"), []);
    // ...mas a caixa dessas letras é ignorada, em qualquer locale do banco.
    assert.deepEqual(await ids("BJØRN"), [oTracado]);
    const eleTracado = await inserir(cliente, "Łukasz", true, "2026-01-01T00:00:00Z");
    for (const grafia of ["Łukasz", "łukasz", "ŁUKASZ"]) assert.deepEqual(await ids(grafia), [eleTracado], grafia);
    assert.deepEqual(await ids("Lukasz"), []);
    const eszett = await inserir(cliente, "Weiß", true, "2026-01-01T00:00:00Z");
    assert.deepEqual(await ids("WEIẞ"), [eszett]);
    assert.deepEqual(await ids("Weiss"), []);

    // Sem corte: 21 ou mais equivalentes continuam todos disponíveis para a escolha.
    const clienteMuitos = randomUUID();
    const muitos: string[] = [];
    for (let i = 0; i < 25; i++) muitos.push(await inserir(clienteMuitos, i % 2 ? "Lía" : "Lia", true, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    assert.deepEqual(await ids("Lia", clienteMuitos), muitos);
  } finally {
    await encerrarDescartavel(db);
  }
});
