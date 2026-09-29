import Link from 'next/link';
import { horaReferencia, rotuloFato, rotuloFonte, type RespostaLeitura as Dados } from './cliente-inteligencia';
import styles from './inteligencia.module.css';

/**
 * Resposta de leitura genérica: resumo, itens com link para a tela de origem, fatos classificados
 * (dado, cálculo, sem dados) e evidências. Nada aqui calcula: os textos e números vêm prontos do servidor.
 */
export default function RespostaLeitura({ dados, aoNavegar }: { dados: Dados; aoNavegar?: () => void }) {
  const hora = horaReferencia(dados.referencia.geradoEm);
  const fontes = dados.referencia.fontes.map(rotuloFonte).join(' · ');
  return <div className={styles.resposta}>
    <p className={dados.estado === 'sem_dados' ? styles.resumoVazio : styles.resumo}>{dados.resumo}</p>
    {dados.itens.length > 0 && <ul className={styles.itens}>
      {dados.itens.map((item) => <li key={item.id}>
        {item.destino
          ? <Link className={styles.item} href={item.destino} onClick={aoNavegar}>
            <span className={styles.ponto} data-prioridade={item.prioridade} aria-hidden="true" />
            <span className={styles.itemTexto}><strong>{item.titulo}</strong><small>{item.detalhe}</small></span>
            <span className={styles.seta} aria-hidden="true">›</span>
          </Link>
          : <div className={styles.item}>
            <span className={styles.ponto} data-prioridade={item.prioridade} aria-hidden="true" />
            <span className={styles.itemTexto}><strong>{item.titulo}</strong><small>{item.detalhe}</small></span>
          </div>}
      </li>)}
    </ul>}
    <details className={styles.evidencias}>
      <summary>Como cheguei nisso</summary>
      <ul>
        {dados.fatos.map((f, i) => <li key={`f${i}`} data-natureza={f.natureza}><span>{rotuloFato(f.natureza)}</span>{f.texto}</li>)}
        {dados.evidencias.map((e, i) => <li key={`e${i}`}><span>{e.rotulo}</span>{e.valor}</li>)}
      </ul>
    </details>
    <p className={styles.referencia}>{hora ? `Atualizado às ${hora} · ` : ''}{fontes}</p>
  </div>;
}
