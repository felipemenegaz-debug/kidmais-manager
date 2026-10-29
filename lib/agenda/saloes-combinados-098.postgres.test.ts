import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 098 (fase 1 dos salões: salão combinado) no PostgreSQL DESCARTÁVEL, modelo 094 com a 098 aplicada aqui:
 * instalação, verificador, 098 parcial recusada, rollback e reaplicação; guardas por SQL direto (formato dos membros,
 * identidade imutável, DELETE de membro, TRUNCATE, recheck diferido); conflito por interseção e paridade SQL × Core;
 * invariante de elegibilidade e D5; corte de "hoje" em São Paulo com sessão em outro fuso; concorrência real entre
 * conexões nas duas ordens com espera observada (pg_blocking_pids) e sem deadlock; cadastro pelo Core (lock do escopo,
 * D5 com a lista de festas) e a ocupação do dia por salão. Os caminhos de serviço com contrato ficam em
 * saloes-caminhos-098.postgres.test.ts.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIG = "database/migrations/20261023_098_saloes_combinados.sql";
const DOWN = "database/rollback/20261023_098_saloes_combinados_down.sql";
const PRE = "database/checks/20261023_098_precheck.sql";
const POS = "database/checks/20261023_098_postcheck.sql";
const INT = "database/checks/20261023_098_integridade.sql";
const INT094 = "database/checks/20261022_094_integridade.sql";
/** Sem BEGIN/COMMIT próprios: para rodar dentro da transação do teste (recusa conferida sem efeito). */
const semTransacao = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");

let a: Client;
const D = dia(40);

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
const instalada = async () => (await a.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL AS ok`)).rows[0]!.ok;
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

// Decisão de Felipe (29/10/2026, retomada da 098, P2-1b): o código só suporta a 108; a 098 histórica é RECUSADA pelos
// serviços de salão. Os testes desta suíte que passavam pelos serviços (paridade SQL × Core, "hoje" de São Paulo pelo
// Core, D5 com o cadastro e reserva × cadastro em lote) foram PORTADOS para saloes-combinados-108.postgres.test.ts
// (modelo 107 + 108). Aqui ficam as provas da 098 em SQL direto (instalação, rollback, retrato, guardas, interseção e
// concorrência por SQL).
test.before(async () => {
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("instalação: código novo + 094 válido; precheck recusa festa futura em salão inativo; 098 com pre/post/integridade; segunda aplicação recusada", async () => {
  assert.equal(await instalada(), false);
  assert.equal(await manifesto(), true, "código novo com a 094 (conjunto 094)");
  await a.query(arquivo(INT094));
  await recusa(a.query(arquivo(INT)), /098 integridade/);
  // Invariante desde a instalação: festa de hoje (São Paulo) em salão inativo recusa o precheck e a migration.
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    const cfg = await configurar(a, c);
    const s = await simples(a, c, "Salão Velho");
    await festa(a, c, cfg, D, s);
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [s]);
    await recusaSql(a, arquivo(PRE), [], /098 precheck: festa de hoje em diante em salão inativo/);
    await recusaSql(a, semTransacao(arquivo(MIG)), [], /098: há festa de hoje em diante em salão inativo/);
  } finally {
    await a.query("ROLLBACK");
  }
  await a.query(arquivo(PRE));
  await a.query(arquivo(MIG));
  await a.query(arquivo(POS));
  await a.query(arquivo(INT));
  await recusa(a.query(arquivo(MIG)), /098: precheck falhou/);
  await a.query("ROLLBACK").catch(() => undefined);
  await recusa(a.query(arquivo(PRE)), /098 precheck: aplicação anterior/);
  assert.equal(await instalada(), true);
  assert.equal(await manifesto(), true, "código novo com a 098 (conjunto 098)");
  // A 094 integridade deixa de passar (três corpos trocados): a 098 a substitui.
  await recusa(a.query(arquivo(INT094)), /094 integridade/);
});

test("retrato estrutural: independe do search_path da sessão e o restaura", async () => {
  // Caminhos com public: verificador e postcheck inteiros. Só pg_catalog: o bloco do retrato isolado (os demais checks
  // do repositório usam nomes não qualificados, como sempre).
  const integridade = arquivo(INT).replaceAll("\r", "");
  const blocoRetrato = integridade.slice(integridade.indexOf("-- @@BLOCO-RETRATO-INICIO 098"), integridade.indexOf("-- @@BLOCO-RETRATO-FIM 098"));
  assert.ok(blocoRetrato.includes("DO $$"));
  for (const caminho of ['"$user", public', "public, pg_catalog", "pg_catalog, public", "pg_catalog"]) {
    await a.query(`SET search_path = ${caminho}`);
    if (caminho === "pg_catalog") await a.query(blocoRetrato);
    else {
      await a.query(arquivo(INT));
      await a.query(arquivo(POS));
    }
    assert.equal((await a.query<{ search_path: string }>("SHOW search_path")).rows[0]!.search_path, caminho, "search_path restaurado");
  }
  await a.query("RESET search_path");
});

test("rollback no estado limpo: volta à 094 completa (integridade 094 e manifesto), recusa repetir; reaplicação devolve a 098", async () => {
  await a.query(arquivo(DOWN));
  assert.equal(await instalada(), false);
  await a.query(arquivo(INT094));
  assert.equal(await manifesto(), true, "conjunto 094");
  assert.equal((await a.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agenda_saloes' AND column_name IN ('combinado','membros')`)).rowCount, 0);
  assert.equal((await a.query(`SELECT 1 FROM pg_trigger WHERE tgname LIKE '%\\_098\\_%'`)).rowCount, 0);
  await recusa(a.query(arquivo(DOWN)), /a 098 não está aplicada/);
  await a.query("ROLLBACK").catch(() => undefined);
  await a.query(arquivo(PRE));
  await a.query(arquivo(MIG));
  await a.query(arquivo(POS));
  await a.query(arquivo(INT));
  assert.equal(await manifesto(), true);
});

