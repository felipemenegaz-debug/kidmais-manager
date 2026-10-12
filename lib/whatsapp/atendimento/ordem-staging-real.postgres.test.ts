import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Ordem de aplicação (11/10/2026; premissa corrigida em 12/10). PREMISSA, não fato verificado: o banco de staging teria
 * 061…079 (076–078 com evidência datada; a 079 sem evidência datada de aplicação neste repositório; o estado real só por
 * um E2a novo). As do atendimento (060, 065, 080, 081, 082) entrariam DEPOIS delas, embora 060 e 065 tenham número
 * menor: estarem livres não prova que funcionem num banco que já tem migrations posteriores. Esta suíte prova:
 *
 *  R0 base = modelo "079-sem-atendimento" (inventário inteiro até a 079, sem 060/065): nenhum objeto do atendimento;
 *  R1 ordem do staging real: 060 → 065 → 080 → 081 → 082, cada uma com o postcheck oficial; o schema FORA do atendimento
 *     e os dados de todas as outras tabelas ficam idênticos;
 *  R2 o schema final é idêntico (catálogo inteiro, sem depender de OID ou ordem de colunas) ao do modelo "082", montado na
 *     ordem do inventário (060 antes da 061, 065 antes da 064, 080–082 depois da 079);
 *  R3 dados sintéticos do atendimento (serviço real, transporte simulado) e do catálogo por empresa (078);
 *  R4 downs do staging com o atendimento presente: a 078 recusa com catálogo de outra empresa (nada muda dos dois lados);
 *     sem esse dado, 079 e 078 saem e voltam (pré e postchecks) sem tocar no atendimento, com os mesmos objetos;
 *  R5 rollback do atendimento na ordem 082 → 081 → 080 → 065 → 060, com as decisões explícitas: depois de CADA down o
 *     schema fora do atendimento e os dados das outras tabelas ficam idênticos; no fim, o schema é exatamente o da base;
 *  R6 a outra ordem: no banco montado pelo inventário ("082"), o mesmo rollback devolve exatamente o schema da base.
 *
 * PostgreSQL descartável, só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede.
 */
import { A060, A065, A080, A081, A082, S078, S079, ROLLBACK, atendimento, dadosFora, schema, tabelasAtendimento, type Q } from "./migracoes-atendimento-teste.ts";
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

