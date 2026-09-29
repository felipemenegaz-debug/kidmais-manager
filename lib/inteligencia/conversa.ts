import { z } from "zod";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { AtencaoHoje } from "./atencao-hoje.ts";
import type { AIResponse, ContextoTela, RespostaLeitura } from "./contratos.ts";
import type { ClassificadorAuxiliar, ContextoExtensao, ModuloAcoes } from "./extensoes.ts";
import { ferramentaRegistrada, ferramentas } from "./ferramentas.ts";
import { grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva, jevAtivo } from "./flags.ts";
import {
  classificar, executarLeitura, exigirGrupoNaEmpresa, pedidoInvalido, recursoDesativado,
  type DependenciasGateway, type PedidoGateway, type RespostaGateway,
} from "./gateway.ts";
import { interpretarComModelo, interpretarDeterministico, type CapacidadeCatalogo, type Intencao } from "./intencao.ts";
import type { RoteadorModelos } from "./modelos/roteador.ts";
import { avaliarPolitica } from "./politica.ts";
import { anotarUsoModelo, novoRastreio, type RastreioInteligencia } from "./rastreio.ts";

/**
 * Orquestrador do drawer "Perguntar ao Kidmais".
 *
 * texto → intenção (regras; modelo só como fallback) → capacidade registrada → política →
 *   READ: mesma execução do gateway;
 *   CONFIRM: rascunho sob Human Gate, pelo módulo de ações (feature ACTIONS), que nunca executa aqui;
 *   DENY / sem capacidade / sem módulo de ações: resposta honesta, sem inventar ferramenta.
 *
 * O CORE não importa a feature de ações: recebe um `ModuloAcoes` opcional por dependência.
 * Estado da conversa: só o rascunho persistido (Kidmais controla); nenhuma memória do modelo.
 */
export const LIMITE_TEXTO = 300;

const contextoSchema = z.object({
  tela: z.enum(["dashboard", "festa", "cliente", "contrato", "financeiro", "pacotes", "geral"]),
  entidadeId: z.string().uuid().optional(),
}).strict();

const pedidoSchema = z.object({
  texto: z.string().trim().min(1).max(LIMITE_TEXTO),
  contexto: contextoSchema.optional(),
  operacaoId: z.string().uuid().optional(),
}).strict();

export type DependenciasConversa = DependenciasGateway & {
  /** Null quando a feature de ações não está instalada: pedidos de ação respondem "ainda não". */
  acoes: ModuloAcoes | null;
  /** Null quando não há provedor configurado: só regras determinísticas. */
  roteador: RoteadorModelos | null;
  /** Classificador auxiliar (JEV), opcional: só sugere rota; indisponível ⇒ roteamento normal. */
  classificador?: ClassificadorAuxiliar | null;
};

/** Teto de espera pelo classificador auxiliar: nunca atrasa a resposta além disso. */
export const LIMITE_AUXILIAR_MS = 800;

const MENSAGEM_FALLBACK = "Não foi possível responder agora. O restante do sistema continua disponível.";

/**
 * Papel para a política: o da membership comprovada nesta transação (UX/056, F1) — nunca o papel global da
 * sessão, que não é autoridade de empresa. Sem o Tenant Context do UX (estágio CORE sozinho), o da sessão.
 */
function papelParaPolitica(sessao: SessaoParaTenant, tenant: TenantComprovado): string {
  let papel = sessao.papel;
  return papel;
}

/** Catálogo que o operador pode usar agora: filtra por papel e flags; ações de tela ficam fora. */
export function catalogoDisponivel(env: DependenciasGateway["env"], papel: string, acoes: ModuloAcoes | null): CapacidadeCatalogo[] {
  const leituras = Object.values(ferramentas)
    .filter((f) => grupoAtivo(env, f.grupo) && avaliarPolitica({ papel }, f, "LEITURA") === "PERMITIDO")
    .map((f): CapacidadeCatalogo => ({ id: f.capacidade, descricao: f.descricao, tipo: "leitura", ...(f.entidade ? { entidade: f.entidade } : {}) }));
  const doModulo = (acoes?.todas() ?? [])
    .filter((a) => a.origem !== "TELA")
    .filter((a) => a.classe === "DENY" || (grupoAtivo(env, a.grupo) && avaliarPolitica({ papel }, a, "HUMAN_GATE") === "PERMITIDO"))
    .map((a): CapacidadeCatalogo => ({ id: a.capacidade, descricao: a.descricao, tipo: "acao" }));
  return [...leituras, ...doModulo];
}

const SUGESTOES_PADRAO = ["O que precisa da minha atenção hoje?", "Quais contratos estão pendentes?", "Como está a agenda de hoje?", "Quanto recebemos este mês?"];

function naoSuportado(mensagem: string): AIResponse {
  return { tipo: "nao_suportado", mensagem, sugestoes: SUGESTOES_PADRAO };
}

