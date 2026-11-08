import Link from 'next/link';
import { notFound } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import ajuda from '@/components/admin/ajuda/ajuda.module.css';
import { artigoDaCentral, blocos, type Trecho } from '@/lib/suporte/central';
import { ROTA_AJUDA } from '@/lib/suporte/rota';
import { carregarCorpusAprovado } from '@/lib/conhecimento/carregar';
import { hojeBrasilia } from '@/lib/financeiro/calculos';

// O corpus é relido a cada pedido (situação e vigência valem na hora, como no MCP).
export const dynamic = 'force-dynamic';

function linha(trechos: Trecho[]) {
    return <>{trechos.map((t, i) => t.tipo === 'negrito' ? <strong key={i}>{t.texto}</strong> : t.tipo === 'link' ? <Link key={i} href={t.href}>{t.texto}</Link> : t.texto)}</>;
}

/** Artigo da central de ajuda: só aprovado, vigente e público; qualquer outro id responde 404, sem dizer o motivo. */
export default async function Artigo({ params }: { params: Promise<{ artigo: string }> }) {
    const { artigo } = await params;
    const doc = /^[a-z0-9][a-z0-9-]{1,63}$/.test(artigo) ? artigoDaCentral(carregarCorpusAprovado(), hojeBrasilia(), artigo) : null;
    if (!doc) notFound();
    return <main className={`${admin.page} ${ajuda.artigo}`} data-artigo={doc.id}>
        <p><Link href={ROTA_AJUDA}>← Ajuda e suporte</Link></p>
        <h1>{doc.titulo}</h1>
        {doc.secoes.map((secao) => <section key={secao.indice} id={`secao-${secao.indice}`} className={workspace.card} aria-labelledby={`t-secao-${secao.indice}`}>
            <h2 id={`t-secao-${secao.indice}`}>{secao.titulo}</h2>
            {blocos(secao.texto).map((b, i) => b.tipo === 'p'
                ? <p key={i}>{linha(b.trechos)}</p>
                : b.tipo === 'imagem'
                    // eslint-disable-next-line @next/next/no-img-element -- captura estática de public/ajuda, sem otimização de imagem
                    ? <img key={i} className={ajuda.imagem} src={b.src} alt={b.alt} loading="lazy" decoding="async" />
                    : b.tipo === 'video'
                        ? <video key={i} className={ajuda.video} controls preload="none" poster={b.capa} aria-label={b.alt}><source src={b.src} type="video/mp4" /><track kind="captions" src={b.legenda} srcLang="pt-BR" label="Português" default /></video>
                        : b.tipo === 'ul'
                            ? <ul key={i}>{b.itens.map((item, j) => <li key={j}>{linha(item)}</li>)}</ul>
                            : <ol key={i}>{b.itens.map((item, j) => <li key={j}>{linha(item)}</li>)}</ol>)}
        </section>)}
        <p className={workspace.muted} data-nao-resolveu>Não resolveu? <Link href={`${ROTA_AJUDA}#t-falar`}>Fale com a equipe iA.Fest</Link>.</p>
    </main>;
}
