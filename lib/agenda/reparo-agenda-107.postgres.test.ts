import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 107 (reparo da deriva da agenda; plano "Retomada 098" rev. 2.1, D-R2a) no PostgreSQL DESCARTÁVEL, modelo 106 (a cadeia
 * recriada do zero = base canônica):
 * - base canônica: no-op (registro vazio), catálogo idêntico; down só apaga o registro; reaplicação;
 * - recusas sem efeito: os dois nomes juntos, definição diferente, gatilho de atualizado_em com outro nome, dado que viola
 *   o CHECK a criar, down sem registro, down com objeto mexido depois da 107;
 * - deriva conhecida do staging (25/10/2026) simulada exatamente: 3 índices ix_*, 6 CHECKs ck_*, sem os 2 gatilhos e os
 *   3 CHECKs nao_vazio → a 107 leva ao catálogo canônico com 14 ações registradas; o down devolve EXATAMENTE a deriva
 *   (P2-R2-1: dois ciclos up/down/up, e o down nunca remove objeto que já existia na base canônica).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIG = "database/migrations/20261028_107_reparo_deriva_agenda.sql";
const DOWN = "database/rollback/20261028_107_reparo_deriva_agenda_down.sql";
const PRE = "database/checks/20261028_107_precheck.sql";
const POS = "database/checks/20261028_107_postcheck.sql";

let a: Client;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => { assert.match(msg(e), trecho); return true; });
  await a.query("ROLLBACK").catch(() => undefined);
}

/** Catálogo das duas tabelas da agenda: índices, CHECKs e gatilhos (nome + definição do servidor), ordenado. */
async function catalogo(db: Client = a) {
  return (await db.query<{ l: string }>(
    `SELECT l FROM (
       SELECT 'I|' || c.relname || '|' || pg_get_indexdef(i.indexrelid) AS l FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid IN ('public.bloqueios_agenda'::regclass, 'public.configuracao_agenda'::regclass)
       UNION ALL
       SELECT 'K|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) || '|' || convalidated FROM pg_constraint
        WHERE conrelid IN ('public.bloqueios_agenda'::regclass, 'public.configuracao_agenda'::regclass)
       UNION ALL
       SELECT 'T|' || tgname || '|' || pg_get_triggerdef(oid) || '|' || tgenabled::text FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid IN ('public.bloqueios_agenda'::regclass, 'public.configuracao_agenda'::regclass)
     ) x ORDER BY l`)).rows.map((r) => r.l);
}
const registro = async () => (await a.query<{ acao: string; nome_anterior: string | null; nome_novo: string }>(
  `SELECT acao, nome_anterior, nome_novo FROM kidmais107_reparos ORDER BY ordem`)).rows;
const aplicar = async () => { await a.query(arquivo(PRE)); await a.query(arquivo(MIG)); await a.query(arquivo(POS)); };

/** A deriva do staging (diagnóstico de 25/10/2026), exatamente. */
const DERIVA = `BEGIN;
ALTER INDEX public.bloqueios_agenda_data_ativos_idx RENAME TO ix_bloqueios_agenda_data_ativos;
ALTER INDEX public.bloqueios_agenda_intervalo_ativos_idx RENAME TO ix_bloqueios_agenda_intervalo_ativos;
ALTER INDEX public.configuracao_agenda_ativos_idx RENAME TO ix_configuracao_agenda_ativos;
ALTER TABLE public.bloqueios_agenda RENAME CONSTRAINT bloqueios_agenda_periodo_check TO ck_bloqueios_agenda_periodo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_intervalo_check TO ck_configuracao_agenda_intervalo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_tolerancia_check TO ck_configuracao_agenda_tolerancia;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_passo_check TO ck_configuracao_agenda_passo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_passo_compativel_check TO ck_configuracao_agenda_passo_compativel;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_ordem_check TO ck_configuracao_agenda_ordem;
ALTER TABLE public.bloqueios_agenda DROP CONSTRAINT bloqueios_agenda_motivo_nao_vazio;
ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_codigo_nao_vazio, DROP CONSTRAINT configuracao_agenda_nome_nao_vazio;
DROP TRIGGER bloqueios_agenda_atualizado_em_trg ON public.bloqueios_agenda;
DROP TRIGGER configuracao_agenda_atualizado_em_trg ON public.configuracao_agenda;
COMMIT;`;

