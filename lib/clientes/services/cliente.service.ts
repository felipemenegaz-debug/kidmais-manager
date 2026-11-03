import type { DbExecutor } from "../../db/contracts";
import { isUniqueViolation } from "../../db/errors";
import { withTransaction } from "../../db/postgres";
import {
  atualizarCliente,
  buscarClienteCanonicoPorCnpj,
  buscarClienteCanonicoPorCpf,
  buscarClienteCanonicoPorId,
  buscarClientePorId,
  buscarClientesPorContatoExato,
  buscarClientesPorEmail,
  buscarClientesPorEmailExato,
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
  INDICES_CPF_CANONICO,
  INDICE_CNPJ_CANONICO,
  migration112Aplicada,
} from "../repositories";
import { normalizarCnpj } from "../../cadastro/cnpj.ts";
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
  status?: ClienteStatus;
  similaridadeNome?: number;
  /** 112: tipo do cadastro candidato (a importação só vincula cliente do mesmo tipo do contrato; R2-5). */
  tipoPessoa?: "PF" | "PJ";
};

export type AnaliseCadastroCliente = {
  podeCadastrar: boolean;
  cpfExistente: { clienteId: string; nomeCompleto: string; status?: ClienteStatus } | null;
  /** 112: mesma regra do CPF para o CNPJ da PJ na empresa (chave de identidade da PJ). */
  cnpjExistente: { clienteId: string; nomeCompleto: string; status?: ClienteStatus } | null;
  possiveisDuplicidades: CandidatoDuplicidade[];
};

function clienteAuditSnapshot(cliente: ClienteRecord) {
  return {
    nomeCompleto: cliente.nomeCompleto,
    tipoPessoa: cliente.tipoPessoa,
    cpf: cliente.cpf,
    cnpj: cliente.cnpj,
    nomeFantasia: cliente.nomeFantasia,
    representanteNome: cliente.representanteNome,
    representanteCpf: cliente.representanteCpf,
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
    status: cliente.status,
    tipoPessoa: cliente.tipoPessoa,
  };
  if (!atual.motivos.includes(motivo)) atual.motivos.push(motivo);
  if (similaridadeNome != null) atual.similaridadeNome = similaridadeNome;
  mapa.set(cliente.id, atual);
}

/**
 * Deduplicação dentro do tenant comprovado. Toda busca filtra `empresa_id` na própria consulta,
 * antes de ordenar e limitar: nunca devolve id, nome ou candidato de outra empresa.
 * O índice global de CPF (até o PR-B2) ainda pode recusar um CPF de outra empresa no INSERT;
 * esse caso é tratado em `cadastrarClienteInterno` sem revelar o dono.
 */
