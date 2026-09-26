import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { exigirVinculoNaEmpresa, sqlPacoteAdicionalMesmaEmpresa } from "./integridade-tenant.ts";
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

type Contexto = { empresaId: string; usuarioId: string; requestId: string; motivo?: string };

type ComposicaoRelacional = {
  adicionais: Array<{ adicionalId: string; modalidade: string; ativo: boolean }>;
  buffet: Array<{ categoriaId: string; modoItens: string; escolhasMin: number; escolhasMax: number; ativo: boolean }>;
  itens: Array<{ categoriaId: string; itemId: string }>;
};

const usado = `EXISTS (SELECT 1 FROM fechamentos f WHERE f.pacote_id = p.id)
  OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots s WHERE s.pacote_id = p.id)
  OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.pacote_id = p.id)`;

function registrarMutacao(
  tx: DbExecutor,
  ctx: Contexto,
  acao: string,
  entidadeId: string,
  antes: unknown,
  depois: unknown,
  motivo: string,
) {
  return auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    acao,
    entidadeTipo: "PACOTE",
    entidadeId,
    empresaId: ctx.empresaId,
    antes: antes && typeof antes === "object" ? antes as Record<string, unknown> : null,
    depois: depois && typeof depois === "object" ? depois as Record<string, unknown> : null,
    motivo,
  });
}

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
  await registrarMutacao(tx, ctx, "PACOTE_CRIADO", id, null, input, ctx.motivo ?? "Criação administrativa");
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function duplicarPacoteAdmin(tx: DbExecutor, origemId: string, codigo: string, ctx: Contexto) {
  const origem = await buscar(tx, ctx.empresaId, origemId, true);
  if (!origem) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  return criarPacoteAdmin(tx, {
    empresaId: ctx.empresaId,
    codigo,
    nome: origem.nome,
    descricao: origem.descricao,
    duracaoMinutos: origem.duracaoMinutos,
  }, ctx);
}

export async function editarPacoteNaoUtilizado(
  tx: DbExecutor,
  id: string,
  input: { nome: string; descricao: string | null; duracaoMinutos: number | null },
  ctx: Contexto,
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
  await registrarMutacao(tx, ctx, "PACOTE_EDITADO", id, atual, input, ctx.motivo ?? "Edição administrativa");
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function criarRevisaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  input: { nome: string; descricao: string | null; duracaoMinutos: number | null },
  ctx: Contexto,
  opcoes?: { silenciarAuditoria?: boolean },
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
  await clonarAgregadoPacote(tx, id, novaId);
  if (!opcoes?.silenciarAuditoria) {
    await registrarMutacao(tx, ctx, "PACOTE_REVISADO", novaId, atual, { ...input, revisaoAnteriorId: id }, ctx.motivo);
  }
  return (await buscar(tx, ctx.empresaId, novaId))!;
}

/** Preço permanece na tabela de preços. A revisão clona composição, buffet, desconto e disponibilidade. */
async function clonarAgregadoPacote(tx: DbExecutor, origemId: string, novaId: string) {
  await tx.query(
    `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade, ativo)
     SELECT $1::uuid, adicional_id, modalidade, ativo
       FROM pacote_adicionais
      WHERE pacote_id = $2::uuid`,
    [novaId, origemId],
  );
  await tx.query(
    `INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
     SELECT $1::uuid, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo
       FROM pacote_buffet_categorias
      WHERE pacote_id = $2::uuid`,
    [novaId, origemId],
  );
  await tx.query(
    `INSERT INTO pacote_buffet_itens (pacote_id, categoria_id, item_id)
     SELECT $1::uuid, categoria_id, item_id
       FROM pacote_buffet_itens
      WHERE pacote_id = $2::uuid`,
    [novaId, origemId],
  );
  await tx.query(
    `INSERT INTO regras_desconto_pacote (
       pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo,
       prioridade, vigencia_inicio, vigencia_fim, ativo, observacoes
     )
     SELECT $1::uuid, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo,
            prioridade, vigencia_inicio, vigencia_fim, ativo, observacoes
       FROM regras_desconto_pacote
      WHERE pacote_id = $2::uuid`,
    [novaId, origemId],
  );
  await tx.query(
    `INSERT INTO regras_disponibilidade_pacote (
       pacote_id, dia_semana, configuracao_agenda_id, estado,
       vigencia_inicio, vigencia_fim, ativo, observacoes
     )
     SELECT $1::uuid, dia_semana, configuracao_agenda_id, estado,
            vigencia_inicio, vigencia_fim, ativo, observacoes
       FROM regras_disponibilidade_pacote
      WHERE pacote_id = $2::uuid`,
    [novaId, origemId],
  );
}

