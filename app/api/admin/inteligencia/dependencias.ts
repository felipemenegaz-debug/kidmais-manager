import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { obterClienteBase } from "@/lib/clientes/services";
import { db, withTransaction } from "@/lib/db/postgres";
import { FestaError, consultarFestas } from "@/lib/festas/service";
import { exigirApiAdminCrmDisponivel, tokenAdmin } from "@/lib/http/admin-crm-api";
import { criarRegistroUsoPostgres } from "@/lib/ia-persistencia/uso";
import type { DependenciasConversa } from "@/lib/inteligencia/conversa";
import { CHAVE_CLASSIFICADOR_AUXILIAR, CHAVE_MODULO_ACOES } from "@/lib/inteligencia/extensoes";
import type { PortasDominio } from "@/lib/inteligencia/ferramentas";
import type { DependenciasGateway } from "@/lib/inteligencia/gateway";
import { orcamentoDoAmbiente } from "@/lib/inteligencia/modelos/orcamento";
import { tabelaDoAmbiente } from "@/lib/inteligencia/modelos/precos";
import { RoteadorModelos, circuitoGlobal, criarAdaptadores, politicaDoAmbiente } from "@/lib/inteligencia/modelos/roteador";
import { InteligenciaError } from "@/lib/inteligencia/politica";
import { registrarRastreio } from "@/lib/inteligencia/rastreio";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { montarExtensoes } from "./extensoes";

/**
 * Composition root do CORE do Kidmais Intelligence: leituras, conversa e Model Router.
 * A IA recebe portas; nunca importa repositório, driver ou SQL.
 *
 * Features (ações, documentos, importação) têm composição própria na pasta de cada rota e entram na
 * conversa só pelo `RegistroExtensoes` (./extensoes.ts). Este arquivo não importa nenhuma delas.
 */
export function portasDominio(request: NextRequest): PortasDominio {
  return {
    festas: {
      async consultarDetalhe(festaId) {
        try {
          // Mesmo contexto da rota /api/admin/festas: o serviço relê a sessão, prova o tenant e exige FESTA_CONSULTAR.
          return await consultarFestas({
            token: tokenAdmin(request),
            requestId: randomUUID(),
            userAgent: request.headers.get("user-agent")?.slice(0, 1000) ?? null,
            empresaSolicitada: request.nextUrl.searchParams.get("empresaId"),
          }, festaId);
        } catch (error) {
          // FestaError já traz mensagem humana; outras falhas seguem para o fallback do gateway.
          if (error instanceof FestaError && error.status >= 400 && error.status < 500) {
            throw new InteligenciaError(error.status === 404 ? "NAO_ENCONTRADO" : "FESTA_RECUSADA", error.message, error.status);
          }
          throw error;
        }
      },
    },
    clientes: { obter: (tx, empresaId, clienteId) => obterClienteBase(clienteId, empresaId, tx) },
  };
}

export function dependenciasGateway(request: NextRequest): DependenciasGateway {
  return {
    env: process.env,
    autenticar: () => exigirApiAdminCrmDisponivel(request),
    withTenantTransaction,
    agora: () => new Date(),
    requestId: randomUUID,
    registrar: (rastreio) => registrarRastreio(rastreio),
    portas: portasDominio(request),
  };
}

/** Cada chamada confere `disponivelPara(workload)`: sem provedor com chave e modelo, só regras determinísticas. */
export function roteadorDoAmbiente() {
  const env = process.env;
  return new RoteadorModelos({
    politica: politicaDoAmbiente(env),
    adaptadores: criarAdaptadores(env, (url, init) => fetch(url, init)),
    precos: tabelaDoAmbiente(env),
    orcamento: orcamentoDoAmbiente(env),
    // Reserva → chamada → reconciliação, com advisory lock por empresa numa transação curta própria.
    registro: criarRegistroUsoPostgres({ executor: db, transacao: withTransaction }),
    circuito: circuitoGlobal,
    agora: () => new Date(),
    relogio: () => performance.now(),
    novoId: randomUUID,
    alertar: (alerta) => console.error(`[Kidmais IA alerta] ${JSON.stringify(alerta)}`),
  });
}

export function dependenciasConversa(request: NextRequest): DependenciasConversa {
  const extensoes = montarExtensoes(request);
  return {
    ...dependenciasGateway(request),
    roteador: roteadorDoAmbiente(),
    acoes: extensoes.obter(CHAVE_MODULO_ACOES),
    classificador: extensoes.obter(CHAVE_CLASSIFICADOR_AUXILIAR),
  };
}
