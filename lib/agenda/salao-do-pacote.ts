import type { DbExecutor } from "../db/contracts.ts";

/**
 * Salão (alias s) de unidade cuja agenda é por salão: só esses aparecem e são exigidos no pacote (decisão de Felipe,
 * 25/10/2026). Módulo à parte, sem dependências comerciais, para os serviços de pacote conferirem sem ciclo de import.
 */
export const SALAO_DE_AGENDA_POR_SALAO = `EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = s.empresa_id
  AND c.estabelecimento_id IS NOT DISTINCT FROM s.estabelecimento_id AND c.capacidade_tipo = 'POR_SALAO')`;

/**
 * Verdadeiro quando a empresa tem agenda por salão (salão ativo de unidade por salão) e o pacote não tem nenhum salão.
 * Pareceres do Astra (25/10/2026, P2): o pacote não pode ficar "em todos os salões" por nenhum caminho de escrita
 * (editar, revisar, ativar, duplicar — tela, IA ou importação). Vínculo com salão desativado depois continua contando.
 */
export async function pacoteSemSalaoNaAgendaPorSalao(tx: DbExecutor, empresaId: string, pacoteId: string) {
  const instalada = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.pacote_saloes') IS NOT NULL AS ok`);
  if (!instalada.rows[0]?.ok) return false;
  const r = await tx.query<{ por_salao: boolean; tem: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_saloes s WHERE s.empresa_id = $1::uuid AND s.ativo AND ${SALAO_DE_AGENDA_POR_SALAO}) AS por_salao,
            EXISTS (SELECT 1 FROM pacote_saloes WHERE pacote_id = $2::uuid) AS tem`,
    [empresaId, pacoteId],
  );
  return Boolean(r.rows[0]?.por_salao && !r.rows[0]?.tem);
}