async function lerComposicao(tx: DbExecutor, pacoteId: string): Promise<ComposicaoRelacional> {
  const adicionais = await tx.query<{ adicional_id: string; modalidade: string; ativo: boolean }>(
    `SELECT adicional_id, modalidade, ativo
       FROM pacote_adicionais
      WHERE pacote_id = $1::uuid
      ORDER BY adicional_id`,
    [pacoteId],
  );
  const buffet = await tx.query<{ categoria_id: string; modo_itens: string; escolhas_min: number; escolhas_max: number; ativo: boolean }>(
    `SELECT categoria_id, modo_itens, escolhas_min, escolhas_max, ativo
       FROM pacote_buffet_categorias
      WHERE pacote_id = $1::uuid
      ORDER BY categoria_id`,
    [pacoteId],
  );
  const itens = await tx.query<{ categoria_id: string; item_id: string }>(
    `SELECT categoria_id, item_id
       FROM pacote_buffet_itens
      WHERE pacote_id = $1::uuid
      ORDER BY categoria_id, item_id`,
    [pacoteId],
  );
  return {
    adicionais: adicionais.rows.map((row) => ({ adicionalId: row.adicional_id, modalidade: row.modalidade, ativo: row.ativo })),
    buffet: buffet.rows.map((row) => ({
      categoriaId: row.categoria_id,
      modoItens: row.modo_itens,
      escolhasMin: Number(row.escolhas_min),
      escolhasMax: Number(row.escolhas_max),
      ativo: row.ativo,
    })),
    itens: itens.rows.map((row) => ({ categoriaId: row.categoria_id, itemId: row.item_id })),
  };
}

export async function alterarComposicaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  mudanca:
    | { tipo: "vinculo"; adicionalId: string; modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL" }
    | { tipo: "buffet"; categoriaId: string; ativo: boolean; escolhasMin: number; escolhasMax: number },
  ctx: Contexto,
) {
  if (!ctx.motivo || ctx.motivo.trim().length < 3) recusar("DADOS_INVALIDOS", "A mudança de composição exige um motivo.", 409);
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não recebe composição por esta ação.", 409);
  if (mudanca.tipo === "vinculo") {
    await exigirVinculoNaEmpresa(tx, ctx.empresaId, {
      sql: sqlPacoteAdicionalMesmaEmpresa(),
      params: [id, mudanca.adicionalId],
    });
  }
  const composicaoAntes = await lerComposicao(tx, id);
  const destino = atual.utilizado
    ? await criarRevisaoPacoteAdmin(tx, id, { nome: atual.nome, descricao: atual.descricao, duracaoMinutos: atual.duracaoMinutos }, ctx, { silenciarAuditoria: true })
    : atual;
  if (mudanca.tipo === "vinculo") {
    await tx.query(
      `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (pacote_id, adicional_id) DO UPDATE SET modalidade = EXCLUDED.modalidade, ativo = true`,
      [destino.id, mudanca.adicionalId, mudanca.modalidade],
    );
  } else {
    await tx.query(
      `INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
       VALUES ($1::uuid, $2::uuid, 'SELECIONADOS', $3, $4, $5)
       ON CONFLICT (pacote_id, categoria_id)
       DO UPDATE SET escolhas_min = EXCLUDED.escolhas_min, escolhas_max = EXCLUDED.escolhas_max, ativo = EXCLUDED.ativo`,
      [destino.id, mudanca.categoriaId, mudanca.escolhasMin, mudanca.escolhasMax, mudanca.ativo],
    );
  }
  const composicaoDepois = await lerComposicao(tx, destino.id);
  await registrarMutacao(tx, ctx, "PACOTE_COMPOSICAO", destino.id, composicaoAntes, composicaoDepois, ctx.motivo);
  return (await buscar(tx, ctx.empresaId, destino.id))!;
}

export async function alterarSituacaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  situacao: "ativar" | "desativar" | "arquivar",
  ctx: Contexto,
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
  await registrarMutacao(tx, ctx, "PACOTE_SITUACAO", id, atual, { situacao }, ctx.motivo ?? situacao);
  return (await buscar(tx, ctx.empresaId, id))!;
}
