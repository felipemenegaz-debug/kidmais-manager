import { caminhoFinanceiro } from './integracao-importados/repositorio.ts';
import type { DbExecutor } from '../db/contracts.ts';
import type { SnapshotHistorico } from '../importacao-contrato/plano.ts';

/**
 * Contrato importado (etapa 1, somente leitura). Projeção da importação CONFIRMADA (`ia_importacoes.status = 'IMPORTADA'`)
 * como registro de Contratos: snapshot como está no documento, cliente vinculado, documento original e pagamentos
 * previstos. Nada aqui cria contrato, fechamento, festa, reserva de agenda, cobrança ou pagamento no Core.
 * A integração ao Core é do serviço `integracao-importados` (061); integrada, a importação sai desta projeção.
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
  /** 061 instalada e papel autorizado: o detalhe oferece "Integrar ao sistema" (sem reenviar o arquivo). */
  podeIntegrar: boolean;
};

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function situacaoEvento(data: string | null | undefined, hoje: string): SituacaoEventoImportado {
  if (!data || !DATA_ISO.test(data)) return 'SEM_DATA';
  return data < hoje ? 'PASSADO' : 'FUTURO';
}

export function podeVerOriginal(papel: string | null | undefined) {
  return (PAPEIS_ORIGINAL_IMPORTADO as readonly string[]).includes(papel ?? '');
}

async function disponibilidade(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean; integracao?: boolean }>(
    "SELECT to_regclass('public.ia_importacoes') IS NOT NULL AND to_regclass('public.ia_documento_originais') IS NOT NULL AS ok, to_regclass('public.contrato_importacoes') IS NOT NULL AS integracao",
  );
  return { ok: r.rows[0]?.ok === true, integracao: r.rows[0]?.integracao === true };
}
async function disponivel(tx: DbExecutor) {
  return (await disponibilidade(tx)).ok;
}

/**
 * Depois da integração (061), o contrato existe no Core: a projeção deixa de listar a importação (sem duplicidade em
 * Contratos, Festas, cliente e indicadores) e os links antigos levam ao contrato integrado.
 */
const naoIntegrada = (integracao: boolean) => integracao
  ? ' AND NOT EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.importacao_id = i.id AND ci.empresa_id = i.empresa_id)'
  : '';

/** Contrato do Core criado pela integração desta importação (tenant comprovado); sem 061 ou não integrada ⇒ null. */
export async function contratoIntegradoDaImportacao(tx: DbExecutor, empresaId: string, importacaoId: string): Promise<string | null> {
  if (!(await disponibilidade(tx)).integracao) return null;
  const r = await tx.query<{ contrato_id: string }>(
    'SELECT contrato_id::text FROM contrato_importacoes WHERE importacao_id = $1::uuid AND empresa_id = $2::uuid',
    [importacaoId, empresaId],
  );
  return r.rows[0]?.contrato_id ?? null;
}

export type OrigemHistoricaContrato = {
  importacaoId: string;
  conferidoEm: string;
  conferidoPor: string | null;
  conferidoPapel: string;
  declaracao: string;
  unidade: string | null;
  documento: DocumentoImportado | null;
  podeVerOriginal: boolean;
  financeiroPendente: boolean;
  /**
   * Caminho OFICIAL para os pagamentos do contrato histórico: CONFERIR_HISTORICO ("Conferir pagamentos" da integração,
   * enquanto a versão conferida é a vigente); PLANO_NA_VERSAO_VIGENTE (depois de revisão: "Criar plano financeiro"
   * nativo + "Registrar recebimento" com a data real); AGUARDAR_REVISAO (revisão aberta); CONCLUIDO.
   */
  caminhoFinanceiro: 'CONFERIR_HISTORICO' | 'PLANO_NA_VERSAO_VIGENTE' | 'AGUARDAR_REVISAO' | 'CONCLUIDO';
  financeiro: { situacao: string; recebidoCentavos: number; saldoCentavos: number } | null;
  /** Campos que diferem do documento (correção de leitura) ou que não constavam nele (complemento). */
  campos: Array<{ campo: string; rotulo: string; documento: string | null; efetivo: string; origem: string; motivo: string | null }>;
  contratoHistorico: SnapshotHistorico | null;
};

