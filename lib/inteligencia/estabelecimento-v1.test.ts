import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { criarRegistroAgentes } from "./agentes/agentes.ts";
import { construirContextoAutorizado, construirContextoModelo } from "./contexto/construtor.ts";
import { ContextoRecusado } from "./contexto/contrato.ts";
import type { AIResponse, RespostaLeitura } from "./contratos.ts";
import { atenderConversa, type DependenciasConversa } from "./conversa.ts";
import { consolidarCustos } from "./custos.ts";
import { criarDemerzel } from "./demerzel/orquestradora.ts";
import type { CatalogoSkills } from "./extensoes.ts";
import { ferramentas, type PacoteDominio } from "./ferramentas.ts";
import { atenderInteligencia, type DependenciasGateway, type PedidoGateway } from "./gateway.ts";
import { decidirPolitica } from "./politica-v1.ts";
import type { RastreioInteligencia } from "./rastreio.ts";
import { manifestoLeitura, registroCompleto, validarRegistro, type Manifesto } from "./registro-ferramentas.ts";
import { criarCatalogoSkills, repositorioEmMemoria } from "./skills/catalogo.ts";
import { SKILLS_PLATAFORMA } from "./skills/plataforma.ts";

/**
 * Establishment Context V1: unidade só do pedido da tela, provada pelo Core no Tenant Context; escopo COMPANY ou
 * ESTABLISHMENT no Tool Registry; Policy exige unidade para ESTABLISHMENT; contexto, skills, trace e custos escopados;
 * cross-establishment na MESMA empresa recusado.
 */

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const UNIDADE_1 = "aaaaaaaa-1111-4111-8111-000000000001";
const UNIDADE_2 = "aaaaaaaa-2222-4222-8222-000000000002";
const sessao = { id: "s", usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "N", cargo: null, papel: "REPRESENTANTE_AUTORIZADO", autenticado_em: "", expira_em: "", csrf_hash: "" } as unknown as SessaoParaTenant;
const tenant: TenantComprovado = { empresaComprovada: EMPRESA, membershipId: "m", usuarioId: sessao.usuario_id, papelAtual: "REPRESENTANTE_AUTORIZADO" };
const pacote: PacoteDominio = { nome: "Completo", descricao: "Buffet", duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 100, diasPermitidos: [6], ativo: true, vigente: true, arquivadoEm: null };

/** Prova falsa com a MESMA semântica do Core: só a UNIDADE_1 é da empresa com vínculo ativo. */
const provas: string[] = [];
const provar: NonNullable<DependenciasGateway["provarEstabelecimento"]> = async (_tx, t, id) => {
  provas.push(id);
  if (t.empresaComprovada === EMPRESA && id === UNIDADE_1) return { estabelecimentoId: id };
  throw new PacoteAdminError("ESTABELECIMENTO_NAO_COMPROVADO", "Unidade não encontrada.", 404);
};

// ---------------------------------------------------------------- Registry + Policy

test("Registry: escopo COMPANY ou ESTABLISHMENT declarado; leituras V1 são COMPANY (dados do Core sem unidade)", () => {
  const { manifestos, problemas } = registroCompleto([]);
  assert.deepEqual(problemas, []);
  assert.ok(manifestos.every((m) => m.escopoEstabelecimento === "COMPANY"));
  const base = manifestoLeitura(ferramentas.pacotes_disponiveis)!;
  assert.match(validarRegistro([{ ...base, escopoEstabelecimento: "UNIDADE_DO_MODELO" as never }]).join(), /escopo de estabelecimento inválido/);
  assert.deepEqual(validarRegistro([{ ...base, capacidade: "x_por_unidade", escopoEstabelecimento: "ESTABLISHMENT" }]), []);
});

test("Policy: ESTABLISHMENT exige unidade comprovada; COMPANY aceita com ou sem unidade; prévia sem tenant não decide unidade", () => {
  const empresarial = manifestoLeitura(ferramentas.pacotes_disponiveis)!;
  const operacional: Manifesto = { ...empresarial, capacidade: "agenda_da_unidade", escopoEstabelecimento: "ESTABLISHMENT" };
  const base = { papel: "REPRESENTANTE_AUTORIZADO", caminho: "LEITURA" as const, origem: "UI" as const, grupoAtivo: true, grupoAtivoNaEmpresa: true };
  assert.equal(decidirPolitica({ ...base, manifesto: operacional, estabelecimento: null }), "NEGADO_ESTABELECIMENTO");
  assert.equal(decidirPolitica({ ...base, manifesto: operacional, estabelecimento: UNIDADE_1 }), "PERMITIDO");
  assert.equal(decidirPolitica({ ...base, manifesto: operacional }), "PERMITIDO", "avaliação prévia; a regra vale na reavaliação dentro do tenant");
  assert.equal(decidirPolitica({ ...base, manifesto: empresarial, estabelecimento: null }), "PERMITIDO");
  assert.equal(decidirPolitica({ ...base, manifesto: empresarial, estabelecimento: UNIDADE_1 }), "PERMITIDO");
  assert.equal(decidirPolitica({ ...base, papel: "ADMINISTRATIVO", manifesto: { ...operacional, papeisExigidos: ["REPRESENTANTE_AUTORIZADO"] }, estabelecimento: UNIDADE_1 }), "NEGADO_PAPEL", "unidade não substitui papel");
});

