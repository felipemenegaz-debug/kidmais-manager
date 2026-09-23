import type { DbExecutor } from "../../db/contracts";
import { isUniqueViolation } from "../../db/errors";
import { withTransaction } from "../../db/postgres";
import {
  atualizarCliente,
  bloquearNomeAniversariante,
  buscarAniversarianteAtivoPorNome,
  buscarAniversariantePorId,
  buscarClienteCanonicoPorCpf,
  buscarClienteCanonicoPorId,
  buscarResponsavelAtivoPorNome,
  criarAniversariante,
  criarCliente,
  criarResponsavel,
  registrarAuditoria,
  registrarEventoHistorico,
  registrarPossivelDuplicidade,
  type ClienteRecord,
} from "../../clientes/repositories";
import {
  normalizarCpf,
  normalizarTelefone,
} from "../../clientes/repositories/normalizers";
import {
  analisarCadastroCliente,
  camposFaltantesParaContrato,
  validarCadastroBasicoCliente,
} from "../../clientes/services";
import { criarIdentityServiceComAmbiente } from "../../identidade/services";
import { buscarPacoteAtivoPorId } from "../../comercial/repositories";
import { pacoteCodigoContratavelV1 } from "../../comercial/pacotes-v1";
import { criarFechamentoComercial } from "./fechamento.service";
import { resolverEscolhasBuffet, gravarEscolhasBuffet } from "./escolhas-buffet.service";
import { FechamentoServiceError } from "./errors";
import type {
  CriarFechamentoComercialInput,
  CriarFechamentoComercialResult,
} from "./models";

export type DadosClienteFechamentoPublico = {
  nomeCompleto: string;
  cpf: string;
  rg?: string | null;
  telefone?: string | null;
  whatsapp?: string | null;
  email: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento?: string | null;
  bairro: string;
  cidade: string;
  uf: string;
};

export type AniversarianteFechamentoPublico = {
  aniversarianteIdExistente?: string | null;
  nome: string;
  temaPadrao?: string | null;
};

export type IdentidadeFechamentoPublico =
  | {
      tipo: "NOVO_CLIENTE";
      provaToken?: null;
      atualizarCadastro?: false;
    }
  | {
      tipo: "CLIENTE_EXISTENTE";
      provaToken: string;
      atualizarCadastro: boolean;
    };

export type CriarFechamentoPublicoInput = Omit<
  CriarFechamentoComercialInput,
  | "origemFechamento"
  | "clienteId"
  | "aniversarianteId"
  | "iniciadoPorUsuarioId"
  | "usuarioResponsavelId"
