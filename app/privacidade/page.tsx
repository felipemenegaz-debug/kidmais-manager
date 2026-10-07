import type { Metadata } from 'next';
import DocumentoLegal from '@/components/cadastro/DocumentoLegal';
import { DOCUMENTOS } from '@/lib/cadastro/documentos-legais';

export const metadata: Metadata = { title: 'Aviso de privacidade — Kidmais Manager' };

export default function Page() {
    return <DocumentoLegal documento={DOCUMENTOS.PRIVACIDADE} />;
}