/** Origem histórica de um contrato do Core (já provado no tenant pela rota). Contrato nativo ⇒ null. */
export async function origemHistoricaDoContrato(tx: DbExecutor, empresaId: string, contratoId: string, papel: string | null | undefined): Promise<OrigemHistoricaContrato | null> {
  if (!(await disponibilidade(tx)).integracao) return null;
  const r = await tx.query<{
    importacao_id: string; versao_conferida_id: string; vigente_conferida: boolean; revisao_aberta: boolean; com_pagamento: boolean; conferido_em: string; conferido_por: string | null; conferido_papel: string; declaracao: string; unidade: string | null;
    campos: unknown; contrato_historico: SnapshotHistorico | null; fin_situacao: string | null; fin_recebido: string | null; fin_saldo: string | null;
    documento_id: string | null; documento_nome: string | null; documento_tipo: string | null; documento_tamanho: number | string | null;
  }>(
    `SELECT ci.importacao_id::text, ci.contrato_versao_id::text AS versao_conferida_id,
            coalesce((SELECT cf.versao_vigente_id = ci.contrato_versao_id FROM contrato_fluxos cf WHERE cf.contrato_id = ci.contrato_id), false) AS vigente_conferida,
            EXISTS(SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_id = ci.contrato_id AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')) AS revisao_aberta,
            EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes pv ON pv.id = p.contrato_versao_id WHERE pv.contrato_id = ci.contrato_id) AS com_pagamento,
            ci.conferido_em::text, u.nome AS conferido_por, ci.conferido_papel, ci.declaracao, e.nome AS unidade,
            ci.decisoes->'resumo'->'campos' AS campos, i.resultado->'contratoHistorico' AS contrato_historico,
            f.situacao AS fin_situacao, f.recebido_centavos::text AS fin_recebido, f.saldo_centavos::text AS fin_saldo,
            o.id::text AS documento_id, o.nome_original AS documento_nome, o.content_type AS documento_tipo, o.tamanho_bytes AS documento_tamanho
       FROM contrato_importacoes ci
       JOIN ia_importacoes i ON i.id = ci.importacao_id AND i.empresa_id = ci.empresa_id
       JOIN ia_documento_originais o ON o.id = ci.documento_original_id AND o.empresa_id = ci.empresa_id
       LEFT JOIN usuarios_administrativos u ON u.id = ci.conferido_por
       LEFT JOIN estabelecimentos e ON e.id = ci.estabelecimento_id AND e.empresa_id = ci.empresa_id
       LEFT JOIN contrato_importacao_financeiro f ON f.contrato_importacao_id = ci.id
      WHERE ci.contrato_id = $1::uuid AND ci.empresa_id = $2::uuid`,
    [contratoId, empresaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  const campos = Array.isArray(l.campos) ? (l.campos as OrigemHistoricaContrato['campos']).filter((c) => c && typeof c === 'object' && c.origem !== 'DOCUMENTO') : [];
  return {
    importacaoId: l.importacao_id, conferidoEm: l.conferido_em, conferidoPor: l.conferido_por, conferidoPapel: l.conferido_papel, declaracao: l.declaracao, unidade: l.unidade,
    documento: l.documento_id ? { id: l.documento_id, nome: l.documento_nome ?? 'documento', contentType: l.documento_tipo ?? 'application/octet-stream', tamanhoBytes: Number(l.documento_tamanho ?? 0) } : null,
    podeVerOriginal: podeVerOriginal(papel),
    financeiroPendente: l.fin_situacao === null && !l.com_pagamento,
    // Caminho do financeiro pendente: conferência da v1 enquanto ela é a vigente; depois de revisão, o plano nativo.
    caminhoFinanceiro: caminhoFinanceiro({ conferido: l.fin_situacao !== null, comPagamento: l.com_pagamento, revisaoAberta: l.revisao_aberta, vigenteConferida: l.vigente_conferida }),
    financeiro: l.fin_situacao ? { situacao: l.fin_situacao, recebidoCentavos: Number(l.fin_recebido ?? 0), saldoCentavos: Number(l.fin_saldo ?? 0) } : null,
    campos,
    contratoHistorico: l.contrato_historico && typeof l.contrato_historico === 'object' ? l.contrato_historico : null,
  };
}

type LinhaResumo = { id: string; cliente_id: string; nome: string | null; data_evento: string | null; pacote: string | null; convidados: number | string | null; importado_em: string | null };

const inteiro = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) ? n : null; };

/** Lista de contratos importados da empresa comprovada (opcionalmente de um cliente), mais recentes primeiro. */
export async function listarContratosImportados(tx: DbExecutor, empresaId: string, hoje: string, clienteId?: string): Promise<ContratoImportadoResumo[]> {
  const d = await disponibilidade(tx);
  if (!d.ok) return [];
  // Seleção limitada: nem extração, nem CPF, nem contatos, nem evidências.
  const r = await tx.query<LinhaResumo>(
    `SELECT i.id::text, i.cliente_id::text AS cliente_id, c.nome_completo AS nome,
            i.resultado->'contratoHistorico'->'evento'->>'data' AS data_evento,
            i.resultado->'contratoHistorico'->'pacote'->>'nome' AS pacote,
            i.resultado->'contratoHistorico'->'evento'->>'convidados' AS convidados,
            i.resultado->>'importadoEm' AS importado_em
       FROM ia_importacoes i JOIN clientes c ON c.id = i.cliente_id AND c.empresa_id = i.empresa_id
      WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA' AND ($2::uuid IS NULL OR i.cliente_id = $2::uuid)${naoIntegrada(d.integracao)}
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
  const d = await disponibilidade(tx);
  if (!d.ok) return 0;
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ia_importacoes i
      WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA'
        AND (i.resultado->'contratoHistorico'->'evento'->>'data') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (i.resultado->'contratoHistorico'->'evento'->>'data') >= $2${naoIntegrada(d.integracao)}`,
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
  const d = await disponibilidade(tx);
  if (!d.ok) return null;
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
    podeIntegrar: d.integracao && podeVerOriginal(papel),
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
