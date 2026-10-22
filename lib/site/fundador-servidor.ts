import { withTransaction } from '../db/postgres';
import { resumoCampanha, type ResumoCampanha } from '../assinatura/campanha.ts';

/** Resumo indicativo para o site (sem ids nem documentos). Falha de leitura vira texto sem prazo nem estoque. */
export async function resumoCampanhaSite(): Promise<ResumoCampanha | null> {
    try { return await withTransaction((tx) => resumoCampanha(tx)); }
    catch { return null; }
}