// ---------------------------------------------------------------- gateway: prova da unidade

function gateway(opcoes: { provar?: DependenciasGateway["provarEstabelecimento"] } = {}) {
  const rastros: RastreioInteligencia[] = [];
  let dominio = 0;
  const deps: DependenciasGateway = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true" },
    autenticar: async () => sessao,
    withTenantTransaction: async (_s, _e, work) => work({} as DbExecutor, tenant),
    agora: () => new Date("2026-09-29T12:00:00Z"), requestId: () => "req", registrar: (r) => rastros.push({ ...r }), relogio: () => 0,
    portas: { festas: null, clientes: null, pacotes: { listar: async () => { dominio += 1; return [pacote]; } } },
    ...(opcoes.provar !== undefined ? { provarEstabelecimento: opcoes.provar } : {}),
  };
  const pedir = (estabelecimentoSolicitado: string | null) => atenderInteligencia({ lerCorpo: async () => ({ capacidade: "pacotes_disponiveis" }), empresaSolicitada: EMPRESA, estabelecimentoSolicitado }, deps);
  return { pedir, rastros, dominio: () => dominio };
}

test("Gateway: sem unidade ⇒ escopo da empresa, nenhuma prova; unidade comprovada ⇒ trace com estabelecimentoId", async () => {
  provas.length = 0;
  const g = gateway({ provar });
  assert.equal((await g.pedir(null)).status, 200);
  assert.deepEqual(provas, []);
  assert.equal(g.rastros[0].estabelecimentoId, null);
  assert.equal((await g.pedir(UNIDADE_1)).status, 200);
  assert.deepEqual(provas, [UNIDADE_1]);
  assert.equal(g.rastros[1].estabelecimentoId, UNIDADE_1);
});

test("Gateway: outra unidade da MESMA empresa, unidade inexistente ou prova indisponível ⇒ 404 antes de ler; nunca cai para a empresa", async () => {
  for (const [nome, g, unidade] of [
    ["outra unidade da mesma empresa", gateway({ provar }), UNIDADE_2],
    ["id inexistente", gateway({ provar }), "99999999-9999-4999-8999-999999999999"],
    ["id malformado", gateway({ provar }), "../outra"],
    ["sem porta de prova", gateway(), UNIDADE_1],
  ] as const) {
    const r = await g.pedir(unidade);
    assert.equal(r.status, 404, nome);
    assert.equal(g.dominio(), 0, `${nome}: domínio não chamado`);
    assert.equal(g.rastros.at(-1)!.estabelecimentoId, null, nome);
    assert.doesNotMatch(JSON.stringify(r.corpo), /aaaaaaaa|99999999/, `${nome}: o id não volta na resposta`);
  }
});

// ---------------------------------------------------------------- conversa: skills e agentes na unidade

function conversa(repositorio: unknown[]) {
  const alvos: Array<string | null> = [];
  const base = criarCatalogoSkills({ plataforma: SKILLS_PLATAFORMA, repositorio: repositorioEmMemoria(repositorio) });
  const skills: CatalogoSkills = { resolver: async (alvo) => { alvos.push(alvo.estabelecimentoId); return base.resolver(alvo); } };
  const rastros: RastreioInteligencia[] = [];
  const deps: DependenciasConversa = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", AI_DEMERZEL_ENABLED: "true" },
    autenticar: async () => sessao,
    withTenantTransaction: async (_s, _e, work) => work({} as DbExecutor, tenant),
    agora: () => new Date("2026-09-29T12:00:00Z"), requestId: () => "req", registrar: (r) => rastros.push({ ...r }), relogio: () => 0,
    portas: { festas: null, clientes: null }, provarEstabelecimento: provar,
    acoes: null, roteador: null, orquestrador: criarDemerzel(), skills, agentes: criarRegistroAgentes(),
  };
  const perguntar = async (texto: string, estabelecimentoSolicitado: string | null) => {
    const pedido: PedidoGateway = { lerCorpo: async () => ({ texto }), empresaSolicitada: EMPRESA, estabelecimentoSolicitado };
    const r = await atenderConversa(pedido, deps);
    return { status: r.status, data: (r.corpo as { data?: AIResponse }).data };
  };
  return { perguntar, alvos, rastros };
}

