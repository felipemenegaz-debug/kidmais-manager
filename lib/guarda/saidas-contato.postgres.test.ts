import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import { carregarComBanco, cliente, cod, comercial, contratoAssinado, empresa, executor, fechamento, vincular, SENHA_FALSA } from "../marketing/harness-postgres.ts";

/**
 * Guarda fase 1 (19/11/2026) no PostgreSQL DESCARTÁVEL, modelo 127. Dados 100% sintéticos (telefones 5511955550xxx,
 * e-mails @guarda.test).
 *   1a — marca de saída (127): descadastro grava as marcas; cadastro novo/importado com o mesmo contato não recebe
 *        CAMPANHA, mas a PESQUISA segue as regras próprias (G2); outra empresa não é alcançada; contato novo de
 *        descadastrado também é marcado; "não contatar" do atendimento marca o número; formulário do site ignora contato
 *        marcado; reativar encerra as marcas (inclusive só pela marca) e recusa contato que outro pedido ainda segura;
 *        marca não se apaga nem se altera; rollback só com a confirmação; precheck, carga inicial e postcheck.
 *   1b — marcos (só leitura): contrato assinado com pagamento, cancelado, mescla e contatos reais pelas consultas reais.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), "utf8");
const UP = "database/migrations/20261119_127_marketing_saidas_contato.sql";
const DOWN = "database/rollback/20261119_127_marketing_saidas_contato_down.sql";
const PRE = "database/checks/20261119_127_precheck.sql";
const POS = "database/checks/20261119_127_postcheck.sql";

type Elegivel = { ok: boolean; motivo?: string };
type Pref = {
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  elegivelParaMensagem(tx: unknown, e: string, c: string, f?: "CAMPANHA" | "PESQUISA"): Promise<Elegivel>;
  registrarAutorizacaoDoFormulario(tx: unknown, e: string, c: string, contato: string, destino: string): Promise<string>;
};
type Marcos = { lerMarcosDoCliente(tx: unknown, e: string, c: string): Promise<Record<string, unknown> & { clienteId: string } | null> };

async function pessoa(c: Client, empresaId: string) {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
    [`${cod("u")}@guarda.test`, SENHA_FALSA])).rows[0].id;
  await vincular(c, empresaId, usuario, "REPRESENTANTE_AUTORIZADO");
  return usuario;
}
const op = (operacao: string, clienteId: string, extra: Record<string, unknown> = {}) => ({ acao: "preferencia", operacao, clienteId, confirmacao: "Pedido sintético da própria pessoa", ...extra });
const marcas = async (c: Client, empresaId: string) => (await c.query<{ tipo: string; valor: string; origem: string; viva: boolean; motivo: string | null }>(
  `SELECT tipo, valor, origem, encerrada_em IS NULL AS viva, motivo_encerramento AS motivo FROM marketing_saidas_contato WHERE empresa_id = $1::uuid ORDER BY tipo, valor, registrado_em`, [empresaId])).rows;
async function recusa(c: Client, sql: string, params: unknown[], padrao: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, params), padrao);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}
async function recusaServico(c: Client, f: () => Promise<unknown>, padrao: RegExp) {
  await c.query("SAVEPOINT servico");
  await assert.rejects(f(), padrao);
  await c.query("ROLLBACK TO SAVEPOINT servico");
}
function modulos(c: Client) {
  const cache = new Map();
  return {
    pref: carregarComBanco("lib/marketing/automacoes/preferencias.ts", c, () => null, {}, cache) as unknown as Pref,
    marcos: carregarComBanco("lib/guarda/marcos.ts", c, () => null, {}, cache) as unknown as Marcos,
  };
}

test("127: descadastro marca telefone e e-mail; cadastro novo com o contato não recebe campanha; pesquisa e outra empresa não mudam", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const { pref } = modulos(c);
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "Guarda A sintética"), B = await empresa(c, "Guarda B sintética");
    const ga = await pessoa(c, A);
    const ana = await cliente(c, A, "Ana Sintética", "11955550001", " Ana@Guarda.TEST ");
    await pref.alterarPreferencia(tx, A, ga, op("descadastrar", ana));
    assert.deepEqual((await marcas(c, A)).map((m) => [m.tipo, m.valor, m.origem, m.viva]),
      [["EMAIL", "ana@guarda.test", "EQUIPE", true], ["TELEFONE", "5511955550001", "EQUIPE", true]], "WhatsApp = telefone: uma marca só");

    // Cadastro novo (ou importado) com o mesmo telefone, e outro só com o mesmo e-mail.
    const mesmoTelefone = await cliente(c, A, "Ana de novo", "5511955550001", null);
    const mesmoEmail = await cliente(c, A, "Ana pelo e-mail", "11955550099", "ana@guarda.test");
    assert.deepEqual(await pref.elegivelParaMensagem(tx, A, mesmoTelefone), { ok: false, motivo: "SAIU_PELO_CONTATO" });
    assert.deepEqual(await pref.elegivelParaMensagem(tx, A, mesmoEmail), { ok: false, motivo: "SAIU_PELO_CONTATO" });
    assert.notEqual((await pref.elegivelParaMensagem(tx, A, mesmoTelefone, "PESQUISA")).motivo, "SAIU_PELO_CONTATO", "G2: pesquisa não confere a marca");
    // Formulário do site: número marcado não vira autorização.
    assert.equal(await pref.registrarAutorizacaoDoFormulario(tx, A, mesmoEmail, "00000000-0000-4000-8000-000000000000", "11955550001"), "IGNORADA_SAIDA_CONTATO");
    // Outra empresa: a marca não alcança.
    const deB = await cliente(c, B, "Ana em B", "11955550001", "ana@guarda.test");
    assert.notEqual((await pref.elegivelParaMensagem(tx, B, deB)).motivo, "SAIU_PELO_CONTATO");
    // A equipe não autoriza número marcado.
    await recusaServico(c, () => pref.alterarPreferencia(tx, A, ga, op("autorizar", mesmoTelefone, { destino: "11955550001" })), /pediu para sair/);

    // Descadastrada que ganha contato novo: o novo também é marcado.
    await c.query("UPDATE clientes SET whatsapp = '11955550002' WHERE id = $1::uuid", [ana]);
    assert.ok((await marcas(c, A)).some((m) => m.valor === "5511955550002" && m.viva));
    // Atendimento: "não contatar" marca o número (sem cliente).
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1::uuid, 'staging', '5511955550003')", [A]);
    await c.query("UPDATE whatsapp_atendimento_conversas SET nao_contatar = true WHERE empresa_id = $1::uuid AND contato = '5511955550003'", [A]);
    assert.ok((await marcas(c, A)).some((m) => m.valor === "5511955550003" && m.origem === "ATENDIMENTO_WHATSAPP" && m.viva));
    await c.query(ler(POS).replace(/^BEGIN TRANSACTION READ ONLY;$/m, "").replace(/^(COMMIT|ROLLBACK);$/m, ""));
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("127: marca não se apaga nem se altera; não nasce encerrada; cliente de outra empresa recusado", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await c.query("BEGIN");
    const A = await empresa(c, "Guarda imutável A"), B = await empresa(c, "Guarda imutável B");
    const deB = await cliente(c, B, "Cliente de B", "11955550010", null);
    const id = (await c.query<{ id: string }>("INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem) VALUES ($1::uuid, 'TELEFONE', '5511955550011', 'EQUIPE') RETURNING id::text AS id", [A])).rows[0].id;
    await recusa(c, "DELETE FROM marketing_saidas_contato WHERE id = $1::uuid", [id], /não é apagada/);
    await recusa(c, "UPDATE marketing_saidas_contato SET valor = '5511955550012' WHERE id = $1::uuid", [id], /imutáveis/);
    await recusa(c, "UPDATE marketing_saidas_contato SET saiu_em = now() - interval '1 day' WHERE id = $1::uuid", [id], /imutáveis/);
    await recusa(c, "INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem) VALUES ($1::uuid, 'TELEFONE', '5511955550011', 'EQUIPE')", [A], /marketing_saidas_viva_uk/);
    await recusa(c, "INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, encerrada_em, motivo_encerramento) VALUES ($1::uuid, 'TELEFONE', '5511955550013', 'EQUIPE', now(), 'teste')", [A], /nasce encerrada/);
    await recusa(c, "INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, cliente_id) VALUES ($1::uuid, 'TELEFONE', '5511955550014', 'EQUIPE', $2::uuid)", [A, deB], /outra empresa/);
    await recusa(c, "INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem) VALUES ($1::uuid, 'TELEFONE', '11955550015', 'EQUIPE')", [A], /check/i);
    await recusa(c, "INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem) VALUES ($1::uuid, 'EMAIL', 'Maiuscula@guarda.test', 'EQUIPE')", [A], /check/i);
    await c.query("UPDATE marketing_saidas_contato SET encerrada_em = now(), motivo_encerramento = 'encerrada no teste' WHERE id = $1::uuid", [id]);
    await recusa(c, "UPDATE marketing_saidas_contato SET encerrada_em = now(), motivo_encerramento = 'de novo' WHERE id = $1::uuid", [id], /uma vez/);
    // Encerrada, o mesmo contato pode ser marcado de novo (nova saída).
    await c.query("INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem) VALUES ($1::uuid, 'TELEFONE', '5511955550011', 'RESPOSTA_PARAR')", [A]);
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("127: reativar encerra as marcas (com descadastro ou só pela marca) e recusa contato que outro pedido ainda segura", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const { pref } = modulos(c);
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "Guarda reativar");
    const ga = await pessoa(c, A);
    const bia = await cliente(c, A, "Bia Sintética", "11955550020", "bia@guarda.test");
    await pref.alterarPreferencia(tx, A, ga, op("descadastrar", bia));
    await pref.alterarPreferencia(tx, A, ga, op("reativar", bia));
    const depois = await marcas(c, A);
    assert.equal(depois.length, 2);
    assert.ok(depois.every((m) => !m.viva && /^REATIVACAO:/.test(m.motivo ?? "")), "as duas marcas encerradas pela reativação");

    // Só pela marca: cadastro novo com contato marcado por outro cadastro que depois trocou de número.
    const caio = await cliente(c, A, "Caio Sintético", "11955550021", null);
    await pref.alterarPreferencia(tx, A, ga, op("descadastrar", caio));
    await c.query("UPDATE clientes SET whatsapp = '11955550022', telefone = '11955550022' WHERE id = $1::uuid", [caio]);
    const novo = await cliente(c, A, "Caio recadastrado", "11955550021", null);
    assert.equal((await pref.elegivelParaMensagem(tx, A, novo)).motivo, "SAIU_PELO_CONTATO");
    await recusaServico(c, () => pref.alterarPreferencia(tx, A, ga, op("descadastrar", novo)).then(() => { throw new Error("ok-descadastrou"); }), /ok-descadastrou/);
    await pref.alterarPreferencia(tx, A, ga, op("reativar", novo));
    assert.notEqual((await pref.elegivelParaMensagem(tx, A, novo)).motivo, "SAIU_PELO_CONTATO");
    const eventos = (await c.query<{ d: boolean[] }>("SELECT array_agg(descadastrado ORDER BY registrado_em) AS d FROM marketing_contato_preferencias_eventos WHERE cliente_id = $1::uuid", [novo])).rows[0].d;
    assert.deepEqual(eventos, [true, false], "086 registra os dois passos (descadastro e reativação)");

    // Compartilhado: o mesmo número em outro cliente ainda descadastrado → recusa sem efeito.
    const duda = await cliente(c, A, "Duda Sintética", "11955550023", null);
    const dudaOutra = await cliente(c, A, "Duda outro cadastro", "11955550023", null);
    await pref.alterarPreferencia(tx, A, ga, op("descadastrar", duda));
    await pref.alterarPreferencia(tx, A, ga, op("descadastrar", dudaOutra));
    await recusaServico(c, () => pref.alterarPreferencia(tx, A, ga, op("reativar", duda)), /outro pedido de saída/);
    assert.ok((await marcas(c, A)).some((m) => m.valor === "5511955550023" && m.viva));
    // E pelo atendimento: "não contatar" segura o número.
    const eva = await cliente(c, A, "Eva Sintética", "11955550024", null);
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', '5511955550024', true)", [A]);
    await recusaServico(c, () => pref.alterarPreferencia(tx, A, ga, op("reativar", eva)), /outro pedido de saída/);
    await c.query(ler(POS).replace(/^BEGIN TRANSACTION READ ONLY;$/m, "").replace(/^(COMMIT|ROLLBACK);$/m, ""));
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("1b: marcos pelas consultas reais — contrato assinado com pagamento, cancelado, mescla, contato real", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const { marcos } = modulos(c);
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "Guarda marcos"), B = await empresa(c, "Guarda marcos B");
    const base = await comercial(c, A);
    await travarConfiguracaoAgenda(tx, A, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
    const fabi = await cliente(c, A, "Fabi Sintética", "11955550030", "fabi@guarda.test");
    const f1 = await fechamento(c, A, base, fabi, { data: "2025-05-10", status: "CONFIRMADO" });
    const { pagamento } = await contratoAssinado(c, f1, 4500, null);
    await c.query(`INSERT INTO pagamento_recebimentos (pagamento_id, status, meio_pagamento, valor_bruto, recebido_em, confirmado_em, chave_idempotencia, metadata_provedor)
      VALUES ($1::uuid, 'CONFIRMADO', 'PIX', 4500, '2025-07-02 12:00-03', '2025-07-02 12:00-03', gen_random_uuid()::text, '{"forma":"PIX"}'::jsonb)`, [pagamento]);
    // Interessado sem contato: marco = cadastro.
    const gil = await cliente(c, A, "Gil Interessado", "11955550031", null);
    const mg = await marcos.lerMarcosDoCliente(tx, A, gil);
    assert.equal(mg?.categoria, "INTERESSADO");
    assert.deepEqual((mg?.ultimoContato as { origem: string }).origem, "CADASTRO");
    // Contratou: contrato pelo último pagamento (depois da festa).
    let m = await marcos.lerMarcosDoCliente(tx, A, fabi);
    assert.equal(m?.categoria, "CONTRATOU");
    assert.equal(m?.ultimaFesta, "2025-05-10");
    assert.equal(m?.ultimoPagamento, "2025-07-02");
    assert.deepEqual(m?.contrato, { data: "2030-07-02", marco: "2025-07-02", motivo: "5 anos do último pagamento" });
    // Mesclado: lido pelo principal, com a festa do mesclado somada; contato do WhatsApp pelo número do mesclado.
    const antigo = await cliente(c, A, "Fabi cadastro antigo", "11955550032", null);
    const f2 = await fechamento(c, A, base, antigo, { data: "2026-02-20", status: "CONFIRMADO" });
    await contratoAssinado(c, f2, 4500, null);
    await c.query("UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $2::uuid, mesclado_em = now() WHERE id = $1::uuid", [antigo, fabi]);
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, ultima_entrada_em) VALUES ($1::uuid, 'staging', '5511955550032', '2026-09-01 10:00-03')", [A]);
    m = await marcos.lerMarcosDoCliente(tx, A, antigo);
    assert.equal(m?.clienteId, fabi);
    assert.equal(m?.ultimaFesta, "2026-02-20");
    assert.deepEqual(m?.ultimoContato, { dia: "2026-09-01", origem: "WHATSAPP" });
    assert.equal((m?.campanhas as { data: string }).data, "2031-09-01");
    // Cancelado depois de assinado: conta do cancelamento.
    await c.query("UPDATE contratos SET status = 'CANCELADO', cancelado_em = '2026-03-15 10:00-03' WHERE fechamento_id = $1::uuid", [f2]);
    m = await marcos.lerMarcosDoCliente(tx, A, fabi);
    assert.equal(m?.ultimaFesta, "2025-05-10", "festa cancelada não é 'última festa'");
    assert.equal((m?.contrato as { data: string }).data, "2031-03-15");
    // Outra empresa: nada.
    assert.equal(await marcos.lerMarcosDoCliente(tx, B, fabi), null);
    // Saída das campanhas encerra o prazo de campanhas na hora.
    await c.query("INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, saiu_em) VALUES ($1::uuid, 'EMAIL', 'fabi@guarda.test', 'EQUIPE', '2026-10-05 10:00-03')", [A]);
    m = await marcos.lerMarcosDoCliente(tx, A, fabi);
    assert.equal(m?.saidaCampanhas, "2026-10-05");
    assert.deepEqual(m?.campanhas, { data: "2026-10-05", marco: "2026-10-05", motivo: "pediu para sair das campanhas" });
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("127: rollback só com a confirmação; precheck; reaplicação com carga inicial de descadastros e do atendimento; postcheck", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    // Sem a confirmação: recusa e nada muda.
    await assert.rejects(c.query(ler(DOWN)), /falta SET kidmais.rollback_127/);
    await c.query("ROLLBACK").catch(() => undefined);
    assert.equal((await c.query("SELECT to_regclass('public.marketing_saidas_contato') IS NOT NULL AS ok")).rows[0].ok, true);
    await assert.rejects(c.query(ler(PRE)), /127 já presente/);
    await c.query("ROLLBACK").catch(() => undefined);
    // Com a confirmação: some tudo; o precheck volta a passar.
    await c.query("SET kidmais.rollback_127 = 'descartar-marcas'");
    await c.query(ler(DOWN));
    await c.query("RESET kidmais.rollback_127");
    assert.equal((await c.query(`SELECT to_regclass('public.marketing_saidas_contato') IS NULL AND to_regprocedure('public.kidmais127_email(text)') IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'marketing_saidas_%') AS ok`)).rows[0].ok, true);
    await c.query(ler(PRE));
    // Estado anterior à 127: descadastro (086) e "não contatar" (060) já existentes.
    const A = await empresa(c, "Guarda carga inicial");
    const ga = await pessoa(c, A);
    const hel = await cliente(c, A, "Hel Sintética", "11955550040", "Hel@Guarda.test");
    await c.query(`INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, descadastrado_em, descadastro_origem, observacao, atualizado_por)
      VALUES ($1::uuid, $2::uuid, '2026-08-01 10:00-03', 'EQUIPE', 'sintético', $3::uuid)`, [A, hel, ga]);
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar, atualizada_em) VALUES ($1::uuid, 'staging', '5511955550041', true, '2026-07-01 10:00-03')", [A]);
    await c.query(ler(UP));
    await c.query(ler(POS));
    const r = await marcas(c, A);
    assert.deepEqual(r.map((m) => [m.tipo, m.valor, m.origem, m.viva]), [
      ["EMAIL", "hel@guarda.test", "EQUIPE", true], ["TELEFONE", "5511955550040", "EQUIPE", true], ["TELEFONE", "5511955550041", "ATENDIMENTO_WHATSAPP", true]]);
    const datas = (await c.query("SELECT valor, (saiu_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM marketing_saidas_contato WHERE empresa_id = $1::uuid ORDER BY valor", [A])).rows;
    assert.equal(datas.length, 3);
    assert.ok(datas.some((d) => d.valor === "5511955550041" && d.d === "2026-07-01") && datas.some((d) => d.valor === "5511955550040" && d.d === "2026-08-01"));
    // Limpeza: dados sintéticos desta suíte (o banco de trabalho é descartado depois de qualquer jeito).
  } finally {
    await encerrarDescartavel(c);
  }
});
