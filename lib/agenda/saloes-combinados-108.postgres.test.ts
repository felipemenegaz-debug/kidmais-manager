import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { cenario, dia, executor, id, representante, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { estadoCombinados } from "./estado-combinados.ts";
import { combinadosInstalados } from "./salao-festa.ts";
import { trocarSalaoDaFesta } from "./troca-salao.ts";
import { ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";
import { lerRegraCapacidadeAgenda, listarFechamentosConfirmadosPorPeriodo } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { criarSalaoCombinado, desativarSalao, impedimentosDesativacao, lerAgendaEscopo, salvarAgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";
import { escolherSalao } from "./salao-festa.ts";
import { saloesDoDia } from "./saloes-do-dia.ts";
import { saloesCruzam } from "./saloes-conjuntos.ts";

/**
 * 108 (salões combinados rebaseados; plano "Retomada 098", rev. 2.1) no PostgreSQL DESCARTÁVEL, modelo 107 (cadeia até a
 * 106 + 107, SEM a 098 histórica) com a 108 aplicada aqui:
 * - instalação com pre/post, recusas da precheck (sem a 107; festa futura em salão inativo), segunda aplicação recusada,
 *   estado NOVA no código e manifesto da Festa válido (conjunto '098');
 * - regra da 100 preservada no ramo POR_HORARIO (uma festa por horário com capacidade gravada maior);
 * - down: corpos da 100/094 de volta por hash, objetos da 102/104/106/107 intactos, estado AUSENTE, manifesto 094;
 *   up/down/up com o catálogo da 108 idêntico; recusas (parcial, corpo alterado, qualquer combinado);
 * - comportamento PORTADO sem mudança da suíte da 098 (saloes-combinados-098.postgres.test.ts, linhas 362–789): guardas
 *   por SQL direto, interseção, paridade SQL × Core, elegibilidade/D5, "hoje" de São Paulo e concorrência nas duas ordens
 *   com espera observada (reserva × desativação de membro; criação × desativação/DELETE de membro; reservas do mesmo
 *   combinado; reserva × cadastro em lote).
 * Gerado por ambientes-locais/saloes-108-20261028/gerar-suite-108.cjs.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIG = "database/migrations/20261028_108_saloes_combinados.sql";
const DOWN = "database/rollback/20261028_108_saloes_combinados_down.sql";
const PRE = "database/checks/20261028_108_precheck.sql";
const POS = "database/checks/20261028_108_postcheck.sql";
/** Sem BEGIN/COMMIT próprios: para rodar dentro da transação do teste (recusa conferida sem efeito). */
const semTransacao = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");

let a: Client;
const D = dia(40);
const TARDE = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => {
    assert.match(msg(e), trecho);
    return true;
  });
}
/** Recusa por SQL direto sem deixar efeito (ponto de salvamento na transação do teste). */
async function recusaSql(db: Client, sql: string, valores: unknown[], trecho: RegExp) {
  await db.query("SAVEPOINT r");
  await recusa(db.query(sql, valores), trecho);
  await db.query("ROLLBACK TO SAVEPOINT r");
}
const instalada = async () => (await estadoCombinados(executor(a))).estado === "NOVA";
const manifesto = async (db: Client = a) => (await db.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0]!.valida;

async function configurar(db: Client, c: Cenario, unidade: string | null = null, limite: number | null = null, intervalo = 0) {
  await db.query(`INSERT INTO agenda_escopo_config (empresa_id, estabelecimento_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                  VALUES ($1::uuid, $2::uuid, 'FIXO', 'POR_SALAO', $3, $4, $5::uuid)`, [c.empresa, unidade, limite, intervalo, c.usuario]);
  return id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                   ordem_exibicao, empresa_id, capacidade) VALUES ($1, 'Tarde', '15:00', '19:00', 0, 30, 1, $2::uuid, 5) RETURNING id`,
  [`T${randomUUID().slice(0, 6).toUpperCase()}`, c.empresa]);
}
const simples = (db: Client, c: Cenario, nome: string, unidade: string | null = null) =>
  id(db, `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome) VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, [c.empresa, unidade, nome]);
const combinado = (db: Client, c: Cenario, nome: string, membros: string[], unidade: string | null = null) =>
  id(db, `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, combinado, membros) VALUES ($1::uuid, $2::uuid, $3, true, $4::uuid[]) RETURNING id`,
    [c.empresa, unidade, nome, [...membros].sort()]);

