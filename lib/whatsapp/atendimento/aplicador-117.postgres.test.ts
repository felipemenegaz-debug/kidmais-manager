import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";

/**
 * 04/11/2026 — APLICADOR REAL da 117 (scripts/migration-117-staging.cjs) no PostgreSQL descartável, no modelo 112 (staging
 * de hoje sem a 117), com dados reais nas 2 tabelas que a 117 trava: empresa ATIVA e mensagens do atendimento (uma saída
 * PENDENTE e duas SUBMETIDAS com o MESMO identificador do provedor — o caso que o precheck só informa). Única substituição:
 * o cliente do aplicador conecta ao cluster descartável e responde à consulta de identidade como o banco de staging. Toda
 * recusa compara a IMPRESSÃO do schema public (antes = depois) e o retrato das 2 tabelas (com xmin). Casos:
 *   1. conferência só leitura → PRONTA (precheck PASS, contagem de mensagens por ambiente e direção), nada muda;
 *   2. aplicação parcial simulada (o índice de busca da 117 criado à mão) → APLICACAO_PARCIAL_117, nada escrito;
 *   3. papel NÃO superusuário: sem SELECT em empresas, sem ser dono das mensagens, sem REFERENCES e sem CREATE, cada falta
 *      recusada com o nome; com o mínimo (dono de whatsapp_atendimento_mensagens + REFERENCES e SELECT em empresas), APLICA
 *      (preservação e postcheck na transação; nenhuma linha das 2 tabelas reescrita);
 *   4. depois: conferência JA_APLICADA (como o dono e como admin); segunda tentativa recusada pelo marcador; SELECT nas
 *      tabelas novas revogado → recusa pelo nome; rodízio com linha (chave ligada) → RECUSARIA por desenho; deriva (índice
 *      de busca removido → parcial; índice único do rodízio removido → postcheck divergente) → restaurada → JA_APLICADA;
 *      down pelo dono volta à impressão;
 *   5. controle positivo da prova de preservação: uma linha de cada tabela escrita na própria transação é contada;
 *   6. falha REAL: outra sessão escreve em whatsapp_atendimento_mensagens (ROW EXCLUSIVE) → o índice da 117 espera SHARE e
 *      estoura o lock_timeout → NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica; down.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string;
  contagens?: { mensagensPorAmbienteDirecao: Record<string, number>; novas?: Record<string, number> };
  contagensAntes?: { mensagensPorAmbienteDirecao: Record<string, number> };
  contagensDepois?: { mensagensPorAmbienteDirecao: Record<string, number>; novas?: Record<string, number> } };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-117-staging.cjs")) as Aplicador;
const { SQL_PRESERVACAO, PRESERVADAS } = exigir(join(raiz, "scripts/migration-117-comum.cjs")) as { SQL_PRESERVACAO: string; PRESERVADAS: string[] };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_117";
const DOWN117 = readFileSync(resolve(raiz, "database/rollback/20261104_117_atendimento_multiempresa_down.sql"), "utf8");
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const INDICE = "whatsapp_atendimento_mensagens_ambiente_provedor_idx";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string, p?: unknown[]) { return q === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(q, p); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 117 real: parcial, papel mínimo não superusuário, preservação, postcheck no catálogo real, deriva, down, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-117-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-11-04T22:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
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
  /** As 2 tabelas que a 117 trava, linha a linha com xmin: o retrato que ela não pode mudar. */
  const dados = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|', ${PRESERVADAS.map((t) =>
      `(SELECT string_agg(md5(x::text) || ':' || x.xmin::text, ',' ORDER BY md5(x::text)) FROM (SELECT tb.*, tb.xmin FROM public.${t} tb) x)`).join(", ")})) AS h`)).rows[0].h;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão e os dados não mudam. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao(), linhas = await dados();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source); assert.equal(await dados(), linhas);
  };
  const instalada = async () => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM unnest(ARRAY['whatsapp_atendimento_rodizio','whatsapp_atendimento_status_colisoes','${INDICE}']) x
    WHERE to_regclass('public.' || x) IS NOT NULL`)).rows[0].n;
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  try {
    assert.equal(await instalada(), 0, "modelo sem a 117");
    // Dados reais nas 2 tabelas travadas pela 117.
    const empresa = (await c.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet aplicador 117', 'PROVISIONAMENTO') RETURNING id::text AS id",
      [`a117${randomBytes(4).toString("hex")}`])).rows[0].id as string;
    await c.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid", [empresa]);
    const usuario = (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Op 117', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id",
      [`op${randomBytes(4).toString("hex")}@example.test`, SENHA_FALSA])).rows[0].id as string;
    const conversa = (await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id, versao",
      [empresa, `5561977${String(randomBytes(2).readUInt16BE(0)).padStart(6, "0")}`])).rows[0] as { id: string; versao: string };
    await c.query("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'staging', 'SAIDA', 'Resposta na fila', 'PENDENTE', $3)",
      [conversa.id, empresa, Number(conversa.versao)]);
    const repetido = `wamid.${randomBytes(6).toString("hex")}`;
    for (let i = 0; i < 2; i++) await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, autor_usuario_id, provedor_id)
      VALUES ($1, $2, 'staging', 'SAIDA', 'Resposta sintética', 'SUBMETIDA', $3, $4, $5)`, [conversa.id, empresa, Number(conversa.versao), usuario, repetido]);
    for (const t of PRESERVADAS) assert.ok(Number((await c.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n) >= 1, "dados em " + t);
    const linhasIniciais = await dados();

    // 1. Conferência só leitura (o identificador repetido é só informado pelo precheck).
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 117": "PASS" }); assert.equal(conf.estado!.objetos, 0);
    assert.ok((conf.contagens!.mensagensPorAmbienteDirecao["staging:SAIDA"] ?? 0) >= 3, JSON.stringify(conf.contagens));
    assert.equal(conf.contagens!.novas, undefined);
    assert.equal(await impressao(), antes); assert.equal(await dados(), linhasIniciais);

    // 1b. P1 (Astra r1): chave MULTI ligada ou inválida no processo — conferência informa e recusa; aplicação recusa antes do
    // marcador e de conectar. Nada muda no banco.
    for (const [valor, chave] of [["true", "LIGADA"], ["sim", "INVALIDA"]] as const) {
      const env = { ...ENV_STG, WHATSAPP_ATENDIMENTO_MULTIEMPRESA: valor };
      const r = await stg.conferir({ env, raiz, Client: clienteDescartavel({}) });
      assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, new RegExp(`CHAVE_MULTIEMPRESA_NAO_DESLIGADA ${chave}$`));
      const dirChave = novoDir();
      await assert.rejects(stg.executar({ env, backup: BACKUP, dir: dirChave, raiz, disco: () => {}, Client: clienteDescartavel({}) }), /CHAVE_MULTIEMPRESA_NAO_DESLIGADA/);
      assert.deepEqual(readdirSync(dirChave), [], "nenhum marcador");
    }
    assert.equal(await impressao(), antes); assert.equal(await dados(), linhasIniciais);

    // 2. Aplicação parcial simulada: o índice de busca da 117 já existe (as tabelas não).
    await c.query(`CREATE INDEX ${INDICE} ON whatsapp_atendimento_mensagens (ambiente, provedor_id) WHERE provedor_id IS NOT NULL`);
    try { await recusa(/APLICACAO_PARCIAL_117 tabelas 0\/2$/); } finally { await c.query(`DROP INDEX ${INDICE}`); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Papel não superusuário: cada falta recusa com o nome; com o mínimo, aplica.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    let dirMin = "";
    try {
      // P3 (Astra r1): sem USAGE em public (nem pelo PUBLIC), o to_regclass qualificado falharia; a recusa é nominal.
      const publicTinha = (await c.query<{ ok: boolean }>(`SELECT has_schema_privilege('${MINIMO}', 'public', 'USAGE') AS ok`)).rows[0].ok;
      if (publicTinha) await c.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
      try {
        assert.equal((await c.query<{ ok: boolean }>(`SELECT has_schema_privilege('${MINIMO}', 'public', 'USAGE') AS ok`)).rows[0].ok, false);
        await recusa(/^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/, MINIMO);
      } finally { if (publicTinha) await c.query("GRANT USAGE ON SCHEMA public TO PUBLIC"); }
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await c.query(`GRANT SELECT ON whatsapp_atendimento_mensagens TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_LEITURA SELECT_EMPRESAS$/, MINIMO);
      await c.query(`GRANT SELECT ON empresas TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_117 DONO_MENSAGENS REFERENCES_EMPRESAS$/, MINIMO);
      await c.query(`ALTER TABLE whatsapp_atendimento_mensagens OWNER TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_117 REFERENCES_EMPRESAS$/, MINIMO);
      await c.query(`GRANT REFERENCES ON empresas TO ${MINIMO}`);
      const antesDono = await impressao();
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta)); assert.equal(pronta.estado!.papel_trocado, true);
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`);
      try { await recusa(/SEM_PRIVILEGIO_117 CREATE$/, MINIMO); } finally { await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`); }
      assert.equal(await impressao(), antesDono);
      dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 117: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 117", "migration 117", "postcheck 117"]);
      assert.deepEqual(ap.contagensDepois!.mensagensPorAmbienteDirecao, ap.contagensAntes!.mensagensPorAmbienteDirecao);
      assert.deepEqual(ap.contagensDepois!.novas, { rodizio: 0, colisoes: 0 });
      const m = JSON.parse(readFileSync(ap.marcador!, "utf8"));
      assert.deepEqual(m.etapas.find((e: { nome: string }) => e.nome === "migration 117").antesDoCommit, { preservacao: "PASS", indices: "PASS", "postcheck 117": "PASS" });
      assert.equal(await dados(), linhasIniciais, "nenhuma linha das 2 tabelas reescrita (xmin incluído)");
      assert.equal(await instalada(), 3, "os 3 objetos da 117");

      // 4. Depois da aplicação.
      const ja = await conferir(MINIMO);
      assert.equal(ja.resultado, "JA_APLICADA_POSTCHECK_PASS", JSON.stringify(ja)); assert.deepEqual(ja.checks, { "postcheck 117": "PASS" });
      assert.deepEqual(ja.contagens!.novas, { rodizio: 0, colisoes: 0 });
      assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
      // Com a 117 presente, o postcheck (bloco DO) e as contagens leem as 2 tabelas novas: cada falta recusada pelo nome.
      for (const [revogar, restaurar, motivo] of [
        [`REVOKE SELECT ON whatsapp_atendimento_rodizio FROM ${MINIMO}`, `GRANT SELECT ON whatsapp_atendimento_rodizio TO ${MINIMO}`, /SEM_PRIVILEGIO_117_PRESENTE SELECT_RODIZIO$/],
        [`REVOKE SELECT ON whatsapp_atendimento_status_colisoes FROM ${MINIMO}`, `GRANT SELECT ON whatsapp_atendimento_status_colisoes TO ${MINIMO}`, /SEM_PRIVILEGIO_117_PRESENTE SELECT_COLISOES$/],
        ["REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC", "GRANT USAGE ON LANGUAGE plpgsql TO PUBLIC", /SEM_PRIVILEGIO_117_PRESENTE LINGUAGEM$/],
      ] as const) {
        await c.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await c.query(restaurar); }
        assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + motivo.source);
      }
      // Chave ligada (o rodízio ganha a vez de uma empresa): a conferência recusa por desenho — serve só à janela.
      await c.query("INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ($1, 'staging', 1)", [empresa]);
      try {
        const d = await conferir();
        assert.equal(d.resultado, "RECUSARIA", JSON.stringify(d)); assert.match(d.motivo!, /117 postcheck: rodízio não está vazio/);
      } finally { await c.query("DELETE FROM whatsapp_atendimento_rodizio"); }
      // Marcas de colisão podem existir também no PILOTO: não recusam.
      await c.query("INSERT INTO whatsapp_atendimento_status_colisoes (ambiente, provedor_id) VALUES ('staging', $1)", [repetido]);
      try {
        const d = await conferir();
        assert.equal(d.resultado, "JA_APLICADA_POSTCHECK_PASS", JSON.stringify(d)); assert.deepEqual(d.contagens!.novas, { rodizio: 0, colisoes: 1 });
      } finally { await c.query("DELETE FROM whatsapp_atendimento_status_colisoes"); }
      // Deriva da 117: índice de busca removido (2 de 3 objetos, parcial) e índice único do rodízio removido (postcheck).
      for (const [derivar, restaurar, motivo] of [
        [`DROP INDEX ${INDICE}`, `CREATE INDEX ${INDICE} ON whatsapp_atendimento_mensagens (ambiente, provedor_id) WHERE provedor_id IS NOT NULL`,
          /APLICACAO_PARCIAL_117 indices 0\/1$/],
        ["DROP INDEX whatsapp_atendimento_rodizio_ordem_uq", "CREATE UNIQUE INDEX whatsapp_atendimento_rodizio_ordem_uq ON whatsapp_atendimento_rodizio (ambiente, ordem)",
          /117 postcheck: definição divergente em whatsapp_atendimento_rodizio/],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar + JSON.stringify(d)); assert.match(d.motivo!, motivo);
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + derivar);
      }

      // P2 (Astra r1): índice da 117 com a definição esperada mas inválido, não pronto ou inativo (pg_index): recusa pelo nome.
      for (const [indice, flag] of [[INDICE, "indisvalid"], ["whatsapp_atendimento_rodizio_ordem_uq", "indisready"],
        ["whatsapp_atendimento_status_colisoes_pkey", "indislive"]] as const) {
        await c.query(`UPDATE pg_index SET ${flag} = false WHERE indexrelid = to_regclass('public.${indice}')`);
        try { await recusa(new RegExp(`^INDICE_INVALIDO_117 ${indice}$`), MINIMO); }
        finally { await c.query(`UPDATE pg_index SET ${flag} = true WHERE indexrelid = to_regclass('public.${indice}')`); }
        assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + indice);
      }

      // Down (só no descartável), pelo dono.
      await c.query(`SET ROLE ${MINIMO}`); await c.query(DOWN117); await c.query("RESET ROLE");
      assert.equal(await impressao(), antesDono, "down voltou ao estado do dono");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), 0, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");
    assert.equal(await dados(), linhasIniciais, "down não reescreveu as 2 tabelas");

    // 5. Controle positivo da prova de preservação: cada tabela escrita na própria transação é contada.
    for (const [t, escrita] of [
      ["empresas", "UPDATE empresas SET nome = nome WHERE id = $1::uuid"],
      ["whatsapp_atendimento_mensagens", "UPDATE whatsapp_atendimento_mensagens SET texto = texto WHERE empresa_id = $1::uuid"],
    ] as const) {
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL session_replication_role = replica");
        assert.equal((await c.query(SQL_PRESERVACAO)).rows[0][t], 0, t + " antes");
        await c.query(escrita, [empresa]);
        const p = (await c.query(SQL_PRESERVACAO)).rows[0];
        assert.ok(p[t] >= 1, t + " escrita contada"); assert.ok(PRESERVADAS.filter((k) => k !== t).every((k) => p[k] === 0), t + " só ela");
      } finally { await c.query("ROLLBACK"); }
    }

    // 6. Falha real: outra sessão escreve nas mensagens; o índice da 117 estoura o lock_timeout de 5 s do SQL.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE deixa passar o catálogo, as contagens, o precheck e a FK para empresas, mas conflita com o SHARE do índice.
      await trava.query("LOCK TABLE whatsapp_atendimento_mensagens IN ROW EXCLUSIVE MODE");
      const inicio = Date.now();
      const f = await executar(dirFalha);
      assert.ok(Date.now() - inicio >= 4500, "esperou o lock_timeout");
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 117: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 117");
      assert.match(f.falha!.mensagem, /lock timeout/);
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.equal(await instalada(), 0, "nada criado");
    assert.equal(await impressao(), antes);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-117.json"), join(dirFalha, "migration-117.2026-11-04T22-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 117: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
    assert.equal(await dados(), linhasIniciais, "retomada também não reescreveu linhas");
    await c.query(DOWN117);
    assert.equal(await impressao(), antes, "limpo ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
