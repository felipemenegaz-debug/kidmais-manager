import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { cicloDoProvedor, type ClienteAsaas } from './asaas.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';
import { decidirCompensacao, type MotivoPreservacao } from './compensacao.ts';

/**
 * Pendências de reconciliação da CONTRATAÇÃO (E8), sem migration nova: uma linha em `cobranca_eventos` (068) com
 * tipo `KIDMAIS_RECONCILIAR_CONTRATACAO`, `evento_id` começando por `kidmais:` e `empresa_id` preenchido. Nasce
 * sempre que o resultado de uma contratação fica INCERTO (resposta do provedor perdida, COMMIT sem confirmação, falha
 * na compensação). Fica PENDENTE/FALHOU até ser resolvida pelo processamento normal de eventos (reentrega, painel do
 * desenvolvedor ou scripts/assinatura-reconciliar.cjs) — nunca é descartada em silêncio.
 *
 * Regra de ouro: exclusão só pela decisão central (compensacao.ts): vínculo confirmado (linha travada) a uma assinatura
 * VIGENTE da mesma empresa e candidata sem nenhuma cobrança fora de "em aberto". Qualquer dúvida → nada é excluído e a
 * pendência fica para revisão.
 */
export const TIPO_PENDENCIA = 'KIDMAIS_RECONCILIAR_CONTRATACAO';
export const PREFIXO_PENDENCIA = 'kidmais:';
const TROCA_PERMITIDA = new Set(['TESTE', 'CANCELADA_FIM_PERIODO', 'ENCERRADA']);

export type MotivoPendencia = 'CRIACAO_SEM_RESPOSTA' | 'COMMIT_INCERTO' | 'COMPENSACAO_FALHOU' | 'VINCULO_DUVIDOSO' | 'COMPENSACAO_PRESERVADA' | 'ASSINATURAS_AMBIGUAS';
export type ProvedorReconciliacao = Pick<ClienteAsaas, 'obterAssinatura' | 'listarAssinaturasPorReferencia' | 'listarCobrancasDaAssinatura' | 'removerAssinatura'>;

