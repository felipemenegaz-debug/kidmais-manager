import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, executor, id } from "../../scripts/integracao-importados-test-support.ts";
import { concluirCota, cotaInstalada, liberarCota, reservarCota, resumoCota, type Posse } from "./cota.ts";

/**
 * 08/11/2026 — APLICADOR REAL da 118 (scripts/migration-118-staging.cjs) no PostgreSQL descartável, no modelo 117: o esquema
 * do staging ANTES da 118 (inventário até a 117 sem a 098 — 112, 114, 116 e 117 presentes). Dados reais nas 2 tabelas que a
 * 118 trava (empresa ATIVA e documentos com original). Única substituição: o cliente do aplicador conecta ao cluster
 * descartável e responde à consulta de identidade como o banco de staging. Toda recusa compara a IMPRESSÃO do schema public
 * (antes = depois) e o retrato das 2 tabelas (com xmin). Casos:
 *   0. o modelo é o pré-118 do alvo: objetos da 116 e da 117 presentes, nenhum da 118; exportação sem as 2 tabelas
 *      (ausentes por migration não aplicada) e cota não instalada (o código publicado responde COTA_INDISPONIVEL);
 *   1. conferência só leitura → PRONTA (precheck PASS, contagem de documentos), nada muda;
 *   2. aplicação parcial simulada (uma função da 118 criada à mão) → APLICACAO_PARCIAL_118, nada escrito;
 *   3. papel NÃO superusuário: sem USAGE em public, sem SELECT em empresas, sem SELECT em ia_documentos (cada um isolado),
 *      sem REFERENCES em empresas e em ia_documentos, sem CREATE, sem USAGE em plpgsql e sem USAGE em sql (revogadas de
 *      PUBLIC de verdade, uma de cada vez), cada falta recusada com o nome; com o mínimo, APLICA (preservação, índices e o
 *      1º postcheck na transação — xid lido antes de cada um = xmin do catálogo das tabelas novas; o 2º postcheck depois do
 *      COMMIT, sem xid e em READ ONLY; nenhuma linha das 2 tabelas reescrita);
 *   4. depois: JA_APLICADA (dono e admin); segunda tentativa recusada pelo marcador; SELECT nas tabelas novas revogado →
 *      recusa pelo nome; deriva (índice parcial removido → parcial; função de tempo trocada, gatilho desligado → postcheck
 *      divergente; índice inválido/não pronto/inativo → recusa pelo nome) → restaurada → JA_APLICADA;
 *   5. ROLLBACK VAZIO: o down pelo dono, sem nenhuma linha de cota, volta à impressão anterior;
 *   6. controle positivo da prova de preservação: uma linha de cada tabela escrita na própria transação é contada;
 *   7. falha REAL: outra sessão com ROW EXCLUSIVE em empresas (e depois em ia_documentos) → a FK da 118 espera SHARE ROW
 *      EXCLUSIVE e estoura o lock_timeout → NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica;
 *   8. FLUXOS DE COTA sobre a 118 aplicada pelo aplicador: reserva → consumo (1 leitura contada), reserva → liberação (não
 *      conta), mesmo arquivo de novo = JA_CONTADO; conferência informa as linhas por situação e continua PASS;
 *   9. EXPORTAÇÃO: as 2 tabelas novas saem no pacote da empresa (linhas da empresa, sem a coluna operacao_id) e deixam de
 *      constar como ausentes;
 *  10. ROLLBACK RECUSADO COM HISTÓRICO: o down falha sem efeito (impressão, dados e linhas de cota iguais); conferência PASS.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string;
  contagens?: { documentos: number; novas?: Record<string, number> };
  contagensAntes?: { documentos: number }; contagensDepois?: { documentos: number; novas?: Record<string, number> } };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-118-staging.cjs")) as Aplicador;
const { SQL_PRESERVACAO, PRESERVADAS, corpoSomenteLeitura } = exigir(join(raiz, "scripts/migration-118-comum.cjs")) as {
  SQL_PRESERVACAO: string; PRESERVADAS: string[]; corpoSomenteLeitura(sql: string, nome: string): string };
/** O corpo do postcheck exatamente como o aplicador o envia (dentro da transação da 118 e, depois, em READ ONLY). */
const POSTCHECK = corpoSomenteLeitura(readFileSync(resolve(raiz, "database/checks/20261104_118_postcheck.sql"), "utf8").replace(/\r\n/g, "\n"), "postcheck 118");
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_118";
const DOWN118 = readFileSync(resolve(raiz, "database/rollback/20261104_118_importacao_cotas_down.sql"), "utf8");
const FUNCAO_MES = `CREATE OR REPLACE FUNCTION public.kidmais_118_periodo_mensal(t timestamptz) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT to_char(t AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') $$`;
const OBJETOS_118 = `SELECT (SELECT count(*) FROM unnest(ARRAY['ia_importacao_cotas','ia_importacao_usos','ia_importacao_usos_vivo_uk','ia_importacao_usos_periodo_idx']) x
    WHERE to_regclass('public.' || x) IS NOT NULL)::int + (SELECT count(*) FROM unnest(ARRAY['kidmais_118_janela_migracao(timestamptz,timestamptz)',
    'kidmais_118_periodo_mensal(timestamptz)','kidmais_118_guarda()']) f WHERE to_regprocedure('public.' || f) IS NOT NULL)::int AS n`;

