import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";

/**
 * Migration 065 (nome de perfil do WhatsApp, não verificado) e a identificação do contato na tela de Atendimento, no
 * PostgreSQL descartável. Só roda pelo check:v1:postgres, com KIDMAIS_POSTGRES_DESCARTAVEL, no cluster descartável e
 * com autorização explícita do Felipe (docs/OPERACAO_AGENTES.md). PREPARADA: não executada.
 * Serviço REAL (listarAtendimento/receberEntrada) numa conexão por transação; dados sintéticos; nenhuma rede.
 *
 * Roteiro:
 *  0. ordem: 065 sem a 060 é recusada;
 *  1. só a 060: a tela lista número completo e cadastro, sem nome de perfil e sem erro; o nome recebido é ignorado;
 *  2. aplicação da 065 + postcheck; reaplicação recusada; regras do banco (formato e par nome/horário);
 *  3. nome de perfil: gravado saneado; evento mais antigo não sobrescreve; mais novo sobrescreve; vazio não apaga;
 *  4. cadastro: um cliente da empresa (sem 55) = nome; cliente de OUTRA empresa com o mesmo número não conta;
 *     segundo cliente da empresa (com 55) = ambíguo, sem nome; o nome de perfil continua separado;
 *  5. isolamento: conversa de outra empresa e de outro ambiente não aparecem; usuário só de outra empresa e usuário
 *     com vínculo não ativo são recusados (fixtures obrigatórias);
 *  6. rollback: recusado com nomes gravados; com descarte explícito remove só as colunas; pós-rollback; a tela
 *     continua funcionando (sem cache) e a 060 fica intacta; reaplicável.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP060 = ler("database/migrations/20261001_060_whatsapp_atendimento.sql");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const DOWN060 = ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql");
const UP = ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql");
const POST = ler("database/checks/20261004_065_postcheck.sql");
const DOWN = ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql");
const POS_DOWN = ler("database/checks/20261004_065_rollback_postcheck.sql");

const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
/** Fixtures sintéticas na própria suíte (invariante de lib/autenticacao/plataforma.test.ts). */
function fixtures(c: Client) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  const empresa = async (nome: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wa"), nome]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    return e;
  };
  /** `ativar = false` deixa o vínculo PENDENTE (transição válida da 045): o usuário existe, mas não comprova a empresa. */
  const usuario = async (papel: string, empresaId: string, ativar = true) => {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 065', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
    if (ativar) await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    return { usuario_id: u, papel } as SessaoParaTenant;
  };
  const cliente = async (empresaId: string, telefone: string, nome: string) => id(`INSERT INTO clientes (nome_completo, empresa_id, telefone) VALUES ($1, $2::uuid, $3) RETURNING id`, [nome, empresaId, telefone]);
  return { empresa, usuario, cliente };
}

