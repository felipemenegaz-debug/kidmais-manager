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
       valor_adicionais, valor_tabela
     ) VALUES (
       $1::uuid,
       (SELECT COALESCE(MAX(sequencia), 0) + 1 FROM fechamento_pacote_snapshots WHERE fechamento_id = $1::uuid),
       $2::uuid, $3, $4, $5, $6,
       $7::uuid, $8, $9,
       $10::uuid, $11::uuid, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28
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
    ],
  );
  const snapshotId = fotografia.rows[0]?.id;
  if (!snapshotId) {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A fotografia do pacote não foi gravada.", 500);
  }

  const inclusos = await tx.query<InclusoRow>(
    `SELECT a.id, a.codigo, a.nome
       FROM pacote_adicionais pa
       JOIN adicionais a ON a.id = pa.adicional_id
      WHERE pa.pacote_id = $1::uuid
        AND pa.ativo
        AND pa.modalidade = 'INCLUSO'
        AND a.ativo
      ORDER BY a.ordem_exibicao, a.codigo`,
    [pacote.id],
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
    [pacote.id],
  );
  for (const categoria of buffet.rows) {
    await tx.query(
      `INSERT INTO fechamento_pacote_composicao (
         snapshot_id, tipo, categoria_id, codigo_aplicado, nome_aplicado,
         modo_itens, escolhas_min, escolhas_max
       ) VALUES ($1::uuid, 'BUFFET', $2::uuid, $3, $4, $5, $6, $7)`,
      [
        snapshotId,
        categoria.id,
        categoria.codigo,
        categoria.nome,
        categoria.modo_itens,
        categoria.escolhas_min,
        categoria.escolhas_max,
      ],
    );
  }

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
