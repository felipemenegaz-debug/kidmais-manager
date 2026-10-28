import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, catalogoNoTurno, cenario, completarCliente, decisoes, dia, executor, id, importacao, integrar, PARCIAL,
  poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * 27/10/2026 — APLICADOR REAL da 104/106 (scripts/migration-104-106-staging.cjs) no PostgreSQL descartável (plano rev. 2
 * aprovado; rodada 2 da revisão do código pelo Astra, P2-C1/P2-C2). Modelo 103 (staging sem 104/105/106) e modelo 105 (já
 * com a 104: só a 106). Única substituição: o cliente do aplicador conecta ao cluster descartável, responde à identidade
 * como o banco de staging, REGISTRA cada consulta e o SQLSTATE de cada erro (para provar a ordem das recusas e o 55P03),
 * e aceita ganchos antes de uma consulta (falha REAL dentro da transação) ou depois de um COMMIT (lock de outra sessão).
 * Toda recusa compara a IMPRESSÃO: schema public, ACL efetiva (aclexplode de coalesce(acl, acldefault)) de banco, schema,
 * relações e funções, e os DADOS das tabelas atingidas (md5 de cada linha de fechamento_revisoes, fechamentos, agenda_saloes).
 * No modelo 103, com revisões v1 REAIS criadas pelos serviços antes de tudo (POR_SALAO com salão no destino e POR_HORARIO):
 *   1. conferência PRONTA, contagens positivas, nada muda;
 *   2. recusas de catálogo (função de hash SECURITY DEFINER; 106 parcial) sem ler dados (consultas registradas);
 *   3. outra sessão com lock em fechamentos → ATIVIDADE_NAS_TABELAS (atividade lida, nada de contagens/checks);
 *   4. transação PREPARADA com lock em fechamentos (pid NULL; só se max_prepared_transactions > 0) → ATIVIDADE_NAO_VERIFICAVEL;
 *   5. papel mínimo não superusuário, cada privilégio retirado isoladamente → recusa nomeada antes de dados e de escrita;
 *      outro papel sem ser dono → DONO_*; com o mínimo, aplica as duas: hashes de TODAS as revisões v1 idênticos antes e
 *      depois, auditoria da 104 sobre elas; reexecução com ambas completas → JA_APLICADA sem reaplicar nem mudar nada;
 *   6. deriva com os nomes presentes (CHECK da 104; search_path de função da 106) → INTEGRIDADE_10x, nunca JA_APLICADA;
 *   7. downs → impressão inicial (inclusive ACL efetiva);
 *   8. falha REAL no DO dentro da transação da 104 (o gancho troca o CHECK na MESMA transação, antes da integridade) →
 *      NAO_COMMITADA, ROLLBACK de verdade: nada da 104 fica;
 *   9. 106 completa e 104 ausente (106 aplicada à mão) → aplica só a 104;
 *  10. falha REAL da 106 depois do COMMIT da 104: o gancho pega lock em fechamentos; a espera do aplicador é OBSERVADA por
 *      pg_blocking_pids e o erro é 55P03 (lock_timeout); 104 CONFIRMADO, 106 NAO_COMMITADA; marcador recusa repetição;
 *      renomeado → retomada aplica só a 106;
 *  11. revisão NOVA (v2) pelos serviços e uma preferência de salão válida: conferência e nova execução com auditoria e
 *      integridade sobre dados reais (revisões v2 ≥ 1, preferências ≥ 1), sem reaplicar.
 * Fica no cliente simulado: COMMIT indeterminado (08/57/58/XX, 40003, sem resposta).
 * Evidências (opcional): KIDMAIS_APLICADOR_104_106_EVIDENCIAS=<pasta> recebe os marcadores e a versão do servidor.
 */
