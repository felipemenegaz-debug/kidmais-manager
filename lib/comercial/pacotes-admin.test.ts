import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import {
  alterarComposicaoPacoteAdmin,
  criarPacoteAdmin,
  criarRevisaoPacoteAdmin,
  editarPacoteNaoUtilizado,
  excluirPacoteArquivadoAdmin,
  listarPacotesAdmin,
  PacoteAdminError,
} from "./pacotes-admin.ts";

const ctx = { empresaId: "11111111-1111-4111-8111-111111111111", usuarioId: "usuario-1", requestId: "req-1", motivo: "Ajuste comercial" };

test('criação gera código normalizado e audita no tenant comprovado sem motivo humano', async () => {
  let codigo = '', auditado = false;
  const tx: DbExecutor = { async query<Row extends object>(sql: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
    if (sql.startsWith('SELECT id FROM empresas')) { assert.equal(values?.[0],ctx.empresaId); return {rows:[{id:ctx.empresaId} as Row],rowCount:1}; }
    if (sql.startsWith('INSERT INTO pacotes')) { codigo=String(values?.[1]); assert.match(codigo,/^P_[A-F0-9]{32}$/); assert.equal(values?.[0],ctx.empresaId); assert.equal(values?.[4],167); return {rows:[{id:linha(false).id} as Row],rowCount:1}; }
    if (sql.startsWith('INSERT INTO auditoria')) { auditado=true; assert.equal(values?.[2],'PACOTE_CRIADO'); assert.equal(values?.[7],'Criação administrativa'); const depois=JSON.parse(String(values?.[6])); assert.equal(depois.codigo,codigo); assert.equal(depois.empresaId,ctx.empresaId); return {rows:[],rowCount:1}; }
    if (sql.includes('AS utilizado')) return {rows:[{...linha(false),codigo,duracao_minutos:167} as Row],rowCount:1};
    throw new Error(sql);
  }};
  const resultado=await criarPacoteAdmin(tx,{empresaId:ctx.empresaId,nome:'Festa',descricao:null,duracaoMinutos:167},{empresaId:ctx.empresaId,usuarioId:ctx.usuarioId,requestId:ctx.requestId});
  assert.equal(resultado.codigo,codigo); assert.equal(resultado.duracaoMinutos,167); assert.equal(auditado,true);
  await assert.rejects(()=>criarPacoteAdmin(tx,{empresaId:'outra',nome:'Festa',descricao:null,duracaoMinutos:null},ctx),/outra empresa/);
});

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
  assert.equal(sql.includes("empresa_id IS NULL"), false);
  assert.match(sql, /p\.vigente/);
  assert.match(sql, /arquivado_em IS DISTINCT FROM NULL/);
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
    () => editarPacoteNaoUtilizado(tx, linha(true).id, { nome: "Outro", descricao: null, duracaoMinutos: null }, ctx),
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
      if (text.startsWith("UPDATE pacotes SET vigente = true")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" } as Row], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO pacotes")) {
        assert.match(text, /\$9::boolean, false, \$8::uuid/);
        assert.equal(values?.[8], true, "padrão da tela: a revisão nasce ativa");
        assert.equal(values?.[7], linha(true).id);
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" } as Row], rowCount: 1 };
      }
      if (text.includes("to_regclass")) return { rows: [{ ok: false } as Row], rowCount: 1 };
      if (text.includes("count(*)::int AS n")) return { rows: [{ n: 1 } as Row], rowCount: 1 };
      if (text.includes("FROM tabelas_preco") || text.includes("kidmais_037") || text.includes("pg_advisory_xact_lock") || text.includes("kidmais_047")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("INSERT INTO auditoria")) {
        assert.equal(values?.[2], "PACOTE_REVISADO");
        assert.equal(values?.[4], "33333333-3333-4333-8333-333333333333");
        assert.match(String(values?.[5]), new RegExp(ctx.empresaId));
        assert.match(String(values?.[6]), new RegExp(ctx.empresaId));
        assert.equal(values?.[7], ctx.motivo);
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO pacote_") || text.startsWith("INSERT INTO regras_desconto_pacote") || text.startsWith("INSERT INTO regras_disponibilidade_pacote")) {
        assert.equal(values?.[0], "33333333-3333-4333-8333-333333333333");
        assert.equal(values?.[1], linha(true).id);
        assert.equal(text.includes("precos_pacote"), false);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  const criada = await criarRevisaoPacoteAdmin(revisao, linha(true).id, { nome: "Revisão", descricao: null, duracaoMinutos: null }, ctx);
  assert.equal(criada.revisaoAnteriorId, linha(true).id);
  assert.equal(chamadas.some((sql) => sql.startsWith("DELETE")), false);
  const promocao = chamadas.findIndex((sql) => sql.startsWith("UPDATE pacotes SET vigente = true"));
  const copia = chamadas.findIndex((sql) => sql.includes("count(*)::int AS n"));
  assert.equal(copia >= 0 && copia < promocao, true);
  assert.equal(chamadas.filter((sql) => sql.includes("INSERT INTO auditoria")).length, 1);
  for (const tabela of ["pacote_adicionais", "pacote_buffet_categorias", "pacote_buffet_itens", "regras_desconto_pacote", "regras_disponibilidade_pacote"]) {
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
      if (text.includes("count(*)::int AS n")) return { rows: [{ n: 1 } as Row], rowCount: 1 };
      escritas.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const resultado = await alterarComposicaoPacoteAdmin(
    tx,
    linha(true).id,
    { tipo: "vinculo", adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "INCLUSO" },
    ctx,
  );
  assert.equal(resultado.id, novaId);
  const auditorias = escritas.filter((item) => item.text.includes("INSERT INTO auditoria"));
  assert.equal(auditorias.length, 1);
  const auditoria = auditorias[0];
  assert.equal(auditoria?.values?.[2], "PACOTE_COMPOSICAO");
  assert.equal(auditoria?.values?.[4], novaId);
  const depois = JSON.parse(String(auditoria?.values?.[6])) as { adicionais?: unknown; tipo?: unknown; empresaId?: string };
  const antes = JSON.parse(String(auditoria?.values?.[5])) as { adicionais?: unknown; tipo?: unknown };
  assert.ok(Array.isArray(antes.adicionais));
  assert.ok(Array.isArray(depois.adicionais));
  assert.equal(antes.tipo, undefined);
  assert.equal(depois.tipo, undefined);
  assert.equal(depois.empresaId, ctx.empresaId);
  assert.equal(auditoria?.values?.[7], ctx.motivo);
  const upsert = escritas.find((item) => item.text.includes("ON CONFLICT (pacote_id, adicional_id)"));
  assert.equal(upsert?.values?.[0], novaId);
  assert.equal(escritas.some((item) => !item.text.trimStart().startsWith("SELECT") && item.values?.[0] === linha(true).id), false);
  assert.equal(escritas.some((item) => !item.text.trimStart().startsWith("SELECT") && item.text.includes("precos_pacote")), false);
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
    () => alterarComposicaoPacoteAdmin(tx, linha(true).id, { tipo: "vinculo", adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "EXTRA" }, ctx),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE",
  );
  assert.equal(chamadas.some((sql) => sql.startsWith("INSERT")), false);
});

