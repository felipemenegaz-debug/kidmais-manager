import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";

/**
 * 29/10/2026 — APLICADOR REAL da 105 de PRODUÇÃO (scripts/migration-105-production.cjs; plano MCP produção, P1) no
 * PostgreSQL descartável, no modelo b14-P11 (produção depois da promoção geral: até a 100, sem 098, sem 102–105) e no 103.
 * Únicas substituições: o cliente conecta ao cluster descartável e, na resposta de identidade, só banco/TLS/rede são
 * trocados pelos de produção. O PAPEL é REAL: sessão de um papel NÃO superusuário (`SET SESSION AUTHORIZATION`) que faz
 * `SET ROLE` para o papel dono de empresas e usuarios_administrativos, como o Render. Casos:
 *   1. superusuário recusado; papel que não é o dono recusado; conferência só leitura → PRONTA, nada muda;
 *   2. APLICAR → APLICADA_POSTCHECK_PASS: prova a FORMA REAL do deparse das 137 definições (em divergência, o arquivo
 *      com as definições lidas fica em KIDMAIS_PG_EVIDENCIAS ou no tmp, e o caminho vai na mensagem);
 *   3. CONFERIR → JA_APLICADA_INTEGRIDADE_PASS; tabelas com o dono da aplicação;
 *   4. mutantes REAIS que preservam nomes e contagens (predicado invertido, CHECK afrouxado, FK ON DELETE CASCADE, corpo
 *      da função trocado, RLS, RULE) → DIVERGENTE; restaurados → JA_APLICADA;
 *   4b. gatilhos das FKs (revisão do Astra, rodada 1, P2-1): O→R em mcp_oauth_tokens e desabilitado em empresas (lado
 *      referenciado) → DIVERGENTE com a integridade antiga PASS; restaurados → JA_APLICADA;
 *   4c. RELAÇÕES (09/11): NOT NULL NOT VALID, FK de entrada de fora da 105, proconfig, FK adiável, herança, RLS forçada,
 *      política e gatilho extra → DIVERGENTE com a integridade antiga PASS (as duas primeiras com definições PASS);
 *      r2 (Astra r1, P2-1): FK externa com LF no nome → DIVERGENTE, sem o texto do nome no CONFERIR, no APLICAR e no marcador;
 *   4d. CHAVES DESCONHECIDAS (10/11): índice e gatilho com LF no nome dão <tipo>:<tabela>:DESCONHECIDA, sem o nome.
 *   4e. ERROS DO SERVIDOR (10/11, P2-3): RLS forçada com política que falha (P0001, marcador no texto) → DIVERGENTE sem executar
 *      as contagens; erro real 22P02 com o marcador nas contagens → FALHA_DE_CONFERENCIA/CONTAGENS/ERRO_SERVIDOR 22P02, sem o texto.
 *   5. marcador impede a repetição; com a 105 completa o APLICAR não escreve; down → impressão inicial;
 *   6. falha real (lock_timeout na FK dentro da transação única) → NAO_COMMITADA, nada criado; retomada pelo marcador renomeado;
 *   7. public.gen_random_uuid() (rodada 1, P2-2). Os modelos (o schema real da aplicação) já têm o pgcrypto em public:
 *      a conferência diz PGCRYPTO e a aplicação dos passos 2–6 usou o DEFAULT qualificado com o pgcrypto genuíno. Aqui, um
 *      homônimo: a função é solta da extensão e passa a devolver UUID constante → conferência recusa
 *      (UUID_PUBLICO_HOMONIMO) e aplicação desfaz antes do COMMIT; a definição original é restaurada.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; commit?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  checks?: { integridade?: string; definicoes?: string; divergencias?: { chave: string; tipo: string }[] } & Record<string, unknown> };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const prod = exigir(join(raiz, "scripts/migration-105-production.cjs")) as Aplicador;
const defs = exigir(join(raiz, "scripts/migration-105-definicoes.cjs")) as { ESPERADO: Record<string, string | string[]>; SET_DEPARSE: string[] };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV = { RENDER: "true", RENDER_SERVICE_ID: "srv-dak77m2d0e5s73b8rkkg", KIDMAIS_DEPLOY_ENV: "production", DATABASE_SSL: "true",
  DATABASE_SSL_REJECT_UNAUTHORIZED: "false", DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production" };
const REDE = { db: "kidmais_production", tls: true, tls_versao: "TLSv1.3", servidor_privado: true };
const DONO = "kidmais_teste_dono_105p", CRED = "kidmais_teste_cred_105p", ALHEIO = "kidmais_teste_alheio_105p";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const M105 = "database/migrations/20261027_105_mcp_assinaturas.sql";
const DOWN105 = "database/rollback/20261027_105_mcp_assinaturas_down.sql";
const DEF105 = "database/checks/20261029_105_definicoes.sql";
const agoraPitr = () => `PITR ${new Date().toISOString().slice(0, 16)}Z ensaio descartavel`;

/** Cliente do aplicador: papel real (sessão → SET ROLE), identidade de rede de produção. `papel` null = conexão do admin. */
function cliente(papel: string | null = DONO, sessao: string = CRED) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (papel) { await this.c.query(`SET SESSION AUTHORIZATION ${sessao}`); await this.c.query(`SET ROLE ${papel}`); }
    }
    async query(q: string) {
      if (q !== prod.SQL_IDENTIDADE) return this.c!.query(q);
      const r = await this.c!.query(q);
      return { rows: [{ ...r.rows[0], ...REDE }] };
    }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 105 de PRODUÇÃO real: papel com SET ROLE, deparse das definições, mutantes reais, transação única, marcador e falha", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-105-prod-")); dirs.push(d); return d; };
  const executar = (dir = novoDir(), papel: string | null = DONO) => prod.executar({ env: ENV, backup: agoraPitr(), dir, raiz, disco: () => {}, Client: cliente(papel) });
  const conferir = (papel: string | null = DONO, sessao = CRED) => prod.conferir({ env: ENV, raiz, Client: cliente(papel, sessao) });
  const impressao = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))) AS h`)).rows[0].h;
  const instalada = async () => (await c.query<{ ok: boolean }>("SELECT to_regclass('public.mcp_oauth_concessoes') IS NOT NULL AS ok")).rows[0].ok;
  /** Evidência do deparse real: as definições lidas que divergem do esperado (só catálogo; nenhum dado). */
  const evidencia = async (r: Resultado) => {
    await c.query("BEGIN READ ONLY"); for (const s of defs.SET_DEPARSE) await c.query(s);
    const lidas = (await c.query<{ chave: string; definicao: string }>(sql(DEF105))).rows; await c.query("ROLLBACK");
    const divergentes = lidas.filter(l => ![defs.ESPERADO[l.chave]].flat().includes(l.definicao));
    const arquivo = join(process.env.KIDMAIS_PG_EVIDENCIAS ?? tmpdir(), `definicoes-105-reais-${Date.now()}.json`);
    writeFileSync(arquivo, JSON.stringify({ versao: (await c.query("SHOW server_version")).rows[0], resultado: r, divergentes, lidas }, null, 1));
    return arquivo;
  };
  const admin = (await c.query<{ u: string; s: boolean }>("SELECT current_user AS u, rolsuper AS s FROM pg_roles WHERE rolname = current_user")).rows[0];
  const donos = (await c.query<{ e: string; u: string }>(`SELECT pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.empresas'::regclass)) AS e,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.usuarios_administrativos'::regclass)) AS u`)).rows[0];
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  try {
    assert.equal(await instalada(), false, "modelo sem a 105");
    const antes = await impressao();
    for (const r of [DONO, CRED, ALHEIO]) await c.query(`DROP ROLE IF EXISTS ${r}`);
    await c.query(`CREATE ROLE ${DONO} NOLOGIN NOSUPERUSER`);
    await c.query(`CREATE ROLE ${CRED} NOLOGIN NOSUPERUSER IN ROLE ${DONO}`);
    await c.query(`CREATE ROLE ${ALHEIO} NOLOGIN NOSUPERUSER`);
    await c.query(`GRANT ${ALHEIO} TO ${CRED}`);
    await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${DONO}, ${ALHEIO}`);
    await c.query(`ALTER TABLE public.empresas OWNER TO ${DONO}`);
    await c.query(`ALTER TABLE public.usuarios_administrativos OWNER TO ${DONO}`);
    await c.query(`GRANT REFERENCES ON public.empresas, public.usuarios_administrativos TO ${ALHEIO}`);
    try {
      // 1. Recusas de papel e conferência só leitura (impressão tirada depois da troca de dono do cenário).
      const comPapeis = await impressao();
      const sup = await conferir(null);
      assert.equal(sup.resultado, "FALHA_DE_CONFERENCIA", JSON.stringify(sup));
      assert.match(sup.motivo!, admin.s ? /SUPERUSUARIO_RECUSADO/ : /PAPEL_NAO_E_DONO_DA_APLICACAO/);
      const alheio = await conferir(ALHEIO);
      assert.equal(alheio.resultado, "FALHA_DE_CONFERENCIA"); assert.match(alheio.motivo!, /PAPEL_NAO_E_DONO_DA_APLICACAO/);
      const pronta = await conferir();
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
      const pgcryptoPublico = (await c.query(`SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pgcrypto' AND n.nspname = 'public'`)).rowCount === 1;
      assert.equal((pronta.checks as Record<string, unknown>)["uuid publico"], pgcryptoPublico ? "PGCRYPTO" : "AUSENTE");
      assert.equal(await impressao(), comPapeis, "conferência não muda nada");

      // 2. Aplicação real: transação única com definições ANTES do COMMIT (prova a forma do deparse).
      const dir = novoDir();
      const ap = await executar(dir);
      if (ap.resultado !== "APLICADA_POSTCHECK_PASS") assert.fail(`APLICAR ${JSON.stringify(ap)} evidência: ${await evidencia(ap)}`);
      assert.equal(ap.commit, "CONFIRMADO");

      // 3. Conferência e dono.
      const ja = await conferir();
      if (ja.resultado !== "JA_APLICADA_INTEGRIDADE_PASS") assert.fail(`CONFERIR ${JSON.stringify(ja)} evidência: ${await evidencia(ja)}`);
      assert.equal(ja.checks!.definicoes, "PASS");
      const donosMcp = (await c.query<{ d: string }>(`SELECT DISTINCT pg_get_userbyid(relowner) AS d FROM pg_class
        WHERE oid IN ('public.mcp_oauth_clientes'::regclass, 'public.mcp_oauth_concessoes'::regclass, 'public.mcp_auditoria'::regclass)`)).rows;
      assert.deepEqual(donosMcp, [{ d: DONO }]);

      // 4. Mutantes reais que preservam nomes e contagens; cada um isolado e restaurado.
      const corpo = /AS \$f\$([\s\S]*?)\$f\$;/.exec(sql(M105))![1];
      const fn = (b: string) => `CREATE OR REPLACE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$${b}$f$`;
      const uk = (p: string) => `DROP INDEX public.mcp_oauth_concessoes_ativa_uk; CREATE UNIQUE INDEX mcp_oauth_concessoes_ativa_uk ON public.mcp_oauth_concessoes (usuario_id, empresa_id, client_id) WHERE ${p}`;
      const ck = (i: string) => `ALTER TABLE public.mcp_oauth_tokens DROP CONSTRAINT mcp_oauth_tokens_check1, ADD CONSTRAINT mcp_oauth_tokens_check1 CHECK (tipo <> 'ACESSO' OR expira_em <= criado_em + interval '${i}')`;
      const fk = (s: string) => `ALTER TABLE public.mcp_oauth_tokens DROP CONSTRAINT mcp_oauth_tokens_concessao_id_fkey, ADD CONSTRAINT mcp_oauth_tokens_concessao_id_fkey FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes (id)${s}`;
      for (const [nome, derivar, restaurar, antigaPassa] of [
        ["predicado invertido", uk("revogada_em IS NOT NULL"), uk("revogada_em IS NULL"), true],
        ["CHECK afrouxado", ck("31 days"), ck("2 hours"), true],
        ["FK ON DELETE CASCADE", fk(" ON DELETE CASCADE"), fk(""), true],
        ["corpo da função trocado", fn("BEGIN RETURN NEW; END"), fn(corpo), false],
        ["RLS ligada", "ALTER TABLE public.mcp_auditoria ENABLE ROW LEVEL SECURITY", "ALTER TABLE public.mcp_auditoria DISABLE ROW LEVEL SECURITY", true],
        ["RULE criada", "CREATE RULE mcp_regra_teste AS ON DELETE TO public.mcp_auditoria DO INSTEAD NOTHING", "DROP RULE mcp_regra_teste ON public.mcp_auditoria", true],
      ] as const) {
        await c.query(`SET ROLE ${DONO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "DIVERGENTE", nome + JSON.stringify(d));
          assert.equal(d.checks!.integridade, antigaPassa ? "PASS" : "FALHOU", nome + ": integridade antiga");
          assert.equal(d.checks!.definicoes, "FALHOU", nome);
          const e = await executar(novoDir());
          assert.equal(e.resultado, "FALHA", nome); assert.match(e.falha!.mensagem, /JA_APLICADA_SEM_INTEGRIDADE_105 DIVERGENTE/);
        } finally { await c.query(`SET ROLE ${DONO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: " + nome);
      }

      // 4b. Gatilhos das FKs (rodada 1, P2-1). São gatilhos de sistema: só o superusuário do descartável os altera.
      const gatilho = async (tabela: string, fk: string, funcao: string) => (await c.query<{ n: string }>(
        `SELECT g.tgname AS n FROM pg_trigger g JOIN pg_constraint k ON k.oid = g.tgconstraint JOIN pg_proc f ON f.oid = g.tgfoid
          WHERE k.conname = $1 AND g.tgrelid = $2::regclass AND f.proname = $3`, [fk, tabela, funcao])).rows[0].n;
      for (const [nome, tabela, fk, funcao, derivar, restaurar] of [
        ["gatilho de FK em modo R (O→R)", "public.mcp_oauth_tokens", "mcp_oauth_tokens_concessao_id_fkey", "RI_FKey_check_ins", "ENABLE REPLICA TRIGGER", "ENABLE TRIGGER"],
        ["gatilho de FK desabilitado em empresas (lado referenciado)", "public.empresas", "mcp_oauth_concessoes_empresa_id_fkey", "RI_FKey_noaction_del", "DISABLE TRIGGER", "ENABLE TRIGGER"],
      ] as const) {
        const n = q(await gatilho(tabela, fk, funcao));
        await c.query(`ALTER TABLE ${tabela} ${derivar} ${n}`);
        try {
          const d = await conferir();
          assert.equal(d.resultado, "DIVERGENTE", nome + JSON.stringify(d)); assert.equal(d.checks!.integridade, "PASS", nome + ": a integridade antiga não pega");
          assert.ok(d.checks!.divergencias!.some(x => x.chave === `gatilhos_fk:${fk.startsWith("mcp_oauth_tokens") ? "mcp_oauth_tokens" : "mcp_oauth_concessoes"}.${fk}`), nome);
        } finally { await c.query(`ALTER TABLE ${tabela} ${restaurar} ${n}`); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: " + nome);
      }

      // 4c. RELAÇÕES pela definição (09/11): derivas reais que a integridade antiga não pega e, nas duas primeiras, nem o
      // definicoes.sql (attnotnull fica true com NOT NULL NOT VALID; FK vinda de fora da 105). A relação pega todas.
      const relacoes: Record<string, unknown> = {};
      for (const [nome, derivar, restaurar, definicoesEsperada] of [
        ["NOT NULL NOT VALID (PG 18)",
          "ALTER TABLE public.mcp_oauth_codigos ALTER COLUMN concessao_id DROP NOT NULL; ALTER TABLE public.mcp_oauth_codigos ADD CONSTRAINT mcp_oauth_codigos_concessao_id_not_null NOT NULL concessao_id NOT VALID",
          "ALTER TABLE public.mcp_oauth_codigos VALIDATE CONSTRAINT mcp_oauth_codigos_concessao_id_not_null", "PASS"],
        ["FK de entrada vinda de fora da 105",
          "CREATE TABLE public.mcp_teste_externa (token_id uuid REFERENCES public.mcp_oauth_tokens (id))", "DROP TABLE public.mcp_teste_externa", "PASS"],
        // Astra r1, P2-1: nome de FK externa com LF (identificador entre aspas) gera uma "linha" que começa com texto do banco.
        ["LF no nome de FK de entrada externa",
          "CREATE TABLE public.mcp_teste_externa (token_id uuid, CONSTRAINT \"nome_fk\nMARCADOR_PRIVADO_SINTETICO restante\" FOREIGN KEY (token_id) REFERENCES public.mcp_oauth_tokens (id))",
          "DROP TABLE public.mcp_teste_externa", "PASS"],
        ["proconfig da função (search_path)",
          "ALTER FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() SET search_path = public", "ALTER FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() RESET search_path", "FALHOU"],
        ["FK adiável", "ALTER TABLE public.mcp_oauth_codigos ALTER CONSTRAINT mcp_oauth_codigos_concessao_id_fkey DEFERRABLE INITIALLY DEFERRED",
          "ALTER TABLE public.mcp_oauth_codigos ALTER CONSTRAINT mcp_oauth_codigos_concessao_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE", "FALHOU"],
        ["herança", "CREATE TABLE public.mcp_teste_filha () INHERITS (public.mcp_auditoria)", "DROP TABLE public.mcp_teste_filha", "FALHOU"],
        ["RLS forçada", "ALTER TABLE public.mcp_oauth_pedidos FORCE ROW LEVEL SECURITY", "ALTER TABLE public.mcp_oauth_pedidos NO FORCE ROW LEVEL SECURITY", "FALHOU"],
        ["política criada", "CREATE POLICY mcp_politica_teste ON public.mcp_oauth_clientes USING (true)", "DROP POLICY mcp_politica_teste ON public.mcp_oauth_clientes", "FALHOU"],
        ["gatilho de usuário extra",
          "CREATE TRIGGER mcp_gatilho_teste BEFORE UPDATE ON public.mcp_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel()",
          "DROP TRIGGER mcp_gatilho_teste ON public.mcp_oauth_tokens", "FALHOU"],
      ] as const) {
        await c.query(`SET ROLE ${DONO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          relacoes[nome] = { integridade: d.checks?.integridade, definicoes: d.checks?.definicoes, relacoes: d.checks?.relacoes, divergencias: d.checks?.divergenciasRelacoes };
          assert.equal(d.resultado, "DIVERGENTE", nome + JSON.stringify(d));
          assert.equal(d.checks!.integridade, "PASS", nome + ": a integridade antiga não pega");
          assert.equal(d.checks!.relacoes, "FALHOU", nome);
          assert.equal(d.checks!.definicoes, definicoesEsperada, nome + ": definicoes.sql");
          assert.doesNotMatch(JSON.stringify(d.checks!.divergenciasRelacoes), /mcp_teste_externa|mcp_teste_filha|mcp_politica_teste|mcp_gatilho_teste|search_path/, nome + ": relações sem texto do banco");
          assert.doesNotMatch(JSON.stringify(d), /MARCADOR_PRIVADO|restante/, nome + ": saída do CONFERIR sem texto do nome");
          const dirE = novoDir();
          const e = await executar(dirE);
          assert.equal(e.resultado, "FALHA", nome); assert.match(e.falha!.mensagem, /JA_APLICADA_SEM_INTEGRIDADE_105 DIVERGENTE/);
          assert.doesNotMatch(JSON.stringify(e), /MARCADOR_PRIVADO/, nome + ": resultado do APLICAR sem texto do nome");
          for (const f of readdirSync(dirE, { withFileTypes: true }).filter((x) => x.isFile())) {
            assert.doesNotMatch(readFileSync(join(dirE, f.name), "utf8"), /MARCADOR_PRIVADO/, nome + ": " + f.name);
          }
        } finally { await c.query(`SET ROLE ${DONO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: " + nome);
      }
      t.diagnostic("relacoes 4c " + JSON.stringify(relacoes));

      // 4d. CHAVES DESCONHECIDAS no definicoes.sql (10/11, Astra r2, P2-2): índice e gatilho extras numa tabela da 105, com
      // LF e o marcador no nome. A divergência sai só como <tipo>:<tabela da 105>:DESCONHECIDA; nenhum nome lido aparece.
      const desconhecidas: Record<string, unknown> = {};
      for (const [nome, derivar, restaurar, rotulo] of [
        ["índice com LF no nome",
          "CREATE INDEX \"idx\nMARCADOR_PRIVADO_SINTETICO restante\" ON public.mcp_oauth_codigos (concessao_id)",
          "DROP INDEX public.\"idx\nMARCADOR_PRIVADO_SINTETICO restante\"", "indice:mcp_oauth_codigos:DESCONHECIDA"],
        ["gatilho com LF no nome",
          "CREATE TRIGGER \"g\nMARCADOR_PRIVADO_SINTETICO restante\" BEFORE UPDATE ON public.mcp_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel()",
          "DROP TRIGGER \"g\nMARCADOR_PRIVADO_SINTETICO restante\" ON public.mcp_oauth_tokens", "gatilho:mcp_oauth_tokens:DESCONHECIDA"],
      ] as const) {
        await c.query(`SET ROLE ${DONO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          desconhecidas[nome] = { definicoes: d.checks?.definicoes, divergencias: d.checks?.divergencias };
          assert.equal(d.resultado, "DIVERGENTE", nome + JSON.stringify(d));
          assert.equal(d.checks!.definicoes, "FALHOU", nome);
          assert.ok(d.checks!.divergencias!.some(x => x.chave === rotulo && x.tipo === "SOBRA"), nome + JSON.stringify(d.checks!.divergencias));
          assert.doesNotMatch(JSON.stringify(d), /MARCADOR_PRIVADO|restante/, nome + ": saída do CONFERIR sem texto do nome");
          const dirE = novoDir();
          const e = await executar(dirE);
          assert.equal(e.resultado, "FALHA", nome); assert.match(e.falha!.mensagem, /JA_APLICADA_SEM_INTEGRIDADE_105 DIVERGENTE/);
          assert.doesNotMatch(JSON.stringify(e), /MARCADOR_PRIVADO|restante/, nome + ": resultado do APLICAR sem texto do nome");
          for (const f of readdirSync(dirE, { withFileTypes: true }).filter((x) => x.isFile())) {
            assert.doesNotMatch(readFileSync(join(dirE, f.name), "utf8"), /MARCADOR_PRIVADO|restante/, nome + ": " + f.name);
          }
        } finally { await c.query(`SET ROLE ${DONO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: " + nome);
      }
      t.diagnostic("desconhecidas 4d " + JSON.stringify(desconhecidas));

      // 4e. ERROS DO SERVIDOR COM TEXTO DO CATÁLOGO (10/11, Astra r3, P2-3). (a) RLS forçada em mcp_oauth_clientes com
      // política cuja expressão falha com o marcador no texto: um count direto prova que o erro REAL do PG traz o marcador
      // na mensagem; o aplicador vê a deriva nas relações, NÃO executa as contagens e sai DIVERGENTE sem o texto.
      // (b) erro REAL do PG (22P02 com o marcador) na fase de contagens com a integridade PASS: FALHA_DE_CONFERENCIA com
      // fase CONTAGENS e só o SQLSTATE, no CONFERIR, no APLICAR e no marcador.
      const errosServidor: Record<string, unknown> = {};
      const semMarcador = (v: unknown, dir: string | null, nome: string) => {
        assert.doesNotMatch(JSON.stringify(v), /MARCADOR_PRIVADO|restante/, nome + ": saída sem o texto do erro");
        if (dir) for (const f of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile())) {
          assert.doesNotMatch(readFileSync(join(dir, f.name), "utf8"), /MARCADOR_PRIVADO|restante/, nome + ": " + f.name);
        }
      };
      try {
        // Uma linha sintética: a política é qual por linha, então só falha com a tabela não vazia.
        await c.query("INSERT INTO public.mcp_oauth_clientes (client_id, nome, redirect_uris, valido_ate) VALUES ('https://teste-4e.invalid/c', 'teste 4e', ARRAY['https://teste-4e.invalid/cb'], now() + interval '1 day')");
        await c.query(`SET ROLE ${DONO}`);
        await c.query("ALTER TABLE public.mcp_oauth_clientes ENABLE ROW LEVEL SECURITY");
        await c.query("ALTER TABLE public.mcp_oauth_clientes FORCE ROW LEVEL SECURITY");
        // Função STABLE que lança: um cast constante seria avaliado já no CREATE POLICY.
        await c.query("CREATE FUNCTION public.mcp_teste_falha() RETURNS boolean LANGUAGE plpgsql STABLE AS 'BEGIN RAISE EXCEPTION ''MARCADOR_PRIVADO_SINTETICO restante''; END'");
        await c.query("CREATE POLICY mcp_teste_falha ON public.mcp_oauth_clientes USING (public.mcp_teste_falha())");
        await c.query("RESET ROLE");
        const bruto = await c.query(`SET ROLE ${DONO}`).then(() => c.query("SELECT count(*) FROM public.mcp_oauth_clientes")).then(
          () => null, (e: { code?: string; message?: string }) => e);
        await c.query("RESET ROLE");
        assert.ok(bruto, "a política falha de verdade no count");
        assert.equal(bruto!.code, "P0001"); assert.match(String(bruto!.message), /MARCADOR_PRIVADO_SINTETICO/, "o erro real traz o texto do catálogo");
        const d = await conferir();
        errosServidor["RLS forçada + política que falha"] = { resultado: d.resultado, relacoes: d.checks?.relacoes, contagens: (d as Record<string, unknown>).contagens ?? null };
        assert.equal(d.resultado, "DIVERGENTE", JSON.stringify(d)); assert.equal(d.checks!.relacoes, "FALHOU");
        assert.equal((d as Record<string, unknown>).contagens, undefined, "contagens não executadas com a integridade divergente");
        semMarcador(d, null, "4e(a) CONFERIR");
        const dirE = novoDir();
        const e = await executar(dirE);
        assert.equal(e.resultado, "FALHA"); assert.equal(e.falha!.mensagem, "JA_APLICADA_SEM_INTEGRIDADE_105 DIVERGENTE");
        semMarcador(e, dirE, "4e(a) APLICAR");
      } finally {
        await c.query(`SET ROLE ${DONO}`);
        await c.query("DROP POLICY IF EXISTS mcp_teste_falha ON public.mcp_oauth_clientes");
        await c.query("DROP FUNCTION IF EXISTS public.mcp_teste_falha()");
        await c.query("ALTER TABLE public.mcp_oauth_clientes NO FORCE ROW LEVEL SECURITY");
        await c.query("ALTER TABLE public.mcp_oauth_clientes DISABLE ROW LEVEL SECURITY");
        await c.query("RESET ROLE");
        await c.query("DELETE FROM public.mcp_oauth_clientes WHERE client_id = 'https://teste-4e.invalid/c'");
      }
      assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: 4e(a)");
      {
        const Base = cliente(DONO);
        // Só a consulta de contagens é trocada por uma que o PG recusa com o marcador na mensagem (erro real, 22P02).
        const ComErroReal = class extends Base {
          async query(q: string) {
            if (q.includes("AS concessoes_ativas")) return this.c!.query("SELECT ('MARCADOR_PRIVADO_SINTETICO restante')::int AS x");
            return super.query(q);
          }
        };
        const d = await prod.conferir({ env: ENV, raiz, Client: ComErroReal }) as Resultado & { fase?: string };
        errosServidor["erro real nas contagens"] = { resultado: d.resultado, fase: d.fase, motivo: d.motivo };
        assert.equal(d.resultado, "FALHA_DE_CONFERENCIA"); assert.equal(d.fase, "CONTAGENS"); assert.equal(d.motivo, "ERRO_SERVIDOR 22P02");
        semMarcador(d, null, "4e(b) CONFERIR");
        const dirE = novoDir();
        const e = await prod.executar({ env: ENV, backup: agoraPitr(), dir: dirE, raiz, disco: () => {}, Client: ComErroReal });
        assert.equal(e.resultado, "FALHA"); assert.equal(e.falha!.mensagem, "JA_APLICADA_SEM_INTEGRIDADE_105 FALHA_DE_CONFERENCIA");
        const m = JSON.parse(readFileSync(join(dirE, "migration-105.json"), "utf8"));
        assert.deepEqual([m.conferencia.fase, m.conferencia.motivo], ["CONTAGENS", "ERRO_SERVIDOR 22P02"]);
        semMarcador(e, dirE, "4e(b) APLICAR");
      }
      t.diagnostic("erros do servidor 4e " + JSON.stringify(errosServidor));

      // 5. Marcador e reaplicação sem DDL; down.
      await assert.rejects(executar(dir), /TENTATIVA_ANTERIOR_REVISAR/);
      const sem = await executar(novoDir());
      assert.equal(sem.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(sem));
      await c.query(`SET ROLE ${DONO}`); await c.query(sql(DOWN105)); await c.query("RESET ROLE");
      assert.equal(await instalada(), false);

      // 6. Falha real dentro da transação única: outra sessão segura empresas; a FK da 105 estoura o lock_timeout.
      const trava = await conectarDescartavel({ travar: false });
      const dirFalha = novoDir();
      try {
        await trava.query("BEGIN");
        await trava.query("LOCK TABLE public.empresas IN ROW EXCLUSIVE MODE");
        const f = await executar(dirFalha);
        assert.equal(f.resultado, "FALHA", JSON.stringify(f)); assert.equal(f.commit, "NAO_COMMITADA");
        await trava.query("ROLLBACK");
      } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
      assert.equal(await instalada(), false, "nada criado");
      await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
      renameSync(join(dirFalha, "migration-105.json"), join(dirFalha, "migration-105.ensaio.json"));
      const retomada = await executar(dirFalha);
      assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
      await c.query(`SET ROLE ${DONO}`); await c.query(sql(DOWN105)); await c.query("RESET ROLE");

      // 7. public.gen_random_uuid() (rodada 1, P2-2): homônimo fora da extensão, com UUID constante.
      if (pgcryptoPublico) {
        const original = (await c.query<{ d: string }>("SELECT pg_get_functiondef('public.gen_random_uuid()'::regprocedure) AS d")).rows[0].d;
        await c.query("ALTER EXTENSION pgcrypto DROP FUNCTION public.gen_random_uuid()");
        await c.query("CREATE OR REPLACE FUNCTION public.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $f$SELECT '00000000-0000-0000-0000-000000000000'::uuid$f$");
        try {
          const h = await conferir();
          assert.equal(h.resultado, "FALHA_DE_CONFERENCIA", JSON.stringify(h)); assert.match(h.motivo!, /UUID_PUBLICO_HOMONIMO/);
          const antesH = await impressao();
          const e = await executar();
          assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.equal(e.commit, "NAO_COMMITADA"); assert.match(e.falha!.mensagem, /INTEGRIDADE_105_ANTES_DO_COMMIT/);
          assert.equal(await instalada(), false); assert.equal(await impressao(), antesH, "homônimo: nada criado");
        } finally {
          await c.query(original);
          await c.query("ALTER EXTENSION pgcrypto ADD FUNCTION public.gen_random_uuid()");
        }
        const volta = await conferir();
        assert.equal(volta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(volta)); assert.equal((volta.checks as Record<string, unknown>)["uuid publico"], "PGCRYPTO");
      } else t.diagnostic("modelo sem pgcrypto em public: homônimo não ensaiado neste modelo");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`ALTER TABLE public.empresas OWNER TO ${q(donos.e)}`);
      await c.query(`ALTER TABLE public.usuarios_administrativos OWNER TO ${q(donos.u)}`);
      for (const r of [ALHEIO, CRED, DONO]) { await c.query(`REASSIGN OWNED BY ${r} TO ${q(admin.u)}`); await c.query(`DROP OWNED BY ${r}`); await c.query(`DROP ROLE ${r}`); }
    }
    assert.equal(await instalada(), false);
    assert.equal(await impressao(), antes, "impressão inicial ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
