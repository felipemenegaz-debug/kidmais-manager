import { NextRequest, NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { withTransaction } from '@/lib/db/postgres';
import { ClienteServiceError, isClienteServiceError } from '@/lib/clientes/services/errors';
import { consultarLogoPerfil } from '@/lib/perfil/cadastro-service';
import { prepararLogo } from '@/lib/perfil/logo';
import { LOGO_MAX_UPLOAD, LOGO_TIPOS } from '@/lib/perfil/logo-limites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function fail(error: unknown) {
    if (isClienteServiceError(error)) return json({ ok:false, erro:error.message, codigo:error.code },error.httpStatus);
    return json({ ok:false, erro:'Não foi possível preparar a logo.' },500);
}

export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const logoDataUrl = await withTransaction(tx => consultarLogoPerfil(tx, sessao.usuario_id));
        return json({ ok:true, data:{logoDataUrl} });
    } catch(error) { return fail(error); }
}

export async function POST(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        await withTransaction(tx => consultarLogoPerfil(tx, sessao.usuario_id, true));
        // Limite inclusive para envio sem Content-Length, antes de analisar multipart.
        const reader = request.body?.getReader();
        if (!reader) throw new ClienteServiceError('PERFIL_LOGO_INVALIDA','Selecione uma imagem.',400);
        const partes: Uint8Array[] = []; let tamanho = 0;
        try {
            while(true) {
                const parte = await reader.read(); if(parte.done) break;
                tamanho += parte.value.length;
                if(tamanho > LOGO_MAX_UPLOAD + 65536) throw new ClienteServiceError('PERFIL_LOGO_INVALIDA','A logo deve ter até 2 MB.',413);
                partes.push(parte.value);
            }
        } finally { await reader.cancel(); }
        let form: FormData;
        try { form = await new Request(request.url,{method:'POST',headers:request.headers,body:new Uint8Array(Buffer.concat(partes))}).formData(); }
        catch { throw new ClienteServiceError('PERFIL_LOGO_INVALIDA','Envie uma imagem PNG, JPEG ou WebP.',400); }
        const arquivo = form.get('arquivo');
        if (!(arquivo instanceof File) || form.getAll('arquivo').length !== 1 || !LOGO_TIPOS.includes(arquivo.type))
            throw new ClienteServiceError('PERFIL_LOGO_INVALIDA','Envie uma imagem PNG, JPEG ou WebP.',400);
        const logoDataUrl = await prepararLogo(Buffer.from(await arquivo.arrayBuffer()));
        // Apenas prepara os pixels. Persistência ocorre em Salvar rascunho / Revisar e aplicar.
        return json({ok:true,data:{logoDataUrl}});
    } catch(error) { return fail(error); }
}