const ENTIDADE_TEXTO = { festa: "festa", cliente: "cliente", contrato: "contrato" } as const;

/**
 * Regras → classificador auxiliar (JEV) → modelo. A sugestão do auxiliar só vale se for uma LEITURA do
 * catálogo que o operador pode usar agora (papel + flags) ou um encaminhamento a atendimento humano.
 * Sugestão de ação, capacidade fora do catálogo, erro ou demora ⇒ ignorada (fail-safe).
 */
async function consultarAuxiliar(texto: string, contexto: ContextoTela | null, sessao: SessaoParaTenant, deps: DependenciasConversa): Promise<Intencao | null> {
  const auxiliar = deps.classificador;
  if (!auxiliar || !jevAtivo(deps.env)) return null;
  const catalogo = catalogoDisponivel(deps.env, sessao.papel, deps.acoes).map((c) => ({ id: c.id, tipo: c.tipo }));
  const controle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<null>((ok) => { timer = setTimeout(() => { controle.abort(); ok(null); }, LIMITE_AUXILIAR_MS); });
  let resultado: Awaited<ReturnType<ClassificadorAuxiliar["sugerirRota"]>>;
  try {
    resultado = await Promise.race([auxiliar.sugerirRota(texto.slice(0, LIMITE_TEXTO), catalogo, controle.signal), limite]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const sugestao = resultado?.sugestao;
  if (!sugestao) return null;
  if (sugestao.tipo === "HUMANO") return { tipo: "revisao_humana" };
  if (sugestao.tipo !== "LEITURA") return null;
  const ferramenta = ferramentaRegistrada(sugestao.capacidade);
  if (!ferramenta || !catalogo.some((c) => c.id === sugestao.capacidade && c.tipo === "leitura")) return null;
  const origem = "INTENCAO_JEV" as const;
  if (ferramenta.entidade) {
    if (contexto?.tela === ferramenta.entidade && contexto.entidadeId) return { tipo: "leitura", capacidade: sugestao.capacidade, parametros: { id: contexto.entidadeId }, origem };
    return { tipo: "precisa_contexto", capacidade: sugestao.capacidade, entidade: ferramenta.entidade };
  }
  return { tipo: "leitura", capacidade: sugestao.capacidade, parametros: {}, origem };
}

async function resolverIntencao(texto: string, contexto: ContextoTela | null, sessao: SessaoParaTenant, pedido: PedidoGateway, deps: DependenciasConversa, rastreio: RastreioInteligencia): Promise<Intencao> {
  const deterministica = interpretarDeterministico(texto, contexto);
  if (deterministica.tipo !== "nenhuma") return deterministica;
  const auxiliar = await consultarAuxiliar(texto, contexto, sessao, deps);
  if (auxiliar) {
    rastreio.intencao = "INTENCAO_JEV";
    return auxiliar;
  }
  if (!deps.roteador?.disponivelPara("CLASSIFICAR_INTENCAO")) return deterministica;
  // O modelo só é chamado com o tenant comprovado (orçamento/uso por empresa) e FORA de transação.
  const tenant = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (_tx, comprovado) => comprovado);
  rastreio.empresaId = tenant.empresaComprovada;
  if (!grupoAtivoParaEmpresa(deps.env, "READ", tenant.empresaComprovada)) recursoDesativado();
  const { intencao, roteado } = await interpretarComModelo(texto, contexto, catalogoDisponivel(deps.env, papelParaPolitica(sessao, tenant), deps.acoes), deps.roteador, {
    empresaId: tenant.empresaComprovada,
    capacidade: "classificar_intencao",
    correlationId: rastreio.correlationId ?? rastreio.requestId,
    hoje: hojeBrasilia(deps.agora()),
  });
  anotarUsoModelo(rastreio, roteado.usos);
  return intencao;
}

export async function atenderConversa(pedido: PedidoGateway, deps: DependenciasConversa): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio = novoRastreio("inteligencia.conversa", deps.requestId());
  try {
    if (!inteligenciaAtiva(deps.env) || !grupoAtivo(deps.env, "READ")) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;
    let entrada: z.infer<typeof pedidoSchema>;
    try {
      entrada = pedidoSchema.parse(await pedido.lerCorpo());
    } catch (error) {
      pedidoInvalido(error);
    }
    const contextoExtensao = (tx: ContextoExtensao["tx"], tenant: ContextoExtensao["tenant"]): ContextoExtensao => ({ tx, tenant, sessao, correlationId: rastreio.correlationId ?? rastreio.requestId });

    // Continuação de rascunho: a resposta do operador só edita o rascunho do próprio tenant e usuário.
    if (entrada.operacaoId) {
      const acoes = deps.acoes;
      if (!acoes || !grupoAtivo(deps.env, "ADMIN_ACTIONS")) recursoDesativado();
      rastreio.intencao = "UI";
      const operacaoId = entrada.operacaoId;
      const resultado = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
        rastreio.empresaId = tenant.empresaComprovada;
        exigirGrupoNaEmpresa(deps.env, "ADMIN_ACTIONS", tenant);
        return acoes.responder(operacaoId, entrada.texto, contextoExtensao(tx, tenant));
      });
      rastreio.capacidade = resultado.capacidade;
      rastreio.ferramenta = resultado.ferramenta;
      rastreio.ferramentasSolicitadas = [resultado.ferramenta];
      rastreio.humanGate = resultado.resposta.tipo === "preview" ? "PREVIEW" : "RASCUNHO";
      rastreio.estado = resultado.resposta.tipo;
      return { status: 200, corpo: { ok: true, data: resultado.resposta } };
    }

    const contexto = entrada.contexto ?? null;
    const intencao = await resolverIntencao(entrada.texto, contexto, sessao, pedido, deps, rastreio);
    let resposta: AIResponse;
    if (intencao.tipo === "revisao_humana") {
      rastreio.estado = "revisao_humana";
      resposta = naoSuportado("Esse pedido precisa de uma pessoa da equipe. Encaminhe pelo atendimento; o Kidmais não responde nem age sozinho neste caso.");
    } else if (intencao.tipo === "nenhuma") {
      rastreio.estado = "nao_suportado";
      resposta = naoSuportado("Ainda não sei responder isso pelo Kidmais. Veja o que consigo fazer agora:");
    } else if (intencao.tipo === "precisa_contexto") {
      rastreio.capacidade = intencao.capacidade;
      rastreio.estado = "precisa_contexto";
      resposta = { tipo: "precisa_contexto", mensagem: `Abra a ${ENTIDADE_TEXTO[intencao.entidade]} e pergunte por ali: assim eu sei de qual ${ENTIDADE_TEXTO[intencao.entidade]} você está falando.` };
    } else if (intencao.tipo === "leitura") {
      rastreio.intencao = intencao.origem;
      const ferramenta = ferramentaRegistrada(intencao.capacidade);
      if (!ferramenta) {
        resposta = naoSuportado("Essa análise ainda não está disponível no Kidmais.");
      } else {
        const dados = await executarLeitura(ferramenta, intencao.parametros, sessao, pedido.empresaSolicitada, deps, rastreio);
        resposta = { tipo: "resposta", dados: dados as unknown as RespostaLeitura | AtencaoHoje };
      }
    } else {
      rastreio.intencao = intencao.origem;
      rastreio.capacidade = intencao.capacidade;
      const acoes = deps.acoes;
      const acao = acoes?.descrever(intencao.capacidade) ?? null;
      if (!acoes || !acao) {
        resposta = naoSuportado("Essa ação ainda não está disponível no Kidmais.");
      } else if (acao.origem === "TELA") {
        resposta = naoSuportado("Essa ação começa pela tela própria (por exemplo, Contratos › Importar contrato antigo).");
      } else if (acao.classe === "DENY") {
        rastreio.politica = "NEGADO_DENY";
        rastreio.humanGate = "RECUSADO";
        resposta = naoSuportado(acao.mensagemNegada ?? "Essa ação não é feita pelo Kidmais.");
      } else if (!grupoAtivo(deps.env, acao.grupo)) {
        rastreio.politica = "NEGADO_FLAG";
        resposta = naoSuportado("Criar e alterar cadastros pelo Kidmais ainda não está liberado. Use a tela correspondente.");
      } else {
        rastreio.ferramenta = acao.ferramenta;
        rastreio.ferramentasSolicitadas = [acao.ferramenta];
        resposta = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
          rastreio.empresaId = tenant.empresaComprovada;
          rastreio.politica = avaliarPolitica({ papel: papelParaPolitica(sessao, tenant) }, acao, "HUMAN_GATE");
          if (!grupoAtivoParaEmpresa(deps.env, acao.grupo, tenant.empresaComprovada)) {
            return naoSuportado("Criar e alterar cadastros pelo Kidmais ainda não está liberado para esta empresa.");
          }
          return (await acoes.iniciar(acao.capacidade, entrada.texto, contextoExtensao(tx, tenant))).resposta;
        });
        rastreio.humanGate = resposta.tipo === "preview" ? "PREVIEW" : resposta.tipo === "rascunho" ? "RASCUNHO" : null;
      }
      rastreio.estado = resposta.tipo;
    }
    return { status: 200, corpo: { ok: true, data: resposta } };
  } catch (error) {
    const falha = classificar(error, MENSAGEM_FALLBACK);
    rastreio.resultado = falha.resultado;
    rastreio.codigo = falha.codigo;
    rastreio.causa = falha.causa;
    rastreio.fallback = rastreio.fallback || falha.fallback;
    return { status: falha.status, corpo: { ok: false, erro: falha.erro, codigo: falha.codigo } };
  } finally {
    rastreio.duracaoMs = Math.max(0, Math.round(relogio() - inicio));
    try {
      deps.registrar(rastreio);
    } catch {
      // O trace nunca derruba a resposta.
    }
  }
}
