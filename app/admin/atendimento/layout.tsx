import { connection } from 'next/server';
import { rotuloAmbiente } from '@/lib/whatsapp/atendimento/rotulo-ambiente';
import styles from '@/components/admin/atendimento/atendimento.module.css';

/** Rodada 42: o rótulo do ambiente (demonstração, homologação) acima de Atendimento, Biblioteca e Configurações. */
export default async function AtendimentoLayout({ children }: { children: React.ReactNode }) {
  await connection(); // lido na requisição (variável do servidor), não no build
  const rotulo = rotuloAmbiente();
  return <>{rotulo && <p className={styles.seloAmbiente} role="note" aria-label={`Ambiente: ${rotulo}`}>{rotulo}</p>}{children}</>;
}
