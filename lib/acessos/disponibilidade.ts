import { situacaoEmail } from './email.ts';
import { erroAcesso } from './erros.ts';

/** Ativar somente depois de instalar o schema e homologar a entrega do e-mail. */
export function recuperacaoPublicaAtiva() {
    return process.env.RECUPERACAO_SENHA_ATIVA === 'true' && situacaoEmail().configurado;
}

export const MENSAGEM_RECUPERACAO_INDISPONIVEL = 'A recuperação de senha está temporariamente indisponível. Entre em contato com o responsável pelo sistema.';

export function exigirRecuperacaoPublicaAtiva() {
    if (!recuperacaoPublicaAtiva())
        throw erroAcesso('EMAIL_NAO_CONFIGURADO', MENSAGEM_RECUPERACAO_INDISPONIVEL, 503);
}
