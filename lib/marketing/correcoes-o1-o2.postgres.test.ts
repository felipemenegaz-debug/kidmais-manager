import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, empresa, executor, vincular, SENHA_FALSA } from "./harness-postgres.ts";

/**
 * Observações O1 e O2 da revisão de 64fcd09 (15/10/2026) no PostgreSQL descartável (modelo 084). Dados 100% sintéticos
 * (telefones 55119666xxxxx / 5511333xxxxx).
 *   O1 — decisão de Felipe: número que SAI do cadastro do cliente perde as autorizações vivas desse número (gatilho
 *        marketing_aut_numero_saiu em clientes); se voltar, precisa de nova autorização. Troca de campo ou só de
 *        formatação não revoga; pendente de número que nunca esteve no cadastro não é afetada; outro cliente e outra
 *        empresa não são afetados; a normalização SQL é a mesma de normalizarDestino.
 *   O2 — evidências de confirmação (confirmada_em, confirmada_por, confirmacao) gravadas uma vez e congeladas, inclusive
 *        na revogação; marketing_aut_confirmada exige evidência coerente em cada estado.
 */
type Elegibilidade = { ok: boolean; telefone?: string; autorizacaoId?: string; motivo?: string };
type Pref = {
  normalizarDestino(v: string | null): string | null;
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  elegivelParaMensagem(tx: unknown, e: string, c: string): Promise<Elegibilidade>;
};
type Crm = { atualizarCliente(id: string, escopo: unknown, patch: Record<string, unknown>, db: unknown): Promise<unknown> };

const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const POST084 = readFileSync("database/checks/20261014_084_postcheck.sql", "utf8");

async function pessoa(c: Client, empresaId: string) {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, SENHA_FALSA])).rows[0].id;
  return vincular(c, empresaId, usuario, "REPRESENTANTE_AUTORIZADO");
}

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