> & {
  escolhasBuffet?: Record<string,string[]>;
  identidade: IdentidadeFechamentoPublico;
  cliente: DadosClienteFechamentoPublico;
  aniversariante: AniversarianteFechamentoPublico;
  responsavelAdicionalNome?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type CriarFechamentoPublicoResult = CriarFechamentoComercialResult & {
  cliente: {
    novo: boolean;
    cadastroCompletoParaContrato: boolean;
    camposFaltantesParaContrato: Array<{ campo: string; label: string }>;
    cadastroAtualizado: boolean;
  };
  aniversariante: {
    novo: boolean;
  };
};

function snapshotCliente(cliente: ClienteRecord) {
  return {
    nomeCompleto: cliente.nomeCompleto,
    cpf: cliente.cpf,
    rg: cliente.rg,
    telefone: cliente.telefone,
    whatsapp: cliente.whatsapp,
    email: cliente.email,
    cep: cliente.cep,
    logradouro: cliente.logradouro,
    numero: cliente.numero,
    complemento: cliente.complemento,
    bairro: cliente.bairro,
    cidade: cliente.cidade,
    uf: cliente.uf,
  };
}

function diffCliente(before: ClienteRecord, after: ClienteRecord) {
  const antes = snapshotCliente(before);
  const depois = snapshotCliente(after);
  const dadosAntes: Record<string, unknown> = {};
  const dadosDepois: Record<string, unknown> = {};

  for (const key of Object.keys(antes) as Array<keyof typeof antes>) {
    if (antes[key] !== depois[key]) {
      dadosAntes[key] = antes[key];
      dadosDepois[key] = depois[key];
    }
  }

  return {
    dadosAntes,
    dadosDepois,
    camposAlterados: Object.keys(dadosDepois),
  };
}

function validarDadosClientePublico(dados: DadosClienteFechamentoPublico) {
  validarCadastroBasicoCliente({
    nomeCompleto: dados.nomeCompleto,
    cpf: dados.cpf,
    telefone: dados.telefone,
    whatsapp: dados.whatsapp,
    email: dados.email,
    cep: dados.cep,
    logradouro: dados.logradouro,
    numero: dados.numero,
    complemento: dados.complemento,
    bairro: dados.bairro,
    cidade: dados.cidade,
    uf: dados.uf,
  });

  const camposObrigatorios = [
    ["email", dados.email],
    ["cep", dados.cep],
    ["logradouro", dados.logradouro],
    ["numero", dados.numero],
    ["bairro", dados.bairro],
    ["cidade", dados.cidade],
    ["uf", dados.uf],
  ] as const;

  const faltantes = camposObrigatorios
    .filter(([, valor]) => !valor?.trim())
    .map(([campo]) => campo);

  if (!normalizarCpf(dados.cpf) || faltantes.length > 0) {
    throw new FechamentoServiceError(
      "CADASTRO_INCOMPLETO",
      "Preencha os dados cadastrais obrigatórios antes de continuar.",
      400,
      { campos: faltantes },
    );
  }

  const temContato = Boolean(
    normalizarTelefone(dados.whatsapp) || normalizarTelefone(dados.telefone),
  );
  if (!temContato) {
    throw new FechamentoServiceError(
      "CADASTRO_INCOMPLETO",
      "Informe WhatsApp ou telefone.",
      400,
      { campos: ["contato"] },
    );
  }
}

async function registrarDuplicidadesNovoCliente(
  clienteId: string,
  dados: DadosClienteFechamentoPublico,
  tx: DbExecutor,
) {
  const analise = await analisarCadastroCliente(
    {
      nomeCompleto: dados.nomeCompleto,
      cpf: dados.cpf,
      telefone: dados.telefone,
      whatsapp: dados.whatsapp,
    },
    { excluirClienteId: clienteId },
    tx,
  );

  for (const candidato of analise.possiveisDuplicidades) {
    await registrarPossivelDuplicidade(
      {
        clienteUmId: clienteId,
        clienteDoisId: candidato.clienteId,
        motivos: candidato.motivos,
      },
      tx,
    );
  }
}

async function criarNovoCliente(
  dados: DadosClienteFechamentoPublico,
  input: CriarFechamentoPublicoInput,
  tx: DbExecutor,
) {
  const cpf = normalizarCpf(dados.cpf);
  const existente = cpf ? await buscarClienteCanonicoPorCpf(cpf, tx) : null;
  if (existente) {
    throw new FechamentoServiceError(
      "CPF_EXISTENTE_REQUER_VALIDACAO",
      "Este CPF já possui cadastro. Confirme sua identidade para usar o cadastro existente.",
      409,
    );
  }

  let cliente: ClienteRecord;
  try {
    cliente = await criarCliente(
      {
        nomeCompleto: dados.nomeCompleto,
        cpf: dados.cpf,
        rg: dados.rg,
        telefone: dados.telefone,
        whatsapp: dados.whatsapp,
        email: dados.email,
        cep: dados.cep,
        logradouro: dados.logradouro,
        numero: dados.numero,
        complemento: dados.complemento,
        bairro: dados.bairro,
        cidade: dados.cidade,
        uf: dados.uf,
        usuarioId: null,
      },
      tx,
    );
  } catch (error) {
    if (isUniqueViolation(error, "clientes_cpf_canonico_uk")) {
      throw new FechamentoServiceError(
        "CPF_EXISTENTE_REQUER_VALIDACAO",
        "Este CPF já possui cadastro. Confirme sua identidade para usar o cadastro existente.",
        409,
      );
    }
    throw error;
  }

  await registrarDuplicidadesNovoCliente(cliente.id, dados, tx);

  await registrarEventoHistorico(
    {
      clienteId: cliente.id,
      clienteOrigemId: cliente.id,
      tipoEvento: "CADASTRO_CRIADO",
      origem: "FECHAMENTO_PUBLICO",
      entidadeTipo: "CLIENTE",
      entidadeId: cliente.id,
      detalhe: "Cadastro criado durante Fechamento público.",
      metadata: { fluxo: "FECHAMENTO_PUBLICO" },
    },
    tx,
  );

  await registrarAuditoria(
    {
      clienteId: cliente.id,
      atorTipo: "CLIENTE",
      acao: "CLIENTE_CRIADO",
      entidadeTipo: "CLIENTE",
      entidadeId: cliente.id,
      dadosDepois: snapshotCliente(cliente),
      origem: "FECHAMENTO_PUBLICO",
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  return cliente;
}

async function atualizarClienteConfirmado(
  cliente: ClienteRecord,
  dados: DadosClienteFechamentoPublico,
  input: CriarFechamentoPublicoInput,
  tx: DbExecutor,
) {
  const cpfRecebido = normalizarCpf(dados.cpf);
  const cpfAtual = normalizarCpf(cliente.cpf);
  if (!cpfAtual || cpfRecebido !== cpfAtual) {
    throw new FechamentoServiceError(
      "CPF_DIVERGENTE_DA_IDENTIDADE",
      "O CPF informado não corresponde à identidade validada.",
      409,
    );
  }

  if (
    input.identidade.tipo !== "CLIENTE_EXISTENTE" ||
    !input.identidade.atualizarCadastro
  ) {
    return { cliente, atualizado: false };
  }

  const atualizado = await atualizarCliente(
    cliente.id,
    {
      nomeCompleto: dados.nomeCompleto,
      rg: dados.rg,
      telefone: dados.telefone,
      whatsapp: dados.whatsapp,
      email: dados.email,
      cep: dados.cep,
      logradouro: dados.logradouro,
      numero: dados.numero,
      complemento: dados.complemento,
      bairro: dados.bairro,
      cidade: dados.cidade,
      uf: dados.uf,
      usuarioId: null,
    },
    tx,
  );

  if (!atualizado) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "Não foi possível atualizar o cadastro validado.",
      409,
    );
  }

  const diff = diffCliente(cliente, atualizado);
  if (diff.camposAlterados.length > 0) {
    await registrarEventoHistorico(
      {
        clienteId: atualizado.id,
        clienteOrigemId: atualizado.id,
        tipoEvento: "DADOS_ATUALIZADOS",
        origem: "FECHAMENTO_PUBLICO",
        entidadeTipo: "CLIENTE",
        entidadeId: atualizado.id,
        detalhe: "Dados atualizados por confirmação explícita no Fechamento público.",
        metadata: { camposAlterados: diff.camposAlterados },
      },
      tx,
    );

    await registrarAuditoria(
      {
        clienteId: atualizado.id,
        atorTipo: "CLIENTE",
        acao: "CLIENTE_ATUALIZADO",
        entidadeTipo: "CLIENTE",
        entidadeId: atualizado.id,
        dadosAntes: diff.dadosAntes,
        dadosDepois: diff.dadosDepois,
        justificativa: "Confirmação explícita do Cliente no Fechamento público.",
        origem: "FECHAMENTO_PUBLICO",
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
  }

  return { cliente: atualizado, atualizado: diff.camposAlterados.length > 0 };
}

async function resolverAniversariante(
  cliente: ClienteRecord,
  dados: AniversarianteFechamentoPublico,
  tx: DbExecutor,
) {
  if (dados.aniversarianteIdExistente) {
    const existente = await buscarAniversariantePorId(
      dados.aniversarianteIdExistente,
      tx,
    );

    if (!existente || !existente.ativo || existente.clienteId !== cliente.id) {
      throw new FechamentoServiceError(
        "ANIVERSARIANTE_INVALIDO",
        "O aniversariante selecionado não pertence ao Cliente validado.",
        409,
      );
    }

    return { aniversariante: existente, novo: false };
  }

  if (dados.nome.trim().length < 1) {
    throw new FechamentoServiceError(
      "ANIVERSARIANTE_INVALIDO",
      "Informe o nome do aniversariante.",
      400,
    );
  }

  await bloquearNomeAniversariante(cliente.id, dados.nome, tx);
  const duplicado = await buscarAniversarianteAtivoPorNome(cliente.id, dados.nome, undefined, tx);
  if (duplicado) {
    throw new FechamentoServiceError(
      "ANIVERSARIANTE_INVALIDO",
      "Já existe um aniversariante com este nome. Selecione o cadastro existente para evitar duplicação.",
      409,
      { aniversarianteId: duplicado.id },
    );
  }

  const criado = await criarAniversariante(
    {
      clienteId: cliente.id,
      nome: dados.nome,
      temaPadrao: dados.temaPadrao,
      usuarioId: null,
    },
    tx,
  );

  await registrarEventoHistorico(
    {
      clienteId: cliente.id,
      clienteOrigemId: cliente.id,
      tipoEvento: "ANIVERSARIANTE_CRIADO",
      origem: "FECHAMENTO_PUBLICO",
      entidadeTipo: "ANIVERSARIANTE",
      entidadeId: criado.id,
      detalhe: "Aniversariante criado durante Fechamento público.",
    },
    tx,
  );

  return { aniversariante: criado, novo: true };
}

async function resolverResponsavelAdicional(
  cliente: ClienteRecord,
  nome: string | null | undefined,
  input: CriarFechamentoPublicoInput,
  tx: DbExecutor,
) {
  const nomeNormalizado = nome?.trim();
  if (!nomeNormalizado) return null;

  const existente = await buscarResponsavelAtivoPorNome(
    cliente.id,
    nomeNormalizado,
    tx,
  );
  if (existente) return existente;

  const criado = await criarResponsavel(
    {
      clienteId: cliente.id,
      nome: nomeNormalizado,
      usuarioId: null,
    },
    tx,
  );

  await registrarEventoHistorico(
    {
      clienteId: cliente.id,
      clienteOrigemId: cliente.id,
      tipoEvento: "RESPONSAVEL_CRIADO",
      origem: "FECHAMENTO_PUBLICO",
      entidadeTipo: "RESPONSAVEL_ADICIONAL",
      entidadeId: criado.id,
      detalhe: "Responsável adicional criado durante Fechamento público.",
    },
    tx,
  );

  await registrarAuditoria(
    {
      clienteId: cliente.id,
      atorTipo: "CLIENTE",
      acao: "RESPONSAVEL_ADICIONAL_CRIADO",
      entidadeTipo: "RESPONSAVEL_ADICIONAL",
      entidadeId: criado.id,
      dadosDepois: { nome: criado.nome },
      origem: "FECHAMENTO_PUBLICO",
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  return criado;
}

export async function criarFechamentoPublicoComIdentidade(
  input: CriarFechamentoPublicoInput,
  customDb?: DbExecutor,
): Promise<CriarFechamentoPublicoResult> {
  validarDadosClientePublico(input.cliente);

  const executar = async (tx: DbExecutor) => {
    const pacoteV1 = await buscarPacoteAtivoPorId(input.pacoteId, tx);
    if (!pacoteV1 || !pacoteCodigoContratavelV1(pacoteV1.codigo)) {
      throw new FechamentoServiceError(
        "PACOTE_FORA_ESCOPO_V1",
        "O pacote selecionado ainda não está disponível para fechamento online.",
        409,
      );
    }

    let cliente: ClienteRecord;
    let clienteNovo = false;
    let cadastroAtualizado = false;
    let provaToken: string | null = null;
    let identityService: ReturnType<typeof criarIdentityServiceComAmbiente> | null = null;

    if (input.identidade.tipo === "CLIENTE_EXISTENTE") {
      provaToken = input.identidade.provaToken.trim();
      if (provaToken.length < 32) {
        throw new FechamentoServiceError(
          "IDENTIDADE_OBRIGATORIA",
          "Confirme sua identidade antes de concluir o Fechamento.",
          401,
        );
      }

      // Nenhum envio ocorre neste fluxo; a função vazia existe somente porque
      // o mesmo IdentityService concentra resolução e consumo da prova.
      identityService = criarIdentityServiceComAmbiente(async () => {});
      const resolvida = await identityService.resolverClientePorProva(provaToken, tx);
      const canonico = await buscarClienteCanonicoPorId(resolvida.clienteId, tx);
      if (!canonico) {
        throw new FechamentoServiceError(
          "IDENTIDADE_OBRIGATORIA",
          "O Cliente validado não está mais disponível.",
          409,
        );
      }

      const atualizacao = await atualizarClienteConfirmado(
        canonico,
        input.cliente,
        input,
        tx,
      );
      cliente = atualizacao.cliente;
      cadastroAtualizado = atualizacao.atualizado;
    } else {
      cliente = await criarNovoCliente(input.cliente, input, tx);
      clienteNovo = true;
    }

    const aniversariante = await resolverAniversariante(
      cliente,
      input.aniversariante,
      tx,
    );

    const responsavelAdicional = await resolverResponsavelAdicional(
      cliente,
      input.responsavelAdicionalNome,
      input,
      tx,
    );

    const escolhasResolvidas = await resolverEscolhasBuffet(tx, input.pacoteId, input.escolhasBuffet, input.buffetStatus);
    const fechamento = await criarFechamentoComercial(
      {
        dataEvento: input.dataEvento,
        horarioInicio: input.horarioInicio,
        horarioFim: input.horarioFim,
        configuracaoAgendaId: input.configuracaoAgendaId,
        pacoteId: input.pacoteId,
        convidados: input.convidados,
        adicionais: input.adicionais,
        valorProposto: input.valorProposto,
        origemFechamento: "CLIENTE",
        clienteId: cliente.id,
        aniversarianteId: aniversariante.aniversariante.id,
        iniciadoPorUsuarioId: null,
        usuarioResponsavelId: null,
        responsavelAdicionalId: responsavelAdicional?.id ?? null,
        idadeAniversarianteEvento: input.idadeAniversarianteEvento,
        temaFesta: input.temaFesta,
        formaPagamentoPretendida: input.formaPagamentoPretendida,
        condicaoPixPretendida: input.condicaoPixPretendida,
        alteracoesPacote: input.alteracoesPacote,
        observacoesCliente: input.observacoesCliente,
        buffetSalgados: input.buffetSalgados,
        buffetBebidas: input.buffetBebidas,
        buffetDoces: input.buffetDoces,
        buffetBolo: input.buffetBolo,
        buffetOutros: input.buffetOutros,
        buffetLembrancinha: input.buffetLembrancinha,
        buffetEmpratado: input.buffetEmpratado,
        buffetBombom: input.buffetBombom,
        motivoNegociacao: input.motivoNegociacao,
        observacoesNegociacao: input.observacoesNegociacao,
        observacoesEquipe: input.observacoesEquipe,
        buffetStatus: input.buffetStatus,
        ...(escolhasResolvidas ? { ...escolhasResolvidas.campos,
          buffetOutros: [input.buffetOutros, escolhasResolvidas.outros].filter(Boolean).join("; ") || null } : {}),
      },
      tx,
    );

    if (escolhasResolvidas) await gravarEscolhasBuffet(tx, fechamento.fechamento.id, escolhasResolvidas);

    if (provaToken && identityService) {
      await identityService.consumirProvaParaFechamento(
        provaToken,
        fechamento.fechamento.id,
        tx,
      );
    }

    await registrarEventoHistorico(
      {
        clienteId: cliente.id,
        clienteOrigemId: cliente.id,
        tipoEvento: "FECHAMENTO_CRIADO",
        origem: "FECHAMENTO_PUBLICO",
        entidadeTipo: "FECHAMENTO",
        entidadeId: fechamento.fechamento.id,
        detalhe: "Fechamento público criado e vinculado ao CRM.",
        metadata: {
          status: fechamento.fechamento.status,
          aniversarianteId: aniversariante.aniversariante.id,
        },
      },
      tx,
    );

    const faltantes = camposFaltantesParaContrato(cliente);

    return {
      ...fechamento,
      cliente: {
        novo: clienteNovo,
        cadastroCompletoParaContrato: faltantes.length === 0,
        camposFaltantesParaContrato: faltantes,
        cadastroAtualizado,
      },
      aniversariante: {
        novo: aniversariante.novo,
      },
    };
  };

  if (customDb) return executar(customDb);
  return withTransaction(executar);
}