test("065: nome de perfil (não verificado), número completo e cadastro na tela — isolamento, ambiguidade e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    // 0. Ordem.
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') AS t")).rows[0].t, null, "descartável começa sem a 060");
    await assert.rejects(c.query(UP), /065 exige a 060/); await c.query("ROLLBACK").catch(() => {});

    // 1. Só a 060.
    await c.query(UP060); await c.query(POST060);
    const f = fixtures(c);
    const A = await f.empresa("Empresa sintética A (065)"), B = await f.empresa("Empresa sintética B (065)");
    const repA = await f.usuario("REPRESENTANTE_AUTORIZADO", A), atendA = await f.usuario("ADMINISTRATIVO", A);
    const { servico } = carregarAtendimento(A);
    await servico.salvarConfiguracao(repA, { ativo: true, nome: "Empresa sintética A", perguntas: [] });
    const contato = "5561900000201";
    const agora = Date.now();
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: agora - 60_000, nomePerfil: "Ana Perfil" });
    let tela = await servico.listarAtendimento(atendA);
    let linha = tela.conversas.find((x) => x.contato === contato)!;
    assert.ok(linha, "número completo na tela autorizada");
    assert.deepEqual([linha.contato_final, linha.nome_perfil, linha.cadastro], ["0201", null, { situacao: "SEM_CADASTRO" }], "sem a 065: sem nome de perfil e sem erro");

    // 2. Aplicação.
    await c.query(UP); await c.query(POST);
    await assert.rejects(c.query(semTransacaoExplicita(UP)), /065 já aplicada/); await c.query("ROLLBACK").catch(() => {});
    const recusa = async (sql: string, v: unknown[], motivo: RegExp) => { await c.query("BEGIN"); await assert.rejects(c.query(sql, v), motivo); await c.query("ROLLBACK"); };
    await recusa("UPDATE whatsapp_atendimento_conversas SET nome_perfil=' Ana ', nome_perfil_em=now() WHERE contato=$1", [contato], /nome_perfil_formato/);
    await recusa("UPDATE whatsapp_atendimento_conversas SET nome_perfil=$2, nome_perfil_em=now() WHERE contato=$1", [contato, "x".repeat(81)], /nome_perfil_formato/);
    await recusa("UPDATE whatsapp_atendimento_conversas SET nome_perfil='Ana' WHERE contato=$1", [contato], /nome_perfil_par/);

    // 3. Nome de perfil.
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Oi", timestamp: agora - 30_000, nomePerfil: "  Ana​  Souza " });
    linha = (await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!;
    assert.equal(linha.nome_perfil, "Ana Souza", "saneado");
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "replay", timestamp: agora - 120_000, nomePerfil: "Nome antigo" });
    assert.equal((await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!.nome_perfil, "Ana Souza", "evento mais antigo não sobrescreve");
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Oi de novo", timestamp: agora - 10_000, nomePerfil: null });
    assert.equal((await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!.nome_perfil, "Ana Souza", "ausente não apaga");
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Mudei o nome", timestamp: agora - 5_000, nomePerfil: "Ana S." });
    assert.equal((await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!.nome_perfil, "Ana S.", "mais novo sobrescreve");

    // 4. Cadastro (repositório de clientes da empresa).
    await f.cliente(B, contato, "Cliente da empresa B");
    assert.deepEqual((await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!.cadastro, { situacao: "SEM_CADASTRO" }, "cliente de outra empresa com o mesmo número não conta");
    await f.cliente(A, "61900000201", "Ana Souza Cadastrada");
    linha = (await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!;
    assert.deepEqual(linha.cadastro, { situacao: "UNICO", nome: "Ana Souza Cadastrada" }, "achado pela variante sem 55");
    assert.equal(linha.nome_perfil, "Ana S.", "o nome de perfil continua separado do cadastro");
    await f.cliente(A, contato, "Outra pessoa com o mesmo número");
    linha = (await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!;
    assert.deepEqual(linha.cadastro, { situacao: "AMBIGUO", quantidade: 2 }, "dois clientes: só a quantidade; nenhum escolhido");
    assert.ok(!JSON.stringify(linha).includes("Cadastrada") && !JSON.stringify(linha).includes("Outra pessoa"), "nenhum nome cadastrado sai com ambiguidade");

    // 5. Isolamento por empresa e ambiente; papel.
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nome_perfil, nome_perfil_em) VALUES ($1, 'staging', '5561900000299', 'Perfil de B', now())", [B]);
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nome_perfil, nome_perfil_em) VALUES ($1, 'production', '5561900000298', 'Perfil de producao', now())", [A]);
    tela = await servico.listarAtendimento(atendA);
    assert.ok(tela.conversas.every((x) => x.empresa_id === A && x.ambiente === "staging"));
    assert.ok(!JSON.stringify(tela).includes("Perfil de B") && !JSON.stringify(tela).includes("Perfil de producao"), "outra empresa e outro ambiente invisíveis");
    // Recusas obrigatórias (fixtures sem catch): o banco só aceita os papéis ADMINISTRATIVO e REPRESENTANTE_AUTORIZADO,
    // ambos com atendimento; quem não vê a tela é quem não comprova a empresa piloto.
    const deB = await f.usuario("ADMINISTRATIVO", B);
    await assert.rejects(servico.listarAtendimento(deB), /não comprova a empresa autorizada/, "usuário só de B não vê a tela do piloto A");
    const pendenteA = await f.usuario("ADMINISTRATIVO", A, false);
    await assert.rejects(servico.listarAtendimento(pendenteA), /não comprova a empresa autorizada/, "vínculo de A não ativo não vê a tela");

    // 6. Rollback.
    await assert.rejects(c.query(DOWN), /Rollback da 065 recusado/); await c.query("ROLLBACK").catch(() => {});
    await c.query(DOWN.replace("SET LOCAL statement_timeout = '60s';", "SET LOCAL statement_timeout = '60s';\nSET LOCAL kidmais.rollback_065_descartar_nomes = 'sim';"));
    await c.query(POS_DOWN); await c.query(POST060);
    linha = (await servico.listarAtendimento(atendA)).conversas.find((x) => x.contato === contato)!;
    assert.deepEqual([linha.nome_perfil, linha.cadastro.situacao], [null, "AMBIGUO"], "sem as colunas a tela segue (sem cache), com cadastro");
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Depois do rollback", timestamp: Date.now(), nomePerfil: "Ignorado" });
    await c.query(UP); await c.query(POST);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM whatsapp_atendimento_conversas WHERE nome_perfil IS NOT NULL")).rows[0].n, 0, "reaplicada vazia");

    // Limpeza do descartável, como a suíte da 064: tira a 065 (vazia) e a 060 (com descarte explícito).
    await c.query(DOWN); await c.query(POS_DOWN);
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await c.query(semTransacaoExplicita(DOWN060)); await c.query("COMMIT");
  } finally {
    await encerrarDescartavel(c);
  }
});