test("O1: número que sai do cadastro perde a autorização; ao voltar, exige nova autorização", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const cache = new Map();
    const pref = carregarComBanco("lib/marketing/automacoes/preferencias.ts", c, () => null, {}, cache) as unknown as Pref;
    const crm = carregarComBanco("lib/clientes/repositories/cliente.repository.ts", c, () => null, {}, cache) as unknown as Crm;
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "O1 A sintética"), B = await empresa(c, "O1 B sintética");
    const ga = await pessoa(c, A), gb = await pessoa(c, B);
    const clienteCom = async (E: string, telefone: string | null, whatsapp: string | null) =>
      (await c.query<{ id: string }>(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp) VALUES ($1, 'Cliente O1 sintético', $2, $3) RETURNING id::text AS id`, [E, telefone, whatsapp])).rows[0].id;
    const autorizar = (E: string, u: string, k: string, destino: string) =>
      pref.alterarPreferencia(tx, E, u, { acao: "preferencia", operacao: "autorizar", clienteId: k, destino, confirmacao: "Autorizou por ligação (sintético)" });
    const autorizacoes = async (k: string) => (await c.query(`SELECT id::text, destino, estado, motivo_revogacao, confirmada_em IS NOT NULL AS tem_data, confirmada_por::text, confirmacao, revogada_por::text
      FROM marketing_contato_autorizacoes WHERE cliente_id = $1 ORDER BY criado_em, id`, [k])).rows;
    const cadastro = (k: string, telefone: string | null, whatsapp: string | null) =>
      c.query(`UPDATE clientes SET telefone = $2, whatsapp = $3 WHERE id = $1`, [k, telefone, whatsapp]);

    await t.test("sai e volta (cenário do parecer): revogada ao sair, não volta a valer, nova autorização passa a valer", async () => {
      const k = await clienteCom(A, "5511966660001", "5511966660001");
      await autorizar(A, ga.usuario, k, "11966660001");
      assert.equal((await pref.elegivelParaMensagem(tx, A, k)).telefone, "5511966660001");
      // Saída pela edição do CRM (repositório real).
      await crm.atualizarCliente(k, { tipo: "TENANT", empresaId: A }, { telefone: "11966660002", whatsapp: "11966660002", usuarioId: ga.usuario }, tx);
      const [saiu] = await autorizacoes(k);
      assert.equal(saiu.estado, "REVOGADA", "revogada na mesma transação da alteração do cadastro");
      assert.match(saiu.motivo_revogacao, /^NUMERO_SAIU_DO_CADASTRO: /);
      assert.equal(saiu.revogada_por, null, "revogação pelo banco, sem usuário atribuído");
      assert.deepEqual([saiu.tem_data, saiu.confirmada_por, saiu.confirmacao], [true, ga.usuario, "Autorizou por ligação (sintético)"], "evidência de confirmação preservada");
      assert.deepEqual(await pref.elegivelParaMensagem(tx, A, k), { ok: false, motivo: "SEM_AUTORIZACAO" });
      // Volta por SQL direto: a autorização antiga NÃO volta a valer (antes de O1: { ok: true, telefone: 5511966660001 }).
      await cadastro(k, "5511966660001", "5511966660001");
      assert.deepEqual(await pref.elegivelParaMensagem(tx, A, k), { ok: false, motivo: "SEM_AUTORIZACAO" });
      await autorizar(A, ga.usuario, k, "5511966660001");
      const nova = await pref.elegivelParaMensagem(tx, A, k);
      assert.equal(nova.telefone, "5511966660001");
      assert.notEqual(nova.autorizacaoId, saiu.id, "nova autorização, com nova evidência");
      assert.deepEqual((await autorizacoes(k)).map((a) => a.estado), ["REVOGADA", "CONFIRMADA"], "histórico preservado");
    });

    await t.test("número que continua no cadastro (outro campo ou outra formatação) mantém a autorização", async () => {
      const k = await clienteCom(A, "551133330003", "5511966660003");
      await autorizar(A, ga.usuario, k, "5511966660003");
      await cadastro(k, "551133330099", "5511966660003");
      await cadastro(k, "5511966660003", "5511966660098");
      await cadastro(k, "11966660003", null);
      await c.query(`UPDATE clientes SET nome_completo = 'Cliente O1 renomeado' WHERE id = $1`, [k]);
      assert.deepEqual((await autorizacoes(k)).map((a) => a.estado), ["CONFIRMADA"]);
      assert.equal((await pref.elegivelParaMensagem(tx, A, k)).telefone, "5511966660003");
    });

    await t.test("pendente de número fora do cadastro não é afetada até o número entrar e sair", async () => {
      const k = await clienteCom(A, "5511966660004", "5511966660004");
      const contato = (await c.query<{ id: string }>(`INSERT INTO marketing_contatos (empresa_id, cliente_id, canal_atendimento, nome, telefone, chave_idempotencia, vinculo_cliente)
        VALUES ($1, $2, 'FORMULARIO_SITE', 'Contato sintético', '11966660005', $3, 'EXISTENTE_CONTATO') RETURNING id::text AS id`, [A, k, cod("o1-chave-")])).rows[0].id;
      await c.query(`INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, destino, estado, origem, contato_id, evidencia)
        VALUES ($1, $2, '5511966660005', 'PENDENTE', 'FORMULARIO_SITE', $3, 'Caixa marcada no formulário (sintético)')`, [A, k, contato]);
      await cadastro(k, "5511966660006", "5511966660006");
      assert.deepEqual((await autorizacoes(k)).map((a) => [a.destino, a.estado]), [["5511966660005", "PENDENTE"]], "nunca esteve no cadastro: continua pendente");
      await cadastro(k, "5511966660005", "5511966660005");
      await cadastro(k, "5511966660006", "5511966660006");
      assert.deepEqual((await autorizacoes(k)).map((a) => [a.destino, a.estado]), [["5511966660005", "REVOGADA"]], "entrou e saiu: revogada");
    });

    await t.test("outro cliente e outra empresa com o mesmo número não são afetados", async () => {
      const k = await clienteCom(A, "5511966660007", "5511966660007");
      const irmao = await clienteCom(A, "5511966660007", "5511966660007");
      const deB = await clienteCom(B, "5511966660007", "5511966660007");
      await autorizar(A, ga.usuario, k, "5511966660007");
      await autorizar(A, ga.usuario, irmao, "5511966660007");
      await autorizar(B, gb.usuario, deB, "5511966660007");
      await cadastro(k, null, null);
      assert.deepEqual((await autorizacoes(k)).map((a) => a.estado), ["REVOGADA"]);
      assert.deepEqual((await autorizacoes(irmao)).map((a) => a.estado), ["CONFIRMADA"]);
      assert.deepEqual((await autorizacoes(deB)).map((a) => a.estado), ["CONFIRMADA"]);
      assert.equal((await pref.elegivelParaMensagem(tx, B, deB)).telefone, "5511966660007");
    });

    await t.test("normalização SQL igual à de normalizarDestino", async () => {
      for (const v of ["(11) 96666-0001", "11966660001", "5511966660001", "+55 11 96666-0001", "1133334444", "551133334444", "123", "", "  ", "12345678901234567", "abc", "+1 (415) 555-0100"]) {
        assert.equal((await c.query(`SELECT kidmais084_destino($1) AS d`, [v])).rows[0].d, pref.normalizarDestino(v), `entrada ${JSON.stringify(v)}`);
      }
      assert.equal((await c.query(`SELECT kidmais084_destino(NULL) AS d`)).rows[0].d, pref.normalizarDestino(null));
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("O2: evidências de confirmação gravadas uma vez e congeladas, inclusive na revogação", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const pref = carregarComBanco("lib/marketing/automacoes/preferencias.ts", c, () => null) as unknown as Pref;
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "O2 A sintética");
    const ga = await pessoa(c, A), outro = await pessoa(c, A);
    const k = (await c.query<{ id: string }>(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp) VALUES ($1, 'Cliente O2 sintético', '5511966660010', '5511966660010') RETURNING id::text AS id`, [A])).rows[0].id;
    const inserir = `INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, destino, estado, origem, evidencia, confirmada_em, confirmada_por, confirmacao, revogada_por)
      VALUES ($1, $2, $3, $4, 'EQUIPE', 'Registro da equipe (sintético)', $5, $6, $7, $8) RETURNING id::text AS id`;
    const evidencia = async (id: string) => (await c.query(`SELECT estado, confirmada_em::text, confirmada_por::text, confirmacao FROM marketing_contato_autorizacoes WHERE id = $1`, [id])).rows[0];

    await t.test("restrição: evidência coerente em cada estado", async () => {
      await recusa(c, inserir, [A, k, "5511966660011", "PENDENTE", new Date(), null, "confirmou", null], /marketing_aut_confirmada/);
      await recusa(c, inserir, [A, k, "5511966660011", "PENDENTE", null, ga.usuario, null, null], /marketing_aut_confirmada/);
      await recusa(c, inserir, [A, k, "5511966660011", "CONFIRMADA", new Date(), ga.usuario, null, null], /marketing_aut_confirmada/);
      await recusa(c, inserir, [A, k, "5511966660011", "CONFIRMADA", null, null, "confirmou", null], /marketing_aut_confirmada/);
      await recusa(c, inserir, [A, k, "5511966660011", "PENDENTE", null, null, null, ga.usuario], /marketing_aut_revogada/);
    });

    await t.test("CONFIRMADA → REVOGADA: não apaga nem troca quando, quem e como", async () => {
      const id = (await c.query<{ id: string }>(inserir, [A, k, "5511966660010", "PENDENTE", null, null, null, null])).rows[0].id;
      await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'CONFIRMADA', confirmada_em = now() WHERE id = $1`, [id], /marketing_aut_confirmada/);
      await pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "confirmar", clienteId: k, autorizacaoId: id, confirmacao: "Confirmou por ligação (sintético)" });
      const antes = await evidencia(id);
      assert.deepEqual([antes.estado, antes.confirmada_por, antes.confirmacao], ["CONFIRMADA", ga.usuario, "Confirmou por ligação (sintético)"]);
      const revogar = `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now(), motivo_revogacao = 'pediu para parar'`;
      await recusa(c, `${revogar}, confirmada_em = NULL, confirmada_por = NULL, confirmacao = NULL WHERE id = $1`, [id], /evidências de confirmação da autorização são imutáveis/);
      await recusa(c, `${revogar}, confirmada_por = $2 WHERE id = $1`, [id, outro.usuario], /evidências de confirmação da autorização são imutáveis/);
      await recusa(c, `${revogar}, confirmacao = 'outra versão' WHERE id = $1`, [id], /evidências de confirmação da autorização são imutáveis/);
      await recusa(c, `${revogar}, confirmada_em = confirmada_em - interval '1 day' WHERE id = $1`, [id], /evidências de confirmação da autorização são imutáveis/);
      await pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "revogar", clienteId: k, autorizacaoId: id, confirmacao: "Pediu para parar (sintético)" });
      assert.deepEqual(await evidencia(id), { ...antes, estado: "REVOGADA" }, "revogada mantém exatamente a evidência de confirmação");
    });

    await t.test("PENDENTE → REVOGADA não fabrica confirmação; descadastro revoga sem tocar na evidência", async () => {
      const id = (await c.query<{ id: string }>(inserir, [A, k, "5511966660012", "PENDENTE", null, null, null, null])).rows[0].id;
      await recusa(c, `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = now(), motivo_revogacao = 'x' || 'yz', confirmada_em = now(), confirmacao = 'fabricada' WHERE id = $1`,
        [id], /evidências de confirmação da autorização são imutáveis/);
      const viva = (await c.query<{ id: string }>(inserir, [A, k, "5511966660010", "CONFIRMADA", new Date(), ga.usuario, "Autorizou (sintético)", null])).rows[0].id;
      const antes = await evidencia(viva);
      await pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "descadastrar", clienteId: k, confirmacao: "Pediu para parar (sintético)" });
      assert.deepEqual(await evidencia(id), { estado: "REVOGADA", confirmada_em: null, confirmada_por: null, confirmacao: null });
      assert.deepEqual(await evidencia(viva), { ...antes, estado: "REVOGADA" });
    });

    await c.query(POST084);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});
