import type { DbExecutor } from "../../db/contracts";
import { isUniqueViolation } from "../../db/errors";
import { withTransaction } from "../../db/postgres";
import {
  atualizarCliente,
  buscarClienteCanonicoPorCpf,
  buscarClienteCanonicoPorId,
  buscarClientePorId,
  buscarClientesPorContatoExato,
  buscarClientesPorEmail,
  buscarClientesPorNomeSemelhante,
  criarCliente,
  listarAniversariantesDoCliente,
  listarClientes,
  listarResponsaveisDoCliente,
  registrarAuditoria,
  registrarEventoHistorico,
  registrarPossivelDuplicidade,
  type ClienteRecord,
  type ClienteStatus,
  type CreateClienteInput,
  type UpdateClienteInput,
} from "../repositories";
import {
  normalizarCpf,
  normalizarTelefone,
} from "../repositories/normalizers";
import { auditoriaActor, type ClienteServiceContext } from "./context";
import { ClienteServiceError } from "./errors";
import {
  camposFaltantesParaContrato,
  validarCadastroBasicoCliente,
} from "./validators";

export type CandidatoDuplicidade = {
  clienteId: string;
  nomeCompleto: string;
  motivos: string[];
  similaridadeNome?: number;
};

export type AnaliseCadastroCliente = {
  podeCadastrar: boolean;
  cpfExistente: { clienteId: string; nomeCompleto: string } | null;
  possiveisDuplicidades: CandidatoDuplicidade[];
};

function clienteAuditSnapshot(cliente: ClienteRecord) {
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
    observacoes: cliente.observacoes,
    status: cliente.status,
  };
}

function diffAudit(before: ClienteRecord, after: ClienteRecord) {
  const a = clienteAuditSnapshot(before);
  const b = clienteAuditSnapshot(after);
  const dadosAntes: Record<string, unknown> = {};
  const dadosDepois: Record<string, unknown> = {};
  for (const key of Object.keys(a) as Array<keyof typeof a>) {
    if (a[key] !== b[key]) {
      dadosAntes[key] = a[key];
      dadosDepois[key] = b[key];
    }
  }
  return { dadosAntes, dadosDepois, camposAlterados: Object.keys(dadosDepois) };
}

function mergeCandidato(
  mapa: Map<string, CandidatoDuplicidade>,
  cliente: ClienteRecord,
  motivo: string,
  similaridadeNome?: number,
) {
  const atual = mapa.get(cliente.id) ?? {
    clienteId: cliente.id,
    nomeCompleto: cliente.nomeCompleto,
    motivos: [],
  };
  if (!atual.motivos.includes(motivo)) atual.motivos.push(motivo);
  if (similaridadeNome != null) atual.similaridadeNome = similaridadeNome;
  mapa.set(cliente.id, atual);
}

export async function analisarCadastroCliente(
  input: Pick<CreateClienteInput, "nomeCompleto" | "cpf" | "telefone" | "whatsapp">,
  options: { excluirClienteId?: string } = {},
  customDb?: DbExecutor,
): Promise<AnaliseCadastroCliente> {
  const cpf = normalizarCpf(input.cpf);
  const cpfExistente = cpf ? await buscarClienteCanonicoPorCpf(cpf, customDb) : null;
  const cpfConflitante = cpfExistente && cpfExistente.id !== options.excluirClienteId
    ? cpfExistente
    : null;

  const candidatos = new Map<string, CandidatoDuplicidade>();
  const contatos = [
    ["TELEFONE_IGUAL", normalizarTelefone(input.telefone)],
    ["WHATSAPP_IGUAL", normalizarTelefone(input.whatsapp)],
  ] as const;

  for (const [motivo, contato] of contatos) {
    if (!contato) continue;
    const encontrados = await buscarClientesPorContatoExato(contato, customDb);
    for (const cliente of encontrados) {
      if (cliente.id === options.excluirClienteId) continue;
      mergeCandidato(candidatos, cliente, motivo);
    }
  }

  if (input.nomeCompleto.trim().length >= 3) {
    const nomes = await buscarClientesPorNomeSemelhante(
      input.nomeCompleto,
      { limit: 5, excluirClienteId: options.excluirClienteId },
      customDb,
    );
    for (const cliente of nomes) {
      mergeCandidato(candidatos, cliente, "NOME_SEMELHANTE", cliente.similaridade);
    }
  }

  if (cpfConflitante) candidatos.delete(cpfConflitante.id);

  return {
    podeCadastrar: !cpfConflitante,
    cpfExistente: cpfConflitante
      ? { clienteId: cpfConflitante.id, nomeCompleto: cpfConflitante.nomeCompleto }
      : null,
    possiveisDuplicidades: [...candidatos.values()].sort((a, b) => {
      const contatoA = a.motivos.some((m) => m.endsWith("_IGUAL")) ? 1 : 0;
      const contatoB = b.motivos.some((m) => m.endsWith("_IGUAL")) ? 1 : 0;
      if (contatoA !== contatoB) return contatoB - contatoA;
      return (b.similaridadeNome ?? 0) - (a.similaridadeNome ?? 0);
    }),
  };
}

