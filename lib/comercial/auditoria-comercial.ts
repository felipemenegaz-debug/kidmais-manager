import type { DbExecutor } from "../db/contracts.ts";

/** A tabela auditoria não tem empresa. O tenant vai no antes/depois, na mesma transação da mutação. */
export async function auditarMutacaoComercial(
  tx: DbExecutor,
  evento: {
    usuarioId: string | null;
    requestId: string | null;
    acao: string;
    entidadeTipo: string;
    entidadeId: string;
    empresaId: string;
    antes: Record<string, unknown> | null;
    depois: Record<string, unknown> | null;
    motivo: string | null;
  },
) {
  const antes = { ...(evento.antes ?? {}), empresaId: evento.empresaId };
  const depois = { ...(evento.depois ?? {}), empresaId: evento.empresaId };
  await tx.query(
    `INSERT INTO auditoria (
       ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
       dados_antes, dados_depois, justificativa, origem, request_id
     ) VALUES (
       $1, $2, $3, $4, $5::uuid, $6::jsonb, $7::jsonb, $8, 'COMERCIAL', $9
     )`,
    [
      evento.usuarioId ? "USUARIO" : "SISTEMA",
      evento.usuarioId,
      evento.acao,
      evento.entidadeTipo,
      evento.entidadeId,
      JSON.stringify(antes),
      JSON.stringify(depois),
      evento.motivo,
      evento.requestId,
    ],
  );
}