/** Festa gravada e confirmada (sem contrato) na conexão dada; o chamador controla a transação. */
async function festa(db: Client, c: Cenario, cfg: string, data: string, salao: string | null, ini = "15:00", fim = "19:00", unidade: string | null = null) {
  const f = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, estabelecimento_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, $8::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid LIMIT 1 RETURNING fechamentos.id`,
  [data, ini, fim, cfg, c.empresa, c.pacote, salao, unidade]);
  await db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
  return f;
}
async function confirmada(db: Client, c: Cenario, cfg: string, data: string, salao: string | null, ini = "15:00", fim = "19:00", unidade: string | null = null) {
  await db.query("BEGIN");
  try {
    const f = await festa(db, c, cfg, data, salao, ini, fim, unidade);
    await db.query("COMMIT");
    return f;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

const pidDe = async (db: Client) => Number((await db.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p);
/** Espera OBSERVADA no servidor: `esperando` bloqueado por `segurando` (pg_blocking_pids), nunca um sleep cego. */
async function esperaObservada(esperando: number, segurando: number) {
  for (let i = 0; i < 400; i++) {
    const r = await a.query<{ ok: boolean }>(`SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS ok`, [esperando, segurando]);
    if (r.rows[0]!.ok) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  throw new Error(`espera não observada: ${esperando} por ${segurando}`);
}
async function duasConexoes<T>(corpo: (b: Client, d: Client) => Promise<T>) {
  const b = await conectarDescartavel({ travar: false });
  const d = await conectarDescartavel({ travar: false });
  try {
    return await corpo(b, d);
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(d, false);
  }
}
const naoDeadlock = (e: unknown) => assert.doesNotMatch(msg(e), /deadlock/i);


test.before(async () => {
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });


const HASH = { conflito108: "06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537", conflito100: "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb",
  contrato094: "4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e", revisao094: "951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821",
  contrato098: "13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21", revisao098: "8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24" };
const corpos = async () => (await a.query<{ c: string; k: string; r: string }>(
  `SELECT (SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) AS c,
          (SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais019_validar_contrato()')) AS k,
          (SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais_validar_agenda_revisao()')) AS r`)).rows[0]!;
/** Objetos das outras migrations que a 108 não pode tocar (102, 103, 104, 106, 107): funções, gatilhos, colunas e a tabela da 107. */
const outras = async () => (await a.query<{ l: string }>(
  `SELECT l FROM (
     SELECT 'F|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) AS l FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND (p.proname ~ '^kidmais10[2-7]_' OR p.proname = 'kidmais_hash_revisao_operacional')
     UNION ALL SELECT 'T|' || tgrelid::regclass::text || '|' || tgname || '|' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '_10[2-7]_'
     UNION ALL SELECT 'C|' || attrelid::regclass::text || '|' || attname || '|' || format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attnum > 0 AND NOT attisdropped AND attrelid IN ('public.agenda_saloes'::regclass, 'public.fechamentos'::regclass, 'public.fechamento_revisoes'::regclass)
     UNION ALL SELECT 'R|' || coalesce(to_regclass('public.kidmais107_reparos')::text, '-')
   ) x ORDER BY l`)).rows.map((r) => r.l);
/** Catálogo dos objetos da 108 (funções kidmais098_ e o marcador da 108, gatilhos _098_, CHECK dos membros). */
const objetos108 = async () => (await a.query<{ l: string }>(
  `SELECT l FROM (
     SELECT 'F|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) AS l FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'kidmais098\\_%' OR p.proname = 'kidmais108_instalada')
     UNION ALL SELECT 'T|' || tgrelid::regclass::text || '|' || tgname || '|' || tgtype || '|' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_098\\_%'
     UNION ALL SELECT 'K|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_098_membros_check'
   ) x ORDER BY l`)).rows.map((r) => r.l);

let outrasAntes: string[] = [];
let catalogo108: string[] = [];

test("instalação: estado AUSENTE → precheck recusa (sem a 107; festa futura em salão inativo) → 108 com pre/post; estado NOVA; manifesto; segunda aplicação recusada", async () => {
  assert.equal((await estadoCombinados(executor(a))).estado, "AUSENTE");
  assert.deepEqual(await corpos(), { c: HASH.conflito100, k: HASH.contrato094, r: HASH.revisao094 }, "modelo 107 = corpos da 100/094");
  outrasAntes = await outras();
  await a.query("BEGIN");
  try {
    await a.query("ALTER TABLE public.kidmais107_reparos RENAME TO kidmais107_reparos_fora");
    await recusaSql(a, arquivo(PRE), [], /108: precheck falhou \(093\/094\/100\/102\/104\/106\/107 ausentes\)/);
    await recusaSql(a, semTransacao(arquivo(MIG)), [], /108: precheck falhou \(093\/094\/100\/102\/104\/106\/107 ausentes\)/);
  } finally { await a.query("ROLLBACK"); }
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    const cfg = await configurar(a, c);
    const s = await simples(a, c, "Será inativo");
    await festa(a, c, cfg, dia(30), s);
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [s]);
    await recusaSql(a, arquivo(PRE), [], /108: há festa de hoje em diante em salão inativo/);
    await recusaSql(a, semTransacao(arquivo(MIG)), [], /108: há festa de hoje em diante em salão inativo/);
  } finally { await a.query("ROLLBACK"); }
  await a.query(arquivo(PRE));
  await a.query(arquivo(MIG));
  await a.query(arquivo(POS));
  assert.equal((await estadoCombinados(executor(a))).estado, "NOVA");
  assert.deepEqual(await corpos(), { c: HASH.conflito108, k: HASH.contrato098, r: HASH.revisao098 });
  assert.equal(await manifesto(), true, "manifesto da Festa: conjunto 098");
  const depois = await outras();
  assert.deepEqual(outrasAntes.filter((l) => !depois.includes(l)), [], "nada da 102/104/106/107 sumiu ou mudou");
  assert.deepEqual(depois.filter((l) => !outrasAntes.includes(l)).sort(),
    ["C|agenda_saloes|combinado|boolean", "C|agenda_saloes|membros|uuid[]"], "só as duas colunas da 108 entraram");
  catalogo108 = await objetos108();
  await recusa(a.query(arquivo(MIG)), /108: precheck falhou \(098 histórica ou 108 anterior\/parcial presente\)/);
  await a.query("ROLLBACK").catch(() => undefined);
  await recusa(a.query(arquivo(PRE)), /108: precheck falhou/);
  await a.query("ROLLBACK").catch(() => undefined);
});

test("regra da 100 preservada: POR_HORARIO aceita UMA festa por horário mesmo com capacidade gravada maior", async () => {
  const c = await cenario(a, 0);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                  VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const cfg = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                   ordem_exibicao, empresa_id, capacidade) VALUES ($1, 'Tarde', '15:00', '19:00', 0, 30, 1, $2::uuid, 3) RETURNING id`,
  [`H${randomUUID().slice(0, 6).toUpperCase()}`, c.empresa]);
  await confirmada(a, c, cfg, dia(44), null);
  await recusa(confirmada(a, c, cfg, dia(44), null), /Conflito/);
});

test("down: corpos da 100/094 de volta, 102–107 intactas, estado AUSENTE, manifesto 094; up/down/up com o catálogo da 108 idêntico", async () => {
  for (let ciclo = 1; ciclo <= 2; ciclo++) {
    await a.query(arquivo(DOWN));
    assert.deepEqual(await corpos(), { c: HASH.conflito100, k: HASH.contrato094, r: HASH.revisao094 }, `ciclo ${ciclo}: corpos da 100/094`);
    assert.deepEqual(await outras(), outrasAntes, `ciclo ${ciclo}: 102–107 intactas e sem as colunas da 108`);
    assert.equal((await estadoCombinados(executor(a))).estado, "AUSENTE");
    assert.equal(await manifesto(), true, "manifesto: conjunto 094");
    assert.deepEqual(await objetos108(), [], "nenhum resto da 108");
    await recusa(a.query(arquivo(DOWN)), /108 rollback: a 108 não está aplicada/);
    await a.query("ROLLBACK").catch(() => undefined);
    await a.query(arquivo(PRE));
    await a.query(arquivo(MIG));
    await a.query(arquivo(POS));
    assert.deepEqual(await objetos108(), catalogo108, `ciclo ${ciclo}: reaplicação idêntica`);
  }
});

test("down recusa sem efeito: sem marcador (regra da 108 sem marcador = PARCIAL), corpo da regra alterado e núcleo incompleto", async () => {
  await a.query("BEGIN");
  try {
    // Sem o marcador, a regra da 108 não é a da 098 histórica: o detector diz PARCIAL (P2-1) e o down da 108 recusa.
    await a.query("DROP FUNCTION public.kidmais108_instalada()");
    assert.equal((await estadoCombinados(executor(a))).estado, "PARCIAL");
    await recusaSql(a, semTransacao(arquivo(DOWN)), [], /108 rollback: a 108 não está aplicada \(ou está parcial\)/);
  } finally { await a.query("ROLLBACK"); }
  await a.query("BEGIN");
  try {
    // Núcleo incompleto: PARCIAL (combinados desligados no código).
    await a.query("DROP FUNCTION public.kidmais098_salao_elegivel(uuid)");
    assert.equal((await estadoCombinados(executor(a))).estado, "PARCIAL");
  } finally { await a.query("ROLLBACK"); }
  await a.query("BEGIN");
  try {
    const m100 = arquivo("database/migrations/20261025_100_agenda_um_salao.sql").replaceAll("\r", "");
    const corpo100 = m100.slice(m100.indexOf("CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao"), m100.indexOf("END $$;", m100.indexOf("CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao")) + 7);
    await a.query(corpo100);
    await recusaSql(a, semTransacao(arquivo(DOWN)), [], /108 rollback: corpos da 108 divergentes/);
  } finally { await a.query("ROLLBACK"); }
  assert.equal((await estadoCombinados(executor(a))).estado, "NOVA");
  assert.deepEqual(await corpos(), { c: HASH.conflito108, k: HASH.contrato098, r: HASH.revisao098 });
});


test("detector no banco (P2-1): guarda desligada/removida, CHECK não validado e corpo divergente = PARCIAL; serviços recusam", async () => {
  const escopoDe = async () => { const c = await cenario(a, 0); await configurar(a, c); return { empresaId: c.empresa, estabelecimentoId: null }; };
  const casos: Array<[string, string]> = [
    ["guarda de desativação desligada", "ALTER TABLE public.agenda_saloes DISABLE TRIGGER agenda_saloes_098_guarda_trg"],
    ["guarda de contratos removida", "DROP TRIGGER contratos_098_guarda_trg ON public.contratos"],
    ["CHECK dos membros não validado", "ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check; ALTER TABLE public.agenda_saloes ADD CONSTRAINT agenda_saloes_098_membros_check CHECK (CASE WHEN combinado THEN kidmais098_membros_canonicos(membros) ELSE membros IS NULL END) NOT VALID"],
    ["gatilho religado a outra função", "DROP TRIGGER agenda_saloes_098_truncate_trg ON public.agenda_saloes; CREATE TRIGGER agenda_saloes_098_truncate_trg BEFORE TRUNCATE ON public.agenda_saloes FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais_set_atualizado_em()"],
    // Parecer de 29/10 (rodada 2, P2-1a): mesmo nome, função e habilitação, mas definição diferente.
    ["guarda recriada só como BEFORE DELETE", "DROP TRIGGER agenda_saloes_098_guarda_trg ON public.agenda_saloes; CREATE TRIGGER agenda_saloes_098_guarda_trg BEFORE DELETE ON public.agenda_saloes FOR EACH ROW EXECUTE FUNCTION public.kidmais098_salao_guarda()"],
    ["CHECK dos membros trocado por CHECK (true) validado", "ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check; ALTER TABLE public.agenda_saloes ADD CONSTRAINT agenda_saloes_098_membros_check CHECK (true)"],
    ["função de guarda com outro corpo", "CREATE OR REPLACE FUNCTION public.kidmais098_contrato_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$ BEGIN RETURN NEW; END $$"],
  ];
  for (const [nome, sql] of casos) {
    await a.query("BEGIN");
    try {
      const escopo = await escopoDe();
      await a.query(sql);
      assert.equal((await estadoCombinados(executor(a))).estado, "PARCIAL", nome);
      await recusa(lerRegraCapacidadeAgenda(executor(a), escopo, { incluirCombinados: true }), /instalação dos salões combinados está incompleta/);
      await recusa(combinadosInstalados(executor(a)), /instalação dos salões combinados está incompleta/);
    } finally { await a.query("ROLLBACK"); }
  }
  // Corpo da regra de conflito divergente (o da 100 de volta): PARCIAL.
  await a.query("BEGIN");
  try {
    const m100 = arquivo("database/migrations/20261025_100_agenda_um_salao.sql").replaceAll("\r", "");
    const ini = m100.indexOf("CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao");
    await a.query(m100.slice(ini, m100.indexOf("END $$;", ini) + 7));
    assert.equal((await estadoCombinados(executor(a))).estado, "PARCIAL");
  } finally { await a.query("ROLLBACK"); }
  assert.equal((await estadoCombinados(executor(a))).estado, "NOVA");
});

test("down × criação de combinado (P1-2), nas duas ordens: a trava vem antes da leitura decisória (espera observada)", async () => {
  const c = await cenario(a, 0);
  const [A, B] = [await simples(a, c, "A down"), await simples(a, c, "B down")];
  await duasConexoes(async (b, d) => {
    const [pb, pd] = [await pidDe(b), await pidDe(d)];
    // Ordem 1: o INSERT do combinado chega primeiro (sem COMMIT); o down espera na trava e, depois, vê o combinado e recusa.
    await b.query("BEGIN");
    const AB = await combinado(b, c, "AB corrida", [A, B]);
    const down1 = d.query(arquivo(DOWN)).then(() => "ok", (e) => e);
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    const r1 = await down1;
    await d.query("ROLLBACK").catch(() => undefined);
    assert.notEqual(r1, "ok", "o down não pode passar com o combinado confirmado");
    naoDeadlock(r1);
    assert.match(msg(r1), /108 rollback: existe salão combinado/);
    assert.equal((await estadoCombinados(executor(a))).estado, "NOVA");
    await a.query(`DELETE FROM agenda_saloes WHERE id = $1::uuid`, [AB]);
    // Ordem 2: o down roda primeiro (sem COMMIT, com a trava); o INSERT espera e, depois do COMMIT, não acha a coluna.
    await d.query("BEGIN");
    await d.query(semTransacao(arquivo(DOWN)));
    const criar = combinado(b, c, "AB tarde", [A, B]).then(() => "ok", (e) => e);
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r2 = await criar;
    assert.notEqual(r2, "ok", "nenhum salão simples sobrevive como resto de um combinado");
    naoDeadlock(r2);
    assert.match(msg(r2), /combinado|membros|does not exist|não existe/);
  });
  assert.equal((await estadoCombinados(executor(a))).estado, "AUSENTE");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int n FROM agenda_saloes WHERE nome IN ('AB corrida', 'AB tarde')`)).rows[0]!.n, 0);
  await a.query(arquivo(PRE));
  await a.query(arquivo(MIG));
  await a.query(arquivo(POS));
  assert.deepEqual(await objetos108(), catalogo108, "reaplicada idêntica");
});

