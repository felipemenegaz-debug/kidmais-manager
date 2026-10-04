import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";

/**
 * Migration 063 (mensagens prontas) no PostgreSQL descartável. Só roda pelo check:v1:postgres, com
 * KIDMAIS_POSTGRES_DESCARTAVEL, no cluster descartável e com autorização explícita do Felipe (docs/OPERACAO_AGENTES.md).
 * PREPARADA: execução registrada em docs/VALIDACAO_063_E_ENCERRAMENTO.md. Dados sintéticos; nenhuma chamada de rede.
 * Serviço REAL da biblioteca, com o repositório REAL de clientes, numa conexão por transação.
 *
 * Roteiro:
 *  0. ordem: 063 sem a 060 é recusada;
 *  1. aplicação: 060 + postcheck, 063 + postcheck; reaplicação recusada;
 *  2. cadastro (representante) e recusa ao atendente; lista com atalhos primeiro;
 *  3. conflitos: atalho e título ativos únicos, versão desatualizada, regras do banco (link por tipo, https, limite);
 *     remover libera atalho e título;
 *  4. favoritas por usuário; mensagem removida não favorita;
 *  5. isolamento: usuário de outra empresa recusado; linha de outra empresa invisível e não favoritável; favorita
 *     cruzada recusada pela chave composta; outro ambiente invisível;
 *  6. rascunho: texto, link fixo e link individual com o repositório real — sem cliente, telefone com/sem 55,
 *     cliente de outra empresa não conta, dois clientes = ambíguo; nada é gravado nem enviado;
 *  7. rollback: recusado com dados; com descarte explícito remove só a 063; pós-rollback; 060 intacta.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP060 = ler("database/migrations/20261001_060_whatsapp_atendimento.sql");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const DOWN060 = ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql");
const UP = ler("database/migrations/20261004_063_whatsapp_mensagens_prontas.sql");
const POST = ler("database/checks/20261004_063_postcheck.sql");
const DOWN = ler("database/rollback/20261004_063_whatsapp_mensagens_prontas_down.sql");
const POS_DOWN = ler("database/checks/20261004_063_rollback_postcheck.sql");

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("BEGIN");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK");
}

const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
/** Empresas e usuários sintéticos (membership ATIVA), no mesmo padrão da suíte 060. */
function fixtures(c: Client) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  const empresa = async (nome: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wa"), nome]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    return e;
  };
  const usuario = async (papel: string, empresaId: string) => {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness atendimento', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    return { usuario_id: u, papel } as SessaoParaTenant;
  };
  const cliente = async (empresaId: string, telefone: string) => id(`INSERT INTO clientes (nome_completo, empresa_id, telefone) VALUES ($1, $2::uuid, $3) RETURNING id`, [`Cliente sintético ${cod("")}`, empresaId, telefone]);
  return { id, empresa, usuario, cliente };
}

