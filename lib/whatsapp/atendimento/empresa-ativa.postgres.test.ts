import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";

/**
 * Empresa ativa (063 do painel) × empresa piloto do atendimento, no PostgreSQL descartável (modelo "063", que na
 * árvore mesclada já contém a 060). Só roda pelo check:v1:postgres, com opt-in e autorização explícita do Felipe.
 * Serviço REAL com o provarTenant do painel; sessões sintéticas em sessoes_administrativas; nenhuma rede.
 *
 * Com a 063 a empresa ativa precisa ser a piloto — escolhida explicitamente, ou a única ativa do usuário (regra do painel):
 *  E2 ativa = piloto → abre (lista, ações e biblioteca);
 *  E3 ativa = outra empresa (vínculo ativo nas duas) → ATENDIMENTO_EMPRESA_DIVERGENTE, sem ler nem gravar;
 *  E4 ativa = nula com MAIS de uma empresa ativa (seleção pendente) → ATENDIMENTO_EMPRESA_NAO_SELECIONADA, sem ler para
 *     a tela nem gravar; E4b nula com UMA única empresa ativa (a piloto) → abre, como no painel;
 *  E5 sessão trocada/revogada depois do carregamento → recusada (ATENDIMENTO_SEM_ACESSO), sem dados;
 *  E6 sem vínculo ativo na piloto (só outra empresa, ou PENDENTE) com a piloto "ativa" → ATENDIMENTO_SEM_ACESSO;
 *  E7 recepção e worker não usam sessão: seguem gravando na piloto com a 063 aplicada.
 *  Configurar é recusado pelo ACESSO mesmo com configuração inválida (o acesso é conferido antes do conteúdo).
 * Sem a 063 (campo ausente) o comportamento anterior é coberto pelas suítes 060/064/065 no modelo "atual".
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP064 = ler("database/migrations/20261004_064_whatsapp_mensagens_prontas.sql");
const POST064 = ler("database/checks/20261004_064_postcheck.sql");
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

type Sessao = SessaoParaTenant & { id: string; empresa_ativa_id: string | null };
function fixtures(c: Client) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  const empresa = async (nome: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("ea"), nome]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    return e;
  };
  /** Vínculos por empresa: `true` = ATIVA, `false` = fica PENDENTE (transição válida da 045). */
  const usuario = async (papel: string, vinculos: Record<string, boolean>) => {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness empresa ativa', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
    for (const [empresaId, ativo] of Object.entries(vinculos)) {
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
      if (ativo) await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    }
    return { usuario_id: u, papel };
  };
  /** Sessão como o consultarSessao do painel a devolve com a 063: id + empresa_ativa_id (texto ou nulo). */
  const sessao = async (u: { usuario_id: string; papel: string }, empresaAtiva: string | null): Promise<Sessao> => {
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`,
      [u.usuario_id, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), empresaAtiva]);
    return { ...u, id: s, empresa_ativa_id: empresaAtiva } as Sessao;
  };
  return { empresa, usuario, sessao };
}
const contar = async (c: Client, sql: string, v: unknown[] = []) => Number((await c.query<{ n: string }>(sql, v)).rows[0].n);

test("empresa ativa × piloto (063): seleção explícita, divergência, seleção pendente, sem acesso e recepção", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    assert.notEqual((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') AS t")).rows[0].t, null, "modelo 063 da árvore mesclada contém a 060");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sessoes_administrativas' AND column_name='empresa_ativa_id'")).rows[0].n, 1, "063 aplicada (empresa ativa na sessão)");
    await c.query(UP064); await c.query(POST064);

    const f = fixtures(c);
    const A = await f.empresa("Empresa piloto (empresa ativa)"), B = await f.empresa("Outra empresa (empresa ativa)");
    const rep = await f.usuario("REPRESENTANTE_AUTORIZADO", { [A]: true, [B]: true });
    const { servico, biblioteca } = carregarAtendimento(A);

    // E7 + preparo: recepção sem sessão grava na piloto.
    const contato = "5561900000301";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: null });
    assert.equal(await contar(c, "SELECT count(*) AS n FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND contato=$2", [A, contato]), 1, "E7: recepção grava na piloto com a 063");

    // E2: ativa = piloto.
    const naPiloto = await f.sessao(rep, A);
    const tela = await servico.listarAtendimento(naPiloto);
    const conversa = tela.conversas.find((x) => x.contato === contato)!;
    assert.ok(conversa, "E2: a piloto selecionada abre");
    await servico.salvarConfiguracao(naPiloto, { ativo: false, nome: "Empresa piloto", perguntas: [] });
    assert.ok(Array.isArray((await biblioteca.listarProntas(naPiloto)).prontas), "E2: biblioteca abre");

    const estado = async () => ({
      versao: Number((await c.query("SELECT versao FROM whatsapp_atendimento_conversas WHERE id=$1", [conversa.id])).rows[0].versao),
      saidas: await contar(c, "SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE direcao='SAIDA'"),
      auditoria: await contar(c, "SELECT count(*) AS n FROM whatsapp_atendimento_auditoria"),
    });
    const recusaTudo = async (s: Sessao, motivo: RegExp, rotulo: string) => {
      const antes = await estado();
      await assert.rejects(servico.listarAtendimento(s), motivo, `${rotulo}: lista`);
      await assert.rejects(servico.controlarAtendimento(s, { acao: "assumir", conversaId: conversa.id, versao: antes.versao }), motivo, `${rotulo}: assumir`);
      await assert.rejects(servico.salvarConfiguracao(s, { ativo: false, nome: "Configuração válida", perguntas: [] }), motivo, `${rotulo}: configurar (válida)`);
      // Configuração INVÁLIDA (nome curto): a recusa de acesso vem antes da validação do conteúdo.
      await assert.rejects(servico.salvarConfiguracao(s, { ativo: false, nome: "X", perguntas: [] }), motivo, `${rotulo}: configurar (inválida)`);
      await assert.rejects(biblioteca.listarProntas(s), motivo, `${rotulo}: biblioteca`);
      assert.deepEqual(await estado(), antes, `${rotulo}: nada lido para a tela nem gravado`);
    };

    // E3: outra empresa ativa (vínculo ativo nas duas).
    await recusaTudo(await f.sessao(rep, B), /ATENDIMENTO_EMPRESA_DIVERGENTE/, "E3");
    // E4: seleção pendente — sem escolha explícita e com MAIS de uma empresa ativa (regra do painel), mesmo com vínculo
    // ativo na piloto.
    await recusaTudo(await f.sessao(rep, null), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/, "E4");
    // E4b: sem escolha explícita e com UMA única empresa ativa (a piloto) = ela é a atual, como no painel: abre.
    const soA = await f.usuario("REPRESENTANTE_AUTORIZADO", { [A]: true });
    const unica = await f.sessao(soA, null);
    assert.ok((await servico.listarAtendimento(unica)).conversas.some((x) => x.contato === contato), "E4b: empresa única sem escolha explícita abre");
    assert.ok(Array.isArray((await biblioteca.listarProntas(unica)).prontas), "E4b: biblioteca abre");
    // E5: a sessão carregada é revogada (troca de empresa/login) → o objeto antigo não comprova mais.
    const antiga = await f.sessao(rep, A);
    await c.query("UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE id = $1::uuid", [antiga.id]);
    await recusaTudo(antiga, /ATENDIMENTO_SEM_ACESSO/, "E5");
    // E6: piloto "ativa" sem vínculo ativo nela (só outra empresa; ou vínculo PENDENTE) — fixtures obrigatórias.
    const soB = await f.usuario("REPRESENTANTE_AUTORIZADO", { [B]: true });
    await recusaTudo(await f.sessao(soB, A), /ATENDIMENTO_SEM_ACESSO/, "E6 só outra empresa");
    const pendente = await f.usuario("ADMINISTRATIVO", { [A]: false });
    await recusaTudo(await f.sessao(pendente, A), /ATENDIMENTO_SEM_ACESSO/, "E6 vínculo pendente");

    assert.equal(await contar(c, "SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE direcao='SAIDA'"), 0, "nenhuma saída");
  } finally {
    await c.end();
  }
});
