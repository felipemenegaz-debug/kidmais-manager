import type { ResumoComercial } from "../../comercial/services";
import type { DbExecutor } from "../../db/contracts";
import type { FechamentoRecord } from "../repositories";
import { FechamentoServiceError } from "./errors.ts";

type InclusoRow = { id: string; codigo: string; nome: string };
type BuffetRow = {
  id: string;
  codigo: string;
  nome: string;
  modo_itens: "TODOS_ATIVOS" | "SELECIONADOS";
  escolhas_min: number;
  escolhas_max: number;
};

async function gravarComposicao(tx: DbExecutor, snapshotId: string, pacoteId: string) {
  const inclusos = await tx.query<InclusoRow>(
    `SELECT a.id, a.codigo, a.nome
       FROM pacote_adicionais pa
       JOIN adicionais a ON a.id = pa.adicional_id
      WHERE pa.pacote_id = $1::uuid
        AND pa.ativo
        AND pa.modalidade = 'INCLUSO'
        AND a.ativo
      ORDER BY a.ordem_exibicao, a.codigo`,
    [pacoteId],
  );
  for (const item of inclusos.rows) {
    await tx.query(
      `INSERT INTO fechamento_pacote_composicao (
         snapshot_id, tipo, adicional_id, codigo_aplicado, nome_aplicado
       ) VALUES ($1::uuid, 'INCLUSO', $2::uuid, $3, $4)`,
      [snapshotId, item.id, item.codigo, item.nome],
    );
  }
  const buffet = await tx.query<BuffetRow>(
    `SELECT c.id, c.codigo, c.nome, r.modo_itens, r.escolhas_min, r.escolhas_max
       FROM pacote_buffet_categorias r
       JOIN buffet_categorias c ON c.id = r.categoria_id
      WHERE r.pacote_id = $1::uuid
        AND r.ativo
        AND c.ativo
      ORDER BY c.ordem_exibicao, c.codigo`,
    [pacoteId],
  );
  for (const categoria of buffet.rows) {
    await tx.query(
      `INSERT INTO fechamento_pacote_composicao (
         snapshot_id, tipo, categoria_id, codigo_aplicado, nome_aplicado,
         modo_itens, escolhas_min, escolhas_max
       ) VALUES ($1::uuid, 'BUFFET', $2::uuid, $3, $4, $5, $6, $7)`,
      [snapshotId, categoria.id, categoria.codigo, categoria.nome, categoria.modo_itens, categoria.escolhas_min, categoria.escolhas_max],
    );
  }
}

/**
 * Grava a fotografia vigente do pacote na mesma transação do fechamento.
 * Duração e descrição permanecem nulas quando o cadastro não as tem.
 */
