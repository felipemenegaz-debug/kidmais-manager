import Link from 'next/link';
import { evidenciaTexto, horaReferencia, rotuloFonte, type AtencaoHoje } from './cliente-inteligencia';
import styles from './inteligencia.module.css';

/**
 * Resposta da capacidade `atencao_hoje`: resumo, indicadores com link para a tela de origem
 * e evidências agregadas. Os indicadores são independentes e não são somados aqui.
 * Sem hooks: é usada pelo card do Dashboard e pelo drawer.
 */
export default function RespostaAtencao({ dados, aoNavegar }: { dados: AtencaoHoje; aoNavegar?: () => void }) {
  const fonte = rotuloFonte(dados.referencia.fonte);
  const hora = horaReferencia(dados.referencia.geradoEm);
  return <div className={styles.resposta}>
    <p className={dados.estado === 'sem_dados' ? styles.resumoVazio : styles.resumo}>{dados.resumo}</p>
    {dados.itens.length > 0 && <ul className={styles.itens}>
      {dados.itens.map((item) => <li key={item.tipo}>
        <Link className={styles.item} href={item.destino} onClick={aoNavegar}>
          <span className={styles.ponto} data-prioridade={item.prioridade} aria-hidden="true" />
          <span className={styles.itemTexto}><strong>{item.titulo}</strong><small>{item.detalhe}</small></span>
          <span className={styles.seta} aria-hidden="true">›</span>
        </Link>
      </li>)}
    </ul>}
    <details className={styles.evidencias}>
      <summary>Dados usados</summary>
      <p className={styles.referencia}>{hora ? `Atualizado às ${hora} · ` : ''}{fonte}</p>
      <ul>
        <li><span>Fonte</span>{fonte}</li>
        {dados.itens.map((item) => <li key={item.tipo}><span>{item.titulo}</span>{evidenciaTexto(item)}</li>)}
        {dados.itens.length > 1 && <li className={styles.observacao}>Cada indicador é independente: “Valores a receber” já inclui os vencidos e os que vencem hoje.</li>}
      </ul>
    </details>
  </div>;
}
