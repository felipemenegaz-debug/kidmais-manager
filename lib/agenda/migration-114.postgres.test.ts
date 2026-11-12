import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, dia, type Cenario } from "../../scripts/integracao-importados-test-support.ts";

/**
 * Plano "liberar agenda com mais de um salão" (D-LIB-6, migration 114; bateria D), no PostgreSQL DESCARTÁVEL (modelo 114):
 * - gatilho BEFORE de fechamentos (kidmais019_lock_ocupacao): sem a trava da configuração da empresa, KD114 e nada gravado;
 *   com a compartilhada ou a exclusiva, grava; a trava de OUTRA empresa não serve; trocar a empresa exige também a antiga;
 * - down: devolve os corpos da cadeia 108/109 (hash do precheck da 114) e remove a função; sem a 114, grava sem trava;
 * - up de novo: corpos da 114 (hash do postcheck); segunda aplicação e down repetido recusam sem alterar nada.
 * Os demais gatilhos (contratos, contrato_fluxos, fechamento_revisoes) usam a mesma função e são exercidos pelas suítes
 * funcionais no modelo 114 (as entradas travam antes).
 */
const UP = readFileSync("database/migrations/20261031_114_trava_configuracao_gatilhos.sql", "utf8");
const DOWN = readFileSync("database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql", "utf8");
const CORPOS_114 = { lock: "2518c5bf7646946705955cd2875c09d432935d02f42a1d6f276e14f4b9c9dfd0", revisao: "dcbfd2b296635249273d36a2593baf15eefb27fa9628523357df4b56476638a1" };
const CORPOS_109 = { lock: "eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880", revisao: "8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24" };

let a: Client;
test.before(async () => { a = await conectarDescartavel(); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

async function corpos() {
  const h = (assinatura: string) => `(SELECT encode(sha256(convert_to(replace(prosrc,E'\\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid = to_regprocedure('public.${assinatura}'))`;
  return (await a.query<{ lock: string; revisao: string; f114: boolean }>(
    `SELECT ${h("kidmais019_lock_ocupacao()")} AS lock, ${h("kidmais_validar_agenda_revisao()")} AS revisao,
            to_regprocedure('public.kidmais114_exigir_configuracao(uuid)') IS NOT NULL AS f114`)).rows[0]!;
}
const travar = (empresa: string, modo: "" | "_shared" = "_shared") =>
  a.query(`SELECT pg_advisory_xact_lock${modo}(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [empresa]);

/** INSERT de festa sem salão (a guarda de escritores ignora salão nulo); devolve o id. */
async function inserir(c: Cenario, data: string) {
  return (await a.query<{ id: string }>(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      SELECT $1::date, '15:00', '19:00', (SELECT id FROM configuracao_agenda WHERE codigo = $4), $2::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $3::uuid RETURNING fechamentos.id::text AS id`,
    [data, c.empresa, c.pacote, c.agendaCodigo])).rows[0]!.id;
}
const kd114 = (e: unknown) => (e as { code?: string }).code === "KD114";
async function contar(c: Cenario) {
  return Number((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0]!.n);
}

test("114: corpos instalados são os do postcheck", async () => {
  assert.deepEqual(await corpos(), { ...CORPOS_114, f114: true });
});

test("114: INSERT/UPDATE de fechamentos sem a trava da empresa = KD114 e nada gravado; com a trava (compartilhada ou exclusiva) grava", async () => {
  const c = await cenario(a, 0);
  const outra = await cenario(a, 0);
  const D = dia(80);
  await a.query("BEGIN");
  await assert.rejects(inserir(c, D), kd114, "sem trava");
  await a.query("ROLLBACK");
  await a.query("BEGIN");
  await travar(outra.empresa);
  await assert.rejects(inserir(c, D), kd114, "trava de outra empresa");
  await a.query("ROLLBACK");
  await a.query("BEGIN");
  await a.query(`SELECT set_config('kidmais.agenda_config_empresa', $1::text, true)`, [c.empresa]);
  await assert.rejects(inserir(c, D), kd114, "só a variável da entrada");
  await a.query("ROLLBACK");
  assert.equal(await contar(c), 0, "nada gravado");

  await a.query("BEGIN"); await travar(c.empresa); const f = await inserir(c, D); await a.query("COMMIT");
  await a.query("BEGIN"); await travar(c.empresa, ""); await inserir(c, dia(81)); await a.query("COMMIT");
  assert.equal(await contar(c), 2);

  // UPDATE: sem trava recusa; mudar a empresa exige também a trava da empresa antiga.
  await a.query("BEGIN");
  await assert.rejects(a.query(`UPDATE fechamentos SET convidados = 11 WHERE id = $1::uuid`, [f]), kd114, "UPDATE sem trava");
  await a.query("ROLLBACK");
  await a.query("BEGIN");
  await travar(outra.empresa);
  // A 053/054 já tornam a empresa do fechamento imutável; o ramo OLD da 114 é defesa em profundidade. Para exercê-lo
  // isolado, os gatilhos de empresa da 053/054 ficam desligados SÓ nesta transação (o ROLLBACK desfaz o DDL).
  for (const g of ["fechamentos_053_empresa_trg", "fechamentos_054_empresa_imutavel_trg", "fechamentos_054_empresa_coerente_trg"]) {
    await a.query(`ALTER TABLE fechamentos DISABLE TRIGGER ${g}`);
  }
  await assert.rejects(a.query(
    `UPDATE fechamentos f SET empresa_id = $2::uuid, pacote_id = p.id, tabela_preco_id = pp.tabela_preco_id, preco_pacote_id = pp.id
       FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE f.id = $1::uuid AND p.id = $3::uuid`,
    [f, outra.empresa, outra.pacote]), kd114, "só a empresa nova travada");
  await a.query("ROLLBACK");
  assert.equal((await a.query(`SELECT empresa_id::text AS e, convidados FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0].e, c.empresa);
});

test("114: down devolve os corpos da 108/109 e tira a verificação; up de novo reinstala; repetições recusam sem mudar nada", async () => {
  await a.query("ROLLBACK").catch(() => undefined); // isola de uma falha do teste anterior
  const c = await cenario(a, 0);
  await a.query(DOWN);
  assert.deepEqual(await corpos(), { ...CORPOS_109, f114: false });
  await assert.rejects(a.query(DOWN), /114 down: precheck falhou/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.deepEqual(await corpos(), { ...CORPOS_109, f114: false }, "down repetido não muda nada");
  // Sem a 114, o gatilho volta a gravar sem a trava (comportamento da cadeia 109).
  await a.query("BEGIN"); await inserir(c, dia(82)); await a.query("COMMIT");
  assert.equal(await contar(c), 1);

  await a.query(UP);
  assert.deepEqual(await corpos(), { ...CORPOS_114, f114: true });
  await assert.rejects(a.query(UP), /114: precheck falhou \(já aplicada\)/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.deepEqual(await corpos(), { ...CORPOS_114, f114: true }, "up repetido não muda nada");
  await a.query("BEGIN");
  await assert.rejects(inserir(c, dia(83)), kd114, "com a 114 de volta, sem trava recusa");
  await a.query("ROLLBACK");
});
