import assert from "node:assert/strict";
import test from "node:test";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { confirmarOperacao, iniciarRascunho, type DependenciasHumanGate } from "./acoes/human-gate.ts";
import { criarAcoesPacote, type PortaPacotes } from "./acoes/pacotes.ts";
import type { FerramentaAcao } from "./acoes/tipos.ts";
import type { HumanGateDraft } from "./contratos.ts";
import { ferramentas, type PacoteDominio } from "./ferramentas.ts";
import { atenderInteligencia, type DependenciasGateway } from "./gateway.ts";
import { decidirPolitica, exigirPolitica, type EntradaPolitica } from "./politica-v1.ts";
import type { RastreioInteligencia } from "./rastreio.ts";
import { SUGESTOES, manifestoAcao, manifestoLeitura } from "./registro-ferramentas.ts";

const leitura = manifestoLeitura(ferramentas.pacotes_disponiveis)!;
const criar = criarAcoesPacote({} as PortaPacotes).find((a) => a.capacidade === "criar_pacote")!;
const confirmavel = manifestoAcao({ ferramenta: criar.nome, capacidade: criar.capacidade, classe: criar.classe, grupo: criar.grupo, papeis: criar.papeis })!;
const proibida = manifestoAcao({ ferramenta: "negada.sql", capacidade: "sql", classe: "DENY", grupo: "ADMIN_ACTIONS", papeis: [] })!;
const sugestao = SUGESTOES[0];

const base: EntradaPolitica = { papel: "ADMINISTRATIVO", manifesto: leitura, caminho: "LEITURA", origem: "UI", grupoAtivo: true, grupoAtivoNaEmpresa: true };

// ---------------------------------------------------------------- tabela de decisão

test("Policy V1: tabela de decisão (a primeira negação vence)", () => {
  const casos: Array<[string, Partial<EntradaPolitica>, string]> = [
    ["leitura permitida", {}, "PERMITIDO"],
    ["sem manifesto", { manifesto: null }, "NEGADO_SEM_MANIFESTO"],
    ["FORBIDDEN mesmo com tudo ativo", { manifesto: proibida, caminho: "HUMAN_GATE" }, "NEGADO_DENY"],
    ["CONFIRM pelo caminho de leitura", { manifesto: confirmavel }, "NEGADO_CLASSE"],
    ["READ pelo Human Gate", { caminho: "HUMAN_GATE" }, "NEGADO_CLASSE"],
    ["SUGGEST pelo caminho de leitura", { manifesto: sugestao }, "NEGADO_CLASSE"],
    ["SUGGEST pelo caminho certo", { manifesto: sugestao, caminho: "SUGESTAO" }, "PERMITIDO"],
    ["confirmação vinda do modelo", { manifesto: confirmavel, caminho: "CONFIRMACAO", origem: "INTENCAO_MODELO", papel: "REPRESENTANTE_AUTORIZADO" }, "NEGADO_ORIGEM"],
    ["confirmação vinda do JEV", { manifesto: confirmavel, caminho: "CONFIRMACAO", origem: "INTENCAO_JEV", papel: "REPRESENTANTE_AUTORIZADO" }, "NEGADO_ORIGEM"],
    ["confirmação vinda das regras", { manifesto: confirmavel, caminho: "CONFIRMACAO", origem: "INTENCAO_DETERMINISTICA", papel: "REPRESENTANTE_AUTORIZADO" }, "NEGADO_ORIGEM"],
    ["confirmação humana", { manifesto: confirmavel, caminho: "CONFIRMACAO", origem: "HUMAN_GATE", papel: "REPRESENTANTE_AUTORIZADO" }, "PERMITIDO"],
    ["papel desconhecido", { papel: "SUPERADMIN" }, "NEGADO_PAPEL"],
    ["papel vazio", { papel: "" }, "NEGADO_PAPEL"],
    ["papel fora do exigido", { manifesto: confirmavel, caminho: "HUMAN_GATE", papel: "ADMINISTRATIVO" }, "NEGADO_PAPEL"],
    ["flag desligada", { grupoAtivo: false }, "NEGADO_FLAG"],
    ["fora da allowlist da empresa", { grupoAtivoNaEmpresa: false }, "NEGADO_FLAG"],
    ["antes do tenant (allowlist ainda não avaliada)", { grupoAtivoNaEmpresa: null }, "PERMITIDO"],
  ];
  for (const [nome, delta, esperado] of casos) assert.equal(decidirPolitica({ ...base, ...delta }), esperado, nome);
});

test("Policy V1: exigir falha fechada com mensagem humana e sem vazar regra", () => {
  assert.throws(() => exigirPolitica({ ...base, papel: "X" }), (e: Error & { code?: string; httpStatus?: number }) => e.code === "INTELIGENCIA_NAO_AUTORIZADA" && e.httpStatus === 403 && !/papeis|ADMINISTRATIVO|REPRESENTANTE/.test(e.message));
  assert.throws(() => exigirPolitica({ ...base, manifesto: null }), (e: Error & { httpStatus?: number }) => e.httpStatus === 400);
  assert.throws(() => exigirPolitica({ ...base, grupoAtivoNaEmpresa: false }), (e: Error & { httpStatus?: number }) => e.httpStatus === 503);
  assert.equal(exigirPolitica(base), "PERMITIDO");
});

