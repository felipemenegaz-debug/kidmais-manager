'use client';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { abas, type AbaId } from '@/lib/site/abas';
import { Recurso } from './elementos';
import { cx } from './estilos';

const chaves = Object.keys(abas) as AbaId[];
export default function Abas({ telas }: { telas: Record<AbaId, ReactNode> }) {
    const [ativa, setAtiva] = useState<AbaId>('orcamento');
    const botoes = useRef<(HTMLButtonElement | null)[]>([]);
    function navegar(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        let proxima: number;
        switch (event.key) {
            case 'ArrowRight': proxima = (index + 1) % chaves.length; break;
            case 'ArrowLeft': proxima = (index + chaves.length - 1) % chaves.length; break;
            case 'Home': proxima = 0; break;
            case 'End': proxima = chaves.length - 1; break;
            default: return;
        }
        event.preventDefault(); setAtiva(chaves[proxima]); botoes.current[proxima]?.focus();
    }
    return <section className={cx('block')} id="recursos" aria-labelledby="t-recursos"><div className={cx('wrap')}>
        <div className={cx('head')}><div className={cx('eyebrow')}>Recursos</div><h2 id="t-recursos">O que acontece nos bastidores<br /><em>faz a festa acontecer.</em></h2></div>
        <div className={cx('stage')}>
            <div className={cx('story')}><div className={cx('tabs')} role="tablist" aria-label="Recursos do Kidmais Manager">
                {chaves.map((id, i) => <button type="button" role="tab" key={id} id={`tab-${id}`} aria-controls={`painel-${id}`} aria-selected={ativa === id} tabIndex={ativa === id ? 0 : -1} ref={el => { botoes.current[i] = el; }} onClick={() => setAtiva(id)} onKeyDown={event => navegar(event, i)}>{abas[id].nome}</button>)}
            </div><h3 id="recurso-titulo"><Recurso ids={abas[ativa].recursos}>{abas[ativa].titulo}</Recurso></h3><p id="recurso-descricao"><Recurso ids={abas[ativa].recursos}>{abas[ativa].texto}</Recurso></p><ul>{abas[ativa].itens.map(texto => <li key={texto}><Recurso ids={abas[ativa].recursos}>{texto}</Recurso></li>)}</ul></div>
            <div className={cx('preview')}>{chaves.map(id => <div key={id} id={`painel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} aria-describedby="recurso-titulo recurso-descricao" hidden={ativa !== id} tabIndex={0} className={cx('app')}>
                {telas[id]}
            </div>)}</div>
        </div>
    </div></section>;
}