test("063: mensagens prontas — aplicação, postcheck, cadastro, favoritas, isolamento, conflitos, rascunho e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    // 0. Ordem.
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') AS t")).rows[0].t, null, "descartável começa sem a 060");
    await assert.rejects(c.query(UP), /063 exige a 060/); await c.query("ROLLBACK").catch(() => {});

    // 1. Aplicação.
    await c.query(UP060); await c.query(POST060);
    await c.query(UP); await c.query(POST);
    await assert.rejects(c.query(semTransacaoExplicita(UP)), /063 já aplicada/); await c.query("ROLLBACK").catch(() => {});

    const f = fixtures(c);
    const A = await f.empresa("Empresa sintética A (063)"), B = await f.empresa("Empresa sintética B (063)");
    const repA = await f.usuario("REPRESENTANTE_AUTORIZADO", A), atendA = await f.usuario("ADMINISTRATIVO", A), repB = await f.usuario("REPRESENTANTE_AUTORIZADO", B);
    const { servico, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(repA, { ativo: true, nome: "Empresa sintética A", perguntas: [] });

    // 2. Cadastro.
    const salvar = (s: typeof repA, p: Record<string, unknown>) => biblioteca.salvarPronta(s, { categoria: "Comercial", link: null, atalho: null, ...p });
    const tabela = (await salvar(repA, { titulo: "Tabela de preços", tipo: "LINK", texto: "Segue a tabela.", link: "https://kidmais.example/tabela", atalho: "TABELA_PRECOS" })).id;
    const contrato = (await salvar(repA, { titulo: "Contrato para assinatura", tipo: "LINK_FECHAMENTO_INDIVIDUAL", texto: "Seu contrato:", atalho: "DISPONIBILIDADE_FECHAMENTO" })).id;
    const endereco = (await salvar(repA, { titulo: "Endereço", categoria: "Informações", tipo: "TEXTO", texto: "Rua das Festas, 100." })).id;
    await assert.rejects(salvar(atendA, { titulo: "Do atendente", tipo: "TEXTO", texto: "x" }), /ATENDIMENTO_ACESSO_NEGADO/);
    const lista = await biblioteca.listarProntas(atendA);
    assert.deepEqual(lista.prontas.map((p) => p.titulo), ["Contrato para assinatura", "Tabela de preços", "Endereço"], "atalhos primeiro (ordem do código do atalho), depois categoria e título");
    assert.equal(lista.podeGerenciar, false); assert.equal((await biblioteca.listarProntas(repA)).podeGerenciar, true);
    assert.equal(lista.prontas.find((p) => p.id === contrato)!.link, null, "link individual nunca gravado");

    // 3. Conflitos.
    await assert.rejects(salvar(repA, { titulo: "Outra tabela", tipo: "TEXTO", texto: "x", atalho: "TABELA_PRECOS" }), /ATENDIMENTO_PRONTA_ATALHO_EM_USO/);
    // ASCII de propósito: lower() segue o LC_CTYPE do banco; no cluster descartável (locale C) letras acentuadas não
    // são convertidas (limitação documentada em docs/VALIDACAO_063_E_ENCERRAMENTO.md).
    await assert.rejects(salvar(repA, { titulo: "CONTRATO PARA ASSINATURA", tipo: "TEXTO", texto: "y" }), /ATENDIMENTO_PRONTA_TITULO_EM_USO/, "título único sem diferenciar caixa");
    const pEnd = lista.prontas.find((p) => p.id === endereco)!;
    await biblioteca.salvarPronta(repA, { id: endereco, versao: pEnd.versao, titulo: "Endereço", categoria: "Informações", tipo: "TEXTO", texto: "Rua das Festas, 200.", link: null, atalho: null });
    await assert.rejects(biblioteca.salvarPronta(repA, { id: endereco, versao: pEnd.versao, titulo: "Endereço", categoria: "Informações", tipo: "TEXTO", texto: "antiga", link: null, atalho: null }), /ATENDIMENTO_PRONTA_DESATUALIZADA/);
    const ins = `INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, link, criada_por, atualizada_por) VALUES ($1, 'staging', $2, 'Teste', $3, $4, $5, $6, $6)`;
    await recusa(c, ins, [A, cod("t"), "TEXTO", "x", "https://kidmais.example", repA.usuario_id], /whatsapp_prontas_link_por_tipo/);
    await recusa(c, ins, [A, cod("t"), "LINK", "x", null, repA.usuario_id], /whatsapp_prontas_link_por_tipo/);
    await recusa(c, ins, [A, cod("t"), "LINK_FECHAMENTO_INDIVIDUAL", "x", "https://kidmais.example/c", repA.usuario_id], /whatsapp_prontas_link_por_tipo/);
    await recusa(c, ins, [A, cod("t"), "LINK", "x", "http://kidmais.example", repA.usuario_id], /check constraint/);
    await recusa(c, ins, [A, cod("t"), "LINK", "x".repeat(3990), "https://kidmais.example/" + "a".repeat(30), repA.usuario_id], /whatsapp_prontas_rascunho_limite/);
    const pTab = (await biblioteca.listarProntas(repA)).prontas.find((p) => p.id === tabela)!;
    await biblioteca.arquivarPronta(repA, { id: tabela, versao: pTab.versao });
    const tabela2 = (await salvar(repA, { titulo: "Tabela de preços", tipo: "LINK", texto: "Nova tabela.", link: "https://kidmais.example/tabela-2", atalho: "TABELA_PRECOS" })).id;
    assert.notEqual(tabela2, tabela, "remover libera atalho e título");
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1 AND NOT ativa", [tabela])).rows[0].n), 1, "remoção lógica: a linha fica");

    // 4. Favoritas por usuário.
    await biblioteca.favoritarPronta(atendA, { id: endereco, favorita: true });
    await biblioteca.favoritarPronta(atendA, { id: endereco, favorita: true });   // idempotente
    await biblioteca.favoritarPronta(atendA, { id: contrato, favorita: true });
    assert.deepEqual((await biblioteca.listarProntas(atendA)).favoritas.sort(), [contrato, endereco].sort());
    assert.deepEqual((await biblioteca.listarProntas(repA)).favoritas, [], "favoritas são de cada usuário");
    await biblioteca.favoritarPronta(atendA, { id: contrato, favorita: false });
    assert.deepEqual((await biblioteca.listarProntas(atendA)).favoritas, [endereco]);
    await assert.rejects(biblioteca.favoritarPronta(atendA, { id: tabela, favorita: true }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/, "removida não favorita");

    // 5. Isolamento.
    await assert.rejects(biblioteca.listarProntas(repB), /não comprova a empresa autorizada/, "usuário só de B não acessa a biblioteca do piloto A");
    const deB = (await c.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, criada_por, atualizada_por) VALUES ($1, 'staging', 'Só de B', 'Teste', 'TEXTO', 'texto de B', $2, $2) RETURNING id`, [B, repB.usuario_id])).rows[0].id;
    const deProducao = (await c.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, criada_por, atualizada_por) VALUES ($1, 'production', 'Só de produção', 'Teste', 'TEXTO', 'x', $2, $2) RETURNING id`, [A, repA.usuario_id])).rows[0].id;
    const idsA = (await biblioteca.listarProntas(atendA)).prontas.map((p) => p.id);
    assert.ok(!idsA.includes(deB) && !idsA.includes(deProducao), "outra empresa e outro ambiente invisíveis");
    await assert.rejects(biblioteca.favoritarPronta(atendA, { id: deB, favorita: true }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/);
    await recusa(c, `INSERT INTO whatsapp_atendimento_mensagens_prontas_favoritas (usuario_id, mensagem_pronta_id, empresa_id, ambiente) VALUES ($1, $2, $3, 'staging')`, [atendA.usuario_id, deB, A], /foreign key|violates/);
    await recusa(c, `INSERT INTO whatsapp_atendimento_mensagens_prontas_favoritas (usuario_id, mensagem_pronta_id, empresa_id, ambiente) VALUES ($1, $2, $3, 'production')`, [atendA.usuario_id, endereco, A], /foreign key|violates/);

    // 6. Rascunho com conversa real e repositório real de clientes.
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: "5561900000401", texto: "Olá", timestamp: Date.now() });
    const conversa = (await c.query("SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = '5561900000401'", [A])).rows[0].id as string;
    const antes = Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens")).rows[0].n);
    assert.deepEqual(await biblioteca.prepararRascunho(atendA, { conversaId: conversa, id: endereco }), { titulo: "Endereço", texto: "Rua das Festas, 200.", linkIndividual: null, aviso: null });
    assert.equal((await biblioteca.prepararRascunho(atendA, { conversaId: conversa, id: tabela2 })).texto, "Nova tabela.\n\nhttps://kidmais.example/tabela-2");
    await assert.rejects(biblioteca.prepararRascunho(atendA, { conversaId: conversa, id: deB }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/);
    const individual = () => biblioteca.prepararRascunho(atendA, { conversaId: conversa, id: contrato });
    let r = await individual();
    assert.deepEqual([r.linkIndividual, r.texto], ["NAO_PREENCHIDO", "Seu contrato:"]); assert.match(r.aviso!, /Nenhum cliente desta empresa/);
    await f.cliente(B, "61900000401");                                   // mesmo telefone, OUTRA empresa: não conta
    r = await individual(); assert.match(r.aviso!, /Nenhum cliente desta empresa/);
    await f.cliente(A, "61900000401");                                   // CRM sem o 55: achado pela variante
    r = await individual(); assert.match(r.aviso!, /não tem contrato aguardando a assinatura/, "cliente único achado; sem contrato liberado, não preenche");
    await f.cliente(A, "5561900000401");                                 // segundo cliente da empresa com o mesmo telefone
    r = await individual(); assert.match(r.aviso!, /Mais de um cliente/);
    assert.ok(!JSON.stringify(r).includes("900000401"), "o telefone não volta");
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens")).rows[0].n), antes, "rascunho não grava nem envia");

    // 7. Rollback.
    const conversasAntes = Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_conversas")).rows[0].n);
    await assert.rejects(c.query(DOWN), /há mensagens prontas gravadas/); await c.query("ROLLBACK").catch(() => {});
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_063_descartar_prontas = 'sim'");
    await c.query(semTransacaoExplicita(DOWN)); await c.query("COMMIT");
    await c.query(POS_DOWN);
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_conversas")).rows[0].n), conversasAntes, "060 intacta");
    await assert.rejects(biblioteca.listarProntas(atendA), /ATENDIMENTO_PRONTAS_INDISPONIVEL/, "sem a 063 a biblioteca fica indisponível");
    assert.ok((await servico.listarAtendimento(atendA)).conversas.length >= 1, "o atendimento segue funcionando");
    // Reaplicável depois do rollback (sem dados), e limpeza final.
    await c.query(UP); await c.query(POST);
    await c.query(DOWN); await c.query(POS_DOWN);
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await c.query(semTransacaoExplicita(DOWN060)); await c.query("COMMIT");
  } finally {
    await encerrarDescartavel(c);
  }
});
