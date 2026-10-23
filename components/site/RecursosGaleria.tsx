'use client';
import Image from 'next/image';
import { useRef, useState, type KeyboardEvent } from 'react';
import { galeria } from '@/lib/site/galeria';
import { cx } from './estilos';

export default function RecursosGaleria() {
    const [ativo, setAtivo] = useState(0);
    const [imagem, setImagem] = useState(0);
    const [ampliada, setAmpliada] = useState(false);
    const botoes = useRef<(HTMLButtonElement | null)[]>([]);
    const recurso = galeria[ativo];
    const captura = recurso.imagens[imagem];
    function selecionar(indice: number) {
        setAtivo((indice + galeria.length) % galeria.length);
        setImagem(0);
        setAmpliada(false);
    }
    function navegar(event: KeyboardEvent<HTMLButtonElement>, indice: number) {
        const proxima = event.key === 'ArrowRight' ? (indice + 1) % galeria.length
            : event.key === 'ArrowLeft' ? (indice + galeria.length - 1) % galeria.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? galeria.length - 1 : null;
        if (proxima === null) return;
        event.preventDefault(); selecionar(proxima); botoes.current[proxima]?.focus();
    }
    return <section className={cx('block')} id="recursos" aria-labelledby="t-recursos"><div className={cx('wrap')}>
        <div className={cx('head')}><div className={cx('eyebrow')}>Recursos</div><h2 id="t-recursos">Tudo para cuidar do seu buffet.</h2><p>Da primeira conversa ao fechamento da festa.</p></div>
        <div className={cx('galeriaTabs')} role="tablist" aria-label="Recursos do iA.Fest">
            {galeria.map((item, indice) => <button type="button" role="tab" id={`recurso-tab-${item.id}`} aria-controls="recurso-painel" aria-selected={indice === ativo} tabIndex={indice === ativo ? 0 : -1} key={item.id} ref={el => { botoes.current[indice] = el; }} onClick={() => selecionar(indice)} onKeyDown={event => navegar(event, indice)}>{item.nome}</button>)}
        </div>
        <div className={cx('galeriaPainel', ampliada ? 'galeriaAmpliada' : '')} role="tabpanel" id="recurso-painel" aria-labelledby={`recurso-tab-${recurso.id}`} tabIndex={0}>
            <div className={cx('galeriaTexto')}><div className={cx('eyebrow')}>{recurso.nome}</div><h3>{recurso.titulo}</h3><p>{recurso.texto}</p><ul>{recurso.itens.map(item => <li key={item}>{item}</li>)}</ul>
                {recurso.id === 'marketing' && <p className={cx('galeriaExemplo')}>Exemplo de mensagem: “Olá, Marina! Obrigado por celebrar a festa da Sofia com a gente. Como foi a experiência? Sua avaliação nos ajuda a melhorar.”</p>}
                {recurso.id === 'copiloto' && <p className={cx('galeriaExemplo')}>Exemplo de pedido: “Crie o pacote Jardim para no mínimo 30 convidados, com duração de 4 horas.” O cadastro é revisado e confirmado por você.</p>}
            </div>
            <div className={cx('galeriaTela')}>
                <div className={cx('galeriaBarra')}><span aria-hidden="true">● ● ●</span><span>iA.Fest · Tela do sistema</span></div>
                <button type="button" className={cx('galeriaZoom')} aria-expanded={ampliada} aria-controls="recurso-captura" onClick={() => setAmpliada(!ampliada)}>{ampliada ? 'Reduzir tela' : 'Ampliar tela'}</button>
                <h4>{recurso.tela}</h4><p className={cx('galeriaLegenda')}>{recurso.legenda}</p>
                <div id="recurso-captura" className={cx('galeriaCaptura', captura.crop && !ampliada ? 'galeriaRecorte' : '', recurso.id === 'convites' && imagem === 0 ? 'galeriaConvite' : '')}>
                    <Image key={captura.src} src={captura.src} alt={captura.alt} width={captura.width} height={captura.height} unoptimized />
                </div>
                {recurso.imagens.length > 1 && <><div className={cx('galeriaPontos')} role="group" aria-label="Imagens do recurso">{recurso.imagens.map((slide, indice) => <button type="button" key={slide.src} aria-label={`Imagem ${indice + 1}: ${slide.label}`} aria-pressed={indice === imagem} onClick={() => setImagem(indice)}>●</button>)}</div><p className={cx('galeriaLegenda')} aria-live="polite">{imagem + 1} / {recurso.imagens.length} · {captura.label}{captura.crop && !ampliada ? ' · Detalhe da seleção' : ''}</p></>}
                <p className={cx('galeriaNota')}>{recurso.nota}</p>
            </div>
        </div>
        <div className={cx('galeriaRodape')}><span>Capturas com dados ilustrativos</span><div><button type="button" aria-label="Recurso anterior" onClick={() => selecionar(ativo - 1)}>‹</button><span aria-live="polite">{String(ativo + 1).padStart(2, '0')} / {galeria.length}</span><button type="button" aria-label="Próximo recurso" onClick={() => selecionar(ativo + 1)}>›</button></div></div>
    </div></section>;
}
