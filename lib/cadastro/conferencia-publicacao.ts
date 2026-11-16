/**
 * Conferência pré-publicação dos textos legais definitivos (R-5): o texto afirma estados da configuração que só o
 * ambiente comprova. Cada item lê apenas nomes de variáveis e compara com valores esperados; o resultado nunca inclui
 * valores do ambiente. Rode no shell do serviço com `node --experimental-strip-types scripts/conferir-publicacao-textos-legais.mjs`.
 *
 * As flags da IA só podem ser lidas por lib/inteligencia/flags.ts e o Core não importa a IA; por isso o estado das
 * capacidades de IA fora da contratação chega pronto, calculado pelo script com `capacidadeForaDaContratacaoAtiva`.
 */
import { FORMATO_AUTORIZACAO_IA } from '../whatsapp/atendimento/configuracao.ts';

export type Ambiente = Readonly<Record<string, string | undefined>>;
export type ItemConferencia = { id: string; afirmacao: string; ok: boolean };
export type EstadoIa = {
    capacidadeForaDaContratacaoAtiva: boolean;
    /** D-OF-1: calculado por lib/inteligencia/publicacao.ts (provedor do atendimento e tetos mensais do AI_BUDGET_JSON). */
    whatsappIa: { provedorOpenAi: boolean; tetoEmpresa: boolean; tetoCapacidade: boolean };
};

const ligado = (v: string | undefined) => v === 'true';

export function conferirPublicacao(env: Ambiente, ia: EstadoIa): ItemConferencia[] {
    return [
        { id: 'convites-provedor', afirmacao: 'Convites com IA usam a OpenAI; o Gemini não está habilitado (sem provedor declarado o código usa o Gemini)',
            ok: !ligado(env.CONVITES_IA_ENABLED) || env.CONVITES_IA_PROVIDER === 'openai' },
        // D-OF-1 (13/11): a IA do atendimento pode ser ligada (Premium); se estiver, precisa estar como o texto descreve.
        { id: 'whatsapp-ia', afirmacao: 'Com a IA do atendimento ligada: provedor OpenAI, teto mensal por empresa e teto mensal do whatsapp_atendimento configurados',
            ok: env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO !== 'modelo'
                || (FORMATO_AUTORIZACAO_IA.test(env.WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO ?? '')
                    && ia.whatsappIa.provedorOpenAi && ia.whatsappIa.tetoEmpresa && ia.whatsappIa.tetoCapacidade) },
        { id: 'assistente-importacao', afirmacao: 'Assistente administrativo e importação de documentos por IA fora da contratação',
            ok: !ia.capacidadeForaDaContratacaoAtiva },
        { id: 'whatsapp-canal-meta', afirmacao: 'O atendimento pelo WhatsApp envia só pela Meta (sem a variável o código envia pela Gupshup, que saiu dos textos)',
            ok: env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO === 'meta' },
        { id: 'otp-meta', afirmacao: 'Os códigos de verificação saem pela Meta (WhatsApp Cloud API), não pela Gupshup',
            ok: (env.IDENTIDADE_OTP_PROVIDER ?? '').trim().toLowerCase() === 'whatsapp_cloud' && env.GUPSHUP_OTP_ENABLED !== 'true' },
        { id: 'importacao-integracao', afirmacao: 'Integração de importação de contratos desligada',
            ok: !ligado(env.CONTRACT_IMPORT_INTEGRATION_ENABLED) },
        { id: 'comprovante-email', afirmacao: 'A cópia do comprovante da contratação é enviada por e-mail',
            ok: ligado(env.ASSINATURA_COMPROVANTE_EMAIL) },
        { id: 'site-responsavel', afirmacao: 'Site identifica a Demerzel Labs Ltda., CNPJ 69.938.612/0001-26',
            ok: (env.SITE_RAZAO_SOCIAL ?? '').startsWith('Demerzel Labs') && env.SITE_CNPJ === '69.938.612/0001-26' },
    ];
}