test("ordem de aplicação do staging real (061…079 antes de 060/065/080–082): mesmo schema da ordem do inventário; rollback nas duas ordens preserva 076–079", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const inv = await conectarDescartavel({ database: "kidmais_pacotes_v1_rollback", travar: false });
  const q: Q = (sql, v = []) => c.query(sql, v);
  const qi: Q = (sql, v = []) => inv.query(sql, v);
  try {
    // R0 — base do staging real.
    assert.deepEqual(await tabelasAtendimento(q), [], "R0: a base não tem tabela do atendimento");
    for (const tb of ["buffet_categorias", "buffet_itens"]) {
      assert.equal((await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='empresa_id'`, [tb])).rows[0].n, 1, `R0: 078 presente (${tb}.empresa_id)`);
    }
    assert.equal((await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_evidencia'`)).rows[0].n, 1, "R0: 079 presente");
    await assert.doesNotReject(q(S078.post), "R0: postcheck 078");
    await assert.doesNotReject(q(S079.post), "R0: postcheck 079");
    const baseCompleta = await schema(q);
    const baseFora = await schema(q, true);
    const dadosBase = await dadosFora(q);

    // R1 — 060 → 065 → 080 → 081 → 082 depois da 079.
    for (const [n, m] of [["060", A060], ["065", A065], ["080", A080], ["081", A081], ["082", A082]] as const) {
      await assert.doesNotReject(q(m.up), `R1: ${n} aplica depois da 079`);
      await assert.doesNotReject(q(m.post), `R1: postcheck ${n}`);
      assert.deepEqual(await schema(q, true), baseFora, `R1: ${n} não altera o schema fora do atendimento`);
      assert.deepEqual(await dadosFora(q), dadosBase, `R1: ${n} não altera dados fora do atendimento`);
    }
    await assert.doesNotReject(q(S078.post), "R1: postcheck 078 com o atendimento");
    await assert.doesNotReject(q(S079.post), "R1: postcheck 079 com o atendimento");

    // R2 — mesmo schema da ordem do inventário (modelo "082", no banco de rollback).
    const ordemStaging = await schema(q);
    const ordemInventario = await schema(qi);
    assert.deepEqual(ordemStaging, ordemInventario, "R2: schema idêntico nas duas ordens de aplicação");
    assert.ok(ordemStaging.length > baseCompleta.length, "R2: o atendimento acrescentou objetos");

    // R3 — dados sintéticos do atendimento e do catálogo por empresa.
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const empresa = async (rotulo: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("or"), `Empresa sintética ${rotulo} (ordem)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("A");
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness ordem', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A } as never;
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Empresa sintética", perguntas: [] });
    const contato = "5561900000801";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil sintético ordem" });
    const conversa = async () => (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    let cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    const foto = (await biblioteca.salvarPronta(sessao, { titulo: "Foto sintética ordem", categoria: "Teste", tipo: "IMAGEM", texto: "Legenda", link: null, atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/ordem.jpg" })).id;
    const vista = (await biblioteca.prepararRascunho(sessao, { conversaId: cv.id, id: foto })).midia!;
    cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: foto, prontaVersao: vista.versao, texto: "Legenda revisada" });
    const envios: ConteudoSaida[] = [];
    await worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } }, { maxTarefas: 10 });
    assert.equal(envios.length, 1, "R3: a saída com mídia sai pelo transporte simulado");
    const categoriaA = await id(`INSERT INTO buffet_categorias (empresa_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2, 'Categoria sintética A', 1, true) RETURNING id`, [A, cod("CAT_")]);
    const atendimentoR3 = await atendimento(q);
    assert.ok(atendimentoR3.tabelas.length >= 8, `R3: tabelas do atendimento (${atendimentoR3.tabelas.join(", ")})`);

    // R4 — downs do staging com o atendimento presente.
    const dadosR3 = await dadosFora(q);
    await assert.rejects(q(S078.down), /078 rollback: há catálogo de mais de uma empresa/, "R4: down da 078 recusado com catálogo de outra empresa");
    await q("ROLLBACK").catch(() => {});
    assert.deepEqual(await dadosFora(q), dadosR3, "R4: recusa da 078 não muda dados");
    assert.deepEqual(await atendimento(q), atendimentoR3, "R4: recusa da 078 não toca o atendimento");
    await q(`DELETE FROM buffet_categorias WHERE id = $1::uuid`, [categoriaA]);
    const foraAntes = await schema(q, true);
    await q(S079.down);
    assert.deepEqual(await atendimento(q), atendimentoR3, "R4: down da 079 não toca o atendimento");
    await q(S078.down);
    assert.deepEqual(await atendimento(q), atendimentoR3, "R4: down da 078 não toca o atendimento");
    for (const sm of [S078, S079]) { await q(sm.pre); await q(sm.up); await q(sm.post); }
    assert.deepEqual(await schema(q, true), foraAntes, "R4: 078 e 079 reaplicadas com os mesmos objetos");
    assert.deepEqual(await atendimento(q), atendimentoR3, "R4: reaplicar 078/079 não toca o atendimento");
    for (const [n, mm] of [["060", A060], ["065", A065], ["080", A080], ["081", A081], ["082", A082]] as const) await assert.doesNotReject(q(mm.post), `R4: postcheck ${n}`);

    // R5 — rollback do atendimento na ordem do staging real.
    const foraR5 = await schema(q, true);
    const dadosR5 = await dadosFora(q);
    for (const passo of ROLLBACK) {
      await passo.run(q);
      assert.deepEqual(await schema(q, true), foraR5, `R5: down da ${passo.n} preserva o schema fora do atendimento`);
      assert.deepEqual(await dadosFora(q), dadosR5, `R5: down da ${passo.n} preserva os dados fora do atendimento`);
      await assert.doesNotReject(q(S078.post), `R5: postcheck 078 sem ${passo.n}`);
    }
    assert.deepEqual(await tabelasAtendimento(q), [], "R5: nenhuma tabela do atendimento sobra");
    assert.deepEqual(await schema(q), baseCompleta, "R5: schema final idêntico à base (staging real)");
    assert.equal(envios.length, 1, "nenhum reenvio em todo o roteiro");

    // R6 — a outra ordem: rollback no banco montado pelo inventário devolve o mesmo schema da base.
    for (const passo of ROLLBACK) await passo.run(qi);
    assert.deepEqual(await tabelasAtendimento(qi), [], "R6: nenhuma tabela do atendimento sobra");
    assert.deepEqual(await schema(qi), baseCompleta, "R6: rollback na ordem do inventário volta ao schema do staging real");
  } finally {
    await c.end();
    await inv.end();
  }
});
