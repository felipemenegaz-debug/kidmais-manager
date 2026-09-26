import {
  buscarAniversariantePorId,
  buscarClienteCanonicoPorId,
  buscarResponsavelPorId,
  registrarAuditoria,
  registrarEventoHistorico,
  type AniversarianteRecord,
  type ClienteRecord,
  type ResponsavelRecord,
} from "../../clientes/repositories";
import { camposFaltantesParaContrato } from "../../clientes/services";
import type { DbExecutor } from "../../db/contracts";
import { withTransaction } from "../../db/postgres";
import {
  buscarFechamentoPorIdParaAtualizacao,
  listarAdicionaisDoFechamento,
  type FechamentoAdicionalRecord,
  type FechamentoRecord,
} from "../../fechamentos/repositories";
import {
  atualizarVersaoAtualContrato,
  buscarContratoPorFechamentoId,
  buscarReferenciasComerciaisContrato,
  buscarVersaoCorrente,
  criarContrato,
  criarContratoVersao,
  substituirVersaoAtiva,
  type ContratoSnapshot,
  type ContratoSnapshotV1,
  type PacoteAplicadoContrato,
  type ReferenciasComerciaisContrato,
} from "../repositories";
import { lerFotografiaPacoteVigente } from "./fotografia-pacote";
import { ContratoServiceError } from "./errors";
import type {
  ContratoServiceContext,
  GerarContratoInput,
  GerarContratoResult,
} from "./models";

import { hashSnapshotContrato, valorFinalContrato } from "./snapshot-core";
import { calcularCondicaoComercial } from "../../comercial/condicao-pagamento";

