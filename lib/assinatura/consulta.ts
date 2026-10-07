import type { DbExecutor } from '../db/contracts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import { precoDoCiclo, ConfiguracaoComercialInvalida } from './configuracao.ts';
import { lerEstadoComercial } from './estado.ts';
import { configuracaoAsaas } from './asaas.ts';

/**
 * Tela "Assinatura" da empresa comprovada (E4/E8): situação, datas e exceções vigentes. Qualquer vínculo ativo
 * consulta; ações de cobrança (assinar, cancelar) são só da Gestão e chegam com o provedor (E8).
 * Nunca expõe motivo interno de exceção, ids do provedor, nem dados de outra empresa.
 */
export async function consultarAssinatura(tx: DbExecutor, tenant: TenantComprovado, env: Record<string, string | undefined> = process.env) {
    const estado = await lerEstadoComercial(tx, tenant.empresaComprovada);
    let precos: { MENSAL: number | null; ANUAL: number | null } = { MENSAL: null, ANUAL: null };
    let configuracaoValida = true;
    try {
        precos = { MENSAL: precoDoCiclo('MENSAL', env), ANUAL: precoDoCiclo('ANUAL', env) };
    }
    catch (error) {
        if (!(error instanceof ConfiguracaoComercialInvalida))
            throw error;
        configuracaoValida = false;
    }
    const a = estado.assinatura;
    // E8: só o necessário para a tela escolher as ações (sem ids do provedor nem valores).
    let cobranca = { disponivel: false, vinculada: false, provedorSituacao: null as string | null, sincronizadoEm: null as string | null };
    if (a && (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0]?.ok) {
        const c = (await tx.query<{ vinculada: boolean; provedor_situacao: string | null; sincronizado_em: string | null }>(
            `SELECT provedor_assinatura_id IS NOT NULL AS vinculada, provedor_situacao,
                    to_char(sincronizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sincronizado_em
               FROM empresa_assinaturas WHERE empresa_id = $1::uuid`, [tenant.empresaComprovada])).rows[0];
        cobranca = { disponivel: configuracaoAsaas(env).ligado, vinculada: c?.vinculada === true, provedorSituacao: c?.provedor_situacao ?? null, sincronizadoEm: c?.sincronizado_em ?? null };
    }
    return {
        cobranca,
        instalado: estado.instalado,
        cobrado: a !== null,
        gestao: tenant.papelAtual === 'REPRESENTANTE_AUTORIZADO',
        agora: estado.agora,
        acesso: estado.acesso,
        assinatura: a ? { situacao: a.situacao, ciclo: a.ciclo, testeInicio: a.testeInicio, testeFim: a.testeFim, periodoAtualFim: a.periodoAtualFim, emAtrasoDesde: a.emAtrasoDesde, encerradaEm: a.encerradaEm } : null,
        excecoes: estado.excecoes.filter((e) => e.tipo !== 'EXTENSAO_TESTE').map((e) => ({ tipo: e.tipo, validaAte: e.validaAte })),
        precos: configuracaoValida ? precos : null,
    };
}
