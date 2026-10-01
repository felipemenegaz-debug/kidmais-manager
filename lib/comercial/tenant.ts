export class IsolamentoEmpresaError extends Error {
  constructor() {
    super("O registro não pertence à empresa informada.");
    this.name = "IsolamentoEmpresaError";
  }
}

/** Pacote legado, com empresa nula, não pertence a nenhum tenant. */
export function mesmaEmpresa(registroEmpresaId: string | null, contextoEmpresaId: string): boolean {
  return registroEmpresaId !== null && registroEmpresaId === contextoEmpresaId;
}

export function exigirMesmaEmpresa(registroEmpresaId: string | null, contextoEmpresaId: string): void {
  if (!mesmaEmpresa(registroEmpresaId, contextoEmpresaId)) throw new IsolamentoEmpresaError();
}

export const filtroEmpresa = "empresa_id = $1::uuid";