export async function gravarFotografiaPacoteFechamento(
  tx: DbExecutor,
  fechamento: FechamentoRecord,
  resumo: ResumoComercial,
): Promise<string> {
  const pacote = resumo.pacote.pacote;
  const tabela = resumo.pacote.tabelaPreco;
  const preco = resumo.pacote.precoRegra;
  const desconto = resumo.pacote.desconto;
  const fotografia = await tx.query<{ id: string }>(
    `INSERT INTO fechamento_pacote_snapshots (
       fechamento_id, sequencia, pacote_id, codigo_aplicado, nome_aplicado,
       descricao_aplicada, duracao_minutos_aplicada,
       tabela_preco_id, tabela_codigo_aplicado, tabela_nome_aplicado,
       preco_pacote_id, regra_desconto_pacote_id, codigo_regra_desconto, titulo_regra_desconto,
       tipo_calculo, convidados_min_faixa, convidados_max_faixa, categoria_preco_linha, valor_linha,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
       desconto_percentual, valor_pacote_base, valor_desconto_pacote, valor_pacote_aplicado,
       valor_adicionais, valor_tabela, motivo, ator_usuario_id, snapshot_anterior_id
     ) VALUES (
       $1::uuid,
       (SELECT COALESCE(MAX(sequencia), 0) + 1 FROM fechamento_pacote_snapshots WHERE fechamento_id = $1::uuid),
       $2::uuid, $3, $4, $5, $6,
       $7::uuid, $8, $9,
       $10::uuid, $11::uuid, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29, $30::uuid, $31::uuid
     ) RETURNING id`,
    [
      fechamento.id,
      pacote.id,
      pacote.codigo,
      pacote.nome,
      pacote.descricao,
      pacote.duracaoMinutos,
      tabela.id,
      tabela.codigo,
      tabela.nome,
      preco.id,
      desconto.regraId,
      desconto.regraId ? desconto.codigo : null,
      desconto.regraId ? desconto.titulo : null,
      preco.tipoCalculo,
      preco.convidadosMin,
      preco.convidadosMax,
      preco.categoriaHorario,
      preco.valor,
      fechamento.categoriaHorario,
      fechamento.categoriaPrecoAplicada,
      fechamento.convidados,
      fechamento.convidadosFaturados,
      fechamento.descontoPercentual,
      fechamento.valorPacoteBase,
      fechamento.valorDescontoPacote,
      fechamento.valorPacoteAplicado,
      fechamento.valorAdicionais,
      fechamento.valorTabela,
      null,
      null,
      null,
    ],
  );
  const snapshotId = fotografia.rows[0]?.id;
  if (!snapshotId) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A fotografia do pacote não foi gravada.", 500);
  }

  await gravarComposicao(tx, snapshotId, pacote.id);

  const vigente = await tx.query(
    `UPDATE fechamentos
        SET pacote_snapshot_vigente_id = $1::uuid
      WHERE id = $2::uuid
        AND pacote_snapshot_vigente_id IS NULL`,
    [snapshotId, fechamento.id],
  );
  if (vigente.rowCount !== 1) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "O fechamento já possui fotografia vigente.",
      409,
    );
  }
  return snapshotId;
}

/** Nova fotografia de uma troca explícita. A anterior permanece e só o ponteiro muda. */
export async function gravarCorrecaoFotografiaPacote(
  tx: DbExecutor,
  fechamento: FechamentoRecord,
  resumo: ResumoComercial,
  correcao: { motivo: string; atorUsuarioId: string },
): Promise<string | null> {
  const motivo = correcao.motivo.trim();
  if (motivo.length < 3) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A troca de pacote exige um motivo.", 409);
  }
  const relacao = await tx.query<{ rel: string | null }>(
    `SELECT to_regclass('public.fechamento_pacote_snapshots')::text AS rel`,
  );
  if (!relacao.rows[0]?.rel) return null;

  const vigente = await tx.query<{ pacote_snapshot_vigente_id: string | null }>(
    `SELECT pacote_snapshot_vigente_id
       FROM fechamentos
      WHERE id = $1::uuid
      FOR UPDATE`,
    [fechamento.id],
  );
  const anteriorId = vigente.rows[0]?.pacote_snapshot_vigente_id ?? null;
  const pacote = resumo.pacote.pacote;
  const tabela = resumo.pacote.tabelaPreco;
  const preco = resumo.pacote.precoRegra;
  const desconto = resumo.pacote.desconto;
  const fotografia = await tx.query<{ id: string }>(
    `INSERT INTO fechamento_pacote_snapshots (
       fechamento_id, sequencia, pacote_id, codigo_aplicado, nome_aplicado,
       descricao_aplicada, duracao_minutos_aplicada,
       tabela_preco_id, tabela_codigo_aplicado, tabela_nome_aplicado,
       preco_pacote_id, regra_desconto_pacote_id, codigo_regra_desconto, titulo_regra_desconto,
       tipo_calculo, convidados_min_faixa, convidados_max_faixa, categoria_preco_linha, valor_linha,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
       desconto_percentual, valor_pacote_base, valor_desconto_pacote, valor_pacote_aplicado,
       valor_adicionais, valor_tabela, motivo, ator_usuario_id, snapshot_anterior_id
     ) VALUES (
       $1::uuid,
       (SELECT COALESCE(MAX(sequencia), 0) + 1 FROM fechamento_pacote_snapshots WHERE fechamento_id = $1::uuid),
       $2::uuid, $3, $4, $5, $6,
       $7::uuid, $8, $9,
       $10::uuid, $11::uuid, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29, $30::uuid, $31::uuid
     ) RETURNING id`,
    [
      fechamento.id, pacote.id, pacote.codigo, pacote.nome, pacote.descricao, pacote.duracaoMinutos,
      tabela.id, tabela.codigo, tabela.nome, preco.id, desconto.regraId,
      desconto.regraId ? desconto.codigo : null, desconto.regraId ? desconto.titulo : null,
      preco.tipoCalculo, preco.convidadosMin, preco.convidadosMax, preco.categoriaHorario, preco.valor,
      fechamento.categoriaHorario, fechamento.categoriaPrecoAplicada, fechamento.convidados, fechamento.convidadosFaturados,
      fechamento.descontoPercentual, fechamento.valorPacoteBase, fechamento.valorDescontoPacote, fechamento.valorPacoteAplicado,
      fechamento.valorAdicionais, fechamento.valorTabela, motivo, correcao.atorUsuarioId, anteriorId,
    ],
  );
  const snapshotId = fotografia.rows[0]?.id;
  if (!snapshotId) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A nova fotografia do pacote não foi gravada.", 500);
  }
  await gravarComposicao(tx, snapshotId, pacote.id);
  const ponteiro = await tx.query(
    `UPDATE fechamentos
        SET pacote_snapshot_vigente_id = $1::uuid
      WHERE id = $2::uuid
        AND pacote_snapshot_vigente_id IS NOT DISTINCT FROM $3::uuid`,
    [snapshotId, fechamento.id, anteriorId],
  );
  if (ponteiro.rowCount !== 1) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A fotografia vigente mudou durante a correção.", 409);
  }
  return snapshotId;
}

