import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { withTransaction } from '../db/postgres.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import type { SessaoParaTenant } from '../saas/provar-tenant.ts';
import { provarTenantParaExportacao, revalidarTenantExportacao, type OpcoesGuarda } from './guarda.ts';
import {
    criarPastaTemporaria, DISCO_PADRAO, FORMATO, LIMITES_PADRAO, lerDados, limpadorDe, limparSobras, montarPacote, VERSAO_FORMATO,
    type Disco, type Limites, type PacoteGerado,
} from './pacote.ts';

/**
 * Exportação completa em três transações curtas, para não segurar as travas da empresa durante a leitura:
 *   A. prova do tenant (guarda.ts) — Gestão; empresa ativa ou, pela exceção mínima, suspensa — e limite por
 *      empresa/pessoa (contado na própria auditoria, vale entre reinícios);
 *   B. leitura numa transação REPEATABLE READ READ ONLY (fotografia única), UTC, com prazo por comando, gravando em
 *      arquivos temporários; o ZIP é montado em arquivo depois do COMMIT da leitura;
 *   C. nova prova, conferência de que é a MESMA empresa, o MESMO vínculo e a MESMA situação, auditoria e revalidação.
 * O arquivo só é entregue depois de C (a rota envia o ZIP por fluxo e chama `limpar()` ao terminar, falhar ou ser
 * abandonada). Vínculo revogado, papel trocado ou empresa desativada no meio = nada sai, nada é auditado.
 * A auditoria do sucesso guarda só contagens e hashes; a recusa da guarda registra só o código (sem IP nem navegador).
 */
export type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
export type LimitesUso = { porEmpresaHora: number; porPessoaHora: number };
export const LIMITES_USO_PADRAO: LimitesUso = { porEmpresaHora: 6, porPessoaHora: 12 };
export type DepsExportacao = {
    transacao: Transacao; limites?: Limites; relogio?: () => number; disco?: Disco; uso?: LimitesUso;
    /** Pasta base dos temporários (padrão: os.tmpdir()). */
    base?: string;
    /** Prazo máximo para a rota consumir o ZIP; depois disso a pasta é apagada de qualquer jeito. */
    prazoEnvioMs?: number;
};
export type ResultadoExportacao = PacoteGerado & { suspensa: boolean };

/** Um pacote por vez neste processo (disco temporário e CPU da instância de 512 MB). */
export const MAXIMO_SIMULTANEAS = 1;
let emAndamento = 0;
export const exportacoesEmAndamento = () => emAndamento;

function recusarTenant(): never {
    throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403);
}

