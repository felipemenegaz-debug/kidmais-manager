import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import { cliente, cod, empresa, vincular, SENHA_FALSA } from "./harness-postgres.ts";
import type { Client as ClientePg } from "pg";

/** Identidade sintética da suíte (senha_hash falsa: não autentica) + vínculo com a empresa. */
async function pessoa(c: ClientePg, empresaId: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO", nome = "Pessoa sintética") {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, nome, SENHA_FALSA, papel])).rows[0].id;
  return vincular(c, empresaId, usuario, papel, nome);
}

/**
 * Migrations 083 (Marketing) e 084 (automações) no PostgreSQL descartável, sobre o modelo 082. Só pelo
 * check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL (goal local de 14/10/2026). Dados sintéticos.
 *   0. ordem: 084 sem a 083 é recusada;
 *   1. 083: precheck, aplicação, postcheck, reaplicação recusada;
 *   2. 084: idem; postchecks juntos;
 *   3. rollback sem dados: 084 down e 083 down funcionam (em transação desfeita);
 *   4. gatilhos e restrições: tenant (contato, atribuição, execução, preferência), append-only, host exclusivo,
 *      provedor só SIMULADO, domínio removido terminal, campanha arquivada imutável, mensagem ativa exige revisão;
 *   5. rollback com dados: recusado (contatos e evidências não são apagados), e a 083 recusa enquanto a 084 existir.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP083 = ler("database/migrations/20261014_083_marketing_base.sql");
const PRE083 = ler("database/checks/20261014_083_precheck.sql");
const POST083 = ler("database/checks/20261014_083_postcheck.sql");
const DOWN083 = ler("database/rollback/20261014_083_marketing_base_down.sql");
const UP084 = ler("database/migrations/20261014_084_marketing_automacoes.sql");
const PRE084 = ler("database/checks/20261014_084_precheck.sql");
const POST084 = ler("database/checks/20261014_084_postcheck.sql");
const DOWN084 = ler("database/rollback/20261014_084_marketing_automacoes_down.sql");

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

test("083/084: ordem, checks, reaplicação, gatilhos de tenant e append-only, host exclusivo e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    // 0. Ordem.
    await assert.rejects(c.query(UP084), /084 exige a 083/); await c.query("ROLLBACK").catch(() => {});
    // 1. 083.
    const pre = await c.query(PRE083) as unknown as Array<{ rows: Array<Record<string, unknown>> }>;
    const linha = pre.flatMap((r) => r.rows ?? []).find((l) => "marketing_ausente" in l)!;
    assert.deepEqual(linha, { tem_empresas: true, tem_estabelecimentos: true, tem_memberships: true, clientes_tem_empresa_054: true, fechamentos_tem_unidade_062: true, marketing_ausente: true });
    await c.query(UP083); await c.query(POST083);
    await assert.rejects(c.query(UP083), /083 já aplicada/); await c.query("ROLLBACK").catch(() => {});
    // 2. 084.
    await c.query(PRE084); await c.query(UP084); await c.query(POST084); await c.query(POST083);
    await assert.rejects(c.query(UP084), /084 já aplicada/); await c.query("ROLLBACK").catch(() => {});
    // 3. Rollback sem dados (desfeito no fim para manter o schema).
    await c.query("BEGIN");
    await c.query(semTransacaoExplicita(DOWN084));
    await c.query(semTransacaoExplicita(DOWN083));
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'marketing\\_%'`)).rows[0].n, 0);
    assert.deepEqual((await c.query(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'marketing_aut_numero_saiu') AS gatilho, to_regprocedure('public.kidmais084_destino(text)') IS NOT NULL AS funcao`)).rows[0],
      { gatilho: false, funcao: false }, "down remove o gatilho em clientes (O1) e a normalização");
    await c.query("ROLLBACK");
    assert.ok((await c.query(`SELECT to_regclass('public.marketing_automacao_execucoes') AS t`)).rows[0].t, "rollback desfeito: schema de volta");

    // 4. Gatilhos e restrições (numa transação desfeita no fim).
    await c.query("BEGIN");
    const A = await empresa(c, "Marketing A (migration)"), B = await empresa(c, "Marketing B (migration)");
    const ga = await pessoa(c, A, "REPRESENTANTE_AUTORIZADO"), gb = await pessoa(c, B, "REPRESENTANTE_AUTORIZADO");
    const clienteA = await cliente(c, A, "Cliente A", "5511988880001"), clienteB = await cliente(c, B, "Cliente B", "5511988880002");
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    const contato = (empresaId: string, clienteId: string | null) => id(
      `INSERT INTO marketing_contatos (empresa_id, cliente_id, canal_atendimento, nome, telefone, chave_idempotencia, vinculo_cliente)
       VALUES ($1, $2, 'FORMULARIO_SITE', 'Contato sintético', '5511988880003', $3, $4) RETURNING id::text AS id`, [empresaId, clienteId, cod("chave-sintetica-"), clienteId ? "NOVO" : "SEM_CLIENTE"]);
    await recusa(c, `INSERT INTO marketing_contatos (empresa_id, cliente_id, canal_atendimento, nome, telefone, chave_idempotencia, vinculo_cliente)
      VALUES ($1, $2, 'FORMULARIO_SITE', 'X', '5511988880003', 'chave-cruzada-0000001', 'NOVO')`, [A, clienteB], /cliente do contato é de outra empresa/);
    const contatoA = await contato(A, clienteA);
    await recusa(c, `INSERT INTO marketing_contatos (empresa_id, canal_atendimento, nome, chave_idempotencia, vinculo_cliente) VALUES ($1, 'OUTRO', 'Sem meio', 'chave-sem-meio-000001', 'SEM_CLIENTE')`, [A], /marketing_contatos_meio/);
    await recusa(c, `DELETE FROM marketing_contatos WHERE id = $1`, [contatoA], /contato captado não é apagado/);
    // Atribuição: alvo de outra empresa recusado; DESCONHECIDA ⇔ DESCONHECIDO; append-only.
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1, 'CLIENTE', $2, 'INSTAGRAM', 'INFORMADO')`, [A, clienteB], /outra empresa/);
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1, 'CLIENTE', $2, 'DESCONHECIDA', 'INFORMADO')`, [A, clienteA], /marketing_atrib_desconhecida/);
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1, 'CLIENTE', $2, 'INSTAGRAM', 'CAPTURADO')`, [A, clienteA], /marketing_atrib_capturada_tem_campanha/);
    const atrib = await id(`INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo, registrado_por) VALUES ($1, 'CLIENTE', $2, 'INDICACAO', 'INFORMADO', $3) RETURNING id::text AS id`, [A, clienteA, ga.usuario]);
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1, 'CLIENTE', $2, 'GOOGLE', 'INFORMADO')`, [A, clienteA], /marketing_atrib_vigente_uk/);
    await recusa(c, `UPDATE marketing_atribuicoes SET origem_codigo = 'GOOGLE' WHERE id = $1`, [atrib], /append-only/);
    await recusa(c, `DELETE FROM marketing_atribuicoes WHERE id = $1`, [atrib], /não é apagada/);
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo, substitui_id, motivo) VALUES ($1, 'CLIENTE', $2, 'GOOGLE', 'INFORMADO', $3, 'correção')`, [A, clienteA, atrib], /substituir a atribuição \(já desativada\)/);
    await c.query(`UPDATE marketing_atribuicoes SET vigente = false, substituida_em = clock_timestamp() WHERE id = $1`, [atrib]);
    await c.query(`INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo, substitui_id, motivo) VALUES ($1, 'CLIENTE', $2, 'GOOGLE', 'INFORMADO', $3, 'Cliente corrigiu')`, [A, clienteA, atrib]);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM marketing_atribuicoes WHERE alvo_id = $1`, [clienteA])).rows[0].n, 2, "histórico preservado");
    // Site + domínio: host exclusivo entre empresas; provedor real recusado; REMOVIDO terminal.
    const site = async (empresaId: string, u: string) => id(`INSERT INTO marketing_sites (empresa_id, slug, rascunho, criado_por, atualizado_por) VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING id::text AS id`, [empresaId, cod("site-"), u]);
    const siteA = await site(A, ga.usuario), siteB = await site(B, gb.usuario);
    await recusa(c, `INSERT INTO marketing_sites (empresa_id, slug, rascunho, criado_por, atualizado_por) VALUES ($1, $2, '{}'::jsonb, $3, $3)`, [A, cod("outro-"), ga.usuario], /marketing_sites_unidade_uk/);
    await recusa(c, `UPDATE marketing_sites SET estado = 'PUBLICADO' WHERE id = $1`, [siteA], /marketing_sites_publicado_tem_versao/);
    const dominio = await id(`INSERT INTO marketing_dominios (empresa_id, site_id, host, principal, token_verificacao, criado_por) VALUES ($1, $2, 'festas.alfa-sintetico.test', true, $3, $4) RETURNING id::text AS id`, [A, siteA, "a".repeat(32), ga.usuario]);
    await recusa(c, `INSERT INTO marketing_dominios (empresa_id, site_id, host, principal, token_verificacao, criado_por) VALUES ($1, $2, 'festas.alfa-sintetico.test', true, $3, $4)`, [B, siteB, "b".repeat(32), gb.usuario], /marketing_dominios_host_uk/);
    await recusa(c, `INSERT INTO marketing_dominios (empresa_id, site_id, host, principal, provedor, simulado, token_verificacao, criado_por) VALUES ($1, $2, 'real.alfa-sintetico.test', false, 'RENDER', false, $3, $4)`, [A, siteA, "c".repeat(32), ga.usuario], /marketing_dominios_provedor/);
    await recusa(c, `UPDATE marketing_dominios SET host = 'outro.alfa-sintetico.test' WHERE id = $1`, [dominio], /imutáveis/);
    await c.query(`UPDATE marketing_dominios SET status = 'REMOVIDO', principal = false, removido_em = clock_timestamp() WHERE id = $1`, [dominio]);
    await recusa(c, `UPDATE marketing_dominios SET status = 'PENDENTE_DNS', removido_em = NULL WHERE id = $1`, [dominio], /removido não volta/);
    await c.query(`INSERT INTO marketing_dominios (empresa_id, site_id, host, principal, token_verificacao, criado_por) VALUES ($1, $2, 'festas.alfa-sintetico.test', true, $3, $4)`, [B, siteB, "d".repeat(32), gb.usuario]);
    // Versão publicada imutável; campanha arquivada imutável e código do link imutável.
    const versao = await id(`INSERT INTO marketing_site_versoes (empresa_id, site_id, numero, conteudo, publicado_por) VALUES ($1, $2, 1, '{}'::jsonb, $3) RETURNING id::text AS id`, [A, siteA, ga.usuario]);
    await recusa(c, `UPDATE marketing_site_versoes SET conteudo = '{"x":1}'::jsonb WHERE id = $1`, [versao], /somente inserção/);
    await recusa(c, `INSERT INTO marketing_site_versoes (empresa_id, site_id, numero, conteudo, publicado_por) VALUES ($1, $2, 2, '{}'::jsonb, $3)`, [B, siteA, gb.usuario], /marketing_versoes_site_fk/);
    const campanha = await id(`INSERT INTO marketing_campanhas (empresa_id, codigo, nome, canal, origem_codigo, inicio, utm_source, utm_medium, criada_por, atualizada_por)
      VALUES ($1, 'nov-centro', 'Novembro', 'INSTAGRAM', 'INSTAGRAM', '2026-11-01', 'instagram', 'social', $2, $2) RETURNING id::text AS id`, [A, ga.usuario]);
    await recusa(c, `UPDATE marketing_campanhas SET codigo = 'outro-codigo' WHERE id = $1`, [campanha], /imutáveis/);
    await c.query(`INSERT INTO marketing_campanhas (empresa_id, codigo, nome, canal, origem_codigo, inicio, utm_source, utm_medium, criada_por, atualizada_por)
      VALUES ($1, 'nov-centro', 'Mesmo código em outra empresa', 'INSTAGRAM', 'INSTAGRAM', '2026-11-01', 'instagram', 'social', $2, $2)`, [B, gb.usuario]);
    await c.query(`UPDATE marketing_campanhas SET status = 'ARQUIVADA', arquivada_em = clock_timestamp() WHERE id = $1`, [campanha]);
    await recusa(c, `UPDATE marketing_campanhas SET nome = 'Renomeada' WHERE id = $1`, [campanha], /arquivada não é alterada/);
    await recusa(c, `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo, campanha_id) VALUES ($1, 'CONTATO', $2, 'INSTAGRAM', 'CAPTURADO', (SELECT id FROM marketing_campanhas WHERE empresa_id = $3 AND codigo = 'nov-centro'))`,
      [A, contatoA, B], /marketing_atrib_campanha_fk/);
    // 084: execução e preferência só da mesma empresa; mensagem ativa exige texto revisado.
    await recusa(c, `INSERT INTO marketing_automacao_regras (empresa_id, tipo, status, acao, espera_dias, criado_por, atualizado_por) VALUES ($1, 'PROPOSTA_PARADA', 'ATIVA', 'MENSAGEM_WHATSAPP', 3, $2, $2)`, [A, ga.usuario], /marketing_regras_mensagem_revisada/);
    await recusa(c, `INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, criado_por, atualizado_por) VALUES ($1, 'DATAS_VAGAS', 'MENSAGEM_WHATSAPP', 0, $2, $2)`, [A, ga.usuario], /marketing_regras_datas_vagas_sugestao/);
    const regra = await id(`INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, criado_por, atualizado_por) VALUES ($1, 'PROPOSTA_PARADA', 'TAREFA_INTERNA', 3, $2, $2) RETURNING id::text AS id`, [A, ga.usuario]);
    await recusa(c, `INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, chave_idempotencia, agendada_para, max_tentativas)
      VALUES ($1, $2, 1, 'TAREFA_INTERNA', 'CLIENTE', $3, $3, 'chave-cruzada-exec', now(), 3)`, [A, regra, clienteB], /cliente da execução é de outra empresa/);
    const exec = await id(`INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, chave_idempotencia, agendada_para, max_tentativas)
      VALUES ($1, $2, 1, 'TAREFA_INTERNA', 'CLIENTE', $3, $3, 'chave-exec-sintetica', now(), 3) RETURNING id::text AS id`, [A, regra, clienteA]);
    await recusa(c, `INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, chave_idempotencia, agendada_para, max_tentativas)
      VALUES ($1, $2, 1, 'TAREFA_INTERNA', 'CLIENTE', $3, $3, 'chave-exec-sintetica', now(), 3)`, [A, regra, clienteA], /marketing_exec_chave_uk/);
    await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'PROCESSANDO' WHERE id = $1`, [exec], /marketing_exec_posse/);
    await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'ACEITA' WHERE id = $1`, [exec], /marketing_exec_provedor/);
    await c.query(`UPDATE marketing_automacao_execucoes SET estado = 'CANCELADA', concluida_em = clock_timestamp() WHERE id = $1`, [exec]);
    await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', concluida_em = NULL WHERE id = $1`, [exec], /concluída não muda/);
    await recusa(c, `DELETE FROM marketing_automacao_execucoes WHERE id = $1`, [exec], /não é apagada/);
    // Preferência (R1): só o descadastro do cliente inteiro; autorização é por destino, em tabela própria.
    await recusa(c, `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, descadastrado_em, descadastro_origem) VALUES ($1, $2, now(), 'EQUIPE')`, [A, clienteB], /outra empresa/);
    await recusa(c, `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, descadastrado_em) VALUES ($1, $2, now())`, [A, clienteA], /marketing_pref_descadastro/);
    await c.query(`INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, descadastrado_em, descadastro_origem, observacao) VALUES ($1, $2, now(), 'EQUIPE', 'pediu para parar')`, [A, clienteA]);
    assert.deepEqual((await c.query(`SELECT descadastrado, observacao FROM marketing_contato_preferencias_eventos WHERE cliente_id = $1`, [clienteA])).rows[0], { descadastrado: true, observacao: "pediu para parar" }, "histórico da preferência");
    // Autorização por destino (R1): mesma empresa, destino normalizado, formulário com contato, não nasce revogada,
    // identidade imutável, transições só para frente, evidência de confirmação congelada (O2), uma viva por destino,
    // nunca apagada; número que sai do cadastro revoga (O1).
    const autSql = `INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, destino, estado, origem, contato_id, evidencia, confirmada_em, confirmacao, revogada_em, motivo_revogacao)
      VALUES ($1, $2, $3, $4, $5, $6, 'autorizou por telefone', CASE WHEN $4 = 'CONFIRMADA' THEN now() END, CASE WHEN $4 = 'CONFIRMADA' THEN 'registro sintético' END,
        CASE WHEN $4 = 'REVOGADA' THEN now() END, CASE WHEN $4 = 'REVOGADA' THEN 'motivo sintético' END) RETURNING id::text AS id`;
    await recusa(c, autSql, [A, clienteB, "5511988880002", "CONFIRMADA", "EQUIPE", null], /outra empresa/);
    await recusa(c, autSql, [A, clienteA, "11988880001", "CONFIRMADA", "EQUIPE", null], /marketing_aut_destino/);
    await recusa(c, autSql, [A, clienteA, "5511988880001", "CONFIRMADA", "FORMULARIO_SITE", null], /marketing_aut_formulario_tem_contato/);
    await recusa(c, autSql, [A, clienteA, "5511988880001", "REVOGADA", "EQUIPE", null], /não nasce revogada/);
    const aut = await id(autSql, [A, clienteA, "5511988880001", "PENDENTE", "FORMULARIO_SITE", contatoA]);
    await recusa(c, autSql, [A, clienteA, "5511988880001", "CONFIRMADA", "EQUIPE", null], /marketing_aut_viva_uk/);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET destino = '5511988889999' WHERE id = $1`, [aut], /imutáveis/);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'CONFIRMADA' WHERE id = $1`, [aut], /marketing_aut_confirmada/);
    await c.query(`UPDATE marketing_contato_autorizacoes SET estado = 'CONFIRMADA', confirmada_em = now(), confirmacao = 'confirmou por ligação' WHERE id = $1`, [aut]);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'PENDENTE' WHERE id = $1`, [aut], /transição de autorização inválida/);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now() WHERE id = $1`, [aut], /marketing_aut_revogada/);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now(), motivo_revogacao = 'pediu para parar', confirmada_em = NULL, confirmacao = NULL WHERE id = $1`,
      [aut], /evidências de confirmação da autorização são imutáveis/);
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now(), motivo_revogacao = 'pediu para parar', confirmacao = 'trocada' WHERE id = $1`,
      [aut], /evidências de confirmação da autorização são imutáveis/);
    await c.query(`UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now(), motivo_revogacao = 'pediu para parar' WHERE id = $1`, [aut]);
    assert.deepEqual((await c.query(`SELECT confirmada_em IS NOT NULL AS data, confirmacao FROM marketing_contato_autorizacoes WHERE id = $1`, [aut])).rows[0],
      { data: true, confirmacao: "confirmou por ligação" }, "revogada vinda de confirmada mantém a evidência");
    await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'CONFIRMADA' WHERE id = $1`, [aut], /transição de autorização inválida/);
    await recusa(c, `DELETE FROM marketing_contato_autorizacoes WHERE id = $1`, [aut], /não é apagada/);
    // Revogada libera o destino para nova autorização (histórico preservado).
    const nova = await id(autSql, [A, clienteA, "5511988880001", "CONFIRMADA", "EQUIPE", null]);
    // O1: o número sai do cadastro do cliente → a autorização viva é revogada pelo banco.
    await c.query(`UPDATE clientes SET telefone = '5511988880009', whatsapp = '5511988880009' WHERE id = $1`, [clienteA]);
    assert.match((await c.query(`SELECT estado || ' ' || motivo_revogacao AS r FROM marketing_contato_autorizacoes WHERE id = $1`, [nova])).rows[0].r, /^REVOGADA NUMERO_SAIU_DO_CADASTRO: /);

    // 5. Rollback com dados: recusado.
    await c.query("SAVEPOINT down");
    await assert.rejects(c.query(semTransacaoExplicita(DOWN084)), /rollback recusado/);
    await c.query("ROLLBACK TO SAVEPOINT down");
    await assert.rejects(c.query(semTransacaoExplicita(DOWN083)), /desfazer a 084 antes/);
    await c.query("ROLLBACK");
    for (const p of [POST083, POST084]) await c.query(p);
  } finally {
    await encerrarDescartavel(c);
  }
});
