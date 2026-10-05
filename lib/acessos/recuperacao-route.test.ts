import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from './teste-carregador.ts';

test('envio configurado não libera recuperação nem redefinição sem ativação explícita', async () => {
    const anterior = process.env.RECUPERACAO_SENHA_ATIVA;
    delete process.env.RECUPERACAO_SENHA_ATIVA;
    try {
        for (const caminho of ['recuperacao', 'redefinir']) {
            let agendados = 0;
            const route = carregarModulo(`app/api/acesso/${caminho}/route.ts`, {
                'next/server': {
                    after: () => { agendados += 1; },
                    NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
                },
                'lib/http/admin-crm-api': { verificarOrigem: () => undefined },
                'lib/acessos/email': { situacaoEmail: () => ({ configurado: true }) },
                'lib/acessos/recuperacao': {
                    validarPedidoPublico: (input: unknown) => input,
                    processarPedidoPublico: () => { throw Error('não processar pedido'); },
                    redefinirSenhaComToken: () => { throw Error('não trocar senha'); },
                },
            });
            const req = new Request(`https://admin.exemplo.test/api/acesso/${caminho}`, { method: 'POST', body: '{}' });
            const response = await (route.POST as (request: Request) => Promise<Response>)(req);
            assert.equal(response.status, 503);
            assert.equal(agendados, 0);
        }
    }
    finally {
        if (anterior === undefined) delete process.env.RECUPERACAO_SENHA_ATIVA;
        else process.env.RECUPERACAO_SENHA_ATIVA = anterior;
    }
});

test('recuperação sem envio configurado retorna 503 para qualquer conta, sem processar pedido nem anunciar envio', async () => {
    for (const email of ['existente@exemplo.test', 'inexistente@exemplo.test']) {
        let agendados = 0;
        let processados = 0;
        const route = carregarModulo('app/api/acesso/recuperacao/route.ts', {
            'next/server': {
                after: () => { agendados += 1; },
                NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
            },
            'lib/http/admin-crm-api': { verificarOrigem: () => undefined },
            'lib/acessos/email': { situacaoEmail: () => ({ configurado: false }) },
            'lib/acessos/recuperacao': {
                validarPedidoPublico: (input: unknown) => input,
                processarPedidoPublico: () => { processados += 1; },
                MENSAGEM_PEDIDO_PUBLICO: 'Mensagem de envio que não deve aparecer',
            },
        });
        const req = new Request('https://admin.exemplo.test/api/acesso/recuperacao', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
        });
        const response = await (route.POST as (request: Request) => Promise<Response>)(req);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).codigo, 'EMAIL_NAO_CONFIGURADO');
        assert.equal(agendados, 0);
        assert.equal(processados, 0);
    }
});
