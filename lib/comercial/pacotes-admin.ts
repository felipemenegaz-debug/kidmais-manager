import type { DbExecutor } from "../db/contracts.ts";
import { randomUUID } from "node:crypto";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { exigirVinculoNaEmpresa, sqlPacoteAdicionalMesmaEmpresa } from "./integridade-tenant.ts";
import { filtroEmpresa } from "./tenant.ts";

export class PacoteAdminError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: unknown;
  constructor(code: string, message: string, httpStatus: number, details: unknown = null) {
    super(message);
    this.name = "PacoteAdminError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export type PacoteAdmin = {
  id: string;
  empresaId: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number | null;
  convidadosMinimos: number | null;
  convidadosMaximos: number | null;
  diasPermitidos: number[];
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
    convidadosMinimos: row.convidados_minimos == null ? null : Number(row.convidados_minimos),
    convidadosMaximos: row.convidados_maximos == null ? null : Number(row.convidados_maximos),
    diasPermitidos: Array.isArray(row.dias) ? (row.dias as unknown[]).map((dia) => Number(dia)) : [],
    ativo: Boolean(row.ativo),
    vigente: Boolean(row.vigente),
    arquivadoEm: row.arquivado_em == null ? null : String(row.arquivado_em),
    revisaoAnteriorId: row.revisao_anterior_id == null ? null : String(row.revisao_anterior_id),
    utilizado: Boolean(row.utilizado),
  };
}

