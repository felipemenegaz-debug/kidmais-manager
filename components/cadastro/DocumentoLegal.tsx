import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { fonteAdmin } from '@/components/admin/fonte';
import tokens from '@/components/admin/tokens.module.css';
import { DOCUMENTOS, hashDocumento, type TextoLegal } from '@/lib/cadastro/documentos-legais';

const borda = '1px solid color-mix(in srgb, currentColor 18%, transparent)';

/** Destaca os marcadores de pendência da minuta ([…]) sem alterar o texto coberto pelo hash. */
function Texto({ texto }: { texto: string }) {
    return <>{texto.split(/(\[[^\]\n]+\])/).map((parte, i) => i % 2 === 1
        ? <mark key={i} data-marcador-pendente style={{ background: 'color-mix(in srgb, #FF7A3D 22%, transparent)', color: 'inherit', borderRadius: 4, padding: '0 2px' }}>{parte}</mark>
        : parte)}</>;
}

/** Termos, privacidade e Acordo de Tratamento de Dados: o texto exibido é exatamente o que o hash do aceite cobre. */
export default function DocumentoLegal({ documento }: { documento: TextoLegal }) {
    const outros = Object.values(DOCUMENTOS).filter((d) => d.documento !== documento.documento);
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}>
        <main className={admin.page} style={{ maxWidth: 820, margin: '0 auto' }}>
            {documento.minuta && <p role="status" style={{ padding: '12px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, #FF7A3D 35%, transparent)', background: 'color-mix(in srgb, #FF7A3D 8%, transparent)' }}>
                <strong>Minuta para homologação.</strong> Este texto ainda passa por revisão jurídica e não é a versão definitiva. Os trechos destacados entre colchetes estão pendentes.</p>}
            <h1>{documento.titulo}</h1>
            <p className={workspace.muted}>Versão {documento.versao} · impressão digital {hashDocumento(documento).slice(0, 12)}</p>
            {documento.secoes.map((s) => <section key={s.titulo} id={s.id} className={workspace.card} style={{ marginTop: 16 }}>
                <h2>{s.titulo}</h2>
                {s.paragrafos.map((p, i) => <p key={i}><Texto texto={p} /></p>)}
                {s.tabela && <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
                        <thead><tr>{s.tabela.colunas.map((c) => <th key={c} scope="col" style={{ textAlign: 'left', padding: '6px 8px', borderBottom: borda }}>{c}</th>)}</tr></thead>
                        <tbody>{s.tabela.linhas.map((l, i) => <tr key={i}>{l.map((c, j) => <td key={j} style={{ verticalAlign: 'top', padding: '6px 8px', borderBottom: borda }}><Texto texto={c} /></td>)}</tr>)}</tbody>
                    </table>
                </div>}
            </section>)}
            <p style={{ marginTop: 24 }}>{outros.map((d) => <span key={d.documento}><Link href={d.rota}>{d.titulo.replace(/ do Kidmais Manager$/, '')}</Link> · </span>)}<Link href="/planos">Planos</Link> · <Link href="/cadastro">Criar conta</Link> · <Link href="/admin/login">Entrar</Link></p>
        </main>
    </div>;
}
