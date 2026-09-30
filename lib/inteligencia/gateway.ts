import { ZodError, z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { ClienteServiceError } from "../clientes/services/errors.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import type { ResultadoPolitica } from "./contratos.ts";
import { SEM_PORTAS, ferramentaRegistrada, type ContextoFerramenta, type Ferramenta, type PortasDominio, type ResultadoFerramenta } from "./ferramentas.ts";
import { grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva, type Ambiente } from "./flags.ts";
import { InteligenciaError, autorizarFerramenta, avaliarPolitica } from "./politica.ts";
import { novoRastreio, type CausaRastreio, type RastreioInteligencia } from "./rastreio.ts";
import { decidirPolitica, exigirPolitica, type EntradaPolitica } from "./politica-v1.ts";
import { manifestoLeitura, saidaValida } from "./registro-ferramentas.ts";

/** A empresa nunca vem do corpo: a seleção usa o mesmo parâmetro `empresaId` das rotas do Financeiro, provado por provarTenant. */
const pedidoSchema = z.object({
  capacidade: z.string().min(1).max(64),
  // Ausente vira {}; null não é "sem parâmetros" e é recusado.
  parametros: z.unknown().refine((valor) => valor !== null).optional(),
}).strict();

export type DependenciasGateway = {
  env: Ambiente;
  autenticar(): Promise<SessaoParaTenant>;
  withTenantTransaction<T>(
    sessao: SessaoParaTenant,
    empresaSolicitada: string | null | undefined,
    work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
  ): Promise<T>;
  agora(): Date;
  requestId(): string;
  registrar(rastreio: RastreioInteligencia): void;
  relogio?(): number;
  /** Serviços de domínio injetados pela rota. Ausentes ⇒ ferramentas que dependem deles respondem sem dados. */
  portas?: PortasDominio;
  /** Teto operacional de prazo (ex.: testes). Só reduz o prazo do manifesto, nunca o aumenta. */
  prazoMaximoMs?: number;
};

export type PedidoGateway = {
  lerCorpo(): Promise<unknown>;
  empresaSolicitada: string | null;
};

export type RespostaGateway = {
  status: number;
  corpo: { ok: true; data: unknown } | { ok: false; erro: string; codigo: string };
};

const MENSAGEM_FALLBACK = "Não foi possível preparar este resumo agora. O Dashboard e o Financeiro continuam disponíveis.";

export function recursoDesativado(): never {
  throw new InteligenciaError("INTELIGENCIA_DESATIVADA", "Kidmais Intelligence indisponível neste ambiente.", 503);
}

/**
 * Só a leitura e a validação do pedido geram 400. Um ZodError ou SyntaxError vindo do domínio
 * é falha interna e cai no fallback, sem culpar o cliente.
 */
export function pedidoInvalido(error: unknown): never {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    throw new InteligenciaError("DADOS_INVALIDOS", "Dados inválidos.", 400);
  }
  throw error;
}

type Classificacao = Pick<RastreioInteligencia, "resultado" | "causa" | "fallback"> & {
  status: number;
  codigo: string;
  erro: string;
};

function resultadoDoStatus(status: number): RastreioInteligencia["resultado"] {
  return status === 401 || status === 403 ? "negado" : "invalido";
}

/** Falhas do próprio Tool Registry que viram fallback seguro (a resposta não é entregue). */
const FALHAS_DE_REGISTRO: Readonly<Record<string, CausaRastreio>> = { INTELIGENCIA_TEMPO_ESGOTADO: "TEMPO", INTELIGENCIA_SAIDA_INVALIDA: "SAIDA" };

