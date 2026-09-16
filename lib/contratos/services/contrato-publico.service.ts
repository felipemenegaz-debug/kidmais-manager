import { bloquearAgendaFormalizacao, garantirFestaFormalizada } from '../../festas/formalizacao';
import { validarAmbienteFesta } from '../../festas/ambiente';
import { normalizarCpf } from "../../clientes/repositories/normalizers";
import {
  buscarClienteCanonicoPorId,
  registrarAuditoria,
  registrarEventoHistorico,
} from "../../clientes/repositories";
import type { DbExecutor } from "../../db/contracts";
import { db, withTransaction } from "../../db/postgres";
import { edicaoDaVersao } from './administrativo.service';
import { documentoParaLeitura, versaoPublicaId, concluirFluxoCliente } from './fluxo-publico';
import { lerDocumento } from '../storage/postgres';
import {
  buscarFechamentoPorIdParaAtualizacao,
  marcarFechamentoContratoAssinado,
} from "../../fechamentos/repositories";
import {
  buscarValidacaoPorTokenHash,
  type ValidacaoIdentidadeRecord,
} from "../../identidade/repositories";
import {
  consultarCpfPublico,
  criarIdentityServiceComAmbiente,
  hashProvaIdentidadeToken,
  type IdentityOtpSender,
} from "../../identidade/services";
import {
  buscarContratoPorId,
  buscarVersaoCorrente,
  buscarVersaoPorId,
  marcarContratoAssinado,
  marcarVersaoContratoAssinada,
  type ContratoRecord,
  type ContratoVersaoRecord,
} from "../repositories";
import {
  aceiteDoTemplatePermitido,
  contratoOficialDisponivelParaVersao,
  gerarResumoContratacaoPdfDaVersao,
} from "./documento.service";
import { criarContratoAcessoToken, validarContratoAcessoToken } from "./acesso-token";
import { ContratoServiceError } from "./errors";
import type {
  AssinarContratoPublicoInput,
  ContratoPublicoRequestContext,
} from "./models";

function acessoNegado(): never {
  throw new ContratoServiceError(
    "CONTRATO_ACESSO_NAO_AUTORIZADO",
    "Não foi possível validar o acesso a este Contrato.",
    404,
  );
}

async function carregarContratoComVersao(
  contratoId: string,
  customDb?: DbExecutor,
  forUpdate = false,
  acessoToken?: string,
): Promise<{ contrato: ContratoRecord; versao: ContratoVersaoRecord }> {
  if(forUpdate){
    const initial=await buscarContratoPorId(contratoId,customDb);
    if(initial)await buscarFechamentoPorIdParaAtualizacao(initial.fechamentoId,customDb??db());
  }
  const contrato = await buscarContratoPorId(
    contratoId,
    customDb,
    { forUpdate },
  );

  if (!contrato) {
    throw new ContratoServiceError(
      "CONTRATO_NAO_ENCONTRADO",
      "Contrato não encontrado.",
      404,
    );
  }

  const escolhida=acessoToken?validarContratoAcessoToken(acessoToken,{contratoId}).versaoId:await versaoPublicaId(contratoId,customDb);
  const versao = escolhida?await buscarVersaoPorId(escolhida,customDb,{forUpdate}):await buscarVersaoCorrente(
    contrato.id,
    customDb,
    { forUpdate },
  );

  if (!versao) {
    throw new ContratoServiceError(
      "DADOS_CONTRATUAIS_INCONSISTENTES",
      "Contrato encontrado sem versão corrente.",
      409,
    );
  }

  if (versao.contratoId !== contrato.id) acessoNegado();
  const edicao=await edicaoDaVersao(versao.id,customDb);
  if(edicao?.estado==='CANCELADA')throw new ContratoServiceError('VERSAO_CONTRATO_DIVERGENTE','Esta versão foi encerrada. Existe uma revisão mais recente; aguarde a liberação do novo acesso pela Kidmais.',409);
  if(edicao && !['AGUARDANDO_CLIENTE','CONCLUIDA'].includes(edicao.estado))acessoNegado();
  if (!edicao && versao.numeroVersao !== contrato.versaoAtual) {
    throw new ContratoServiceError(
      "DADOS_CONTRATUAIS_INCONSISTENTES",
      "A versão corrente não corresponde à versão atual do Contrato.",
      409,
      {
        versaoAtualContrato: contrato.versaoAtual,
        numeroVersaoCorrente: versao.numeroVersao,
      },
    );
  }

  return { contrato, versao };
}

