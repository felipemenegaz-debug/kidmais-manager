import { InteligenciaError } from '@/lib/inteligencia/politica';
import { fonteDoRascunho } from '@/lib/contratos/integracao-importados/rascunho';
import { coreNativo } from '@/lib/contratos/integracao-importados/composicao';
import { confirmarIntegracao, opcoesIntegracaoRascunho, simularIntegracao, IntegracaoImportadoError } from '@/lib/contratos/integracao-importados/servico';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import type { NextRequest } from "next/server";
import { analisarCadastroCliente, cadastrarClienteInterno, obterClienteBase } from "@/lib/clientes/services";
import { executarImportacao } from "@/lib/importacao-contrato/motor";
import { documentosDisponiveis, ultimaExtracao } from "@/lib/importacao-contrato/repositorio-documentos";
import { abrirImportacao, atualizarImportacao, importacaoDisponivel, importacaoPorDocumento, lerImportacao } from "@/lib/importacao-contrato/repositorio-importacao";
import { CHAVE_ACOES, CHAVE_HUMAN_GATE } from "@/lib/inteligencia/acoes/modulo";
import type { RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarAcaoImportacao, type PortaImportacao } from "@/lib/inteligencia/importacao/acao";
import type { DependenciasImportacao } from "@/lib/inteligencia/importacao/revisao";
import { dependenciasGateway } from "../dependencias";
import { montarExtensoes } from "../extensoes";

/** Só recusas humanas conhecidas do domínio mantêm seu status. Falhas internas seguem o fallback sanitizado. */
function traduzirRecusa(erro: unknown): never {
  if (erro instanceof IntegracaoImportadoError && erro.httpStatus >= 400 && erro.httpStatus < 500) throw new InteligenciaError(erro.code, erro.message, erro.httpStatus);
  throw erro;
}

/** Composição da feature IMPORT: rascunho de importação, match no CRM e Import Engine. */
export function portaImportacao(request: NextRequest): PortaImportacao {
  return {
    completa: {
      async opcoes(tx, tenant, i, p) { return opcoesIntegracaoRascunho(tx, tenant, await fonteDoRascunho(tx, tenant, i, p), hojeBrasilia()).catch(traduzirRecusa); },
      async simular(tx, tenant, i, p, d) {
        const sim = await simularIntegracao(tx, tenant, i.id, d, hojeBrasilia(), await fonteDoRascunho(tx, tenant, i, p)).catch(traduzirRecusa);
        if (sim.integrada) throw new IntegracaoImportadoError('IMPORTACAO_JA_INTEGRADA', 'Este contrato já foi integrado. Abra o contrato.', 409);
        return sim;
      },
      async confirmar(tx, tenant, i, d, hash, ctx) {
        // Sessão ATUAL do request de confirmação; senha/token nunca entram no payload persistido.
        const sessao = await exigirApiAdminCrmDisponivel(request);
        if (sessao.usuario_id !== ctx.usuarioId || tenant.usuarioId !== ctx.usuarioId) throw new IntegracaoImportadoError('OPERACAO_NAO_AUTORIZADA', 'Sessão divergente.', 403);
        return confirmarIntegracao(tx, tenant, { usuarioId: ctx.usuarioId, token: tokenAdmin(request), requestId: ctx.operacaoId, ip: null,
          userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null, autenticadoEm: sessao.autenticado_em }, i.id,
          { decisoes: d, resumoHash: hash, chave: ctx.operacaoId }, hojeBrasilia(), coreNativo).catch(traduzirRecusa);
      },
    },
    disponivel: async (tx) => await importacaoDisponivel(tx) && await documentosDisponiveis(tx),
    ultimaExtracao,
    abrirImportacao,
    lerImportacao,
    importacaoPorDocumento,
    atualizarImportacao,
    analisarCliente: (tx, empresaId, dados) => analisarCadastroCliente(dados, empresaId, {}, tx),
    executar: (tx, entrada) => executarImportacao(tx, entrada, {
      // Cliente novo pelo mesmo serviço do CRM: dedup no tenant, índice de CPF, histórico e auditoria.
      async cadastrarCliente(txCliente, empresaId, dados, ctx) {
        const criado = await cadastrarClienteInterno({ ...dados, empresaId }, {
          usuarioId: ctx.usuarioId,
          origem: "CRM_INTERNO",
          requestId: ctx.requestId,
          ip: null,
          userAgent: request.headers.get("user-agent")?.slice(0, 1000) ?? null,
        }, txCliente);
        return { clienteId: criado.cliente.id };
      },
      // Vínculo só com cliente do tenant comprovado (outra empresa responde como inexistente).
      async conferirCliente(txCliente, empresaId, clienteId) {
        await obterClienteBase(clienteId, empresaId, txCliente);
      },
      atualizarImportacao,
    }),
  };
}

/** A ação de importação entra na lista de ações do Human Gate (feature ACTIONS). */
export function registrarImportacao(registro: RegistroExtensoes, request: NextRequest) {
  registro.lista(CHAVE_ACOES).push(criarAcaoImportacao(portaImportacao(request)));
}

export function dependenciasImportacao(request: NextRequest): DependenciasImportacao {
  const extensoes = montarExtensoes(request);
  const acao = extensoes.lista(CHAVE_ACOES).find((a) => a.capacidade === "importar_contrato") ?? null;
  return { ...dependenciasGateway(request), importacao: portaImportacao(request), gate: extensoes.obter(CHAVE_HUMAN_GATE), acao };
}
