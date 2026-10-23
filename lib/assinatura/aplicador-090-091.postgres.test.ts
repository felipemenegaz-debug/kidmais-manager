import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { iniciarTeste } from "./servico.ts";
import { prepararOferta } from "./ofertas.ts";

/**
 * Aplicadores REAIS da 090 (campanha Fundador), da 091 (documento CPF/CNPJ) e da 096 (comprovante da contratação e
 * arquivo das versões; grupo B, 22/10/2026), staging e produção, no PostgreSQL
 * DESCARTÁVEL (modelo 089, as duas ausentes), no desenho do teste dos aplicadores 088/089. Única substituição: o cliente
 * conecta ao cluster descartável (identidade provada por conectarDescartavel) e responde à consulta de identidade como o
 * banco do ambiente responderia. Para cada migration:
 *   1. conferência só leitura (staging e produção) → PRONTA, nada criado;
 *   2. papel sem CREATE / sem ser dono das tabelas alteradas (has_*_privilege e pg_has_role reais) → RECUSARIA e FALHA antes de escrever;
 *   3. vestígio parcial (só a função criada à mão) → recusa;
 *   4. falha REAL dentro da migration (lock_timeout com tráfego simulado) → FALHA no marcador, nada fica, sem repetição;
 *   5. aplicação (produção) sobre fixtures legadas → APLICADA_POSTCHECK_PASS com prova agregada de preservação; repetição recusada;
 *   6. nova conferência e nova aplicação (outro registro) só conferem.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[]; estado?: Record<string, unknown>;
  estadoDepois?: Record<string, unknown>; contagensAntes?: Record<string, unknown>; contagensDepois?: Record<string, unknown>; migracaoCommitada?: boolean };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const carregar = (n: string) => ({ stg: exigir(join(raiz, `scripts/migration-${n}-staging.cjs`)) as Aplicador, prod: exigir(join(raiz, `scripts/migration-${n}-production.cjs`)) as Aplicador });
// Configurações FICTÍCIAS: só satisfazem a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const ENV_PROD = { RENDER: "true", RENDER_SERVICE_ID: "srv-dak77m2d0e5s73b8rkkg", KIDMAIS_DEPLOY_ENV: "production", DATABASE_SSL: "true",
  DATABASE_SSL_REJECT_UNAUTHORIZED: "false", DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-dak750gae00c73fudmg0-a/kidmais_production" };
const PAPEL = "kidmais_teste_aplicador_090_091";
const BACKUP = "export 2026-10-22T12:00Z teste";
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";

function clienteDescartavel(identidades: Map<string, unknown>, cfg: { papel?: string; antesDaMigration?: () => Promise<void> } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() { this.c = await conectarDescartavel({ travar: false }); if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`); }
    async query(sql: string) {
      const id = identidades.get(sql);
      if (id) return { rows: [id] };
      // Gancho do teste: tráfego que começa DEPOIS do corte e antes da migration (o arquivo começa por "-- 09x —").
      if (cfg.antesDaMigration && /^-- 09[016] —/.test(sql)) { const h = cfg.antesDaMigration; cfg.antesDaMigration = undefined; await h(); }
      return this.c!.query(sql);
    }
    async end() { if (this.c) await this.c.end(); }
  };
}
function cnpj(n: number) {
  const base = `7${String(n).padStart(7, "0")}0001`;
  const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
  const d1 = dv(base); return base + d1 + dv(base + d1);
}

type Caso = { n: "090" | "091" | "096"; objetos: (c: Client) => Promise<boolean[]>; parcial: [string, string]; trafego: string; motivoSemPrivilegio: RegExp; chaveEstado: string };
const CASOS: Caso[] = [
  { n: "090", chaveEstado: "m090",
    objetos: async (c) => Object.values((await c.query(`SELECT to_regclass('public.assinatura_campanhas') IS NOT NULL AS t,
      to_regprocedure('public.kidmais_090_fundador_guarda()') IS NOT NULL AS f,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'assinatura_fundadores' AND column_name = 'origem') AS o`)).rows[0]),
    parcial: ["CREATE FUNCTION kidmais_090_campanha_guarda() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$", "DROP FUNCTION kidmais_090_campanha_guarda()"],
    trafego: "LOCK TABLE assinatura_fundadores IN ROW EXCLUSIVE MODE", motivoSemPrivilegio: /SEM_PRIVILEGIO_090 CREATE REFERENCES DONO/ },
  { n: "091", chaveEstado: "m091",
    objetos: async (c) => Object.values((await c.query(`SELECT to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL AS f,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'empresa_assinaturas_091_documento') AS d`)).rows[0]),
    parcial: ["CREATE FUNCTION kidmais_091_documento_valido(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'", "DROP FUNCTION kidmais_091_documento_valido(text)"],
    trafego: "LOCK TABLE empresa_assinaturas IN ROW EXCLUSIVE MODE", motivoSemPrivilegio: /SEM_PRIVILEGIO_091 CREATE REFERENCES DONO/ },
  // 096 só cria tabelas (sem exigir dono de tabela existente); a FK para assinatura_contratacoes disputa a trava do tráfego.
  { n: "096", chaveEstado: "m096",
    objetos: async (c) => Object.values((await c.query(`SELECT to_regclass('public.documentos_legais_versoes') IS NOT NULL AS v,
      to_regclass('public.assinatura_comprovantes') IS NOT NULL AS c, to_regprocedure('public.kidmais_096_guarda()') IS NOT NULL AS g`)).rows[0]),
    parcial: ["CREATE FUNCTION kidmais_096_guarda() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$", "DROP FUNCTION kidmais_096_guarda()"],
    trafego: "LOCK TABLE assinatura_contratacoes IN ROW EXCLUSIVE MODE", motivoSemPrivilegio: /SEM_PRIVILEGIO_096 CREATE REFERENCES/ },
];

test("aplicadores 090 e 091 reais no modelo 089: conferência, privilégios/dono, parcial, falha real, aplicação com preservação, anti-repetição",
  { timeout: 600_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = (n: string) => { const d = mkdtempSync(join(tmpdir(), `aplicador-${n}-`)); dirs.push(d); return d; };
  try {
    // Fixtures legadas criadas pelo código atual (sem 090/091): duas concessões Fundador LEGADO reservadas.
    const usuario = (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Aplicador', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
      [`ap${randomBytes(3).toString("hex")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`])).rows[0].id;
    for (let i = 1; i <= 2; i++) {
      const e = (await c.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Aplicador', 'PROVISIONAMENTO') RETURNING id", [`ap${i}${randomBytes(3).toString("hex")}`])).rows[0].id;
      await c.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [e]);
      await c.query("BEGIN");
      await iniciarTeste(c as never, { empresaId: e, documento: cnpj(i) });
      await prepararOferta(c as never, e, usuario, { plano: "essencial", ciclo: "MENSAL", valorEsperadoCentavos: 11820, versao: "2026-10-20" });
      await c.query("COMMIT");
    }
    for (const caso of CASOS) {
      const { stg, prod } = carregar(caso.n);
      const ids = new Map<string, unknown>([[stg.SQL_IDENTIDADE, { db: "kidmais_staging_1z91", tls: false, servidor_privado: true }],
        [prod.SQL_IDENTIDADE, { db: "kidmais_production", tls: true, tls_versao: "TLSv1.3", servidor_privado: true }]]);
      const cli = (cfg: { papel?: string; antesDaMigration?: () => Promise<void> } = {}) => clienteDescartavel(ids, cfg);
      const nada = async () => assert.ok((await caso.objetos(c)).every((x) => x === false), `${caso.n}: nada criado`);
      await nada();
      // 1. Conferência só leitura.
      for (const [m, env] of [[stg, ENV_STG], [prod, ENV_PROD]] as const) {
        const conf = await m.conferir({ env, raiz, Client: cli() });
        assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", `${caso.n} ${JSON.stringify(conf)}`);
        assert.equal((conf.estado as Record<string, unknown>)[caso.chaveEstado], "ausente");
      }
      await nada();
      // 2. Papel sem CREATE nem dono (só USAGE/SELECT); depois com CREATE e REFERENCES, ainda sem ser dono.
      await c.query(`DROP ROLE IF EXISTS ${PAPEL}`); await c.query(`CREATE ROLE ${PAPEL} NOLOGIN`);
      try {
        await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`); await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
        const r1 = await prod.conferir({ env: ENV_PROD, raiz, Client: cli({ papel: PAPEL }) });
        assert.equal(r1.resultado, "RECUSARIA"); assert.match(r1.motivo!, caso.motivoSemPrivilegio);
        await c.query(`GRANT CREATE ON SCHEMA public TO ${PAPEL}`); await c.query(`GRANT REFERENCES ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
        const r2 = await stg.conferir({ env: ENV_STG, raiz, Client: cli({ papel: PAPEL }) });
        if (caso.n === "096") {
          // Sem tabela existente alterada: CREATE + REFERENCES bastam (não executa com este papel, que ficaria dono).
          assert.equal(r2.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(r2));
          await c.query(`REVOKE CREATE ON SCHEMA public FROM ${PAPEL}`);
        }
        else { assert.equal(r2.resultado, "RECUSARIA"); assert.match(r2.motivo!, new RegExp(`SEM_PRIVILEGIO_${caso.n} +DONO`)); }
        const dir = novoDir(caso.n);
        const r3 = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: cli({ papel: PAPEL }) });
        assert.equal(r3.resultado, "FALHA"); assert.match(r3.falha!.mensagem, new RegExp(`SEM_PRIVILEGIO_${caso.n}`)); assert.equal(r3.migracaoCommitada, false);
        assert.equal(JSON.parse(readFileSync(join(dir, `migration-${caso.n}.json`), "utf8")).situacao, "FALHA");
        await nada();
      } finally {
        await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL}`); await c.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL}`); await c.query(`DROP ROLE ${PAPEL}`);
      }
      // 3. Vestígio parcial.
      await c.query(caso.parcial[0]);
      assert.match((await stg.conferir({ env: ENV_STG, raiz, Client: cli() })).motivo!, new RegExp(`APLICACAO_PARCIAL_${caso.n}`));
      const parcial = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: novoDir(caso.n), raiz, disco: () => {}, Client: cli() });
      assert.equal(parcial.resultado, "FALHA"); assert.match(parcial.falha!.mensagem, new RegExp(`APLICACAO_PARCIAL_${caso.n}`));
      await c.query(caso.parcial[1]);
      // 4a. Transação aberta ANTES do corte (escrita ainda não confirmada): o aplicador espera e, sem fim, recusa antes de
      //     escrever (sem falso PRESERVACAO_DIVERGENTE depois). Revisão de 22/10/2026.
      const antiga = await conectarDescartavel({ travar: false });
      let recusa: Resultado;
      try {
        await antiga.query("BEGIN"); await antiga.query(caso.trafego);
        recusa = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir: novoDir(caso.n), raiz, disco: () => {}, Client: cli(), pausa: async () => {}, tentativas: 3 });
      } finally { await antiga.query("ROLLBACK").catch(() => {}); await antiga.end(); }
      assert.equal(recusa.resultado, "FALHA", JSON.stringify(recusa)); assert.match(recusa.falha!.mensagem, /TRANSACOES_ANTERIORES_AO_CORTE/);
      assert.equal(recusa.migracaoCommitada, false);
      await nada();
      // 4b. Falha REAL na migration: tráfego que começa DEPOIS do corte, em ROW EXCLUSIVE na tabela alterada (leituras
      //     passam; o LOCK da migration espera o lock_timeout de 5 s e a transação do arquivo é desfeita por inteiro).
      const outra = await conectarDescartavel({ travar: false });
      const dirFalha = novoDir(caso.n);
      let falha: Resultado;
      try {
        falha = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir: dirFalha, raiz, disco: () => {},
          Client: cli({ antesDaMigration: async () => { await outra.query("BEGIN"); await outra.query(caso.trafego); } }) });
      } finally { await outra.query("ROLLBACK").catch(() => {}); await outra.end(); }
      assert.equal(falha.resultado, "FALHA", JSON.stringify(falha)); assert.equal(falha.falha!.etapa, `migration ${caso.n}`);
      assert.match(falha.falha!.mensagem, /lock timeout/); assert.equal(falha.migracaoCommitada, false);
      await nada();
      await assert.rejects(prod.executar({ env: ENV_PROD, backup: BACKUP, dir: dirFalha, raiz, disco: () => {}, Client: cli() }), /TENTATIVA_ANTERIOR_REVISAR/);
      // 5. Aplicação real (produção) com prova agregada de preservação. Uma transação aberta ANTES do corte termina durante
      //    a espera (a pausa a confirma): o aplicador espera de verdade e segue.
      const dir = novoDir(caso.n);
      const pendente = await conectarDescartavel({ travar: false });
      let ok: Resultado & { esperaCorte?: { esperas: number; sessoesInvisiveis: number } };
      try {
        await pendente.query("BEGIN"); await pendente.query("SELECT count(*) FROM empresas");
        ok = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: cli(),
          pausa: async () => { await pendente.query("COMMIT"); }, tentativas: 5 });
      } finally { await pendente.query("ROLLBACK").catch(() => {}); await pendente.end(); }
      assert.ok((ok.esperaCorte?.esperas ?? 0) >= 1, `esperou a transação anterior ao corte: ${JSON.stringify(ok.esperaCorte)}`);
      assert.equal(ok.esperaCorte?.sessoesInvisiveis, 0);
      assert.equal(ok.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ok));
      assert.deepEqual(ok.etapas, [`precheck ${caso.n}`, `migration ${caso.n}`, `postcheck ${caso.n}`]);
      assert.equal((ok.estadoDepois as Record<string, unknown>)[caso.chaveEstado], "completa");
      assert.ok((await caso.objetos(c)).every((x) => x === true));
      if (caso.n === "090") {
        assert.equal(ok.contagensAntes!.fundadores, 2); assert.equal(ok.contagensDepois!.legado, 2);
        assert.equal(ok.contagensDepois!.resumo_fundadores, ok.contagensAntes!.resumo_fundadores);
      } else if (caso.n === "091") {
        assert.equal(ok.contagensDepois!.resumo_assinaturas, ok.contagensAntes!.resumo_assinaturas); assert.equal(ok.contagensDepois!.teste_cpf, 0);
      } else {
        assert.equal(ok.contagensAntes!.ofertas, 2); assert.equal(ok.contagensDepois!.resumo_ofertas, ok.contagensAntes!.resumo_ofertas);
        assert.equal(ok.contagensDepois!.resumo_aceites, ok.contagensAntes!.resumo_aceites); assert.equal(ok.contagensDepois!.comprovantes, 0, "nada retroativo");
      }
      assert.ok(!JSON.stringify(ok).includes(cnpj(1)), "saída sem documentos");
      assert.deepEqual(readdirSync(dir), [`migration-${caso.n}.json`]);
      const marcador = JSON.parse(readFileSync(join(dir, `migration-${caso.n}.json`), "utf8"));
      assert.equal(marcador.situacao, "CONCLUIDA"); assert.ok(!JSON.stringify(marcador).includes("senha-ficticia"));
      await assert.rejects(prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: cli() }), /TENTATIVA_ANTERIOR_REVISAR/);
      // 6. Depois: só confere.
      for (const [m, env] of [[stg, ENV_STG], [prod, ENV_PROD]] as const)
        assert.equal((await m.conferir({ env, raiz, Client: cli() })).resultado, "JA_APLICADA_POSTCHECK_PASS");
      const denovo = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: novoDir(caso.n), raiz, disco: () => {}, Client: cli() });
      assert.equal(denovo.resultado, "JA_APLICADA_POSTCHECK_PASS"); assert.deepEqual(denovo.etapas, [`postcheck ${caso.n}`]);
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
