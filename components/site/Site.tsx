import type { ReactNode } from 'react';
import { situacaoCadastro } from '@/lib/cadastro/publico';
import { configuracaoSite, ROTA_SITE, type ConfiguracaoSite } from '@/lib/site/configuracao';
import { comercial } from '@/lib/site/catalogo';
import { abas, type AbaId } from '@/lib/site/abas';
import { fonteTexto, fonteTitulo } from './fonte';
import { cx } from './estilos';
import { Cadastro, Contato } from './elementos';
import Abas from './Abas';
import Planos from './Planos';
import { TelaIlustrativa } from './telas';
import { AntesDepois, ComoFunciona, Confianca, Convite, Diferenciais, Duvidas, Hero, WallE } from './secoes';

function Marca({ href }: { href: string }) {
    return <a className={cx('brand')} href={href} aria-label="Kidmais Manager, início"><span className={cx('mark')}>+</span><span>kidmais<small>MANAGER</small></span></a>;
}
export function Rodape({ config, prefixo = '' }: { config: ConfiguracaoSite; prefixo?: string }) {
    return <footer><div className={cx('wrap')}><div className={cx('foot')}>
        <div><Marca href={`${prefixo}#topo`} /><p style={{ marginTop: 14, maxWidth: '34ch' }}>Gestão para buffets infantis e espaços de festa.</p></div>
        <div><h4>Produto</h4><ul><li><a href={`${prefixo}#diferenciais`}>Diferenciais</a></li><li><a href={`${prefixo}#wall-e`}>Wall-e</a></li><li><a href={`${prefixo}#convite`}>Convite</a></li><li><a href="#planos">Planos</a></li><li><a href="/admin/login">Entrar</a></li></ul></div>
        <div><h4>Legal</h4><ul><li><a href="/termos">Termos de uso</a></li><li><a href="/privacidade">Privacidade</a></li><li><a href="/termos#cancelamento">Cancelamento</a></li><li><a href="/privacidade#tratamento-de-dados">Tratamento de dados</a></li></ul></div>
        <div><h4>Atendimento</h4><ul><li>E-mail: {config.email}</li><li>WhatsApp: {config.whatsapp}</li><li>Horário: {config.horario}</li><li>Cancelamento pelos mesmos canais</li></ul></div>
    </div><div className={cx('legal')}><span>Kidmais Manager é um produto de {config.razaoSocial} · CNPJ {config.cnpj} · {config.endereco} · Encarregado de dados: {config.encarregado}</span><span>© 2026 Kidmais Manager</span></div></div></footer>;
}
export default function SiteVenda({ somentePlanos = false }: { somentePlanos?: boolean }) {
    const config = configuracaoSite();
    const aberto = situacaoCadastro().ativo;
    const prefixo = somentePlanos ? ROTA_SITE : '';
    const telas = Object.fromEntries((Object.keys(abas) as AbaId[]).map(id => [id, <TelaIlustrativa key={id} aba={id} />])) as Record<AbaId, ReactNode>;
    return <div className={`${cx('site')} ${fonteTitulo.variable} ${fonteTexto.variable}`} data-site-venda>
        <a href="#topo" className={cx('btn', 'skip')}>Ir para o conteúdo</a>
        <div className={cx('founder-bar')}><div className={cx('wrap')}><span><strong>Plano Fundador:</strong> {comercial.fundador.descontoPercentual}% de desconto por {comercial.fundador.meses} meses para os {comercial.fundador.vagas} primeiros buffets.</span><a href="#fundador">Quero uma vaga →</a></div></div>
        <header className={cx('header')}><div className={cx('wrap')}><Marca href={`${prefixo}#topo`} /><nav className={cx('nav')} aria-label="Principal">
            <a href={`${prefixo}#diferenciais`}>Diferenciais</a><a href={`${prefixo}#recursos`}>Recursos</a><a href={`${prefixo}#wall-e`}>Wall-e</a><a href={`${prefixo}#convite`}>Convite</a><a href="#planos">Planos</a><a href={`${prefixo}#duvidas`}>Dúvidas</a><a className={cx('login')} href="/admin/login">Entrar</a>
            {aberto && <a className={cx('btn', 'btn-primary', 'btn-sm')} href="/cadastro">Testar grátis</a>}
        </nav></div></header>
        <main id="topo" data-planos={somentePlanos || undefined}>
            {somentePlanos ? <div className={cx('wrap')} style={{ paddingTop: 48 }}><h1>Planos Kidmais Manager</h1></div> : <><Hero aberto={aberto} config={config} /><AntesDepois /><Diferenciais /><Abas telas={telas} /><WallE /><Convite /><ComoFunciona /><Confianca /></>}
            <Planos publicado={config.precosPublicados} aberto={aberto} contato={{ contato: config.contato, fundador: config.fundador }} />
            {!somentePlanos && <><Duvidas config={config} /><section className={cx('final')} id="demonstracao" aria-labelledby="t-final"><div className={cx('wrap', 'final-grid')}><div className={cx('final-copy')}><div className={cx('eyebrow')}>Próximo passo</div><h2 id="t-final">A próxima fase<br />do seu espaço começa aqui.</h2><p className={cx('lead')}>Comece o teste agora ou converse com a equipe. Mostramos o sistema com uma festa do jeito que o seu buffet trabalha.</p><div className={cx('actions')}><Cadastro aberto={aberto} /></div></div>
                <div className={cx('panel', 'contactPanel')}><h3>Conheça o Kidmais</h3><p>Fale com a equipe para conhecer o sistema e tirar suas dúvidas.</p><Contato config={config} /></div>
            </div></section></>}
        </main>
        <Rodape config={config} prefixo={prefixo} /><Contato config={config} flutuante />
    </div>;
}
