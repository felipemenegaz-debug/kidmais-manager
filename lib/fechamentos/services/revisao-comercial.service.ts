import { createHash } from "node:crypto";
import { calcularCondicaoComercial, centavosComerciais, validarPretensaoPix,
  type PretensaoPixInput, type CondicaoPagamento } from "../../comercial/condicao-pagamento";
import { withTransaction } from "../../db/postgres";
import { registrarAuditoria, registrarEventoHistorico } from "../../clientes/repositories";
import { buscarFechamentoPorId, buscarFechamentoPorIdParaAtualizacao, criarAprovacaoNegociacao,
  listarAprovacoesDoFechamento, registrarDecisaoNoFechamento } from "../repositories/fechamento.repository";
import { FechamentoServiceError } from "./errors";

export async function obterRevisaoComercial(id: string) {
  const fechamento = await buscarFechamentoPorId(id);
  if (!fechamento) throw new FechamentoServiceError("FECHAMENTO_NAO_ENCONTRADO", "Fechamento não encontrado.", 404);
  return { fechamento, aprovacoes: await listarAprovacoesDoFechamento(id) };
}

export type RevisarComercialInput = {
  solicitacaoId: string;
  decisao: "APROVAR" | "RECUSAR";
  valorBaseAprovado?: number | string;
  condicaoAprovada?: PretensaoPixInput | null;
  motivo: string;
};

export async function revisarComercial(id: string, input: RevisarComercialInput,
  context: { usuarioId?: string | null; origem: string }) {
  if (!input.motivo?.trim() || input.motivo.length > 1000 ||
    !["APROVAR", "RECUSAR"].includes(input.decisao)) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "Informe decisão e motivo da revisão.");
  }
  const aprovada = input.decisao === "APROVAR";
  const propostaAprovada = validarPretensaoPix(input.condicaoAprovada);
  const baseInformada = input.valorBaseAprovado === undefined ? null : centavosComerciais(input.valorBaseAprovado) / 100;
  const decisaoHash = createHash("sha256").update(JSON.stringify({
    solicitacaoId: input.solicitacaoId.toLowerCase(), decisao: input.decisao,
    baseInformada, propostaAprovada, motivo: input.motivo.trim(),
  })).digest("hex");
  return withTransaction(async (tx) => {
    const f = await buscarFechamentoPorIdParaAtualizacao(id, tx);
    if (!f) throw new FechamentoServiceError("FECHAMENTO_NAO_ENCONTRADO", "Fechamento não encontrado.", 404);
    const historico = await listarAprovacoesDoFechamento(id, tx);
    const anterior = historico.find((a) => a.condicaoPagamento?.solicitacaoId === input.solicitacaoId.toLowerCase());
    if (anterior) {
      if (anterior.condicaoPagamento?.decisaoHash !== decisaoHash) {
        throw new FechamentoServiceError("REVISAO_COMERCIAL_INVALIDA", "Esta solicitação já recebeu outra decisão.", 409);
      }
      return { fechamento: f, decisao: anterior, reutilizada: true };
    }
    const pendente = historico.find((a) => a.id.toLowerCase() === input.solicitacaoId.toLowerCase() && a.status === "PENDENTE");
    if (!pendente || !f.condicaoPagamento || f.condicaoPagamento.revisaoStatus !== "PENDENTE" || f.status !== "AGUARDANDO_APROVACAO") {
      throw new FechamentoServiceError("REVISAO_COMERCIAL_INVALIDA", "O Fechamento não possui esta revisão pendente no novo fluxo.", 409);
    }
    if ((await tx.query("SELECT id FROM contratos WHERE fechamento_id=$1::uuid LIMIT 1", [id])).rows.length) {
      throw new FechamentoServiceError("REVISAO_COMERCIAL_INVALIDA", "Revisão não pode alterar Fechamento que já possui Contrato.", 409);
    }
    if (f.formaPagamentoPretendida !== f.condicaoPagamento.forma ||
      (propostaAprovada && f.formaPagamentoPretendida !== "PIX_PARCELADO")) {
      throw new FechamentoServiceError("DADOS_INVALIDOS", "Condição incompatível com a forma de pagamento.");
    }
    if (!aprovada && (baseInformada !== null || propostaAprovada !== null)) {
      throw new FechamentoServiceError("DADOS_INVALIDOS", "Recusa não deve informar valores ou condição aprovados.");
    }
    if (aprovada && f.formaPagamentoPretendida === "PIX_PARCELADO" && propostaAprovada === null) {
      throw new FechamentoServiceError("DADOS_INVALIDOS", "Registre ao menos um dado da condição de PIX parcelado acordada com o cliente.");
    }
    if (aprovada && f.valorNegociado !== null && baseInformada === null) {
      throw new FechamentoServiceError("DADOS_INVALIDOS", "Confirme explicitamente a base comercial aprovada.");
    }
    const base = baseInformada ?? f.valorTabela;
    if (aprovada && f.valorNegociado === null && base !== f.valorTabela) {
      throw new FechamentoServiceError("DADOS_INVALIDOS", "Esta revisão é de condição; não há negociação de valor registrada.");
    }
    const condicao: CondicaoPagamento = {
      ...f.condicaoPagamento, revisaoStatus: aprovada ? "APROVADA" : "RECUSADA",
      aprovada: aprovada ? propostaAprovada : null,
    };
    const decisao = await criarAprovacaoNegociacao({
      fechamentoId: id, valorInformado: pendente.valorInformado,
      valorAprovado: aprovada ? base : null, status: aprovada ? "APROVADO" : "RECUSADO",
      motivo: input.motivo.trim(), aprovadoPorUsuarioId: context.usuarioId,
      condicaoPagamento: { ...condicao, solicitacaoId: input.solicitacaoId.toLowerCase(), decisaoHash,
        ...(aprovada ? { valores: calcularCondicaoComercial(base, condicao.forma) } : {}) },
    }, tx);
    const fechamento = await registrarDecisaoNoFechamento(f, { aprovada, valorBase: aprovada ? base : null, condicao }, tx);
    await registrarAuditoria({ entidadeTipo: "FECHAMENTO", entidadeId: id,
      atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA", clienteId: f.clienteId,
      acao: "REVISAO_COMERCIAL_REGISTRADA", origem: context.origem, usuarioId: context.usuarioId,
      dadosAntes: { status: f.status, condicaoPagamento: f.condicaoPagamento },
      dadosDepois: { status: fechamento.status, decisaoId: decisao.id, condicaoPagamento: condicao } }, tx);
    if (f.clienteId) await registrarEventoHistorico({ clienteId: f.clienteId, clienteOrigemId: f.clienteId,
      tipoEvento: "REVISAO_COMERCIAL_REGISTRADA", origem: context.origem, entidadeTipo: "FECHAMENTO", entidadeId: id,
      detalhe: aprovada ? "Condição comercial aprovada pela Kidmais." : "Condição comercial recusada pela Kidmais.",
      metadata: { decisaoId: decisao.id } }, tx);
    return { fechamento, decisao, reutilizada: false };
  });
}
