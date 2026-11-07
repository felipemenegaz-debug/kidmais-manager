import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, executor, id } from "../../scripts/integracao-importados-test-support.ts";
import { concluirCota, cotaInstalada, liberarCota, reservarCota, resumoCota, resumoCotaParaTela, type Posse, type ResultadoReserva } from "./cota.ts";
import { registrarExtracao } from "./repositorio-documentos.ts";

/**
 * L2 — cota de leitura de documentos (migration 118) no PostgreSQL DESCARTÁVEL, modelo 112 (sem a 118; a suíte aplica).
 * Dados SINTÉTICOS. Ajustes de tempo (reserva vencida, período de mês anterior, marco no passado) são fixture gravada numa
 * conexão própria com session_replication_role = replica (só no cluster descartável), porque a guarda da 118 torna esses
 * campos imutáveis; o código testado sempre roda com a guarda ligada.
 *   1. precheck, aplicação, postcheck, reaplicação recusada, down vazio aceito e reaplicação; down com histórico recusado (fim);
 *   2. fronteiras exatas da janela (inicio, fim − 1 µs, fim) e do mês de São Paulo, em dois fusos de sessão;
 *   3. guarda: sem DELETE, identidade/período/prazo imutáveis, transições só a partir de RESERVADA, marco gravado uma vez,
 *      uma linha viva por arquivo;
 *   4. franquias (D-LOTE-6): sem plano mede sem recusar; Profissional 10/mês; Essencial 50 extra + 5 na implantação; Premium
 *      30/mês; mês anterior, LIBERADA e vencida não ocupam; recusa antes de gravar;
 *   5. posse (R2-1/R3-1): LEITURA_EM_ANDAMENTO, falha libera e reenvio reserva, falha tardia não reverte CONSUMIDA nem toca o
 *      sucessor, execução antiga não conclui, virada de mês;
 *   6. concorrência REAL com espera observada: último saldo (só uma passa), G1 (conclusão que espera a trava e perde a vaga ⇒
 *      LEITURA_EXPIRADA e extração desfeita; controle positivo), marco com duas conclusões, borda do fim da janela;
 *   7. janela de migração (D-LOTE-8 rev. 6.1): marco só na conclusão com dados e plano confirmado, nunca na reserva, liberação,
 *      rollback ou sem plano; extra antes da franquia; contagem por toda a janela; sobra não vira franquia; reenvios.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const PRE = ler("database/checks/20261104_118_precheck.sql");
const UP = ler("database/migrations/20261104_118_importacao_cotas.sql");
const POS = ler("database/checks/20261104_118_postcheck.sql");
const DOWN = ler("database/rollback/20261104_118_importacao_cotas_down.sql");
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let b: Client;
let f: Client;
let pidA = 0;
let pidB = 0;

test.before(async () => {
  if (!opt()) return;
  a = await conectarDescartavel();
  b = await conectarDescartavel({ travar: false });
  f = await conectarDescartavel({ travar: false });
  await f.query("SET session_replication_role = replica");
  pidA = await pidDe(a);
  pidB = await pidDe(b);
});
test.after(async () => {
  if (b) await encerrarDescartavel(b, false);
  if (f) await encerrarDescartavel(f, false);
  if (a) await encerrarDescartavel(a);
});

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidDe = async (c: Client) => (await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
/**
 * Espera observada NO SERVIDOR, por conexão à parte: o backend `alvo` está parado em trava, bloqueado por `dono`, numa
 * instrução sobre a linha da empresa. Só depois disso o teste solta a trava; sem o bloqueio, o prazo estoura e o teste falha.
 */
async function bloqueada(alvo: number, dono: number) {
  const limite = Date.now() + 20_000;
  for (;;) {
    const l = (await f.query<{ blocos: number[]; evento: string | null; instrucao: string }>(
      `SELECT pg_blocking_pids(pid) AS blocos, wait_event_type AS evento, query AS instrucao FROM pg_stat_activity WHERE pid = $1`, [alvo])).rows[0];
    if (l?.blocos.includes(dono)) {
      assert.equal(l.evento, "Lock");
      assert.ok(l.instrucao.includes("ia_importacao_cotas"), `bloqueada fora da trava da empresa: ${l.instrucao}`);
      return;
    }
    assert.ok(Date.now() < limite, `backend ${alvo} não chegou a ficar bloqueado por ${dono}`);
    await dormir(10);
  }
}
/** Posição em relação a uma fronteira, sempre pelo relógio do servidor. */
const antesDe = async (fronteira: string) => (await f.query<{ ok: boolean }>(`SELECT clock_timestamp() < $1::timestamptz AS ok`, [fronteira])).rows[0].ok;
async function passar(fronteira: string) {
  while (await antesDe(fronteira)) await dormir(20);
}
const fimDaJanela = async (E: string) => (await f.query<{ fim: string }>(`SELECT (migracao_inicio + interval '720 hours')::text AS fim FROM ia_importacao_cotas WHERE empresa_id = $1`, [E])).rows[0].fim;
type Plano = "ESSENCIAL" | "PROFISSIONAL" | "PREMIUM";

