import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import ajuda from '@/components/admin/ajuda/ajuda.module.css';
import CodigoSuporte from '@/components/admin/ajuda/CodigoSuporte';
import { canaisSuporte } from '@/lib/suporte/canais';
import { artigosDaCentral, buscarNaCentral, CONSULTA_MAX, rotaDoArtigo } from '@/lib/suporte/central';
import { carregarCorpusAprovado } from '@/lib/conhecimento/carregar';
import { hojeBrasilia } from '@/lib/financeiro/calculos';

// Canais lidos a cada pedido: mudar o contato no ambiente não exige novo build.
export const dynamic = 'force-dynamic';

/**
 * Ajuda e suporte do Admin. Aberta também com o acesso comercial bloqueado e sem empresa ativa (AdminShell):
 * é a saída de quem não consegue usar o sistema. Só mostra canais configurados; nunca "a definir".
 * Central de ajuda (S3): artigos aprovados e públicos de `conhecimento/`, com busca pelo mesmo índice do MCP.
 */
export default async function Ajuda({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
    const canais = canaisSuporte();
    const bruto = (await searchParams)?.q;
    const consulta = (typeof bruto === 'string' ? bruto : '').trim().slice(0, CONSULTA_MAX);
    const corpus = carregarCorpusAprovado();
    const hoje = hojeBrasilia();
    const artigos = artigosDaCentral(corpus, hoje);
    const resultados = consulta ? buscarNaCentral(corpus, hoje, consulta) : [];
    return <main className={admin.page} data-ajuda>
        <h1>Ajuda e suporte</h1>
        {artigos.length > 0 && <section className={workspace.card} aria-labelledby="t-artigos" data-central>
            <h2 id="t-artigos">Como fazer</h2>
            <form className={ajuda.busca} method="get" action="/admin/ajuda" role="search">
                <label htmlFor="busca-ajuda">Buscar na ajuda</label>
                <input id="busca-ajuda" name="q" type="search" defaultValue={consulta} maxLength={CONSULTA_MAX} placeholder="Ex.: enviar contrato para assinatura" />
                <button type="submit">Buscar</button>
            </form>
            {consulta ? (resultados.length > 0
                ? <ul className={ajuda.resultados} data-resultados>{resultados.map((r) => <li key={r.href}><Link href={r.href}>{r.titulo} — {r.secao}</Link><p className={workspace.muted}>{r.trecho}</p></li>)}</ul>
                : <p data-sem-resultado>Nenhum artigo encontrado para “{consulta}”. Tente outras palavras ou fale com a equipe abaixo.</p>)
                : <ul className={ajuda.lista} data-lista>{artigos.map((a) => <li key={a.id}><Link href={rotaDoArtigo(a.id)}>{a.titulo}</Link></li>)}</ul>}
        </section>}
        <section className={workspace.card} aria-labelledby="t-falar" data-canais={canais.configurado ? 'configurados' : 'ausentes'}>
            <h2 id="t-falar">Fale com a equipe Kidmais</h2>
            {canais.configurado ? <>
                <ul>
                    {canais.whatsappHref && <li>WhatsApp: <CodigoSuporte numero={canais.whatsapp!} rotulo={canais.whatsapp!} hrefSemCodigo={canais.whatsappHref} /></li>}
                    {canais.emailHref && <li>E-mail: <a href={canais.emailHref} data-canal="email">{canais.email}</a></li>}
                </ul>
                {canais.horario && <p className={workspace.muted} data-canal="horario">Horário de atendimento: {canais.horario}</p>}
            </> : <p>Os canais de atendimento ainda não foram publicados neste ambiente. Fale com a pessoa da Kidmais que acompanha a implantação da sua empresa.</p>}
            <CodigoSuporte mostrarCodigo />
        </section>
        <section className={workspace.card} aria-labelledby="t-antes">
            <h2 id="t-antes">Para resolver mais rápido</h2>
            <ul>
                <li>Informe o código de suporte da sua empresa (aparece acima).</li>
                <li>Diga a tela em que estava.</li>
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
