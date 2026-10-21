import { createHash, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { withTransaction } from '../db/postgres.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import type { SessaoParaTenant } from '../saas/provar-tenant.ts';
import { provarTenantParaExportacao, revalidarTenantExportacao } from './guarda.ts';
import { FORMATO, gerarPacote, LIMITES_PADRAO, VERSAO_FORMATO, type Limites, type PacoteGerado } from './pacote.ts';

/**
 * Exportação completa em três transações curtas, para não segurar as travas da empresa durante a leitura:
 *   A. prova do tenant (guarda.ts) — Gestão; empresa ativa ou, pela exceção mínima, suspensa;
 *   B. leitura numa transação REPEATABLE READ READ ONLY (fotografia única), UTC, com prazo por comando;
 *   C. nova prova, conferência de que é a MESMA empresa e o MESMO vínculo, auditoria e revalidação antes do commit.
 * O arquivo só é entregue depois de C: vínculo revogado, papel trocado ou empresa desativada no meio = nada sai.
 * A auditoria guarda só contagens e hashes (nenhum conteúdo, IP ou navegador).
 */
export type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
export type DepsExportacao = { transacao: Transacao; limites?: Limites; relogio?: () => number };
export type ResultadoExportacao = PacoteGerado & { suspensa: boolean; zipSha256: string };

/** Pacotes montados em memória ao mesmo tempo neste processo (protege a memória da instância). */
export const MAXIMO_SIMULTANEAS = 2;
let emAndamento = 0;

function recusarTenant(): never {
    throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403);
}

function prazoEsgotado(erro: unknown) {
    return typeof erro === 'object' && erro !== null && 'code' in erro && (erro as { code?: unknown }).code === '57014';
}

export async function exportarPacoteCompleto(
    sessao: SessaoParaTenant,
    empresaSolicitada: string | null | undefined,
    ctx: { requestId?: string },
    deps: DepsExportacao = { transacao: withTransaction },
): Promise<ResultadoExportacao> {
    if (emAndamento >= MAXIMO_SIMULTANEAS)
        throw new PacoteAdminError('EXPORTACAO_OCUPADA', 'Outra exportação está sendo preparada agora. Tente de novo em um minuto.', 429);
    emAndamento++;
    try {
        const prova = await deps.transacao((tx) => provarTenantParaExportacao(tx, sessao, empresaSolicitada));
        let pacote: PacoteGerado;
        try {
            pacote = await deps.transacao(async (tx) => {
                await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
                await tx.query("SET LOCAL statement_timeout = '60s'");
                await tx.query("SET LOCAL TimeZone = 'UTC'");
                return gerarPacote(tx, prova.empresaComprovada, deps.limites ?? LIMITES_PADRAO, deps.relogio);
            });
        } catch (erro) {
            if (prazoEsgotado(erro))
                throw new PacoteAdminError('EXPORTACAO_DEMORADA', 'A exportação passou do tempo limite. Tente de novo em alguns minutos; se persistir, fale com o suporte.', 503);
            throw erro;
        }
        const zipSha256 = createHash('sha256').update(pacote.zip).digest('hex');
        await deps.transacao(async (tx) => {
            const atual = await provarTenantParaExportacao(tx, sessao, empresaSolicitada);
            if (atual.empresaComprovada !== prova.empresaComprovada || atual.membershipId !== prova.membershipId || atual.suspensa !== prova.suspensa) recusarTenant();
            const m = pacote.manifesto;
            // Mesmo registro da exportação em CSV (acao EXPORTACAO_DADOS, origem EXPORTACAO), sem IP nem navegador.
            await tx.query(
                `INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem, request_id)
                 VALUES ('USUARIO', $1::uuid, 'EXPORTACAO_DADOS', 'EMPRESA', $2::uuid, NULL, $3::jsonb, NULL, 'EXPORTACAO', $4)`,
                [atual.usuarioId, atual.empresaComprovada, JSON.stringify({
                    tipo: 'completa', formato: FORMATO, versaoFormato: VERSAO_FORMATO, empresaId: atual.empresaComprovada, empresaSuspensa: atual.suspensa,
                    geradoEm: m.geradoEm, arquivos: m.totais.arquivos, linhas: m.totais.linhas, bytes: m.totais.bytes, pdfs: m.totais.pdfs,
                    entidadesAusentes: m.entidadesAusentes.length, manifestoSha256: pacote.manifestoSha256, zipSha256, resultado: 'SUCESSO',
                }), ctx.requestId ?? randomUUID()]);
            await revalidarTenantExportacao(tx, atual);
        });
        return { ...pacote, suspensa: prova.suspensa, zipSha256 };
    } finally {
        emAndamento--;
    }
}
