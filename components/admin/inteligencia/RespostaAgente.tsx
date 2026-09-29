'use client';
import { useState } from 'react';
import { pareceAtencaoHoje, type SecaoAgente, type SugestaoAgente } from './cliente-inteligencia';
import RespostaAtencao from './RespostaAtencao';
import RespostaLeitura from './RespostaLeitura';
import styles from './inteligencia.module.css';

/**
 * Resposta de um agente: resumo, as leituras que ele fez (cada uma com a própria evidência) e, se houver, uma
 * SUGESTÃO de texto. A sugestão nunca é enviada: o operador copia, revisa e usa pelo canal oficial.
 */
export default function RespostaAgente({ agente, resumo, secoes, sugestao, aoNavegar }: {
  agente: { id: string; nome: string };
  resumo: string;
  secoes: SecaoAgente[];
  sugestao: SugestaoAgente | null;
  aoNavegar?: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  }
  return <div className={styles.resposta} data-agente={agente.id}>
    <p className={styles.agenteNome}>{agente.nome}</p>
    <p className={styles.resumo}>{resumo}</p>
    {secoes.map((s) => <section key={s.titulo} className={styles.secaoAgente} aria-label={s.titulo}>
      <h3>{s.titulo}</h3>
      {pareceAtencaoHoje(s.dados) ? <RespostaAtencao dados={s.dados} aoNavegar={aoNavegar} /> : <RespostaLeitura dados={s.dados} aoNavegar={aoNavegar} />}
    </section>)}
    {sugestao && <section className={styles.sugestaoTexto} aria-label={`Sugestão: ${sugestao.titulo}`}>
      <p className={styles.complementoTitulo}>{sugestao.titulo}</p>
      <blockquote>{sugestao.texto}</blockquote>
      {sugestao.pendentes.length > 0 && <p className={styles.nota}>Complete antes de usar: {sugestao.pendentes.join(', ')}.</p>}
      <p className={styles.nota}>{sugestao.aviso}</p>
      <div className={styles.decisao}>
        <button type="button" className={styles.botaoDiscreto} onClick={() => copiar(sugestao.texto)}>Copiar texto</button>
        <span role="status" className={styles.nota}>{copiado ? 'Texto copiado.' : ''}</span>
      </div>
    </section>}
  </div>;
}
