import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { criarAcoesPacote, type PortaPacotes } from "./acoes/pacotes.ts";
import { acoesNegadas } from "./acoes/registro.ts";
import type { FerramentaAcao } from "./acoes/tipos.ts";
import type { DescricaoAcao } from "./extensoes.ts";
import { ferramentas, type PacoteDominio } from "./ferramentas.ts";
import { atenderInteligencia, comPrazo, type DependenciasGateway } from "./gateway.ts";
import { criarAcaoImportacao, type PortaImportacao } from "./importacao/acao.ts";
import { montarPacotesDisponiveis } from "./leituras/pacotes.ts";
import type { RastreioInteligencia } from "./rastreio.ts";
import {
  CLASSES_V1, SUGESTOES, manifestoAcao, manifestoLeitura, registroCompleto, saidaValida, validarRegistro, type Manifesto,
} from "./registro-ferramentas.ts";

const descrever = (a: FerramentaAcao): DescricaoAcao => ({
  capacidade: a.capacidade, ferramenta: a.nome, classe: a.classe, grupo: a.grupo, papeis: a.papeis, descricao: a.descricao, origem: a.origem ?? "CONVERSA",
});

/** Ações reais das features (as portas nunca são chamadas: só a construção). */
function acoesReais(): DescricaoAcao[] {
  return [
    ...criarAcoesPacote({} as PortaPacotes),
    ...acoesNegadas(),
    criarAcaoImportacao({} as PortaImportacao),
  ].map(descrever);
}

// ---------------------------------------------------------------- manifesto completo

test("Registry: toda leitura, sugestão e ação real tem manifesto completo e o registro é válido", () => {
  const { manifestos, problemas } = registroCompleto(acoesReais());
  assert.deepEqual(problemas, []);
  const classes = new Set(manifestos.map((m) => m.classe));
  for (const c of CLASSES_V1) assert.ok(classes.has(c), `sem nenhuma entrada ${c}`);
  for (const m of manifestos) {
    for (const campo of ["nome", "capacidade", "dominio", "classe", "papeisExigidos", "grupoExigido", "escopoTenant", "escopoEstabelecimento", "saida", "prazoMs", "idempotencia", "auditoria", "executor"] as const) {
      assert.ok(m[campo] !== undefined, `${m.capacidade}.${campo}`);
    }
    assert.equal(m.escopoTenant, "EMPRESA_COMPROVADA");
  }
  assert.equal(manifestos.filter((m) => m.classe === "READ").length, Object.keys(ferramentas).length);
});

test("Registry: não existe ferramenta executável de SQL/shell; 'sql' só existe como FORBIDDEN sem papel", () => {
  const { manifestos } = registroCompleto(acoesReais());
  const executaveis = manifestos.filter((m) => m.executor !== "NENHUM");
  for (const m of executaveis) assert.doesNotMatch(`${m.nome} ${m.capacidade}`, /sql|shell|exec|eval|bash|query/i);
  const sql = manifestos.find((m) => m.capacidade === "sql");
  assert.equal(sql?.classe, "FORBIDDEN");
  assert.deepEqual(sql?.papeisExigidos, []);
  assert.equal(sql?.idempotencia, "NUNCA_EXECUTA");
});

test("Registry: nenhuma entrada READ aceita empresa, tenant, usuário, papel ou estabelecimento", () => {
  for (const f of Object.values(ferramentas)) {
    const m = manifestoLeitura(f)!;
    for (const chave of ["empresaId", "tenantId", "usuarioId", "papel", "estabelecimentoId", "role"]) {
      for (const base of [{}, { id: "00000000-0000-4000-8000-000000000000" }, { dia: "hoje" }, { tema: "pacotes" }]) {
        assert.equal(m.entrada!.safeParse({ ...base, [chave]: "x" }).success, false, `${f.capacidade} aceitou ${chave}`);
      }
    }
  }
});

test("Registry: CONFIRM só pelo Human Gate com auditoria de negócio; SUGGEST sem efeito", () => {
  const { manifestos } = registroCompleto(acoesReais());
  for (const m of manifestos.filter((x) => x.classe === "CONFIRM")) {
    assert.equal(m.executor, "HUMAN_GATE");
    assert.equal(m.idempotencia, "OPERACAO_UNICA_HUMAN_GATE");
    assert.equal(m.auditoria, "TRACE_IA_E_AUDITORIA_NEGOCIO");
    assert.ok(m.papeisExigidos.length > 0);
  }
  for (const m of SUGESTOES) assert.equal(m.idempotencia, "SEM_EFEITO");
});

test("Registry: validação pega os erros de registro (fail-closed na composição)", () => {
  const base = manifestoLeitura(ferramentas.pacotes_disponiveis)!;
  const casos: Array<[string, Manifesto, RegExp]> = [
    ["entrada frouxa", { ...base, capacidade: "x_frouxa", entrada: z.object({}).passthrough() }, /entrada aceita empresaId/],
    ["sql disfarçado", { ...base, nome: "banco.sql.query", capacidade: "consulta_sql" }, /execução arbitrária/],
    ["forbidden com papel", { ...base, capacidade: "x_proibida", classe: "FORBIDDEN", papeisExigidos: ["ADMINISTRATIVO"], idempotencia: "NUNCA_EXECUTA", executor: "NENHUM" }, /FORBIDDEN com papel/],
    ["confirm sem gate", { ...base, capacidade: "x_confirm", classe: "CONFIRM", executor: "GATEWAY" }, /CONFIRM fora do Human Gate/],
    ["read sem papel", { ...base, capacidade: "x_sem_papel", papeisExigidos: [] }, /sem papel exigido/],
    ["prazo absurdo", { ...base, capacidade: "x_prazo", prazoMs: 600_000 }, /prazo fora/],
    ["tenant do pedido", { ...base, capacidade: "x_tenant", escopoTenant: "PEDIDO" as never }, /tenant não comprovado/],
  ];
  for (const [nome, m, esperado] of casos) assert.match(validarRegistro([m]).join("\n"), esperado, nome);
  assert.match(validarRegistro([base, base]).join("\n"), /capacidade duplicada/);
});

