import type { DbExecutor } from '../db/contracts';
import { FestaError } from './domain.ts';
import { assinaturaEstruturaFesta016, estruturaFesta016Sql, tabelasFesta016 } from './estrutura-016.ts';

/** Falha fechada: apenas leitura dos catálogos; nunca executa instalação automática. */
export async function validarAmbienteFesta(tx: DbExecutor) {
    if (process.env.FESTA_ENABLED !== 'true') throw new FestaError('Módulo Festa indisponível neste ambiente.', 503);
    try {
        const result = await tx.query<{ assinatura: string }>(estruturaFesta016Sql, [tabelasFesta016]);
        if (result.rows[0]?.assinatura !== assinaturaEstruturaFesta016) throw new Error('Estrutura incompatível');
    } catch {
        throw new FestaError('Módulo Festa indisponível: instalação não validada.', 503);
    }
}