async function emTx<T>(c: Client, corpo: (db: DbExecutor) => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    const r = await corpo(executor(c));
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
const codigo = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return (e as { codigo?: string }).codigo ?? (e as Error).message; }
};
const mesAtual = async () => (await a.query<{ m: string }>(`SELECT kidmais_118_periodo_mensal(clock_timestamp()) AS m`)).rows[0].m;
const mesAnterior = async () => (await a.query<{ m: string }>(`SELECT kidmais_118_periodo_mensal(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' - interval '1 day') AS m`)).rows[0].m;

/** Empresa sintética; com plano, contratação confirmada pelas guardas reais da 067/068/074a. */
async function empresa(plano?: Plano) {
  const c = await cenario(a);
  if (plano) {
    await a.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '2 days', clock_timestamp() + interval '20 days')`, [c.empresa]);
    const contratacao = (await a.query<{ id: string }>(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos, criada_por)
      VALUES ($1, $2, $3, 'MENSAL', 'sintetico', 9900, 9900, $4) RETURNING id::text AS id`, [c.empresa, randomUUID(), plano, c.usuario])).rows[0].id;
    const sub = `sub-${randomBytes(4).toString("hex")}`;
    await a.query(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $2, provedor_assinatura_id = $3 WHERE id = $1`,
      [contratacao, `pg-${randomBytes(4).toString("hex")}`, sub]);
    await a.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', plano = $4, ciclo = 'MENSAL', provedor = 'ASAAS', contratacao_atual_id = $2, provedor_assinatura_id = $3,
        periodo_atual_fim = clock_timestamp() + interval '29 days' WHERE empresa_id = $1`, [c.empresa, contratacao, sub, plano]);
  }
  return { E: c.empresa, U: c.usuario };
}
/** Confirma um plano numa empresa que já existe (teste → pago). */
async function confirmarPlano(e: { E: string; U: string }, plano: Plano) {
  const c = { empresa: e.E, usuario: e.U };
  await a.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '2 days', clock_timestamp() + interval '20 days')`, [c.empresa]);
  const contratacao = (await a.query<{ id: string }>(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos, criada_por)
    VALUES ($1, $2, $3, 'MENSAL', 'sintetico', 9900, 9900, $4) RETURNING id::text AS id`, [c.empresa, randomUUID(), plano, c.usuario])).rows[0].id;
  const sub = `sub-${randomBytes(4).toString("hex")}`;
  await a.query(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $2, provedor_assinatura_id = $3 WHERE id = $1`,
    [contratacao, `pg-${randomBytes(4).toString("hex")}`, sub]);
  await a.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', plano = $4, ciclo = 'MENSAL', provedor = 'ASAAS', contratacao_atual_id = $2, provedor_assinatura_id = $3,
      periodo_atual_fim = clock_timestamp() + interval '29 days' WHERE empresa_id = $1`, [c.empresa, contratacao, sub, plano]);
}

