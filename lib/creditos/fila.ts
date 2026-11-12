import type { DbExecutor } from '../db/contracts';
import { REVISOES_DA_PESSOA } from './pagamento.ts';

/**
 * Pedidos da fila. B-14 (revisão do Astra, rodada 2, P3-R2-1): o pedido retido para a pessoa (`REVISOES_DA_PESSOA`) fica
 * congelado no processamento normal, que só atualiza a situação lida da cobrança. Por isso a fila mostra, ao lado do motivo
 * da retenção (que não muda), a situação e a última conferência da cobrança canônica: um estorno ou uma contestação que
 * chegou depois aparece aqui, e não só na cobrança.
 */
export async function pedidosDaFila(tx: DbExecutor) {
    const linhas = (await tx.query<{ protocolo: string; estado: string; revisao_motivo: string | null; recurso: string; preco_centavos: string; forma: string; criado_em: string;
        empresa_nome: string; empresa_id: string; cobranca_situacao: string | null; cobranca_conferida_em: string | null }>(`SELECT p.protocolo, p.estado, p.revisao_motivo, p.recurso,
            p.preco_centavos, p.forma, p.criado_em, e.nome AS empresa_nome, p.empresa_id, c.situacao_provedor AS cobranca_situacao, c.conferida_em AS cobranca_conferida_em
        FROM ia_credito_pedidos p JOIN empresas e ON e.id = p.empresa_id
        LEFT JOIN ia_credito_cobrancas c ON c.pedido_id = p.id AND c.empresa_id = p.empresa_id AND c.canonica
        WHERE p.estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'REVISAO') ORDER BY p.criado_em LIMIT 100`)).rows;
    return linhas.map((l) => ({ ...l, retida_pela_pessoa: l.estado === 'REVISAO' && l.revisao_motivo !== null && REVISOES_DA_PESSOA.has(l.revisao_motivo) }));
}