/**
 * `sonda` (parecer r1 do Astra, P2): imediatamente antes de CADA verificação — preservação, índices e cada postcheck —
 * lê na MESMA conexão o xid da transação em curso (null fora de transação ou em transação sem escrita) e
 * transaction_read_only. O teste exige: preservação, índices e o 1º postcheck com o MESMO xid, que é o xmin do catálogo das
 * tabelas criadas (DDL e as 3 verificações numa transação só, ainda aberta); o 2º postcheck depois, sem xid e em READ ONLY.
 */
type Sonda = { etapa: string; x: string | null; ro: string };
function clienteDescartavel(cfg: { papel?: string; sonda?: Sonda[] } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string, p?: unknown[]) {
      if (q === stg.SQL_IDENTIDADE) return { rows: [IDENTIDADE] };
      const etapa = q.startsWith("/* preservacao-118 */") ? "preservacao" : q.startsWith("/* indices-118 */") ? "indices" : q === POSTCHECK ? "postcheck" : null;
      if (cfg.sonda && etapa) {
        const r = (await this.c!.query<{ x: string | null; ro: string }>("SELECT pg_current_xact_id_if_assigned()::text AS x, current_setting('transaction_read_only') AS ro")).rows[0];
        cfg.sonda.push({ etapa, x: r.x, ro: r.ro });
      }
      return this.c!.query(q, p);
    }
    async end() { if (this.c) await this.c.end(); }
  };
}

