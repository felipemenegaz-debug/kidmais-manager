import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { cadastrarEmpresa, MENSAGEM_CNPJ_EXISTENTE } from '@/lib/cadastro/publico';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cadastro de empresa pela pessoa autenticada (primeira empresa ou mais uma). CNPJ já cadastrado responde 409 com a
 * mesma mensagem neutra, sem nenhum dado da empresa existente.
 */
export async function POST(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const r = await cadastrarEmpresa(sessao, await lerJson(request), contextoDaRequisicao(request));
        if (r.situacao === 'CNPJ_EXISTENTE')
            return responder({ ok: false, erro: MENSAGEM_CNPJ_EXISTENTE, codigo: 'CNPJ_EXISTENTE' }, 409);
        return responder({ ok: true, data: r }, r.repetido ? 200 : 201);
    }
    catch (error) {
        return falhar(error);
    }
}
