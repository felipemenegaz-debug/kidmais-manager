import type { ClienteAsaas } from './asaas.ts';
import { STATUS_PAGO } from './provedor-estado.ts';

/**
 * ÚNICO ponto que decide se uma assinatura do provedor pode ser EXCLUÍDA como duplicata (compensação imediata da
 * contratação e reconciliação usam esta função). Exclui só com justificativa segura, todas confirmadas agora:
 *   1. o banco mostra um vínculo confirmado (lido de verdade), diferente da candidata;
 *   2. esse vínculo MUDOU desde o que a contratação viu (outro escritor vinculou outra assinatura) — quando informado;
 *   3. a assinatura vinculada está VIGENTE no provedor (ativa, não removida) e é da mesma empresa (externalReference);
 *      uma referência antiga cancelada nunca justifica excluir uma recontratação;
 *   4. a candidata existe, é da mesma empresa e todas as cobranças dela estão só em aberto (PENDING/OVERDUE):
 *      pagamento, estorno, análise ou qualquer situação desconhecida → preserva.
 * Qualquer outra coisa preserva a candidata com o motivo. Falha do provedor propaga (quem chama decide: pendência).
 */
export type MotivoPreservacao =
    | 'VINCULO_NAO_CONFIRMADO' | 'CANDIDATA_E_A_VINCULADA' | 'VINCULO_NAO_MUDOU' | 'VINCULADA_NAO_VIGENTE'
    | 'VINCULADA_DE_OUTRA_EMPRESA' | 'CANDIDATA_INEXISTENTE' | 'CANDIDATA_DE_OUTRA_EMPRESA' | 'CANDIDATA_COM_PAGAMENTO'
    | 'CANDIDATA_COM_COBRANCA_INDEFINIDA';
export type DecisaoCompensacao = { excluir: true } | { excluir: false; motivo: MotivoPreservacao };
export type ProvedorCompensacao = Pick<ClienteAsaas, 'obterAssinatura' | 'listarCobrancasDaAssinatura'>;

const EM_ABERTO = new Set(['PENDING', 'OVERDUE']);
const preservar = (motivo: MotivoPreservacao): DecisaoCompensacao => ({ excluir: false, motivo });

export async function decidirCompensacao(provedor: ProvedorCompensacao, input: {
    empresaId: string;
    /** Vínculo lido do banco agora; null = sem vínculo; undefined = leitura falhou. */
    vinculo: string | null | undefined;
    /** Vínculo que a contratação viu antes de criar (fase A); omitido na reconciliação. */
    vinculoAnterior?: string | null;
    candidataId: string;
}): Promise<DecisaoCompensacao> {
    const { empresaId, vinculo, candidataId } = input;
    if (typeof vinculo !== 'string')
        return preservar('VINCULO_NAO_CONFIRMADO');
    if (vinculo === candidataId)
        return preservar('CANDIDATA_E_A_VINCULADA');
    if (input.vinculoAnterior !== undefined && vinculo === input.vinculoAnterior)
        return preservar('VINCULO_NAO_MUDOU');
    const vigente = await provedor.obterAssinatura(vinculo);
    if (!vigente || vigente.deleted || vigente.status !== 'ACTIVE')
        return preservar('VINCULADA_NAO_VIGENTE');
    if (vigente.externalReference !== empresaId)
        return preservar('VINCULADA_DE_OUTRA_EMPRESA');
    const candidata = await provedor.obterAssinatura(candidataId);
    if (!candidata || candidata.deleted)
        return preservar('CANDIDATA_INEXISTENTE');
    if (candidata.externalReference !== empresaId)
        return preservar('CANDIDATA_DE_OUTRA_EMPRESA');
    const cobrancas = (await provedor.listarCobrancasDaAssinatura(candidataId)).filter((c) => !c.deleted || STATUS_PAGO.has(c.status));
    if (cobrancas.some((c) => STATUS_PAGO.has(c.status)))
        return preservar('CANDIDATA_COM_PAGAMENTO');
    if (cobrancas.some((c) => !EM_ABERTO.has(c.status)))
        return preservar('CANDIDATA_COM_COBRANCA_INDEFINIDA');
    return { excluir: true };
}
