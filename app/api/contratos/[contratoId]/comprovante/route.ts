import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { lerComprovantePublico } from '@/lib/contratos/services/contrato-publico.service';
import { erroContratoPublico } from '../../route-utils';
const schema = z.object({ provaToken: z.string().min(32).max(512), acessoToken: z.string().min(32).max(2048), documentoId: z.string().uuid() }).strict();
export async function POST(request: NextRequest, context: {
    params: Promise<{
        contratoId: string;
    }>;
}) {
    try {
        const body = schema.parse(await request.json()), contratoId = z.string().uuid().parse((await context.params).contratoId);
        const doc = await lerComprovantePublico({ contratoId, ...body });
        return new NextResponse(new Uint8Array(doc.conteudo_pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="comprovante-${doc.id}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return NextResponse.json({ ok: false, erro: 'Dados inválidos.' }, { status: 400 });
        return erroContratoPublico(error);
    }
}