test("guardas por SQL direto: formato dos membros, aninhamento, autoassociação, escopo, identidade imutável, DELETE, TRUNCATE e recheck no COMMIT", async () => {
  await a.query("BEGIN");
  try {
    // Qualquer GUC definida pelo chamador não dá autoridade (não existe marcador a forjar).
    await a.query(`SET LOCAL kidmais.criando_combinado = 'forjado'`);
    const c = await cenario(a, 1);
    const outra = await cenario(a, 0);
    const [A, B, C] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C")];
    const naUnidade = await simples(a, c, "U1", c.unidade);
    const deFora = await simples(a, outra, "Fora");
    const inativo = await simples(a, c, "Inativo");
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [inativo]);
    const ins = `INSERT INTO agenda_saloes (empresa_id, nome, combinado, membros) VALUES ($1::uuid, $2, $3, $4::uuid[])`;
    const ordenados = [A, B].sort();
    await recusaSql(a, ins, [c.empresa, "Vazio", true, []], /2 ou mais/);
    await recusaSql(a, ins, [c.empresa, "Nulo", true, null], /2 ou mais/);
    await recusaSql(a, ins, [c.empresa, "Um", true, [A]], /2 ou mais/);
    await recusaSql(a, ins, [c.empresa, "Repetido", true, [A, A]], /2 ou mais/);
    await recusaSql(a, ins, [c.empresa, "Fora de ordem", true, [...ordenados].reverse()], /2 ou mais/);
    await recusaSql(a, `INSERT INTO agenda_saloes (empresa_id, nome, combinado, membros) VALUES ($1::uuid, 'Com nulo', true, ARRAY[$2::uuid, NULL, $3::uuid])`, [c.empresa, ...ordenados], /2 ou mais/);
    await recusaSql(a, `INSERT INTO agenda_saloes (empresa_id, nome, combinado, membros) VALUES ($1::uuid, '2D', true, ARRAY[[$2::uuid, $3::uuid], [$2::uuid, $3::uuid]])`, [c.empresa, ...ordenados], /2 ou mais/);
    await recusaSql(a, `INSERT INTO agenda_saloes (empresa_id, nome, combinado, membros) VALUES ($1::uuid, 'Base 0', true, '[0:1]={${ordenados.join(",")}}'::uuid[])`, [c.empresa], /2 ou mais/);
    await recusaSql(a, ins, [c.empresa, "Simples com membros", false, ordenados], /simples não tem membros/);
    const auto = randomUUID();
    await recusaSql(a, `INSERT INTO agenda_saloes (id, empresa_id, nome, combinado, membros) VALUES ($1::uuid, $2::uuid, 'Auto', true, $3::uuid[])`,
      [auto, c.empresa, [A, auto].sort()], /a si mesmo/);
    await recusaSql(a, ins, [c.empresa, "Com inativo", true, [A, inativo].sort()], /simples, ativos, da mesma empresa e unidade/);
    await recusaSql(a, ins, [c.empresa, "Outra unidade", true, [A, naUnidade].sort()], /mesma empresa e unidade/);
    await recusaSql(a, ins, [c.empresa, "Outra empresa", true, [A, deFora].sort()], /mesma empresa e unidade/);
    await recusaSql(a, ins, [c.empresa, "Membro ausente", true, [A, randomUUID()].sort()], /mesma empresa e unidade/);
    const AB = await combinado(a, c, "AB", [A, B]);
    await recusaSql(a, ins, [c.empresa, "Aninhado", true, [AB, C].sort()], /simples/);
    // Identidade imutável: id, empresa, unidade, tipo e membros, de simples e de combinado.
    const imut = /id, empresa, unidade, tipo e membros do salão não mudam/;
    const antigo = C;
    await recusaSql(a, `UPDATE agenda_saloes SET id = $2::uuid WHERE id = $1::uuid`, [antigo, randomUUID()], imut);
    await recusaSql(a, `UPDATE agenda_saloes SET empresa_id = $2::uuid WHERE id = $1::uuid`, [A, outra.empresa], imut);
    await recusaSql(a, `UPDATE agenda_saloes SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [A, c.unidade], imut);
    await recusaSql(a, `UPDATE agenda_saloes SET combinado = true, membros = $2::uuid[] WHERE id = $1::uuid`, [C, ordenados], imut);
    await recusaSql(a, `UPDATE agenda_saloes SET membros = $2::uuid[] WHERE id = $1::uuid`, [AB, [A, C].sort()], imut);
    await recusaSql(a, `UPDATE agenda_saloes SET combinado = false, membros = NULL WHERE id = $1::uuid`, [AB], imut);
    // O id antigo continua do salão de antes: não há como "reutilizá-lo" em outro salão.
    await recusaSql(a, `INSERT INTO agenda_saloes (id, empresa_id, nome) VALUES ($1::uuid, $2::uuid, 'Reuso')`, [antigo, c.empresa], /duplicate key|duplicada|chave/i);
    // Renomear, ordem e capacidade continuam livres.
    await a.query(`UPDATE agenda_saloes SET nome = 'Salão inteiro', ordem = 9, capacidade_convidados = 200 WHERE id = $1::uuid`, [AB]);
    // DELETE de membro recusado; de salão sem vínculo, aceito; TRUNCATE recusado.
    await recusaSql(a, `DELETE FROM agenda_saloes WHERE id = $1::uuid`, [A], /faz parte de um salão combinado/);
    await a.query(`DELETE FROM agenda_saloes WHERE id = $1::uuid`, [inativo]);
  } finally {
    await a.query("ROLLBACK");
  }
  // TRUNCATE (transação própria, sem eventos pendentes): recusado nas duas tabelas, mesmo com CASCADE.
  for (const tabela of ["agenda_saloes", "contratos"]) {
    await a.query("BEGIN");
    try {
      await recusa(a.query(`TRUNCATE ${tabela} CASCADE`), /não aceita TRUNCATE/);
    } finally {
      await a.query("ROLLBACK");
    }
  }
  // Recheck diferido: membro desativado na mesma transação da criação é recusado no COMMIT.
  const c = await cenario(a, 0);
  const [A, B] = [await simples(a, c, "A"), await simples(a, c, "B")];
  await a.query("BEGIN");
  await combinado(a, c, "AB", [A, B]);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [B]);
  await recusa(a.query("COMMIT"), /membros precisam ser salões simples, ativos/);
  assert.equal((await a.query(`SELECT 1 FROM agenda_saloes WHERE empresa_id = $1::uuid AND combinado`, [c.empresa])).rowCount, 0);
});

test("conflito por interseção nos gatilhos: A × B passam; A × AB e AB × BC conflitam; festa sem salão ocupa todos; bloqueio fecha tudo; limite conta a festa uma vez", async () => {
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c, null, 2);
  const [A, B, C] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C")];
  const AB = await combinado(a, c, "AB", [A, B]);
  const BC = await combinado(a, c, "BC", [B, C]);
  await confirmada(a, c, cfg, D, A);
  await confirmada(a, c, cfg, D, B);
  await recusa(confirmada(a, c, cfg, D, AB), /Conflito/);
  await recusa(confirmada(a, c, cfg, D, C), /Conflito/, ); // limite do dia = 2 (duas festas, não três)
  const D2 = dia(41);
  await confirmada(a, c, cfg, D2, AB);
  await recusa(confirmada(a, c, cfg, D2, BC), /Conflito/);
  await recusa(confirmada(a, c, cfg, D2, A), /Conflito/);
  await confirmada(a, c, cfg, D2, C, "19:00", "22:00");
  const D3 = dia(42);
  await confirmada(a, c, cfg, D3, null);
  await recusa(confirmada(a, c, cfg, D3, C), /Conflito/);
  const D4 = dia(43);
  await a.query(`INSERT INTO bloqueios_agenda (data, dia_inteiro, motivo, ativo, empresa_id) VALUES ($1::date, true, 'Manutenção', true, $2::uuid)`, [D4, c.empresa]);
  await recusa(confirmada(a, c, cfg, D4, C), /Conflito/);
});

test("paridade SQL × Core: matriz ocupado × candidato (A, B, C, AB, BC, sem salão) com intervalo e limite", async () => {
  for (const intervalo of [0, 60]) {
    await a.query("BEGIN");
    try {
      const c = await cenario(a, 0);
      const cfg = await configurar(a, c, null, null, intervalo);
      const [A, B, C] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C")];
      const AB = await combinado(a, c, "AB", [A, B]);
      const BC = await combinado(a, c, "BC", [B, C]);
      const nomes: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [AB]: "AB", [BC]: "BC" };
      const tx = executor(a);
      const regra = await lerRegraCapacidadeAgenda(tx, { empresaId: c.empresa, estabelecimentoId: null }, { incluirCombinados: true });
      assert.ok(regra?.conjuntos, "Core lê os conjuntos com a 098");
      for (const [ocupado, ini, fim] of [[A, "15:00", "19:00"], [AB, "15:00", "19:00"], [BC, "15:00", "19:00"], [null, "15:00", "19:00"], [A, "19:30", "21:00"]] as Array<[string | null, string, string]>) {
        await a.query("SAVEPOINT p");
        await festa(a, c, cfg, D, ocupado, ini, fim);
        const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(D, D, tx, { empresaId: c.empresa, estabelecimentoId: null });
        for (const candidato of [A, B, C, AB, BC]) {
          const sql = (await a.query<{ x: boolean }>(`SELECT kidmais094_conflito_ocupacao($1::uuid, $2::date, '15:00', '19:00', $3::uuid, NULL, $4::uuid, $5::uuid) AS x`,
            [randomUUID(), D, c.empresa, cfg, candidato])).rows[0]!.x;
          const core = ocupacaoImpedeCandidato(regra, cfg, TARDE, ocupacoes, [candidato]);
          const sobrepoe = ini === "15:00" || intervalo >= 30;
          const esperado: boolean = sobrepoe && saloesCruzam(ocupado, candidato, regra!.conjuntos);
          const rotulo = `intervalo ${intervalo}: ${ocupado ? nomes[ocupado] : "sem salão"} ${ini} × ${nomes[candidato]}`;
          assert.equal(sql, esperado, `SQL ${rotulo}`);
          assert.equal(core, sql, `Core × SQL ${rotulo}`);
        }
        await a.query("ROLLBACK TO SAVEPOINT p");
      }
      // Elegibilidade: com B inativo, AB sai dos candidatos do Core e o SQL o declara inelegível; A segue elegível.
      await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [B]);
      const depois = await lerRegraCapacidadeAgenda(tx, { empresaId: c.empresa, estabelecimentoId: null }, { incluirCombinados: true });
      assert.equal(ocupacaoImpedeCandidato(depois, cfg, TARDE, [], [AB]), true, "sem candidato elegível = indisponível");
      assert.equal(ocupacaoImpedeCandidato(depois, cfg, TARDE, [], [A]), false);
      const eleg = (await a.query<{ ab: boolean; a: boolean; bc: boolean }>(`SELECT kidmais098_salao_elegivel($1::uuid) ab, kidmais098_salao_elegivel($2::uuid) a, kidmais098_salao_elegivel($3::uuid) bc`, [AB, A, BC])).rows[0]!;
      assert.deepEqual(eleg, { ab: false, a: true, bc: false });
    } finally {
      await a.query("ROLLBACK");
    }
  }
});

test("invariante de elegibilidade e D5 por SQL direto: salão inativo, combinado com membro inativo, desativação com festa futura, cancelamento e volta", async () => {
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c);
  const [A, B, C] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C")];
  const AB = await combinado(a, c, "AB", [A, B]);
  // D5: festa futura no combinado impede desativar o combinado e cada membro.
  const f = await confirmada(a, c, cfg, D, AB);
  await recusa(a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A]), /festa de hoje em diante/);
  await recusa(a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [AB]), /festa de hoje em diante/);
  assert.equal((await impedimentosDesativacao(executor(a), [B])).length, 1, "a listagem da tela mostra a festa");
  // Cancelada, libera a desativação; voltar a ocupar exige salão elegível.
  await a.query(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid`, [f]);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [B]);
  await recusa(a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]), /098: salão inativo ou combinado com membro inativo/);
  // Agenda do dia (P3-3): AB ativo com B inativo aparece inelegível, com o membro desativado.
  const noDia = await saloesDoDia(executor(a), c.empresa, null, dia(47));
  assert.deepEqual(noDia.filter((s) => s.combinado).map((s) => [s.nome, s.elegivel, s.membrosInativos]), [["AB", false, ["B"]]]);
  assert.equal(noDia.find((s) => s.nome === "A")?.elegivel, true);
  // Ocupação nova: combinado com membro inativo e salão inativo recusados.
  await recusa(confirmada(a, c, cfg, dia(45), AB), /098: salão inativo ou combinado com membro inativo/);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [C]);
  await recusa(confirmada(a, c, cfg, dia(45), C), /098: salão inativo/);
  // Mudança física revalidada: festa em A movida para C (inativo) é recusada.
  const emA = await confirmada(a, c, cfg, dia(46), A);
  await recusa(a.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [emA, C]), /098: salão inativo/);
  // Reativado, volta a valer.
  await a.query(`UPDATE agenda_saloes SET ativo = true WHERE id = ANY ($1::uuid[])`, [[B, C]]);
  await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
});