test("pacote arquivado sem uso é apagado e um preço publicado bloqueia a exclusão", async () => {
  const apagados: string[] = [];
  const livre: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("AS utilizado")) return { rows: [{ ...linha(false), arquivado_em: "2026-09-27", vigente: false, ativo: false } as Row], rowCount: 1 };
    if (text.includes("pg_constraint")) return { rows: [{ tabela: "fechamentos", coluna: "pacote_id", composto: false } as Row, { tabela: "pacote_adicionais", coluna: "pacote_id", composto: false } as Row], rowCount: 2 };
    if (text.includes("count(*)")) return { rows: [{ n: 0 } as Row], rowCount: 1 };
    if (text.includes("publicada_em IS NOT NULL")) return { rows: [], rowCount: 0 };
    if (text.startsWith("DELETE")) { apagados.push(text); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("INSERT INTO auditoria")) return { rows: [], rowCount: 1 };
    throw new Error(text);
  } };
  await excluirPacoteArquivadoAdmin(livre, linha(false).id, ctx);
  assert.equal(apagados.some((sql) => sql.includes("DELETE FROM pacotes")), true);
  assert.equal(apagados.some((sql) => sql.includes("DELETE FROM fechamentos")), false);

  const protegido: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("AS utilizado")) return { rows: [{ ...linha(false), arquivado_em: "2026-09-27" } as Row], rowCount: 1 };
    if (text.includes("pg_constraint")) return { rows: [], rowCount: 0 };
    if (text.includes("FROM precos_pacote")) return { rows: [{ ok: 1 } as Row], rowCount: 1 };
    throw new Error(text);
  } };
  await assert.rejects(() => excluirPacoteArquivadoAdmin(protegido, linha(false).id, ctx), /preço protegido/);
  const vigente: DbExecutor = { async query<Row extends object>(): Promise<DbQueryResult<Row>> {
    return { rows: [{ ...linha(false), arquivado_em: null } as Row], rowCount: 1 };
  } };
  await assert.rejects(() => excluirPacoteArquivadoAdmin(vigente, linha(false).id, ctx), /Arquive o pacote/);
});

test("a API administrativa reutiliza o papel existente e só exclui pelo preflight do pacote arquivado", () => {
  const colecao = readFileSync("app/api/admin/configuracoes/pacotes/route.ts", "utf8");
  const item = readFileSync("app/api/admin/configuracoes/pacotes/[id]/route.ts", "utf8");
  // 056: Gestão é o papel DA MEMBERSHIP, conferido dentro da transação do tenant (nunca o papel global da sessão).
  for (const fonte of [colecao, item]) {
    assert.match(fonte, /exigirGestaoNoTenant\(tenant, "Apenas o proprietário pode (editar|excluir) pacotes\."\)/);
    assert.doesNotMatch(fonte, /sessao\.papel/);
  }
  assert.equal(colecao.includes("export async function DELETE"), false);
  assert.match(item, /export async function DELETE/);
  assert.match(item, /excluirPacoteArquivadoAdmin/);
  assert.match(colecao, /exigirApiAdminCrmDisponivel/);
});