async function registrarDuplicidadesDetectadas(
  novoClienteId: string,
  candidatos: CandidatoDuplicidade[],
  tx: DbExecutor,
) {
  for (const candidato of candidatos) {
    await registrarPossivelDuplicidade(
      {
        clienteUmId: novoClienteId,
        clienteDoisId: candidato.clienteId,
        motivos: candidato.motivos,
      },
      tx,
    );
  }
}

export async function cadastrarClienteInterno(
  input: CreateClienteInput,
  context: ClienteServiceContext,
) {
  validarCadastroBasicoCliente(input);

  return withTransaction(async (tx) => {
    const analise = await analisarCadastroCliente(input, {}, tx);
    if (!analise.podeCadastrar && analise.cpfExistente) {
      throw new ClienteServiceError(
        "CPF_EXISTENTE",
        "Já existe um Cliente cadastrado com este CPF. Use o cadastro existente.",
        409,
        analise.cpfExistente,
      );
    }

    let cliente: ClienteRecord;
    try {
      cliente = await criarCliente({ ...input, usuarioId: context.usuarioId ?? null }, tx);
    } catch (error) {
      if (isUniqueViolation(error, "clientes_cpf_canonico_uk")) {
        const existente = input.cpf
          ? await buscarClienteCanonicoPorCpf(input.cpf, tx)
          : null;
        throw new ClienteServiceError(
          "CPF_EXISTENTE",
          "Já existe um Cliente cadastrado com este CPF. Use o cadastro existente.",
          409,
          existente ? { clienteId: existente.id, nomeCompleto: existente.nomeCompleto } : undefined,
        );
      }
      throw error;
    }

    await registrarDuplicidadesDetectadas(cliente.id, analise.possiveisDuplicidades, tx);

    await registrarEventoHistorico(
      {
        clienteId: cliente.id,
        clienteOrigemId: cliente.id,
        tipoEvento: "CADASTRO_CRIADO",
        origem: context.origem,
        entidadeTipo: "CLIENTE",
        entidadeId: cliente.id,
        usuarioId: context.usuarioId ?? null,
        detalhe: "Cadastro de Cliente criado.",
        metadata: {
          cadastroBasico: true,
          possiveisDuplicidades: analise.possiveisDuplicidades.map((item) => item.clienteId),
        },
      },
      tx,
    );

    const actor = auditoriaActor(context);
    await registrarAuditoria(
      {
        clienteId: cliente.id,
        ...actor,
        acao: "CLIENTE_CRIADO",
        entidadeTipo: "CLIENTE",
        entidadeId: cliente.id,
        dadosDepois: {
          status: cliente.status,
          camposInformados: Object.entries(clienteAuditSnapshot(cliente))
            .filter(([, value]) => value !== null && value !== "")
            .map(([key]) => key),
        },
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    return {
      cliente,
      cadastro: {
        completoParaContrato: camposFaltantesParaContrato(cliente).length === 0,
        camposFaltantes: camposFaltantesParaContrato(cliente),
      },
      possiveisDuplicidades: analise.possiveisDuplicidades,
    };
  });
}

export async function obterClienteBase(clienteId: string) {
  const original = await buscarClientePorId(clienteId);
  if (!original) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
  }

  const cliente = await buscarClienteCanonicoPorId(clienteId);
  if (!cliente) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente canônico não encontrado.", 404);
  }

  const [aniversariantes, responsaveis] = await Promise.all([
    listarAniversariantesDoCliente(cliente.id),
    listarResponsaveisDoCliente(cliente.id),
  ]);

  const camposFaltantes = camposFaltantesParaContrato(cliente);
  return {
    cliente,
    redirecionadoDeClienteMesclado: original.status === "MESCLADO" ? original.id : null,
    aniversariantes,
    responsaveis,
    cadastro: {
      completoParaContrato: camposFaltantes.length === 0,
      camposFaltantes,
    },
  };
}

export async function listarClientesCrm(options: {
  status?: ClienteStatus | "CANONICOS";
  limit?: number;
  offset?: number;
} = {}) {
  const clientes = await listarClientes(options);
  return clientes.map((cliente) => {
    const camposFaltantes = camposFaltantesParaContrato(cliente);
    return {
      cliente,
      cadastroCompleto: camposFaltantes.length === 0,
      camposFaltantes,
    };
  });
}