test("\"hoje\" é São Paulo com a sessão em qualquer fuso (faixa 21h–24h de SP = outro dia em UTC)", async () => {
  // Expressão da 098 em instantes fixos: às 21h, 23h59 e 0h de SP, a data de SP difere da de UTC nas duas primeiras.
  const r = await a.query<{ sp21: string; utc21: string; sp2359: string; utc2359: string; sp0: string }>(`SET TIME ZONE 'UTC';
    SELECT ('2026-10-23 21:00-03'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text sp21, ('2026-10-23 21:00-03'::timestamptz)::date::text utc21,
           ('2026-10-23 23:59-03'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text sp2359, ('2026-10-23 23:59-03'::timestamptz)::date::text utc2359,
           ('2026-10-24 00:00-03'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text sp0`).then((x) => (Array.isArray(x) ? x[1]! : x));
  assert.deepEqual(r.rows[0], { sp21: "2026-10-23", utc21: "2026-10-24", sp2359: "2026-10-23", utc2359: "2026-10-24", sp0: "2026-10-24" });
  const hojeSp = (await a.query<{ d: string }>(`SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text d`)).rows[0]!.d;
  const ontemSp = (await a.query<{ d: string }>(`SELECT ($1::date - 1)::text d`, [hojeSp])).rows[0]!.d;
  // UTC−12 e UTC+14: a qualquer hora, um dos dois está num dia diferente de SP (incluindo a faixa das 21h às 24h, em que
  // UTC e UTC+14 já estão no dia seguinte). O corte da 098 não muda com o fuso da sessão; CURRENT_DATE muda.
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c);
  const [hoje, ontem] = [await simples(a, c, "Hoje"), await simples(a, c, "Ontem")];
  await confirmada(a, c, cfg, hojeSp, hoje);
  // Festa de "ontem" (SP): passado não impede a desativação (ocupação passada fora do invariante).
  await confirmada(a, c, cfg, ontemSp, ontem);
  const diferentes = new Set<string>();
  for (const fuso of ["Etc/GMT+12", "UTC", "Pacific/Kiritimati", "America/Sao_Paulo"]) {
    await a.query(`SET TIME ZONE '${fuso}'`);
    const x = (await a.query<{ hoje: string; corrente: string }>(`SELECT kidmais098_hoje()::text hoje, CURRENT_DATE::text corrente`)).rows[0]!;
    assert.equal(x.hoje, hojeSp, `kidmais098_hoje com a sessão em ${fuso}`);
    if (x.corrente !== hojeSp) diferentes.add(fuso);
    assert.deepEqual((await impedimentosDesativacao(executor(a), [hoje])).map((i) => i.data), [hojeSp], `listagem do D5 em ${fuso}`);
    await a.query("BEGIN");
    await recusa(a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [hoje]), /festa de hoje em diante/);
    await a.query("ROLLBACK");
    assert.equal((await impedimentosDesativacao(executor(a), [ontem])).length, 0, `passado não impede (${fuso})`);
  }
  await a.query(`SET TIME ZONE 'America/Sao_Paulo'`);
  assert.ok(diferentes.size >= 1, "pelo menos um fuso da sessão estava em outro dia (CURRENT_DATE ≠ hoje de SP)");
  // Volátil (relógio a cada chamada, não o início da transação): a virada da meia-noite numa transação longa vale na hora.
  assert.equal((await a.query<{ v: string; src: string }>(`SELECT provolatile v, prosrc src FROM pg_proc WHERE proname = 'kidmais098_hoje'`)).rows[0]!.v, "v");
});

