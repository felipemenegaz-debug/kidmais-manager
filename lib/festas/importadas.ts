import type { DbExecutor } from '../db/contracts.ts';
import type { SnapshotHistorico } from '../importacao-contrato/plano.ts';

/** Projeção de consulta do contrato confirmado. Não cria assinatura, pagamento ou Festa operacional. */
type Linha = { id: string; cliente_id: string; cliente: string; evento: SnapshotHistorico['evento']; pacote: SnapshotHistorico['pacote']; buffet: SnapshotHistorico['buffet']; observacoes: string | null };
export type FestaImportada = {
  id: string; origem: 'IMPORTACAO'; clienteId: string;
  snapshot: {
    contratante: { nomeCompleto: string };
    aniversariante: { nome: string; idadeNoEvento: number | null };
    evento: { data: string; horarioInicio: string; horarioFim: string; convidados: number | null; tema: string | null; pacote: { nome: string } };
  };
  itens: string | null; buffet: SnapshotHistorico['buffet']; observacoes: string | null;
};

export async function listarFestasImportadas(tx: DbExecutor, empresaId: string, clienteId?: string, importacaoId?: string): Promise<FestaImportada[]> {
  const disponivel = await tx.query<{ ok: boolean; integracao?: boolean }>("SELECT to_regclass('public.ia_importacoes') IS NOT NULL AS ok, to_regclass('public.contrato_importacoes') IS NOT NULL AS integracao");
  if (!disponivel.rows[0]?.ok) return [];
  // Integrada (061): a festa já existe no Core e aparece pelas listas nativas; a projeção não a repete.
  const naoIntegrada = disponivel.rows[0]?.integracao === true
    ? ' AND NOT EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.importacao_id = i.id AND ci.empresa_id = i.empresa_id)' : '';
  // Só o snapshot CONFIRMADO; rascunhos e descartes nunca entram na programação.
  // Seleção limitada: não expõe extração, evidências, contatos ou valores financeiros.
  const r = await tx.query<Linha>(`SELECT i.id::text, i.cliente_id::text, c.nome_completo AS cliente,
      i.resultado->'contratoHistorico'->'evento' AS evento,
      i.resultado->'contratoHistorico'->'pacote' AS pacote,
      i.resultado->'contratoHistorico'->'buffet' AS buffet,
      i.resultado->'contratoHistorico'->>'observacoes' AS observacoes
    FROM ia_importacoes i JOIN clientes c ON c.id = i.cliente_id AND c.empresa_id = i.empresa_id
    WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA'
      AND ($2::uuid IS NULL OR i.cliente_id = $2::uuid)
      AND ($3::uuid IS NULL OR i.id = $3::uuid)${naoIntegrada}
    ORDER BY i.resultado->'contratoHistorico'->'evento'->>'data', i.id`, [empresaId, clienteId ?? null, importacaoId ?? null]);
  return r.rows.filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l.evento?.data ?? '')).map(l => ({
    id: l.id, origem: 'IMPORTACAO', clienteId: l.cliente_id,
    snapshot: {
      contratante: { nomeCompleto: l.cliente },
      aniversariante: { nome: l.evento.aniversariante ?? 'Aniversariante não informado', idadeNoEvento: l.evento.idade },
      evento: { data: l.evento.data!, horarioInicio: l.evento.horario?.inicio ?? '', horarioFim: l.evento.horario?.fim ?? '', convidados: l.evento.convidados, tema: l.evento.tema, pacote: { nome: l.pacote?.nome ?? 'Pacote não informado' } },
    },
    itens: l.pacote?.itens ?? null, buffet: l.buffet, observacoes: l.observacoes,
  }));
}
