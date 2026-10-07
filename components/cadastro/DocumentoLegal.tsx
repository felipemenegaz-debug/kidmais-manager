import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { fonteAdmin } from '@/components/admin/fonte';
import tokens from '@/components/admin/tokens.module.css';
import { hashDocumento, type TextoLegal } from '@/lib/cadastro/documentos-legais';

/** Termos e privacidade: o texto exibido é exatamente o que o hash do aceite cobre. */
export default function DocumentoLegal({ documento }: { documento: TextoLegal }) {
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}>
        <main className={admin.page} style={{ maxWidth: 820, margin: '0 auto' }}>
            {documento.minuta && <p role="status" style={{ padding: '12px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, #FF7A3D 35%, transparent)', background: 'color-mix(in srgb, #FF7A3D 8%, transparent)' }}>
                <strong>Minuta para homologação.</strong> Este texto ainda passa por revisão jurídica e não é a versão definitiva.</p>}
            <h1>{documento.titulo}</h1>
            <p className={workspace.muted}>Versão {documento.versao} · impressão digital {hashDocumento(documento).slice(0, 12)}</p>
            {documento.secoes.map((s) => <section key={s.titulo} className={workspace.card} style={{ marginTop: 16 }}>
                <h2>{s.titulo}</h2>
                {s.paragrafos.map((p, i) => <p key={i}>{p}</p>)}
            </section>)}
            <p style={{ marginTop: 24 }}><Link href="/planos">Planos</Link> · <Link href="/cadastro">Criar conta</Link> · <Link href="/admin/login">Entrar</Link></p>
        </main>
    </div>;
}
