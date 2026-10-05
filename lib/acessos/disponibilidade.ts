import { situacaoEmail } from './email.ts';
import { erroAcesso } from './erros.ts';

/** Ativar somente depois de instalar o schema e homologar a entrega do e-mail. */
export function exigirRecuperacaoPublicaAtiva() {
    if (process.env.RECUPERACAO_SENHA_ATIVA !== 'true' || !situacaoEmail().configurado)
        throw erroAcesso('EMAIL_NAO_CONFIGURADO', 'A recuperação de senha está temporariamente indisponível. Entre em contato com o responsável pelo sistema.', 503);
}
