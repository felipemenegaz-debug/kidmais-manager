import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { abrirEmpresaCriada } from './abrir-empresa-criada.ts';

test('seleção só abre a empresa com sucesso confirmado', async () => {
    const com = (status: number, corpo: { ok?: boolean } | null) => async () => ({ status, corpo });
    assert.equal(await abrirEmpresaCriada(com(200, { ok: true }), 'e'), true);
    for (const [status, corpo] of [[200, { ok: false }], [200, null], [200, {}], [403, { ok: true }], [500, null], [409, { ok: false }]] as Array<[number, { ok?: boolean } | null]>)
        assert.equal(await abrirEmpresaCriada(com(status, corpo), 'e'), false, JSON.stringify([status, corpo]));
    assert.equal(await abrirEmpresaCriada(async () => { throw new TypeError('rede'); }, 'e'), false, 'exceção de rede não cai no erro genérico');
});

test('seleção envia a empresa criada, uma vez', async () => {
    const pedidos: unknown[] = [];
    await abrirEmpresaCriada(async (url, corpo) => { pedidos.push([url, corpo]); return { status: 200, corpo: { ok: true } }; }, 'e1');
    assert.deepEqual(pedidos, [['/api/admin/autenticacao', { acao: 'selecionar-empresa', empresaId: 'e1' }]]);
});

test('tela: a mensagem só vem depois do sucesso do primeiro POST; retomada e reautenticação ficam como estão', () => {
    const fonte = readFileSync('app/cadastro/empresa/page.tsx', 'utf8');
    const reaut = fonte.indexOf("codigo === 'REAUTENTICACAO'");
    const cnpj = fonte.indexOf("codigo === 'CNPJ_EXISTENTE'");
    const falhou = fonte.indexOf('!r.corpo?.ok || !r.corpo.data?.empresaId');
    // A página usa o resultado: seleção sem sucesso confirmado para no aviso de empresa criada, sem navegar.
    const abre = fonte.indexOf('if (!await abrirEmpresaCriada(postar, r.corpo.data.empresaId)) { setOcupado(false); setCriadaSemAbrir(true); return; }');
    const vai = fonte.indexOf("window.location.replace('/admin/inicio')");
    assert.ok(reaut > 0 && reaut < cnpj && cnpj < falhou && falhou < abre && abre < vai);
    assert.match(fonte, /Sua empresa foi criada, mas não conseguimos abri-la\. Entre com seu login para continuar\./);
    assert.match(fonte, /Tente de novo: se a empresa já tiver sido criada, você continua nela\./, 'retomada idempotente do primeiro POST');
});
