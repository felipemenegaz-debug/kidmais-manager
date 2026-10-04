import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import * as domain from "./domain.ts";
import * as buffet from "./buffet.ts";
import { perfis, nomePerfil } from "./perfis.ts";
import { nomePapelSistema } from "../autenticacao/papeis.ts";

/**
 * E1/056 — Festa com Tenant Context sobre MEMBERSHIP. O serviço REAL (`lib/festas/service.ts`) roda sobre um
 * banco falso que aplica os predicados da SQL (empresa no WHERE, membership da empresa, capacidade da
 * membership), registrando a ordem das consultas.
 */
function carregar(file: string, deps: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const js = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", js)((id: string) => { assert(id in deps, `Import não isolado: ${id}`); return deps[id]; }, exports);
  return exports;
}

const schema = carregar("lib/festas/schema.ts", { "./buffet": buffet, zod: { z }, "./domain": domain });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FESTA_A = "f0000000-0000-4000-8000-00000000000a";
const FESTA_B = "f0000000-0000-4000-8000-00000000000b";
const VERSAO = "a0000000-0000-4000-8000-000000000001";
const ATOR = "a0000000-0000-4000-8000-000000000001";
const MEMBRO_A = "b0000000-0000-4000-8000-00000000000a";
const MEMBRO_B = "b0000000-0000-4000-8000-00000000000b";
const COMPARTILHADO = "b0000000-0000-4000-8000-0000000000ab";
const AREA_A = "c0000000-0000-4000-8000-00000000000a";
const AREA_B = "c0000000-0000-4000-8000-00000000000b";
const UNIDADE_A = "d0000000-0000-4000-8000-00000000000a";
const UNIDADE_B = "d0000000-0000-4000-8000-00000000000b";
const MEMBERSHIP_ATOR_A = "e0000000-0000-4000-8000-0000000000aa";

type Opcoes = { tenant?: "ok" | "recusa"; papelAtual?: string; capacidades?: boolean; revalidacaoFalha?: boolean };

