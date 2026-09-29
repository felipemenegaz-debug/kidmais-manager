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

/** Composição da feature IMPORT: rascunho de importação, match no CRM e Import Engine. */
export function portaImportacao(request: NextRequest): PortaImportacao {
  return {
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
