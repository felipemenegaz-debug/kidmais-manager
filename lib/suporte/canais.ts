import { linkWhatsApp, type AmbienteSite } from '../site/configuracao.ts';

export { ROTA_AJUDA } from './rota.ts';

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;

/**
 * Canais de atendimento da Kidmais para quem usa o Admin. Mesmas variáveis do rodapé do site (SITE_ATENDIMENTO_*),
 * mas sem o texto "a definir": canal ausente ou inválido simplesmente não aparece, e a tela explica o caminho que resta.
 */
export function canaisSuporte(env: AmbienteSite = process.env) {
    const email = env.SITE_ATENDIMENTO_EMAIL?.trim() ?? '';
    const emailValido = email.length <= 254 && EMAIL.test(email) ? email : null;
    const whatsapp = linkWhatsApp(env.SITE_ATENDIMENTO_WHATSAPP, 'Olá! Sou cliente do Kidmais Manager e preciso de ajuda.');
    const horario = env.SITE_ATENDIMENTO_HORARIO?.trim() || null;
    return {
        email: emailValido,
        emailHref: emailValido ? `mailto:${emailValido}?subject=${encodeURIComponent('Suporte Kidmais Manager')}` : null,
        whatsapp: whatsapp ? env.SITE_ATENDIMENTO_WHATSAPP!.trim() : null,
        whatsappHref: whatsapp,
        horario: emailValido || whatsapp ? horario : null,
        configurado: Boolean(emailValido || whatsapp),
    };
}
export type CanaisSuporte = ReturnType<typeof canaisSuporte>;
