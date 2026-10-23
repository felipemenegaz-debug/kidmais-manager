import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VERSOES_PUBLICADAS } from './documentos-legais-historico.ts';
import { DOCUMENTOS } from './documentos-legais.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/** Catálogo histórico (revisão 00cecac, P2-B2) e página pública de versões (P3-B2). */
test('catálogo: cada versão publicada confere com o próprio SHA-256, é única e não colide com a vigente', () => {
    assert.ok(VERSOES_PUBLICADAS.length >= 8);
    const chaves = new Set<string>();
    for (const v of VERSOES_PUBLICADAS) {
        assert.equal(createHash('sha256').update(v.conteudo, 'utf8').digest('hex'), v.hash, `${v.documento} ${v.versao}`);
        assert.match(v.versao, /^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$/);
        const k = `${v.documento}|${v.versao}`;
        assert.ok(!chaves.has(k), k); chaves.add(k);
        assert.notEqual(v.versao, DOCUMENTOS[v.documento].versao, 'a vigente vem do código, não do catálogo');
    }
    // Versões das rodadas publicadas de 20–21/10 (hashes registrados nelas).
    const termos20 = VERSOES_PUBLICADAS.find((v) => v.documento === 'TERMOS_USO' && v.versao === '2026-10-20-minuta');
    assert.match(termos20?.hash ?? '', /^8568c1af/);
    assert.match(VERSOES_PUBLICADAS.find((v) => v.documento === 'PRIVACIDADE' && v.versao === '2026-10-20-minuta5')?.hash ?? '', /^06e7b9a5/);
});

test('cadastro: o texto apresentado no pedido é arquivado já na apresentação (com a 096)', () => {
    const fonte = readFileSync('lib/cadastro/publico.ts', 'utf8');
    const pedido = fonte.slice(fonte.indexOf("const termos = versaoVigente('TERMOS_USO'), privacidade = versaoVigente('PRIVACIDADE');"));
    assert.match(pedido.slice(0, 400), /if \(await comprovanteInstalado\(tx\)\) await arquivarVersoesVigentes\(tx\);/);
});

test('página de versões: nomes herdados do protótipo e documento desconhecido são 404, nunca erro', async () => {
    const naoEncontrado = new Error('NOT_FOUND');
    const pagina = carregarModulo('app/documentos/[documento]/[versao]/page.tsx', {
        'next/navigation': { notFound: () => { throw naoEncontrado; } },
        'next/link': { default: () => null },
        'components/admin/admin.module.css': { default: {} }, 'components/admin/workspace.module.css': { default: {} },
        'components/admin/fonte': { fonteAdmin: { variable: 'f' } }, 'components/admin/tokens.module.css': { default: {} },
        'components/cadastro/DocumentoLegal': { default: () => null },
        'lib/db/postgres': { withTransaction: async () => null },
    }, new Map()).default as (p: { params: Promise<{ documento: string; versao: string }> }) => Promise<unknown>;
    for (const documento of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'outro'])
        await assert.rejects(pagina({ params: Promise.resolve({ documento, versao: '2026-01-01' }) }), (e) => e === naoEncontrado, documento);
    // Versão publicada do catálogo sem banco: renderiza (não é 404).
    const v = VERSOES_PUBLICADAS[0];
    assert.ok(await pagina({ params: Promise.resolve({ documento: v.documento.toLowerCase(), versao: v.versao }) }));
});
