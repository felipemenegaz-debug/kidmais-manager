import type { DbExecutor } from "../db/contracts.ts";
import { AgendaConfiguracaoError, escoposDaEmpresa } from "./configuracao-unidade.ts";
import { combinadosInstalados } from "./salao-festa.ts";
import { conjuntosDosSaloes, salaoElegivel, saloesCruzam, type SalaoDoEscopo } from "./saloes-conjuntos.ts";

/**
 * 098 (fase 1 dos salões): ocupação do dia por salão na agenda. Cada salão ativo (simples ou combinado) mostra as
 * ocupações que o impedem pela MESMA regra do banco (kidmais098_saloes_cruzam): o combinado A+B ocupado marca A e B;
 * A ocupado marca A e o combinado; festa sem salão definido marca todos. Origem e destino de hold são ocupações
 * separadas, como em kidmais094_ocupacoes. Leitura do tenant comprovado, sem dados do cliente.
 */
export type OcupacaoNoSalao = { inicio: string; fim: string; reservadoEm: string | null; remarcacao: boolean };
/**
 * elegivel: pode receber festa nova (mesma regra de kidmais098_salao_elegivel). Combinado ativo com membro desativado
 * aparece como indisponível (membrosInativos), nunca como livre (P3-3 da revisão do Astra).
 */
export type SalaoNoDia = {
  id: string; nome: string; combinado: boolean; membros: string[]; ocupacoes: OcupacaoNoSalao[];
  elegivel: boolean; membrosInativos: string[];
};

type Linha = SalaoDoEscopo & { nome: string; ordem: number };

const hora = (texto: string) => texto.slice(0, 5);

export async function saloesDoDia(db: DbExecutor, empresaId: string, estabelecimentoId: string | null, data: string): Promise<SalaoNoDia[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new AgendaConfiguracaoError("DADOS_INVALIDOS", "Informe a data.", 400);
  const escopos = await escoposDaEmpresa(db, empresaId);
  if (!escopos.some((e) => e.estabelecimentoId === estabelecimentoId)) return [];
  const capacidade = await db.query<{ ok: boolean }>(
    `SELECT to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NOT NULL AS ok`,
  );
  if (!capacidade.rows[0]?.ok) return [];
  const v098 = await combinadosInstalados(db);
  const saloes = await db.query<Linha>(
    v098
      ? `SELECT id::text AS id, nome, ordem, ativo, combinado, membros::text[] AS membros FROM agenda_saloes
          WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid ORDER BY combinado, ordem, nome`
      : `SELECT id::text AS id, nome, ordem, ativo, false AS combinado, NULL::text[] AS membros FROM agenda_saloes
          WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid ORDER BY ordem, nome`,
    [empresaId, estabelecimentoId],
  );
  if (saloes.rows.length === 0) return [];
  const ocupacoes = await db.query<{ salao_id: string | null; inicio: string; fim: string; origem: string }>(
    `SELECT o.salao_id::text AS salao_id, o.horario_inicio::text AS inicio, o.horario_fim::text AS fim, o.origem
       FROM kidmais094_ocupacoes($3::date, $3::date) o
      WHERE kidmais062_mesmo_recurso($1::uuid, $2::uuid, o.empresa_id, o.estabelecimento_id)
      ORDER BY o.horario_inicio, o.horario_fim`,
    [empresaId, estabelecimentoId, data],
  );
  const conjuntos = conjuntosDosSaloes(saloes.rows);
  const nomes = new Map(saloes.rows.map((s) => [s.id, s.nome]));
  const porId = new Map(saloes.rows.map((s) => [s.id, s]));
  return saloes.rows.filter((s) => s.ativo).map((s) => ({
    id: s.id,
    nome: s.nome,
    combinado: s.combinado,
    membros: (s.membros ?? []).map((m) => nomes.get(m) ?? "Salão"),
    elegivel: salaoElegivel(s, saloes.rows),
    membrosInativos: (s.membros ?? []).filter((m) => porId.get(m)?.ativo !== true).map((m) => nomes.get(m) ?? "Salão"),
    ocupacoes: ocupacoes.rows
      .filter((o) => saloesCruzam(o.salao_id, s.id, conjuntos))
      .map((o) => ({ inicio: hora(o.inicio), fim: hora(o.fim), reservadoEm: o.salao_id ? nomes.get(o.salao_id) ?? "Salão" : null, remarcacao: o.origem === "REVISAO_DESTINO" })),
  }));
}
