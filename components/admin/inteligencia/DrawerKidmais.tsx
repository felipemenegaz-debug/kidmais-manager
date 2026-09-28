'use client';
import { useEffect, useRef, useState } from 'react';
import { CAPACIDADES_DISPONIVEIS, LIMITE_PERGUNTA } from './perguntas';
import type { Mensagem } from './conversa';
import RespostaAtencao from './RespostaAtencao';
import styles from './inteligencia.module.css';

const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function DrawerKidmais({ mensagens, aguardando, onPerguntar, onFechar }: {
  mensagens: readonly Mensagem[];
  aguardando: boolean;
  onPerguntar(texto: string): void;
  onFechar(): void;
}) {
  const [texto, setTexto] = useState('');
  const painelRef = useRef<HTMLElement>(null);
  const campoRef = useRef<HTMLInputElement>(null);
  const fimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    campoRef.current?.focus();
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function tecla(evento: KeyboardEvent) {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        onFechar();
        return;
      }
      if (evento.key !== 'Tab') return;
      const controles = Array.from(painelRef.current?.querySelectorAll<HTMLElement>(FOCAVEIS) ?? []);
      const primeiro = controles[0];
      const ultimo = controles[controles.length - 1];
      if (!primeiro || !ultimo) return;
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    }
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('keydown', tecla);
      document.body.style.overflow = overflowAnterior;
    };
  }, [onFechar]);

  useEffect(() => {
    fimRef.current?.scrollIntoView?.({ block: 'end' });
  }, [mensagens]);

  function enviar(pergunta: string) {
    if (!pergunta.trim() || aguardando) return;
    onPerguntar(pergunta);
    setTexto('');
  }

  return <div className={styles.camada}>
    <button type="button" className={styles.cortina} aria-label="Fechar Perguntar ao Kidmais" tabIndex={-1} onClick={onFechar} />
    <aside ref={painelRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="kidmais-drawer-titulo">
      <header className={styles.drawerTopo}>
        <div>
          <h2 id="kidmais-drawer-titulo">Perguntar ao Kidmais</h2>
          <p>Consultas somente leitura sobre os dados da sua empresa.</p>
        </div>
        <button type="button" className={styles.fechar} aria-label="Fechar" onClick={onFechar}>×</button>
      </header>

      <div className={styles.historico} aria-live="polite">
        {mensagens.length === 0 && <div className={styles.inicio}>
          <p>Posso responder agora:</p>
          {CAPACIDADES_DISPONIVEIS.map((item) => <button key={item.capacidade} type="button" className={styles.sugestao} onClick={() => enviar(item.pergunta)}>
            <strong>{item.pergunta}</strong><small>{item.escopo}</small>
          </button>)}
          <small className={styles.nota}>Outras análises serão liberadas aos poucos.</small>
        </div>}

        {mensagens.map((mensagem) => <article key={mensagem.id} className={styles.troca}>
          <p className={styles.pergunta}>{mensagem.pergunta}</p>
          {mensagem.fase === 'carregando' && <div className={styles.carregando} aria-busy="true"><span /><span /><p>Consultando o Financeiro…</p></div>}
          {mensagem.fase === 'resposta' && <RespostaAtencao dados={mensagem.dados} aoNavegar={onFechar} />}
          {mensagem.fase === 'erro' && <p className={styles.erro} role="alert">{mensagem.mensagem}</p>}
          {mensagem.fase === 'indisponivel' && <div className={styles.indisponivel}>
            <p>Essa análise ainda não está disponível no Kidmais.</p>
            <p>Por enquanto, consigo responder:</p>
            {CAPACIDADES_DISPONIVEIS.map((item) => <button key={item.capacidade} type="button" className={styles.sugestaoCurta} onClick={() => enviar(item.pergunta)}>{item.pergunta}</button>)}
          </div>}
        </article>)}
        <div ref={fimRef} />
      </div>

      <form className={styles.formulario} onSubmit={(evento) => { evento.preventDefault(); enviar(texto); }}>
        <label className={styles.oculto} htmlFor="kidmais-pergunta">Sua pergunta</label>
        <input ref={campoRef} id="kidmais-pergunta" value={texto} maxLength={LIMITE_PERGUNTA} autoComplete="off"
          placeholder="Pergunte sobre sua operação…" onChange={(evento) => setTexto(evento.target.value)} />
        <button type="submit" className={styles.enviar} disabled={!texto.trim() || aguardando}>Perguntar</button>
      </form>
    </aside>
  </div>;
}
