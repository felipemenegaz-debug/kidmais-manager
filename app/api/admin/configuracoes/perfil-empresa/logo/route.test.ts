import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import sharp from 'sharp';
import { ClienteServiceError, isClienteServiceError } from '../../../../../../lib/clientes/services/errors.ts';
import { prepararLogo } from '../../../../../../lib/perfil/logo.ts';
import * as limites from '../../../../../../lib/perfil/logo-limites.ts';

const requireModule = createRequire(import.meta.url);
const url = 'http://localhost/api/admin/configuracoes/perfil-empresa/logo';

// Executa a rota real, com auth/contexto e transação em memória. Nenhum SQL ou rede.
function rota(opcoes: { authStatus?: number; semConcessao?: boolean; logo?: string } = {}) {
    let permissoes = 0, imagens = 0;
    const code = ts.transpileModule(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, (r: Request) => Promise<Response>> = {};
    new Function('require', 'exports', code)((id: string) => {
        if (id === 'next/server') return requireModule(id);
        if (id === '@/lib/http/admin-crm-api') return { exigirApiAdminCrmDisponivel: async () => {
            if (opcoes.authStatus) throw new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', 'Sessão ou origem inválida.', opcoes.authStatus);
            return { usuario_id: 'usuario-sintetico' };
        } };
        if (id === '@/lib/db/postgres') return { withTransaction: async (fn: (tx: object) => Promise<unknown>) => fn({}) };
        if (id === '@/lib/clientes/services/errors') return { ClienteServiceError, isClienteServiceError };
        if (id === '@/lib/perfil/cadastro-service') return { consultarLogoPerfil: async (_tx: object, usuario: string, editar = false) => {
            permissoes++;
            assert.equal(usuario, 'usuario-sintetico');
            if (opcoes.semConcessao) throw new ClienteServiceError('PERFIL_SEM_CONCESSAO', 'Sem concessão ativa.', 403);
            return editar ? null : opcoes.logo ?? null;
        } };
        if (id === '@/lib/perfil/logo') return { prepararLogo: async (bytes: Buffer) => { imagens++; return prepararLogo(bytes); } };
        if (id === '@/lib/perfil/logo-limites') return limites;
        throw new Error(`Dependência não interceptada: ${id}`);
    }, exports);
    return { exports, contadores: () => ({ permissoes, imagens }) };
}

async function upload(bytes: Uint8Array, tipo = 'image/png') {
    const form = new FormData();
    form.append('arquivo', new File([Uint8Array.from(bytes)], 'logo.png', { type: tipo }));
    const request = new Request(url, { method: 'POST', body: form });
    return new Request(url, { method: 'POST', headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
}

test('logo exige sessão/origem e concessão antes de ler ou processar o arquivo', async () => {
    for (const authStatus of [401, 403]) {
        const r = rota({ authStatus });
        for (const metodo of ['GET', 'POST']) assert.equal((await r.exports[metodo](new Request(url, { method: metodo }))).status, authStatus);
        assert.deepEqual(r.contadores(), { permissoes: 0, imagens: 0 });
    }
    const r = rota({ semConcessao: true });
    assert.equal((await r.exports.POST(await upload(new Uint8Array([1])))).status, 403);
    assert.deepEqual(r.contadores(), { permissoes: 1, imagens: 0 });
});

test('GET retorna só a logo vigente, sem cache; POST prepara PNG sem gravar', async () => {
    const bytes = await sharp({ create: { width: 30, height: 15, channels: 4, background: '#8877cc' } }).webp().toBuffer();
    const logo = await prepararLogo(bytes);
    const r = rota({ logo });
    const get = await r.exports.GET(new Request(url));
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await get.json()).data.logoDataUrl, logo);
    const post = await r.exports.POST(await upload(new Uint8Array(bytes), 'image/webp'));
    assert.equal(post.status, 200);
    assert.equal((await post.json()).data.logoDataUrl, logo);
    assert.deepEqual(r.contadores(), { permissoes: 2, imagens: 1 });
});

test('upload rejeita conteúdo falso, SVG, multipart inválido e tamanho excessivo', async () => {
    const r = rota();
    for (const request of [await upload(new Uint8Array([1])), await upload(new Uint8Array([1]), 'image/svg+xml'), new Request(url, { method: 'POST', body: 'não é multipart' })])
        assert.equal((await r.exports.POST(request)).status, 400);
    const oversized = await r.exports.POST(await upload(new Uint8Array(limites.LOGO_MAX_UPLOAD + 65537)));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).codigo, 'PERFIL_LOGO_INVALIDA');
});
