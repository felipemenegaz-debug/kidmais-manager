import { redirect } from 'next/navigation';

/** A importação da tabela de preços passou a ser uma aba de Importar documentos (23/10/2026). */
export default function Page() { redirect('/admin/configuracoes/importar-documentos?documento=tabela'); }
