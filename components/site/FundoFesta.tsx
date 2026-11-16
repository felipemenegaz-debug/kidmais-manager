'use client';

import { useEffect, useRef } from 'react';
import { iniciarFundo } from './fundo-festa';
import { cx } from './estilos';
import { EVENTO_PAUSA, pausaAtual } from './pausa';

/** Apenas decoração: conteúdo e links continuam renderizados pelo servidor. A pausa é única na página (PausaGlobal). */
export default function FundoFesta() {
    const camada = useRef<HTMLDivElement>(null);
    const controle = useRef<ReturnType<typeof iniciarFundo> | null>(null);
    useEffect(() => {
        if (!camada.current) return;
        const elemento = camada.current;
        const observar = new IntersectionObserver(([entrada]) => {
            if (entrada.isIntersecting && !controle.current) {
                controle.current = iniciarFundo(elemento, () => {}, pausaAtual());
            } else if (!entrada.isIntersecting) {
                controle.current?.destruir(); controle.current = null;
            }
        }, { rootMargin: '160px 0px' });
        observar.observe(elemento.parentElement!);
        const pausa = (evento: Event) => controle.current?.definir((evento as CustomEvent<boolean>).detail);
        window.addEventListener(EVENTO_PAUSA, pausa);
        return () => { observar.disconnect(); window.removeEventListener(EVENTO_PAUSA, pausa); controle.current?.destruir(); controle.current = null; };
    }, []);
    return <div ref={camada} className={cx('fundoFesta')} aria-hidden="true" data-fundo-festa>
        <div data-gradiente-container className={cx('fundoGradiente')} />
        <canvas data-elementos />
        <canvas data-coracoes />
    </div>;
}