test("concorrência: reserva × desativação de membro, nas duas ordens (espera observada, sem deadlock)", async () => {
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c);
  const [A, B, C, E] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C"), await simples(a, c, "E")];
  const AB = await combinado(a, c, "AB", [A, B]);
  const CE = await combinado(a, c, "CE", [C, E]);
  await duasConexoes(async (b, d) => {
    const [pb, pd] = [await pidDe(b), await pidDe(d)];
    // Ordem 1: a reserva trava AB, A e B (FOR SHARE) primeiro; a desativação de A espera e, depois do COMMIT, vê a festa.
    await b.query("BEGIN");
    await festa(b, c, cfg, D, AB);
    await b.query("SET CONSTRAINTS ALL IMMEDIATE");
    const desativar = d.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A]).then(() => "ok", (e) => e);
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    const r1 = await desativar;
    assert.notEqual(r1, "ok");
    naoDeadlock(r1);
    assert.match(msg(r1), /festa de hoje em diante/);
    // Ordem 2: a desativação de C pega a linha primeiro; o COMMIT da reserva espera e, depois, vê C inativo.
    await d.query("BEGIN");
    await d.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [C]);
    const reservar = (async () => {
      await b.query("BEGIN");
      try {
        await festa(b, c, cfg, D, CE, "08:00", "12:00");
        await b.query("COMMIT");
        return "ok";
      } catch (e) {
        await b.query("ROLLBACK");
        return e;
      }
    })();
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r2 = await reservar;
    assert.notEqual(r2, "ok");
    naoDeadlock(r2);
    assert.match(msg(r2), /098: salão inativo ou combinado com membro inativo/);
  });
});

