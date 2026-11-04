'use client';
import Link from 'next/link';
import { tamanhoLegivel } from '@/lib/importacao-contrato/revisao';
import { contratoImportadoUrl, MENSAGEM_ORCAMENTO, proximoParaRevisar, ROTULO_ESTADO, type ItemLote, type Lote } from './fila-lote';
import styles from './importacao.module.css';
import real from './importacao-real.module.css';

/**
 * Envio em lote (L1): uma linha por arquivo. Mostra o estado de cada um e por que o lote parou ou pausou; a revisão de
 * cada contrato continua sendo a tela de revisão de sempre, um por vez.
 */
export default function FilaLote({ lote, ocupado, onRevisar, onTentar, onAbrirDeNovo, onRetirar, onContinuar, onNovoLote }: {
  lote: Lote;
  /** Há passo automático em andamento ou previsto. */
  ocupado: boolean;
  onRevisar(item: ItemLote): void;
  onTentar(item: ItemLote): void;
  /** Recuperação ambígua: a pessoa decide abrir de novo (`abrir` comum). */
  onAbrirDeNovo(item: ItemLote): void;
  onRetirar(item: ItemLote): void;
  onContinuar(): void;
  onNovoLote(): void;
}) {
  const orcamento = lote.pausas.includes('ORCAMENTO');
  const incertos = lote.pausas.filter((p) => p !== 'ORCAMENTO').length;
  const proximo = proximoParaRevisar(lote);
  const naFila = lote.itens.filter((i) => i.estado === 'NA_FILA').length;
  return <section className={`${styles.painel} ${real.lote}`} aria-labelledby="lote-titulo">
    <div className={real.loteTopo}>
      <h2 id="lote-titulo" className={styles.titulo}>Envio em lote</h2>
      <p className={styles.arquivo}>{lote.itens.length} arquivo(s){naFila ? ` · ${naFila} na fila` : ''}</p>
    </div>
    <div aria-live="polite">
      {lote.parada && <p className={real.loteParada} role="alert">{lote.parada.tipo === 'INVALIDAR' ? 'Envio interrompido: ' : 'Envio parado: '}{lote.parada.mensagem} Os arquivos já lidos continuam salvos.</p>}
      {!lote.parada && orcamento && <div className={styles.aviso}>
        <p className={real.loteMensagem}>{MENSAGEM_ORCAMENTO}</p>
        <button type="button" className={styles.linkBotao} onClick={onContinuar}>Continuar enviando</button>
      </div>}
      {!lote.parada && incertos > 0 && <p className={styles.aviso}>O envio está pausado até confirmar o resultado de {incertos === 1 ? 'um arquivo' : `${incertos} arquivos`}. Nada é reenviado sem conferir.</p>}
    </div>
    <ol className={real.loteLista}>
      {lote.itens.map((i) => <li key={i.id} className={real.loteItem} data-estado={i.estado}>
        <div className={real.loteNome}>
          <strong>{i.nome}</strong>
          <span>{tamanhoLegivel(i.tamanho)}{i.parcial ? ' · lido por regras' : ''}</span>
        </div>
        <span className={real.loteEstado} data-estado={i.estado}>{ROTULO_ESTADO[i.estado]}</span>
        {(i.retirada ?? i.motivo) && <p className={real.loteMensagem}>{i.retirada ?? i.motivo}</p>}
        <div className={real.loteAcoes}>
          {i.estado === 'PRONTO' && !i.concluido && <button type="button" className={styles.linkBotao} onClick={() => onRevisar(i)} aria-label={`Revisar ${i.nome}`}>Revisar</button>}
          {i.estado === 'ENCERRADO' && i.encerramento === 'IMPORTADA' && i.importacaoId && <Link className={styles.linkBotao} href={contratoImportadoUrl(i.importacaoId)} aria-label={`Ver contrato ${i.nome}`}>Ver contrato</Link>}
          {i.estado === 'LIDO_SEM_REVISAO' && i.exigeAbertura && !ocupado && <button type="button" className={styles.linkBotao} onClick={() => onAbrirDeNovo(i)} aria-label={`Abrir de novo ${i.nome}`}>Abrir de novo</button>}
          {podeTentar(i) && !ocupado && <button type="button" className={styles.linkBotao} onClick={() => onTentar(i)} aria-label={`Tentar de novo ${i.nome}`}>Tentar de novo</button>}
          {podeRetirar(i) && <button type="button" className={styles.linkBotao} onClick={() => onRetirar(i)} aria-label={`Retirar ${i.nome} do lote`}>Retirar do lote</button>}
        </div>
      </li>)}
    </ol>
    <div className={styles.acoesFinais}>
      {proximo && <button type="button" className={styles.primario} onClick={() => onRevisar(proximo)}>Próximo da fila</button>}
      {!ocupado && <button type="button" className={styles.fantasma} onClick={onNovoLote}>Enviar outros arquivos</button>}
    </div>
  </section>;
}

function podeTentar(i: ItemLote) {
  if (i.estado === 'FALHOU') return i.podeRepetir && !i.documentoId;
  if (i.estado === 'LIDO_SEM_REVISAO') return !i.exigeAbertura && (i.etapaIncerta === null || i.tentativas >= 2);
  return i.estado === 'INCERTO' && i.proximaConsultaEm === null && i.tentativas >= 2;
}

function podeRetirar(i: ItemLote) {
  return i.estado === 'INCERTO' || i.estado === 'LIDO_SEM_REVISAO' || i.estado === 'FALHOU' || i.estado === 'NA_FILA';
}
