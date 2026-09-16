import Link from 'next/link';
import { linksContratoDaFesta } from '@/lib/festas/apresentacao';
import styles from './festa.module.css';

export default function RevisaoPendente({ contratoId, festaId, cancelado, versoes }: {
    contratoId: string; festaId: string; cancelado: boolean;
    versoes: { id: string; [key: string]: unknown }[];
}) {
    const revisao = versoes.find(v => v.em_preparacao === true &&
        ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(String(v.estado)));
    if (cancelado || !contratoId || !revisao) return null;
    return <section className={styles.card} aria-label="Revisão contratual pendente">
        <strong>Revisão contratual em andamento — V{String(revisao.numero_versao)}</strong>
        <p>A versão vigente continua valendo até a formalização da revisão pelas duas partes.</p>
        <Link href={linksContratoDaFesta(contratoId, revisao.id, festaId).contrato}>Abrir revisão em andamento</Link>
    </section>;
}
