import test from "node:test";
import assert from "node:assert/strict";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { A065, A080, A081, A082, ROLLBACK, dadosFora, schema, tabelasAtendimento, type Q } from "./migracoes-atendimento-teste.ts";

/**
 * Estado misto (revisão de 8b2c55d, item M5; 12/10/2026): a 060 já aplicada no banco ANTES de 061…079 (como na ordem do
 * inventário) e a 065 ausente. Não se sabe se é o caso do banco de staging (só um E2a novo diz); esta suíte prova que,
 * se for:
 *  M1 base = modelo "079-sem-065": 060 presente, 061…079 por cima, 065/080–082 ausentes;
 *  M2 065 → 080 → 081 → 082 aplicam com os postchecks oficiais; schema e dados fora do atendimento ficam idênticos;
 *  M3 o schema final é idêntico ao da ordem do inventário (modelo "082", no banco de rollback);
 *  M4 o rollback 082 → 081 → 080 → 065 preserva o schema e os dados fora do atendimento e volta exatamente à base;
 *     o down da 060 (último passo) também roda e deixa só o schema do staging.
 * PostgreSQL descartável, só pelo check:v1:postgres com opt-in. Sem dados pessoais.
 */
test("estado misto: 060 aplicada antes de 061…079 e 065 ausente — aplicação, mesmo schema da ordem do inventário e rollback", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const inv = await conectarDescartavel({ database: "kidmais_pacotes_v1_rollback", travar: false });
  const q: Q = (sql, v = []) => c.query(sql, v);
  const qi: Q = (sql, v = []) => inv.query(sql, v);
  try {
    // M1 — base.
    assert.deepEqual((await tabelasAtendimento(q)).length > 0, true, "M1: a 060 está aplicada");
    assert.equal((await q("SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='public.whatsapp_atendimento_conversas'::regclass AND attname='nome_perfil' AND NOT attisdropped")).rows[0].n, 0, "M1: a 065 está ausente");
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL AS ausente")).rows[0].ausente, true, "M1: 080 ausente");
    assert.equal((await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_evidencia'")).rows[0].n, 1, "M1: 079 presente");
    const base = await schema(q);
    const baseFora = await schema(q, true);
    const dadosBase = await dadosFora(q);
    // M2 — o que falta, depois de tudo.
    for (const [n, m] of [["065", A065], ["080", A080], ["081", A081], ["082", A082]] as const) {
      await assert.doesNotReject(q(m.up), `M2: ${n} aplica no estado misto`);
      await assert.doesNotReject(q(m.post), `M2: postcheck ${n}`);
      assert.deepEqual(await schema(q, true), baseFora, `M2: ${n} não altera o schema fora do atendimento`);
      assert.deepEqual(await dadosFora(q), dadosBase, `M2: ${n} não altera dados fora do atendimento`);
    }
    // M3 — mesmo schema da ordem do inventário.
    assert.deepEqual(await schema(q), await schema(qi), "M3: schema idêntico ao da ordem do inventário");
    // M4 — rollback até a 065 volta exatamente à base; o da 060 deixa só o staging.
    for (const passo of ROLLBACK) {
      await passo.run(q);
      assert.deepEqual(await schema(q, true), baseFora, `M4: down da ${passo.n} preserva o schema fora do atendimento`);
      assert.deepEqual(await dadosFora(q), dadosBase, `M4: down da ${passo.n} preserva os dados fora do atendimento`);
      if (passo.n === "065") assert.deepEqual(await schema(q), base, "M4: sem 065–082 o schema é exatamente o da base (060 presente)");
    }
    assert.deepEqual(await tabelasAtendimento(q), [], "M4: o down da 060 remove o resto do atendimento");
  } finally {
    await c.end();
    await inv.end();
  }
});
