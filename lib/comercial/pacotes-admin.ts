import type { DbExecutor } from "../db/contracts.ts";
import { filtroEmpresa } from "./tenant.ts";

export class PacoteAdminError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: null = null;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "PacoteAdminError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type PacoteAdmin = {
  id: string;
  empresaId: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number | null;
  ativo: boolean;
  vigente: boolean;
  arquivadoEm: string | null;
  revisaoAnteriorId: string | null;
  utilizado: boolean;
};

type AuditoriaPacote = (tx: DbExecutor, evento: {
  usuarioId: string;
  requestId: string;
  acao: string;
  pacoteId: string;
  antes: unknown;
  depois: unknown;
  motivo: string;
}) => Promise<unknown>;

type Contexto = { empresaId: string; usuarioId: string; requestId: string; motivo?: string };

const usado = `EXISTS (SELECT 1 FROM fechamentos f WHERE f.pacote_id = p.id)
  OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots s WHERE s.pacote_id = p.id)
  OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.pacote_id = p.id)`;

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

function map(row: Record<string, unknown>): PacoteAdmin {
  return {
    id: String(row.id),
    empresaId: String(row.empresa_id),
    codigo: String(row.codigo),
    nome: String(row.nome),
    descricao: row.descricao == null ? null : String(row.descricao),
    duracaoMinutos: row.duracao_minutos == null ? null : Number(row.duracao_minutos),
    ativo: Boolean(row.ativo),
    vigente: Boolean(row.vigente),
    arquivadoEm: row.arquivado_em == null ? null : String(row.arquivado_em),
    revisaoAnteriorId: row.revisao_anterior_id == null ? null : String(row.revisao_anterior_id),
    utilizado: Boolean(row.utilizado),
  };
}

async function buscar(tx: DbExecutor, empresaId: string, id: string, travar = false) {
  const result = await tx.query(
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos, p.ativo, p.vigente,
            p.arquivado_em, p.revisao_anterior_id, (${usado}) AS utilizado
       FROM pacotes p
      WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid${travar ? " FOR UPDATE" : ""}`,
    [id, empresaId],
  );
  return result.rows[0] ? map(result.rows[0] as Record<string, unknown>) : null;
}

export async function listarPacotesAdmin(tx: DbExecutor, empresaId: string) {
  const result = await tx.query(
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos, p.ativo, p.vigente,
            p.arquivado_em, p.revisao_anterior_id, (${usado}) AS utilizado
       FROM pacotes p
      WHERE p.${filtroEmpresa} AND p.vigente
      ORDER BY p.ordem_exibicao, p.codigo`,
    [empresaId],
  );
  return result.rows.map((row) => map(row as Record<string, unknown>));
}

export async function consultarPacoteAdmin(tx: DbExecutor, empresaId: string, id: string) {
  return buscar(tx, empresaId, id);
}

