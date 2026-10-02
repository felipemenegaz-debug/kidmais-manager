import type { DbExecutor } from '../db/contracts.ts';
import type { SnapshotHistorico } from '../importacao-contrato/plano.ts';

/**
 * Contrato importado (etapa 1, somente leitura). Projeção da importação CONFIRMADA (`ia_importacoes.status = 'IMPORTADA'`)
 * como registro de Contratos: snapshot como está no documento, cliente vinculado, documento original e pagamentos
 * previstos. Nada aqui cria contrato, fechamento, festa, reserva de agenda, cobrança ou pagamento no Core.
 *
 * Toda consulta filtra a empresa comprovada no próprio SQL; outra empresa ou inexistente responde como ausente.
 * O original só sai pela rota protegida, para os papéis que podem importar (`PAPEIS_ORIGINAL_IMPORTADO`).
 */
export const PAPEIS_ORIGINAL_IMPORTADO = ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'] as const;

/** PASSADO: data anterior a hoje (Histórico). FUTURO: hoje ou depois (evento importado, ainda não integrado à agenda). */
export type SituacaoEventoImportado = 'PASSADO' | 'FUTURO' | 'SEM_DATA';

export type ContratoImportadoResumo = {
  id: string;
  origem: 'IMPORTACAO';
  status: 'IMPORTADO';
  nome: string | null;
  data_evento: string | null;
  pacote: string | null;
  convidados: number | null;
  clienteId: string;
  situacaoEvento: SituacaoEventoImportado;
  importadoEm: string | null;
};

export type DocumentoImportado = { id: string; nome: string; contentType: string; tamanhoBytes: number };

export type ContratoImportadoDetalhe = {
  id: string;
  origem: 'IMPORTACAO';
  status: 'IMPORTADO';
  situacaoEvento: SituacaoEventoImportado;
  importadoEm: string | null;
  importadoPor: string | null;
  cliente: { id: string; nome: string };
  documento: DocumentoImportado | null;
  contrato: SnapshotHistorico;
  pendencias: string[];
  podeVerOriginal: boolean;
};

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function situacaoEvento(data: string | null | undefined, hoje: string): SituacaoEventoImportado {
  if (!data || !DATA_ISO.test(data)) return 'SEM_DATA';
  return data < hoje ? 'PASSADO' : 'FUTURO';
}

export function podeVerOriginal(papel: string | null | undefined) {
  return (PAPEIS_ORIGINAL_IMPORTADO as readonly string[]).includes(papel ?? '');
}

async function disponivel(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    "SELECT to_regclass('public.ia_importacoes') IS NOT NULL AND to_regclass('public.ia_documento_originais') IS NOT NULL AS ok",
  );
  return r.rows[0]?.ok === true;
}

type LinhaResumo = { id: string; cliente_id: string; nome: string | null; data_evento: string | null; pacote: string | null; convidados: number | string | null; importado_em: string | null };

const inteiro = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) ? n : null; };

/** Lista de contratos importados da empresa comprovada (opcionalmente de um cliente), mais recentes primeiro. */
export async function listarContratosImportados(tx: DbExecutor, empresaId: string, hoje: string, clienteId?: string): Promise<ContratoImportadoResumo[]> {
  if (!await disponivel(tx)) return [];
  // Seleção limitada: nem extração, nem CPF, nem contatos, nem evidências.
  const r = await tx.query<LinhaResumo>(
    `SELECT i.id::text, i.cliente_id::text AS cliente_id, c.nome_completo AS nome,
            i.resultado->'contratoHistorico'->'evento'->>'data' AS data_evento,
            i.resultado->'contratoHistorico'->'pacote'->>'nome' AS pacote,
            i.resultado->'contratoHistorico'->'evento'->>'convidados' AS convidados,
            i.resultado->>'importadoEm' AS importado_em
       FROM ia_importacoes i JOIN clientes c ON c.id = i.cliente_id AND c.empresa_id = i.empresa_id
      WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA' AND ($2::uuid IS NULL OR i.cliente_id = $2::uuid)
      ORDER BY i.resultado->'contratoHistorico'->'evento'->>'data' DESC NULLS LAST, i.atualizado_em DESC, i.id`,
    [empresaId, clienteId ?? null],
  );
  return r.rows.map((l) => ({
    id: l.id, origem: 'IMPORTACAO', status: 'IMPORTADO', nome: l.nome, data_evento: l.data_evento, pacote: l.pacote,
    convidados: inteiro(l.convidados), clienteId: l.cliente_id, situacaoEvento: situacaoEvento(l.data_evento, hoje), importadoEm: l.importado_em,
  }));
}

