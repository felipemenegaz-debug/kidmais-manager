import { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { inteligenciaAtiva, type Ambiente } from "./flags.ts";
import { classificar, pedidoInvalido, recursoDesativado, type PedidoGateway, type RespostaGateway } from "./gateway.ts";
import { InteligenciaError } from "./politica.ts";
import { novoRastreio, type RastreioInteligencia } from "./rastreio.ts";

/**
 * Controle de custos V1: visão consolidada do uso de modelos da empresa COMPROVADA, por estabelecimento,
 * capacidade, modelo e dia, com o total do mês. Somente leitura, só para a Gestão (REPRESENTANTE_AUTORIZADO).
 *
 * Regras de honestidade:
 * - custo desconhecido (preço ausente, moeda diferente da configurada, uso sem tokens) NUNCA vira zero: o grupo
 *   fica com custo null e a contagem de desconhecidos aparece;
 * - reservas ainda abertas (ou órfãs/sem uso conhecido) aparecem à parte, como consumo comprometido;
 * - sem as tabelas de uso (migration 055a não aplicada) ⇒ `disponivel: false`.
 * O orçamento continua fail-closed no Model Router (sem teto aplicável ⇒ nenhuma chamada).
 */
export type UsoAgrupadoLido = {
  estabelecimentoId: string | null; capacidade: string; provedor: string; modelo: string; dia: string; mes: string; moeda: string | null;
  chamadas: number; tokensEntrada: number; tokensSaida: number; tokensDesconhecidos: number; custoMicros: number; custoDesconhecido: number;
};
export type ReservaAgrupadaLida = { capacidade: string; dia: string; moeda: string | null; reservas: number; tokens: number; custoMicros: number; custoDesconhecido: number };

export type Soma = { chamadas: number; tokens: number | null; custoMicros: number | null; desconhecidos: number };
export type VisaoCustos = {
  disponivel: boolean;
  mes: string;
  moeda: string | null;
  total: Soma;
  porEstabelecimento: Record<string, Soma>;
  porCapacidade: Record<string, Soma>;
  porModelo: Record<string, Soma>;
  porDia: Record<string, Soma>;
  reservado: { reservas: number; tokens: number; custoMicros: number | null; desconhecidos: number };
};

const vazia = (): Soma => ({ chamadas: 0, tokens: 0, custoMicros: 0, desconhecidos: 0 });

function somar(alvo: Soma, u: UsoAgrupadoLido, moeda: string | null) {
  alvo.chamadas += u.chamadas;
  alvo.tokens = alvo.tokens === null || u.tokensDesconhecidos > 0 ? null : alvo.tokens + u.tokensEntrada + u.tokensSaida;
  const custoConhecido = moeda !== null && u.moeda === moeda && u.custoDesconhecido === 0;
  if (!custoConhecido) {
    alvo.desconhecidos += Math.max(u.custoDesconhecido, u.moeda === moeda ? 0 : u.chamadas);
    alvo.custoMicros = null;
  } else if (alvo.custoMicros !== null) {
    alvo.custoMicros += u.custoMicros;
  }
}

/** Consolidação pura (testável sem banco). `moeda` = moeda configurada do pricing; null ⇒ todo custo é desconhecido. */
export function consolidarCustos(entrada: { disponivel: boolean; usos: readonly UsoAgrupadoLido[]; reservas: readonly ReservaAgrupadaLida[] }, mes: string, moeda: string | null): VisaoCustos {
  const v: VisaoCustos = {
    disponivel: entrada.disponivel, mes, moeda, total: vazia(), porEstabelecimento: {}, porCapacidade: {}, porModelo: {}, porDia: {},
    reservado: { reservas: 0, tokens: 0, custoMicros: 0, desconhecidos: 0 },
  };
  if (!entrada.disponivel) {
    v.total = { chamadas: 0, tokens: null, custoMicros: null, desconhecidos: 0 };
    v.reservado.custoMicros = null;
    return v;
  }
  const grupo = (mapa: Record<string, Soma>, chave: string) => (mapa[chave] ??= vazia());
  for (const u of entrada.usos) {
    if (u.mes !== mes) continue;
    somar(v.total, u, moeda);
    // Estabelecimento: o Tenant Context V1 não tem unidade; usos sem estabelecimento ficam em "EMPRESA".
    somar(grupo(v.porEstabelecimento, u.estabelecimentoId ?? "EMPRESA"), u, moeda);
    somar(grupo(v.porCapacidade, u.capacidade), u, moeda);
    somar(grupo(v.porModelo, `${u.provedor}:${u.modelo}`), u, moeda);
    somar(grupo(v.porDia, u.dia), u, moeda);
  }
  for (const r of entrada.reservas) {
    v.reservado.reservas += r.reservas;
    v.reservado.tokens += r.tokens;
    if (moeda === null || r.moeda !== moeda || r.custoDesconhecido > 0) {
      v.reservado.custoMicros = null;
      v.reservado.desconhecidos += Math.max(r.custoDesconhecido, r.moeda === moeda ? 0 : r.reservas);
    } else if (v.reservado.custoMicros !== null) {
      v.reservado.custoMicros += r.custoMicros;
    }
  }
  return v;
}

// ---------------------------------------------------------------- endpoint (Gestão da empresa comprovada)

export type DependenciasCustos = {
  env: Ambiente;
  autenticar(): Promise<SessaoParaTenant>;
  withTenantTransaction<T>(sessao: SessaoParaTenant, empresaSolicitada: string | null | undefined, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>): Promise<T>;
  lerUso(tx: DbExecutor, empresaId: string, mes: string): Promise<{ disponivel: boolean; usos: UsoAgrupadoLido[]; reservas: ReservaAgrupadaLida[] }>;
  /** Moeda do pricing configurado (AI_PRICING_JSON); null ⇒ custo desconhecido. */
  moeda(): string | null;
  agora(): Date;
  requestId(): string;
  registrar(rastreio: RastreioInteligencia): void;
  relogio?(): number;
};

const pedidoSchema = z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

export async function atenderCustos(pedido: PedidoGateway, deps: DependenciasCustos): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio = novoRastreio("inteligencia.custos", deps.requestId());
  rastreio.capacidade = "custos_ia";
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
    const mes = entrada.mes ?? hojeBrasilia(deps.agora()).slice(0, 7);
    const visao = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      // Custos são informação de Gestão: só o papel de Gestão NESTA empresa (membership comprovada).
      if (tenant.papelAtual !== "REPRESENTANTE_AUTORIZADO") {
        rastreio.politica = "NEGADO_PAPEL";
        throw new InteligenciaError("INTELIGENCIA_NAO_AUTORIZADA", "Seu acesso não permite esta consulta.", 403);
      }
      rastreio.politica = "PERMITIDO";
      return consolidarCustos(await deps.lerUso(tx, tenant.empresaComprovada, mes), mes, deps.moeda());
    });
    rastreio.estado = visao.disponivel ? "disponivel" : "indisponivel";
    return { status: 200, corpo: { ok: true, data: visao } };
  } catch (error) {
    const falha = classificar(error, "Não foi possível consultar os custos agora.");
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
