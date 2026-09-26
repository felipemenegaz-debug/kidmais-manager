import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import {
  alterarComposicaoPacoteAdmin,
  criarRevisaoPacoteAdmin,
  editarPacoteNaoUtilizado,
  listarPacotesAdmin,
  PacoteAdminError,
} from "./pacotes-admin.ts";

const ctx = { empresaId: "11111111-1111-4111-8111-111111111111", usuarioId: "usuario-1", requestId: "req-1", motivo: "Ajuste comercial" };
const auditar = async () => undefined;

function linha(utilizado: boolean) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    empresa_id: ctx.empresaId,
    codigo: "NOVO",
    nome: "Novo",
    descricao: null,
    duracao_minutos: null,
    ativo: true,
    vigente: true,
    arquivado_em: null,
    revisao_anterior_id: null,
    utilizado,
  };
}

test("a lista administrativa não inclui pacote de outra empresa nem legado sem empresa", async () => {
  let sql = "";
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      sql = text;
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await listarPacotesAdmin(tx, ctx.empresaId), []);
  assert.match(sql, /empresa_id = \$1::uuid/);
  assert.equal(sql.includes("IS NULL"), false);
  assert.match(sql, /p\.vigente/);
});

test("pacote utilizado não é reescrito; a revisão nova preserva a anterior", async () => {
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.includes("AS utilizado")) return { rows: [linha(true) as Row], rowCount: 1 };
      throw new Error(text);
    },
  };
  await assert.rejects(
    () => editarPacoteNaoUtilizado(tx, linha(true).id, { nome: "Outro", descricao: null, duracaoMinutos: null }, ctx, auditar),
    (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 409,
  );
  assert.equal(chamadas.some((sql) => sql.startsWith("UPDATE pacotes")), false);

  let leituras = 0;
  const revisao: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.includes("AS utilizado")) {
        leituras += 1;
        const nova = leituras > 1;
        return { rows: [{ ...linha(!nova), id: nova ? "33333333-3333-4333-8333-333333333333" : linha(true).id, revisao_anterior_id: nova ? linha(true).id : null, utilizado: !nova } as Row], rowCount: 1 };
      }
      if (text.startsWith("UPDATE pacotes SET vigente = false")) {
        assert.equal(text.includes("nome"), false);
        return { rows: [{ id: linha(true).id } as Row], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO pacotes")) {
        assert.equal(values?.[5], linha(true).id);
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" } as Row], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO auditoria")) {
        assert.equal(values?.[2], "PACOTE_REVISADO");
        assert.equal(values?.[4], "33333333-3333-4333-8333-333333333333");
        assert.match(String(values?.[5]), new RegExp(ctx.empresaId));
        assert.match(String(values?.[6]), new RegExp(ctx.empresaId));
        assert.equal(values?.[7], ctx.motivo);
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO pacote_") || text.startsWith("INSERT INTO regras_desconto_pacote")) {
        assert.equal(values?.[0], "33333333-3333-4333-8333-333333333333");
        assert.equal(values?.[1], linha(true).id);
        assert.equal(text.includes("precos_pacote"), false);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  const criada = await criarRevisaoPacoteAdmin(revisao, linha(true).id, { nome: "Revisão", descricao: null, duracaoMinutos: null }, ctx, auditar);
  assert.equal(criada.revisaoAnteriorId, linha(true).id);
  assert.equal(chamadas.some((sql) => sql.includes("DELETE") || sql.includes("precos_pacote")), false);
  for (const tabela of ["pacote_adicionais", "pacote_buffet_categorias", "pacote_buffet_itens", "regras_desconto_pacote"]) {
    assert.equal(chamadas.filter((sql) => sql.startsWith(`INSERT INTO ${tabela}`)).length, 1);
  }
});

test("composição de pacote utilizado cria revisão e não reescreve a anterior", async () => {
  const novaId = "33333333-3333-4333-8333-333333333333";
  const escritas: Array<{ text: string; values?: readonly unknown[] }> = [];
  let leituras = 0;
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      if (text.includes("AS esquerda")) {
        return { rows: [{ esquerda: ctx.empresaId, direita: ctx.empresaId } as Row], rowCount: 1 };
      }
      if (text.includes("AS utilizado")) {
        leituras += 1;
        const nova = leituras > 2;
        return { rows: [{ ...linha(!nova), id: nova ? novaId : linha(true).id, revisao_anterior_id: nova ? linha(true).id : null, utilizado: !nova } as Row], rowCount: 1 };
      }
      if (text.startsWith("UPDATE pacotes SET vigente = false")) return { rows: [{ id: linha(true).id } as Row], rowCount: 1 };
      if (text.startsWith("INSERT INTO pacotes")) return { rows: [{ id: novaId } as Row], rowCount: 1 };
      escritas.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const resultado = await alterarComposicaoPacoteAdmin(
    tx,
    linha(true).id,
    { tipo: "vinculo", adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "INCLUSO" },
    ctx,
    auditar,
  );
  assert.equal(resultado.id, novaId);
  const auditoria = escritas.find((item) => item.text.includes("INSERT INTO auditoria") && item.values?.[2] === "PACOTE_COMPOSICAO");
  assert.equal(auditoria?.values?.[4], novaId);
  assert.match(String(auditoria?.values?.[6]), new RegExp(ctx.empresaId));
  assert.equal(auditoria?.values?.[7], ctx.motivo);
  const upsert = escritas.find((item) => item.text.includes("ON CONFLICT (pacote_id, adicional_id)"));
  assert.equal(upsert?.values?.[0], novaId);
  assert.equal(escritas.some((item) => item.values?.[0] === linha(true).id), false);
  assert.equal(escritas.some((item) => item.text.includes("precos_pacote")), false);
});

test("composição cruzando empresas é recusada antes de gravar", async () => {
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.includes("AS utilizado")) return { rows: [linha(true) as Row], rowCount: 1 };
      if (text.includes("AS esquerda")) return { rows: [{ esquerda: ctx.empresaId, direita: "99999999-9999-4999-8999-999999999999" } as Row], rowCount: 1 };
      throw new Error(text);
    },
  };
  await assert.rejects(
    () => alterarComposicaoPacoteAdmin(tx, linha(true).id, { tipo: "vinculo", adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "EXTRA" }, ctx, auditar),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE",
  );
  assert.equal(chamadas.some((sql) => sql.startsWith("INSERT")), false);
});

test("a API administrativa não oferece exclusão física e reutiliza o papel existente", () => {
  const colecao = readFileSync("app/api/admin/configuracoes/pacotes/route.ts", "utf8");
  const item = readFileSync("app/api/admin/configuracoes/pacotes/[id]/route.ts", "utf8");
  assert.match(colecao, /REPRESENTANTE_AUTORIZADO/);
  assert.match(item, /REPRESENTANTE_AUTORIZADO/);
  assert.equal(colecao.includes("export async function DELETE"), false);
  assert.equal(item.includes("export async function DELETE"), false);
  assert.match(colecao, /exigirApiAdminCrmDisponivel/);
});
