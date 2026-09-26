import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import {
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
      throw new Error(text);
    },
  };
  const criada = await criarRevisaoPacoteAdmin(revisao, linha(true).id, { nome: "Revisão", descricao: null, duracaoMinutos: null }, ctx, auditar);
  assert.equal(criada.revisaoAnteriorId, linha(true).id);
  assert.equal(chamadas.some((sql) => sql.includes("DELETE")), false);
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