/** Prazo da ferramenta (manifesto). Excedido ⇒ fallback; a leitura não tem efeito a desfazer. */
export async function comPrazo<T>(ms: number, trabalho: () => Promise<T>): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(() => rejeitar(new InteligenciaError("INTELIGENCIA_TEMPO_ESGOTADO", MENSAGEM_FALLBACK, 503)), ms);
  });
  try {
    return await Promise.race([trabalho(), limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

function causaDaIA(error: InteligenciaError): CausaRastreio {
  if (Object.hasOwn(FALHAS_DE_REGISTRO, error.code)) return FALHAS_DE_REGISTRO[error.code];
  if (error.code === "INTELIGENCIA_DESATIVADA") return "FLAG";
  if (error.code === "INTELIGENCIA_NAO_AUTORIZADA") return "POLITICA";
  return "VALIDACAO";
}

function causaDoCore(error: ClienteServiceError | PacoteAdminError): CausaRastreio {
  if (error.httpStatus === 401) return "AUTENTICACAO";
  if (error.code === "TENANT_NAO_COMPROVADO") return "TENANT";
  return "RECUSA_CORE";
}

/** Só classifica: nada do objeto de erro (nome, mensagem, código, stack) vai para o trace. */
function causaInesperada(error: unknown): CausaRastreio {
  if (error instanceof ZodError || error instanceof SyntaxError) return "DOMINIO";
  const pareceSqlstate = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code);
  return pareceSqlstate ? "BANCO" : "INESPERADO";
}

/** Recusa do Core com status HTTP próprio (4xx): mantém status e mensagem, como em apiErrorResponse. */
function recusaDoCore(error: unknown): error is { code: string; message: string; httpStatus: number } {
  if (error instanceof ClienteServiceError || error instanceof PacoteAdminError) return error.httpStatus >= 400 && error.httpStatus < 500;
  // Erros de outros domínios (ex.: FestaError via porta) chegam só com status; a mensagem já é humana.
  return false;
}

export function classificar(error: unknown, mensagemFallback = MENSAGEM_FALLBACK): Classificacao {
  if (error instanceof InteligenciaError && Object.hasOwn(FALHAS_DE_REGISTRO, error.code)) {
    return { status: 503, codigo: error.code, erro: mensagemFallback, resultado: "fallback", causa: causaDaIA(error), fallback: true };
  }
  if (error instanceof InteligenciaError) {
    return {
      status: error.httpStatus,
      codigo: error.code,
      erro: error.message,
      resultado: error.code === "INTELIGENCIA_DESATIVADA" ? "desativado" : resultadoDoStatus(error.httpStatus),
      causa: causaDaIA(error),
      fallback: false,
    };
  }
  if (recusaDoCore(error)) {
    return {
      status: error.httpStatus,
      codigo: error.code,
      erro: error.message,
      resultado: resultadoDoStatus(error.httpStatus),
      causa: causaDoCore(error as ClienteServiceError),
      fallback: false,
    };
  }
  // Qualquer outra falha vira fallback seguro, sem repassar mensagem interna.
  return {
    status: 503,
    codigo: "INTELIGENCIA_INDISPONIVEL",
    erro: mensagemFallback,
    resultado: "fallback",
    causa: causaInesperada(error),
    fallback: true,
  };
}

/** Allowlist por empresa, depois do Tenant Context. Fora da lista ⇒ mesmo tratamento de flag desligada. */
export function exigirGrupoNaEmpresa(env: Ambiente, grupo: Parameters<typeof grupoAtivoParaEmpresa>[1], tenant: TenantComprovado) {
  if (!grupoAtivoParaEmpresa(env, grupo, tenant.empresaComprovada)) recursoDesativado();
}

/**
 * Caminho único de leitura (gateway e conversa): manifesto → flag do grupo → política → entrada (schema do
 * manifesto) → tenant → ferramenta dentro do prazo → saída (schema do manifesto). Parâmetros inválidos viram 400
 * antes de qualquer transação; prazo excedido ou saída fora do schema viram fallback (nada é entregue).
 */
export async function executarLeitura(
  ferramenta: Ferramenta,
  parametros: unknown,
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null,
  deps: DependenciasGateway,
  rastreio: RastreioInteligencia,
): Promise<ResultadoFerramenta> {
  rastreio.capacidade = ferramenta.capacidade;
  rastreio.ferramenta = ferramenta.nome;
  rastreio.ferramentasSolicitadas = [...rastreio.ferramentasSolicitadas, ferramenta.nome];
  const manifesto = manifestoLeitura(ferramenta);
  const prazo = Math.min(manifesto?.prazoMs ?? 0, deps.prazoMaximoMs ?? Number.POSITIVE_INFINITY);
  if (!manifesto || manifesto.classe !== "READ") throw new InteligenciaError("CAPACIDADE_DESCONHECIDA", "Capacidade não disponível.", 400);
  if (!grupoAtivo(deps.env, ferramenta.grupo)) recursoDesativado();
  const politica: ResultadoPolitica = avaliarPolitica(sessao, ferramenta, "LEITURA");
  rastreio.politica = politica;
  autorizarFerramenta(sessao, ferramenta);
  // Policy V1 sobre o manifesto: antes do tenant (papel da sessão) e de novo dentro dele (papel da membership).
  const aplicarPolitica = (entrada: EntradaPolitica) => {
    rastreio.politica = decidirPolitica(entrada);
    exigirPolitica(entrada);
  };
  const politicaNoTenant = (tenant: TenantComprovado) => aplicarPolitica({
    papel: tenant.papelAtual, manifesto, caminho: "LEITURA", origem: "UI", grupoAtivo: true,
    grupoAtivoNaEmpresa: grupoAtivoParaEmpresa(deps.env, ferramenta.grupo, tenant.empresaComprovada),
  });
  aplicarPolitica({ papel: sessao.papel, manifesto, caminho: "LEITURA", origem: "UI", grupoAtivo: true, grupoAtivoNaEmpresa: null });

  const agora = deps.agora();
  const contexto: ContextoFerramenta = { hoje: hojeBrasilia(agora), geradoEm: agora.toISOString(), portas: deps.portas ?? SEM_PORTAS };

  let data: ResultadoFerramenta;
  if (ferramenta.modo === "SERVICO_PROPRIO") {
    let executar: ReturnType<typeof ferramenta.preparar>;
    try {
      manifesto.entrada?.parse(parametros);
      executar = ferramenta.preparar(parametros);
    } catch (error) {
      pedidoInvalido(error);
    }
    // Prova o tenant numa transação curta; o serviço de domínio prova de novo, sozinho, na dele.
    const tenant = await deps.withTenantTransaction(sessao, empresaSolicitada, async (_tx, comprovado) => comprovado);
    rastreio.empresaId = tenant.empresaComprovada;
    exigirGrupoNaEmpresa(deps.env, ferramenta.grupo, tenant);
    politicaNoTenant(tenant);
    data = await comPrazo(prazo, () => executar(tenant, contexto));
  } else {
    let executar: ReturnType<typeof ferramenta.preparar>;
    try {
      manifesto.entrada?.parse(parametros);
      executar = ferramenta.preparar(parametros);
    } catch (error) {
      pedidoInvalido(error);
    }
    data = await deps.withTenantTransaction(sessao, empresaSolicitada, (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      exigirGrupoNaEmpresa(deps.env, ferramenta.grupo, tenant);
      politicaNoTenant(tenant);
      return comPrazo(prazo, () => executar(tx, tenant, contexto));
    });
  }
  if (!saidaValida(manifesto.saida, data)) throw new InteligenciaError("INTELIGENCIA_SAIDA_INVALIDA", MENSAGEM_FALLBACK, 503);
  rastreio.ferramentasExecutadas = [...rastreio.ferramentasExecutadas, ferramenta.nome];
  rastreio.estado = data.estado;
  rastreio.itens = data.itens.length;
  return data;
}

/**
 * AI Gateway de leitura: flag → sessão → pedido → registro → flag do grupo → política → tenant → ferramenta.
 * Não fala com o banco; só repassa a transação tenant-comprovada à ferramenta.
 */
export async function atenderInteligencia(pedido: PedidoGateway, deps: DependenciasGateway): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio = novoRastreio("inteligencia.capacidade", deps.requestId());
  rastreio.intencao = "UI";
  rastreio.humanGate = "NAO_SE_APLICA";
  try {
    if (!inteligenciaAtiva(deps.env)) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;

    let entrada: z.infer<typeof pedidoSchema>;
    try {
      entrada = pedidoSchema.parse(await pedido.lerCorpo());
    } catch (error) {
      pedidoInvalido(error);
    }
    const ferramenta = ferramentaRegistrada(entrada.capacidade);
    if (!ferramenta) throw new InteligenciaError("CAPACIDADE_DESCONHECIDA", "Capacidade não disponível.", 400);
    const data = await executarLeitura(ferramenta, entrada.parametros === undefined ? {} : entrada.parametros, sessao, pedido.empresaSolicitada, deps, rastreio);
    return { status: 200, corpo: { ok: true, data } };
  } catch (error) {
    const falha = classificar(error);
    rastreio.resultado = falha.resultado;
    rastreio.codigo = falha.codigo;
    rastreio.causa = falha.causa;
    rastreio.fallback = falha.fallback;
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