type Doc = { doc: string; original: string; sha: string };
/** Documento com original real (o sha256 é conferido pela 055c). */
async function documento(e: { E: string; U: string }): Promise<Doc> {
  const doc = await id(a, `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid) RETURNING id`, [e.E, e.U]);
  const pdf = Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`);
  const r = (await a.query<{ id: string; sha: string }>(`INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 1, 'contrato.pdf', 'application/pdf', $3, encode(sha256($4), 'hex'), $4, $5::uuid) RETURNING id::text, sha256 AS sha`, [doc, e.E, pdf.length, pdf, e.U])).rows[0];
  return { doc, original: r.id, sha: r.sha };
}
const reservar = (e: { E: string }, d: Doc, c: Client = a) => emTx(c, (db) => reservarCota(db, { empresaId: e.E, documentoId: d.doc, sha256: d.sha }));
const posseDe = (r: ResultadoReserva): Posse => { assert.equal(r.tipo, "RESERVADA"); return (r as { posse: Posse }).posse; };
const concluir = (e: { E: string }, posse: Posse, comDados = true, c: Client = a) => emTx(c, (db) => concluirCota(db, { empresaId: e.E, posse, comDados }));
const liberar = (e: { E: string }, posse: Posse) => emTx(a, (db) => liberarCota(db, { empresaId: e.E, posse }));
/** Reserva e consome um documento novo; devolve o período. */
async function consumir(e: { E: string; U: string }) {
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  await concluir(e, p);
  return p.periodo;
}
const usos = async (E: string) => (await a.query<{ id: string; sha256: string; estado: string; periodo: string; operacao_id: string; atualizado_em: string }>(
  `SELECT id::text, sha256, estado, periodo, operacao_id::text, atualizado_em::text FROM ia_importacao_usos WHERE empresa_id = $1 ORDER BY criado_em, id`, [E])).rows;
const uso = async (usoId: string) => (await a.query<{ estado: string; periodo: string; atualizado_em: string }>(
  `SELECT estado, periodo, atualizado_em::text FROM ia_importacao_usos WHERE id = $1`, [usoId])).rows[0];
const marco = async (E: string) => (await a.query<{ m: string | null }>(`SELECT migracao_inicio::text AS m FROM ia_importacao_cotas WHERE empresa_id = $1`, [E])).rows[0]?.m ?? null;
/** Fixture: marco no passado (a guarda deixa gravar quando nulo). */
async function marcoEm(E: string, expressao: string) {
  await a.query(`INSERT INTO ia_importacao_cotas (empresa_id) VALUES ($1) ON CONFLICT DO NOTHING`, [E]);
  await a.query(`UPDATE ia_importacao_cotas SET migracao_inicio = ${expressao} WHERE empresa_id = $1 AND migracao_inicio IS NULL`, [E]);
}
/** Fixture: n usos num documento qualquer da empresa (sha256 sintéticos distintos). */
async function usosFixture(e: { E: string; U: string }, n: number, periodo: string, estado: string, quando = "clock_timestamp()", prazo = "interval '15 minutes'") {
  const d = await documento(e);
  await a.query(`INSERT INTO ia_importacao_cotas (empresa_id) VALUES ($1) ON CONFLICT DO NOTHING`, [e.E]);
  await a.query(`INSERT INTO ia_importacao_usos (empresa_id, sha256, documento_id, operacao_id, periodo, estado, expira_em, criado_em, atualizado_em)
    SELECT $1, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $2, gen_random_uuid(), $3, $4, (${quando}) + ${prazo}, ${quando}, ${quando} FROM generate_series(1, $5::int)`,
    [e.E, d.doc, periodo, estado, n]);
}
/** Fixture: a reserva venceu (criado/expira/atualizado recuados 16 min). */
const vencer = (usoId: string) => f.query(`UPDATE ia_importacao_usos SET criado_em = criado_em - interval '16 minutes', expira_em = expira_em - interval '16 minutes',
  atualizado_em = atualizado_em - interval '16 minutes' WHERE id = $1`, [usoId]);

test("118: precheck, aplicação, postcheck, reaplicação recusada, down vazio aceito e reaplicação", { skip: !opt(), timeout: 120_000 }, async () => {
  assert.equal(await cotaInstalada(executor(a)), false);
  await a.query(PRE);
  await a.query(UP);
  const pos = (await a.query(POS)) as unknown as Array<{ rows: Array<{ aprovado: boolean }> }>;
  assert.equal(pos.find((r) => r.rows?.[0]?.aprovado !== undefined)?.rows[0].aprovado, true);
  assert.equal(await cotaInstalada(executor(a)), true);
  await assert.rejects(a.query(UP), /118 já \(parcialmente\) presente/);
  await a.query("ROLLBACK").catch(() => {});
  await assert.rejects(a.query(PRE), /118 precheck: 118 já/);
  await a.query("ROLLBACK").catch(() => {});
  await a.query(DOWN);
  assert.equal(await cotaInstalada(executor(a)), false);
  assert.equal(await emTx(a, (db) => resumoCotaParaTela(db, randomUUID())), null, "sem as tabelas: sem linha na tela, sem erro");
  await a.query(PRE);
  await a.query(UP);
  await a.query(POS);
  assert.equal(await cotaInstalada(executor(a)), true);
});

test("118: fronteiras exatas da janela (inicio, fim − 1 µs, fim) e do mês de São Paulo, em dois fusos de sessão", { skip: !opt() }, async () => {
  for (const fuso of ["UTC", "Asia/Tokyo"]) {
    await a.query(`SET TIME ZONE '${fuso}'`);
    const r = (await a.query(`SELECT
        kidmais_118_janela_migracao(NULL, '2026-11-04T12:00:00Z') AS nulo,
        kidmais_118_janela_migracao('2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z') AS inicio,
        kidmais_118_janela_migracao('2026-11-04T12:00:00Z', '2026-11-04T11:59:59.999999Z') AS antes,
        kidmais_118_janela_migracao('2026-11-04T12:00:00Z', '2026-12-04T11:59:59.999999Z') AS fim_menos_1us,
        kidmais_118_janela_migracao('2026-11-04T12:00:00Z', '2026-12-04T12:00:00Z') AS fim,
        kidmais_118_periodo_mensal('2026-12-01T02:59:59.999999Z') AS ultimo_instante_nov_sp,
        kidmais_118_periodo_mensal('2026-12-01T03:00:00Z') AS primeiro_instante_dez_sp`)).rows[0];
    assert.deepEqual(r, { nulo: true, inicio: true, antes: false, fim_menos_1us: true, fim: false, ultimo_instante_nov_sp: "2026-11", primeiro_instante_dez_sp: "2026-12" }, fuso);
  }
  await a.query(`SET TIME ZONE 'UTC'`);
});

test("118 guarda: sem DELETE, identidade/período/prazo imutáveis, transições só de RESERVADA, marco uma vez, uma linha viva por arquivo", { skip: !opt() }, async () => {
  const e = await empresa();
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  await assert.rejects(a.query(`DELETE FROM ia_importacao_usos WHERE id = $1`, [p.usoId]), /não é apagada/);
  await assert.rejects(a.query(`UPDATE ia_importacao_usos SET periodo = 'MIGRACAO' WHERE id = $1`, [p.usoId]), /imutáveis/);
  await assert.rejects(a.query(`UPDATE ia_importacao_usos SET expira_em = expira_em + interval '1 hour' WHERE id = $1`, [p.usoId]), /imutáveis/);
  await assert.rejects(a.query(`UPDATE ia_importacao_usos SET operacao_id = gen_random_uuid() WHERE id = $1`, [p.usoId]), /imutáveis/);
  await assert.rejects(a.query(`INSERT INTO ia_importacao_usos (empresa_id, sha256, documento_id, operacao_id, periodo, estado, expira_em, criado_em, atualizado_em)
    VALUES ($1, $2, $3, gen_random_uuid(), '2026-11', 'RESERVADA', clock_timestamp() + interval '1 minute', clock_timestamp(), clock_timestamp())`, [e.E, d.sha, d.doc]), /ia_importacao_usos_vivo_uk/);
  await concluir(e, p);
  await assert.rejects(a.query(`UPDATE ia_importacao_usos SET estado = 'LIBERADA' WHERE id = $1`, [p.usoId]), /Transição de uso inválida: CONSUMIDA → LIBERADA/);
  await assert.rejects(a.query(`UPDATE ia_importacao_usos SET estado = 'RESERVADA' WHERE id = $1`, [p.usoId]), /Transição de uso inválida/);
  await assert.rejects(a.query(`DELETE FROM ia_importacao_cotas WHERE empresa_id = $1`, [e.E]), /não é apagada/);
  await marcoEm(e.E, "clock_timestamp()");
  await assert.rejects(a.query(`UPDATE ia_importacao_cotas SET migracao_inicio = migracao_inicio - interval '1 day' WHERE empresa_id = $1`, [e.E]), /não muda/);
  await assert.rejects(a.query(`UPDATE ia_importacao_cotas SET migracao_inicio = NULL WHERE empresa_id = $1`, [e.E]), /não muda/);
});

test("franquia sem plano confirmado: mede sem recusar, no mês de São Paulo, sem extra nem marco", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa();
  const mes = await mesAtual();
  for (let i = 0; i < 40; i += 1) assert.equal(await consumir(e), mes);
  assert.equal((await usos(e.E)).filter((u) => u.estado === "CONSUMIDA" && u.periodo === mes).length, 40);
  assert.equal(await marco(e.E), null);
  const r = await emTx(a, (db) => resumoCota(db, e.E));
  assert.deepEqual(r, { plano: null, franquia: { periodo: mes, usados: 40, limite: null }, migracao: null });
});

test("Profissional (janela encerrada): 10 no mês; mês anterior, LIBERADA e vencida não ocupam; 11º recusado ANTES de gravar; reenvio não conta", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '31 days'");
  const mes = await mesAtual();
  await usosFixture(e, 5, await mesAnterior(), "CONSUMIDA", "clock_timestamp() - interval '40 days'");
  await usosFixture(e, 3, mes, "LIBERADA");
  await usosFixture(e, 2, mes, "RESERVADA", "clock_timestamp() - interval '20 minutes'");
  await usosFixture(e, 4, "MIGRACAO", "CONSUMIDA", "clock_timestamp() - interval '31 days'");
  const primeiro = await documento(e);
  const p1 = posseDe(await reservar(e, primeiro));
  assert.equal(p1.periodo, mes);
  await concluir(e, p1);
  for (let i = 0; i < 9; i += 1) assert.equal(await consumir(e), mes);
  const antes = await usos(e.E);
  const extra = await documento(e);
  assert.equal(await codigo(reservar(e, extra)), "COTA_IMPORTACAO_ESGOTADA");
  assert.deepEqual(await usos(e.E), antes, "a recusa não grava nada");
  assert.deepEqual(await reservar(e, primeiro), { tipo: "JA_CONTADO" }, "reenvio do arquivo já consumido não conta");
  assert.deepEqual(await usos(e.E), antes);
  const r = await emTx(a, (db) => resumoCota(db, e.E));
  assert.deepEqual(r, { plano: "profissional", franquia: { periodo: mes, usados: 10, limite: 10 }, migracao: null });
});

test("Essencial: 50 de extra (MIGRACAO) antes das 5 da implantação, depois recusa; a reserva não grava o marco, a 1ª conclusão com dados grava", { skip: !opt(), timeout: 120_000 }, async () => {
  const e = await empresa("ESSENCIAL");
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  assert.equal(p.periodo, "MIGRACAO");
  assert.equal(await marco(e.E), null, "a reserva não grava o marco");
  await concluir(e, p);
  const m = await marco(e.E);
  assert.equal(m, (await uso(p.usoId)).atualizado_em, "marco = T da conclusão");
  const resumo1 = await emTx(a, (db) => resumoCota(db, e.E));
  assert.equal(resumo1.migracao?.usados, 1);
  assert.equal(resumo1.migracao?.extra, 50);
  assert.match(resumo1.migracao?.ate ?? "", /^\d{4}-\d{2}-\d{2}$/);
  for (let i = 0; i < 49; i += 1) assert.equal(await consumir(e), "MIGRACAO");
  for (let i = 0; i < 5; i += 1) assert.equal(await consumir(e), "IMPLANTACAO");
  const erro = await reservar(e, await documento(e)).then(() => null, (x: Error) => x);
  assert.equal((erro as { codigo?: string } | null)?.codigo, "COTA_IMPORTACAO_ESGOTADA");
  assert.match(erro!.message, /Essencial \(5 na implantação\)/);
  assert.equal(await marco(e.E), m, "o marco nunca muda");
});

test("Premium (janela encerrada): 30 no mês, 31º recusado", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PREMIUM");
  await marcoEm(e.E, "clock_timestamp() - interval '31 days'");
  const mes = await mesAtual();
  for (let i = 0; i < 30; i += 1) assert.equal(await consumir(e), mes);
  assert.equal(await codigo(reservar(e, await documento(e))), "COTA_IMPORTACAO_ESGOTADA");
});

test("marco: sem plano não nasce; leitura sem dados (LIBERADA) não nasce; rollback da conclusão não deixa marco; a próxima com dados grava", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa();
  const mes = await mesAtual();
  assert.equal(await consumir(e), mes, "sem plano confirmado: período normal, nunca MIGRACAO");
  assert.equal(await marco(e.E), null);
  await confirmarPlano(e, "PROFISSIONAL");
  const vazio = await documento(e);
  const pv = posseDe(await reservar(e, vazio));
  assert.equal(pv.periodo, "MIGRACAO", "antes do marco a janela conta como aberta");
  await concluir(e, pv, false);
  assert.equal((await uso(pv.usoId)).estado, "LIBERADA");
  assert.equal(await marco(e.E), null, "leitura sem dados não inicia a janela");
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  await a.query("BEGIN");
  await concluirCota(executor(a), { empresaId: e.E, posse: p, comDados: true });
  await a.query("ROLLBACK");
  assert.equal(await marco(e.E), null, "rollback não deixa marco");
  assert.equal((await uso(p.usoId)).estado, "RESERVADA");
  await concluir(e, p);
  assert.equal(await marco(e.E), (await uso(p.usoId)).atualizado_em);
});

test("posse conferida pelo token: usoId certo com operacao_id trocado não conclui nem libera; liberar depois do marco não mexe nele", { skip: !opt() }, async () => {
  const e = await empresa("PROFISSIONAL");
  const p0 = posseDe(await reservar(e, await documento(e)));
  await concluir(e, p0);
  const inicio = await marco(e.E);
  assert.notEqual(inicio, null);
  const p = posseDe(await reservar(e, await documento(e)));
  const forjada: Posse = { ...p, operacaoId: randomUUID() };
  assert.equal(await codigo(concluir(e, forjada)), "LEITURA_EXPIRADA", "id do uso sem o token de posse não conclui");
  assert.equal(await liberar(e, forjada), false, "id do uso sem o token de posse não libera");
  assert.equal((await uso(p.usoId)).estado, "RESERVADA");
  assert.equal(await liberar(e, p), true, "falha depois do marco libera a própria reserva");
  assert.equal((await uso(p.usoId)).estado, "LIBERADA");
  assert.equal(await marco(e.E), inicio, "liberar não zera nem move o marco");
});

test("posse: mesmo arquivo ⇒ LEITURA_EM_ANDAMENTO; falha libera e o reenvio reserva; execução antiga não conclui nem libera o sucessor; CONSUMIDA não volta", { skip: !opt() }, async () => {
  const e = await empresa();
  const d = await documento(e);
  const p1 = posseDe(await reservar(e, d));
  assert.equal(await codigo(reservar(e, d)), "LEITURA_EM_ANDAMENTO");
  assert.equal(await liberar(e, p1), true);
  const p2 = posseDe(await reservar(e, d));
  assert.notEqual(p2.operacaoId, p1.operacaoId);
  assert.equal(await liberar(e, p1), false, "liberação tardia da posse antiga não toca o sucessor");
  assert.equal(await codigo(concluir(e, p1)), "LEITURA_EXPIRADA", "conclusão da posse antiga recusada");
  assert.equal((await uso(p2.usoId)).estado, "RESERVADA");
  await concluir(e, p2);
  assert.equal(await liberar(e, p2), false, "falha tardia não reverte CONSUMIDA");
  assert.equal((await uso(p2.usoId)).estado, "CONSUMIDA");
  assert.deepEqual(await reservar(e, d), { tipo: "JA_CONTADO" });
  // Ordem invertida: sucesso primeiro, o segundo envio do mesmo arquivo não conta.
  const d2 = await documento(e);
  const q1 = posseDe(await reservar(e, d2));
  await concluir(e, q1);
  assert.deepEqual(await reservar(e, d2), { tipo: "JA_CONTADO" });
  assert.equal((await usos(e.E)).filter((u) => u.sha256 === d2.sha).length, 1);
});

test("posse tomada: reserva vencida é liberada e decidida de novo; a execução antiga recebe LEITURA_EXPIRADA; virada de mês nos dois sentidos", { skip: !opt() }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '31 days'");
  const mes = await mesAtual();
  const anterior = await mesAnterior();
  const d = await documento(e);
  const p1 = posseDe(await reservar(e, d));
  await vencer(p1.usoId);
  await f.query(`UPDATE ia_importacao_usos SET periodo = $2 WHERE id = $1`, [p1.usoId, anterior]);
  const p2 = posseDe(await reservar(e, d));
  assert.equal((await uso(p1.usoId)).estado, "LIBERADA");
  assert.equal(p2.periodo, mes, "retomada no mês seguinte: período atual, sem herdar a decisão antiga");
  assert.equal(await codigo(concluir(e, p1)), "LEITURA_EXPIRADA");
  await concluir(e, p2);
  // Reservada no mês anterior (ainda no prazo) e concluída agora: consome no mês em que ocupou o saldo.
  const d3 = await documento(e);
  const p3 = posseDe(await reservar(e, d3));
  await f.query(`UPDATE ia_importacao_usos SET periodo = $2 WHERE id = $1`, [p3.usoId, anterior]);
  await concluir(e, { ...p3, periodo: anterior });
  assert.deepEqual([(await uso(p3.usoId)).estado, (await uso(p3.usoId)).periodo], ["CONSUMIDA", anterior]);
  const r = await emTx(a, (db) => resumoCota(db, e.E));
  assert.equal(r.franquia.usados, 1, "o consumo do mês anterior não ocupa o mês atual");
});

test("concorrência: duas reservas de arquivos diferentes para o último saldo — só uma passa, com espera observada na trava", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '31 days'");
  await usosFixture(e, 9, await mesAtual(), "CONSUMIDA");
  const d1 = await documento(e);
  const d2 = await documento(e);
  await a.query("BEGIN");
  await reservarCota(executor(a), { empresaId: e.E, documentoId: d1.doc, sha256: d1.sha });
  const segunda = codigo(reservar(e, d2, b));
  await bloqueada(pidB, pidA);
  await a.query("COMMIT");
  assert.equal(await segunda, "COTA_IMPORTACAO_ESGOTADA");
  assert.equal((await usos(e.E)).filter((u) => u.estado !== "LIBERADA").length, 10);
});

test("G1: conclusão que começa antes do vencimento e só alcança a trava depois perde a vaga para B (LEITURA_EXPIRADA, extração desfeita); reenvio de A recusado", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '31 days'");
  await usosFixture(e, 9, await mesAtual(), "CONSUMIDA");
  const dA = await documento(e);
  const pA = posseDe(await reservar(e, dA));
  const dB = await documento(e);
  await f.query(`UPDATE ia_importacao_usos SET expira_em = clock_timestamp() + interval '3000 milliseconds' WHERE id = $1`, [pA.usoId]);
  const vencimento = (await f.query<{ v: string }>(`SELECT expira_em::text AS v FROM ia_importacao_usos WHERE id = $1`, [pA.usoId])).rows[0].v;
  await b.query("BEGIN");
  await b.query(`SELECT 1 FROM ia_importacao_cotas WHERE empresa_id = $1 FOR UPDATE`, [e.E]);
  await a.query("BEGIN");
  const conclusaoA = (async () => {
    await concluirCota(executor(a), { empresaId: e.E, posse: pA, comDados: true });
    await registrarExtracao(executor(a), { empresaId: e.E, documentoId: dA.doc, originalId: dA.original, metodo: "DETERMINISTICO", provedor: null, modelo: null, schemaVersao: 1,
      status: "SUCESSO", resultado: { secoes: [] }, erro: null, correlationId: "g1", iniciadoEm: new Date().toISOString(), concluidoEm: new Date().toISOString(), evidencias: [] });
  })().then(() => "OK", (x: { codigo?: string }) => x.codigo ?? String(x));
  await bloqueada(pidA, pidB);
  assert.equal(await antesDe(vencimento), true, "A chegou à trava ainda dentro do prazo");
  await passar(vencimento);
  const rB = await reservarCota(executor(b), { empresaId: e.E, documentoId: dB.doc, sha256: dB.sha });
  await b.query("COMMIT");
  assert.equal(await conclusaoA, "LEITURA_EXPIRADA");
  await a.query("ROLLBACK");
  assert.equal(posseDe(rB).periodo, await mesAtual());
  assert.equal((await uso(pA.usoId)).estado, "RESERVADA", "A não consumiu");
  assert.equal((await a.query(`SELECT count(*)::int AS n FROM ia_extracoes WHERE documento_id = $1`, [dA.doc])).rows[0].n, 0, "extração de A desfeita");
  assert.equal(await codigo(reservar(e, dA)), "COTA_IMPORTACAO_ESGOTADA", "reenvio de A: libera a vencida, B ocupa o saldo");
  assert.equal((await uso(pA.usoId)).estado, "RESERVADA", "a recusa desfez também a liberação da vencida");
  // Controle positivo: mesma espera, mas A alcança a trava ainda no prazo.
  const e2 = await empresa("PROFISSIONAL");
  await marcoEm(e2.E, "clock_timestamp() - interval '31 days'");
  const dC = await documento(e2);
  const pC = posseDe(await reservar(e2, dC));
  await b.query("BEGIN");
  await b.query(`SELECT 1 FROM ia_importacao_cotas WHERE empresa_id = $1 FOR UPDATE`, [e2.E]);
  const conclusaoC = codigo(concluir(e2, pC));
  await bloqueada(pidA, pidB);
  await b.query("COMMIT");
  assert.equal(await conclusaoC, "OK");
  assert.equal((await uso(pC.usoId)).estado, "CONSUMIDA");
});

test("marco com duas conclusões concorrentes (espera observada): fica o T da primeira e a segunda não o altera", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PREMIUM");
  const d1 = await documento(e);
  const d2 = await documento(e);
  const p1 = posseDe(await reservar(e, d1));
  const p2 = posseDe(await reservar(e, d2));
  await a.query("BEGIN");
  await concluirCota(executor(a), { empresaId: e.E, posse: p1, comDados: true });
  const segunda = codigo(concluir(e, p2, true, b));
  await bloqueada(pidB, pidA);
  await a.query("COMMIT");
  assert.equal(await segunda, "OK");
  const t1 = (await uso(p1.usoId)).atualizado_em;
  const t2 = (await uso(p2.usoId)).atualizado_em;
  assert.notEqual(t1, t2);
  assert.equal(await marco(e.E), t1);
});

test("janela: extra antes da franquia; transação que espera a trava e passa do fim usa o T depois da trava; conclusão após a janela mantém MIGRACAO; sobra não vira franquia", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '720 hours' + interval '4000 milliseconds'");
  const fim = await fimDaJanela(e.E);
  const mes = await mesAtual();
  const d1 = await documento(e);
  const p1 = posseDe(await reservar(e, d1));
  assert.equal(p1.periodo, "MIGRACAO", "controle: sem espera, dentro da janela");
  await b.query("BEGIN");
  await b.query(`SELECT 1 FROM ia_importacao_cotas WHERE empresa_id = $1 FOR UPDATE`, [e.E]);
  const d2 = await documento(e);
  const r2 = reservar(e, d2);
  await bloqueada(pidA, pidB);
  assert.equal(await antesDe(fim), true, "chegou bloqueada antes do fim da janela");
  await passar(fim);
  await b.query("COMMIT");
  assert.equal(posseDe(await r2).periodo, mes, "começou antes do fim, decidiu depois da trava: regra normal");
  await concluir(e, p1);
  assert.deepEqual([(await uso(p1.usoId)).estado, (await uso(p1.usoId)).periodo], ["CONSUMIDA", "MIGRACAO"], "conclusão depois do fim, no prazo: período original");
  for (let i = 0; i < 9; i += 1) assert.equal(await consumir(e), mes, "98 do extra sobram e não aumentam a franquia");
  assert.equal(await codigo(reservar(e, await documento(e))), "COTA_IMPORTACAO_ESGOTADA");
  const r = await emTx(a, (db) => resumoCota(db, e.E));
  assert.equal(r.migracao, null, "janela encerrada: sem extra na tela");
});

test("retomada depois do fim da janela: reserva MIGRACAO vencida volta como período normal", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '720 hours' + interval '1500 milliseconds'");
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  assert.equal(p.periodo, "MIGRACAO");
  await passar(await fimDaJanela(e.E));
  await vencer(p.usoId);
  const q = posseDe(await reservar(e, d));
  assert.equal(q.periodo, await mesAtual());
  assert.equal((await uso(p.usoId)).estado, "LIBERADA");
});

test("saldo do extra: conta CONSUMIDA + RESERVADA vigente por toda a janela (inclusive mês anterior), exclui vencida e LIBERADA; última vaga disputada vai uma para MIGRACAO e outra para a franquia", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  await marcoEm(e.E, "clock_timestamp() - interval '29 days'");
  await usosFixture(e, 98, "MIGRACAO", "CONSUMIDA", "clock_timestamp() - interval '28 days'");
  await usosFixture(e, 1, "MIGRACAO", "RESERVADA");
  await usosFixture(e, 3, "MIGRACAO", "RESERVADA", "clock_timestamp() - interval '20 minutes'");
  await usosFixture(e, 4, "MIGRACAO", "LIBERADA");
  const d1 = await documento(e);
  const d2 = await documento(e);
  await a.query("BEGIN");
  const r1 = await reservarCota(executor(a), { empresaId: e.E, documentoId: d1.doc, sha256: d1.sha });
  const r2 = reservar(e, d2, b);
  await bloqueada(pidB, pidA);
  await a.query("COMMIT");
  assert.equal(posseDe(r1).periodo, "MIGRACAO", "a 100ª vaga do extra");
  assert.equal(posseDe(await r2).periodo, await mesAtual(), "extra esgotado: franquia normal");
  const r = await emTx(a, (db) => resumoCota(db, e.E));
  assert.deepEqual([r.migracao?.usados, r.migracao?.extra, r.franquia.usados, r.franquia.limite], [100, 100, 1, 10]);
});

test("reenvios: CONSUMIDA MIGRACAO depois da janela e CONSUMIDA normal durante a janela não debitam e não mexem no marco", { skip: !opt() }, async () => {
  const e = await empresa("PROFISSIONAL");
  const d = await documento(e);
  const p = posseDe(await reservar(e, d));
  await concluir(e, p);
  assert.equal(p.periodo, "MIGRACAO");
  await f.query(`UPDATE ia_importacao_cotas SET migracao_inicio = migracao_inicio - interval '31 days' WHERE empresa_id = $1`, [e.E]);
  const m = await marco(e.E);
  assert.deepEqual(await reservar(e, d), { tipo: "JA_CONTADO" });
  assert.equal(await marco(e.E), m);
  const e2 = await empresa("PROFISSIONAL");
  await marcoEm(e2.E, "clock_timestamp() - interval '1 day'");
  const n = await documento(e2);
  await f.query(`INSERT INTO ia_importacao_usos (empresa_id, sha256, documento_id, operacao_id, periodo, estado, expira_em, criado_em, atualizado_em)
    VALUES ($1, $2, $3, gen_random_uuid(), $4, 'CONSUMIDA', clock_timestamp() + interval '15 minutes', clock_timestamp(), clock_timestamp())`, [e2.E, n.sha, n.doc, await mesAtual()]);
  const m2 = await marco(e2.E);
  const antes = await usos(e2.E);
  assert.deepEqual(await reservar(e2, n), { tipo: "JA_CONTADO" });
  assert.deepEqual(await usos(e2.E), antes);
  assert.equal(await marco(e2.E), m2);
});

test("resumo da tela: depois da conclusão traz o prazo efetivo; leitura sem dados não conta; falha de SQL vira null sem abortar a transação", { skip: !opt(), timeout: 60_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  const p = posseDe(await reservar(e, await documento(e)));
  const durante = await emTx(a, (db) => resumoCotaParaTela(db, e.E));
  assert.deepEqual([durante?.migracao?.usados, durante?.migracao?.ate], [1, null], "antes da conclusão a janela não começou");
  await concluir(e, p);
  const depois = await emTx(a, (db) => resumoCotaParaTela(db, e.E));
  assert.equal(depois?.migracao?.usados, 1);
  assert.match(depois?.migracao?.ate ?? "", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "a primeira leitura com dados já mostra o prazo");
  await concluir(e, posseDe(await reservar(e, await documento(e))), false);
  assert.equal((await emTx(a, (db) => resumoCotaParaTela(db, e.E)))?.migracao?.usados, 1, "leitura sem dados não sobe a linha");
  await a.query("BEGIN");
  const falhou = await resumoCotaParaTela(executor(a), e.E, async (tx, empresaId) => { await tx.query("SELECT 1 / 0"); return resumoCota(tx, empresaId); });
  assert.equal(falhou, null);
  assert.equal((await a.query<{ n: number }>("SELECT 1 AS n")).rows[0].n, 1, "a transação de quem chama segue viva");
  await a.query("COMMIT");
});

test("exportação: marco e leituras da empresa saem no pacote, sem o token de posse e sem dados de outra empresa", { skip: !opt(), timeout: 120_000 }, async () => {
  const e = await empresa("PROFISSIONAL");
  const p = posseDe(await reservar(e, await documento(e)));
  await concluir(e, p);
  const outra = await empresa("PROFISSIONAL");
  const po = posseDe(await reservar(outra, await documento(outra)));
  const { gerarPacote } = await import("../exportacao/pacote.ts");
  const { lerZip } = await import("../exportacao/zip.ts");
  await a.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const pacote = await gerarPacote(a as unknown as DbExecutor, e.E);
  await a.query("COMMIT");
  const zip = lerZip(readFileSync(pacote.zipCaminho));
  await pacote.limpar();
  const ausentes = pacote.manifesto.entidadesAusentes.map((x) => x.tabela);
  assert.ok(!ausentes.includes("ia_importacao_cotas") && !ausentes.includes("ia_importacao_usos"), "com a 118 as duas tabelas entram no pacote");
  const csv = (tabela: string) => {
    const arquivo = pacote.manifesto.arquivos.find((x) => x.tabela === tabela);
    assert.ok(arquivo, tabela);
    return zip.get(arquivo.caminho)!.toString("utf8");
  };
  const leituras = csv("ia_importacao_usos");
  assert.ok(leituras.includes(p.usoId), "a leitura da empresa sai");
  assert.ok(!leituras.split("\n")[0].includes("operacao_id"), "o token de posse não é coluna do pacote");
  assert.ok(!leituras.includes(p.operacaoId), "o valor do token de posse não sai");
  assert.ok(!leituras.includes(po.usoId), "leitura de outra empresa não sai");
  assert.ok(!leituras.includes(outra.E), "outra empresa não aparece");
  const cotas = csv("ia_importacao_cotas");
  assert.ok(cotas.includes(e.E) && cotas.split("\n")[0].includes("migracao_inicio"), "o marco da empresa sai");
  assert.ok(!cotas.includes(outra.E), "cota de outra empresa não sai");
});

test("118 down com histórico de cota é recusado sem efeito", { skip: !opt() }, async () => {
  await assert.rejects(a.query(DOWN), /rollback recusado; já existe histórico de cota/);
  await a.query("ROLLBACK").catch(() => {});
  assert.equal(await cotaInstalada(executor(a)), true);
});