type EstadoFotografavel = {
  pacote_snapshot_vigente_id: string | null;
  pacote_id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  duracao_minutos: number | null;
  tabela_preco_id: string;
  tabela_codigo: string;
  tabela_nome: string;
  preco_pacote_id: string;
  tipo_calculo: "FIXO" | "POR_CONVIDADO";
  convidados_min: number;
  convidados_max: number | null;
  categoria_preco_linha: string;
  valor_linha: string | number;
  regra_desconto_pacote_id: string | null;
  regra_codigo: string | null;
  regra_titulo: string | null;
  categoria_horario: string;
  categoria_preco_aplicada: string;
  convidados: number;
  convidados_faturados: number;
  desconto_percentual: string | number;
  valor_pacote_base: string | number;
  valor_desconto_pacote: string | number;
  valor_pacote_aplicado: string | number;
  valor_adicionais: string | number;
  valor_tabela: string | number;
};

/**
 * Depois de persistir o fechamento, grava outra fotografia e troca o ponteiro.
 * A anterior permanece. Sem a tabela 029, não há ponteiro para atualizar.
 */
export async function fotografarEstadoFechamento(
  tx: DbExecutor,
  fechamentoId: string,
  contexto: { motivo: string; atorUsuarioId: string | null },
): Promise<{ id: string; empresaId: string | null } | null> {
  const motivo = contexto.motivo.trim();
  if (motivo.length < 3) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A troca de pacote exige um motivo.", 409);
  }
  const relacao = await tx.query<{ rel: string | null }>(
    `SELECT to_regclass('public.fechamento_pacote_snapshots')::text AS rel`,
  );
  if (!relacao.rows[0]?.rel) return null;

  const estado = await tx.query<EstadoFotografavel>(
    `SELECT f.pacote_snapshot_vigente_id,
            f.pacote_id, p.codigo, p.nome, p.descricao, p.duracao_minutos,
            f.tabela_preco_id, t.codigo AS tabela_codigo, t.nome AS tabela_nome,
            f.preco_pacote_id, pp.tipo_calculo, pp.convidados_min, pp.convidados_max,
            pp.categoria_horario AS categoria_preco_linha, pp.valor AS valor_linha,
            f.regra_desconto_pacote_id, r.codigo AS regra_codigo, r.titulo AS regra_titulo,
            f.categoria_horario, f.categoria_preco_aplicada, f.convidados, f.convidados_faturados,
            f.desconto_percentual, f.valor_pacote_base, f.valor_desconto_pacote, f.valor_pacote_aplicado,
            f.valor_adicionais, f.valor_tabela
       FROM fechamentos f
       JOIN pacotes p ON p.id = f.pacote_id
       JOIN tabelas_preco t ON t.id = f.tabela_preco_id
       JOIN precos_pacote pp ON pp.id = f.preco_pacote_id
       LEFT JOIN regras_desconto_pacote r ON r.id = f.regra_desconto_pacote_id
      WHERE f.id = $1::uuid
      FOR UPDATE OF f`,
    [fechamentoId],
  );
  const atual = estado.rows[0];
  if (!atual) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "O fechamento não tem pacote e preço aplicáveis para fotografar.", 409);
  }
  const colunaEmpresa = await tx.query(
    `SELECT 1 AS ok
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'`,
  );
  let empresaId: string | null = null;
  if (colunaEmpresa.rows[0]) {
    const empresa = await tx.query<{ empresa_id: string | null }>(
      `SELECT empresa_id::text AS empresa_id FROM pacotes WHERE id = $1::uuid`,
      [atual.pacote_id],
    );
    empresaId = empresa.rows[0]?.empresa_id ?? null;
  }
  const anteriorId = atual.pacote_snapshot_vigente_id;
  const fotografia = await tx.query<{ id: string }>(
    `INSERT INTO fechamento_pacote_snapshots (
       fechamento_id, sequencia, pacote_id, codigo_aplicado, nome_aplicado,
       descricao_aplicada, duracao_minutos_aplicada,
       tabela_preco_id, tabela_codigo_aplicado, tabela_nome_aplicado,
       preco_pacote_id, regra_desconto_pacote_id, codigo_regra_desconto, titulo_regra_desconto,
       tipo_calculo, convidados_min_faixa, convidados_max_faixa, categoria_preco_linha, valor_linha,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
       desconto_percentual, valor_pacote_base, valor_desconto_pacote, valor_pacote_aplicado,
       valor_adicionais, valor_tabela, motivo, ator_usuario_id, snapshot_anterior_id
     ) VALUES (
       $1::uuid,
       (SELECT COALESCE(MAX(sequencia), 0) + 1 FROM fechamento_pacote_snapshots WHERE fechamento_id = $1::uuid),
       $2::uuid, $3, $4, $5, $6,
       $7::uuid, $8, $9,
       $10::uuid, $11::uuid, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29, $30::uuid, $31::uuid
     ) RETURNING id`,
    [
      fechamentoId, atual.pacote_id, atual.codigo, atual.nome, atual.descricao, atual.duracao_minutos,
      atual.tabela_preco_id, atual.tabela_codigo, atual.tabela_nome, atual.preco_pacote_id, atual.regra_desconto_pacote_id,
      atual.regra_desconto_pacote_id ? atual.regra_codigo : null, atual.regra_desconto_pacote_id ? atual.regra_titulo : null,
      atual.tipo_calculo, atual.convidados_min, atual.convidados_max, atual.categoria_preco_linha, atual.valor_linha,
      atual.categoria_horario, atual.categoria_preco_aplicada, atual.convidados, atual.convidados_faturados,
      atual.desconto_percentual, atual.valor_pacote_base, atual.valor_desconto_pacote, atual.valor_pacote_aplicado,
      atual.valor_adicionais, atual.valor_tabela, motivo, contexto.atorUsuarioId, anteriorId,
    ],
  );
  const snapshotId = fotografia.rows[0]?.id;
  if (!snapshotId) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A nova fotografia do pacote não foi gravada.", 500);
  }
  await gravarComposicao(tx, snapshotId, atual.pacote_id);
  const ponteiro = await tx.query(
    `UPDATE fechamentos
        SET pacote_snapshot_vigente_id = $1::uuid
      WHERE id = $2::uuid
        AND pacote_snapshot_vigente_id IS NOT DISTINCT FROM $3::uuid`,
    [snapshotId, fechamentoId, anteriorId],
  );
  if (ponteiro.rowCount !== 1) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A fotografia vigente mudou durante a correção.", 409);
  }
  return { id: snapshotId, empresaId };
}