async function buscar(tx: DbExecutor, empresaId: string, id: string, travar = false) {
  const result = await tx.query(
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos,
            p.convidados_minimos, p.convidados_maximos, p.ativo, p.vigente,
            p.arquivado_em, p.revisao_anterior_id, (${usado}) AS utilizado
       FROM pacotes p
      WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid${travar ? " FOR UPDATE" : ""}`,
    [id, empresaId],
  );
  return result.rows[0] ? map(result.rows[0] as Record<string, unknown>) : null;
}

export async function listarPacotesAdmin(tx: DbExecutor, empresaId: string) {
  const result = await tx.query(
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos,
            p.convidados_minimos, p.convidados_maximos, p.ativo, p.vigente,
            p.arquivado_em, p.revisao_anterior_id, (${usado}) AS utilizado,
            COALESCE((
              SELECT array_agg(DISTINCT r.dia_semana ORDER BY r.dia_semana)
                FROM regras_disponibilidade_pacote r
               WHERE r.pacote_id = p.id
                 AND r.ativo
                 AND r.estado = 'DISPONIVEL'
                 AND r.vigencia_inicio <= CURRENT_DATE
                 AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= CURRENT_DATE)
            ), ARRAY[]::smallint[]) AS dias
       FROM pacotes p
      WHERE p.${filtroEmpresa}
        AND (p.vigente OR p.arquivado_em IS DISTINCT FROM NULL)
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
    `SELECT p.id, p.empresa_id, p.codigo, p.nome, p.descricao, p.duracao_minutos,
            p.convidados_minimos, p.convidados_maximos, p.ativo, p.vigente,
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
  input: {
    empresaId: string;
    codigo?: string;
    nome: string;
    descricao: string | null;
    duracaoMinutos: number | null;
    convidadosMinimos?: number | null;
    convidadosMaximos?: number | null;
  },
  ctx: Contexto,
) {
  if (input.empresaId !== ctx.empresaId) recusar("EMPRESA_DIVERGENTE", "O pacote não pode ser criado em outra empresa.", 403);
  await empresaExiste(tx, ctx.empresaId);
  // Código técnico só nasce aqui. Revisões continuam usando o código original.
  // O índice (empresa_id, codigo) WHERE vigente garante a unicidade no banco.
  const cadastro = { ...input, codigo: input.codigo ?? `P_${randomUUID().replaceAll('-', '').toUpperCase()}` };
  const result = await tx.query(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, descricao, duracao_minutos, convidados_minimos, convidados_maximos,
       ordem_exibicao, ativo, vigente
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7,
       (SELECT COALESCE(MAX(ordem_exibicao), 0) + 1 FROM pacotes),
       true, true
     ) RETURNING id`,
    [ctx.empresaId, cadastro.codigo, input.nome, input.descricao, input.duracaoMinutos, input.convidadosMinimos ?? null, input.convidadosMaximos ?? null],
  );
  const id = String((result.rows[0] as { id: string }).id);
  await registrarMutacao(tx, ctx, "PACOTE_CRIADO", id, null, cadastro, ctx.motivo ?? "Criação administrativa");
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function duplicarPacoteAdmin(tx: DbExecutor, origemId: string, codigo: string | undefined, ctx: Contexto) {
  const origem = await buscar(tx, ctx.empresaId, origemId, true);
  if (!origem) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  const criado = await criarPacoteAdmin(tx, {
    empresaId: ctx.empresaId,
    codigo,
    nome: nomeCopia(origem.nome),
    descricao: origem.descricao,
    duracaoMinutos: origem.duracaoMinutos,
    convidadosMinimos: origem.convidadosMinimos,
    convidadosMaximos: origem.convidadosMaximos,
  }, ctx);
  await clonarAgregadoPacote(tx, origem.id, criado.id);
  return (await buscar(tx, ctx.empresaId, criado.id))!;
}

function nomeCopia(nome: string) {
  const sufixo = " Cópia";
  const base = nome.trim();
  if (base.length + sufixo.length <= 160) return `${base}${sufixo}`;
  return `${base.slice(0, 160 - sufixo.length).trimEnd()}${sufixo}`;
}

export async function editarPacoteNaoUtilizado(
  tx: DbExecutor,
  id: string,
  input: {
    nome: string;
    descricao: string | null;
    duracaoMinutos: number | null;
    convidadosMinimos?: number | null;
    convidadosMaximos?: number | null;
  },
  ctx: Contexto,
) {
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.utilizado) recusar("REVISAO_UTILIZADA", "Pacote utilizado. A mudança futura cria uma revisão.", 409);
  if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não é editado por esta ação.", 409);
  const convidadosMinimos = input.convidadosMinimos === undefined ? atual.convidadosMinimos : input.convidadosMinimos;
  const convidadosMaximos = input.convidadosMaximos === undefined ? atual.convidadosMaximos : input.convidadosMaximos;
  const result = await tx.query(
    `UPDATE pacotes
        SET nome = $3, descricao = $4, duracao_minutos = $5, convidados_minimos = $6, convidados_maximos = $7
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND vigente AND arquivado_em IS NULL
      RETURNING id`,
    [id, ctx.empresaId, input.nome, input.descricao, input.duracaoMinutos, convidadosMinimos, convidadosMaximos],
  );
  if (result.rowCount !== 1) recusar("CONFLITO", "A revisão vigente mudou durante a edição.", 409);
  await registrarMutacao(tx, ctx, "PACOTE_EDITADO", id, atual, input, ctx.motivo ?? "Edição administrativa");
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function criarRevisaoPacoteAdmin(
  tx: DbExecutor,
  id: string,
  input: {
    nome: string;
    descricao: string | null;
    duracaoMinutos: number | null;
    convidadosMinimos?: number | null;
    convidadosMaximos?: number | null;
  },
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
       empresa_id, codigo, nome, descricao, duracao_minutos, convidados_minimos, convidados_maximos,
       ordem_exibicao, ativo, vigente, revisao_anterior_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7,
       (SELECT ordem_exibicao FROM pacotes WHERE id = $8::uuid),
       true, true, $8::uuid
     ) RETURNING id`,
    [
      ctx.empresaId,
      atual.codigo,
      input.nome,
      input.descricao,
      input.duracaoMinutos,
      input.convidadosMinimos === undefined ? atual.convidadosMinimos : input.convidadosMinimos,
      input.convidadosMaximos === undefined ? atual.convidadosMaximos : input.convidadosMaximos,
      id,
    ],
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
    ? await criarRevisaoPacoteAdmin(tx, id, {
      nome: atual.nome,
      descricao: atual.descricao,
      duracaoMinutos: atual.duracaoMinutos,
      convidadosMinimos: atual.convidadosMinimos,
      convidadosMaximos: atual.convidadosMaximos,
    }, ctx, { silenciarAuditoria: true })
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

const TABELAS_DO_PROPRIO_PACOTE = new Set([
  "pacote_adicionais",
  "pacote_buffet_categorias",
  "pacote_buffet_itens",
  "regras_disponibilidade_pacote",
  "regras_desconto_pacote",
  "precos_pacote",
  "tabela_preco_escopos",
]);

function identificadorSql(nome: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) recusar("EM_USO", "Não foi possível conferir todos os vínculos deste pacote. Ele não foi apagado.", 409);
  return nome;
}

function mensagemDeUso(tabela: string) {
  if (tabela.includes("fechamento") || tabela.includes("snapshot") || tabela.includes("festa") || tabela.includes("contrato")) {
    return "Este pacote já foi usado em uma festa ou contrato. Apagar removeria esse histórico, então ele continua guardado.";
  }
  if (tabela === "pacotes") return "Existe uma revisão ligada a este pacote. Ele continua guardado.";
  if (tabela.includes("preco") || tabela.includes("escopo")) {
    return "Este pacote já tem preço protegido de festas e contratos. Ele não pode ser apagado.";
  }
  return "Este pacote ainda está ligado a outros registros. Ele não pode ser apagado.";
}

export async function definirDisponibilidadePacoteAdmin(
  tx: DbExecutor,
  id: string,
  escolha: { dias: number[]; horariosIds: string[] },
  ctx: Contexto,
) {
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não recebe disponibilidade por esta ação.", 409);
  const dias = [...new Set(escolha.dias)];
  const horarios = [...new Set(escolha.horariosIds)];
  if (horarios.length > 0) {
    const existentes = await tx.query<{ id: string }>(
      `SELECT id FROM configuracao_agenda WHERE ativo AND id = ANY($1::uuid[])`,
      [horarios],
    );
    if (existentes.rows.length !== horarios.length) {
      recusar("DADOS_INVALIDOS", "Escolha apenas horários que o calendário já usa.", 409);
    }
  }
  const paresDias = dias.flatMap((dia) => horarios.map(() => dia));
  const paresHorarios = dias.flatMap(() => horarios);
  await tx.query(
    `UPDATE regras_disponibilidade_pacote r
        SET vigencia_fim = CURRENT_DATE - 1
      WHERE r.pacote_id = $1::uuid
        AND r.ativo
        AND r.vigencia_fim IS NULL
        AND r.vigencia_inicio < CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM unnest($2::smallint[], $3::uuid[]) AS e(dia, horario)
           WHERE e.dia = r.dia_semana AND e.horario = r.configuracao_agenda_id
        )`,
    [id, paresDias, paresHorarios],
  );
  await tx.query(
    `UPDATE regras_disponibilidade_pacote r
        SET ativo = false
      WHERE r.pacote_id = $1::uuid
        AND r.ativo
        AND r.vigencia_inicio >= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM unnest($2::smallint[], $3::uuid[]) AS e(dia, horario)
           WHERE e.dia = r.dia_semana AND e.horario = r.configuracao_agenda_id
        )`,
    [id, paresDias, paresHorarios],
  );
  if (paresDias.length > 0) {
    await tx.query(
      `INSERT INTO regras_disponibilidade_pacote (
         pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, ativo
       )
       SELECT $1::uuid, e.dia, e.horario, 'DISPONIVEL', CURRENT_DATE, true
         FROM unnest($2::smallint[], $3::uuid[]) AS e(dia, horario)
       ON CONFLICT (pacote_id, dia_semana, configuracao_agenda_id, vigencia_inicio)
       DO UPDATE SET estado = 'DISPONIVEL', ativo = true, vigencia_fim = NULL`,
      [id, paresDias, paresHorarios],
    );
  }
  await registrarMutacao(tx, ctx, "PACOTE_DISPONIBILIDADE", id, atual, { dias, horarios }, ctx.motivo ?? "PACOTE_EDITADO");
  return (await buscar(tx, ctx.empresaId, id))!;
}

export async function definirCategoriasPacoteAdmin(
  tx: DbExecutor,
  id: string,
  categorias: Array<{ categoriaId: string; escolhas: number }>,
  ctx: Contexto,
) {
  if (!ctx.motivo || ctx.motivo.trim().length < 3) recusar("DADOS_INVALIDOS", "A mudança de composição exige um motivo.", 409);
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não recebe composição por esta ação.", 409);
  const ids = [...new Set(categorias.map((categoria) => categoria.categoriaId))];
  if (ids.length > 0) {
    const existentes = await tx.query<{ id: string }>(
      `SELECT id FROM buffet_categorias WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    if (existentes.rows.length !== ids.length) recusar("DADOS_INVALIDOS", "Escolha apenas categorias do buffet já cadastradas.", 409);
  }
  const destino = atual.utilizado
    ? await criarRevisaoPacoteAdmin(tx, id, {
      nome: atual.nome,
      descricao: atual.descricao,
      duracaoMinutos: atual.duracaoMinutos,
      convidadosMinimos: atual.convidadosMinimos,
      convidadosMaximos: atual.convidadosMaximos,
    }, ctx, { silenciarAuditoria: true })
    : atual;
  const antes = await lerComposicao(tx, destino.id);
  await tx.query(
    `UPDATE pacote_buffet_categorias
        SET ativo = false
      WHERE pacote_id = $1::uuid
        AND NOT (categoria_id = ANY($2::uuid[]))`,
    [destino.id, ids],
  );
  for (const categoria of categorias) {
    if (!Number.isInteger(categoria.escolhas) || categoria.escolhas < 0 || categoria.escolhas > 30) {
      recusar("LIMITE_BUFFET", "Informe quantas opções o cliente escolhe, de 0 a 30.", 409);
    }
    await tx.query(
      `INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
       VALUES ($1::uuid, $2::uuid, 'SELECIONADOS', 0, $3, true)
       ON CONFLICT (pacote_id, categoria_id)
       DO UPDATE SET escolhas_max = EXCLUDED.escolhas_max, ativo = true`,
      [destino.id, categoria.categoriaId, categoria.escolhas],
    );
  }
  const depois = await lerComposicao(tx, destino.id);
  await registrarMutacao(tx, ctx, "PACOTE_COMPOSICAO", destino.id, antes, depois, ctx.motivo);
  return (await buscar(tx, ctx.empresaId, destino.id))!;
}

/**
 * Apaga só pacote arquivado sem dependência.
 * Pacote já usado fica bloqueado. Uma purga futura desse histórico exige migration com Human Gate;
 * esta função não apaga fechamento, snapshot, contrato, festa nem preço publicado.
 */
export async function excluirPacoteArquivadoAdmin(tx: DbExecutor, id: string, ctx: Contexto) {
  const atual = await buscar(tx, ctx.empresaId, id, true);
  if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if (!atual.arquivadoEm) recusar("NAO_ARQUIVADO", "Arquive o pacote antes de excluir.", 409);
  const vinculos = await tx.query<{ tabela: string; coluna: string; composto: boolean }>(
    `SELECT c.relname AS tabela, a.attname AS coluna, cardinality(fk.conkey) <> 1 AS composto
       FROM pg_constraint fk
       JOIN pg_class c ON c.oid = fk.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = fk.conkey[1]
      WHERE fk.contype = 'f'
        AND fk.confrelid = 'public.pacotes'::regclass
        AND n.nspname = 'public'`,
  );
  if (vinculos.rows.some((vinculo) => vinculo.composto)) {
    recusar("EM_USO", "Este pacote tem um vínculo que esta exclusão não consegue conferir. Ele não foi apagado.", 409);
  }
  for (const vinculo of vinculos.rows) {
    if (TABELAS_DO_PROPRIO_PACOTE.has(vinculo.tabela)) continue;
    const tabela = identificadorSql(vinculo.tabela);
    const coluna = identificadorSql(vinculo.coluna);
    const contagem = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${tabela} WHERE ${coluna} = $1::uuid`,
      [id],
    );
    if (Number(contagem.rows[0]?.n ?? 0) > 0) recusar("EM_USO", mensagemDeUso(tabela), 409);
  }
  const precoProtegido = await tx.query(
    `SELECT 1
       FROM precos_pacote pp
       JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      WHERE pp.pacote_id = $1::uuid
        AND (
          t.publicada_em IS NOT NULL
          OR t.empresa_id IS DISTINCT FROM $2::uuid
          OR EXISTS (SELECT 1 FROM fechamentos f WHERE f.preco_pacote_id = pp.id)
          OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots s WHERE s.preco_pacote_id = pp.id)
          OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.preco_pacote_id = pp.id)
        )
      LIMIT 1`,
    [id, ctx.empresaId],
  );
  if (precoProtegido.rows[0]) {
    recusar("EM_USO", "Este pacote já tem preço protegido de festas e contratos. Ele não pode ser apagado.", 409);
  }
  const escopoPublicado = await tx.query(
    `SELECT 1
       FROM tabela_preco_escopos e
       JOIN tabelas_preco t ON t.id = e.tabela_preco_id
      WHERE e.pacote_id = $1::uuid
        AND t.publicada_em IS NOT NULL
      LIMIT 1`,
    [id],
  );
  if (escopoPublicado.rows[0]) {
    recusar("EM_USO", "Este pacote já entrou numa tabela de preços protegida. Ele não pode ser apagado.", 409);
  }
  await registrarMutacao(tx, ctx, "PACOTE_EXCLUIDO", id, atual, null, ctx.motivo ?? "PACOTE_EXCLUIDO");
  await tx.query(
    `DELETE FROM tabela_preco_escopo_faixas f
      USING tabela_preco_escopos e
      WHERE f.escopo_id = e.id
        AND e.pacote_id = $1::uuid`,
    [id],
  );
  await tx.query(`DELETE FROM tabela_preco_escopos WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM precos_pacote WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM pacote_buffet_itens WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM pacote_buffet_categorias WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM pacote_adicionais WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM regras_disponibilidade_pacote WHERE pacote_id = $1::uuid`, [id]);
  await tx.query(`DELETE FROM regras_desconto_pacote WHERE pacote_id = $1::uuid`, [id]);
  const apagado = await tx.query(
    `DELETE FROM pacotes
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND arquivado_em IS NOT NULL`,
    [id, ctx.empresaId],
  );
  if (apagado.rowCount !== 1) recusar("CONFLITO", "O pacote não foi apagado.", 409);
  return { id };
}
