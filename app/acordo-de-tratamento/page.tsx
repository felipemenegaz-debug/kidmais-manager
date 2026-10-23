import type { Metadata } from 'next';
import DocumentoLegal from '@/components/cadastro/DocumentoLegal';
import { DOCUMENTOS } from '@/lib/cadastro/documentos-legais';

export const metadata: Metadata = {
    title: 'Acordo de Tratamento de Dados — Kidmais Manager',
    description: 'Minuta do Acordo de Tratamento de Dados do Kidmais Manager, anexo dos Termos de uso: instruções, segurança, suboperadores, incidentes e término.',
};

export default function Page() {
    return <DocumentoLegal documento={DOCUMENTOS.DPA} />;
}
