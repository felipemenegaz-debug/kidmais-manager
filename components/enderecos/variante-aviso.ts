/** Texto e ação do aviso de troca de endereço por rota (plano D4). Sem botão onde recarregar perderia o token ou o link. */
export const AVISO_ENDERECO_MUDOU = 'Este sistema mudou de endereço. O que você não salvou pode se perder. Copie antes de continuar.';
export const AVISO_ABRIR_LINK = 'Este endereço mudou. Abra de novo o link que você recebeu por e-mail. Se ele não funcionar mais, peça um novo.';
export const AVISO_ABRIR_CONFIRMACAO = 'Este endereço mudou. Abra de novo o link do e-mail. Se a conta já tiver sido criada, entre com seu login e continue o cadastro.';
export const AVISO_SEM_RESPOSTA = 'Sem resposta do servidor para confirmar a sessão. Tentando de novo.';

export function varianteDaRota(caminho: string): { texto: string; botao: boolean } {
    if (caminho === '/acesso/recuperar' || caminho.startsWith('/acesso/recuperar/')) return { texto: AVISO_ENDERECO_MUDOU, botao: true };
    if (caminho === '/acesso' || caminho.startsWith('/acesso/')) return { texto: AVISO_ABRIR_LINK, botao: false };
    if (caminho === '/cadastro/confirmar' || caminho.startsWith('/cadastro/confirmar/')) return { texto: AVISO_ABRIR_CONFIRMACAO, botao: false };
    return { texto: AVISO_ENDERECO_MUDOU, botao: true };
}
