'use client';

import { useEffect, useRef, useState } from 'react';
import { iniciarFundo } from './fundo-festa';
import { cx } from './estilos';

/** Apenas decoração: conteúdo e links continuam renderizados pelo servidor. */
export default function FundoFesta() {
    const camada = useRef<HTMLDivElement>(null);
    const controle = useRef<ReturnType<typeof iniciarFundo> | null>(null);
    const [pausado, setPausado] = useState(false);
    useEffect(() => {
        if (!camada.current) return;
        const instancia = iniciarFundo(camada.current, setPausado);
        controle.current = instancia;
        return () => { instancia?.destruir(); controle.current = null; };
    }, []);
    return <>
        <div ref={camada} className={cx('fundoFesta')} aria-hidden="true" data-fundo-festa>
            <canvas data-gradiente className={cx('fundoGradiente')} />
            <canvas data-elementos />
            <canvas data-coracoes />
        </div>
        <button type="button" className={cx('fundoPausa')} aria-pressed={pausado}
            onClick={() => controle.current?.alternar()}>
            {pausado ? 'Ativar animação de fundo' : 'Pausar animação de fundo'}
        </button>
    </>;
}
