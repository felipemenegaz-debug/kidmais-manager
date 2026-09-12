export type ClienteServiceContext = {
  usuarioId?: string | null;
  origem: "CRM_INTERNO" | "CRM_INTERNO_DEV" | "FECHAMENTO_PUBLICO" | "SISTEMA";
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export function auditoriaActor(context: ClienteServiceContext) {
  return context.usuarioId
    ? { atorTipo: "USUARIO" as const, usuarioId: context.usuarioId }
    : { atorTipo: "SISTEMA" as const, usuarioId: null };
}
