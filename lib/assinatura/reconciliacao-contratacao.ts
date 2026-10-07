import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { cicloDoProvedor, type ClienteAsaas } from './asaas.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';

/**
 * Pendências de reconciliação da CONTRATAÇÃO (E8), sem migration nova: uma linha em `cobranca_eventos` (068) com
 * tipo `KIDMAIS_RECONCILIAR_CONTRATACAO`, `evento_id` começando por `kidmais:` e `empresa_id` preenchido. Nasce
 * sempre que o resultado de uma contratação fica INCERTO (resposta do provedor perdida, COMMIT sem confirmação, falha
 * na compensação). Fica PENDENTE/FALHOU até ser resolvida pelo processamento normal de eventos (reentrega, painel do
 * desenvolvedor ou scripts/assinatura-reconciliar.cjs) — nunca é descartada em silêncio.
 *
 * Regra de ouro: uma assinatura do provedor só é EXCLUÍDA quando o banco (lido com a linha travada, estado confirmado)
 * mostra OUTRA assinatura vinculada à empresa e a candidata não tem cobrança paga. Havendo qualquer dúvida sobre o
 * vínculo, nada é excluído: a pendência fica para revisão.
 */
export const TIPO_PENDENCIA = 'KIDMAIS_RECONCILIAR_CONTRATACAO';
export const PREFIXO_PENDENCIA = 'kidmais:';
const PAGAS = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

export type MotivoPendencia = 'CRIACAO_SEM_RESPOSTA' | 'COMMIT_INCERTO' | 'COMPENSACAO_FALHOU' | 'VINCULO_DUVIDOSO';
export type ProvedorReconciliacao = Pick<ClienteAsaas, 'listarAssinaturasPorReferencia' | 'listarCobrancasDaAssinatura' | 'removerAssinatura'>;

/** Registra a pendência (só identificadores). Devolve o id interno. */
export async function registrarPendencia(tx: DbExecutor, input: { empresaId: string; assinaturaId: string | null; motivo: MotivoPendencia }) {
    return (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, referencia_externa, empresa_id, situacao, ultimo_erro)
         VALUES ('ASAAS', $1, $2, $3, $4, $5::uuid, 'PENDENTE', $6) RETURNING id`,
        [`${PREFIXO_PENDENCIA}contratacao:${input.empresaId}:${randomUUID()}`, TIPO_PENDENCIA, input.assinaturaId, input.empresaId, input.empresaId, input.motivo])).rows[0].id;
}

export function ehPendencia(ev: { tipo: string; evento_id: string; empresa_id: string | null }) {
    return ev.tipo === TIPO_PENDENCIA && ev.evento_id.startsWith(PREFIXO_PENDENCIA) && ev.empresa_id !== null;
}

export type ResultadoReconciliacao =
    | { resultado: 'NADA_A_FAZER' | 'CONCILIADA'; removidas: string[] }
    | { resultado: 'VINCULADA'; assinaturaId: string }
    | { resultado: 'REVISAO_HUMANA'; motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO' | 'DUPLICATA_COM_PAGAMENTO' | 'SEM_ASSINATURA_NO_BANCO'; ids: string[] };

const ativa = (s: { status: string; deleted: boolean }) => !s.deleted && s.status === 'ACTIVE';

/**
 * Compara o vínculo gravado (linha travada, nesta transação) com o que o provedor tem para a referência da empresa:
 *   - sem vínculo e exatamente uma assinatura ativa → vincula os ids (a situação só muda pela sincronização);
 *   - sem vínculo e várias ativas → revisão humana (não escolhe, não exclui);
 *   - com vínculo → outras ativas da mesma referência são duplicatas: excluídas só se não tiverem cobrança paga;
 *     com pagamento, revisão humana.
 * Falha do provedor propaga (o evento fica FALHOU e volta a ser tentado).
 */
export async function reconciliarContratacao(tx: DbExecutor, empresaId: string, provedor: ProvedorReconciliacao, requestId: string | null = null): Promise<ResultadoReconciliacao> {
    const linha = (await tx.query<{ situacao: string; provedor_assinatura_id: string | null; provedor_cliente_id: string | null }>(
        'SELECT situacao, provedor_assinatura_id, provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha)
        return { resultado: 'REVISAO_HUMANA', motivo: 'SEM_ASSINATURA_NO_BANCO', ids: [] };
    const ativas = (await provedor.listarAssinaturasPorReferencia(empresaId)).filter(ativa);
    const origem = { tipo: 'RECONCILIACAO' as const, requestId };
    if (!linha.provedor_assinatura_id) {
        if (ativas.length === 0)
            return { resultado: 'NADA_A_FAZER', removidas: [] };
        if (ativas.length > 1)
            return { resultado: 'REVISAO_HUMANA', motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO', ids: ativas.map((s) => s.id) };
        const s = ativas[0];
        await tx.query(
            `UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = COALESCE(provedor_cliente_id, $2), provedor_assinatura_id = $3,
                    ciclo = CASE WHEN situacao IN ('TESTE', 'ENCERRADA') THEN COALESCE($4, ciclo) ELSE ciclo END, provedor_situacao = $5
              WHERE empresa_id = $1::uuid`, [empresaId, s.customer, s.id, cicloDoProvedor(s.cycle), s.status.slice(0, 40)]);
        await auditarCobranca(tx, { acao: 'ASSINATURA_VINCULADA_RECONCILIACAO', empresaId, origem, ip: null, depois: { vinculada: true } });
        return { resultado: 'VINCULADA', assinaturaId: s.id };
    }
    const duplicatas = ativas.filter((s) => s.id !== linha.provedor_assinatura_id);
    const removidas: string[] = [];
    const pagas: string[] = [];
    for (const d of duplicatas) {
        if ((await provedor.listarCobrancasDaAssinatura(d.id)).some((c) => PAGAS.has(c.status))) {
            pagas.push(d.id);
            continue;
        }
        // Compensação: o banco confirma (linha travada) que a empresa está vinculada a OUTRA assinatura.
        await provedor.removerAssinatura(d.id);
        removidas.push(d.id);
    }
    if (removidas.length)
        await auditarCobranca(tx, { acao: 'ASSINATURA_DUPLICADA_REMOVIDA', empresaId, origem, ip: null, depois: { removidas: removidas.length } });
    if (pagas.length)
        return { resultado: 'REVISAO_HUMANA', motivo: 'DUPLICATA_COM_PAGAMENTO', ids: pagas };
    return { resultado: removidas.length ? 'CONCILIADA' : 'NADA_A_FAZER', removidas };
}
