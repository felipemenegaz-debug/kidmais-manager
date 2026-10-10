import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { recursoIncluido } from "@/lib/assinatura/recursos-plano";
import { buscarClientesCrm, obterClienteBase } from "@/lib/clientes/services";
import { listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { detalheAdministrativo } from "@/lib/contratos/services/administrativo.service";
import { contratoNoTenant } from "@/lib/contratos/services/contrato-tenant";
import { db, withTransaction } from "@/lib/db/postgres";
import { lerPosicaoFinanceira } from "@/lib/pagamentos/repositories/alteracao-financeira.repository";
import { AlteracaoFinanceiraError } from "@/lib/pagamentos/services/alteracao-financeira-core";
import { FestaError, consultarFestas } from "@/lib/festas/service";
import { fonteParametrosDisponivel, parametroVigente } from "@/lib/operacional/parametros-consumo";
import { exigirApiAdminCrmDisponivel, tokenAdmin } from "@/lib/http/admin-crm-api";
import { criarRegistroUsoPostgres, lerUsoAgrupado } from "@/lib/ia-persistencia/uso";
import type { DependenciasConversa } from "@/lib/inteligencia/conversa";
import type { DependenciasCustos } from "@/lib/inteligencia/custos";
import { CHAVE_AGENTES, CHAVE_CATALOGO_SKILLS, CHAVE_CLASSIFICADOR_AUXILIAR, CHAVE_COPILOTO, CHAVE_MODULO_ACOES, CHAVE_ORQUESTRADOR } from "@/lib/inteligencia/extensoes";
import type { PortasDominio } from "@/lib/inteligencia/ferramentas";
import type { DependenciasGateway } from "@/lib/inteligencia/gateway";
import { orcamentoDoAmbiente } from "@/lib/inteligencia/modelos/orcamento";
import { tabelaDoAmbiente } from "@/lib/inteligencia/modelos/precos";
import { RoteadorModelos, circuitoGlobal, criarAdaptadores, politicaDoAmbiente } from "@/lib/inteligencia/modelos/roteador";
import { InteligenciaError } from "@/lib/inteligencia/politica";
import { registrarRastreio } from "@/lib/inteligencia/rastreio";
import { provarEstabelecimento } from "@/lib/saas/provar-estabelecimento";
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
    // Mesma matriz de plano das APIs do financeiro, na transação da empresa comprovada.
    recursos: { financeiroCompleto: (tx, empresaId) => recursoIncluido(tx, empresaId, "FINANCEIRO_COMPLETO") },
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
    clientes: {
      obter: (tx, empresaId, clienteId) => obterClienteBase(clienteId, empresaId, tx),
      // Busca do CRM no tenant comprovado; a IA só recebe id, nome e status (sem CPF, contato ou endereço).
      async buscar(tx, empresaId, termo, limite) {
        const encontrados = await buscarClientesCrm(termo, empresaId, limite, false, tx);
        return encontrados.map(({ cliente }) => ({ id: cliente.id, nomeCompleto: cliente.nomeCompleto, status: String(cliente.status) }));
      },
    },
    // Pacotes: serviço comercial com a empresa comprovada no WHERE (sem preço; preço segue a tabela vigente).
    pacotes: { listar: (tx, empresaId) => listarPacotesAdmin(tx, empresaId) },
    // Versões de contrato: posse comprovada na empresa (fechamento + pacote) ANTES de ler o detalhe do domínio.
    contratos: {
      async versoes(tx, empresaId, contratoId) {
        if (!(await contratoNoTenant(tx, empresaId, contratoId))) return null;
        const detalhe = await detalheAdministrativo(contratoId, tx);
        return (detalhe.versoes as Array<{ numero_versao: number; status: string; snapshot: unknown }>).map((v) => ({ numero: Number(v.numero_versao), status: String(v.status), snapshot: (v.snapshot ?? null) as never }));
      },
    },
    // Posição financeira OFICIAL (AI V1.1, PR 5.5): posse do contrato na empresa ANTES da leitura; só o mínimo sai
    // daqui (valores do Core em centavos, cobrança e cronograma em aberto) — nada de nomes, documentos ou histórico.
    financeiro: {
      async posicaoContrato(tx, empresaId, contratoId) {
        if (!(await contratoNoTenant(tx, empresaId, contratoId))) return null;
        try {
          const p = await lerPosicaoFinanceira(tx, contratoId);
          const abertas = p.futuro
            .filter((f) => BigInt(f.valorCentavos) > 0n)
            .map((f) => ({ numero: Number(p.parcelas.find((x) => x.id === f.parcelaId)?.numero ?? 0), vencimento: String(f.vencimento), valorCentavos: String(f.valorCentavos) }))
            .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.numero - b.numero);
          return {
            contratoId,
            obrigacaoCentavos: p.posicao.obrigacao.toString(),
            recebidoLiquidoCentavos: p.posicao.liquido.toString(),
            saldoACobrarCentavos: p.cobranca.saldoACobrar.toString(),
            creditoCentavos: p.posicao.credito.toString(),
            encerrada: p.cobranca.encerrada,
            acertoAdministrativoPendente: p.cobranca.acertoAdministrativoPendente,
            parcelasAbertas: abertas,
          };
        } catch (error) {
          if (error instanceof AlteracaoFinanceiraError && error.code === "OBRIGACAO_NAO_DISPONIVEL") return "SEM_OBRIGACAO";
          throw error;
        }
      },
    },
    // IA operacional: regra de consumo VIGENTE da empresa comprovada (serviço da 059, somente leitura). Sem a tabela,
    // INDISPONIVEL: o cálculo pergunta o parâmetro ao operador.
    parametrosConsumo: {
      vigente: (empresaId, categoria) => withTransaction(async (tx) => ((await fonteParametrosDisponivel(tx)) ? parametroVigente(tx, empresaId, categoria) : "INDISPONIVEL")),
    },
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
    // Establishment Context: prova do Core (unidade da empresa comprovada, ATIVA, com vínculo ATIVO da membership).
    provarEstabelecimento: (tx, tenant, estabelecimentoId) => provarEstabelecimento(tx, tenant, estabelecimentoId),
  };
}

/** Visão de custos: leitura agrupada das tabelas ia_* da empresa comprovada; moeda do pricing configurado. */
export function dependenciasCustos(request: NextRequest): DependenciasCustos {
  const base = dependenciasGateway(request);
  return {
    env: base.env,
    autenticar: base.autenticar,
    withTenantTransaction,
    lerUso: (tx, empresaId, mes) => lerUsoAgrupado(tx, empresaId, mes),
    moeda: () => tabelaDoAmbiente(process.env)?.moeda ?? null,
    agora: base.agora,
    requestId: base.requestId,
    registrar: base.registrar,
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
    orquestrador: extensoes.obter(CHAVE_ORQUESTRADOR),
    skills: extensoes.obter(CHAVE_CATALOGO_SKILLS),
    copiloto: extensoes.obter(CHAVE_COPILOTO),
    agentes: extensoes.obter(CHAVE_AGENTES),
  };
}