test("Conversa: skill resolvida com a unidade COMPROVADA; unidade não comprovada aborta o pedido (sem skill, sem resposta)", async () => {
  const c = conversa([]);
  const ok = await c.perguntar("Redija uma mensagem de confirmação", UNIDADE_1);
  assert.equal(ok.data?.tipo, "agente");
  assert.deepEqual(c.alvos, [UNIDADE_1]);
  assert.equal(c.rastros.at(-1)!.estabelecimentoId, UNIDADE_1);

  const outra = conversa([]);
  const r = await outra.perguntar("Redija uma mensagem de confirmação", UNIDADE_2);
  assert.equal(r.status, 404);
  assert.deepEqual(outra.alvos, []);
});

test("Conversa: pedido que cita outra unidade no TEXTO é recusado; a unidade nunca vem do texto", async () => {
  const c = conversa([]);
  const r = await c.perguntar(`me dá um panorama da operação da unidade ${UNIDADE_2}`, UNIDADE_1);
  assert.equal(r.data?.tipo, "nao_suportado");
  assert.equal(c.rastros.at(-1)!.orquestracao?.parada, "RECUSA_JULGAMENTO");
});

// ---------------------------------------------------------------- Context Builder e custos

test("Context Builder: bloco lido noutra unidade da mesma empresa recusa o contexto; bloco da própria unidade entra", () => {
  const dados: RespostaLeitura = { capacidade: "atencao_hoje", estado: "informativo", resumo: "ok", fatos: [], itens: [], evidencias: [], referencia: { hoje: "2026-09-29", geradoEm: "", fontes: [] } };
  const naUnidade = construirContextoAutorizado({ sessao, tenant: { ...tenant, estabelecimentoComprovado: UNIDADE_1 } as TenantComprovado, contexto: null, capacidades: ["atencao_hoje"] });
  assert.equal(naUnidade.estabelecimentoId, UNIDADE_1);
  assert.doesNotThrow(() => construirContextoModelo(naUnidade, [{ empresaId: EMPRESA, estabelecimentoId: UNIDADE_1, capacidade: "atencao_hoje", resposta: dados }], { finalidade: "EXPLICAR_DADOS" }));
  assert.doesNotThrow(() => construirContextoModelo(naUnidade, [{ empresaId: EMPRESA, estabelecimentoId: null, capacidade: "atencao_hoje", resposta: dados }], { finalidade: "EXPLICAR_DADOS" }), "dado da empresa (COMPANY) pode compor");
  assert.throws(() => construirContextoModelo(naUnidade, [{ empresaId: EMPRESA, estabelecimentoId: UNIDADE_2, capacidade: "atencao_hoje", resposta: dados }], { finalidade: "EXPLICAR_DADOS" }),
    (e: ContextoRecusado) => e instanceof ContextoRecusado && e.motivo === "OUTRO_ESTABELECIMENTO");
  const daEmpresa = construirContextoAutorizado({ sessao, tenant, contexto: null, capacidades: ["atencao_hoje"] });
  assert.equal(daEmpresa.estabelecimentoId, null);
  assert.throws(() => construirContextoModelo(daEmpresa, [{ empresaId: EMPRESA, estabelecimentoId: UNIDADE_1, capacidade: "atencao_hoje", resposta: dados }], { finalidade: "EXPLICAR_DADOS" }), /OUTRO_ESTABELECIMENTO|estabelecimento/i);
});

test("Custos: uso com unidade comprovada aparece por estabelecimento; sem unidade, na empresa", () => {
  const u = (estabelecimentoId: string | null) => ({ estabelecimentoId, capacidade: "c", provedor: "OPENAI", modelo: "m", dia: "2026-09-29", mes: "2026-09", moeda: "USD", chamadas: 1, tokensEntrada: 1, tokensSaida: 1, tokensDesconhecidos: 0, custoMicros: 10, custoDesconhecido: 0 });
  const v = consolidarCustos({ disponivel: true, usos: [u(UNIDADE_1), u(null)], reservas: [] }, "2026-09", "USD");
  assert.equal(v.porEstabelecimento[UNIDADE_1].custoMicros, 10);
  assert.equal(v.porEstabelecimento.EMPRESA.custoMicros, 10);
});
