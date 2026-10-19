'use client';
/* eslint-disable @next/next/no-img-element -- Imagens do próprio site já reprocessadas (WebP), sem otimizador remoto. */
import { useRef, type CSSProperties } from 'react';
import styles from './site-publico.module.css';

/**
 * Galeria navegável: faixa com rolagem por encaixe (toque/trackpad/teclado) + botões anterior/próxima. Sem dependências;
 * respeita "reduzir movimento" (sem rolagem suave).
 */
export default function GaleriaNavegavel({ fotos, nome }: { fotos: Array<{ src: string; legenda: string }>; nome: string }) {
  const faixa = useRef<HTMLUListElement>(null);
  function mover(sentido: 1 | -1) {
    const el = faixa.current;
    if (!el) return;
    const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: sentido * Math.max(240, el.clientWidth * 0.8), behavior: suave ? 'smooth' : 'auto' });
  }
  return <div className={styles.galeriaNav} data-poucas={fotos.length <= 3 ? 'sim' : 'nao'}>
    <ul ref={faixa} className={styles.galeriaFaixa} data-quantidade={fotos.length} style={{ '--colunas': Math.min(fotos.length, 3) } as CSSProperties} tabIndex={0} aria-label={`Fotos do ${nome}. Use as setas do teclado para rolar.`}>
      {fotos.map((f, i) => <li key={f.src}>
        <figure>
          <img src={f.src} alt={f.legenda || `Foto ${i + 1} do ${nome}`} loading="lazy" decoding="async" width={640} height={480} />
          {f.legenda && <figcaption>{f.legenda}</figcaption>}
        </figure>
      </li>)}
    </ul>
    {fotos.length > 1 && <div className={styles.galeriaControles}>
      <button type="button" onClick={() => mover(-1)} aria-label="Fotos anteriores">‹</button>
      <button type="button" onClick={() => mover(1)} aria-label="Próximas fotos">›</button>
    </div>}
  </div>;
}