export async function historicoPacoteAdmin(tx: DbExecutor, empresaId: string, id: string) {
  const atual = await buscar(tx, empresaId, id);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  const result = await tx.query(
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos, p.ativo, p.vigente,
            p.arquivado_em, p.revisao_anterior_id, (${usado}) AS utilizado
       FROM pacotes p
      WHERE p.${filtroEmpresa} AND p.codigo = $2
      ORDER BY p.criado_em, p.id`,
    [empresaId, atual.codigo],
  );
  return result.rows.map((row) => map(row as Record<string, unknown>));
}

async function empresaExiste(tx: DbExecutor, empresaId: string) {
  const result = await tx.query(`SELECT id FROM empresas WHERE id = $1::uuid`, [empresaId]);
  if (!result.rows[0]) recusar("NAO_ENCONTRADO", "Empresa não encontrada.", 404);
}

export async function criarPacoteAdmin(
  tx: DbExecutor,
  input: { empresaId: string; codigo: string; nome: string; descricao: string | null; duracaoMinutos: number | null },
  ctx: Contexto,
  auditar: AuditoriaPacote,
) {
  if (input.empresaId !== ctx.empresaId) recusar("EMPRESA_DIVERGENTE", "O pacote não pode ser criado em outra empresa.", 403);
  await empresaExiste(tx, ctx.empresaId);
  const result = await tx.query(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, descricao, duracao_minutos, ordem_exibicao, ativo, vigente
     ) VALUES (
       $1::uuid, $2, $3, $4, $5,
       (SELECT COALESCE(MAX(ordem_exibicao), 0) + 1 FROM pacotes),
       true, true
     ) RETURNING id`,
    [ctx.empresaId, input.codigo, input.nome, input.descricao, input.duracaoMinutos],
  );
  const id = String((result.rows[0] as { id: string }).id);
  await auditar(tx, { usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao: "PACOTE_CRIADO", pacoteId: id, antes: null, depois: input, motivo: ctx.motivo ?? "Criação administrativa" });
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function duplicarPacoteAdmin(tx: DbExecutor, origemId: string, codigo: string, ctx: Contexto, auditar: AuditoriaPacote) {
  const origem = await buscar(tx, ctx.empresaId, origemId, true);
  if (!origem) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  return criarPacoteAdmin(tx, {
    empresaId: ctx.empresaId,
    codigo,
    nome: origem.nome,
    descricao: origem.descricao,
    duracaoMinutos: origem.duracaoMinutos,
  }, ctx, auditar);
}

export async function editarPacoteNaoUtilizado(
  tx: DbExecutor,
  id: string,
  input: { nome: string; descricao: string | null; duracaoMinutos: number | null },
  ctx: Contexto,
  auditar: AuditoriaPacote,
) {
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.utilizado) recusar("REVISAO_UTILIZADA", "Pacote utilizado. A mudança futura cria uma revisão.", 409);
  if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não é editado por esta ação.", 409);
  const result = await tx.query(
    `UPDATE pacotes
        SET nome = $3, descricao = $4, duracao_minutos = $5
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND vigente AND arquivado_em IS NULL
      RETURNING id`,
    [id, ctx.empresaId, input.nome, input.descricao, input.duracaoMinutos],
  );
  if (result.rowCount !== 1) recusar("CONFLITO", "A revisão vigente mudou durante a edição.", 409);
  await auditar(tx, { usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao: "PACOTE_EDITADO", pacoteId: id, antes: atual, depois: input, motivo: ctx.motivo ?? "Edição administrativa" });
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function criarRevisaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  input: { nome: string; descricao: string | null; duracaoMinutos: number | null },
  ctx: Contexto,
  auditar: AuditoriaPacote,
) {
  if (!ctx.motivo || ctx.motivo.trim().length < 3) recusar("DADOS_INVALIDOS", "A nova revisão exige um motivo.", 409);
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (!atual.vigente) recusar("CONFLITO", "A revisão informada não é a vigente.", 409);
  if (!atual.utilizado) recusar("REVISAO_LIVRE", "A revisão ainda não utilizada pode ser editada.", 409);
  const retirada = await tx.query(
    `UPDATE pacotes SET vigente = false
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND vigente
      RETURNING id`,
    [id, ctx.empresaId],
  );
  if (retirada.rowCount !== 1) recusar("CONFLITO", "A revisão vigente mudou durante a correção.", 409);
  const criada = await tx.query(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, descricao, duracao_minutos, ordem_exibicao, ativo, vigente, revisao_anterior_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5,
       (SELECT ordem_exibicao FROM pacotes WHERE id = $6::uuid),
       true, true, $6::uuid
     ) RETURNING id`,
    [ctx.empresaId, atual.codigo, input.nome, input.descricao, input.duracaoMinutos, id],
  );
  const novaId = String((criada.rows[0] as { id: string }).id);
  await auditar(tx, { usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao: "PACOTE_REVISADO", pacoteId: novaId, antes: atual, depois: { ...input, revisaoAnteriorId: id }, motivo: ctx.motivo });
  return (await buscar(tx, ctx.empresaId, novaId))!;
}

export async function alterarSituacaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  situacao: "ativar" | "desativar" | "arquivar",
  ctx: Contexto,
  auditar: AuditoriaPacote,
) {
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.arquivadoEm && situacao !== "arquivar") {
    recusar("ARQUIVADO", "A restauração de um pacote arquivado não está disponível.", 409);
  }
  const result = await tx.query(
    `UPDATE pacotes
        SET ativo = $3,
            vigente = CASE WHEN $4 THEN false ELSE vigente END,
            arquivado_em = CASE WHEN $4 THEN clock_timestamp() ELSE arquivado_em END
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      RETURNING id`,
    [id, ctx.empresaId, situacao === "ativar", situacao === "arquivar"],
  );
  if (result.rowCount !== 1) recusar("CONFLITO", "A situação do pacote não foi alterada.", 409);
  await auditar(tx, { usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao: "PACOTE_SITUACAO", pacoteId: id, antes: atual, depois: { situacao }, motivo: ctx.motivo ?? situacao });
  return (await buscar(tx, ctx.empresaId, id))!;
}
