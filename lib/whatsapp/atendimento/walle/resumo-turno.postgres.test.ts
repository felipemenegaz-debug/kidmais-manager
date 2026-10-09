import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import { cod } from "../harness-postgres.ts";
import { resumoDaConversa } from "./resumo.ts";

/**
 * Revisão final (M2): o turno do RESUMO da conversa (tela da equipe) vem do mesmo escopo que o Wall-e usa com o
 * cliente: empresa e, quando a unidade tem agenda própria, a unidade; o nível mais específico vence. Antes a consulta
 * filtrava só pelo código e podia mostrar o turno de OUTRA empresa com o mesmo código. Modelo "063" (com a 062), só pelo
 * check:v1:postgres, com opt-in, no cluster descartável. Dados sintéticos.
 *
 *  T1 mesmo código em duas empresas (a outra com ordem menor, que a consulta antiga escolhia): cada uma vê o seu;
 *  T2 unidade com agenda própria e turno próprio: o da unidade vence o da empresa;
 *  T3 unidade sem agenda própria: o da empresa; sem unidade e com duas unidades agendáveis: o da empresa;
 *  T4 mesma regra do repositório da agenda (a que o Wall-e usa com o cliente): vale só o nível mais específico que
 *     existe; empresa com turnos próprios não herda o modelo global; empresa SEM turnos próprios usa o global; código
 *     só de OUTRA empresa: nenhum horário (nunca o da outra).
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261009_076_whatsapp_mensagens_prontas.sql", "database/checks/20261009_076_postcheck.sql"],
  ["database/migrations/20261009_077_whatsapp_prontas_midia.sql", "database/checks/20261009_077_postcheck.sql"],
  ["database/migrations/20261009_078_wall_e_atendimento.sql", "database/checks/20261009_078_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

test("resumo da conversa: turno pelo escopo da empresa e da unidade, nunca de outra empresa", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const ex = c as unknown as DbExecutor;
  try {
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') IS NOT NULL AS ok")).rows[0].ok, true, "modelo 063 com a 060");
    for (const [up, post] of MIGRATIONS) { await c.query(up); await c.query(post); }
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("rt"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness resumo turno', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { e, u };
    }
    const A = await empresa("Buffet sintético (resumo turno)");
    const B = await empresa("Outra empresa sintética (resumo turno)");
    const C = await empresa("Empresa sintética sem turnos próprios (resumo turno)");
    const unidade = async (nome: string, agendavel: boolean) => {
      const u = await id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1, $2, $3, 'SUSPENSO') RETURNING id`, [A.e, cod("un-").toLowerCase(), nome]);
      if (agendavel) await c.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', 'Abertura da unidade (harness)')`, [A.e, u, A.u]);
      return u;
    };
    const comTurno = await unidade("Asa Sul (sintética)", true), semTurno = await unidade("Águas Claras (sintética)", true), naoAgendavel = await unidade("Taguatinga (sintética)", false);
    const codigo = cod("T_M2_").toUpperCase(), soGlobal = cod("T_GL_").toUpperCase(), soDaOutra = cod("T_OU_").toUpperCase();
    const turno = (cd: string, nome: string, ini: string, fim: string, ordem: number, empresaId: string | null, unidadeId: string | null) =>
      c.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id, estabelecimento_id) VALUES ($1, $2, $3::time, $4::time, $5, $6, $7)`, [cd, nome, ini, fim, ordem, empresaId, unidadeId]);
    // B com ordem MENOR: a consulta antiga (só código, ORDER BY ordem_exibicao LIMIT 1) mostraria o turno de B na tela de A.
    await turno(codigo, "Turno de B", "08:00", "12:00", 1, B.e, null);
    await turno(codigo, "Turno de A", "18:00", "22:00", 7, A.e, null);
    await turno(codigo, "Turno da unidade Asa Sul", "19:00", "23:30", 7, A.e, comTurno);
    await turno(soGlobal, "Turno modelo global", "14:00", "18:00", 8, null, null);
    await turno(soDaOutra, "Turno exclusivo de B", "09:00", "13:00", 1, B.e, null);

    const conversa = async (empresaId: string, contexto: Record<string, unknown>) => id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, ultima_entrada_em, contexto) VALUES ($1, 'staging', $2, clock_timestamp(), $3::jsonb) RETURNING id`,
      [empresaId, `55619${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, JSON.stringify(contexto)]);
    const horario = async (empresaId: string, contexto: Record<string, unknown>) => (await resumoDaConversa(ex, empresaId, "staging", await conversa(empresaId, contexto)))?.horario ?? null;

    // T1 — mesmo código, empresas diferentes.
    assert.equal(await horario(A.e, { turno: codigo }), "Turno de A (18h às 22h)", "T1: A vê o turno de A (sem unidade, duas unidades agendáveis ⇒ empresa)");
    assert.equal(await horario(B.e, { turno: codigo }), "Turno de B (8h às 12h)", "T1: B vê o turno de B");
    // T2 — unidade com turno próprio vence.
    assert.equal(await horario(A.e, { turno: codigo, unidade: comTurno }), "Turno da unidade Asa Sul (19h às 23h30)", "T2: o da unidade vence");
    // T3 — unidade sem turno próprio, ou não agendável: o da empresa.
    assert.equal(await horario(A.e, { turno: codigo, unidade: semTurno }), "Turno de A (18h às 22h)", "T3: unidade sem turno próprio");
    assert.equal(await horario(A.e, { turno: codigo, unidade: naoAgendavel }), "Turno de A (18h às 22h)", "T3: unidade sem agenda própria");
    // T4 — nível mais específico vence (como na consulta de disponibilidade do Wall-e); outra empresa nunca aparece.
    assert.equal(await horario(A.e, { turno: soGlobal }), null, "T4: A tem turnos próprios: o modelo global não vale para A");
    assert.equal(await horario(C.e, { turno: soGlobal }), "Turno modelo global (14h às 18h)", "T4: empresa sem turnos próprios usa o modelo global");
    assert.equal(await horario(C.e, { turno: codigo }), null, "T4: o código de A/B não vale para C");
    assert.equal(await horario(A.e, { turno: soDaOutra }), null, "T4: turno exclusivo de outra empresa não aparece");
    // Conversa de outra empresa não é lida pela empresa A.
    assert.equal(await resumoDaConversa(ex, A.e, "staging", await conversa(B.e, { turno: codigo })), null, "conversa de B invisível para A");
  } finally {
    await c.end();
  }
});