export function montarSnapshotContratoV1(input: {
  fechamento: FechamentoRecord;
  cliente: ClienteRecord;
  aniversariante: AniversarianteRecord;
  responsavelAdicional: ResponsavelRecord | null;
  adicionais: FechamentoAdicionalRecord[];
  referencias: ReferenciasComerciaisContrato;
}): ContratoSnapshotV1 {
  const { fechamento, cliente, aniversariante, responsavelAdicional, adicionais, referencias } = input;
  if (fechamento.condicaoPagamento && (
    fechamento.condicaoPagamento.forma !== fechamento.formaPagamentoPretendida ||
    !["APROVADA", "DISPENSADA"].includes(fechamento.condicaoPagamento.revisaoStatus) ||
    (fechamento.formaPagamentoPretendida === "PIX_PARCELADO" && fechamento.condicaoPagamento.revisaoStatus !== "APROVADA")
  )) {
    throw new ContratoServiceError("DADOS_CONTRATUAIS_INCONSISTENTES", "A condição comercial deve ser aprovada antes do Contrato.", 409);
  }

  if (!cliente.cpf || !cliente.email || !cliente.cep || !cliente.logradouro || !cliente.numero || !cliente.bairro || !cliente.cidade || !cliente.uf) {
    throw new ContratoServiceError(
      "CADASTRO_CONTRATUAL_INCOMPLETO",
      "O cadastro do Cliente ainda não possui todos os dados obrigatórios para o Contrato.",
      409,
    );
  }

  return {
    schemaVersao: 1,
    fechamento: {
      id: fechamento.id,
      status: fechamento.status,
      origem: fechamento.origemFechamento,
    },
    contratante: {
      clienteId: cliente.id,
      nomeCompleto: cliente.nomeCompleto,
      cpf: cliente.cpf,
      rg: cliente.rg,
      telefone: cliente.telefone,
      whatsapp: cliente.whatsapp,
      email: cliente.email,
      endereco: {
        cep: cliente.cep,
        logradouro: cliente.logradouro,
        numero: cliente.numero,
        complemento: cliente.complemento,
        bairro: cliente.bairro,
        cidade: cliente.cidade,
        uf: cliente.uf,
      },
    },
    responsavelAdicional: responsavelAdicional
      ? {
          id: responsavelAdicional.id,
          nome: responsavelAdicional.nome,
          cpf: responsavelAdicional.cpf,
          telefone: responsavelAdicional.telefone,
          whatsapp: responsavelAdicional.whatsapp,
          email: responsavelAdicional.email,
          relacao: responsavelAdicional.relacao,
        }
      : null,
    aniversariante: {
      id: aniversariante.id,
      nome: aniversariante.nome,
      dataNascimento: aniversariante.dataNascimento,
      idadeNoEvento: fechamento.idadeAniversarianteEvento,
      temaFesta: fechamento.temaFesta ?? aniversariante.temaPadrao,
    },
    evento: {
      data: fechamento.dataEvento,
      horarioInicio: fechamento.horarioInicio,
      horarioFim: fechamento.horarioFim,
      pacote: {
        id: referencias.pacoteId,
        codigo: referencias.pacoteCodigo,
        nome: referencias.pacoteNome,
        duracaoMinutos: referencias.pacoteDuracaoMinutos,
      },
      convidados: fechamento.convidados,
      convidadosFaturados: fechamento.convidadosFaturados,
    },
    contratacao: {
      adicionais: adicionais.map((item) => ({
        adicionalId: item.adicionalId,
        nome: item.nomeAplicado,
        unidadeCobranca: item.unidadeCobrancaAplicada,
        quantidade: item.quantidade,
        valorUnitario: item.valorUnitarioAplicado,
        valorTotal: item.valorTotal,
        observacoes: item.observacoes,
      })),
      alteracoesPacote: fechamento.alteracoesPacote,
      observacoesCliente: fechamento.observacoesCliente,
      observacoesEquipe: fechamento.observacoesEquipe,
      buffet: {
        status: fechamento.buffetStatus,
        salgados: fechamento.buffetSalgados,
        bebidas: fechamento.buffetBebidas,
        doces: fechamento.buffetDoces,
        bolo: fechamento.buffetBolo,
        outros: fechamento.buffetOutros,
lembrancinha: fechamento.buffetLembrancinha ?? null,
empratado: fechamento.buffetEmpratado ?? null,
bombom: fechamento.buffetBombom ?? null,
      },
    },
    comercial: {
      tabelaPreco: {
        id: referencias.tabelaPrecoId,
        codigo: referencias.tabelaPrecoCodigo,
        nome: referencias.tabelaPrecoNome,
      },
      categoriaHorario: fechamento.categoriaHorario,
      categoriaPrecoAplicada: fechamento.categoriaPrecoAplicada,
      valorPacoteBase: fechamento.valorPacoteBase,
      descontoPercentual: fechamento.descontoPercentual,
      valorDescontoPacote: fechamento.valorDescontoPacote,
      valorPacoteAplicado: fechamento.valorPacoteAplicado,
      valorAdicionais: fechamento.valorAdicionais,
      valorTabela: fechamento.valorTabela,
      valorNegociado: fechamento.valorNegociado,
      valorAprovado: fechamento.valorAprovado,
      valorFinalContrato: valorFinalContrato(fechamento),
      formaPagamentoPretendida: fechamento.formaPagamentoPretendida,
      ...(fechamento.condicaoPagamento ? {
        ...calcularCondicaoComercial(fechamento.valorAprovado ?? fechamento.valorTabela, fechamento.condicaoPagamento.forma),
        condicaoPagamento: fechamento.condicaoPagamento,
      } : {}),
    },
  };
}

function referenciasDaFotografia(aplicada: PacoteAplicadoContrato): ReferenciasComerciaisContrato {
  return {
    pacoteId: aplicada.pacoteId,
    pacoteCodigo: aplicada.codigo,
    pacoteNome: aplicada.nome,
    pacoteDuracaoMinutos: aplicada.duracaoMinutos,
    tabelaPrecoId: aplicada.tabelaPreco.id,
    tabelaPrecoCodigo: aplicada.tabelaPreco.codigo,
    tabelaPrecoNome: aplicada.tabelaPreco.nome,
  };
}

function comFotografia(base: ContratoSnapshotV1, aplicada: PacoteAplicadoContrato): ContratoSnapshot {
  return {
    ...base,
    schemaVersao: 2,
    pacoteAplicado: aplicada,
  };
}

function pendenciasParaAssinatura(fechamento: FechamentoRecord) {
  const pendencias: Array<{ campo: string; label: string }> = [];
  if (!fechamento.formaPagamentoPretendida) {
    pendencias.push({
      campo: "formaPagamentoPretendida",
      label: "Forma de pagamento pretendida",
    });
  }
  return pendencias;
}

