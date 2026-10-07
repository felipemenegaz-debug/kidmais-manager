'use client';
import Link from 'next/link';
import { GerenciarMensagensProntas } from './MensagensProntas';
import styles from './atendimento.module.css';

/** Tela própria da biblioteca do atendimento: cadastro, estados, arquivos e autorização do Wall-e. */
export default function BibliotecaAtendimento() {
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Biblioteca do atendimento</h1><p>Mensagens prontas, fotos, vídeos e PDFs da equipe e do Wall-e.</p></div><div className={styles.acoes}><Link href="/admin/atendimento">Voltar ao atendimento</Link><Link href="/admin/atendimento/configuracao">Configuração</Link></div></header>
    <GerenciarMensagensProntas pagina />
  </main>;
}