// ---------------------------------------------------------------- gateway: papel da MEMBERSHIP

const empresa = "11111111-1111-4111-8111-111111111111";
const sessao = { id: "s", usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "N", cargo: null, papel: "ADMINISTRATIVO", autenticado_em: "", expira_em: "", csrf_hash: "" } as unknown as SessaoParaTenant;
const tenantCom = (papelAtual: string) => ({ empresaComprovada: empresa, membershipId: "m", usuarioId: sessao.usuario_id, papelAtual }) as unknown as TenantComprovado;
const pacote: PacoteDominio = { nome: "Completo", descricao: "Buffet", duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 100, diasPermitidos: [6], ativo: true, vigente: true, arquivadoEm: null };

function gateway(papelAtual: string, env: Record<string, string> = {}) {
  const rastros: RastreioInteligencia[] = [];
  let chamadasDominio = 0;
  const deps: DependenciasGateway = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", ...env },
    autenticar: async () => sessao,
    withTenantTransaction: async (_s, _e, work) => work({} as never, tenantCom(papelAtual)),
    agora: () => new Date("2026-09-29T12:00:00Z"),
    requestId: () => "req",
    registrar: (r) => rastros.push({ ...r }),
    relogio: () => 0,
    portas: { festas: null, clientes: null, pacotes: { listar: async () => { chamadasDominio += 1; return [pacote]; } } },
  };
  return { deps, rastros, dominio: () => chamadasDominio };
}

const pedir = (deps: DependenciasGateway) => atenderInteligencia({ lerCorpo: async () => ({ capacidade: "pacotes_disponiveis" }), empresaSolicitada: empresa }, deps);

test("Gateway: sessão ADMINISTRATIVO mas membership NESTA empresa sem papel conhecido ⇒ 403, domínio não é chamado", async () => {
  const g = gateway("CONVIDADO");
  const r = await pedir(g.deps);
  assert.equal(r.status, 403);
  assert.equal(g.dominio(), 0);
  assert.equal(g.rastros[0].politica, "NEGADO_PAPEL");
});

test("Gateway: membership válida ⇒ PERMITIDO registrado no trace", async () => {
  const g = gateway("REPRESENTANTE_AUTORIZADO");
  const r = await pedir(g.deps);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(g.rastros[0].politica, "PERMITIDO");
  assert.equal(g.dominio(), 1);
});

// ---------------------------------------------------------------- Human Gate: autoridade de AGORA

const semRepositorio = {
  repositorio: { disponivel: async () => { throw new Error("não deveria chegar ao repositório"); } },
  agora: () => new Date("2026-09-29T12:00:00Z"),
  novoId: () => "op",
  ttlConfirmacaoSegundos: 600,
} as unknown as DependenciasHumanGate;

const ctx = (papelAtual: string) => ({ tx: {} as never, tenant: tenantCom(papelAtual), sessao: { usuario_id: sessao.usuario_id, papel: "ADMINISTRATIVO" }, correlationId: "c" });

test("Human Gate: ação CONFIRM sem manifesto no Tool Registry não abre rascunho (antes de qualquer persistência)", async () => {
  const semManifesto: FerramentaAcao = { ...criar, nome: "whatsapp.enviar", capacidade: "enviar_whatsapp" };
  await assert.rejects(iniciarRascunho(semManifesto, "envie", ctx("REPRESENTANTE_AUTORIZADO"), semRepositorio), (e: Error & { code?: string }) => e.code === "CAPACIDADE_DESCONHECIDA");
});

test("Human Gate: papel rebaixado depois do rascunho ⇒ confirmação negada (aprovação antiga não vale)", async () => {
  const draft: HumanGateDraft = {
    operacaoId: "op", correlationId: "c", idempotencyKey: "k", capacidade: "criar_pacote", ferramenta: criar.nome, empresaId: empresa, usuarioId: sessao.usuario_id,
    estado: "AGUARDANDO_CONFIRMACAO", versao: 2, payload: {}, payloadHash: "h", expiraEm: "2026-09-29T13:00:00Z", criadoEm: "", atualizadoEm: "", resultado: null,
  };
  await assert.rejects(
    confirmarOperacao(criar, draft, { versao: 2, payloadHash: "h" }, { ...ctx("ADMINISTRATIVO"), flagAtiva: true }, semRepositorio),
    (e: Error & { httpStatus?: number }) => e.httpStatus === 403,
  );
  await assert.rejects(
    confirmarOperacao(criar, { ...draft, empresaId: "22222222-2222-4222-8222-222222222222" }, { versao: 2, payloadHash: "h" }, { ...ctx("REPRESENTANTE_AUTORIZADO"), flagAtiva: true }, semRepositorio),
    (e: Error & { httpStatus?: number }) => e.httpStatus === 404,
    "rascunho de outra empresa responde como inexistente",
  );
});
