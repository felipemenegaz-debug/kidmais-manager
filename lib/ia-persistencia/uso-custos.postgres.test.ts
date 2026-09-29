import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import type { ModelUsage } from "../inteligencia/contratos.ts";
import { consolidarCustos } from "../inteligencia/custos.ts";
import { criarRegistroUsoPostgres, lerUsoAgrupado } from "./uso.ts";

/**
 * Custos V1 no PostgreSQL descartável (só pelo `check:v1:postgres`, com opt-in). Tudo numa transação que
 * termina em ROLLBACK: a 055a é instalada com o script REAL, os usos são gravados pelo registro REAL e a visão
 * consolidada é lida por `lerUsoAgrupado`. Prova: isolamento por empresa, leitura sem escrita e custo
 * desconhecido nunca somado como zero. Nada fica no banco ao final.
 */
const UP_055A = readFileSync("database/migrations/20260928_055a_inteligencia_uso.sql", "utf8");
const MES = "2026-09";

const uso = (empresaId: string, extra: Partial<ModelUsage> = {}): ModelUsage => ({
  correlationId: "harness-custos", empresaId, estabelecimentoId: null, capacidade: "copiloto_explicar", workload: "TEXTO_CURTO", tier: "ECONOMY",
  provedor: "OPENAI", modelo: "modelo-harness", tokensEntrada: 100, tokensSaida: 20, tokensCache: null, duracaoMs: 10,
  custoEstimadoMicros: 500, moeda: "USD", sucesso: true, erro: null, fallback: false, em: "2026-09-15T15:00:00Z", ...extra,
} as ModelUsage);

test("custos V1 (PostgreSQL): visão consolidada isolada por empresa, somente leitura, desconhecido nunca vira zero", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  try {
    await db.query("BEGIN");
    const antes = await lerUsoAgrupado(db, "00000000-0000-4000-8000-000000000000", MES);
    assert.deepEqual(antes, { disponivel: false, usos: [], reservas: [] }, "sem a 055a: indisponível, nunca zero");

    await db.query(semTransacaoExplicita(UP_055A));
    const nova = async (nome: string) => {
      const id = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [`cst${randomBytes(4).toString("hex")}`, nome])).rows[0].id;
      await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
      return id;
    };
    const empresaA = await nova("Empresa custos A");
    const empresaB = await nova("Empresa custos B");

    const registro = criarRegistroUsoPostgres({ executor: () => db, transacao: (trabalho) => trabalho(db) }, () => undefined);
    await registro.registrar(uso(empresaA));
    // Custo desconhecido: a 055a exige custo e moeda juntos (ambos null).
    await registro.registrar(uso(empresaA, { custoEstimadoMicros: null, moeda: null }));
    await registro.registrar(uso(empresaA, { capacidade: "jev_classificar", modelo: "outro", custoEstimadoMicros: 200 }));
    await registro.registrar(uso(empresaB, { custoEstimadoMicros: 999_999 }));

    const escritasAntes = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ia_uso_modelo`)).rows[0].n;
    const lidoA = await lerUsoAgrupado(db, empresaA, MES);
    const lidoB = await lerUsoAgrupado(db, empresaB, MES);
    assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ia_uso_modelo`)).rows[0].n, escritasAntes, "leitura não escreve");

    assert.equal(lidoA.disponivel, true);
    assert.equal(lidoA.usos.reduce((n, u) => n + u.chamadas, 0), 3);
    assert.equal(lidoB.usos.reduce((n, u) => n + u.chamadas, 0), 1);
    assert.ok(lidoA.usos.every((u) => u.custoMicros < 999_999), "nada da empresa B aparece na A");

    const visaoA = consolidarCustos(lidoA, MES, "USD");
    assert.equal(visaoA.total.custoMicros, null, "uma chamada sem preço ⇒ total desconhecido");
    assert.equal(visaoA.total.desconhecidos, 1);
    assert.equal(visaoA.porCapacidade.jev_classificar.custoMicros, 200);
    assert.equal(visaoA.porModelo["OPENAI:modelo-harness"].custoMicros, null);
    assert.equal(consolidarCustos(lidoB, MES, "USD").total.custoMicros, 999_999);
    assert.equal(consolidarCustos(await lerUsoAgrupado(db, empresaA, "2026-08"), "2026-08", "USD").total.chamadas, 0);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    const sobrou = (await db.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_uso_modelo') IS NOT NULL AS ok`)).rows[0].ok;
    await encerrarDescartavel(db);
    assert.equal(sobrou, false, "ROLLBACK desfez a 055a e os dados do harness");
  }
});