test("Registry: ação registrada por uma feature sem manifesto não é oferecida", () => {
  const nova: DescricaoAcao = { capacidade: "enviar_whatsapp", ferramenta: "whatsapp.enviar", classe: "CONFIRM", grupo: "ADMIN_ACTIONS", papeis: ["ADMINISTRATIVO"], descricao: "x", origem: "CONVERSA" };
  assert.equal(manifestoAcao(nova), null);
  assert.deepEqual(registroCompleto([nova]).problemas, ["ação sem manifesto: enviar_whatsapp"]);
});

// ---------------------------------------------------------------- outputSchema

const contexto = { hoje: "2026-09-29", geradoEm: "2026-09-29T00:00:00Z", portas: { festas: null, clientes: null } };
const pacote = (descricao: string | null): PacoteDominio => ({ nome: "Completo", descricao, duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 100, diasPermitidos: [6], ativo: true, vigente: true, arquivadoEm: null });

test("Saída: resposta real passa; chave sensível, campo extra ou texto gigante não passam", () => {
  const ok = montarPacotesDisponiveis([pacote("Buffet")], contexto);
  assert.equal(saidaValida("RESPOSTA_LEITURA", ok), true);
  assert.equal(saidaValida("RESPOSTA_LEITURA", { ...ok, cpf: "123" }), false);
  assert.equal(saidaValida("RESPOSTA_LEITURA", { ...ok, itens: [{ ...ok.itens[0], telefone: "11" }] }), false);
  assert.equal(saidaValida("RESPOSTA_LEITURA", { ...ok, extra: 1 }), false);
  assert.equal(saidaValida("RESPOSTA_LEITURA", montarPacotesDisponiveis([pacote("x".repeat(5000))], contexto)), false);
  assert.equal(saidaValida("SUGESTAO", ok), false, "saída sem schema declarado nunca passa");
});

// ---------------------------------------------------------------- gateway aplica o manifesto

const empresa = "11111111-1111-4111-8111-111111111111";
const sessao = { id: "s", usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "N", cargo: null, papel: "ADMINISTRATIVO", autenticado_em: "", expira_em: "", csrf_hash: "" } as unknown as SessaoParaTenant;
const tenant = { empresaComprovada: empresa, membershipId: "m", usuarioId: sessao.usuario_id, papelAtual: "ADMINISTRATIVO" } as unknown as TenantComprovado;

function gateway(listar: () => Promise<readonly PacoteDominio[]>, prazoMaximoMs?: number) {
  const rastros: RastreioInteligencia[] = [];
  let transacoes = 0;
  const deps: DependenciasGateway = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true" },
    autenticar: async () => sessao,
    withTenantTransaction: async (_s, _e, work) => { transacoes += 1; return work({} as never, tenant); },
    agora: () => new Date("2026-09-29T12:00:00Z"),
    requestId: () => "req",
    registrar: (r) => rastros.push({ ...r }),
    relogio: () => 0,
    portas: { festas: null, clientes: null, pacotes: { listar: async () => listar() } },
    ...(prazoMaximoMs ? { prazoMaximoMs } : {}),
  };
  return { deps, rastros, transacoes: () => transacoes };
}

const pedir = (deps: DependenciasGateway, parametros?: unknown) =>
  atenderInteligencia({ lerCorpo: async () => ({ capacidade: "pacotes_disponiveis", ...(parametros === undefined ? {} : { parametros }) }), empresaSolicitada: empresa }, deps);

test("Gateway: entrada fora do schema do manifesto ⇒ 400 antes de qualquer transação", async () => {
  const g = gateway(async () => [pacote("x")]);
  const r = await pedir(g.deps, { empresaId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(r.status, 400);
  assert.equal(g.transacoes(), 0);
});

test("Gateway: prazo excedido ⇒ fallback 503 (TEMPO), nada entregue", async () => {
  const g = gateway(() => new Promise((resolver) => setTimeout(() => resolver([pacote("x")]), 200)), 20);
  const r = await pedir(g.deps);
  assert.equal(r.status, 503);
  assert.equal(r.corpo.ok, false);
  assert.equal(g.rastros[0].causa, "TEMPO");
  assert.equal(g.rastros[0].fallback, true);
  assert.deepEqual(g.rastros[0].ferramentasExecutadas, []);
});

test("Gateway: saída fora do schema ⇒ fallback 503 (SAIDA), nada entregue", async () => {
  const g = gateway(async () => [pacote("x".repeat(5000))]);
  const r = await pedir(g.deps);
  assert.equal(r.status, 503);
  assert.equal(g.rastros[0].causa, "SAIDA");
  assert.doesNotMatch(JSON.stringify(r.corpo), /xxxxx/);
});

test("Gateway: caminho feliz entrega a saída validada; teto operacional nunca aumenta o prazo", async () => {
  const g = gateway(async () => [pacote("Buffet")], 60_000);
  const r = await pedir(g.deps);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(g.rastros[0].fallback, false);
  await assert.rejects(comPrazo(10, () => new Promise((resolver) => setTimeout(resolver, 100))), /INTELIGENCIA_TEMPO_ESGOTADO|indispon|possível/);
});
