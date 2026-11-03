import { criarEnviarEmail, origemPublica, situacaoEmail } from '../acessos/email.ts';
import { withTransaction } from '../db/postgres.ts';
import { avisosLigados } from './avisos.ts';
import { enviarPendentes, type DepsAvisos } from './avisos-envio.ts';
import { repositorioAvisos } from './avisos-repositorio.ts';
import { prazosDeAcesso } from './configuracao.ts';

/**
 * Dependências reais do envio dos avisos no serviço web. null (nada é enviado) quando a trava ASSINATURA_AVISOS_EMAIL
 * está desligada ou o e-mail do ambiente não está configurado.
 */
export function depsAvisosPadrao(env: Record<string, string | undefined> = process.env): DepsAvisos | null {
    if (!avisosLigados(env) || !situacaoEmail(env).configurado)
        return null;
    return { repositorio: repositorioAvisos(withTransaction), enviar: criarEnviarEmail(env), origem: origemPublica(), prazos: prazosDeAcesso(env), simular: false };
}

/**
 * Depois de um evento do Asaas processado (`after` do webhook): envia os avisos pendentes DAQUELA empresa (pagamento
 * confirmado, cancelamento). Falha só vai ao log, sem dados; o job diário é a rede de segurança.
 */
export async function enviarAvisosDaEmpresaAgora(empresaId: string, env: Record<string, string | undefined> = process.env) {
    try {
        const deps = depsAvisosPadrao(env);
        if (deps)
            await enviarPendentes(deps, empresaId);
    }
    catch (error) {
        console.warn('[avisos da assinatura] envio adiado para o job diário', error instanceof Error ? error.name : typeof error);
    }
}