let a: Client;
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; contagens?: Record<string, number | null>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-104-106-staging.cjs")) as Aplicador;
const comum = exigir(join(raiz, "scripts/migration-104-106-comum.cjs")) as { SQL_ATIVIDADE: string; ETAPAS: [string, string, string][] };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_104_106", OUTRO = "kidmais_teste_outro_104_106";
const HASH = "kidmais_hash_revisao_operacional(uuid)";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const DOWN104 = "database/rollback/20261027_104_revisao_hash_salao_down.sql";
const DOWN106 = "database/rollback/20261027_106_salao_preferido_down.sql";
const M106 = "database/migrations/20261027_106_salao_preferido.sql";
const textoDe = (nome: string) => sql(comum.ETAPAS.find((e) => e[0] === nome)![1]).replace(/\r\n/g, "\n");
const CHECKS = comum.ETAPAS.filter(([n]) => !n.startsWith("migration")).map(([n]) => textoDe(n));
const HORA = { inicio: "10:00", fim: "22:00" };
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "aplicador-104-106" });

/** Consultas e erros de cada cliente do aplicador (a ordem das recusas e o SQLSTATE vêm daqui). */
const registro: { consultas: string[]; erros: { consulta: string; code?: string }[]; pid?: number } = { consultas: [], erros: [] };
const leuDados = () => registro.consultas.some((q) => q === comum.SQL_ATIVIDADE || q.includes("AS saloes") || CHECKS.includes(q));
const leuAtividade = () => registro.consultas.includes(comum.SQL_ATIVIDADE);
const leuContagensOuChecks = () => registro.consultas.some((q) => q.includes("AS saloes") || CHECKS.includes(q));

