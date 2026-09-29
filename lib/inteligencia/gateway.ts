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

function causaDaIA(error: InteligenciaError): CausaRastreio {
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
 * Caminho único de leitura (gateway e conversa): flag do grupo → política → parâmetros → tenant → ferramenta.
 * Parâmetros inválidos viram 400 antes de qualquer transação.
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
  if (!grupoAtivo(deps.env, ferramenta.grupo)) recursoDesativado();
  const politica: ResultadoPolitica = avaliarPolitica(sessao, ferramenta, "LEITURA");
  rastreio.politica = politica;
  autorizarFerramenta(sessao, ferramenta);

  const agora = deps.agora();
  const contexto: ContextoFerramenta = { hoje: hojeBrasilia(agora), geradoEm: agora.toISOString(), portas: deps.portas ?? SEM_PORTAS };

  let data: ResultadoFerramenta;
  if (ferramenta.modo === "SERVICO_PROPRIO") {
    let executar: ReturnType<typeof ferramenta.preparar>;
    try {
      executar = ferramenta.preparar(parametros);
    } catch (error) {
      pedidoInvalido(error);
    }
    // Prova o tenant numa transação curta; o serviço de domínio prova de novo, sozinho, na dele.
    const tenant = await deps.withTenantTransaction(sessao, empresaSolicitada, async (_tx, comprovado) => comprovado);
    rastreio.empresaId = tenant.empresaComprovada;
    exigirGrupoNaEmpresa(deps.env, ferramenta.grupo, tenant);
    data = await executar(tenant, contexto);
  } else {
    let executar: ReturnType<typeof ferramenta.preparar>;
    try {
      executar = ferramenta.preparar(parametros);
    } catch (error) {
      pedidoInvalido(error);
    }
    data = await deps.withTenantTransaction(sessao, empresaSolicitada, (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      exigirGrupoNaEmpresa(deps.env, ferramenta.grupo, tenant);
      return executar(tx, tenant, contexto);
    });
  }
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