/** Registra a pendência (só identificadores e o motivo). Devolve o id interno. */
export async function registrarPendencia(tx: DbExecutor, input: { empresaId: string; assinaturaId: string | null; motivo: MotivoPendencia; detalhe?: MotivoPreservacao }) {
    return (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, referencia_externa, empresa_id, situacao, ultimo_erro)
         VALUES ('ASAAS', $1, $2, $3, $4, $5::uuid, 'PENDENTE', $6) RETURNING id`,
        [`${PREFIXO_PENDENCIA}contratacao:${input.empresaId}:${randomUUID()}`, TIPO_PENDENCIA, input.assinaturaId, input.empresaId, input.empresaId, input.detalhe ? `${input.motivo}: ${input.detalhe}` : input.motivo])).rows[0].id;
}

export function ehPendencia(ev: { tipo: string; evento_id: string; empresa_id: string | null }) {
    return ev.tipo === TIPO_PENDENCIA && ev.evento_id.startsWith(PREFIXO_PENDENCIA) && ev.empresa_id !== null;
}

export type ResultadoReconciliacao =
    | { resultado: 'NADA_A_FAZER' | 'CONCILIADA'; removidas: string[] }
    | { resultado: 'VINCULADA'; assinaturaId: string }
    | { resultado: 'REVISAO_HUMANA'; motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO' | 'DUPLICATA_COM_PAGAMENTO' | 'DUPLICATA_PRESERVADA' | 'VINCULO_INATIVO_COM_ACESSO' | 'SEM_ASSINATURA_NO_BANCO'; ids: string[] };

const ativa = (s: { status: string; deleted: boolean }) => !s.deleted && s.status === 'ACTIVE';

/**
 * Compara o vínculo gravado (linha travada, nesta transação) com o que o provedor tem para a referência da empresa:
 *   - vínculo vazio OU apontando para assinatura que não está mais ativa (ex.: cancelada antes de uma recontratação):
 *       nenhuma ativa → nada; exatamente uma → vincula (se a 068 permite a troca nesta situação; senão revisão);
 *       várias → revisão humana (não escolhe a primeira, não exclui);
 *   - vínculo a assinatura ativa → as outras ativas são candidatas a duplicata; cada uma passa pela decisão central
 *     (compensacao.ts): exclui só com justificativa segura; preservada → revisão humana com o motivo.
 * Falha do provedor propaga (o evento fica FALHOU e volta a ser tentado).
 */
export async function reconciliarContratacao(tx: DbExecutor, empresaId: string, provedor: ProvedorReconciliacao, requestId: string | null = null): Promise<ResultadoReconciliacao> {
    const linha = (await tx.query<{ situacao: string; provedor_assinatura_id: string | null; provedor_cliente_id: string | null }>(
        'SELECT situacao, provedor_assinatura_id, provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha)
        return { resultado: 'REVISAO_HUMANA', motivo: 'SEM_ASSINATURA_NO_BANCO', ids: [] };
    const ativas = (await provedor.listarAssinaturasPorReferencia(empresaId)).filter(ativa);
    const origem = { tipo: 'RECONCILIACAO' as const, requestId };
    const vinculada = linha.provedor_assinatura_id ? ativas.find((s) => s.id === linha.provedor_assinatura_id) ?? null : null;
    if (!vinculada) {
        if (ativas.length === 0)
            return { resultado: 'NADA_A_FAZER', removidas: [] };
        if (ativas.length > 1)
            return { resultado: 'REVISAO_HUMANA', motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO', ids: ativas.map((s) => s.id) };
        const s = ativas[0];
        // Vínculo antigo não vigente: a troca só vale onde a 068 permite; com acesso pago em curso, pessoa decide.
        if (linha.provedor_assinatura_id && !TROCA_PERMITIDA.has(linha.situacao))
            return { resultado: 'REVISAO_HUMANA', motivo: 'VINCULO_INATIVO_COM_ACESSO', ids: [linha.provedor_assinatura_id, s.id] };
        await tx.query(
            `UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = COALESCE(provedor_cliente_id, $2), provedor_assinatura_id = $3,
                    ciclo = CASE WHEN situacao IN ('TESTE', 'ENCERRADA') THEN COALESCE($4, ciclo) ELSE ciclo END, provedor_situacao = $5
              WHERE empresa_id = $1::uuid`, [empresaId, s.customer, s.id, cicloDoProvedor(s.cycle), s.status.slice(0, 40)]);
        await auditarCobranca(tx, { acao: 'ASSINATURA_VINCULADA_RECONCILIACAO', empresaId, origem, ip: null, depois: { vinculada: true } });
        return { resultado: 'VINCULADA', assinaturaId: s.id };
    }
    const removidas: string[] = [];
    const preservadas: Array<{ id: string; motivo: MotivoPreservacao }> = [];
    for (const d of ativas) {
        if (d.id === vinculada.id)
            continue;
        const decisao = await decidirCompensacao(provedor, { empresaId, vinculo: vinculada.id, candidataId: d.id });
        if (!decisao.excluir) {
            if (decisao.motivo !== 'CANDIDATA_INEXISTENTE')
                preservadas.push({ id: d.id, motivo: decisao.motivo });
            continue;
        }
        await provedor.removerAssinatura(d.id);
        removidas.push(d.id);
    }
    if (removidas.length)
        await auditarCobranca(tx, { acao: 'ASSINATURA_DUPLICADA_REMOVIDA', empresaId, origem, ip: null, depois: { removidas: removidas.length } });
    if (preservadas.length)
        return {
            resultado: 'REVISAO_HUMANA', ids: preservadas.map((p) => p.id),
            motivo: preservadas.every((p) => p.motivo === 'CANDIDATA_COM_PAGAMENTO') ? 'DUPLICATA_COM_PAGAMENTO' : 'DUPLICATA_PRESERVADA',
        };
    return { resultado: removidas.length ? 'CONCILIADA' : 'NADA_A_FAZER', removidas };
}
