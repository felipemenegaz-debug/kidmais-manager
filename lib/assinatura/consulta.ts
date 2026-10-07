import type { DbExecutor } from '../db/contracts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import { precoDoCiclo, ConfiguracaoComercialInvalida } from './configuracao.ts';
import { lerEstadoComercial } from './estado.ts';

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
    return {
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
