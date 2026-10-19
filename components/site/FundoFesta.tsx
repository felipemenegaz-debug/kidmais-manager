'use client';

import { useEffect, useRef, useState } from 'react';
import { iniciarFundo } from './fundo-festa';
import { cx } from './estilos';

/** Apenas decoração: conteúdo e links continuam renderizados pelo servidor. */
export default function FundoFesta() {
    const camada = useRef<HTMLDivElement>(null);
    const controle = useRef<ReturnType<typeof iniciarFundo> | null>(null);
    const pausaSalva = useRef<boolean | undefined>(undefined);
    const [pausado, setPausado] = useState(false);
    useEffect(() => {
        if (!camada.current) return;
        const elemento = camada.current;
        const observar = new IntersectionObserver(([entrada]) => {
            if (entrada.isIntersecting && !controle.current) {
                controle.current = iniciarFundo(elemento, valor => {
                    pausaSalva.current = valor;
                    setPausado(valor);
                }, pausaSalva.current);
            } else if (!entrada.isIntersecting) {
                controle.current?.destruir(); controle.current = null;
            }
        }, { rootMargin: '160px 0px' });
        observar.observe(elemento.parentElement!);
        return () => { observar.disconnect(); controle.current?.destruir(); controle.current = null; };
    }, []);
    return <>
        <div ref={camada} className={cx('fundoFesta')} aria-hidden="true" data-fundo-festa>
            <div data-gradiente-container className={cx('fundoGradiente')} />
            <canvas data-elementos />
            <canvas data-coracoes />
        </div>
        <button type="button" className={cx('fundoPausa')} aria-pressed={pausado}
            onClick={() => controle.current?.alternar()}>
            {pausado ? 'Ativar animação desta seção' : 'Pausar animação desta seção'}
        </button>
    </>;
}