export async function carregarSnapshot(
  fechamento: FechamentoRecord,
  tx: DbExecutor,
  preparacao?: { id: string; adicionais: FechamentoAdicionalRecord[] },
): Promise<{
  snapshot: ContratoSnapshot;
  cliente: ClienteRecord;
}> {
  if (!fechamento.clienteId) {
    throw new ContratoServiceError(
      "CLIENTE_NAO_VINCULADO",
      "O Fechamento não possui Cliente vinculado.",
      409,
    );
  }
  if (!fechamento.aniversarianteId) {
    throw new ContratoServiceError(
      "ANIVERSARIANTE_NAO_VINCULADO",
      "O Fechamento não possui Aniversariante vinculado.",
      409,
    );
  }

  const cliente = await buscarClienteCanonicoPorId(fechamento.clienteId, tx);
  if (!cliente) {
    throw new ContratoServiceError(
      "CLIENTE_NAO_VINCULADO",
      "O Cliente vinculado ao Fechamento não está disponível.",
      409,
    );
  }

  const faltantes = camposFaltantesParaContrato(cliente);
  if (faltantes.length > 0) {
    throw new ContratoServiceError(
      "CADASTRO_CONTRATUAL_INCOMPLETO",
      "Complete o cadastro do Cliente antes de gerar o Contrato.",
      409,
      { camposFaltantes: faltantes },
    );
  }

  const aniversariante=await buscarAniversariantePorId(fechamento.aniversarianteId, tx);
  const adicionais=preparacao ? preparacao.adicionais : await listarAdicionaisDoFechamento(fechamento.id, tx);
  const aplicada = preparacao ? null : await lerFotografiaPacoteVigente(tx, fechamento.id);
  const referencias = aplicada
    ? referenciasDaFotografia(aplicada)
    : await buscarReferenciasComerciaisContrato(fechamento.id, tx, preparacao?.id);

  if (!aniversariante) {
    throw new ContratoServiceError(
      "ANIVERSARIANTE_NAO_VINCULADO",
      "O Aniversariante vinculado ao Fechamento não está disponível.",
      409,
    );
  }
  if (!referencias) {
    throw new ContratoServiceError(
      "REFERENCIA_COMERCIAL_INCONSISTENTE",
      "Não foi possível recuperar o pacote e a tabela de preço do Fechamento.",
      409,
    );
  }

  let responsavelAdicional: ResponsavelRecord | null = null;
  if (fechamento.responsavelAdicionalId) {
    responsavelAdicional = await buscarResponsavelPorId(
      fechamento.responsavelAdicionalId,
      tx,
    );
    if (!responsavelAdicional || responsavelAdicional.clienteId !== cliente.id) {
      throw new ContratoServiceError(
        "DADOS_CONTRATUAIS_INCONSISTENTES",
        "O Responsável adicional do Fechamento não pertence ao Cliente contratante.",
        409,
      );
    }
  }

  const base = montarSnapshotContratoV1({
    fechamento,
    cliente,
    aniversariante,
    responsavelAdicional,
    adicionais,
    referencias,
  });
  return {
    cliente,
    snapshot: aplicada ? comFotografia(base, aplicada) : base,
  };
}