test("rollback recusa 098 parcial ou alterada e é atômico: gatilho da 094 ou da 098 desligado, deriva de corpo, pós-condição da 094", async () => {
  // P2-1 da revisão do Astra (reprodução dele: gatilho da 094 desligado → o rollback concluía e a 094 ficava incompleta).
  const estado = async () => (await a.query<{ n: number }>(`SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'kidmais098\\_%'`)).rows[0]!.n;
  const original = (nome: string) => {
    const m = arquivo(MIG).replaceAll("\r", "").match(new RegExp(String.raw`CREATE FUNCTION public\.` + nome + String.raw`\([\s\S]*?\$\$;`));
    assert.ok(m, nome);
    return m[0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  };
  const casos: Array<[string, RegExp, string]> = [
    ["ALTER TABLE public.fechamentos DISABLE TRIGGER fechamentos_094_salao_trg", /098 integridade: gatilho/,
      "ALTER TABLE public.fechamentos ENABLE TRIGGER fechamentos_094_salao_trg"],
    ["ALTER TABLE public.contratos DISABLE TRIGGER contratos_098_guarda_trg", /098 integridade: gatilho/,
      "ALTER TABLE public.contratos ENABLE TRIGGER contratos_098_guarda_trg"],
    ["ALTER TABLE public.agenda_saloes DISABLE TRIGGER agenda_saloes_098_combinado_diferido", /098 integridade: gatilho/,
      "ALTER TABLE public.agenda_saloes ENABLE TRIGGER agenda_saloes_098_combinado_diferido"],
    ["CREATE OR REPLACE FUNCTION public.kidmais098_conjunto(salao uuid) RETURNS uuid[] LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$ SELECT ARRAY[salao] $$",
      /098 integridade: corpo/, original("kidmais098_conjunto")],
    // Rodada 3 do Astra: coluna salao_id com outra definição (NOT NULL, DEFAULT) é recusada antes de qualquer remoção.
    ["ALTER TABLE public.fechamentos ALTER COLUMN salao_id SET NOT NULL", /098 integridade: coluna salao_id/,
      "ALTER TABLE public.fechamentos ALTER COLUMN salao_id DROP NOT NULL"],
    ["ALTER TABLE public.fechamento_revisoes ALTER COLUMN salao_id SET DEFAULT gen_random_uuid()", /098 integridade: coluna salao_id/,
      "ALTER TABLE public.fechamento_revisoes ALTER COLUMN salao_id DROP DEFAULT"],
    // Rodada 4 do Astra: deriva que as checagens pontuais não viam — pega pelo retrato estrutural canônico.
    ["ALTER TABLE public.agenda_saloes ALTER COLUMN id SET DEFAULT '11111111-1111-4111-8111-111111111111'::uuid", /098 retrato: estrutura diferente do estado 098/,
      // A 093 criou o default com search_path = public, pg_catalog: public.gen_random_uuid() (pgcrypto), não o do catálogo.
      "ALTER TABLE public.agenda_saloes ALTER COLUMN id SET DEFAULT public.gen_random_uuid()"],
    ["CREATE UNIQUE INDEX fechamentos_salao_unico_098 ON public.fechamentos (salao_id)", /098 retrato: estrutura diferente do estado 098/,
      "DROP INDEX public.fechamentos_salao_unico_098"],
    ["ALTER FUNCTION public.kidmais019_validar_destino(uuid) SET search_path = pg_catalog", /098 retrato: estrutura diferente do estado 098/,
      "ALTER FUNCTION public.kidmais019_validar_destino(uuid) SET search_path = public, pg_catalog"],
    ["ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check", /098 integridade: constraint/,
      "ALTER TABLE public.agenda_saloes ADD CONSTRAINT agenda_saloes_098_membros_check CHECK (CASE WHEN combinado THEN kidmais098_membros_canonicos(membros) ELSE membros IS NULL END)"],
  ];
  for (const [adulteracao, trecho, desfazer] of casos) {
    await a.query(adulteracao);
    await recusa(a.query(arquivo(DOWN)), trecho);
    await a.query("ROLLBACK").catch(() => undefined);
    assert.equal(await estado(), 10, `nada removido: ${adulteracao}`);
    await a.query(desfazer);
    await a.query(arquivo(INT));
  }
  // Rodada 2 do Astra (P2-1): FK para agenda_saloes com coluna, ação ou quantidade errada é recusada pelo verificador
  // e pelo rollback, sem remover nada; reconstruída a original, o verificador volta a passar.
  const fkDe = async (tabela: string) => (await a.query<{ nome: string; def: string }>(
    `SELECT conname AS nome, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid = to_regclass('public.' || $1) AND confrelid = to_regclass('public.agenda_saloes')`, [tabela])).rows;
  const [fkFechamento] = await fkDe("fechamentos");
  const [fkPacote] = await fkDe("pacote_saloes");
  assert.ok(fkFechamento && fkPacote);
  const restaurar = (tabela: string, fk: { nome: string; def: string }) =>
    `ALTER TABLE public.${tabela} DROP CONSTRAINT ${fk.nome}; ALTER TABLE public.${tabela} ADD CONSTRAINT ${fk.nome} ${fk.def}`;
  const casosFk: Array<[string, string]> = [
    // Reprodução do Astra: mesmo nome e ações, mas de fechamentos.id (validada).
    [`ALTER TABLE public.fechamentos DROP CONSTRAINT ${fkFechamento.nome};
      ALTER TABLE public.fechamentos ADD CONSTRAINT ${fkFechamento.nome} FOREIGN KEY (id) REFERENCES public.agenda_saloes(id) ON DELETE RESTRICT ON UPDATE RESTRICT`,
     restaurar("fechamentos", fkFechamento)],
    // Coluna certa, ação errada.
    [`ALTER TABLE public.fechamentos DROP CONSTRAINT ${fkFechamento.nome};
      ALTER TABLE public.fechamentos ADD CONSTRAINT ${fkFechamento.nome} FOREIGN KEY (salao_id) REFERENCES public.agenda_saloes(id) ON DELETE CASCADE ON UPDATE RESTRICT`,
     restaurar("fechamentos", fkFechamento)],
    // FK extra (substituta) para agenda_saloes na mesma tabela, ao lado da certa.
    [`ALTER TABLE public.pacote_saloes ADD CONSTRAINT pacote_saloes_extra_098_fk FOREIGN KEY (pacote_id) REFERENCES public.agenda_saloes(id) NOT VALID`,
     `ALTER TABLE public.pacote_saloes DROP CONSTRAINT pacote_saloes_extra_098_fk`],
  ];
  for (const [adulteracao, desfazer] of casosFk) {
    await a.query(adulteracao);
    await recusa(a.query(arquivo(INT)), /098 integridade: FK para agenda_saloes/);
    await recusa(a.query(arquivo(DOWN)), /098 integridade: FK para agenda_saloes/);
    await a.query("ROLLBACK").catch(() => undefined);
    assert.equal(await estado(), 10, `nada removido: ${adulteracao}`);
    await a.query(desfazer);
    await a.query(arquivo(INT));
  }
  // Rodada 5 do Astra (P2-1): (1) gatilhos INTERNOS da FK fechamentos.salao_id → agenda_saloes desligados, nos dois
  // lados (referenciador e referenciado); (2) dependência direta renomeada (configuracao_agenda.capacidade, lida por
  // kidmais094_conflito_ocupacao). O verificador e o rollback recusam pelo retrato, sem remover nada.
  const internos = (await a.query<{ tabela: string; nome: string }>(
    `SELECT t.tgrelid::regclass::text AS tabela, t.tgname AS nome FROM pg_trigger t JOIN pg_constraint k ON k.oid = t.tgconstraint
      WHERE t.tgisinternal AND k.contype = 'f' AND k.conrelid = 'public.fechamentos'::regclass AND k.confrelid = 'public.agenda_saloes'::regclass
      ORDER BY t.tgname`)).rows;
  assert.equal(internos.length, 4, "check_ins/check_upd em fechamentos e os de agenda_saloes");
  const ladoReferenciador = internos.filter((t) => /fechamentos/.test(t.tabela));
  const ladoReferenciado = internos.filter((t) => /agenda_saloes/.test(t.tabela));
  assert.equal(ladoReferenciador.length, 2);
  assert.equal(ladoReferenciado.length, 2);
  const casosR5: Array<[string, string]> = [
    [ladoReferenciador.map((t) => `ALTER TABLE ${t.tabela} DISABLE TRIGGER "${t.nome}"`).join("; "),
      ladoReferenciador.map((t) => `ALTER TABLE ${t.tabela} ENABLE TRIGGER "${t.nome}"`).join("; ")],
    [ladoReferenciado.map((t) => `ALTER TABLE ${t.tabela} DISABLE TRIGGER "${t.nome}"`).join("; "),
      ladoReferenciado.map((t) => `ALTER TABLE ${t.tabela} ENABLE TRIGGER "${t.nome}"`).join("; ")],
    ["ALTER TABLE public.configuracao_agenda RENAME COLUMN capacidade TO capacidade_r5",
      "ALTER TABLE public.configuracao_agenda RENAME COLUMN capacidade_r5 TO capacidade"],
  ];
  for (const [adulteracao, desfazer] of casosR5) {
    await a.query(adulteracao);
    await recusa(a.query(arquivo(INT)), /098 retrato: estrutura diferente do estado 098/);
    await recusa(a.query(arquivo(DOWN)), /098 retrato: estrutura diferente do estado 098/);
    await a.query("ROLLBACK").catch(() => undefined);
    assert.equal(await estado(), 10, `nada removido: ${adulteracao}`);
    await a.query(desfazer);
    await a.query(arquivo(INT));
  }
  // Rodada 6 do Astra (P3): dependência só TRANSITIVA (tabela_preco_escopos entra pelo gatilho/função de uma
  // dependência direta) e atributos de sequência do escopo também são recusados pelo retrato.
  const casosR6: Array<[string, string]> = [
    ["ALTER TABLE public.tabela_preco_escopos ADD COLUMN coluna_r6 integer", "ALTER TABLE public.tabela_preco_escopos DROP COLUMN coluna_r6"],
    ["ALTER SEQUENCE public.festa_eventos_sequencia_seq INCREMENT BY 2", "ALTER SEQUENCE public.festa_eventos_sequencia_seq INCREMENT BY 1"],
  ];
  for (const [adulteracao, desfazer] of casosR6) {
    await a.query(adulteracao);
    await recusa(a.query(arquivo(INT)), /098 retrato: estrutura diferente do estado 098/);
    await recusa(a.query(arquivo(DOWN)), /098 retrato: estrutura diferente do estado 098/);
    await a.query("ROLLBACK").catch(() => undefined);
    assert.equal(await estado(), 10, `nada removido: ${adulteracao}`);
    await a.query(desfazer);
    await a.query(arquivo(INT));
  }
  // Políticas RLS: os papéis entram no retrato (mudar só os papéis muda o texto).
  const expressao = (() => {
    const fonte = arquivo("database/checks/20261023_098_retrato.sql").replaceAll("\r", "");
    return fonte.slice(fonte.indexOf("-- @@RETRATO-INICIO"), fonte.indexOf("-- @@RETRATO-FIM") + "-- @@RETRATO-FIM".length);
  })();
  const retratoAgora = async () => {
    await a.query("SET LOCAL search_path = pg_catalog");
    const r = (await a.query<{ x: string }>(`SELECT (${expressao}\n) AS x`)).rows[0]!.x;
    await a.query("SET LOCAL search_path = public");
    return r;
  };
  await a.query("BEGIN");
  try {
    await a.query(`CREATE POLICY politica_r6 ON public.agenda_saloes FOR SELECT TO PUBLIC USING (true)`);
    const paraTodos = await retratoAgora();
    await a.query(`ALTER POLICY politica_r6 ON public.agenda_saloes TO kidmais_descartavel`);
    const paraUm = await retratoAgora();
    assert.match(paraTodos, /P\|agenda_saloes\|politica_r6\|r\|true\|public\|/);
    assert.match(paraUm, /P\|agenda_saloes\|politica_r6\|r\|true\|kidmais_descartavel\|/);
    assert.notEqual(paraTodos, paraUm);
  } finally {
    await a.query("ROLLBACK");
  }
  // Pós-condição: um rollback cujo resultado não seja a 094 completa (aqui, o corpo restaurado do conflito com uma
  // mudança) é recusado pelo verificador da 094 dentro da mesma transação, e NADA muda.
  const down = arquivo(DOWN).replaceAll("\r", "");
  const mutante = down.replace("RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o", "RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) AS o");
  assert.notEqual(mutante, down);
  await recusa(a.query(mutante), /094 integridade: corpo/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal(await instalada(), true);
  assert.equal(await estado(), 10);
  await a.query(arquivo(INT));
  assert.equal(await manifesto(), true);
});

test("098 parcial é recusada: corpo da 094 num validador, gatilho removido ou desligado, CHECK removido", async () => {
  const corpo094 = arquivo("database/migrations/20261022_094_agenda_capacidade.sql").replaceAll("\r", "")
    .match(/CREATE OR REPLACE FUNCTION public\.kidmais_validar_agenda_revisao\(\)[\s\S]*?\$\$;/)![0];
  const casos: Array<[string, RegExp]> = [
    [corpo094, /corpo de função/],
    ["DROP TRIGGER agenda_saloes_098_guarda_trg ON public.agenda_saloes", /gatilho/],
    ["ALTER TABLE public.contratos DISABLE TRIGGER contratos_098_guarda_trg", /gatilho/],
    ["ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check", /constraint/],
    ["CREATE RULE r098 AS ON DELETE TO public.contratos DO INSTEAD NOTHING", /regra ou privilégio/],
  ];
  for (const [sql, trecho] of casos) {
    await a.query("BEGIN");
    try {
      await a.query(sql);
      if (sql === corpo094) assert.equal(await manifesto(), false, "098 parcial: nenhum conjunto coerente");
      await recusa(a.query(arquivo(INT)), trecho);
    } finally {
      await a.query("ROLLBACK");
    }
  }
  await a.query(arquivo(INT));
  assert.equal(await manifesto(), true);
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

test("rollback adversarial: qualquer combinado (mesmo inativo e sem referência) recusa; nada muda", async () => {
  const c = await cenario(a, 0);
  const [A, B] = [await simples(a, c, "A"), await simples(a, c, "B")];
  const AB = await combinado(a, c, "AB", [A, B]);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [AB]);
  await recusa(a.query(arquivo(DOWN)), /existe salão combinado/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal(await instalada(), true);
  await a.query(arquivo(INT));
  assert.equal(await manifesto(), true);
});
