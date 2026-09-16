import type { DbExecutor } from '../db/contracts';

export const estadosEmContratacao = ['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'AGUARDANDO_CONTRATO', 'CONTRATO_ASSINADO', 'AGUARDANDO_PAGAMENTO', 'CONFIRMADO'];
export type ContratacaoRow = {
    id: string; clienteId: string | null; cliente: string; clienteStatus: string | null; data: string; inicio: string; fim: string;
    pacote: string; convidados: number; criadoEm: string; status: string; formaPagamento: string | null;
    contratoId: string | null; contratoStatus: string | null; versaoId: string | null;
    edicaoEstado: string | null; documentoRevisado: boolean; valorContratual: string | null; temFesta: boolean;
};
export type Contratacao = Omit<ContratacaoRow, 'temFesta' | 'documentoRevisado'> & {
    situacao: string; proximoPasso: string; acao: { titulo: string; href: string }; acessoPublico: string | null;
};

/** Presentation only. Never advances a contract, creates Festa or reserves an interval. */
export function classificarContratacao(row: ContratacaoRow): Contratacao | null {
    if (row.temFesta || row.contratoStatus === 'CANCELADO' || !estadosEmContratacao.includes(row.status)) return null;
    let situacao = 'Fechamento em preparação', titulo = 'Abrir revisão', proximoPasso = 'Conferir os dados do fechamento.';
    const href = row.contratoId
        ? `/admin/contratos?contratoId=${encodeURIComponent(row.contratoId)}${row.versaoId ? `&versaoId=${encodeURIComponent(row.versaoId)}` : ''}`
        : `/admin/fechamentos/${encodeURIComponent(row.id)}/revisao`;
    let acessoPublico: string | null = null;
    if (row.contratoId) {
        titulo = 'Abrir contrato';
        situacao = 'Contrato em elaboração';
        proximoPasso = 'Conferir o contrato e preparar o documento para assinatura.';
        if (row.edicaoEstado === 'AGUARDANDO_CLIENTE') {
            situacao = 'Aguardando assinatura do cliente';
            proximoPasso = 'Acompanhar a assinatura do cliente pelo acesso público.';
            acessoPublico = `/contrato/${encodeURIComponent(row.contratoId)}`;
        } else if (row.edicaoEstado === 'ASSINADA_KIDMAIS') {
            situacao = 'Assinado pela Kidmais';
            proximoPasso = 'Liberar o contrato para assinatura do cliente.';
        } else if (row.edicaoEstado === 'EM_ELABORACAO' && row.documentoRevisado) {
            situacao = 'Aguardando assinatura da Kidmais';
            titulo = 'Assinar pela Kidmais';
            proximoPasso = 'Abrir o contrato e concluir a assinatura administrativa.';
        } else if (row.edicaoEstado === 'EM_ELABORACAO') {
            situacao = row.contratoStatus === 'ASSINADO' ? 'Revisão em elaboração' : 'Contrato em elaboração';
        } else if (row.contratoStatus === 'ASSINADO') {
            situacao = 'Formalizado — Festa pendente';
            proximoPasso = 'Solicitar verificação operacional da Festa. Não gerar outro contrato.';
        } else if (row.edicaoEstado === 'CANCELADA') {
            situacao = 'Preparação contratual cancelada';
            proximoPasso = 'Conferir o contrato antes de retomar a contratação.';
        }
    } else if (row.status === 'AGUARDANDO_APROVACAO') {
        situacao = 'Aguardando aprovação comercial';
        titulo = 'Revisar proposta';
        proximoPasso = 'Conferir a proposta e aprovar ou recusar a condição comercial.';
    } else if (row.status === 'AGUARDANDO_CONTRATO') {
        situacao = 'Aguardando contrato';
        titulo = 'Gerar contrato';
        proximoPasso = 'Abrir a revisão e conferir os dados antes de gerar o contrato.';
    } else if (row.status === 'APROVADO') {
        situacao = 'Proposta aprovada';
        proximoPasso = 'Conferir o fechamento aprovado e seu próximo passo contratual.';
    } else if (['CONTRATO_ASSINADO', 'AGUARDANDO_PAGAMENTO', 'CONFIRMADO'].includes(row.status)) {
        situacao = 'Vínculo contratual pendente de verificação';
        proximoPasso = 'Conferir o fechamento; não criar uma contratação duplicada.';
    }
    // Explicit DTO: no CPF, tokens, signatures, full snapshot or document payload.
    return { id: row.id, clienteId: row.clienteId, cliente: row.cliente, clienteStatus: row.clienteStatus, data: row.data, inicio: row.inicio, fim: row.fim,
        pacote: row.pacote, convidados: row.convidados, criadoEm: row.criadoEm, status: row.status,
        formaPagamento: row.formaPagamento, contratoId: row.contratoId, contratoStatus: row.contratoStatus,
        versaoId: row.versaoId, edicaoEstado: row.edicaoEstado, valorContratual: row.valorContratual,
        situacao, proximoPasso, acao: { titulo, href }, acessoPublico };
}

export const contratacoesSql = `WITH fila AS (
 SELECT f.id, f.cliente_id AS "clienteId", COALESCE(cl.nome_completo,'Cliente não vinculado') AS cliente, cl.status AS "clienteStatus",
 f.data_evento::text AS data, f.horario_inicio::text AS inicio, f.horario_fim::text AS fim,
 COALESCE(p.nome,'Pacote não informado') AS pacote, f.convidados,
 f.criado_em::text AS "criadoEm", f.status, f.forma_pagamento_pretendida AS "formaPagamento",
 c.id AS "contratoId", c.status AS "contratoStatus", v.id AS "versaoId", e.estado AS "edicaoEstado",
 (e.documento_revisado_id IS NOT NULL) AS "documentoRevisado",
 v.snapshot->'comercial'->>'valorFinalContrato' AS "valorContratual",
 EXISTS(SELECT 1 FROM public.festas ft WHERE ft.contrato_id=c.id) AS "temFesta"
 FROM public.fechamentos f
 LEFT JOIN public.clientes cl ON cl.id=f.cliente_id
 LEFT JOIN public.pacotes p ON p.id=f.pacote_id
 LEFT JOIN public.contratos c ON c.fechamento_id=f.id
 LEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id
 LEFT JOIN public.contrato_versoes v ON v.contrato_id=c.id AND
 (v.id=COALESCE(cf.versao_em_preparacao_id,cf.versao_vigente_id)
  OR (cf.versao_em_preparacao_id IS NULL AND cf.versao_vigente_id IS NULL AND v.numero_versao=c.versao_atual))
 LEFT JOIN public.contrato_edicoes e ON e.contrato_versao_id=v.id
 WHERE f.status=ANY($1::text[]) AND ($2::uuid IS NULL OR f.cliente_id=$2::uuid)
 ) SELECT * FROM fila WHERE NOT "temFesta" AND "contratoStatus" IS DISTINCT FROM 'CANCELADO'
 ORDER BY data,inicio,"criadoEm",id`;

export async function listarContratacoes(tx: DbExecutor, clienteId?: string): Promise<Contratacao[]> {
    const result = await tx.query<ContratacaoRow>(contratacoesSql, [estadosEmContratacao, clienteId ?? null]);
    return result.rows.map(classificarContratacao).filter((r): r is Contratacao => r !== null);
}
