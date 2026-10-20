'use client';
import { useState, type ReactNode } from 'react';
import type { Ciclo } from '@/lib/site/catalogo';
import { cx } from './estilos';

/** Só a seleção é hidratada; os cards e os preços são renderizados no servidor. */
export default function CicloPlanos({ cabecalho, children }: { cabecalho: ReactNode; children: ReactNode }) {
    const [ciclo, setCiclo] = useState<Ciclo>('mensal');
    return <div data-ciclo={ciclo}><div className={cx('price-top')}>{cabecalho}
        <div className={cx('cycle')} role="group" aria-label="Ciclo de cobrança"><button type="button" aria-pressed={ciclo === 'mensal'} onClick={() => setCiclo('mensal')}>Mensal</button><button type="button" aria-pressed={ciclo === 'anual'} onClick={() => setCiclo('anual')}>Anual <span className={cx('save')}>2 meses grátis</span></button></div>
    </div>{children}</div>;
}