export async function buscarClientesCrm(termo: string, limit = 20) {
  const q = termo.trim();
  if (!q) return listarClientesCrm({ limit });

  const digits = q.replace(/\D/g, "");
  const encontrados = new Map<string, ClienteRecord>();

  if (digits.length === 11) {
    const porCpf = await buscarClienteCanonicoPorCpf(digits);
    if (porCpf) encontrados.set(porCpf.id, porCpf);
  }

  if (digits.length >= 10) {
    const porContato = await buscarClientesPorContatoExato(digits);
    porContato.forEach((cliente) => encontrados.set(cliente.id, cliente));
  }

  if (q.length >= 3) {
    const [porNome, porEmail] = await Promise.all([
      buscarClientesPorNomeSemelhante(q, { limit }),
      buscarClientesPorEmail(q, { limit }),
    ]);
    porNome.forEach((cliente) => encontrados.set(cliente.id, cliente));
    porEmail.forEach((cliente) => encontrados.set(cliente.id, cliente));
  }

  return [...encontrados.values()].slice(0, limit).map((cliente) => {
    const camposFaltantes = camposFaltantesParaContrato(cliente);
    return {
      cliente,
      cadastroCompleto: camposFaltantes.length === 0,
      camposFaltantes,
    };
  });
}

export async function atualizarClienteInterno(
  clienteId: string,
  patch: UpdateClienteInput,
  context: ClienteServiceContext,
  customDb?: DbExecutor,
) {
  const executar = async (tx: DbExecutor) => {
    await tx.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE', [clienteId]);
    const atual = await buscarClientePorId(clienteId, tx);
    if (!atual) {
      throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
    }
    if (atual.status === "MESCLADO") {
      throw new ClienteServiceError(
        "CLIENTE_MESCLADO",
        "Este cadastro foi mesclado. Edite o Cliente principal.",
        409,
        { clientePrincipalId: atual.clientePrincipalId },
      );
    }

    if (patch.cpf !== undefined && normalizarCpf(patch.cpf) !== normalizarCpf(atual.cpf)) {
      throw new ClienteServiceError(
        "ALTERACAO_CPF_REQUER_PERMISSAO",
        "Alteração de CPF é uma ação crítica e será habilitada na etapa de autenticação/permissões.",
        403,
      );
    }

    validarCadastroBasicoCliente({
      nomeCompleto: patch.nomeCompleto ?? atual.nomeCompleto,
      cpf: atual.cpf,
      telefone: patch.telefone ?? atual.telefone,
      whatsapp: patch.whatsapp ?? atual.whatsapp,
      email: patch.email ?? atual.email,
      cep: patch.cep ?? atual.cep,
      logradouro: patch.logradouro ?? atual.logradouro,
      numero: patch.numero ?? atual.numero,
      complemento: patch.complemento ?? atual.complemento,
      bairro: patch.bairro ?? atual.bairro,
      cidade: patch.cidade ?? atual.cidade,
      uf: patch.uf ?? atual.uf,
      observacoes: patch.observacoes ?? atual.observacoes,
    });

    const analise = await analisarCadastroCliente(
      {
        nomeCompleto: patch.nomeCompleto ?? atual.nomeCompleto,
        cpf: atual.cpf,
        telefone: patch.telefone ?? atual.telefone,
        whatsapp: patch.whatsapp ?? atual.whatsapp,
      },
      { excluirClienteId: clienteId },
      tx,
    );

    const atualizado = await atualizarCliente(
      clienteId,
      { ...patch, usuarioId: context.usuarioId ?? null },
      tx,
    );
    if (!atualizado) {
      throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não pôde ser atualizado.", 404);
    }

    await registrarDuplicidadesDetectadas(atualizado.id, analise.possiveisDuplicidades, tx);

    const diff = diffAudit(atual, atualizado);

    await registrarEventoHistorico(
      {
        clienteId: atualizado.id,
        clienteOrigemId: atualizado.id,
        tipoEvento: "DADOS_ATUALIZADOS",
        origem: context.origem,
        entidadeTipo: "CLIENTE",
        entidadeId: atualizado.id,
        usuarioId: context.usuarioId ?? null,
        detalhe: "Dados cadastrais do Cliente atualizados.",
        metadata: { camposAlterados: diff.camposAlterados },
      },
      tx,
    );

    const actor = auditoriaActor(context);
    await registrarAuditoria(
      {
        clienteId: atualizado.id,
        ...actor,
        acao: "CLIENTE_ATUALIZADO",
        entidadeTipo: "CLIENTE",
        entidadeId: atualizado.id,
        dadosAntes: diff.dadosAntes,
        dadosDepois: diff.dadosDepois,
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    const camposFaltantes = camposFaltantesParaContrato(atualizado);
    return {
      cliente: atualizado,
      cadastro: {
        completoParaContrato: camposFaltantes.length === 0,
        camposFaltantes,
      },
      possiveisDuplicidades: analise.possiveisDuplicidades,
    };
  };
  return customDb ? executar(customDb) : withTransaction(executar);
}