test("concorrência: criação de combinado × desativação e × DELETE de membro, nas duas ordens", async () => {
  const c = await cenario(a, 0);
  const [A, B, C, E, F, G, H, I] = await Promise.all(["A", "B", "C", "E", "F", "G", "H", "I"].map((n) => simples(a, c, n)));
  await duasConexoes(async (b, d) => {
    const [pb, pd] = [await pidDe(b), await pidDe(d)];
    // 1) Criação primeiro (FOR SHARE em A e B): a desativação de A espera; depois passa (sem festas) e o combinado fica
    //    inelegível — a criação viu os membros ativos.
    await b.query("BEGIN");
    const AB = await combinado(b, c, "AB", [A!, B!]);
    const desativar = d.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A]).then(() => "ok", (e) => e);
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    assert.equal(await desativar, "ok");
    assert.equal((await a.query<{ e: boolean }>(`SELECT kidmais098_salao_elegivel($1::uuid) e`, [AB])).rows[0]!.e, false);
    // 2) Desativação primeiro: a criação espera o FOR SHARE e, depois, vê o membro inativo e recusa.
    await d.query("BEGIN");
    await d.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [C]);
    const criar = combinado(b, c, "CE", [C!, E!]).then(() => "ok", (e) => e);
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r2 = await criar;
    naoDeadlock(r2);
    assert.match(msg(r2), /simples, ativos/);
    // 3) Criação primeiro × DELETE do membro: o DELETE espera e, depois, é recusado (é membro).
    await b.query("BEGIN");
    await combinado(b, c, "FG", [F!, G!]);
    const apagar = d.query(`DELETE FROM agenda_saloes WHERE id = $1::uuid`, [F]).then(() => "ok", (e) => e);
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    const r3 = await apagar;
    naoDeadlock(r3);
    assert.match(msg(r3), /faz parte de um salão combinado/);
    // 4) DELETE primeiro: a criação espera e, depois do COMMIT do DELETE, o membro está ausente: recusa.
    await d.query("BEGIN");
    await d.query(`DELETE FROM agenda_saloes WHERE id = $1::uuid`, [H]);
    const criar2 = combinado(b, c, "HI", [H!, I!]).then(() => "ok", (e) => e);
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r4 = await criar2;
    naoDeadlock(r4);
    assert.match(msg(r4), /mesma empresa e unidade/);
  });
});