type Ganchos = { papel?: string; antesDe?: (q: string, c: Client) => Promise<void>; aposCommit?: (n: number) => Promise<void> };
function clienteDescartavel(cfg: Ganchos = {}) {
  return class {
    c: Client | null = null;
    commits = 0;
    on() {}
    async connect() {
      registro.consultas = []; registro.erros = [];
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      registro.pid = (await this.c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string) {
      if (q === stg.SQL_IDENTIDADE) return { rows: [IDENTIDADE] };
      registro.consultas.push(q);
      if (cfg.antesDe) await cfg.antesDe(q, this.c!);
      try {
        const r = await this.c!.query(q);
        if (q === "COMMIT" && cfg.aposCommit) await cfg.aposCommit(++this.commits);
        return r;
      } catch (e) { registro.erros.push({ consulta: q.slice(0, 120), code: (e as { code?: string }).code }); throw e; }
    }
    async end() { if (this.c) await this.c.end(); }
  };
}

// Fixtures de revisões REAIS pelos serviços (mesmo caminho da suíte hash-revisao-104: importação → nova versão → editar).
type Operar = (id: string, acao: Record<string, unknown>, token: string, ctx: unknown, empresa: string) => Promise<unknown>;
const precificados = new Set<string>();
const nativos = new Map<string, Awaited<ReturnType<typeof catalogoNativo>>>();
async function comCommit<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { const r = await corpo(); await a.query("COMMIT"); return r; }
  catch (error) { await a.query("ROLLBACK"); throw error; }
  finally { restaurarAmbiente(); restaurarPool(); }
}
async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  nativos.set(c.empresa, await catalogoNativo(a, c));
  const conteudo = { titulo: "Contrato aplicador 104/106", contratada: { nome: "Buffet 104/106 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 106", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste" };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "b".repeat(64), c.usuario]);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
  return c;
}
const salao = (c: Cenario, nome: string, ordem: number) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, $2, $3, true) RETURNING id`, [c.empresa, nome, ordem]);
/** Contrato histórico integrado e uma revisão operacional aberta e editada para `destino`. */
async function revisaoAberta(c: Cenario, data: string, destino: string, tema: string) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const ev = { data, ...HORA };
  const imp = await importacao(a, c, ev);
  await completarCliente(a, imp.cliente);
  const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
  await validarAgora(a);
  const festa = (await a.query<{ id: string; cfg: string }>(
    `SELECT f.id::text, f.configuracao_agenda_id::text cfg FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [r.contratoId])).rows[0];
  const chave = `${c.empresa}:${festa.cfg}`;
  if (festa.cfg !== nativos.get(c.empresa)!.turno && !precificados.has(chave)) { await catalogoNoTurno(a, c, festa.cfg); precificados.add(chave); }
  const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
  await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: tema, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
  const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
  const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
  await operar(v2, { acao: "editar_festa", revisao, motivo: tema, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
    dataEvento: destino, configuracaoAgendaId: festa.cfg, horarioInicio: HORA.inicio, horarioFim: HORA.fim, adicionais: fonte.adicionais,
    idadeAniversarianteEvento: 6, temaFesta: tema, buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
    observacoesEquipe: "aplicador 104/106" }, c.token, ctxOp(), c.empresa);
  return { festa: festa.id, versao: v2 };
}
const hashes = async () => new Map((await a.query<{ id: string; h: string; c: string }>(
  `SELECT id::text, kidmais_hash_revisao_operacional(id) h, conteudo_hash c FROM fechamento_revisoes ORDER BY id`)).rows.map((r) => [r.id, `${r.h}|${r.c}`]));

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("aplicador 104/106 real: recusas antes de dados, papel mínimo, atividade e transação preparada, falhas reais antes/depois do COMMIT, combinações, revisões v1/v2", { timeout: 1_800_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const dirs: string[] = [];
  const evid = process.env.KIDMAIS_APLICADOR_104_106_EVIDENCIAS;
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-104-106-")); dirs.push(d); return d; };
  const guardar = (nome: string, d: string) => {
    if (!evid) return;
    mkdirSync(join(evid, nome), { recursive: true });
    for (const f of readdirSync(d)) copyFileSync(join(d, f), join(evid, nome, f));
  };
  const BACKUP = "PITR 2026-10-27T21:00Z teste";
  const executar = (dir = novoDir(), g: Ganchos = {}) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel(g) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  /** Schema public, ACL EFETIVA (padrão explicitado por acldefault) de banco/schema/relações/funções e dados das tabelas atingidas. */
  const impressao = async () => (await a.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY cl.relname, a.attname)
         FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), p.prosecdef, coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(x, ',' ORDER BY x) FROM (
         SELECT concat_ws(':', 'r', cl.relname, pg_get_userbyid(e.grantor), coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type, e.is_grantable) x
           FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace, aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) e WHERE n.nspname = 'public'
         UNION ALL SELECT concat_ws(':', 'f', p.proname, pg_get_userbyid(e.grantor), coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e WHERE n.nspname = 'public'
         UNION ALL SELECT concat_ws(':', 'n', pg_get_userbyid(e.grantor), coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type)
           FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) e WHERE n.nspname = 'public'
         UNION ALL SELECT concat_ws(':', 'd', pg_get_userbyid(e.grantor), coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type)
           FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) e WHERE d.datname = current_database()) acl),
      (SELECT md5(string_agg(md5(r::text), ',' ORDER BY r.id)) FROM fechamento_revisoes r),
      (SELECT md5(string_agg(md5(f::text), ',' ORDER BY f.id)) FROM fechamentos f),
      (SELECT md5(string_agg(md5(s::text), ',' ORDER BY s.id)) FROM agenda_saloes s))) AS h`)).rows[0].h;
  const objetos = async () => (await a.query<{ m104: boolean; m106: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped) AS m104,
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_preferido_id' AND NOT attisdropped) AS m106`)).rows[0];
  /**
   * Recusa: conferência código 3 e aplicação FALHA sem commit; impressão (schema, ACL efetiva e dados) igual. `ordem`:
   * "catalogo" = nenhuma leitura de dados (nem atividade); "atividade" = atividade lida, sem contagens nem checks.
   */
  const recusa = async (motivo: RegExp, ordem: "catalogo" | "atividade", papel?: string) => {
    const antes = await impressao();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    if (ordem === "catalogo") assert.ok(!leuDados(), "conferência: recusa antes de qualquer leitura de dados: " + motivo.source);
    else assert.ok(leuAtividade() && !leuContagensOuChecks(), "conferência: atividade lida, nada de contagens/checks");
    const e = await executar(novoDir(), { papel });
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    if (ordem === "catalogo") assert.ok(!leuDados(), "aplicação: recusa antes de qualquer leitura de dados");
    else assert.ok(!leuContagensOuChecks(), "aplicação: nada de contagens/checks");
    assert.equal(await impressao(), antes, "nada mudou (schema, ACL efetiva e dados): " + motivo.source);
  };
  const donos = (await a.query<{ revisoes: string; fechamentos: string; saloes: string; hash: string; banco: string }>(`SELECT
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.fechamento_revisoes'::regclass)) AS revisoes,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.fechamentos'::regclass)) AS fechamentos,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.agenda_saloes'::regclass)) AS saloes,
    pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.${HASH}'::regprocedure)) AS hash,
    current_database() AS banco`)).rows[0];
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const banco = q(donos.banco);
  try {
    assert.equal((await a.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NULL AS ok`)).rows[0].ok, true, "modelo sem a 098");
    if (evid) { mkdirSync(evid, { recursive: true }); writeFileSync(join(evid, "versao.txt"), (await a.query<{ v: string }>("SELECT version() AS v")).rows[0].v + "\n"); }
    const inicial = await objetos();

    if (inicial.m104) {
      // Modelo 105 (já com a 104): pula a 104 e aplica só a 106; depois o down da 106 volta ao início.
      assert.equal(inicial.m106, false);
      const antes = await impressao();
      const conf = await conferir();
      assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
      assert.deepEqual(conf.checks, { "integridade 104": "PASS", "postcheck 104": "PASS", "precheck 106": "PASS" });
      const d = novoDir();
      const ap = await executar(d);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.etapas, ["integridade 104", "postcheck 104", "precheck 106", "migration 106", "postcheck 106", "integridade 106"]);
      assert.deepEqual(ap.commits, { 106: "CONFIRMADO" });
      guardar("modelo-105", d);
      assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
      await a.query(sql(DOWN106));
      assert.equal(await impressao(), antes, "down da 106 volta ao início");
      return;
    }

    // Modelo 103: as duas ausentes. Revisões v1 REAIS antes de tudo (fazem parte do estado inicial).
    assert.deepEqual(inicial, { m104: false, m106: false });
    const D1 = dia(90), D2 = dia(91), D3 = dia(92), D4 = dia(93), D5 = dia(94);
    const fx = await comCommit(async () => {
      const cs = await empresa("POR_SALAO");
      const S1 = await salao(cs, "Salão A", 1); await salao(cs, "Salão B", 2);
      const p = await revisaoAberta(cs, D1, D2, "Circo");
      const ch = await empresa("POR_HORARIO");
      await revisaoAberta(ch, D1, D1, "Dinossauros");
      await validarAgora(a);
      return { cs, S1, festa: p.festa };
    });
    const hashesV1 = await hashes();
    assert.ok(hashesV1.size >= 2, "revisões v1 reais criadas");
    for (const [k, v] of hashesV1) { const [h, c] = v.split("|"); assert.equal(h, c, `revisão ${k}: hash gravado = função`); }
    const antes = await impressao();

    // 1. Conferência só leitura, contagens positivas.
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 104": "PASS", "precheck 106": "PASS" });
    assert.ok(Number(conf.contagens!.revisoes) >= 2 && Number(conf.contagens!.saloes) >= 2, JSON.stringify(conf.contagens));
    assert.equal(await impressao(), antes);

    // 2. Recusas de catálogo, antes de qualquer leitura de dados.
    await a.query(`ALTER FUNCTION public.${HASH} SECURITY DEFINER`);
    try { await recusa(/FUNCAO_HASH_DIVERGENTE_104/, "catalogo"); } finally { await a.query(`ALTER FUNCTION public.${HASH} SECURITY INVOKER`); }
    await a.query("ALTER TABLE fechamentos ADD COLUMN salao_preferido_id uuid");
    try { await recusa(/APLICACAO_PARCIAL_106/, "catalogo"); } finally { await a.query("ALTER TABLE fechamentos DROP COLUMN salao_preferido_id"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Outra sessão com lock em fechamentos.
    const outra = await conectarDescartavel({ travar: false });
    try {
      await outra.query("BEGIN");
      await outra.query("LOCK TABLE fechamentos IN ACCESS SHARE MODE");
      await recusa(/ATIVIDADE_NAS_TABELAS 1/, "atividade");
    } finally { await outra.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(outra); }

    // 4. Transação PREPARADA (pid NULL em pg_locks) — só com max_prepared_transactions > 0 no cluster.
    const preparadas = (await a.query<{ n: number }>("SELECT current_setting('max_prepared_transactions')::int AS n")).rows[0].n;
    assert.ok(Number.isInteger(preparadas), "max_prepared_transactions legível");
    if (preparadas > 0) {
      const p = await conectarDescartavel({ travar: false });
      try {
        await p.query("BEGIN");
        await p.query("LOCK TABLE fechamentos IN ACCESS SHARE MODE");
        await p.query("PREPARE TRANSACTION 'aplicador_104_106_teste'");
        try { await recusa(/ATIVIDADE_NAO_VERIFICAVEL 1 sem contexto visível \(1 lock\(s\) sem pid: transação preparada\)/, "atividade"); }
        finally { await a.query("ROLLBACK PREPARED 'aplicador_104_106_teste'"); }
      } finally { await encerrarDescartavel(p); }
    } else t.diagnostic(`max_prepared_transactions = ${preparadas}: prova da transação preparada não executada neste cluster`);

    // 5. Papel mínimo não superusuário; cada privilégio retirado isoladamente. Precondição do modelo: TEMP do banco e
    // EXECUTE da função de hash vêm de PUBLIC (padrão); a impressão compara a ACL EFETIVA no fim.
    assert.equal((await a.query<{ ok: boolean }>(`SELECT has_database_privilege('public', current_database(), 'TEMP')
      AND has_function_privilege('public', 'public.${HASH}', 'EXECUTE') AS ok`)).rows[0].ok, true, "precondição: TEMP e EXECUTE vêm de PUBLIC");
    for (const p of [MINIMO, OUTRO]) await a.query(`DROP ROLE IF EXISTS ${p}`);
    await a.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    await a.query(`CREATE ROLE ${OUTRO} NOLOGIN NOSUPERUSER`);
    await a.query(`REVOKE TEMP ON DATABASE ${banco} FROM PUBLIC`);
    await a.query(`REVOKE EXECUTE ON FUNCTION public.${HASH} FROM PUBLIC`);
    try {
      for (const p of [MINIMO, OUTRO]) {
        await a.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${p}`);
        await a.query(`GRANT TEMP ON DATABASE ${banco} TO ${p}`);
        await a.query(`GRANT SELECT ON fechamento_revisoes, fechamento_revisao_adicionais, fechamentos, agenda_saloes TO ${p}`);
        await a.query(`GRANT EXECUTE ON FUNCTION public.${HASH} TO ${p}`);
        await a.query(`GRANT pg_read_all_stats TO ${p}`);
      }
      await a.query(`GRANT TRIGGER, UPDATE ON fechamento_revisoes TO ${OUTRO}`);
      await a.query(`GRANT TRIGGER ON fechamentos TO ${OUTRO}`);
      await a.query(`GRANT TRIGGER, REFERENCES ON agenda_saloes TO ${OUTRO}`);
      await a.query(`ALTER TABLE fechamento_revisoes OWNER TO ${MINIMO}`);
      await a.query(`ALTER FUNCTION public.${HASH} OWNER TO ${MINIMO}`);
      await a.query(`ALTER TABLE fechamentos OWNER TO ${MINIMO}`);
      await a.query(`ALTER TABLE agenda_saloes OWNER TO ${MINIMO}`);
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
      assert.equal(pronta.estado!.papel_trocado, true);
      await recusa(/SEM_PRIVILEGIO_104 DONO_FECHAMENTO_REVISOES DONO_FUNCAO_HASH$/, "catalogo", OUTRO);
      for (const [revogar, conceder, motivo] of [
        [`REVOKE TEMP ON DATABASE ${banco} FROM ${MINIMO}`, `GRANT TEMP ON DATABASE ${banco} TO ${MINIMO}`, /SEM_PRIVILEGIO_104 TEMP$/],
        [`REVOKE TRIGGER ON fechamento_revisoes FROM ${MINIMO}`, `GRANT TRIGGER ON fechamento_revisoes TO ${MINIMO}`, /SEM_PRIVILEGIO_104 TRIGGER$/],
        [`REVOKE UPDATE, DELETE, TRUNCATE, MAINTAIN ON fechamento_revisoes FROM ${MINIMO}`, `GRANT UPDATE, DELETE, TRUNCATE, MAINTAIN ON fechamento_revisoes TO ${MINIMO}`, /SEM_PRIVILEGIO_104 LOCK$/],
        [`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`, `GRANT CREATE ON SCHEMA public TO ${MINIMO}`, /SEM_PRIVILEGIO_104 CREATE$/],
        [`REVOKE SELECT ON fechamento_revisao_adicionais FROM ${MINIMO}`, `GRANT SELECT ON fechamento_revisao_adicionais TO ${MINIMO}`, /SEM_PRIVILEGIO_LEITURA SELECT_FECHAMENTO_REVISAO_ADICIONAIS$/],
        [`REVOKE EXECUTE ON FUNCTION public.${HASH} FROM ${MINIMO}`, `GRANT EXECUTE ON FUNCTION public.${HASH} TO ${MINIMO}`, /SEM_PRIVILEGIO_LEITURA EXECUTE_HASH$/],
        [`REVOKE TRIGGER ON fechamentos FROM ${MINIMO}`, `GRANT TRIGGER ON fechamentos TO ${MINIMO}`, /SEM_PRIVILEGIO_106 TRIGGER_FECHAMENTOS$/],
        [`REVOKE TRIGGER ON agenda_saloes FROM ${MINIMO}`, `GRANT TRIGGER ON agenda_saloes TO ${MINIMO}`, /SEM_PRIVILEGIO_106 TRIGGER_AGENDA_SALOES$/],
        [`REVOKE REFERENCES ON agenda_saloes FROM ${MINIMO}`, `GRANT REFERENCES ON agenda_saloes TO ${MINIMO}`, /SEM_PRIVILEGIO_106 REFERENCES$/],
        [`REVOKE pg_read_all_stats FROM ${MINIMO}`, `GRANT pg_read_all_stats TO ${MINIMO}`, /ATIVIDADE_NAO_VERIFICAVEL/],
      ] as const) {
        await a.query(revogar);
        try { await recusa(motivo, "catalogo", MINIMO); } finally { await a.query(conceder); }
      }
      // Com o mínimo, o papel não superusuário aplica as duas; os hashes das revisões v1 reais não mudam.
      const dirMin = novoDir();
      const ap = await executar(dirMin, { papel: MINIMO });
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 104: "CONFIRMADO", 106: "CONFIRMADO" });
      assert.deepEqual(await hashes(), hashesV1, "hash de TODAS as revisões v1 idêntico depois da 104 aplicada pelo aplicador");
      guardar("5-papel-minimo", dirMin);
      // Ambas completas: nova execução não reaplica nada e não muda nada.
      const completas = await impressao();
      const j = await executar(novoDir(), { papel: MINIMO });
      assert.equal(j.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(j));
      assert.deepEqual(j.etapas, ["integridade 104", "postcheck 104", "integridade 106"]); assert.deepEqual(j.commits, {});
      assert.ok(!registro.consultas.some((x) => x.includes("ALTER TABLE")), "nenhum DDL na reexecução");
      assert.equal(await impressao(), completas);

      // 6. Deriva com todos os nomes presentes: integridade recusa, nunca JA_APLICADA.
      await a.query("ALTER TABLE fechamento_revisoes DROP CONSTRAINT fechamento_revisoes_hash_versao_ck, ADD CONSTRAINT fechamento_revisoes_hash_versao_ck CHECK (hash_versao IN (1, 2, 3))");
      try {
        const d = await conferir(); assert.equal(d.resultado, "RECUSARIA", JSON.stringify(d)); assert.match(d.motivo!, /INTEGRIDADE_104/);
      } finally { await a.query("ALTER TABLE fechamento_revisoes DROP CONSTRAINT fechamento_revisoes_hash_versao_ck, ADD CONSTRAINT fechamento_revisoes_hash_versao_ck CHECK (hash_versao IN (1, 2))"); }
      await a.query("ALTER FUNCTION public.kidmais106_salao_preferido_escopo() SET search_path = public");
      try {
        const d = await conferir(); assert.equal(d.resultado, "RECUSARIA", JSON.stringify(d)); assert.match(d.motivo!, /INTEGRIDADE_106/);
      } finally { await a.query("ALTER FUNCTION public.kidmais106_salao_preferido_escopo() SET search_path = public, pg_catalog"); }
      assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "definições restauradas");

      // 7. Downs (só no descartável).
      await a.query(sql(DOWN106));
      await a.query(sql(DOWN104));
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await a.query(`ALTER TABLE fechamento_revisoes OWNER TO ${q(donos.revisoes)}`);
      await a.query(`ALTER FUNCTION public.${HASH} OWNER TO ${q(donos.hash)}`);
      await a.query(`ALTER TABLE fechamentos OWNER TO ${q(donos.fechamentos)}`);
      await a.query(`ALTER TABLE agenda_saloes OWNER TO ${q(donos.saloes)}`);
      await a.query(`GRANT TEMP ON DATABASE ${banco} TO PUBLIC`);
      await a.query(`GRANT EXECUTE ON FUNCTION public.${HASH} TO PUBLIC`);
      for (const p of [MINIMO, OUTRO]) {
        await a.query(`REASSIGN OWNED BY ${p} TO ${q(donos.fechamentos)}`); await a.query(`DROP OWNED BY ${p}`); await a.query(`DROP ROLE ${p}`);
      }
    }
    assert.deepEqual(await objetos(), { m104: false, m106: false }, "downs voltaram ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial (schema, ACL efetiva e dados) depois dos downs");

    // 8. Falha REAL no DO dentro da transação da 104: o gancho troca o CHECK na MESMA transação, antes da integridade.
    const I104 = textoDe("integridade 104");
    const dirDo = novoDir();
    // A 1ª vez que a integridade da 104 é enviada é DENTRO da transação da migration (o plano começa no precheck).
    let primeira = true;
    const fDo = await executar(dirDo, { antesDe: async (consulta, cl) => {
      if (consulta === I104 && primeira) {
        primeira = false;
        await cl.query("ALTER TABLE fechamento_revisoes DROP CONSTRAINT fechamento_revisoes_hash_versao_ck, ADD CONSTRAINT fechamento_revisoes_hash_versao_ck CHECK (hash_versao IN (1, 2, 3))");
      }
    } });
    assert.equal(fDo.resultado, "FALHA", JSON.stringify(fDo)); assert.match(fDo.falha!.mensagem, /INTEGRIDADE_104/);
    assert.deepEqual(fDo.commits, { 104: "NAO_COMMITADA" });
    assert.ok(registro.erros.some((e) => e.code === "P0001"), "exceção do bloco DO (P0001) dentro da transação");
    assert.deepEqual(await objetos(), { m104: false, m106: false }, "ROLLBACK de verdade: nada da 104 ficou");
    assert.equal(await impressao(), antes);
    guardar("8-falha-do", dirDo);

    // 9. 106 completa e 104 ausente: aplica só a 104.
    await a.query(sql(M106));
    try {
      const d9 = novoDir();
      const r9 = await executar(d9);
      assert.equal(r9.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(r9));
      assert.deepEqual(r9.etapas, ["precheck 104", "migration 104", "integridade 104", "postcheck 104", "integridade 106"]);
      assert.deepEqual(r9.commits, { 104: "CONFIRMADO" });
      guardar("9-so-104", d9);
    } finally { await a.query(sql(DOWN106)).catch(() => undefined); await a.query(sql(DOWN104)).catch(() => undefined); }
    assert.equal(await impressao(), antes, "combinação desfeita");

    // 10. Falha REAL da 106 depois do COMMIT da 104: lock de outra sessão em fechamentos; espera observada; 55P03.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    let esperaObservada = false;
    try {
      const pendente = executar(dirFalha, { aposCommit: async (n) => {
        if (n !== 1) return;
        await trava.query("BEGIN");
        await trava.query("LOCK TABLE fechamentos IN ACCESS SHARE MODE");
      } });
      for (let i = 0; i < 300 && !esperaObservada; i++) {
        if (registro.pid) {
          const b = (await a.query<{ b: number[] }>("SELECT pg_blocking_pids($1::int) AS b", [registro.pid])).rows[0].b;
          if (b.length > 0) esperaObservada = true;
        }
        if (!esperaObservada) await new Promise((r) => setTimeout(r, 20));
      }
      const f = await pendente;
      assert.ok(esperaObservada, "a espera do aplicador pelo lock em fechamentos foi observada (pg_blocking_pids)");
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 104: "CONFIRMADO", 106: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 106");
      assert.ok(registro.erros.some((e) => e.code === "55P03"), "lock_timeout (55P03) na migration 106: " + JSON.stringify(registro.erros));
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.deepEqual(await objetos(), { m104: true, m106: false }, "104 confirmada, 106 ausente");
    assert.deepEqual(await hashes(), hashesV1, "hashes v1 preservados");
    guardar("10-falha-106", dirFalha);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-104-106.json"), join(dirFalha, "migration-104-106.2026-10-27T22-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.etapas, ["integridade 104", "postcheck 104", "precheck 106", "migration 106", "postcheck 106", "integridade 106"]);
    assert.deepEqual(retomada.commits, { 106: "CONFIRMADO" });
    guardar("10-retomada", dirFalha);

    // 11. Revisão NOVA (v2) pelos serviços e uma preferência válida: auditoria e integridade sobre dados reais.
    await comCommit(async () => { await revisaoAberta(fx.cs, D3, D4, "Espacial"); await validarAgora(a); });
    await a.query("UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid", [fx.festa, fx.S1]);
    const v = (await a.query<{ v1: number; v2: number }>(`SELECT count(*) FILTER (WHERE hash_versao = 1)::int v1, count(*) FILTER (WHERE hash_versao = 2)::int v2 FROM fechamento_revisoes`)).rows[0];
    assert.ok(v.v1 >= 2 && v.v2 >= 1, "revisões v1 e v2 reais: " + JSON.stringify(v));
    const final = await conferir();
    assert.equal(final.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(final));
    assert.deepEqual(final.checks, { "integridade 104": "PASS", "postcheck 104": "PASS", "integridade 106": "PASS" });
    assert.ok(Number(final.contagens!.revisoes_v2) >= 1 && Number(final.contagens!.fechamentos_com_preferencia) >= 1, JSON.stringify(final.contagens));
    const antesRepetir = await impressao();
    const repetida = await executar(novoDir());
    assert.equal(repetida.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(repetida)); assert.deepEqual(repetida.commits, {});
    assert.equal(await impressao(), antesRepetir, "auditoria repetida não muda nada");
    void D5;
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
