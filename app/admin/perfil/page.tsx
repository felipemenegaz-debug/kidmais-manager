import Link from 'next/link';
import PerfilSenha from '@/components/admin/PerfilSenha';
import { mcpAtivo } from '@/lib/integracoes/mcp/config';

export const dynamic = 'force-dynamic';

export default function Page() {
    // Canal MCP (105): o atalho só aparece com o canal ligado neste ambiente; a página em si também informa quando está desligado.
    return <>
        <PerfilSenha />
        {mcpAtivo(process.env) && <p style={{ padding: '0 32px 32px' }} data-atalho-conexoes-ia><Link href="/admin/conexoes-ia">Assistentes conectados (ChatGPT, Claude)</Link></p>}
    </>;
}