test("concorrência: duas reservas do mesmo combinado em datas diferentes (FOR SHARE compatível) — sem espera e sem deadlock", async () => {
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c);
  const [A, B] = [await simples(a, c, "A"), await simples(a, c, "B")];
  const AB = await combinado(a, c, "AB", [A, B]);
  await duasConexoes(async (b, d) => {
    await b.query("BEGIN");
    await d.query("BEGIN");
    await festa(b, c, cfg, dia(50), AB);
    await festa(d, c, cfg, dia(51), AB);
    await b.query("SET CONSTRAINTS ALL IMMEDIATE");
    await d.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.deepEqual((await a.query(`SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND pid = ANY ($1::int[])`, [[await pidDe(b), await pidDe(d)]])).rows, []);
    await b.query("COMMIT");
    await d.query("COMMIT");
  });
  assert.equal((await a.query(`SELECT 1 FROM fechamentos WHERE salao_id = $1::uuid AND status = 'CONFIRMADO'`, [AB])).rowCount, 2);
});

test("concorrência: reserva na unidade (locks da 062) × cadastro em lote pelo Core, nas duas ordens", async () => {
  const c = await cenario(a, 1);
  const rep = await representante(a, c);
  await a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Abertura da unidade 098')`, [c.empresa, c.unidade, rep.usuarioId]);
  const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
  let existentes: string[] = [];
  const horario: { id?: string } = {};
  // Plano rev. 1.1: a versão é lida na conexão `a` (só leitura, sem travas) antes de cada gravação.
  const versao = async () => (await lerAgendaEscopo(executor(a), c.empresa, c.unidade)).versaoAgenda;
  const entrada = (nomeA: string, versaoEsperada: string | null = null): SalvarAgenda => ({
    versaoEsperada,
    estabelecimentoId: c.unidade, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 0,
    saloes: [nomeA, "Salão B", "Salão C"].map((nome, i) => ({ ...(existentes[i] ? { id: existentes[i] } : {}), nome, capacidadeConvidados: null })),
    horarios: [{ ...(horario.id ? { id: horario.id } : {}), nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 3,
      saloes: [nomeA, "Salão B", "Salão C", ...(existentes.length ? ["Salão inteiro"] : [])] }],
  });
  const v0 = await versao();
  await a.query("BEGIN");
  await salvarAgendaEscopo(executor(a), entrada("Salão A", v0), ctx, "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
  await a.query("COMMIT");
  const ids = (await a.query<{ id: string; nome: string }>(`SELECT id::text, nome FROM agenda_saloes WHERE empresa_id = $1::uuid ORDER BY nome`, [c.empresa])).rows;
  const [A, B] = [ids[0]!.id, ids[1]!.id];
  existentes = ids.map((s) => s.id);
  await a.query("BEGIN");
  const { id: AB } = await criarSalaoCombinado(executor(a), ctx, { estabelecimentoId: c.unidade, nome: "Salão inteiro", capacidadeConvidados: 150, membros: [B, A] });
  await a.query("COMMIT");
  const cfg = (await a.query<{ id: string }>(`SELECT id::text FROM configuracao_agenda WHERE estabelecimento_id = $1::uuid AND ativo AND NOT horario_livre`, [c.unidade])).rows[0]!.id;
  horario.id = cfg;
  // O cadastro vê a composição e mantém o combinado ao salvar a lista de salões simples.
  const agenda = await lerAgendaEscopo(executor(a), c.empresa, c.unidade);
  assert.deepEqual(agenda.combinados.map((x) => [x.nome, x.membros.map((m) => m.nome), x.elegivel]), [["Salão inteiro", ["Salão A", "Salão B"], true]]);
  const vRenomear = await versao();
  await duasConexoes(async (b, d) => {
    const [pb, pd] = [await pidDe(b), await pidDe(d)];
    // 1) Reserva do combinado primeiro (062: empresa → unidade → habilitação; salões FOR SHARE): o cadastro espera no
    //    lock do escopo dos salões e termina depois.
    await b.query("BEGIN");
    await festa(b, c, cfg, D, AB, "15:00", "19:00", c.unidade);
    await b.query("SET CONSTRAINTS ALL IMMEDIATE");
    const salvar = (async () => {
      await d.query("BEGIN");
      try {
        await salvarAgendaEscopo(executor(d), entrada("Salão A renomeado", vRenomear), { ...ctx, requestId: randomUUID() }, "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
        await d.query("COMMIT");
        return "ok";
      } catch (e) {
        await d.query("ROLLBACK");
        return e;
      }
    })();
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    assert.equal(await salvar, "ok");
    // 2) Cadastro primeiro (todos os salões do escopo FOR NO KEY UPDATE, por id): a reserva espera no COMMIT e passa
    //    depois, sem deadlock.
    const vVoltar = await versao();
    await d.query("BEGIN");
    await salvarAgendaEscopo(executor(d), entrada("Salão A", vVoltar), { ...ctx, requestId: randomUUID() }, "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
    const reservar = (async () => {
      await b.query("BEGIN");
      try {
        await festa(b, c, cfg, dia(41), AB, "15:00", "19:00", c.unidade);
        await b.query("COMMIT");
        return "ok";
      } catch (e) {
        await b.query("ROLLBACK");
        return e;
      }
    })();
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r = await reservar;
    if (r !== "ok") naoDeadlock(r);
    assert.equal(r, "ok");
  });
  // D5 pelo cadastro: omitir o Salão A (membro do combinado com festas) recusa o salvamento inteiro e lista as festas.
  await a.query("BEGIN");
  try {
    const semA: SalvarAgenda = { ...entrada("Salão A", await versao()), saloes: [{ id: existentes[1], nome: "Salão B", capacidadeConvidados: null }, { id: existentes[2], nome: "Salão C", capacidadeConvidados: null }],
      horarios: [{ id: horario.id, nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 2, saloes: ["Salão B", "Salão C"] }] };
    await recusa(salvarAgendaEscopo(executor(a), semA, ctx, "CONFIGURACOES", { maisDeUmSalaoLiberada: true }), /Não dá para desativar Salão A: há 2 festa\(s\) de hoje em diante/);
  } finally {
    await a.query("ROLLBACK");
  }
  await a.query("BEGIN");
  try {
    await recusa(desativarSalao(executor(a), ctx, AB), /Não dá para desativar Salão inteiro: há 2 festa/);
  } finally {
    await a.query("ROLLBACK");
  }
  // Agenda do dia: o combinado reservado marca A e B; C livre.
  const dia1 = await saloesDoDia(executor(a), c.empresa, c.unidade, D);
  assert.deepEqual(dia1.map((s) => [s.nome, s.ocupacoes.length > 0]), [["Salão A", true], ["Salão B", true], ["Salão C", false], ["Salão inteiro", true]]);
  // Escolha automática (Core): pacote que libera A e B não libera AB; só AB listado leva a festa ao combinado.
  const pacoteAB = await id(a, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa grande', 2, true, true) RETURNING id`,
    [c.empresa, `G${randomUUID().slice(0, 6).toUpperCase()}`]);
  await a.query(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario)
                 SELECT tabela_preco_id, $1::uuid, 1, 'FIXO', 100, 'PADRAO' FROM precos_pacote WHERE pacote_id = $2::uuid LIMIT 1`, [pacoteAB, c.pacote]);
  await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid), ($3::uuid, $5::uuid)`, [pacoteAB, AB, c.pacote, A, B]);
  // O horário lista o combinado (o cadastro acima o incluiu pelo nome: permissão explícita também no horário).
  assert.equal((await a.query(`SELECT 1 FROM configuracao_agenda_saloes WHERE configuracao_agenda_id = $1::uuid AND salao_id = $2::uuid`, [cfg, AB])).rowCount, 1);
  await a.query("BEGIN");
  try {
    const grande = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, estabelecimento_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, $4::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $5::uuid LIMIT 1 RETURNING fechamentos.id`, [dia(60), cfg, c.empresa, c.unidade, pacoteAB]);
    assert.deepEqual(await escolherSalao(executor(a), grande), { exigido: true, salao: AB });
    const pequena = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, estabelecimento_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, $4::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $5::uuid LIMIT 1 RETURNING fechamentos.id`, [dia(61), cfg, c.empresa, c.unidade, c.pacote]);
    const escolha = await escolherSalao(executor(a), pequena);
    assert.ok(escolha.salao === A || escolha.salao === B, "A e B liberados: nunca AB");
    // Com A ocupado no dia 60 pela grande, a pequena no mesmo dia escolheria C? Não: o pacote só permite A e B; B serve? Não (AB ocupa B).
    await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1::uuid`, [pequena, dia(60)]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [grande]);
    assert.deepEqual(await escolherSalao(executor(a), pequena), { exigido: true, salao: null }, "sem candidato elegível livre = indisponível");
  } finally {
    await a.query("ROLLBACK");
  }
});


test("concorrência (rev. 2.1, P2-R2-3): troca manual de salão para o combinado × desativação de membro, nas duas ordens", async () => {
  const c = await cenario(a, 0);
  const cfg = await configurar(a, c);
  const [A, B, C, E, G] = [await simples(a, c, "A"), await simples(a, c, "B"), await simples(a, c, "C"), await simples(a, c, "E"), await simples(a, c, "G")];
  const AB = await combinado(a, c, "AB", [A, B]);
  const EG = await combinado(a, c, "EG", [E, G]);
  const F1 = await confirmada(a, c, cfg, dia(70), C);
  const F2 = await confirmada(a, c, cfg, dia(71), C);
  const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
  await duasConexoes(async (b, d) => {
    const [pb, pd] = [await pidDe(b), await pidDe(d)];
    // Ordem 1: a troca C → AB pega as travas primeiro (sem COMMIT); a desativação de A espera e, depois, vê a festa em AB.
    await b.query("BEGIN");
    await trocarSalaoDaFesta(executor(b), ctx, F1, AB);
    await b.query("SET CONSTRAINTS ALL IMMEDIATE");
    const desativar = (async () => {
      await d.query("BEGIN");
      try { await desativarSalao(executor(d), { ...ctx, requestId: randomUUID() }, A); await d.query("COMMIT"); return "ok"; }
      catch (e) { await d.query("ROLLBACK"); return e; }
    })();
    await esperaObservada(pd, pb);
    await b.query("COMMIT");
    const r1 = await desativar;
    assert.notEqual(r1, "ok", "A não é desativado com festa futura no combinado");
    naoDeadlock(r1);
    assert.match(msg(r1), /festa/);
    assert.equal((await a.query<{ s: string }>(`SELECT salao_id::text s FROM fechamentos WHERE id = $1::uuid`, [F1])).rows[0]!.s, AB);
    // Ordem 2: a desativação de E pega a linha primeiro (sem COMMIT); a troca C → EG espera e, depois, é recusada.
    await d.query("BEGIN");
    await desativarSalao(executor(d), { ...ctx, requestId: randomUUID() }, E);
    const trocar = (async () => {
      await b.query("BEGIN");
      try { await trocarSalaoDaFesta(executor(b), { ...ctx, requestId: randomUUID() }, F2, EG); await b.query("COMMIT"); return "ok"; }
      catch (e) { await b.query("ROLLBACK"); return e; }
    })();
    await esperaObservada(pb, pd);
    await d.query("COMMIT");
    const r2 = await trocar;
    assert.notEqual(r2, "ok", "a festa não vai para um combinado com membro inativo");
    naoDeadlock(r2);
    assert.equal((await a.query<{ s: string }>(`SELECT salao_id::text s FROM fechamentos WHERE id = $1::uuid`, [F2])).rows[0]!.s, C, "a festa fica onde estava");
  });
});

test("rollback adversarial: qualquer combinado (mesmo inativo e sem referência) recusa; nada muda", async () => {
  const c = await cenario(a, 0);
  const [A, B] = [await simples(a, c, "A"), await simples(a, c, "B")];
  const AB = await combinado(a, c, "AB", [A, B]);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [AB]);
  await recusa(a.query(arquivo(DOWN)), /108 rollback: existe salão combinado \(mesmo inativo\)/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal(await instalada(), true);
  await a.query(arquivo(POS));
  assert.equal(await manifesto(), true);
  assert.deepEqual(await objetos108(), catalogo108);
});