async function clienteCanonicoDaVersao(
  versao: ContratoVersaoRecord,
  customDb?: DbExecutor,
) {
  const cliente = await buscarClienteCanonicoPorId(
    versao.snapshot.contratante.clienteId,
    customDb,
  );

  if (!cliente) {
    throw new ContratoServiceError(
      "DADOS_CONTRATUAIS_INCONSISTENTES",
      "O Cliente associado à versão contratual não está disponível.",
      409,
    );
  }

  if ('revisaoOperacional' in versao.snapshot &&
      (cliente.id !== versao.snapshot.contratante.clienteId ||
       normalizarCpf(cliente.cpf) !== normalizarCpf(versao.snapshot.contratante.cpf))) {
    throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES',
      'A identidade do contratante mudou. Cancele a proposta e prepare uma nova versão.', 409);
  }

  return cliente;
}

function provaAindaValida(record: ValidacaoIdentidadeRecord) {
  if (!record.provaExpiraEm) return false;
  const expira = new Date(record.provaExpiraEm).getTime();
  return Number.isFinite(expira) && expira > Date.now();
}

async function validarProvaParaLeitura(
  provaToken: string,
  acessoToken: string,
  contrato: ContratoRecord,
  versao: ContratoVersaoRecord,
  customDb?: DbExecutor,
) {
  const token = provaToken.trim();
  if (token.length < 32) acessoNegado();

  const acesso = validarContratoAcessoToken(acessoToken, {
    contratoId: contrato.id,
    versaoId: versao.id,
  });

  const validacao = await buscarValidacaoPorTokenHash(
    hashProvaIdentidadeToken(token),
    customDb,
  );

  if (
    !validacao ||
    validacao.id !== acesso.validacaoId ||
    validacao.finalidade !== "CONTRATO_ACEITE"
  ) acessoNegado();
  if (!provaAindaValida(validacao)) acessoNegado();

  const statusPermitido =
    validacao.status === "CONFIRMADA" ||
    (
      validacao.status === "CONSUMIDA" &&
      validacao.consumidoPorContratoVersaoId === versao.id
    );

  if (!statusPermitido) acessoNegado();

  const [clienteProva, clienteVersao] = await Promise.all([
    buscarClienteCanonicoPorId(validacao.clienteId, customDb),
    clienteCanonicoDaVersao(versao, customDb),
  ]);

  if (!clienteProva || clienteProva.id !== clienteVersao.id) acessoNegado();

  return {
    validacao,
    cliente: clienteVersao,
  };
}

export async function consultarAcessoContrato(input: {
  contratoId: string;
  cpf: string;
}) {
  const { contrato, versao } = await carregarContratoComVersao(input.contratoId);
  const cpfInformado = normalizarCpf(input.cpf);
  const cpfSnapshot = normalizarCpf(versao.snapshot.contratante.cpf);

  if (!cpfInformado || !cpfSnapshot || cpfInformado !== cpfSnapshot) acessoNegado();

  const consulta = await consultarCpfPublico(cpfInformado);
  if (consulta.situacao === "NOVO_CLIENTE") acessoNegado();

  return {
    contratoId: contrato.id,
    status: contrato.status,
    situacao: consulta.situacao,
    canais: consulta.canais,
  };
}

export async function iniciarDesafioContrato(
  input: {
    contratoId: string;
    cpf: string;
    canal: "WHATSAPP";
  },
  enviarOtp: IdentityOtpSender,
) {
  const acesso = await consultarAcessoContrato({
    contratoId: input.contratoId,
    cpf: input.cpf,
  });

  if (
    acesso.situacao !== "CLIENTE_EXISTENTE" ||
    !acesso.canais.some((item) => item.canal === input.canal)
  ) {
    acessoNegado();
  }

  const { contrato, versao } = await carregarContratoComVersao(input.contratoId);
  const identity = criarIdentityServiceComAmbiente(enviarOtp);
  const desafio = await identity.iniciarDesafio({
    cpf: input.cpf,
    canal: input.canal,
    finalidade: "CONTRATO_ACEITE",
  });

  return {
    ...desafio,
    acessoToken: criarContratoAcessoToken({
      contratoId: contrato.id,
      versaoId: versao.id,
      validacaoId: desafio.validacaoId,
    }),
  };
}