function prazoEsgotado(erro: unknown) {
    return typeof erro === 'object' && erro !== null && 'code' in erro && (erro as { code?: unknown }).code === '57014';
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recusa da guarda auditada sem dados pessoais: quem pediu (id), o que pediu (id da empresa) e o código. */
async function auditarRecusa(deps: DepsExportacao, sessao: SessaoParaTenant, empresaSolicitada: string | null | undefined, codigo: string, requestId: string) {
    const pedida = empresaSolicitada?.trim().toLowerCase() ?? '';
    const empresa = UUID.test(pedida) ? pedida : null;
    try {
        await deps.transacao((tx) => tx.query(
            `INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem, request_id)
             VALUES ('USUARIO', $1::uuid, 'EXPORTACAO_RECUSADA', $2, $3::uuid, NULL, $4::jsonb, NULL, 'EXPORTACAO', $5)`,
            [sessao.usuario_id, empresa ? 'EMPRESA' : 'USUARIO', empresa ?? sessao.usuario_id,
                JSON.stringify({ tipo: 'completa', codigo, empresaInformada: empresa !== null }), requestId]));
    } catch (erro) {
        // A recusa continua recusa mesmo se o registro falhar; só o motivo técnico vai ao log.
        console.error('[exportacao] falha ao auditar recusa', erro instanceof Error ? erro.message : erro);
    }
}

async function exigirLimiteDeUso(tx: DbExecutor, empresaId: string, usuarioId: string, uso: LimitesUso) {
    const r = (await tx.query<{ empresa: string; pessoa: string }>(
        `SELECT count(*) FILTER (WHERE entidade_id = $1::uuid)::text AS empresa, count(*) FILTER (WHERE usuario_id = $2::uuid)::text AS pessoa
           FROM auditoria
          WHERE acao = 'EXPORTACAO_DADOS' AND origem = 'EXPORTACAO' AND dados_depois->>'tipo' = 'completa'
            AND criado_em > clock_timestamp() - interval '1 hour' AND (entidade_id = $1::uuid OR usuario_id = $2::uuid)`,
        [empresaId, usuarioId])).rows[0];
    if (Number(r.empresa) >= uso.porEmpresaHora || Number(r.pessoa) >= uso.porPessoaHora)
        throw new PacoteAdminError('EXPORTACAO_LIMITE', 'O limite de exportações completas por hora foi atingido. Use o último pacote baixado ou tente de novo mais tarde.', 429);
}

export async function exportarPacoteCompleto(
    sessao: SessaoParaTenant,
    empresaSolicitada: string | null | undefined,
    ctx: { requestId?: string },
    deps: DepsExportacao = { transacao: withTransaction },
    opcoesGuarda: OpcoesGuarda = {},
): Promise<ResultadoExportacao> {
    if (emAndamento >= MAXIMO_SIMULTANEAS)
        throw new PacoteAdminError('EXPORTACAO_OCUPADA', 'Outra exportação está sendo preparada agora. Tente de novo em um minuto.', 429);
    emAndamento++;
    let liberado = false;
    const liberar = () => { if (!liberado) { liberado = true; emAndamento--; } };
    let dir: string | null = null;
    let limpar: (() => Promise<void>) | null = null;
    const requestId = ctx.requestId ?? randomUUID();
    try {
        let prova;
        try {
            prova = await deps.transacao(async (tx) => {
                const t = await provarTenantParaExportacao(tx, sessao, empresaSolicitada, opcoesGuarda);
                await exigirLimiteDeUso(tx, t.empresaComprovada, t.usuarioId, deps.uso ?? LIMITES_USO_PADRAO);
                return t;
            });
        } catch (erro) {
            if (erro instanceof PacoteAdminError && (erro.code === 'TENANT_NAO_COMPROVADO' || erro.code === 'PAPEL_NAO_AUTORIZADO'))
                await auditarRecusa(deps, sessao, empresaSolicitada, erro.code, requestId);
            throw erro;
        }
        await limparSobras(deps.base).catch(() => 0);
        dir = await criarPastaTemporaria(deps.base);
        limpar = limpadorDe(dir, liberar);
        const disco = deps.disco ?? DISCO_PADRAO;
        const pastaTemporaria = dir;
        let dados;
        try {
            dados = await deps.transacao(async (tx) => {
                await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
                await tx.query("SET LOCAL statement_timeout = '60s'");
                await tx.query("SET LOCAL TimeZone = 'UTC'");
                return lerDados(tx, prova.empresaComprovada, pastaTemporaria, { limites: deps.limites ?? LIMITES_PADRAO, relogio: deps.relogio, disco });
            });
        } catch (erro) {
            if (prazoEsgotado(erro))
                throw new PacoteAdminError('EXPORTACAO_DEMORADA', 'A exportação passou do tempo limite. Tente de novo em alguns minutos; se persistir, fale com o suporte.', 503);
            throw erro;
        }
        const pacote = await montarPacote(dados, disco);
        await deps.transacao(async (tx) => {
            const atual = await provarTenantParaExportacao(tx, sessao, empresaSolicitada, opcoesGuarda);
            if (atual.empresaComprovada !== prova.empresaComprovada || atual.membershipId !== prova.membershipId || atual.suspensa !== prova.suspensa) recusarTenant();
            const m = pacote.manifesto;
            // Mesmo registro da exportação em CSV (acao EXPORTACAO_DADOS, origem EXPORTACAO), sem IP nem navegador.
            await tx.query(
                `INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem, request_id)
                 VALUES ('USUARIO', $1::uuid, 'EXPORTACAO_DADOS', 'EMPRESA', $2::uuid, NULL, $3::jsonb, NULL, 'EXPORTACAO', $4)`,
                [atual.usuarioId, atual.empresaComprovada, JSON.stringify({
                    tipo: 'completa', formato: FORMATO, versaoFormato: VERSAO_FORMATO, empresaId: atual.empresaComprovada, empresaSuspensa: atual.suspensa,
                    geradoEm: m.geradoEm, arquivos: m.totais.arquivos, linhas: m.totais.linhas, bytes: m.totais.bytes, pdfs: m.totais.pdfs,
                    entidadesAusentes: m.entidadesAusentes.length, manifestoSha256: pacote.manifestoSha256, zipSha256: pacote.zipSha256, resultado: 'SUCESSO',
                }), requestId]);
            await revalidarTenantExportacao(tx, atual);
        });
        // Rede de segurança: se a rota nunca consumir o ZIP, a pasta some sozinha e a vaga é liberada.
        const final = limpar;
        setTimeout(() => { void final(); }, deps.prazoEnvioMs ?? 10 * 60 * 1000).unref();
        limpar = null;
        return { ...pacote, limpar: final, suspensa: prova.suspensa };
    } finally {
        if (limpar) await limpar();
        else if (!dir) liberar();
    }
}