test.before(async () => { a = await conectarDescartavel(); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

let canonico: string[] = [];

test("base canônica: no-op com registro vazio; catálogo idêntico; down só apaga o registro; reaplicação", async () => {
  canonico = await catalogo();
  assert.equal(canonico.filter((l) => /ix_|\|ck_/.test(l)).length, 0, "modelo 106 = base canônica, sem nome de deriva");
  await aplicar();
  assert.deepEqual(await registro(), [], "nada reparado");
  assert.deepEqual(await catalogo(), canonico, "catálogo inalterado");
  await recusa(a.query(arquivo(MIG)), /relation "kidmais107_reparos" already exists|107/);
  await recusa(a.query(arquivo(PRE)), /107 precheck: agenda da 005 ausente ou 107 já aplicada/);
  await a.query(arquivo(DOWN));
  assert.equal((await a.query(`SELECT to_regclass('public.kidmais107_reparos') IS NULL AS ok`)).rows[0].ok, true);
  assert.deepEqual(await catalogo(), canonico, "down na base canônica não remove nenhum objeto da 005");
  await recusa(a.query(arquivo(DOWN)), /107 down: sem o registro de proveniência/);
});

test("recusas sem efeito: os dois nomes juntos, definição diferente, gatilho com outro nome, dado que viola o CHECK a criar", async () => {
  const casos: Array<{ preparar: string; desfazer: string; trecho: RegExp }> = [
    { preparar: `CREATE INDEX ix_bloqueios_agenda_data_ativos ON public.bloqueios_agenda (data) WHERE ativo = true`,
      desfazer: `DROP INDEX public.ix_bloqueios_agenda_data_ativos`, trecho: /107: bloqueios_agenda_data_ativos_idx e ix_bloqueios_agenda_data_ativos existem juntos/ },
    { preparar: `ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_ordem_check;
                 ALTER TABLE public.configuracao_agenda ADD CONSTRAINT ck_configuracao_agenda_ordem CHECK (ordem_exibicao >= 0)`,
      desfazer: `ALTER TABLE public.configuracao_agenda DROP CONSTRAINT ck_configuracao_agenda_ordem;
                 ALTER TABLE public.configuracao_agenda ADD CONSTRAINT configuracao_agenda_ordem_check CHECK (ordem_exibicao > 0)`,
      trecho: /107: ck_configuracao_agenda_ordem com definição diferente da 005/ },
    { preparar: `ALTER INDEX public.configuracao_agenda_ativos_idx RENAME TO ix_configuracao_agenda_ativos;
                 DROP INDEX public.ix_configuracao_agenda_ativos;
                 CREATE INDEX ix_configuracao_agenda_ativos ON public.configuracao_agenda (ordem_exibicao)`,
      desfazer: `DROP INDEX public.ix_configuracao_agenda_ativos;
                 CREATE INDEX configuracao_agenda_ativos_idx ON public.configuracao_agenda (ordem_exibicao) WHERE ativo = true`,
      trecho: /107: ix_configuracao_agenda_ativos com definição diferente da 005/ },
    { preparar: `CREATE TRIGGER x_bloqueios_atualizado BEFORE UPDATE ON public.bloqueios_agenda FOR EACH ROW EXECUTE FUNCTION public.kidmais_set_atualizado_em()`,
      desfazer: `DROP TRIGGER x_bloqueios_atualizado ON public.bloqueios_agenda`, trecho: /107: bloqueios_agenda tem gatilho de atualizado_em com outro nome/ },
    { preparar: `ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_passo_check;
                 ALTER TABLE public.configuracao_agenda ADD CONSTRAINT ck_configuracao_agenda_passo CHECK (passo_inicio_minutos BETWEEN 1 AND 180) NOT VALID`,
      desfazer: `ALTER TABLE public.configuracao_agenda DROP CONSTRAINT ck_configuracao_agenda_passo;
                 ALTER TABLE public.configuracao_agenda ADD CONSTRAINT configuracao_agenda_passo_check CHECK (passo_inicio_minutos BETWEEN 1 AND 180)`,
      trecho: /107: ck_configuracao_agenda_passo com definição diferente da 005 .*\[FORMA\]/ },
  ];
  for (const k of casos) {
    await a.query(k.preparar);
    const antes = await catalogo();
    await recusa(a.query(arquivo(MIG)), k.trecho);
    assert.deepEqual(await catalogo(), antes, "nada alterado");
    assert.equal((await a.query(`SELECT to_regclass('public.kidmais107_reparos') IS NULL AS ok`)).rows[0].ok, true, "sem registro");
    await a.query(k.desfazer);
    assert.deepEqual(await catalogo(), canonico, "volta à base canônica");
  }
  // CHECK nao_vazio ausente com linha que o violaria: recusa sem criar nada.
  const c = await cenario(a, 0);
  await a.query(`ALTER TABLE public.bloqueios_agenda DROP CONSTRAINT bloqueios_agenda_motivo_nao_vazio`);
  const b = (await a.query<{ id: string }>(`INSERT INTO bloqueios_agenda (data, dia_inteiro, motivo, ativo, empresa_id) VALUES (current_date + 400, true, '  ', false, $1::uuid) RETURNING id`, [c.empresa])).rows[0]!.id;
  await recusa(a.query(arquivo(MIG)), /107: bloqueios_agenda_motivo_nao_vazio não pode ser criado: há linha que o viola/);
  await a.query(`DELETE FROM bloqueios_agenda WHERE id = $1::uuid`, [b]);
  await a.query(`ALTER TABLE public.bloqueios_agenda ADD CONSTRAINT bloqueios_agenda_motivo_nao_vazio CHECK (btrim(motivo) <> '')`);
  assert.deepEqual(await catalogo(), canonico);
});

test("deriva conhecida do staging: 107 leva ao canônico com 14 ações; down devolve EXATAMENTE a deriva; dois ciclos; down recusa objeto mexido", async () => {
  await a.query(DERIVA);
  const deriva = await catalogo();
  assert.notDeepEqual(deriva, canonico);
  for (let ciclo = 1; ciclo <= 2; ciclo++) {
    await aplicar();
    assert.deepEqual(await catalogo(), canonico, `ciclo ${ciclo}: catálogo canônico`);
    const r = await registro();
    assert.equal(r.length, 14, `ciclo ${ciclo}: 14 ações`);
    assert.deepEqual(r.map((x) => x.acao).sort(), [
      ...Array(2).fill("CRIAR_GATILHO"), ...Array(3).fill("CRIAR_CHECK"), ...Array(6).fill("RENOMEAR_CHECK"), ...Array(3).fill("RENOMEAR_INDICE"),
    ].sort());
    await a.query(arquivo(DOWN));
    assert.deepEqual(await catalogo(), deriva, `ciclo ${ciclo}: down devolve a deriva exata`);
  }
  // Objeto mexido depois da 107: o down recusa sem alterar nada.
  await aplicar();
  await a.query(`ALTER INDEX public.bloqueios_agenda_data_ativos_idx RENAME TO outro_nome_idx`);
  const mexido = await catalogo();
  await recusa(a.query(arquivo(DOWN)), /107 down: bloqueios_agenda_data_ativos_idx não está como a 107 deixou/);
  assert.deepEqual(await catalogo(), mexido, "nada alterado");
  await a.query(`ALTER INDEX public.outro_nome_idx RENAME TO bloqueios_agenda_data_ativos_idx`);
  // Deixa o banco na base canônica SEM a 107 (para as suítes seguintes): o registro é descartado à mão, não pelo down.
  await a.query(`DROP TABLE public.kidmais107_reparos`);
  assert.deepEqual(await catalogo(), canonico);
});