function ambiente(o: Opcoes = {}) {
  const log: string[] = [];
  const escritas: string[] = [];
  const festas: Record<string, { empresa: string; row: Record<string, unknown> }> = {
    [FESTA_A]: { empresa: A, row: { id: FESTA_A, contrato_id: "contrato-a", revisao: 1, invalidada_em: null, versao_contratual_criacao_id: VERSAO } },
    [FESTA_B]: { empresa: B, row: { id: FESTA_B, contrato_id: "contrato-b", revisao: 1, invalidada_em: null, versao_contratual_criacao_id: VERSAO } },
  };
  /** (empresa, usuário) → membership ATIVA. O compartilhado tem uma em A e OUTRA em B. */
  const memberships: Array<{ id: string; empresa: string; usuario: string }> = [
    { id: MEMBERSHIP_ATOR_A, empresa: A, usuario: ATOR },
    { id: "m-membro-a", empresa: A, usuario: MEMBRO_A },
    { id: "m-membro-b", empresa: B, usuario: MEMBRO_B },
    { id: "m-comp-a", empresa: A, usuario: COMPARTILHADO },
    { id: "m-comp-b", empresa: B, usuario: COMPARTILHADO },
  ];
  const areas: Record<string, { empresa: string; estabelecimento: string | null }> = { [AREA_A]: { empresa: A, estabelecimento: null }, [AREA_B]: { empresa: B, estabelecimento: null } };
  const unidades: Record<string, string> = { [UNIDADE_A]: A, [UNIDADE_B]: B };
  const concedidas: Array<{ empresa: string; membership: string; capacidade: string }> = [];
  const tx = {
    async query(sql: string, v: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      log.push(s);
      const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
      if (/^(INSERT|UPDATE)/.test(s)) {
        escritas.push(s);
        if (s.startsWith("UPDATE festas")) return r([{ ...festas[String(v[0])].row, revisao: 2 }]);
        if (s.startsWith("INSERT INTO festa_tarefas")) return r([{ id: randomUUID() }]);
        if (s.startsWith("INSERT INTO festa_membership_capacidades")) { concedidas.push({ empresa: String(v[0]), membership: String(v[1]), capacidade: String(v[2]) }); return r([{ id: randomUUID(), empresa_id: v[0], membership_id: v[1], capacidade: v[2] }]); }
        if (s.startsWith("INSERT INTO festa_areas")) { assert.equal(v[3], A, "área nasce na empresa comprovada"); return r([{ id: randomUUID(), nome: v[0], empresa_id: v[3], estabelecimento_id: v[4] }]); }
        if (s.startsWith("UPDATE festa_areas")) { assert.match(s, /WHERE id=\$1 AND empresa_id=\$2::uuid/); return r([{ id: v[0], empresa_id: v[1], nome: v[2] }]); }
        return r([]);
      }
      if (s.startsWith("SELECT f.* FROM festas f JOIN contratos co")) {
        assert.match(s, /fe\.empresa_id=\$2::uuid/, "empresa no WHERE da posse");
        const f = festas[String(v[0])];
        return r(f && f.empresa === v[1] ? [f.row] : []);
      }
      if (s.startsWith("SELECT * FROM festas WHERE id=$1 FOR UPDATE")) return r([festas[String(v[0])].row]);
      if (s.startsWith("SELECT id FROM festa_membership_capacidades WHERE membership_id=$1 AND empresa_id=$2 AND capacidade=$3")) {
        // Capacidade só da membership comprovada (a do ator em A).
        return r(o.capacidades === false || v[0] !== MEMBERSHIP_ATOR_A || v[1] !== A ? [] : [{ id: "cap" }]);
      }
      if (s.startsWith("SELECT * FROM festa_eventos")) return r([]);
      if (s.startsWith("SELECT m.usuario_id FROM memberships m WHERE m.usuario_id=$1 AND m.empresa_id=$2::uuid AND m.status='ATIVA'")) return r(memberships.some((m) => m.usuario === v[0] && m.empresa === v[1]) ? [{ usuario_id: v[0] }] : []);
      if (s.startsWith("SELECT m.id FROM memberships m WHERE m.empresa_id=$1::uuid AND m.usuario_id=$2::uuid AND m.status='ATIVA'")) {
        return r(memberships.filter((m) => m.empresa === v[0] && m.usuario === v[1]).map((m) => ({ id: m.id })));
      }
      if (s.startsWith("SELECT u.id,u.nome,m.papel,(m.status='ATIVA') AS ativo")) {
        return r(memberships.filter((m) => m.empresa === v[0]).map((m) => ({ id: m.usuario, nome: m.usuario, papel: "ADMINISTRATIVO", ativo: true, membership_id: m.id })));
      }
      if (s.startsWith("SELECT n.*,m.usuario_id FROM festa_membership_capacidades n")) {
        assert.match(s, /WHERE n\.empresa_id=\$1::uuid/);
        return r(concedidas.filter((c) => c.empresa === v[0]).map((c) => ({ ...c, usuario_id: memberships.find((m) => m.id === c.membership)!.usuario })));
      }
      if (s.startsWith("SELECT * FROM festa_membership_capacidades WHERE membership_id=$1 AND capacidade=$2")) return r([]);
      if (s.startsWith("SELECT capacidade FROM festa_membership_capacidades")) return r([]);
      if (s.startsWith("SELECT * FROM festa_areas WHERE empresa_id=$1::uuid ORDER BY nome")) return r([]);
      if (s.startsWith("SELECT f.*,(SELECT a.data_nascimento")) return r([]);
      if (s.startsWith("SELECT c.id,cf.versao_vigente_id")) return r([]);
      if (s.startsWith("SELECT id FROM festa_areas WHERE id=$1 AND empresa_id=$2::uuid AND ativo")) return r(areas[String(v[0])]?.empresa === v[1] ? [{ id: v[0] }] : []);
      if (s.startsWith("SELECT * FROM festa_areas WHERE id=$1 AND empresa_id=$2::uuid FOR UPDATE")) {
        const a = areas[String(v[0])];
        return r(a && a.empresa === v[1] ? [{ id: v[0], empresa_id: a.empresa, estabelecimento_id: a.estabelecimento }] : []);
      }
      if (s.startsWith("SELECT id FROM estabelecimentos WHERE id=$1 AND empresa_id=$2::uuid")) return r(unidades[String(v[0])] === v[1] ? [{ id: v[0] }] : []);
      throw new Error(`SQL não simulado: ${s.slice(0, 110)}`);
    },
  };
  const sessao = { usuario_id: ATOR, nome: "Ator", cargo: null, papel: "REPRESENTANTE_AUTORIZADO" };
  const tenant = { empresaComprovada: A, membershipId: MEMBERSHIP_ATOR_A, usuarioId: ATOR, papelAtual: o.papelAtual ?? "REPRESENTANTE_AUTORIZADO" };
  const recusa = Object.assign(new Error("Tenant não comprovado."), { code: "TENANT_NAO_COMPROVADO", httpStatus: 403 });
  const svc = carregar("lib/festas/service.ts", {
    "./importadas": { listarFestasImportadas: async (_tx: unknown, empresaId: string, _cliente: unknown, id: string) => {
      assert.equal(_tx, tx);log.push(`importada(${empresaId},${id})`);
      return empresaId === A && (!id || id === FESTA_A) ? [{ id: FESTA_A, origem: 'IMPORTACAO' }] : [];
    } },
    "./ambiente": { validarAmbienteFesta: async () => undefined }, "./buffet": { escolhasBuffet: [] }, "./perfis": { perfis, nomePerfil }, zod: { z },
    "./politica": { politicaOperacao: () => ({ corrigir: false, motivoObrigatorio: false }) },
    "node:crypto": { createHash, randomUUID }, "./domain": domain, "./schema": schema,
    "./repository": {
      formalizacaoElegivelSql: "TRUE", filhos: async () => ({}), contagens: async () => ({}),
      contrato: async (_t: unknown, id: string, lock: boolean) => { log.push(`contrato(${id},${lock})`); return { id, versao_id: VERSAO, status: "ASSINADO", snapshot: { evento: { convidados: 10 } } }; },
    },
    "../contratos/services/cancelamento.service": { cancelarContratacaoDaFesta: async () => undefined },
    "../clientes/repositories/auditoria.repository": { registrarAuditoria: async () => { escritas.push("auditoria"); } },
    "../pagamentos/services/financeiro-consulta.service": {},
    "../autenticacao/service": { consultarSessao: async (_t: unknown, _x: unknown, lock: boolean) => { log.push(`sessao(${lock})`); return sessao; } },
    "../autenticacao/papeis": { nomePapelSistema },
    "../saas/provar-tenant": {
      provarTenant: async () => { log.push("provarTenant"); if (o.tenant === "recusa") throw recusa; return tenant; },
      revalidarTenant: async () => { log.push("revalidarTenant"); if (o.revalidacaoFalha) throw recusa; },
    },
    "../db/postgres": { db: () => tx, withTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
  });
  return { svc, log, escritas, concedidas };
}

const ctx = { token: "t", requestId: "r", userAgent: null, empresaSolicitada: null };
test('festa importada: prova tenant e capacidade antes da leitura, revalida e não escreve', async () => {
  const a = ambiente();
  assert.deepEqual(await a.svc.consultarFestaImportada(ctx, FESTA_A), { importada: { id: FESTA_A, origem: 'IMPORTACAO' } });
  const leitura = a.log.findIndex(l => l.startsWith('importada('));
  assert(leitura > a.log.findIndex(l => l.startsWith('SELECT id FROM festa_membership_capacidades')));
  assert(a.log.lastIndexOf('revalidarTenant') > leitura);
  assert.deepEqual(a.escritas, []);
  const lista = await a.svc.consultarFestas(ctx) as { importadas: unknown[]; festas: unknown[] };
  assert.deepEqual(lista.importadas, [{ id: FESTA_A, origem: 'IMPORTACAO' }]);
  assert.deepEqual(lista.festas, []);
  for (const id of [FESTA_B, randomUUID()]) await assert.rejects(ambiente().svc.consultarFestaImportada(ctx, id), { status: 404 });
  for (const o of [{ tenant: 'recusa' as const }, { capacidades: false }]) {
    const negada = ambiente(o);
    await assert.rejects(negada.svc.consultarFestaImportada(ctx, FESTA_A));
    assert(!negada.log.some(l => l.startsWith('importada(')));
  }
});
const tarefa = (extra: Record<string, unknown> = {}) => ({ acao: "tarefa", chave: randomUUID(), revisao: 1, versaoId: VERSAO, titulo: "Balões", descricao: "", prioridade: "NORMAL", estado: "PENDENTE", areaId: null, responsavelId: null, prazo: null, ...extra });
const nao404 = (e: unknown) => (e as { status?: number }).status === 404 && /Festa não encontrada/.test((e as Error).message);
const st = (e: unknown) => (e as { status?: number; httpStatus?: number }).status ?? (e as { httpStatus?: number }).httpStatus;

test("E1 comando: ordem sessão → tenant → capacidade DA MEMBERSHIP → posse na empresa → travas → ação → revalidação", async () => {
  const a = ambiente();
  await a.svc.comandarFesta(FESTA_A, tarefa(), ctx);
  const i = (p: string) => a.log.findIndex((l) => l.startsWith(p));
  assert.ok(i("sessao(true)") < i("provarTenant"));
  assert.ok(i("provarTenant") < i("SELECT id FROM festa_membership_capacidades"));
  assert.ok(i("SELECT id FROM festa_membership_capacidades") < i("SELECT f.* FROM festas f JOIN contratos co"));
  assert.ok(i("SELECT f.* FROM festas f JOIN contratos co") < i("contrato(contrato-a,true)"));
  assert.ok(i("contrato(contrato-a,true)") < i("SELECT * FROM festas WHERE id=$1 FOR UPDATE"));
  assert.ok(a.log.lastIndexOf("revalidarTenant") > a.log.findIndex((l) => l.startsWith("INSERT INTO festa_eventos")), "revalida depois da escrita, antes do commit");
  assert.ok(!a.log.some((l) => l.includes("festa_usuario_capacidades")), "nenhuma capacidade global");
});

test("E1 comando: Festa de outra empresa e inexistente ⇒ o mesmo 404, sem trava nem escrita", async () => {
  for (const id of [FESTA_B, randomUUID()]) {
    const a = ambiente();
    await assert.rejects(a.svc.comandarFesta(id, tarefa(), ctx), nao404, id);
    assert.equal(a.log.some((l) => l.startsWith("contrato(") || l.includes("FOR UPDATE")), false, "nenhuma trava do recurso");
    assert.deepEqual(a.escritas, []);
  }
});

test("E1 comando: tenant não comprovado ⇒ 403 antes de ler a Festa; sem capacidade na membership ⇒ 403 antes da posse", async () => {
  const a = ambiente({ tenant: "recusa" });
  await assert.rejects(a.svc.comandarFesta(FESTA_A, tarefa(), ctx), (e: unknown) => st(e) === 403);
  assert.equal(a.log.some((l) => l.includes("FROM festas")), false);
  const b = ambiente({ capacidades: false });
  await assert.rejects(b.svc.comandarFesta(FESTA_A, tarefa(), ctx), (e: unknown) => st(e) === 403);
  assert.equal(b.log.some((l) => l.includes("FROM festas")), false, "capacidade antes do recurso");
  assert.deepEqual([...a.escritas, ...b.escritas], []);
});

test("E1 comando: revogação vista na revalidação desfaz a ação (erro dentro da transação)", async () => {
  await assert.rejects(ambiente({ revalidacaoFalha: true }).svc.comandarFesta(FESTA_A, tarefa(), ctx), (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO");
});

test("E1 comando: responsável e área precisam ser da empresa da Festa", async () => {
  await assert.rejects(ambiente().svc.comandarFesta(FESTA_A, tarefa({ responsavelId: MEMBRO_B }), ctx), /Responsável inativo ou inexistente/);
  await assert.rejects(ambiente().svc.comandarFesta(FESTA_A, tarefa({ areaId: AREA_B }), ctx), /Área inativa ou inexistente/);
  await ambiente().svc.comandarFesta(FESTA_A, tarefa({ responsavelId: COMPARTILHADO, areaId: AREA_A }), ctx);
});

test("056 capacidades: concessão vai para a membership DESTA empresa (compartilhado incluído); conta só de B e inexistente recusadas; papel atual vale", async () => {
  const a = ambiente();
  const conceder = (usuarioId: string) => ({ usuarioId, capacidade: "FESTA_OPERAR", conceder: true, motivo: "Equipe da festa" });
  await a.svc.administrarCapacidade(conceder(COMPARTILHADO), ctx);
  assert.deepEqual(a.concedidas, [{ empresa: A, membership: "m-comp-a", capacidade: "FESTA_OPERAR" }], "membership de A, nunca a de B");
  for (const alvo of [MEMBRO_B, randomUUID()]) {
    const b = ambiente();
    await assert.rejects(b.svc.administrarCapacidade(conceder(alvo), ctx), /Usuário inativo ou inexistente/, alvo);
    assert.deepEqual(b.escritas, [], alvo);
  }
  const r = await a.svc.consultarCapacidades(ctx) as { usuarios: Array<{ id: string }>; concessoes: Array<{ usuario_id: string; empresa: string }> };
  assert.deepEqual(r.usuarios.map((u) => u.id).sort(), [ATOR, MEMBRO_A, COMPARTILHADO].sort());
  assert.ok(r.concessoes.every((c) => c.empresa === A));
  const papel = ambiente({ papelAtual: "ADMINISTRATIVO" });
  await assert.rejects(papel.svc.administrarCapacidade(conceder(MEMBRO_A), ctx), (e: unknown) => st(e) === 403);
  await assert.rejects(papel.svc.aplicarPerfil({ usuarioId: MEMBRO_A, perfil: "EQUIPE" }, ctx), (e: unknown) => st(e) === 403);
  await assert.rejects(papel.svc.consultarCapacidades(ctx), (e: unknown) => st(e) === 403);
  assert.deepEqual(papel.escritas, []);
  await assert.rejects(ambiente().svc.aplicarPerfil({ usuarioId: MEMBRO_B, perfil: "EQUIPE" }, ctx), /Usuário inativo ou inexistente/);
});

test("056 áreas: criadas na empresa comprovada (e na unidade dela); área ou unidade de outra empresa ⇒ não encontrada; sem capacidade ⇒ 403", async () => {
  const a = ambiente();
  await a.svc.administrarArea({ nome: "Salão principal", ativo: true, motivo: "Nova área" }, ctx);
  await a.svc.administrarArea({ nome: "Brinquedoteca", ativo: true, estabelecimentoId: UNIDADE_A, motivo: "Nova área da unidade" }, ctx);
  await a.svc.administrarArea({ id: AREA_A, nome: "Salão 2", ativo: false, motivo: "Renomear" }, ctx);
  for (const [corpo, msg] of [
    [{ id: AREA_B, nome: "Invasão", ativo: true, motivo: "Tentativa" }, /Área não encontrada/],
    [{ nome: "Área baby", ativo: true, estabelecimentoId: UNIDADE_B, motivo: "Unidade alheia" }, /Unidade não encontrada/],
  ] as const) {
    const b = ambiente();
    await assert.rejects(b.svc.administrarArea(corpo, ctx), msg);
    assert.deepEqual(b.escritas, []);
  }
  const semCap = ambiente({ capacidades: false });
  await assert.rejects(semCap.svc.administrarArea({ nome: "Qualquer", ativo: true, motivo: "Sem permissão" }, ctx), (e: unknown) => st(e) === 403);
  assert.deepEqual(semCap.escritas, []);
});

test("E1/056 estrutural: nada global na família Festa (UUID sem empresa, usuários, capacidades, áreas)", () => {
  const fonte = readFileSync("lib/festas/service.ts", "utf8");
  assert.doesNotMatch(fonte, /SELECT \* FROM festas WHERE id=\$1'/, "a busca inicial por UUID solto saiu");
  assert.doesNotMatch(fonte, /festa_usuario_capacidades/, "capacidade global não é lida nem gravada");
  assert.doesNotMatch(fonte, /FROM usuarios_administrativos WHERE ativo ORDER BY nome|FROM usuarios_administrativos ORDER BY nome/, "nenhuma lista global de usuários");
  assert.doesNotMatch(fonte, /FROM festa_areas ORDER BY|FROM festa_areas WHERE id=\$1 AND ativo'/, "nenhuma leitura global de área");
  assert.match(fonte, /FROM festa_areas WHERE empresa_id=\$1::uuid ORDER BY nome/);
  assert.match(fonte, /consultarPainelFinanceiro\(c\.id,tx\)/, "financeiro da Festa no tx da prova");
  for (const f of ["lib/contratos/services/cancelamento.service.ts", "lib/contratos/services/administrativo.service.ts", "lib/autenticacao/usuarios.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /festa_usuario_capacidades/, `${f}: nenhuma capacidade global`);
  }
  assert.match(readFileSync("app/api/admin/festas/route.ts", "utf8"), /empresaSolicitada:request\.nextUrl\.searchParams\.get\('empresaId'\)/);
});