export async function analisarCadastroCliente(
  input: Pick<CreateClienteInput, "nomeCompleto" | "cpf" | "cnpj" | "telefone" | "whatsapp" | "email">,
  empresaId: string,
  options: { excluirClienteId?: string } = {},
  customDb?: DbExecutor,
): Promise<AnaliseCadastroCliente> {
  const cpf = normalizarCpf(input.cpf);
  const cpfExistente = cpf ? await buscarClienteCanonicoPorCpf(cpf, empresaId, customDb) : null;
  const cpfConflitante = cpfExistente && cpfExistente.id !== options.excluirClienteId
    ? cpfExistente
    : null;
  // A chave da PJ é o CNPJ; o CPF do representante não entra na duplicidade (R2-1, R2-5).
  const cnpj = normalizarCnpj(input.cnpj);
  const cnpjExistente = cnpj ? await buscarClienteCanonicoPorCnpj(cnpj, empresaId, customDb) : null;
  const cnpjConflitante = cnpjExistente && cnpjExistente.id !== options.excluirClienteId ? cnpjExistente : null;

  const candidatos = new Map<string, CandidatoDuplicidade>();
  const contatos = [
    ["TELEFONE_IGUAL", normalizarTelefone(input.telefone)],
    ["WHATSAPP_IGUAL", normalizarTelefone(input.whatsapp)],
  ] as const;

  for (const [motivo, contato] of contatos) {
    if (!contato) continue;
    const encontrados = await buscarClientesPorContatoExato(contato, empresaId, customDb);
    for (const cliente of encontrados) {
      if (cliente.id === options.excluirClienteId) continue;
      mergeCandidato(candidatos, cliente, motivo);
    }
  }

  if (input.nomeCompleto.trim().length >= 3) {
    const nomes = await buscarClientesPorNomeSemelhante(
      input.nomeCompleto,
      empresaId,
      { limit: 5, excluirClienteId: options.excluirClienteId },
      customDb,
    );
    for (const cliente of nomes) {
      mergeCandidato(candidatos, cliente, "NOME_SEMELHANTE", cliente.similaridade);
    }
  }

  if (input.email?.trim()) {
    const porEmail = await buscarClientesPorEmailExato(input.email, empresaId, customDb);
    for (const cliente of porEmail) if(cliente.id!==options.excluirClienteId && cliente.email?.toLowerCase()===input.email.trim().toLowerCase()) mergeCandidato(candidatos,cliente,"EMAIL_IGUAL");
  }
  if (cpfConflitante) candidatos.delete(cpfConflitante.id);
  if (cnpjConflitante) candidatos.delete(cnpjConflitante.id);

  return {
    podeCadastrar: !cpfConflitante && !cnpjConflitante,
    cpfExistente: cpfConflitante
      ? { clienteId: cpfConflitante.id, nomeCompleto: cpfConflitante.nomeCompleto, status: cpfConflitante.status }
      : null,
    cnpjExistente: cnpjConflitante
      ? { clienteId: cnpjConflitante.id, nomeCompleto: cnpjConflitante.nomeCompleto, status: cnpjConflitante.status }
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

/** Cadastro administrativo: `input.empresaId` é o tenant comprovado pela rota, nunca do body. */
export async function cadastrarClienteInterno(
  input: CreateClienteInput & { empresaId: string },
  context: ClienteServiceContext,
  customDb?: DbExecutor,
) {
  if (typeof input.empresaId !== "string" || input.empresaId === "") {
    throw new ClienteServiceError("AUTENTICACAO_ADMINISTRATIVA", "Empresa administrativa não comprovada.", 403);
  }
  validarCadastroBasicoCliente(input);

  const executar = async (tx: DbExecutor) => {
    if (input.tipoPessoa === "PJ") await exigirPj(tx);
    const analise = await analisarCadastroCliente(input, input.empresaId, {}, tx);
    if (analise.cnpjExistente) {
      throw new ClienteServiceError(
        "CNPJ_EXISTENTE",
        analise.cnpjExistente.status === "INATIVO" ? "Este CNPJ pertence a um cliente arquivado/excluído. Abra o perfil para restaurar." : "Já existe cliente com este CNPJ nesta empresa. Use o cadastro existente.",
        409,
        analise.cnpjExistente,
      );
    }
    if (!analise.podeCadastrar && analise.cpfExistente) {
      throw new ClienteServiceError(
        "CPF_EXISTENTE",
        analise.cpfExistente.status === "INATIVO" ? "Este CPF pertence a um cliente arquivado/excluído. Abra o perfil para restaurar." : "Já existe um Cliente cadastrado com este CPF. Use o cadastro existente.",
        409,
        analise.cpfExistente,
      );
    }

    const inativoComContato = analise.possiveisDuplicidades.find(c => c.status === 'INATIVO' && c.motivos.some(m => m.endsWith('_IGUAL')));
    if (inativoComContato) throw new ClienteServiceError('DADOS_INVALIDOS','Existe cliente arquivado/excluído com este contato. Abra o perfil para restaurar antes de cadastrar novamente.',409,{clienteId:inativoComContato.clienteId});
    let cliente: ClienteRecord;
    try {
      cliente = await criarCliente({ ...input, usuarioId: context.usuarioId ?? null }, tx);
    } catch (error) {
      // O índice de CPF ainda é global (PR-B2). A análise acima já viu o CPF desta empresa, então
      // a violação aqui vem de outra empresa (ou de uma corrida). A transação está abortada:
      // nenhuma consulta nova, e a resposta não revela id, nome nem empresa do dono.
      if (INDICES_CPF_CANONICO.some((indice) => isUniqueViolation(error, indice))) {
        throw new ClienteServiceError(
          "CPF_INDISPONIVEL",
          "Este CPF não pode ser cadastrado agora. Confira o documento ou fale com o suporte.",
          409,
        );
      }
      // Corrida: duas criações com o mesmo CNPJ na empresa; a outra venceu (transação abortada, sem nova consulta).
      if (isUniqueViolation(error, INDICE_CNPJ_CANONICO)) {
        throw new ClienteServiceError("CNPJ_EXISTENTE", "Já existe cliente com este CNPJ nesta empresa.", 409);
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
  };
  return customDb ? executar(customDb) : withTransaction(executar);
}

/** R21-4: código da Entrega B rodando sem a 112 → PJ_INDISPONIVEL (409) com motivo MIGRACAO_PENDENTE. */
export const MENSAGEM_PJ_MIGRACAO_PENDENTE = "Cliente pessoa jurídica ainda não está disponível nesta instalação (atualização do banco pendente). Nada foi gravado.";
/** A 112 está aplicada? Conferido na transação a cada chamada, sem cache (R2-3). */
export const pessoaJuridicaDisponivel = (tx: DbExecutor) => migration112Aplicada(tx);
async function exigirPj(tx: DbExecutor) {
  if (!(await migration112Aplicada(tx))) {
    throw new ClienteServiceError("PJ_INDISPONIVEL", MENSAGEM_PJ_MIGRACAO_PENDENTE, 409, { motivo: "MIGRACAO_PENDENTE", campo: "tipoPessoa" });
  }
}

/** Fechamento (os contratos pendem dele) ou importação de contrato vinculados, em qualquer status: a troca PF↔PJ fica bloqueada. */
async function temVinculoContratual(clienteId: string, tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM fechamentos WHERE cliente_id = $1)
         OR (to_regclass('public.contrato_importacoes') IS NOT NULL AND EXISTS (SELECT 1 FROM contrato_importacoes WHERE cliente_id = $1)) AS ok`,
    [clienteId],
  );
  return r.rows[0]?.ok === true;
}

async function montarClienteBase(original: ClienteRecord, cliente: ClienteRecord, customDb?: DbExecutor) {
  const [aniversariantes, responsaveis] = await Promise.all([
    listarAniversariantesDoCliente(cliente.id, {}, customDb),
    listarResponsaveisDoCliente(cliente.id, {}, customDb),
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

/**
 * Leitura administrativa. `empresaId` é o tenant comprovado pela rota (nunca do body).
 * Cliente de outra empresa, ou legado sem empresa, responde exatamente como inexistente.
 */
export async function obterClienteBase(clienteId: string, empresaId: string, customDb?: DbExecutor) {
  const original = await buscarClientePorId(clienteId, customDb);
  if (!original || original.empresaId === null || original.empresaId !== empresaId) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
  }

  const cliente = await buscarClienteCanonicoPorId(clienteId, customDb);
  if (!cliente || cliente.empresaId === null || cliente.empresaId !== empresaId) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
  }

  return montarClienteBase(original, cliente, customDb);
}

/**
 * Prova de identidade já resolvida por IdentityService.resolverClientePorProva (token válido, não
 * expirado, não consumido, finalidade conferida, cliente canônico). É uma capacidade distinta do
 * Tenant Context: dá acesso só ao cliente comprovado e não serve para nenhuma rota administrativa.
 */
export type IdentidadeClienteComprovada = {
  readonly validacaoId: string;
  readonly clienteId: string;
};

/** Leitura pelo próprio cliente, depois da prova de identidade. Não aceita outro id. */
export async function obterClienteBasePorIdentidade(
  identidade: IdentidadeClienteComprovada,
  customDb?: DbExecutor,
) {
  if (!identidade.validacaoId || !identidade.clienteId) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
  }
  const original = await buscarClientePorId(identidade.clienteId, customDb);
  const cliente = await buscarClienteCanonicoPorId(identidade.clienteId, customDb);
  // A prova já aponta para o canônico; um id mesclado aqui significa prova antiga.
  if (!original || !cliente || cliente.id !== identidade.clienteId) {
    throw new ClienteServiceError("CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.", 404);
  }
  return montarClienteBase(original, cliente, customDb);
}

export async function listarClientesCrm(empresaId: string, options: {
  status?: ClienteStatus | "CANONICOS";
  limit?: number;
  offset?: number;
} = {}, customDb?: DbExecutor) {
  const clientes = await listarClientes(empresaId, { ...options, status: options.status ?? "ATIVO" }, customDb);
  return clientes.map((cliente) => {
    const camposFaltantes = camposFaltantesParaContrato(cliente);
    return {
      cliente,
      cadastroCompleto: camposFaltantes.length === 0,
      camposFaltantes,
    };
  });
}

/**
 * Busca do CRM dentro do tenant comprovado. O escopo está em cada consulta do repositório (antes
 * de ORDER BY/LIMIT), não num filtro posterior: um cliente de outra empresa não ocupa vaga no
 * limite nem aparece no resultado.
 */
export async function buscarClientesCrm(
  termo: string,
  empresaId: string,
  limit = 20,
  incluirInativos = false,
  customDb?: DbExecutor,
) {
  const q = termo.trim();
  if (!q) return listarClientesCrm(empresaId, { limit, status: incluirInativos ? "CANONICOS" : "ATIVO" }, customDb);

  const digits = q.replace(/\D/g, "");
  const encontrados = new Map<string, ClienteRecord>();

  if (digits.length === 11) {
    const porCpf = await buscarClienteCanonicoPorCpf(digits, empresaId, customDb);
    if (porCpf) encontrados.set(porCpf.id, porCpf);
  }
  // CNPJ numérico ou alfanumérico (14 caracteres sem pontuação).
  const doc = normalizarCnpj(q);
  if (/^[0-9A-Z]{12}[0-9]{2}$/.test(doc)) {
    const porCnpj = await buscarClienteCanonicoPorCnpj(doc, empresaId, customDb);
    if (porCnpj) encontrados.set(porCnpj.id, porCnpj);
  }

  if (digits.length >= 10) {
    const porContato = await buscarClientesPorContatoExato(digits, empresaId, customDb);
    porContato.forEach((cliente) => encontrados.set(cliente.id, cliente));
  }

  if (q.length >= 3) {
    const [porNome, porEmail] = await Promise.all([
      buscarClientesPorNomeSemelhante(q, empresaId, { limit, incluirInativos }, customDb),
      buscarClientesPorEmail(q, empresaId, { limit, incluirInativos }, customDb),
    ]);
    porNome.forEach((cliente) => encontrados.set(cliente.id, cliente));
    porEmail.forEach((cliente) => encontrados.set(cliente.id, cliente));
  }

  return [...encontrados.values()]
    .filter(c => incluirInativos || c.status === "ATIVO").slice(0, limit).map((cliente) => {
    const camposFaltantes = camposFaltantesParaContrato(cliente);
    return {
      cliente,
      cadastroCompleto: camposFaltantes.length === 0,
      camposFaltantes,
    };
  });
}

/**
 * Edição administrativa. `empresaId` é sempre o tenant comprovado do chamador (rota do CRM,
 * contratos ou revisão), nunca a empresa lida do próprio cliente. Legado sem empresa e cliente de
 * outra empresa respondem como inexistentes.
 */
export async function atualizarClienteInterno(
  clienteId: string,
  empresaId: string,
  patch: UpdateClienteInput,
  context: ClienteServiceContext,
  customDb?: DbExecutor,
) {
  if (typeof empresaId !== "string" || empresaId === "") {
    throw new ClienteServiceError("AUTENTICACAO_ADMINISTRATIVA", "Empresa administrativa não comprovada.", 403);
  }
  const executar = async (tx: DbExecutor) => {
    await tx.query('SELECT id FROM clientes WHERE id=$1 AND empresa_id=$2::uuid FOR UPDATE', [clienteId, empresaId]);
    const atual = await buscarClientePorId(clienteId, tx);
    if (!atual || atual.empresaId === null || atual.empresaId !== empresaId) {
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

    const tipoNovo = patch.tipoPessoa ?? atual.tipoPessoa;
    const trocaTipo = tipoNovo !== atual.tipoPessoa;
    if (patch.tipoPessoa !== undefined && patch.tipoPessoa !== "PF" && patch.tipoPessoa !== "PJ") {
      throw new ClienteServiceError("DADOS_INVALIDOS", "Escolha pessoa física ou jurídica.", 400, { campo: "tipoPessoa" });
    }
    if (trocaTipo) {
      // R2-5: troca PF↔PJ só sem contrato nem fechamento vinculados; senão, outro cadastro.
      if (await temVinculoContratual(clienteId, tx)) {
        throw new ClienteServiceError(
          "TROCA_TIPO_PESSOA_BLOQUEADA",
          "Este cliente já tem contrato ou fechamento. Para mudar entre pessoa física e jurídica, crie outro cadastro.",
          409,
          { campo: "tipoPessoa" },
        );
      }
      if (tipoNovo === "PJ") await exigirPj(tx);
    }
    if (!trocaTipo && normalizarCpf(atual.cpf) && patch.cpf !== undefined && normalizarCpf(patch.cpf) !== normalizarCpf(atual.cpf)) {
      throw new ClienteServiceError(
        "ALTERACAO_CPF_REQUER_PERMISSAO",
        "Alteração de CPF é uma ação crítica e será habilitada na etapa de autenticação/permissões.",
        403,
      );
    }
    // A mesma proteção vale para o CNPJ da PJ (chave de identidade).
    if (!trocaTipo && atual.cnpj && patch.cnpj !== undefined && normalizarCnpj(patch.cnpj) !== atual.cnpj) {
      throw new ClienteServiceError(
        "ALTERACAO_DOCUMENTO_REQUER_PERMISSAO",
        "Alteração de CNPJ é uma ação crítica e será habilitada na etapa de autenticação/permissões.",
        403,
      );
    }
    // Campos de PJ nunca entram num cadastro que continua PF (e PF→PJ exige o CPF removido explicitamente).
    const valorFinal = <K extends "cpf" | "cnpj" | "nomeFantasia" | "representanteNome" | "representanteCpf">(k: K) =>
      patch[k] !== undefined ? patch[k] : tipoNovo === "PF" && trocaTipo && k !== "cpf" ? null : atual[k];

    validarCadastroBasicoCliente({
      empresaId: atual.empresaId,
      nomeCompleto: patch.nomeCompleto ?? atual.nomeCompleto,
      tipoPessoa: tipoNovo,
      cpf: valorFinal("cpf"),
      cnpj: valorFinal("cnpj"),
      nomeFantasia: valorFinal("nomeFantasia"),
      representanteNome: valorFinal("representanteNome"),
      representanteCpf: valorFinal("representanteCpf"),
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
        cpf: valorFinal("cpf"),
        cnpj: valorFinal("cnpj"),
        telefone: patch.telefone ?? atual.telefone,
        whatsapp: patch.whatsapp ?? atual.whatsapp,
      },
      empresaId,
      { excluirClienteId: clienteId },
      tx,
    );

    if (analise.cnpjExistente) {
      throw new ClienteServiceError("CNPJ_EXISTENTE", "Já existe cliente com este CNPJ nesta empresa.", 409);
    }
    if (!analise.podeCadastrar) {
      throw new ClienteServiceError("CPF_EXISTENTE", "Este CPF já está cadastrado. Confira o cliente vinculado.", 409);
    }

    // Troca de tipo: a gravação leva o tipo e o documento juntos (PJ→PF limpa os campos de PJ no repositório).
    // Sem troca, o tipo repetido pela tela não vai ao repositório (uma PF editada sem a 112 não toca colunas de PJ).
    const { tipoPessoa: _tipoRepetido, ...patchSemTipo } = patch;
    void _tipoRepetido;
    const patchFinal: UpdateClienteInput = trocaTipo
      ? { ...patch, tipoPessoa: tipoNovo, cpf: valorFinal("cpf"), ...(tipoNovo === "PJ" ? { cnpj: valorFinal("cnpj") } : {}) }
      : patchSemTipo;
    let atualizado: ClienteRecord | null;
    try {
      atualizado = await atualizarCliente(
        clienteId,
        { tipo: "TENANT", empresaId },
        { ...patchFinal, usuarioId: context.usuarioId ?? null },
        tx,
      );
    } catch (error) {
      if (isUniqueViolation(error, INDICE_CNPJ_CANONICO)) {
        throw new ClienteServiceError("CNPJ_EXISTENTE", "Já existe cliente com este CNPJ nesta empresa.", 409);
      }
      throw error;
    }
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
