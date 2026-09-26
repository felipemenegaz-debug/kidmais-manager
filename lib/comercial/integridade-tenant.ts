import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { mesmaEmpresa } from "./tenant.ts";

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

/** Igual ao SQL `IS DISTINCT FROM`: nulo com nulo não cruza; empresa diferente cruza. */
export function empresasDistintas(esquerda: string | null, direita: string | null): boolean {
  return esquerda !== direita;
}

/**
 * Operação de tenant: os dois lados precisam ser a empresa do contexto.
 * Legado sem empresa não é vinculado a uma empresa, nem uma empresa à outra.
 */
export async function exigirVinculoNaEmpresa(
  tx: DbExecutor,
  empresaId: string,
  consulta: { sql: string; params: readonly unknown[] },
) {
  const resultado = await tx.query<{ esquerda: string | null; direita: string | null }>(consulta.sql, consulta.params);
  const linha = resultado.rows[0];
  if (!linha) recusar("NAO_ENCONTRADO", "O vínculo não foi encontrado nesta empresa.", 404);
  if (!mesmaEmpresa(linha.esquerda, empresaId) || !mesmaEmpresa(linha.direita, empresaId) || empresasDistintas(linha.esquerda, linha.direita)) {
    recusar("EMPRESA_DIVERGENTE", "O vínculo cruza empresas.", 403);
  }
}

export function sqlPrecoPacoteMesmaEmpresa() {
  return `SELECT t.empresa_id::text AS esquerda, p.empresa_id::text AS direita
            FROM tabelas_preco t
            JOIN pacotes p ON p.id = $2::uuid
           WHERE t.id = $1::uuid`;
}

export function sqlPacoteAdicionalMesmaEmpresa() {
  return `SELECT p.empresa_id::text AS esquerda, a.empresa_id::text AS direita
            FROM pacotes p
            JOIN adicionais a ON a.id = $2::uuid
           WHERE p.id = $1::uuid`;
}

export function sqlPrecoAdicionalMesmaEmpresa() {
  return `SELECT t.empresa_id::text AS esquerda, a.empresa_id::text AS direita
            FROM tabelas_preco t
            JOIN adicionais a ON a.id = $2::uuid
           WHERE t.id = $1::uuid`;
}
