import { redirect } from 'next/navigation';

/** O modelo de contrato passou a ser uma aba de Importar documentos (23/10/2026). */
export default function Page() { redirect('/admin/configuracoes/importar-documentos?documento=contrato'); }
