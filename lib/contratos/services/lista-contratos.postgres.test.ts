import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { versaoDeReferencia } from "../versao-referencia.ts";
import { randomUUID } from "node:crypto";
import { FINANCEIRO_SQL, ORIGEM_POR_PRIORIDADE, PRIORIDADE_REFERENCIA_SQL, decodificarCursor, financeiroDaLinha } from "./lista-contratos.ts";
import {
  carregar, cenario, decisoes, dia, executor, importacao, instalar055, instalar061, instalar062, integrar, PARCIAL, validarAgora, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * Lista de contratos (fase 2) no PostgreSQL REAL do cluster descartável:
 *  1. paridade da versão de referência SQL × TypeScript em todas as combinações (SQL sobre VALUES, sem tabelas);
 *  2. contratos reais (integração de importados com pagamento parcial, serviço real): números da lista = leitura
 *     financeira do contrato (`lerPosicaoFinanceira`), isolamento entre duas empresas, busca e cursor sem repetição;
 *  3. volume: o grafo de contratos é clonado (gatilhos desligados só nesta transação) para milhares de contratos em
 *     duas empresas; tempos e plano da consulta ficam registrados. Tudo dentro de transação, desfeito no ROLLBACK.
 * Só roda pelo `check:v1:postgres` com KIDMAIS_POSTGRES_DESCARTAVEL (nunca staging/produção nem `kidmais_manager`).
 */
const STATUS = ["ATIVA", "SUBSTITUIDA", "ASSINADA", "CANCELADA"];
type ListaMod = typeof import("./lista-contratos.ts");
type FinMod = typeof import("../../pagamentos/repositories/alteracao-financeira.repository.ts");

test("lista de contratos: paridade da versão de referência, números iguais à leitura do contrato, isolamento e volume", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const a = await conectarDescartavel();
  try {
    t.beforeEach(async () => { await a.query("ROLLBACK"); });

    await t.test("versão de referência: SQL sobre VALUES = versaoDeReferencia, em qualquer ordem", async () => {
      const casos: Array<{ versoes: Array<{ id: string; numero_versao: number; status: string }>; fluxo: { versao_vigente_id: string | null; versao_em_preparacao_id: string | null } | null }> = [];
      const combinar = (k: number): string[][] => (k === 0 ? [[]] : combinar(k - 1).flatMap((c) => STATUS.map((s) => [...c, s])));
      for (let n = 1; n <= 3; n++) for (const estados of combinar(n)) {
        const versoes = estados.map((s, i) => ({ id: `v${i + 1}`, numero_versao: i + 1, status: s }));
        const ids = [null, "fora", ...versoes.map((v) => v.id)];
        casos.push({ versoes, fluxo: null });
        for (const vig of ids) for (const prep of ids) casos.push({ versoes, fluxo: { versao_vigente_id: vig, versao_em_preparacao_id: prep } });
      }
      // Valores fixos do próprio teste (ids "v1".."v3"/"fora", estados conhecidos): literais, sem parâmetros.
      const lit = (x: string | null) => (x === null ? "NULL::text" : `'${x}'::text`);
      const vv: string[] = [], ff: string[] = [];
      casos.forEach((c, k) => {
        for (const x of c.versoes) vv.push(`(${k}, ${lit(x.id)}, ${x.numero_versao}, ${lit(x.status)})`);
        if (c.fluxo) ff.push(`(${k}, ${lit(c.fluxo.versao_vigente_id)}, ${lit(c.fluxo.versao_em_preparacao_id)})`);
      });
      const r = await a.query<{ caso: number; id: string; prioridade: number }>(
        `WITH versoes(caso, id, numero_versao, status) AS (VALUES ${vv.join(",")}),
              fluxos(caso, versao_vigente_id, versao_em_preparacao_id) AS (VALUES ${ff.join(",")})
         SELECT DISTINCT ON (v.caso) v.caso, v.id, ${PRIORIDADE_REFERENCIA_SQL} AS prioridade
           FROM versoes v LEFT JOIN fluxos cf ON cf.caso = v.caso
          ORDER BY v.caso, prioridade, v.numero_versao DESC`);
      assert.equal(r.rows.length, casos.length);
      for (const linha of r.rows) {
        const caso = casos[linha.caso], esperado = versaoDeReferencia(caso.versoes, caso.fluxo)!;
        assert.equal(linha.id, esperado.versao.id, JSON.stringify(caso));
        assert.equal(ORIGEM_POR_PRIORIDADE[linha.prioridade], esperado.origem, JSON.stringify(caso));
      }
      assert.ok(casos.length > 1000);
    });

    await t.test("financeiro SQL real com NaN em recebimento e em estorno: sem erro, vira CONFERIR; controle válido OK", async () => {
      await a.query("BEGIN");
      // Tabelas temporárias com o mesmo nome das reais (pg_temp vem antes de public): só o FINANCEIRO_SQL, com dado anômalo.
      const ddl = [
        "CREATE TEMP TABLE fechamentos (id uuid PRIMARY KEY, empresa_id uuid) ON COMMIT DROP",
        "CREATE TEMP TABLE contratos (id uuid PRIMARY KEY, fechamento_id uuid) ON COMMIT DROP",
        "CREATE TEMP TABLE contrato_versoes (id uuid PRIMARY KEY, contrato_id uuid) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamentos (id uuid PRIMARY KEY, contrato_versao_id uuid, valor_total_contratado numeric(12,2), status text) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_recebimentos (id uuid PRIMARY KEY, pagamento_id uuid, valor_bruto numeric(12,2), status text) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_estornos (id uuid PRIMARY KEY, recebimento_id uuid, valor numeric(12,2), status text) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_devolucoes (pagamento_id uuid, valor_centavos bigint, estado text) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_eventos (id uuid PRIMARY KEY) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_ajustes_contratuais (pagamento_id uuid, delta_centavos bigint, evento_id uuid) ON COMMIT DROP",
        "CREATE TEMP TABLE pagamento_credito_reservas (pagamento_id uuid, valor_centavos bigint, estado text) ON COMMIT DROP",
      ];
      for (const sql of ddl) await a.query(sql);
      const empresa = randomUUID(), casos = { nanRec: randomUUID(), nanEst: randomUUID(), valido: randomUUID() };
      for (const [nome, contrato] of Object.entries(casos)) {
        const fech = randomUUID(), versao = randomUUID(), pag = randomUUID(), rec = randomUUID();
        await a.query("INSERT INTO fechamentos VALUES ($1, $2)", [fech, empresa]);
        await a.query("INSERT INTO contratos VALUES ($1, $2)", [contrato, fech]);
        await a.query("INSERT INTO contrato_versoes VALUES ($1, $2)", [versao, contrato]);
        await a.query("INSERT INTO pagamentos VALUES ($1, $2, 6000.00, 'PARCIAL')", [pag, versao]);
        await a.query("INSERT INTO pagamento_recebimentos VALUES ($1, $2, $3::numeric, 'CONFIRMADO')", [rec, pag, nome === "nanRec" ? "NaN" : "2000.00"]);
        await a.query("INSERT INTO pagamento_estornos VALUES ($1, $2, $3::numeric, 'CONFIRMADO')", [randomUUID(), rec, nome === "nanEst" ? "NaN" : "500.00"]);
      }
      const linhas = (await a.query(FINANCEIRO_SQL, [Object.values(casos), empresa])).rows;
      const de = (c: string) => financeiroDaLinha("ASSINADO", "VIGENTE_FLUXO", linhas.filter((l) => l.contrato_id === c));
      assert.deepEqual(de(casos.nanRec), { tipo: "CONFERIR" }, "NaN no recebimento");
      assert.deepEqual(de(casos.nanEst), { tipo: "CONFERIR" }, "NaN no estorno");
      assert.deepEqual(de(casos.valido), { tipo: "OK", recebido: "150000", aCobrar: "450000", obrigacao: "600000", encerrada: false });
      await a.query("ROLLBACK");
    });

    await t.test("contratos reais: números = leitura do contrato; isolamento; busca; cursor; volume", async () => {
      await instalar055(a); await instalar061(a); await instalar062(a);
      process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
      const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
      const { coreNativo } = carregar<typeof import("../integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
      const lista = carregar<ListaMod>("lib/contratos/services/lista-contratos.ts");
      const fin = carregar<FinMod>("lib/pagamentos/repositories/alteracao-financeira.repository.ts");
      await a.query("BEGIN");
      const A = await cenario(a), B = await cenario(a);
      const criar = async (c: typeof A, dias: number) => { const ev = { data: dia(dias), inicio: "14:00", fim: "18:00" }; const imp = await importacao(a, c, ev); return (await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()))).contratoId as string; };
      const a1 = await criar(A, 40), a2 = await criar(A, 80), b1 = await criar(B, 50);
      await validarAgora(a);
      const tx = executor(a), hoje = dia(0), semBusca = { texto: null, data: null };
      const todasA = await lista.listarContratosPaginados(tx, A.empresa, { filtro: "todas", busca: semBusca, cursor: null, hoje });
      assert.deepEqual(todasA.itens.map((i) => i.id).sort(), [a1, a2].sort(), "só contratos da empresa A");
      assert.equal(todasA.contagens.todas, 2); assert.equal(todasA.contagens.proximas, 2);
      for (const item of todasA.itens) {
        const p = await fin.lerPosicaoFinanceira(tx, item.id);
        assert.equal(item.financeiro.tipo, "OK", item.id);
        if (item.financeiro.tipo !== "OK") continue;
        assert.deepEqual({ recebido: item.financeiro.recebido, aCobrar: item.financeiro.aCobrar, obrigacao: item.financeiro.obrigacao, encerrada: item.financeiro.encerrada },
          { recebido: p.posicao.liquido.toString(), aCobrar: p.cobranca.saldoACobrar.toString(), obrigacao: p.posicao.obrigacao.toString(), encerrada: p.cobranca.encerrada }, "paridade com a leitura do contrato");
        assert.equal(item.referencia.origem, "VIGENTE_FLUXO");
      }
      const todasB = await lista.listarContratosPaginados(tx, B.empresa, { filtro: "todas", busca: semBusca, cursor: null, hoje });
      assert.deepEqual(todasB.itens.map((i) => i.id), [b1]);
      // Busca e cursor (limite 1): páginas sem repetição nem perda, na ordem "próximas" (data crescente).
      assert.equal((await lista.listarContratosPaginados(tx, A.empresa, { filtro: "todas", busca: lista.interpretarBusca("cliente 061"), cursor: null, hoje })).itens.length, 2);
      assert.equal((await lista.listarContratosPaginados(tx, A.empresa, { filtro: "todas", busca: lista.interpretarBusca("zzz"), cursor: null, hoje })).itens.length, 0);
      assert.deepEqual((await lista.listarContratosPaginados(tx, A.empresa, { filtro: "todas", busca: lista.interpretarBusca(dia(40).split("-").reverse().join("/")), cursor: null, hoje })).itens.map((i) => i.id), [a1]);
      const p1 = await lista.listarContratosPaginados(tx, A.empresa, { filtro: "proximas", busca: semBusca, cursor: null, hoje, limite: 1 });
      const p2 = await lista.listarContratosPaginados(tx, A.empresa, { filtro: "proximas", busca: semBusca, cursor: decodificarCursor(p1.proximoCursor, "proximas"), hoje, limite: 1 });
      assert.deepEqual([...p1.itens, ...p2.itens].map((i) => i.id), [a1, a2]); assert.equal(p2.proximoCursor, null);

      // Volume: superusuário do cluster descartável liga o modo réplica só nesta transação (gatilhos e FKs fora) para clonar.
      const superuser = (await a.query<{ s: boolean }>("SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user")).rows[0].s;
      if (!superuser) { t.diagnostic("volume pulado: papel do cluster sem superusuário"); await a.query("ROLLBACK"); return; }
      const copias = 2500;
      await clonarContratos(a, [a1, a2], copias, { A: { empresa: A.empresa, pacote: A.pacote }, B: { empresa: B.empresa, pacote: B.pacote } });
      await a.query("ANALYZE contratos; ANALYZE fechamentos; ANALYZE contrato_versoes; ANALYZE contrato_fluxos; ANALYZE contrato_edicoes; ANALYZE pagamentos; ANALYZE pagamento_recebimentos");
      // Casos de borda sobre clones da empresa A (modo réplica só para montar o caso):
      //  L-1: referência sem edição em contrato aguardando assinatura continua nos filtros ativos;
      //  L-2: contrato sem pagamento vira "Conferir"; vários movimentos: lista = leitura do contrato.
      await a.query("SET LOCAL session_replication_role = replica");
      const alvos = (await a.query<{ id: string }>(`SELECT c.id FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id
          WHERE f.empresa_id = $1::uuid AND c.id <> ALL($2::uuid[]) ORDER BY c.id LIMIT 3`, [A.empresa, [a1, a2]])).rows.map((r) => r.id);
      await a.query("DELETE FROM contrato_edicoes WHERE contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id = $1::uuid)", [alvos[0]]);
      await a.query("UPDATE contratos SET status = 'AGUARDANDO_ASSINATURA' WHERE id = $1::uuid", [alvos[0]]);
      const pagamentosDe = "SELECT p.id FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1::uuid";
      await a.query(`DELETE FROM pagamento_recebimentos WHERE pagamento_id IN (${pagamentosDe})`, [alvos[1]]);
      await a.query(`DELETE FROM pagamentos WHERE id IN (${pagamentosDe})`, [alvos[1]]);
      await duplicarLinha(a, "pagamento_recebimentos", `pagamento_id IN (${pagamentosDe})`, [alvos[2]]);
      await a.query("SET LOCAL session_replication_role = origin");
      const aguardando = await lista.listarContratosPaginados(tx, A.empresa, { filtro: "aguardando", busca: semBusca, cursor: null, hoje });
      assert.deepEqual(aguardando.itens.map((i) => i.id), [alvos[0]], "L-1: sem edição continua visível"); assert.equal(aguardando.contagens.aguardando, 1);
      assert.equal(aguardando.contagens.todas, 2 + copias, "L-1: nenhum contrato sumiu de Todas");
      // Percurso completo de "Todas" pelo cursor: sem repetição, total = contagem.
      const vistos = new Map<string, (typeof aguardando.itens)[number]>();
      let cursor: ReturnType<typeof decodificarCursor> = null;
      do {
        const pg = await lista.listarContratosPaginados(tx, A.empresa, { filtro: "todas", busca: semBusca, cursor, hoje });
        for (const i of pg.itens) { assert.ok(!vistos.has(i.id), `repetido: ${i.id}`); vistos.set(i.id, i); }
        cursor = decodificarCursor(pg.proximoCursor, "todas");
      } while (cursor);
      assert.equal(vistos.size, 2 + copias);
      assert.deepEqual(vistos.get(alvos[1])!.financeiro, { tipo: "CONFERIR" }, "L-2: sem pagamento");
      const dois = vistos.get(alvos[2])!.financeiro, p2pos = await fin.lerPosicaoFinanceira(tx, alvos[2]);
      assert.equal(dois.tipo, "OK");
      if (dois.tipo === "OK") assert.deepEqual({ recebido: dois.recebido, aCobrar: dois.aCobrar }, { recebido: p2pos.posicao.liquido.toString(), aCobrar: p2pos.cobranca.saldoACobrar.toString() }, "dois recebimentos");
      const consultas: Array<{ sql: string; params: unknown[] }> = [];
      const gravando = { query: async (sql: string, params: unknown[] = []) => { consultas.push({ sql, params }); return tx.query(sql, params); } };
      const tempos: Record<string, number> = {};
      for (const filtro of ["todas", "proximas"] as const) {
        const ini = performance.now();
        const pagina = await lista.listarContratosPaginados(gravando as never, A.empresa, { filtro, busca: semBusca, cursor: null, hoje });
        tempos[filtro] = Math.round(performance.now() - ini);
        assert.equal(pagina.itens.length, 50); assert.ok(pagina.proximoCursor);
        assert.equal(pagina.contagens.todas, 2 + copias, "cópias ímpares (2 contratos cada) ficam na empresa A");
        assert.ok(pagina.itens.every((i) => i.id === alvos[1] || i.financeiro.tipo === "OK"), "clones com pagamento parcial (exceto o montado sem pagamento)");
      }
      const planos: string[] = [];
      for (const c of consultas.slice(0, 3)) planos.push((await a.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${c.sql}`, c.params)).rows.map((r) => r["QUERY PLAN"]).join("\n"));
      const rel = process.env.KIDMAIS_RELATORIOS_LISTA ?? "D:/glass/KidMais Manager/ambientes-locais/pg-descartavel-contratos-lista-20261025-relatorios";
      try { mkdirSync(rel, { recursive: true }); writeFileSync(`${rel}/lista-volume.txt`, `contratos por empresa: ${2 + copias} (A) e ${1 + copias} (B)\ntempos (ms): ${JSON.stringify(tempos)}\n\n${planos.join("\n\n----\n\n")}\n`); } catch { /* relatório é opcional */ }
      t.diagnostic(`volume: ${JSON.stringify(tempos)} ms (contagens + página + financeiro)`);
      for (const [f, ms] of Object.entries(tempos)) assert.ok(ms < 3000, `${f}: ${ms} ms`);
      await a.query("ROLLBACK");
    });
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(a);
  }
});

/** Duplica uma linha (novo id; colunas de texto únicas com sufixo). Usar só em modo réplica, dentro da transação do teste. */
async function duplicarLinha(db: Client, tabela: string, onde: string, params: unknown[]) {
  const colunas = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' AND identity_generation IS NULL ORDER BY ordinal_position`, [tabela])).rows.map((r) => r.c);
  const unicas = (await db.query<{ c: string }>(`SELECT DISTINCT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)`, [tabela])).rows.map((r) => r.c);
  const sobrepor = ["'id', gen_random_uuid()", ...unicas.map((u) => `'${u}', s.${u} || '-dup'`)].join(", ");
  await db.query(`INSERT INTO ${tabela} (${colunas.map((c) => `"${c}"`).join(", ")})
    SELECT ${colunas.map((c) => `r."${c}"`).join(", ")} FROM (SELECT (jsonb_populate_record(NULL::${tabela}, to_jsonb(s) || jsonb_build_object(${sobrepor}))).*
      FROM ${tabela} s WHERE ${onde} LIMIT 1) r`, params);
}

/**
 * Clona o grafo (fechamento → contrato → versões → edições → fluxo → pagamento → recebimentos) dos contratos-semente.
 * Cópias pares vão para a empresa B (com o pacote de B), ímpares ficam na A. Colunas de texto únicas recebem sufixo.
 */
async function clonarContratos(db: Client, sementes: string[], copias: number, empresas: { A: { empresa: string; pacote: string }; B: { empresa: string; pacote: string } }) {
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query(`CREATE TEMP TABLE mapa ON COMMIT DROP AS
    WITH origem AS (
      SELECT c.id FROM contratos c WHERE c.id = ANY($1::uuid[])
      UNION SELECT c.fechamento_id FROM contratos c WHERE c.id = ANY($1::uuid[])
      UNION SELECT v.id FROM contrato_versoes v WHERE v.contrato_id = ANY($1::uuid[])
      UNION SELECT p.id FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = ANY($1::uuid[])
      UNION SELECT r.id FROM pagamento_recebimentos r JOIN pagamentos p ON p.id = r.pagamento_id JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = ANY($1::uuid[]))
    SELECT k, o.id AS velho, gen_random_uuid() AS novo FROM generate_series(1, $2::int) k CROSS JOIN origem o`, [sementes, copias]);
  await db.query("CREATE INDEX ON mapa (velho, k)");
  const tabelas: Array<{ nome: string; chave: string; onde: string; extra?: string }> = [
    { nome: "fechamentos", chave: "id", onde: "s.id IN (SELECT fechamento_id FROM contratos WHERE id = ANY($1::uuid[]))",
      extra: `, 'empresa_id', CASE WHEN m.k % 2 = 0 THEN $2::uuid ELSE s.empresa_id END, 'pacote_id', CASE WHEN m.k % 2 = 0 THEN $3::uuid ELSE s.pacote_id END` },
    { nome: "contratos", chave: "id", onde: "s.id = ANY($1::uuid[])" },
    { nome: "contrato_versoes", chave: "id", onde: "s.contrato_id = ANY($1::uuid[])" },
    { nome: "contrato_edicoes", chave: "contrato_versao_id", onde: "s.contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id = ANY($1::uuid[]))" },
    { nome: "contrato_fluxos", chave: "contrato_id", onde: "s.contrato_id = ANY($1::uuid[])" },
    { nome: "pagamentos", chave: "id", onde: "s.contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id = ANY($1::uuid[]))" },
    { nome: "pagamento_recebimentos", chave: "id", onde: "s.pagamento_id IN (SELECT p.id FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = ANY($1::uuid[]))" },
  ];
  for (const tab of tabelas) {
    const colunas = (await db.query<{ c: string; tipo: string }>(`SELECT column_name AS c, data_type AS tipo FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' AND identity_generation IS NULL ORDER BY ordinal_position`, [tab.nome])).rows;
    const unicas = (await db.query<{ c: string }>(`SELECT DISTINCT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)`, [tab.nome])).rows.map((r) => r.c);
    const nomes = colunas.map((c) => c.c);
    // Toda coluna uuid que aponta para um registro clonado passa a apontar para o clone da mesma cópia.
    const uuids = colunas.filter((c) => c.tipo === "uuid" && c.c !== tab.chave).map((c) => c.c);
    const sobrepor = [`'${tab.chave}', m.novo`, ...uuids.map((f) => `'${f}', COALESCE((SELECT x.novo FROM mapa x WHERE x.k = m.k AND x.velho = s.${f}), s.${f})`),
      ...unicas.filter((u) => u !== tab.chave).map((u) => `'${u}', s.${u} || '-c' || m.k`)].join(", ");
    const lista = nomes.map((n) => `"${n}"`).join(", ");
    // Tabelas cuja chave não é `id` (edições, fluxo): o próprio valor da chave está no mapa.
    await db.query(`INSERT INTO ${tab.nome} (${lista})
      SELECT ${nomes.map((n) => `r."${n}"`).join(", ")} FROM (
        SELECT (jsonb_populate_record(NULL::${tab.nome}, to_jsonb(s) || jsonb_build_object(${sobrepor}${tab.extra ?? ""}))).*
          FROM ${tab.nome} s JOIN mapa m ON m.velho = s.${tab.chave} WHERE ${tab.onde}) r`, tab.extra ? [sementes, empresas.B.empresa, empresas.B.pacote] : [sementes]);
  }
  await db.query("SET LOCAL session_replication_role = origin");
}
