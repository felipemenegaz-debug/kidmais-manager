'use client';
import { useEffect, useState } from 'react';
import styles from './site-publico.module.css';

/**
 * Ação principal sempre à mão no celular (só aparece em larguras estreitas, pelo CSS do contêiner). Some quando o
 * formulário de orçamento está visível ou quando um campo está em edição (teclado aberto), para nunca cobrir campos,
 * avisos ou o rodapé. `position: sticky` (não fixed): na prévia do editor ela fica dentro da área da prévia.
 */
export default function BarraAcaoCelular({ orcamento, whatsapp }: { orcamento: boolean; whatsapp: string | null }) {
  const [oculta, setOculta] = useState(false);
  useEffect(() => {
    const alvo = document.getElementById('orcamento');
    let formularioVisivel = false, editando = false;
    const atualizar = () => setOculta(formularioVisivel || editando);
    const obs = alvo && 'IntersectionObserver' in window
      ? new IntersectionObserver(([e]) => { formularioVisivel = e.isIntersecting; atualizar(); }, { threshold: 0.05 }) : null;
    if (alvo && obs) obs.observe(alvo);
    const foco = (e: FocusEvent) => { editando = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement; atualizar(); };
    const saiu = () => { editando = false; atualizar(); };
    document.addEventListener('focusin', foco);
    document.addEventListener('focusout', saiu);
    return () => { obs?.disconnect(); document.removeEventListener('focusin', foco); document.removeEventListener('focusout', saiu); };
  }, []);
  if (!orcamento && !whatsapp) return null;
  return <div className={styles.barraCelular} data-oculta={oculta} aria-hidden={oculta}>
    {orcamento && <a className={styles.botaoPrimario} href="#orcamento" tabIndex={oculta ? -1 : 0}>Pedir orçamento</a>}
    {whatsapp && <a className={styles.botaoSecundario} href={whatsapp} rel="nofollow noopener" tabIndex={oculta ? -1 : 0}>WhatsApp</a>}
  </div>;
}
