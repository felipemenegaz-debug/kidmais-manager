import test from "node:test";
import assert from "node:assert/strict";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import { criarBloqueioAgenda } from "../../../disponibilidade/repositories/disponibilidade.repository.ts";
import { cod } from "../harness-postgres.ts";
import { entenderPorRegras } from "./entendimento.ts";
import { catalogosWallE, fontesPostgres } from "./fontes-postgres.ts";
import { resolverWallE } from "./resolver.ts";

/**
 * Escopo REAL da agenda consultada pelo Wall-e, com a 062 instalada (modelo "063"; só pelo check:v1:postgres, com opt-in,
 * no cluster descartável). Dados sintéticos. A resposta nunca atribui à unidade o que veio de outra agenda:
 *  E1 unidade COM agenda própria (habilitada) → escopo UNIDADE, bloqueio da unidade vale;
 *  E2 unidade SEM agenda própria → escopo EMPRESA (todas as unidades), dito assim na resposta, sem "na unidade X";
 *  E3 sem unidade pedida e uma única unidade com agenda → essa unidade, nomeada;
 *  E4 bloqueio de OUTRA empresa não aparece (isolamento).
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const somarDias = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const br = (iso: string) => iso.split("-").reverse().join("/");

test("Wall-e: disponibilidade informa o escopo real da agenda (unidade, empresa) e isola empresas", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const ex = c as unknown as DbExecutor;
  try {
    assert.equal((await c.query("SELECT to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS ok")).rows[0].ok, true, "modelo com a 062");
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("ag"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness agenda Wall-e', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { e, u };
    }
    const A = await empresa("Buffet sintético (escopo da agenda)");
    const B = await empresa("Outra empresa sintética (isolamento)");
    const unidade = (nome: string) => id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1, $2, $3, 'SUSPENSO') RETURNING id`, [A.e, cod("un-").toLowerCase(), nome]);
    const comAgenda = await unidade("Asa Sul (sintética)"), semAgenda = await unidade("Águas Claras (sintética)");
    await c.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', 'Abertura da unidade (harness)')`, [A.e, comAgenda, A.u]);
    const dUnidade = somarDias(hoje, 41), dOutra = somarDias(hoje, 43);
    await c.query("BEGIN");
    await criarBloqueioAgenda({ data: dUnidade, diaInteiro: true, motivo: "Festa sintética da unidade", usuarioId: A.u, empresaId: A.e, estabelecimentoId: comAgenda }, ex);
    await criarBloqueioAgenda({ data: dOutra, diaInteiro: true, motivo: "Festa sintética de outra empresa", usuarioId: B.u, empresaId: B.e }, ex);
    await c.query("COMMIT");

    const fontes = fontesPostgres(ex, { empresaId: A.e, ambiente: "staging", hoje, linkContratoProprio: async () => null });
    const ocupado = (r: Awaited<ReturnType<typeof fontes.disponibilidade>>) => r.periodos.every((p) => !p.disponivel);
    // E1 — unidade com agenda própria.
    const e1 = await fontes.disponibilidade(dUnidade, comAgenda);
    assert.deepEqual(e1.escopo, { tipo: "UNIDADE", unidadeId: comAgenda });
    assert.ok(ocupado(e1), "E1: o bloqueio da unidade vale");
    // E2 — unidade sem agenda própria: empresa inteira (inclui a outra unidade: conservador), nunca "da unidade".
    const e2 = await fontes.disponibilidade(dUnidade, semAgenda);
    assert.deepEqual(e2.escopo, { tipo: "EMPRESA" });
    assert.ok(ocupado(e2), "E2: a agenda da empresa enxerga as ocupações de todas as unidades");
    // E3 — sem unidade pedida e uma única unidade com agenda.
    assert.deepEqual((await fontes.disponibilidade(dUnidade, null)).escopo, { tipo: "UNIDADE", unidadeId: comAgenda });
    // E4 — bloqueio de outra empresa não aparece.
    assert.ok((await fontes.disponibilidade(dOutra, comAgenda)).periodos.some((p) => p.disponivel), "E4: isolamento entre empresas");
    assert.ok((await fontes.disponibilidade(dOutra, semAgenda)).periodos.some((p) => p.disponivel));

    // Ponta a ponta no resolvedor: a resposta diz o escopo e a fonte registra o que foi consultado.
    const config = { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 20 } };
    const catalogos = await catalogosWallE(ex, A.e, config, hoje);
    assert.deepEqual(catalogos.unidadesAgenda, [comAgenda]);
    const responder = async (unidadeEscolhida: string) => {
      const texto = `tem vaga dia ${br(dUnidade)}?`;
      return resolverWallE({ texto, entendimento: entenderPorRegras(texto, catalogos, {}), contexto: { unidade: unidadeEscolhida }, config, catalogos, agora: new Date().toISOString() }, fontes);
    };
    const r2 = await responder(semAgenda);
    const t2 = r2.saidas.map((s) => s.texto ?? "").join("\n");
    assert.doesNotMatch(t2, /na unidade Águas Claras/, "E2: nada é atribuído à unidade sem agenda própria");
    assert.match(t2, /A agenda ainda não é separada por unidade: a consulta abaixo vale para todas as unidades da empresa, não só para a unidade Águas Claras/);
    assert.ok(r2.saidas.flatMap((s) => s.fontes).some((f) => f.tipo === "AGENDA" && f.escopo === "EMPRESA" && f.unidade === null));
    const r1 = await responder(comAgenda);
    const t1 = r1.saidas.map((s) => s.texto ?? "").join("\n");
    assert.match(t1, /na unidade Asa Sul/);
    assert.doesNotMatch(t1, /não é separada por unidade/);
    assert.ok(r1.saidas.flatMap((s) => s.fontes).some((f) => f.tipo === "AGENDA" && f.escopo === "UNIDADE" && f.unidade === comAgenda));
  } finally {
    await c.end();
  }
});
