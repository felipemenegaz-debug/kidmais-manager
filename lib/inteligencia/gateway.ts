import { ZodError, z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { ClienteServiceError } from "../clientes/services/errors.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { ferramentaRegistrada } from "./ferramentas.ts";
import { InteligenciaError, autorizarFerramenta } from "./politica.ts";
import type { CausaRastreio, RastreioInteligencia } from "./rastreio.ts";

/**
 * Flag global da V1. Uma futura configuração por empresa deve entrar como condição adicional,
 * nunca como alternativa a esta.
 */
export function inteligenciaAtiva(env: Readonly<Record<string, string | undefined>>) {
  return env.INTELIGENCIA_ENABLED === "true";
}

/** A empresa nunca vem do corpo: a seleção usa o mesmo parâmetro `empresaId` das rotas do Financeiro, provado por provarTenant. */
const pedidoSchema = z.object({
  capacidade: z.string().min(1).max(64),
  // Ausente vira {}; null não é "sem parâmetros" e é recusado.
  parametros: z.unknown().refine((valor) => valor !== null).optional(),
}).strict();

export type DependenciasGateway = {
  env: Readonly<Record<string, string | undefined>>;
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

/**
 * Só a leitura e a validação do pedido geram 400. Um ZodError ou SyntaxError vindo do domínio
 * é falha interna e cai no fallback, sem culpar o cliente.
 */
function pedidoInvalido(error: unknown): never {
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

function classificar(error: unknown): Classificacao {
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
  // Recusas do Core (sessão, tenant) mantêm status e mensagem, como em apiErrorResponse.
  if ((error instanceof ClienteServiceError || error instanceof PacoteAdminError) && error.httpStatus >= 400 && error.httpStatus < 500) {
    return {
      status: error.httpStatus,
      codigo: error.code,
      erro: error.message,
      resultado: resultadoDoStatus(error.httpStatus),
      causa: causaDoCore(error),
      fallback: false,
    };
  }
  // Qualquer outra falha vira fallback seguro, sem repassar mensagem interna.
  return {
    status: 503,
    codigo: "INTELIGENCIA_INDISPONIVEL",
    erro: MENSAGEM_FALLBACK,
    resultado: "fallback",
    causa: causaInesperada(error),
    fallback: true,
  };
}

/**
 * AI Gateway da V1: flag → sessão → pedido → registro → política → tenant → ferramenta.
 * Não fala com o banco; só repassa a transação tenant-comprovada à ferramenta.
 */
export async function atenderInteligencia(pedido: PedidoGateway, deps: DependenciasGateway): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio: RastreioInteligencia = {
    evento: "inteligencia.capacidade",
    requestId: deps.requestId(),
    usuarioId: null,
    empresaId: null,
    capacidade: null,
    ferramenta: null,
    resultado: "sucesso",
    codigo: null,
    estado: null,
    itens: null,
    causa: null,
    fallback: false,
    duracaoMs: 0,
  };
  try {
    if (!inteligenciaAtiva(deps.env)) {
      throw new InteligenciaError("INTELIGENCIA_DESATIVADA", "Kidmais Intelligence indisponível neste ambiente.", 503);
    }
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
    rastreio.capacidade = ferramenta.nome;
    rastreio.ferramenta = ferramenta.nome;

    autorizarFerramenta(sessao, ferramenta);
    let executar: ReturnType<typeof ferramenta.preparar>;
    try {
      executar = ferramenta.preparar(entrada.parametros === undefined ? {} : entrada.parametros);
    } catch (error) {
      pedidoInvalido(error);
    }
    const agora = deps.agora();
    const contexto = { hoje: hojeBrasilia(agora), geradoEm: agora.toISOString() };

    const data = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      return executar(tx, tenant, contexto);
    });
    rastreio.estado = data.estado;
    rastreio.itens = data.itens.length;
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