export async function obterContextoContratoPublico(input: {
  contratoId: string;
  provaToken: string;
  acessoToken: string;
}) {
  const { contrato, versao } = await carregarContratoComVersao(input.contratoId,undefined,false,input.acessoToken);
  await validarProvaParaLeitura(input.provaToken, input.acessoToken, contrato, versao);
  const resumo = gerarResumoContratacaoPdfDaVersao(versao);
  const modeloOficial = contratoOficialDisponivelParaVersao(versao);
  const contratoOficial = modeloOficial.disponivel
    ? await documentoParaLeitura(versao)
    : null;

  return {
    contrato: {
      id: contrato.id,
      status: contrato.status,
      assinadoEm: contrato.assinadoEm,
    },
    comprovantes: (await db().query<{id:string;parte:string;nome:string;assinado_em:string}>(`SELECT a.comprovante_documento_id AS id,a.parte,a.identidade_snapshot->>'nome' AS nome,a.assinado_em::text FROM contrato_assinaturas a WHERE a.contrato_versao_id=$1 ORDER BY assinado_em`,[versao.id])).rows,
    versao: {
      id: versao.id,
      numero: versao.numeroVersao,
      status: versao.status,
      snapshotHash: versao.snapshotHash,
      resumo: {
        templateVersao: resumo.templateVersao,
        pdfHash: resumo.pdfHash,
      },
      contratoOficial: {
        disponivel: modeloOficial.disponivel,
        modeloCodigo: contratoOficial?.modeloCodigo ?? modeloOficial.modeloCodigo,
        templateVersao: contratoOficial?.templateVersao ?? modeloOficial.templateVersao,
        pdfHash: contratoOficial?.pdfHash ?? null,
        homologadoParaProducao: contratoOficial?.documento.homologadoParaProducao ?? false,
      },
      documentoTemplateVersao: contratoOficial?.templateVersao ?? null,
      documentoPdfHash: contratoOficial?.pdfHash ?? null,
      documentoHomologadoParaProducao: contratoOficial?.documento.homologadoParaProducao ?? false,
      assinadoEm: versao.assinadoEm,
    },
    evento: {
      data: versao.snapshot.evento.data,
      horarioInicio: versao.snapshot.evento.horarioInicio,
      horarioFim: versao.snapshot.evento.horarioFim,
      pacote: versao.snapshot.evento.pacote.nome,
      pacoteCodigo: versao.snapshot.evento.pacote.codigo,
      aniversariante: versao.snapshot.aniversariante.nome,
      valorFinalContrato: versao.snapshot.comercial.valorFinalContrato,
    },
    aceitePermitido:
      modeloOficial.disponivel &&
      aceiteDoTemplatePermitido({
        disponivel: modeloOficial.disponivel,
        homologadoParaProducao: modeloOficial.homologadoParaProducao,
      }) &&
      versao.status === "ATIVA",
  };
}

export async function gerarPdfContratoPublico(input: {
  contratoId: string;
  provaToken: string;
  acessoToken: string;
}) {
  const { contrato, versao } = await carregarContratoComVersao(input.contratoId,undefined,false,input.acessoToken);
  await validarProvaParaLeitura(input.provaToken, input.acessoToken, contrato, versao);
  const documento = await documentoParaLeitura(versao);

  return {
    contrato,
    versao,
    ...documento,
  };
}

export async function lerComprovantePublico(input:{contratoId:string;provaToken:string;acessoToken:string;documentoId:string}){
  const {contrato,versao}=await carregarContratoComVersao(input.contratoId,undefined,false,input.acessoToken);
  await validarProvaParaLeitura(input.provaToken,input.acessoToken,contrato,versao);
  const vinculo=await db().query('SELECT id FROM contrato_assinaturas WHERE contrato_versao_id=$1 AND comprovante_documento_id=$2',[versao.id,input.documentoId]);
  if(!vinculo.rows[0])acessoNegado();return lerDocumento(input.documentoId);
}

export async function gerarPdfContratoAdmin(fechamentoId: string) {
  const { buscarContratoPorFechamentoId } = await import("../repositories");
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
  return { contrato, versao, ...await documentoParaLeitura(versao) };
}

