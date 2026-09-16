import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classificarContratacao } from '../../lib/fechamentos/contratacoes.ts';

const nativeRequire = createRequire(import.meta.url);
function carregar(caminho: string, mocks: Record<string, unknown>) {
    const output = ts.transpileModule(readFileSync(caminho, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
    const exports: Record<string, unknown> = {};
    new Function('require', 'exports', output.outputText)((name: string) => {
        if (name in mocks) return mocks[name];
        if (['react', 'react/jsx-runtime', 'zod'].includes(name)) return nativeRequire(name);
        throw Error(`Import não autorizado no teste offline: ${name}`);
    }, exports);
    return exports;
}
test('cards renderizam identificação, pagamento e links reais de revisão/contrato', () => {
    const { ContratacoesLista } = carregar('components/festas/Contratacoes.tsx', {
        'next/link': { default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children), __esModule: true },
        '@/lib/http/admin-fetch': {}, './festa.module.css': {},
        '@/lib/contratos/documento/formatters': { formatarMoeda: (v: number) => `R$ ${v}`, formatarFormaPagamento: () => 'PIX à vista' },
    });
    const base = { id: 'f-sintetico', clienteId: 'cl-sintetico', cliente: 'Cliente sintético', data: '2026-09-19', inicio: '11:00', fim: '15:00', pacote: 'Pacote sintético', convidados: 40, criadoEm: '2026-09-16T10:00:00Z', status: 'AGUARDANDO_CONTRATO', formaPagamento: 'PIX_AVISTA', contratoId: null, contratoStatus: null, versaoId: null, edicaoEstado: null, documentoRevisado: false, valorContratual: null, temFesta: false };
    const itens = [classificarContratacao(base)!, classificarContratacao({ ...base, id: 'f2', contratoId: 'c-sintetico', edicaoEstado: 'AGUARDANDO_CLIENTE', valorContratual: '5000' })!];
    const html = renderToStaticMarkup(React.createElement(ContratacoesLista as React.ComponentType<{ itens: typeof itens }>, { itens }));
    for (const texto of ['Cliente sintético', '19/09/2026', '11:00–15:00', 'Pacote sintético', '40', 'PIX à vista', 'Criado em', 'Próximo passo', 'R$ 5000']) assert(html.includes(texto), texto);
    for (const href of ['/admin/fechamentos/f-sintetico/revisao', '/admin/contratos?contratoId=c-sintetico', '/contrato/c-sintetico']) assert(html.includes(`href="${href}"`), href);
    assert.equal((html.match(/Gerar contrato/g) ?? []).length, 1);
});

test('API exige autorização antes da consulta, valida clienteId e usa no-store', async () => {
    let autorizado = false, consultas = 0;
    const clientes: unknown[] = [];
    const { GET } = carregar('app/api/admin/fechamentos/contratacoes/route.ts', {
        '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => { if (!autorizado) throw Error('sem sessão'); } },
        '@/lib/http/api-response': { jsonNoStore: (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store' } }), apiErrorResponse: (error: Error) => Response.json({ erro: error.message }, { status: error.message === 'sem sessão' ? 401 : 400 }) },
        '@/lib/db/postgres': { db: () => { consultas++; return {}; } },
        '@/lib/fechamentos/contratacoes': { listarContratacoes: async (_db: unknown, clienteId: unknown) => { clientes.push(clienteId); return [{ id: 'sintetico' }]; } },
    });
    const get = GET as (r: { nextUrl: URL }) => Promise<Response>;
    const req = (query = '') => ({ nextUrl: new URL('https://example.invalid/api/admin/fechamentos/contratacoes' + query) });
    assert.equal((await get(req())).status, 401); assert.equal(consultas, 0);
    autorizado = true;
    assert.equal((await get(req('?clienteId=invalido'))).status, 400); assert.equal(consultas, 0);
    const id = '22222222-2222-4222-8222-222222222222';
    const response = await get(req(`?clienteId=${id}`));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(clientes, [id]); assert.equal((await response.json()).data.total, 1);
    await get(req()); assert.equal(clientes[1], undefined);
});