/** Eventos importados com data de hoje em diante: aguardam integração; nunca contam como festa operacional. */
export async function contarEventosImportadosAIntegrar(tx: DbExecutor, empresaId: string, hoje: string): Promise<number> {
  if (!await disponivel(tx)) return 0;
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ia_importacoes i
      WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA'
        AND (i.resultado->'contratoHistorico'->'evento'->>'data') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (i.resultado->'contratoHistorico'->'evento'->>'data') >= $2`,
    [empresaId, hoje],
  );
  return Number(r.rows[0]?.n ?? 0);
}

type LinhaDetalhe = {
  id: string; cliente_id: string; nome: string | null; contrato: SnapshotHistorico | null; pendencias: unknown; importado_em: string | null; importado_por: string | null;
  documento_id: string | null; documento_nome: string | null; documento_tipo: string | null; documento_tamanho: number | string | null;
};

/** Detalhe do contrato importado no tenant comprovado; outra empresa ou inexistente ⇒ null. */
export async function detalheContratoImportado(tx: DbExecutor, empresaId: string, hoje: string, importacaoId: string, papel: string | null | undefined): Promise<ContratoImportadoDetalhe | null> {
  if (!await disponivel(tx)) return null;
  const r = await tx.query<LinhaDetalhe>(
    `SELECT i.id::text, i.cliente_id::text AS cliente_id, c.nome_completo AS nome,
            i.resultado->'contratoHistorico' AS contrato, i.resultado->'pendencias' AS pendencias,
            i.resultado->>'importadoEm' AS importado_em, u.nome AS importado_por,
            o.id::text AS documento_id, o.nome_original AS documento_nome, o.content_type AS documento_tipo, o.tamanho_bytes AS documento_tamanho
       FROM ia_importacoes i
       JOIN clientes c ON c.id = i.cliente_id AND c.empresa_id = i.empresa_id
       LEFT JOIN usuarios_administrativos u ON u.id::text = i.resultado->>'importadoPor'
       LEFT JOIN LATERAL (SELECT d.id, d.nome_original, d.content_type, d.tamanho_bytes FROM ia_documento_originais d
                           WHERE d.documento_id = i.documento_id AND d.empresa_id = i.empresa_id ORDER BY d.versao DESC LIMIT 1) o ON true
      WHERE i.id = $1::uuid AND i.empresa_id = $2::uuid AND i.status = 'IMPORTADA'`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  if (!l || !l.contrato || typeof l.contrato !== 'object') return null;
  const pendencias = Array.isArray(l.pendencias) ? l.pendencias.filter((p): p is string => typeof p === 'string') : [];
  return {
    id: l.id, origem: 'IMPORTACAO', status: 'IMPORTADO',
    situacaoEvento: situacaoEvento(l.contrato.evento?.data, hoje),
    importadoEm: l.importado_em, importadoPor: l.importado_por,
    cliente: { id: l.cliente_id, nome: l.nome ?? 'Cliente' },
    documento: l.documento_id ? { id: l.documento_id, nome: l.documento_nome ?? 'documento', contentType: l.documento_tipo ?? 'application/octet-stream', tamanhoBytes: Number(l.documento_tamanho ?? 0) } : null,
    contrato: l.contrato,
    pendencias,
    podeVerOriginal: podeVerOriginal(papel),
  };
}

export type OriginalImportado = { conteudo: Buffer; contentType: string; nome: string };

/** Bytes do original da importação confirmada, no tenant comprovado. A autorização por papel é da rota. */
export async function originalDoContratoImportado(tx: DbExecutor, empresaId: string, importacaoId: string): Promise<OriginalImportado | null> {
  if (!await disponivel(tx)) return null;
  const r = await tx.query<{ conteudo: Buffer; content_type: string; nome_original: string }>(
    `SELECT o.conteudo, o.content_type, o.nome_original
       FROM ia_importacoes i JOIN ia_documento_originais o ON o.documento_id = i.documento_id AND o.empresa_id = i.empresa_id
      WHERE i.id = $1::uuid AND i.empresa_id = $2::uuid AND i.status = 'IMPORTADA'
      ORDER BY o.versao DESC LIMIT 1`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  return l ? { conteudo: l.conteudo, contentType: l.content_type, nome: l.nome_original } : null;
}
