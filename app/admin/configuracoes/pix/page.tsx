import { redirect } from 'next/navigation';

// A chave Pix passou para o Perfil da empresa (seção Recebimento por Pix).
export default function Page() { redirect('/admin/configuracoes/perfil-empresa#recebimento-pix'); }