export async function gerarResumoContratoPublico(input: {
  contratoId: string;
  provaToken: string;
  acessoToken: string;
}) {
  const { contrato, versao } = await carregarContratoComVersao(input.contratoId,undefined,false,input.acessoToken);
  await validarProvaParaLeitura(input.provaToken, input.acessoToken, contrato, versao);
  const documento = gerarResumoContratacaoPdfDaVersao(versao);
  return { contrato, versao, ...documento };
}

export async function gerarResumoContratoAdmin(fechamentoId: string) {
  const { buscarContratoPorFechamentoId } = await import("../repositories");
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
  return { contrato, versao, ...gerarResumoContratacaoPdfDaVersao(versao) };
}

export async function assinarContratoPublico(
  input: AssinarContratoPublicoInput,
  enviarOtp: IdentityOtpSender,
  context: ContratoPublicoRequestContext = {},
) {
  const identity = criarIdentityServiceComAmbiente(enviarOtp);

  return withTransaction(async (tx) => {
    const { contrato, versao } = await carregarContratoComVersao(
      input.contratoId,
      tx,
      true,
      input.acessoToken,
    );

    if (
      versao.id !== input.versaoId ||
      versao.snapshotHash !== input.snapshotHash
    ) {
      throw new ContratoServiceError(
        "VERSAO_CONTRATO_DIVERGENTE",
        "A versão exibida não é mais a versão corrente do Contrato.",
        409,
        {
          versaoAtualId: versao.id,
          numeroVersaoAtual: versao.numeroVersao,
        },
      );
    }

    const edicao=await edicaoDaVersao(versao.id,tx);
    const documento = await documentoParaLeitura(versao,tx);
    if (documento.pdfHash !== input.documentoPdfHash) {
      throw new ContratoServiceError(
        "DOCUMENTO_CONTRATO_DIVERGENTE",
        "O documento exibido não corresponde mais ao documento corrente.",
        409,
      );
    }

    const acesso = validarContratoAcessoToken(input.acessoToken, {
      contratoId: contrato.id,
      versaoId: versao.id,
    });
    const tokenHash = hashProvaIdentidadeToken(input.provaToken.trim());

    // Retry legítimo após commit: mesma prova, mesma versão e mesmo documento.
    if (contrato.status === "ASSINADO" && versao.status === "ASSINADA") {
      const validacaoAnterior = await buscarValidacaoPorTokenHash(tokenHash, tx);
      if (
        validacaoAnterior?.id === acesso.validacaoId &&
        validacaoAnterior.finalidade === "CONTRATO_ACEITE" &&
        validacaoAnterior.status === "CONSUMIDA" &&
        validacaoAnterior.consumidoPorContratoVersaoId === versao.id &&
        versao.documentoPdfHash === documento.pdfHash
      ) {
        await validarAmbienteFesta(tx);
        const festa = await garantirFestaFormalizada(tx, contrato.id, versao.id, context, 'RETRY');
        return {
          ...festa,
          contrato,
          versao,
          fechamentoStatus: "CONTRATO_ASSINADO" as const,
          reutilizado: true,
        };
      }

      throw new ContratoServiceError(
        "CONTRATO_JA_ASSINADO",
        "Este Contrato já foi assinado.",
        409,
      );
    }

    if (!aceiteDoTemplatePermitido({
      disponivel: true,
      homologadoParaProducao: documento.documento.homologadoParaProducao,
    })) {
      throw new ContratoServiceError(
        "TEMPLATE_CONTRATUAL_NAO_HOMOLOGADO",
        "O template contratual atual ainda não está liberado para aceite neste ambiente.",
        409,
      );
    }

    if ((!edicao && contrato.status !== "AGUARDANDO_ASSINATURA") || versao.status !== "ATIVA" || (edicao && edicao.estado!=='AGUARDANDO_CLIENTE')) {
      throw new ContratoServiceError(
        "STATUS_CONTRATO_NAO_PERMITE_ASSINATURA",
        "O estado atual do Contrato não permite assinatura.",
        409,
        { contratoStatus: contrato.status, versaoStatus: versao.status },
      );
    }

    const fechamento = await buscarFechamentoPorIdParaAtualizacao(
      contrato.fechamentoId,
      tx,
    );
    if (!fechamento) {
      throw new ContratoServiceError(
        "FECHAMENTO_NAO_ENCONTRADO",
        "O Fechamento associado ao Contrato não foi encontrado.",
        404,
      );
    }

    if (fechamento.status !== "AGUARDANDO_CONTRATO" && !(edicao && contrato.status==='ASSINADO' && ['CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO','CONFIRMADO'].includes(fechamento.status))) {
      throw new ContratoServiceError(
        "STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO",
        "O estado atual do Fechamento não permite concluir a assinatura do Contrato.",
        409,
        { statusAtual: fechamento.status },
      );
    }

    await validarProvaParaLeitura(
      input.provaToken,
      input.acessoToken,
      contrato,
      versao,
      tx,
    );

    if (!edicao) throw new ContratoServiceError('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'Fluxo legado exige revisão antes da formalização automática.', 409);
    await validarAmbienteFesta(tx);
    await bloquearAgendaFormalizacao(tx, contrato.id);

    const prova = await identity.consumirProvaParaContrato(
      input.provaToken,
      versao.id,
      tx,
    );

    const clienteVersao = await clienteCanonicoDaVersao(versao, tx);
    if (prova.clienteId !== clienteVersao.id) acessoNegado();

    const versaoAssinada = await marcarVersaoContratoAssinada(
      {
        versaoId: versao.id,
        documentoTemplateVersao: documento.templateVersao,
        documentoPdfHash: documento.pdfHash,
        aceiteMetodo: "OTP",
      },
      tx,
    );
    if (!versaoAssinada) {
      throw new ContratoServiceError(
        "STATUS_CONTRATO_NAO_PERMITE_ASSINATURA",
        "A versão contratual não pôde ser marcada como assinada.",
        409,
      );
    }

    if(edicao)await concluirFluxoCliente(tx,versaoAssinada,acesso.validacaoId,context);
    const contratoAssinado = edicao?await buscarContratoPorId(contrato.id,tx):await marcarContratoAssinado(contrato.id, tx);
    if (!contratoAssinado) {
      throw new ContratoServiceError(
        "STATUS_CONTRATO_NAO_PERMITE_ASSINATURA",
        "O Contrato não pôde ser marcado como assinado.",
        409,
      );
    }

    const fechamentoAssinado = fechamento.status==='AGUARDANDO_CONTRATO'?await marcarFechamentoContratoAssinado(
      fechamento.id,
      tx,
    ):fechamento;
    if (!fechamentoAssinado) {
      throw new ContratoServiceError(
        "STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO",
        "O Fechamento não pôde avançar para CONTRATO_ASSINADO.",
        409,
      );
    }

    await garantirFestaFormalizada(tx, contrato.id, versaoAssinada.id, context);

    await registrarEventoHistorico(
      {
        clienteId: clienteVersao.id,
        tipoEvento: "CONTRATO_ASSINADO",
        origem: "CONTRATO_PUBLICO",
        entidadeTipo: "CONTRATO",
        entidadeId: contrato.id,
        detalhe: `Contrato V${versao.numeroVersao} aceito eletronicamente por OTP.`,
        metadata: {
          contratoId: contrato.id,
          contratoVersaoId: versao.id,
          numeroVersao: versao.numeroVersao,
          snapshotHash: versao.snapshotHash,
          documentoPdfHash: documento.pdfHash,
          documentoTemplateVersao: documento.templateVersao,
          metodo: "OTP",
        },
        critico: true,
      },
      tx,
    );

    await registrarAuditoria(
      {
        clienteId: clienteVersao.id,
        atorTipo: "CLIENTE",
        acao: "CONTRATO_ACEITO_CLIENTE",
        entidadeTipo: "CONTRATO_VERSAO",
        entidadeId: versao.id,
        dadosAntes: {
          contratoStatus: contrato.status,
          versaoStatus: versao.status,
          fechamentoStatus: fechamento.status,
        },
        dadosDepois: {
          contratoStatus: contratoAssinado.status,
          versaoStatus: versaoAssinada.status,
          fechamentoStatus: fechamentoAssinado.status,
          snapshotHash: versao.snapshotHash,
          documentoPdfHash: documento.pdfHash,
          documentoTemplateVersao: documento.templateVersao,
          aceiteMetodo: "OTP",
          validacaoId: prova.validacaoId,
        },
        origem: "CONTRATO_PUBLICO",
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    return {
      contrato: contratoAssinado,
      versao: versaoAssinada,
      fechamentoStatus: fechamentoAssinado.status,
      reutilizado: false,
    };
  });
}
