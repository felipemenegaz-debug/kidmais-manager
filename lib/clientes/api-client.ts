import type { ClienteFormData } from "@/components/clientes/types";
import { adminFetch } from "@/lib/http/admin-fetch";

export type ClienteApiStatus = "ATIVO" | "INATIVO" | "MESCLADO";

export type ClienteApiRecord = {
  id: string;
  nomeCompleto: string;
  cpf: string | null;
  rg: string | null;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  observacoes: string | null;
  status: ClienteApiStatus;
  clientePrincipalId: string | null;
  mescladoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type AniversarianteApiRecord = {
  id: string;
  clienteId: string;
  nome: string;
  dataNascimento: string | null;
  temaPadrao: string | null;
  observacoes: string | null;
  ativo: boolean;
};

export type ResponsavelApiRecord = {
  id: string;
  clienteId: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  relacao: string | null;
  observacoes: string | null;
  ativo: boolean;
};

export type CandidatoDuplicidadeApi = {
  clienteId: string;
  nomeCompleto: string;
  motivos: string[];
  status?: ClienteApiStatus;
  similaridadeNome?: number;
};

export type AnaliseCadastroClienteApi = {
  podeCadastrar: boolean;
  cpfExistente: { clienteId: string; nomeCompleto: string; status?: ClienteApiStatus } | null;
  possiveisDuplicidades: CandidatoDuplicidadeApi[];
};

export type ClienteListaApiItem = {
  cliente: ClienteApiRecord;
  cadastroCompleto: boolean;
  camposFaltantes: Array<{ campo: string; label: string }>;
};

export type ClienteDetalheApi = {
  cliente: ClienteApiRecord;
  redirecionadoDeClienteMesclado: string | null;
  aniversariantes: AniversarianteApiRecord[];
  responsaveis: ResponsavelApiRecord[];
  cadastro: {
    completoParaContrato: boolean;
    camposFaltantes: Array<{ campo: string; label: string }>;
  };
};

export type ClienteMutacaoApi = {
  cliente: ClienteApiRecord;
  cadastro: {
    completoParaContrato: boolean;
    camposFaltantes: Array<{ campo: string; label: string }>;
  };
  possiveisDuplicidades: CandidatoDuplicidadeApi[];
};

type ApiOk<T> = { ok: true; data: T };
type ApiFalha = {
  ok: false;
  erro?: string;
  codigo?: string;
  detalhes?: unknown;
};

export class CrmApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, options: { status: number; code?: string | null; details?: unknown }) {
    super(message);
    this.name = "CrmApiError";
    this.status = options.status;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await adminFetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new CrmApiError("Não foi possível conectar à API do Kidmais Manager.", { status: 0 });
  }

  let payload: ApiOk<T> | ApiFalha | null = null;
  try {
    payload = await response.json();
  } catch {
    // respostas inesperadas são tratadas abaixo
  }

  if (!response.ok || !payload || payload.ok !== true) {
    const falha = payload && payload.ok === false ? payload : null;
    throw new CrmApiError(
      falha?.erro ?? `A API respondeu com status ${response.status}.`,
      {
        status: response.status,
        code: falha?.codigo ?? null,
        details: falha?.detalhes ?? null,
      },
    );
  }

  return payload.data;
}

function textoOuNull(valor: string) {
  const texto = valor.trim();
  return texto ? texto : null;
}

export function formParaPayload(form: ClienteFormData) {
  return {
    nomeCompleto: form.nomeCompleto.trim(),
    cpf: textoOuNull(form.cpf),
    rg: textoOuNull(form.rg),
    whatsapp: textoOuNull(form.whatsapp),
    telefone: textoOuNull(form.telefone),
    email: textoOuNull(form.email),
    cep: textoOuNull(form.cep),
    logradouro: textoOuNull(form.logradouro),
    numero: textoOuNull(form.numero),
    complemento: textoOuNull(form.complemento),
    bairro: textoOuNull(form.bairro),
    cidade: textoOuNull(form.cidade),
    uf: textoOuNull(form.uf),
    observacoes: textoOuNull(form.observacoes),
  };
}

export function clienteParaForm(cliente: ClienteApiRecord): ClienteFormData {
  return {
    nomeCompleto: cliente.nomeCompleto,
    cpf: cliente.cpf ?? "",
    rg: cliente.rg ?? "",
    whatsapp: cliente.whatsapp ?? "",
    telefone: cliente.telefone ?? "",
    email: cliente.email ?? "",
    cep: cliente.cep ?? "",
    logradouro: cliente.logradouro ?? "",
    numero: cliente.numero ?? "",
    complemento: cliente.complemento ?? "",
    bairro: cliente.bairro ?? "",
    cidade: cliente.cidade ?? "",
    uf: cliente.uf ?? "",
    observacoes: cliente.observacoes ?? "",
  };
}

export function listarClientesApi(params: { q?: string; limit?: number; offset?: number; incluirInativos?: boolean } = {}) {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  if (params.incluirInativos) search.set("incluirInativos", "true");
  const query = search.toString();
  return requestJson<ClienteListaApiItem[]>(`/api/admin/clientes${query ? `?${query}` : ""}`);
}

export function obterClienteApi(clienteId: string) {
  return requestJson<ClienteDetalheApi>(`/api/admin/clientes/${encodeURIComponent(clienteId)}`);
}

export type AniversariantePayload = {
  nome: string;
  dataNascimento: string | null;
  temaPadrao: string | null;
  observacoes: string | null;
};

export function cadastrarAniversarianteApi(clienteId: string, input: AniversariantePayload) {
  return requestJson<AniversarianteApiRecord>(`/api/admin/clientes/${encodeURIComponent(clienteId)}/aniversariantes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function atualizarAniversarianteApi(clienteId: string, aniversarianteId: string, input: AniversariantePayload) {
  return requestJson<AniversarianteApiRecord>(`/api/admin/clientes/${encodeURIComponent(clienteId)}/aniversariantes/${encodeURIComponent(aniversarianteId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function analisarCadastroApi(
  input: Pick<ClienteFormData, "nomeCompleto" | "cpf" | "telefone" | "whatsapp" | "email">,
  excluirClienteId?: string,
) {
  return requestJson<AnaliseCadastroClienteApi>("/api/admin/clientes/analisar-cadastro", {
    method: "POST",
    body: JSON.stringify({
      nomeCompleto: input.nomeCompleto,
      cpf: textoOuNull(input.cpf),
      email: textoOuNull(input.email),
      telefone: textoOuNull(input.telefone),
      whatsapp: textoOuNull(input.whatsapp),
      ...(excluirClienteId ? { excluirClienteId } : {}),
    }),
  });
}

export function cadastrarClienteApi(form: ClienteFormData) {
  return requestJson<ClienteMutacaoApi>("/api/admin/clientes", {
    method: "POST",
    body: JSON.stringify(formParaPayload(form)),
  });
}

export function atualizarClienteApi(clienteId: string, form: ClienteFormData) {
  const payload = formParaPayload(form);
  // Troca de CPF/contratante exige o fluxo específico de identidade, fora deste bloco.
  const { cpf: _cpf, ...patchSemCpf } = payload;
  void _cpf;
  return requestJson<ClienteMutacaoApi>(`/api/admin/clientes/${encodeURIComponent(clienteId)}`, {
    method: "PATCH",
    body: JSON.stringify(patchSemCpf),
  });
}