async function emTx<T>(c: Client, corpo: (db: DbExecutor) => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try { const r = await corpo(executor(c)); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK"); throw e; }
}

test("aplicador 118 real no esquema pré-118 do staging (116 e 117): papel mínimo, preservação, postcheck, deriva, down vazio, falha e retomada, cota, exportação e down recusado com histórico", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-118-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-11-08T22:00Z teste";
  const executar = (dir = novoDir(), papel?: string, sonda?: Sonda[]) =>
    stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel, sonda }) });
  /** A transação da 118: preservação, índices e 1º postcheck com o xid que é o xmin do catálogo das 2 tabelas novas; 2º postcheck fora dela, READ ONLY. */
  const mesmaTransacao = async (sonda: Sonda[], rotulo: string) => {
    assert.deepEqual(sonda.map((p) => p.etapa), ["preservacao", "indices", "postcheck", "postcheck"], rotulo + ": ordem das verificações");
    const [pres, ind, pos1, pos2] = sonda;
    assert.notEqual(pres.x, null, rotulo + ": preservação dentro de uma transação");
    assert.equal(ind.x, pres.x, rotulo + ": índices na MESMA transação da preservação");
    assert.equal(pos1.x, pres.x, rotulo + ": 1º postcheck na MESMA transação (antes do COMMIT)");
    assert.deepEqual([pres.ro, ind.ro, pos1.ro], ["off", "off", "off"], rotulo + ": verificações na transação de escrita");
    assert.equal(pos2.x, null, rotulo + ": 2º postcheck depois do COMMIT, sem xid");
    assert.equal(pos2.ro, "on", rotulo + ": 2º postcheck em READ ONLY");
    const xmin = (await c.query<{ x: string }>(`SELECT string_agg(DISTINCT xmin::text, ',') AS x FROM pg_class WHERE oid IN (to_regclass('public.ia_importacao_cotas'), to_regclass('public.ia_importacao_usos'))`)).rows[0].x;
    assert.equal(xmin, String(BigInt(pres.x!) % 4294967296n), rotulo + ": DDL e verificações na MESMA transação");
  };
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  /** Impressão do schema public: relações, colunas, restrições, índices, gatilhos e funções (com donos). */
  const impressao = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY cl.relname, a.attname)
         FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(indexdef, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, tgenabled, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname, tg.tgrelid::regclass::text) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))) AS h`)).rows[0].h;
  /** As 2 tabelas que a 118 trava, linha a linha com xmin: o retrato que ela não pode mudar. */
  const dados = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|', ${PRESERVADAS.map((tb) =>
      `(SELECT string_agg(md5(x::text) || ':' || x.xmin::text, ',' ORDER BY md5(x::text)) FROM (SELECT tb.*, tb.xmin FROM public.${tb} tb) x)`).join(", ")})) AS h`)).rows[0].h;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão e os dados não mudam. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao(), linhas = await dados();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source); assert.equal(await dados(), linhas);
  };
  const instalada = async () => (await c.query<{ n: number }>(OBJETOS_118)).rows[0].n;
  const ja = async (papel?: string, rotulo = "") => { const r = await conferir(papel); assert.equal(r.resultado, "JA_APLICADA_POSTCHECK_PASS", rotulo + JSON.stringify(r)); return r; };
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  /** Exportação real da empresa (REPEATABLE READ READ ONLY, como servico.ts). */
  const exportar = async (empresa: string) => {
    const { gerarPacote } = await import("../exportacao/pacote.ts");
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const p = await gerarPacote(executor(c), empresa);
      await p.limpar();
      return p.manifesto;
    } finally { await c.query("ROLLBACK"); }
  };
  try {
    // 0. Modelo pré-118 do alvo.
    const presentes = (await c.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_credito_franquias_ciclo') IS NOT NULL AND to_regclass('public.ia_credito_franquia_pendencias') IS NOT NULL
        AND to_regclass('public.whatsapp_atendimento_rodizio') IS NOT NULL AND to_regclass('public.whatsapp_atendimento_status_colisoes') IS NOT NULL
        AND to_regclass('public.whatsapp_atendimento_mensagens_ambiente_provedor_idx') IS NOT NULL AND to_regclass('public.clientes') IS NOT NULL AS ok`)).rows[0].ok;
    assert.equal(presentes, true, "116 e 117 presentes no modelo");
    assert.equal(await instalada(), 0, "modelo sem a 118");
    assert.equal(await cotaInstalada(executor(c)), false, "sem a 118 o código publicado recusa a leitura (COTA_INDISPONIVEL)");

    // Dados reais nas 2 tabelas travadas: empresa ATIVA, 3 documentos com original (sha256 conferido pela 055c).
    const cen = await cenario(c);
    const E = cen.empresa;
    const docs: { doc: string; sha: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const doc = await id(c, `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid) RETURNING id`, [E, cen.usuario]);
      const pdf = Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`);
      const sha = (await c.query<{ sha: string }>(`INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
         VALUES ($1::uuid, $2::uuid, 1, 'contrato.pdf', 'application/pdf', $3, encode(sha256($4), 'hex'), $4, $5::uuid) RETURNING sha256 AS sha`, [doc, E, pdf.length, pdf, cen.usuario])).rows[0].sha;
      docs.push({ doc, sha });
    }
    for (const tb of PRESERVADAS) assert.ok(Number((await c.query(`SELECT count(*)::int AS n FROM public.${tb}`)).rows[0].n) >= 1, "dados em " + tb);
    const linhasIniciais = await dados();
    const exp0 = await exportar(E);
    const ausentes0 = exp0.entidadesAusentes.map((a) => a.tabela);
    for (const tb of ["ia_importacao_cotas", "ia_importacao_usos"]) assert.ok(ausentes0.includes(tb), "ausente sem a 118: " + tb);
    assert.ok(exp0.entidadesAusentes.filter((a) => a.tabela.startsWith("ia_importacao_")).every((a) => /migration não aplicada/.test(a.motivo)));

    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 118": "PASS" }); assert.equal(conf.estado!.objetos, 0);
    assert.ok(conf.contagens!.documentos >= 3, JSON.stringify(conf.contagens)); assert.equal(conf.contagens!.novas, undefined);
    assert.equal(await impressao(), antes); assert.equal(await dados(), linhasIniciais);

    // 2. Aplicação parcial simulada: uma função da 118 já existe (as tabelas não).
    await c.query(FUNCAO_MES);
    try { await recusa(/APLICACAO_PARCIAL_118 tabelas 0\/2, indices 0\/2, funcoes 1\/3$/); }
    finally { await c.query("DROP FUNCTION public.kidmais_118_periodo_mensal(timestamptz)"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Papel não superusuário: cada falta recusa com o nome; com o mínimo, aplica.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    let antesDono = "";
    try {
      const publicTinha = (await c.query<{ ok: boolean }>(`SELECT has_schema_privilege('${MINIMO}', 'public', 'USAGE') AS ok`)).rows[0].ok;
      if (publicTinha) await c.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
      try {
        assert.equal((await c.query<{ ok: boolean }>(`SELECT has_schema_privilege('${MINIMO}', 'public', 'USAGE') AS ok`)).rows[0].ok, false);
        await recusa(/^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/, MINIMO);
      } finally { if (publicTinha) await c.query("GRANT USAGE ON SCHEMA public TO PUBLIC"); }
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await recusa(/^SEM_PRIVILEGIO_LEITURA SELECT_DOCUMENTOS SELECT_EMPRESAS$/, MINIMO);
      await c.query(`GRANT SELECT ON ia_documentos TO ${MINIMO}`);
      await recusa(/^SEM_PRIVILEGIO_LEITURA SELECT_EMPRESAS$/, MINIMO);
      // Parecer r1, P3: a falta de SELECT em ia_documentos também isolada (com SELECT em empresas).
      await c.query(`REVOKE SELECT ON ia_documentos FROM ${MINIMO}`);
      await c.query(`GRANT SELECT ON empresas TO ${MINIMO}`);
      await recusa(/^SEM_PRIVILEGIO_LEITURA SELECT_DOCUMENTOS$/, MINIMO);
      await c.query(`GRANT SELECT ON ia_documentos TO ${MINIMO}`);
      await recusa(/^SEM_PRIVILEGIO_118 REFERENCES_EMPRESAS REFERENCES_DOCUMENTOS$/, MINIMO);
      await c.query(`GRANT REFERENCES ON empresas TO ${MINIMO}`);
      await recusa(/^SEM_PRIVILEGIO_118 REFERENCES_DOCUMENTOS$/, MINIMO);
      await c.query(`GRANT REFERENCES ON ia_documentos TO ${MINIMO}`);
      antesDono = await impressao();
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta)); assert.equal(pronta.estado!.papel_trocado, true);
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`);
      try { await recusa(/^SEM_PRIVILEGIO_118 CREATE$/, MINIMO); } finally { await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`); }
      // Parecer r1, P3: linguagens revogadas DE VERDADE antes da 118 (o mínimo só as tem por PUBLIC), uma de cada vez.
      for (const [lingua, motivo] of [["plpgsql", /^SEM_PRIVILEGIO_118 LINGUAGEM$/], ["sql", /^SEM_PRIVILEGIO_118 LINGUAGEM_SQL$/]] as const) {
        assert.equal((await c.query<{ ok: boolean }>(`SELECT has_language_privilege('${MINIMO}', '${lingua}', 'USAGE') AS ok`)).rows[0].ok, true, lingua + " antes");
        await c.query(`REVOKE USAGE ON LANGUAGE ${lingua} FROM PUBLIC`);
        try {
          assert.equal((await c.query<{ ok: boolean }>(`SELECT has_language_privilege('${MINIMO}', '${lingua}', 'USAGE') AS ok`)).rows[0].ok, false, lingua + " revogada");
          await recusa(motivo, MINIMO);
        } finally { await c.query(`GRANT USAGE ON LANGUAGE ${lingua} TO PUBLIC`); }
      }
      assert.equal(await impressao(), antesDono);
      const dirMin = novoDir();
      const sondaMin: Sonda[] = [];
      const ap = await executar(dirMin, MINIMO, sondaMin);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      await mesmaTransacao(sondaMin, "papel mínimo");
      assert.deepEqual(ap.commits, { 118: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 118", "migration 118", "postcheck 118"]);
      assert.equal(ap.contagensDepois!.documentos, ap.contagensAntes!.documentos);
      assert.deepEqual(ap.contagensDepois!.novas, { cotas: 0, reservadas: 0, consumidas: 0, liberadas: 0 });
      const m = JSON.parse(readFileSync(ap.marcador!, "utf8"));
      assert.deepEqual(m.etapas.find((e: { nome: string }) => e.nome === "migration 118").antesDoCommit, { preservacao: "PASS", indices: "PASS", "postcheck 118": "PASS" });
      assert.equal(await dados(), linhasIniciais, "nenhuma linha das 2 tabelas reescrita (xmin incluído)");
      assert.equal(await instalada(), 7, "os 7 objetos da 118");

      // 4. Depois da aplicação.
      await ja(MINIMO); await ja();
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
      for (const [revogar, restaurar, motivo] of [
        [`REVOKE SELECT ON ia_importacao_cotas FROM ${MINIMO}`, `GRANT SELECT ON ia_importacao_cotas TO ${MINIMO}`, /SEM_PRIVILEGIO_118_PRESENTE SELECT_COTAS$/],
        [`REVOKE SELECT ON ia_importacao_usos FROM ${MINIMO}`, `GRANT SELECT ON ia_importacao_usos TO ${MINIMO}`, /SEM_PRIVILEGIO_118_PRESENTE SELECT_USOS$/],
        ["REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC", "GRANT USAGE ON LANGUAGE plpgsql TO PUBLIC", /SEM_PRIVILEGIO_118_PRESENTE LINGUAGEM$/],
      ] as const) {
        await c.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await c.query(restaurar); }
        await ja(MINIMO, "restaurado: " + motivo.source);
      }
      // Deriva: índice parcial removido (parcial), função de tempo trocada e gatilho desligado (postcheck divergente).
      for (const [derivar, restaurar, motivo] of [
        ["DROP INDEX ia_importacao_usos_periodo_idx", "CREATE INDEX ia_importacao_usos_periodo_idx ON ia_importacao_usos (empresa_id, periodo) WHERE estado IN ('RESERVADA', 'CONSUMIDA')",
          /APLICACAO_PARCIAL_118 indices 1\/2$/],
        [FUNCAO_MES.replace("'YYYY-MM'", "'YYYY-MM' || ''"), FUNCAO_MES, /118 postcheck: funções divergentes/],
        ["ALTER TABLE ia_importacao_usos DISABLE TRIGGER ia_importacao_usos_118_guarda", "ALTER TABLE ia_importacao_usos ENABLE TRIGGER ia_importacao_usos_118_guarda",
          /118 postcheck: definição das tabelas novas divergente/],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar + JSON.stringify(d)); assert.match(d.motivo!, motivo);
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        await ja(undefined, "restaurado: " + derivar);
      }
      // Índice da 118 com a definição esperada mas inválido, não pronto ou inativo (pg_index): recusa pelo nome.
      for (const [indice, flag] of [["ia_importacao_usos_vivo_uk", "indisvalid"], ["ia_importacao_usos_periodo_idx", "indisready"],
        ["ia_importacao_cotas_pkey", "indislive"]] as const) {
        await c.query(`UPDATE pg_index SET ${flag} = false WHERE indexrelid = to_regclass('public.${indice}')`);
        try { await recusa(new RegExp(`^INDICE_INVALIDO_118 ${indice}$`), MINIMO); }
        finally { await c.query(`UPDATE pg_index SET ${flag} = true WHERE indexrelid = to_regclass('public.${indice}')`); }
        await ja(MINIMO, "restaurado: " + indice);
      }

      // 5. Rollback VAZIO (só no descartável), pelo dono: volta à impressão anterior.
      assert.equal(Number((await c.query("SELECT (SELECT count(*) FROM ia_importacao_cotas) + (SELECT count(*) FROM ia_importacao_usos) AS n")).rows[0].n), 0);
      await c.query(`SET ROLE ${MINIMO}`); await c.query(DOWN118); await c.query("RESET ROLE");
      assert.equal(await impressao(), antesDono, "down vazio voltou ao estado do dono");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), 0, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");
    assert.equal(await dados(), linhasIniciais, "down não reescreveu as 2 tabelas");
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "depois do down vazio, pronta de novo");

    // 6. Controle positivo da prova de preservação: cada tabela escrita na própria transação é contada.
    for (const [tb, escrita] of [
      ["empresas", "UPDATE empresas SET nome = nome WHERE id = $1::uuid"],
      ["ia_documentos", "UPDATE ia_documentos SET status = status WHERE empresa_id = $1::uuid"],
    ] as const) {
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL session_replication_role = replica");
        assert.equal((await c.query(SQL_PRESERVACAO)).rows[0][tb], 0, tb + " antes");
        await c.query(escrita, [E]);
        const p = (await c.query(SQL_PRESERVACAO)).rows[0];
        assert.ok(p[tb] >= 1, tb + " escrita contada"); assert.ok(PRESERVADAS.filter((k) => k !== tb).every((k) => p[k] === 0), tb + " só ela");
      } finally { await c.query("ROLLBACK"); }
    }

    // 7. Falha real: outra sessão escreve em empresas e, depois, em ia_documentos; a FK da 118 estoura o lock_timeout de 5 s.
    const dirFalha = novoDir();
    for (const [n, travada] of [[0, "empresas"], [1, "ia_documentos"]] as const) {
      const trava = await conectarDescartavel({ travar: false });
      try {
        await trava.query("BEGIN");
        // ROW EXCLUSIVE deixa passar o catálogo, as contagens e o precheck, mas conflita com o SHARE ROW EXCLUSIVE da FK nova.
        await trava.query(`LOCK TABLE ${travada} IN ROW EXCLUSIVE MODE`);
        const inicio = Date.now();
        const f = await executar(dirFalha);
        assert.ok(Date.now() - inicio >= 4500, "esperou o lock_timeout");
        assert.equal(f.resultado, "FALHA", JSON.stringify(f));
        assert.deepEqual(f.commits, { 118: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 118");
        assert.match(f.falha!.mensagem, /lock timeout/);
        await trava.query("ROLLBACK");
      } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
      assert.equal(await instalada(), 0, "nada criado: " + travada);
      assert.equal(await impressao(), antes);
      await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
      renameSync(join(dirFalha, "migration-118.json"), join(dirFalha, `migration-118.2026-11-08T22-0${n}.json`));
    }
    const sondaRetomada: Sonda[] = [];
    const retomada = await executar(dirFalha, undefined, sondaRetomada);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    await mesmaTransacao(sondaRetomada, "retomada");
    assert.deepEqual(retomada.commits, { 118: "CONFIRMADO" });
    assert.deepEqual(JSON.parse(readFileSync(retomada.marcador!, "utf8")).tentativasAnteriores, ["migration-118.2026-11-08T22-00.json", "migration-118.2026-11-08T22-01.json"]);
    assert.equal(await dados(), linhasIniciais, "retomada também não reescreveu linhas");
    await ja();
    assert.equal(await cotaInstalada(executor(c)), true, "cota instalada pelo aplicador");

    // 8. Fluxos de cota sobre a 118 aplicada pelo aplicador (sem plano confirmado: mede sem recusar, período do mês).
    const reservar = (d: { doc: string; sha: string }) => emTx(c, (db) => reservarCota(db, { empresaId: E, documentoId: d.doc, sha256: d.sha }));
    const posse = (r: Awaited<ReturnType<typeof reservar>>): Posse => { assert.equal(r.tipo, "RESERVADA", JSON.stringify(r)); return (r as { posse: Posse }).posse; };
    const p1 = posse(await reservar(docs[0]));
    await emTx(c, (db) => concluirCota(db, { empresaId: E, posse: p1, comDados: true }));
    const p2 = posse(await reservar(docs[1]));
    assert.equal(await emTx(c, (db) => liberarCota(db, { empresaId: E, posse: p2 })), true);
    assert.equal((await reservar(docs[0])).tipo, "JA_CONTADO", "o mesmo arquivo não conta duas vezes");
    const resumo = await emTx(c, (db) => resumoCota(db, E));
    assert.equal(resumo.plano, null); assert.equal(resumo.franquia.usados, 1, JSON.stringify(resumo)); assert.equal(resumo.franquia.limite, null);
    assert.match(resumo.franquia.periodo, /^\d{4}-\d{2}$/);
    const comLinhas = await ja();
    assert.deepEqual(comLinhas.contagens!.novas, { cotas: 1, reservadas: 0, consumidas: 1, liberadas: 1 }, "linhas de cota não recusam a conferência");
    assert.equal(await dados(), linhasIniciais, "a cota não escreve em empresas nem em ia_documentos");

    // 9. Exportação: as 2 tabelas novas saem com as linhas da empresa, sem o token de posse.
    const exp1 = await exportar(E);
    assert.ok(!exp1.entidadesAusentes.some((a) => a.tabela.startsWith("ia_importacao_")), JSON.stringify(exp1.entidadesAusentes));
    const arquivo = (tb: string) => { const a = exp1.arquivos.find((x) => x.tabela === tb); assert.ok(a, "exportada: " + tb); return a!; };
    assert.equal(arquivo("ia_importacao_cotas").linhas, 1); assert.equal(arquivo("ia_importacao_usos").linhas, 2);
    assert.ok(!arquivo("ia_importacao_usos").colunas!.includes("operacao_id"), "token de posse fora do pacote");
    assert.ok(arquivo("ia_importacao_usos").colunasExcluidas!.some((x) => x.coluna === "operacao_id"));
    assert.ok(arquivo("ia_importacao_usos").colunas!.includes("estado") && arquivo("ia_importacao_cotas").colunas!.includes("migracao_inicio"));

    // 10. Rollback recusado com histórico: sem efeito.
    const antesDown = await impressao();
    const usos = async () => (await c.query<{ h: string }>(`SELECT md5(string_agg(md5(u::text), ',' ORDER BY u.id)) AS h FROM ia_importacao_usos u`)).rows[0].h;
    const usosAntes = await usos();
    await assert.rejects(c.query(DOWN118), /118: rollback recusado; já existe histórico de cota de importação\./);
    await c.query("ROLLBACK").catch(() => undefined);
    assert.equal(await impressao(), antesDown, "down recusado não mudou o schema"); assert.equal(await usos(), usosAntes, "nem as leituras contadas");
    assert.equal(await dados(), linhasIniciais);
    assert.equal(await instalada(), 7);
    await ja(undefined, "depois do down recusado");
    assert.deepEqual(readdirSync(dirFalha).sort(), ["migration-118.2026-11-08T22-00.json", "migration-118.2026-11-08T22-01.json", "migration-118.json"]);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
