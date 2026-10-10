export const ROTA_SITE = '/conheca';
export const CADASTRO_FECHADO = 'O cadastro on-line abre em breve. Fale com a Kidmais para começar.';
export type AmbienteSite = Record<string, string | undefined>;
export function linkWhatsApp(numero: string | undefined, mensagem: string): string | null {
    const informado = numero?.trim() ?? '';
    if (!/^[+\d\s().-]+$/.test(informado)) return null;
    const digitos = informado.replace(/\D/g, '');
    // Configuração exige código internacional: não inferir DDI nem abrir um destino parcial.
    if (!/^[1-9]\d{9,14}$/.test(digitos)) return null;
    return `https://wa.me/${digitos}?text=${encodeURIComponent(mensagem)}`;
}
export function configuracaoSite(env: AmbienteSite = process.env) {
    const dado = (nome: string) => env[nome]?.trim() || 'a definir';
    const whatsapp = env.SITE_ATENDIMENTO_WHATSAPP;
    let origem: string | null = null;
    try {
        const url = new URL(env.SITE_URL || env.ADMIN_AUTH_ORIGIN || '');
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) origem = url.origin;
    } catch { /* Sem origem confiável, não inventar domínio público. */ }
    return {
        precosPublicados: env.SITE_PRECOS_PUBLICADOS === 'true', origem,
        razaoSocial: dado('SITE_RAZAO_SOCIAL'), cnpj: dado('SITE_CNPJ'), endereco: dado('SITE_ENDERECO'),
        email: dado('SITE_ATENDIMENTO_EMAIL'), whatsapp: dado('SITE_ATENDIMENTO_WHATSAPP'), horario: dado('SITE_ATENDIMENTO_HORARIO'), encarregado: dado('SITE_ENCARREGADO_DADOS'),
        contato: linkWhatsApp(whatsapp, 'Olá! Quero conhecer o Kidmais Manager e conversar com a equipe.'),
        fundador: linkWhatsApp(whatsapp, 'Olá! Quero ser fundador do Kidmais Manager. Podem me explicar as condições?'),
    };
}
export type ConfiguracaoSite = ReturnType<typeof configuracaoSite>;
