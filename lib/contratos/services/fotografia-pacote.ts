import type { PacoteAplicadoContrato } from "../repositories";
import type { DbExecutor } from "../../db/contracts";

type FotografiaRow = {
  id: string;
  pacote_id: string;
  codigo_aplicado: string;
  nome_aplicado: string;
  descricao_aplicada: string | null;
  duracao_minutos_aplicada: number | null;
  tabela_preco_id: string;
  tabela_codigo_aplicado: string;
  tabela_nome_aplicado: string;
};

type ComposicaoRow = {
  tipo: "INCLUSO" | "BUFFET";
  codigo_aplicado: string;
  nome_aplicado: string;
  modo_itens: "TODOS_ATIVOS" | "SELECIONADOS" | null;
  escolhas_min: number | null;
  escolhas_max: number | null;
};

/** Lê a fotografia vigente. Sem a migration 029, o contrato continua no schema 1. */
export async function lerFotografiaPacoteVigente(
  tx: DbExecutor,
  fechamentoId: string,
): Promise<PacoteAplicadoContrato | null> {
  const relacao = await tx.query<{ rel: string | null }>(
    `SELECT to_regclass('public.fechamento_pacote_snapshots')::text AS rel`,
  );
  if (!relacao.rows[0]?.rel) return null;

  const fotografia = await tx.query<FotografiaRow>(
    `SELECT s.id, s.pacote_id, s.codigo_aplicado, s.nome_aplicado, s.descricao_aplicada,
            s.duracao_minutos_aplicada, s.tabela_preco_id, s.tabela_codigo_aplicado, s.tabela_nome_aplicado
       FROM fechamentos f
       JOIN fechamento_pacote_snapshots s
         ON s.id = f.pacote_snapshot_vigente_id
        AND s.fechamento_id = f.id
      WHERE f.id = $1::uuid`,
    [fechamentoId],
  );
  const row = fotografia.rows[0];
  if (!row) return null;

  const composicao = await tx.query<ComposicaoRow>(
    `SELECT tipo, codigo_aplicado, nome_aplicado, modo_itens, escolhas_min, escolhas_max
       FROM fechamento_pacote_composicao
      WHERE snapshot_id = $1::uuid
      ORDER BY tipo, codigo_aplicado`,
    [row.id],
  );

  return {
    snapshotId: row.id,
    pacoteId: row.pacote_id,
    codigo: row.codigo_aplicado,
    nome: row.nome_aplicado,
    descricao: row.descricao_aplicada,
    duracaoMinutos: row.duracao_minutos_aplicada === null ? null : Number(row.duracao_minutos_aplicada),
    tabelaPreco: {
      id: row.tabela_preco_id,
      codigo: row.tabela_codigo_aplicado,
      nome: row.tabela_nome_aplicado,
    },
    composicao: composicao.rows.map((item) => ({
      tipo: item.tipo,
      codigo: item.codigo_aplicado,
      nome: item.nome_aplicado,
      modoItens: item.modo_itens,
      escolhasMin: item.escolhas_min === null ? null : Number(item.escolhas_min),
      escolhasMax: item.escolhas_max === null ? null : Number(item.escolhas_max),
    })),
  };
}