export async function gerarContrato(
  input: GerarContratoInput,
  context: ContratoServiceContext,
): Promise<GerarContratoResult> {
  return withTransaction(async (tx) => {
    const fechamento = await buscarFechamentoPorIdParaAtualizacao(
      input.fechamentoId,
      tx,
    );

    if (!fechamento) {
      throw new ContratoServiceError(
        "FECHAMENTO_NAO_ENCONTRADO",
        "Fechamento não encontrado.",
        404,
      );
    }

    if (fechamento.status !== "AGUARDANDO_CONTRATO") {
      throw new ContratoServiceError(
        "STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO",
        "O Contrato só pode ser gerado quando o Fechamento está aguardando contrato.",
        409,
        { statusAtual: fechamento.status },
      );
    }

    const { snapshot, cliente } = await carregarSnapshot(fechamento, tx);
    const snapshotHash = hashSnapshotContrato(snapshot);

    let contrato = await buscarContratoPorFechamentoId(
      fechamento.id,
      tx,
      { forUpdate: true },
    );

    if (contrato?.status === "ASSINADO") {
      throw new ContratoServiceError(
        "CONTRATO_ASSINADO_NAO_REGERAR",
        "Contrato assinado não pode ser regenerado.",
        409,
      );
    }

    if (contrato?.status === "CANCELADO") {
      throw new ContratoServiceError(
        "CONTRATO_CANCELADO_NAO_REGERAR",
        "Contrato cancelado não pode ser regenerado no mesmo registro lógico.",
        409,
      );
    }

    if (!contrato) {
      contrato = await criarContrato(
        {
          fechamentoId: fechamento.id,
          criadoPorUsuarioId: context.usuarioId ?? null,
        },
        tx,
      );
    }

    const corrente = await buscarVersaoCorrente(contrato.id, tx);

    if (contrato.versaoAtual > 0 && !corrente) {
      throw new ContratoServiceError(
        "DADOS_CONTRATUAIS_INCONSISTENTES",
        "Contrato possui número de versão atual, mas não possui versão documental corrente.",
        409,
      );
    }

    if (corrente && corrente.numeroVersao !== contrato.versaoAtual) {
      throw new ContratoServiceError(
        "DADOS_CONTRATUAIS_INCONSISTENTES",
        "A versão corrente do Contrato diverge do número de versão registrado.",
        409,
      );
    }

    if (corrente?.snapshotHash === snapshotHash) {
      return {
        contrato,
        versao: corrente,
        reutilizado: true,
        pendenciasParaAssinatura: pendenciasParaAssinatura(fechamento),
      };
    }

    if (corrente?.status === "ASSINADA") {
      throw new ContratoServiceError(
        "CONTRATO_ASSINADO_NAO_REGERAR",
        "A versão atual do Contrato já foi assinada.",
        409,
      );
    }

    if (corrente) {
      const edicao = await tx.query('SELECT contrato_versao_id FROM contrato_edicoes WHERE contrato_versao_id=$1', [corrente.id]);
      if (edicao.rows[0]) {
        throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES', 'O Contrato já possui elaboração administrativa. Abra essa versão para revisar os campos documentais permitidos.', 409);
      }
      await substituirVersaoAtiva(corrente.id, tx);
    }

    const numeroVersao = contrato.versaoAtual + 1;
    const versao = await criarContratoVersao(
      {
        contratoId: contrato.id,
        numeroVersao,
        snapshot,
        snapshotHash,
        motivoNovaVersao: input.motivoNovaVersao?.trim() || null,
        geradoPorUsuarioId: context.usuarioId ?? null,
      },
      tx,
    );

    if (!context.usuarioId) throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES','Geração exige usuário administrativo autenticado.',403);
    const { iniciarEdicao } = await import('./administrativo.service');
    await iniciarEdicao(tx, versao, context.usuarioId);

    contrato = await atualizarVersaoAtualContrato(
      contrato.id,
      numeroVersao,
      tx,
    );

    const tipoEvento = corrente ? "CONTRATO_REGERADO" : "CONTRATO_GERADO";
    await registrarEventoHistorico(
      {
        clienteId: cliente.id,
        clienteOrigemId: cliente.id,
        tipoEvento,
        origem: context.origem,
        entidadeTipo: "CONTRATO",
        entidadeId: contrato.id,
        usuarioId: context.usuarioId ?? null,
        detalhe: corrente
          ? `Contrato regenerado na versão ${numeroVersao}.`
          : "Contrato gerado a partir do Fechamento aprovado.",
        metadata: {
          fechamentoId: fechamento.id,
          versao: numeroVersao,
          snapshotHash,
        },
      },
      tx,
    );

    await registrarAuditoria(
      {
        clienteId: cliente.id,
        atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null,
        acao: tipoEvento,
        entidadeTipo: "CONTRATO",
        entidadeId: contrato.id,
        dadosAntes: corrente
          ? { versao: corrente.numeroVersao, snapshotHash: corrente.snapshotHash }
          : null,
        dadosDepois: { versao: numeroVersao, snapshotHash },
        justificativa: input.motivoNovaVersao?.trim() || null,
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    return {
      contrato,
      versao,
      reutilizado: false,
      pendenciasParaAssinatura: pendenciasParaAssinatura(fechamento),
    };
  });
}

export async function obterContratoPorFechamento(fechamentoId: string) {
  const contrato = await buscarContratoPorFechamentoId(fechamentoId);
  if (!contrato) {
    throw new ContratoServiceError(
      "CONTRATO_NAO_ENCONTRADO",
      "Contrato ainda não gerado para este Fechamento.",
      404,
    );
  }

  const versao = await buscarVersaoCorrente(contrato.id);
  if (!versao) {
    throw new ContratoServiceError(
      "DADOS_CONTRATUAIS_INCONSISTENTES",
      "Contrato encontrado sem versão corrente.",
      409,
    );
  }

  return { contrato, versao };
}
