import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { canaisSuporte } from '@/lib/suporte/canais';

// Canais lidos a cada pedido: mudar o contato no ambiente não exige novo build.
export const dynamic = 'force-dynamic';

/**
 * Ajuda e suporte do Admin. Aberta também com o acesso comercial bloqueado e sem empresa ativa (AdminShell):
 * é a saída de quem não consegue usar o sistema. Só mostra canais configurados; nunca "a definir".
 */
export default function Ajuda() {
    const canais = canaisSuporte();
    return <main className={admin.page} data-ajuda>
        <h1>Ajuda e suporte</h1>
        <section className={workspace.card} aria-labelledby="t-falar" data-canais={canais.configurado ? 'configurados' : 'ausentes'}>
            <h2 id="t-falar">Fale com a equipe Kidmais</h2>
            {canais.configurado ? <>
                <ul>
                    {canais.whatsappHref && <li>WhatsApp: <a href={canais.whatsappHref} target="_blank" rel="noopener noreferrer" data-canal="whatsapp">{canais.whatsapp}</a></li>}
                    {canais.emailHref && <li>E-mail: <a href={canais.emailHref} data-canal="email">{canais.email}</a></li>}
                </ul>
                {canais.horario && <p className={workspace.muted} data-canal="horario">Horário de atendimento: {canais.horario}</p>}
            </> : <p>Os canais de atendimento ainda não foram publicados neste ambiente. Fale com a pessoa da Kidmais que acompanha a implantação da sua empresa.</p>}
        </section>
        <section className={workspace.card} aria-labelledby="t-antes">
            <h2 id="t-antes">Para resolver mais rápido</h2>
            <ul>
                <li>Diga o nome da empresa e a tela em que estava.</li>
                <li>Conte o que tentou fazer e o que apareceu.</li>
                <li>Se a mensagem de erro mostrar um código de referência, informe o código.</li>
            </ul>
            <p className={workspace.muted}>A equipe Kidmais nunca pede a sua senha.</p>
        </section>
        <section className={workspace.card} aria-labelledby="t-atalhos">
            <h2 id="t-atalhos">Atalhos</h2>
            <ul>
                <li><Link href="/admin/inicio">Primeiros passos</Link></li>
                <li><Link href="/admin/assinatura">Assinatura, teste grátis e cancelamento</Link></li>
                <li><Link href="/admin/perfil">Meu perfil e senha</Link></li>
            </ul>
        </section>
    </main>;
}
