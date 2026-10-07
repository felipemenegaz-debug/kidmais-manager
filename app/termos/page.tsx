import type { Metadata } from 'next';
import DocumentoLegal from '@/components/cadastro/DocumentoLegal';
import { DOCUMENTOS } from '@/lib/cadastro/documentos-legais';

export const metadata: Metadata = { title: 'Termos de uso — Kidmais Manager' };

export default function Page() {
    return <DocumentoLegal documento={DOCUMENTOS.TERMOS_USO} />;
}
