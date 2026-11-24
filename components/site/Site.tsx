import type { ReactNode } from 'react';
import Image from 'next/image';
import { situacaoCadastro } from '@/lib/cadastro/publico';
import { configuracaoSite, ROTA_SITE, type ConfiguracaoSite } from '@/lib/site/configuracao';
import { textoFundador } from '@/lib/site/fundador';
import { resumoCampanhaSite } from '@/lib/site/fundador-servidor';
import { cpfContratacaoLigado } from '@/lib/assinatura/documento-contratante';
import { fonteTexto, fonteTitulo } from './fonte';
import { cx } from './estilos';
import { BarraCelular, Cadastro, Contato } from './elementos';
import NavegacaoSite from './NavegacaoSite';
import FundoFesta from './FundoFesta';
import Planos from './Planos';
import { AntesDepois, ComoFunciona, Confianca, Duvidas, Hero, Modulos, Paineis, WallE } from './secoes';
import { PausaGlobal } from './interativos';
import { filtrar, modulos, paineis, RECURSOS_SECAO_WALLE, visivel } from '@/lib/site/catalogo';

/** Links do menu e do rodapé: só para seções que aparecem na página. */
export function linksSite(): [string, string][] {
    return [
        ...(filtrar(paineis).length ? [['recursos', 'Recursos'] as [string, string]] : []),
        ...(filtrar(modulos).length ? [['modulos', 'Módulos'] as [string, string]] : []),
        ...(visivel(RECURSOS_SECAO_WALLE) ? [['wall-e', 'Wall-e'] as [string, string]] : []),
        ['como-funciona', 'Como funciona'], ['confianca', 'Confiança'], ['planos', 'Planos'], ['duvidas', 'Dúvidas'],
    ];
}

function Marca({ href }: { href: string }) {
    return <a className={cx('brand')} href={href} aria-label="iA.Fest, início"><Image src="/site/iafest/simbolo.svg" alt="" aria-hidden="true" width={42} height={48} className={cx('brandSymbol')} unoptimized /><Image src="/site/iafest/logotipo.png" alt="iA.Fest" width={280} height={79} className={cx('brandLogo')} unoptimized /></a>;
}
function SecaoAnimada({ children }: { children: ReactNode }) {
    return <div className={cx('aberturaAnimada')} data-abertura-animada><FundoFesta />{children}</div>;
}
export function Rodape({ config, prefixo = '' }: { config: ConfiguracaoSite; prefixo?: string }) {
    return <footer><div className={cx('wrap')}><div className={cx('foot')}>
        <div><Marca href={`${prefixo}#topo`} /><p style={{ marginTop: 14, maxWidth: '34ch' }}>Gestão para buffets infantis e espaços de festa.</p></div>
        <div><h4>Produto</h4><ul>{linksSite().map(([id, nome]) => <li key={id}><a href={`${id === 'planos' ? '' : prefixo}#${id}`}>{nome}</a></li>)}<li><a href="/admin/login">Entrar</a></li></ul></div>
        <div><h4>Legal</h4><ul><li><a href="/termos">Termos de uso</a></li><li><a href="/privacidade">Privacidade</a></li><li><a href="/termos#cancelamento">Cancelamento</a></li><li><a href="/privacidade#tratamento-de-dados">Tratamento de dados</a></li></ul></div>
        <div><h4>Atendimento</h4><ul><li>E-mail: {config.emailHref ? <a href={config.emailHref}>{config.email}</a> : config.email}</li>{config.whatsapp !== 'a definir' && <li>WhatsApp: {config.whatsapp}</li>}{config.horario !== 'a definir' && <li>Horário: {config.horario}</li>}<li>Cancelamento pelos mesmos canais</li></ul></div>
    </div><div className={cx('legal')}><span>iA.Fest é um produto de {config.razaoSocial} · CNPJ {config.cnpj} · {config.endereco} · {config.encarregado !== 'a definir' ? <>Encarregado de dados: {config.encarregado}</> : <>Privacidade e dados pessoais: {config.email}</>}</span><span>© {new Date().getFullYear()} iA.Fest</span></div></div></footer>;
}
export default async function SiteVenda({ somentePlanos = false }: { somentePlanos?: boolean }) {
    const config = configuracaoSite();
    const fundador = textoFundador(await resumoCampanhaSite());
    const aberto = situacaoCadastro().ativo;
    const prefixo = somentePlanos ? ROTA_SITE : '';
    return <div className={`${cx('site')} ${fonteTitulo.variable} ${fonteTexto.variable}`} data-site-venda>
        <a href="#topo" className={cx('btn', 'skip')}>Ir para o conteúdo</a>
        <div className={cx('founder-bar')}><div className={cx('wrap')}><span>{fundador.barra.startsWith('Plano Fundador') ? fundador.barra : <><strong>Plano Fundador:</strong> {fundador.barra}</>}</span>{fundador.cta && <a href="#fundador">{fundador.cta}</a>}</div></div>
        <NavegacaoSite prefixo={prefixo} aberto={aberto} links={linksSite()} pausa={<PausaGlobal />}><Marca href={`${prefixo}#topo`} /></NavegacaoSite>
        <main id="topo" data-planos={somentePlanos || undefined}>
            {somentePlanos ? <div className={cx('wrap')} style={{ paddingTop: 48 }}><h1>Planos iA.Fest</h1></div> : <><SecaoAnimada><Hero aberto={aberto} config={config} /><AntesDepois /></SecaoAnimada><SecaoAnimada><Paineis /></SecaoAnimada><SecaoAnimada><Modulos /></SecaoAnimada>{visivel(RECURSOS_SECAO_WALLE) && <SecaoAnimada><WallE /></SecaoAnimada>}<SecaoAnimada><ComoFunciona /></SecaoAnimada><SecaoAnimada><Confianca /></SecaoAnimada></>}
            {somentePlanos ? <Planos publicado={config.precosPublicados} aberto={aberto} contato={config} fundador={fundador} cpf={cpfContratacaoLigado()} /> : <SecaoAnimada><Planos publicado={config.precosPublicados} aberto={aberto} contato={config} fundador={fundador} cpf={cpfContratacaoLigado()} /></SecaoAnimada>}
            {!somentePlanos && <><SecaoAnimada><Duvidas fundador={fundador} /></SecaoAnimada><SecaoAnimada><section className={cx('final')} id="demonstracao" aria-labelledby="t-final"><div className={cx('wrap', 'final-grid')}><div className={cx('final-copy')}><div className={cx('eyebrow')}>Próximo passo</div><h2 id="t-final">A próxima fase<br />do seu espaço começa aqui.</h2><p className={cx('lead')}>Comece o teste agora ou converse com a equipe. Mostramos o sistema com uma festa do jeito que o seu buffet trabalha.</p><div className={cx('actions')}><Cadastro aberto={aberto} contato={config} /></div></div>
                <div className={cx('panel', 'contactPanel')}><h3>Conheça o iA.Fest</h3><p>Fale com a equipe para conhecer o sistema e tirar suas dúvidas.</p><Contato config={config} /></div>
            </div></section></SecaoAnimada></>}
        </main>
        <Rodape config={config} prefixo={prefixo} /><Contato config={config} flutuante /><BarraCelular aberto={aberto} config={config} />
    </div>;
}
