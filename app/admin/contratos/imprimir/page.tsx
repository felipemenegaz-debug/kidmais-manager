'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from '@/components/admin/admin.module.css';
export default function ImprimirContrato() {
    const [ids, setIds] = useState<string[]>([]), [error, setError] = useState(''), [versao, setVersao] = useState(0);
    useEffect(() => { const p = new URLSearchParams(window.location.search); adminFetch('/api/admin/contratos/painel?contratoId=' + p.get('contratoId')).then(r => r.json()).then(b => { if (!b.ok)
        throw Error(b.erro); const v = b.data.versoes.find((x: {
        id: string;
    }) => x.id === p.get('versaoId')); if (!v?.documento_revisado_id)
        throw Error('Documento não disponível.'); setVersao(v.numero_versao); setIds([v.documento_revisado_id, ...b.data.assinaturas.filter((s: {
            contrato_versao_id: string;
        }) => s.contrato_versao_id === v.id).map((s: {
            comprovante_documento_id: string;
        }) => s.comprovante_documento_id)]); }).catch(e => setError(e.message)); }, []);
    return <main className={styles.page}><h1>Contrato completo — versão {versao}</h1><p>Conjunto documental original, sem alteração dos PDFs. Imprima cada objeto usando o botão da visualização PDF abaixo.</p><p role="alert">{error}</p>{ids.map((id, i) => <section key={id}><h2>{i === 0 ? 'Contrato principal' : `Comprovante ${i}`}</h2><a href={`/api/admin/contratos/documentos/${id}`} target="_blank" rel="noreferrer">Abrir para imprimir</a><iframe title={`Documento ${i + 1}`} src={`/api/admin/contratos/documentos/${id}`} style={{ width: '100%', height: '85vh' }}/></section>)}</main>;
}
