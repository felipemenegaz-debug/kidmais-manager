import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canaisSuporte, ROTA_AJUDA } from './canais.ts';
import { referenciaDoErro } from '../../components/erro/referencia.ts';
import ts from 'typescript';
import { carregarComponente, cssFalso, elementos, texto } from '../../components/admin/teste-componente.ts';

test('canais: sem configuração não mostra nada nem "a definir"', () => {
    const c = canaisSuporte({});
    assert.equal(c.configurado, false);
    assert.equal(c.email, null);
    assert.equal(c.whatsappHref, null);
    assert.equal(c.horario, null, 'horário sozinho não é canal');
    assert.equal(JSON.stringify(c).includes('a definir'), false);
    assert.equal(canaisSuporte({ SITE_ATENDIMENTO_HORARIO: 'Seg a sex' }).configurado, false);
});

test('canais: e-mail e WhatsApp válidos viram links', () => {
    const c = canaisSuporte({ SITE_ATENDIMENTO_EMAIL: ' suporte@exemplo.com.br ', SITE_ATENDIMENTO_WHATSAPP: '+55 61 99999-0000', SITE_ATENDIMENTO_HORARIO: 'Seg a sex, 9h às 18h' });
    assert.equal(c.configurado, true);
    assert.equal(c.email, 'suporte@exemplo.com.br');
    assert.equal(c.emailHref, 'mailto:suporte@exemplo.com.br?subject=Suporte%20Kidmais%20Manager');
    assert.match(c.whatsappHref ?? '', /^https:\/\/wa\.me\/5561999990000\?text=/);
    assert.equal(c.whatsapp, '+55 61 99999-0000');
    assert.equal(c.horario, 'Seg a sex, 9h às 18h');
});

test('canais: valores inválidos não geram link', () => {
    for (const email of ['a definir', 'sem-arroba', 'a@b', 'x@y.com?bcc=z@w.com', 'a b@c.com']) assert.equal(canaisSuporte({ SITE_ATENDIMENTO_EMAIL: email }).email, null, email);
    // Mesma validação do site (linkWhatsApp): curto demais ou com letras não vira link.
    assert.equal(canaisSuporte({ SITE_ATENDIMENTO_WHATSAPP: '9999-0000' }).whatsappHref, null);
    assert.equal(canaisSuporte({ SITE_ATENDIMENTO_WHATSAPP: 'a definir' }).whatsappHref, null);
    const so = canaisSuporte({ SITE_ATENDIMENTO_WHATSAPP: '5561999990000' });
    assert.equal(so.configurado, true);
    assert.equal(so.emailHref, null);
});

test('referência do erro: só digest válido; erro do navegador fica sem código', () => {
    assert.equal(referenciaDoErro({ digest: '1234567890' }), '1234567890');
    assert.equal(referenciaDoErro({ digest: ' abc_DEF-1 ' }), 'abc_DEF-1');
    assert.equal(referenciaDoErro({}), null);
    assert.equal(referenciaDoErro(null), null);
    assert.equal(referenciaDoErro({ digest: 42 }), null);
    assert.equal(referenciaDoErro({ digest: '<script>' }), null);
    assert.equal(referenciaDoErro({ digest: 'x'.repeat(65) }), null);
});

/** api-response.ts carregado de verdade; as classes de erro de domínio viram dublês que nunca casam (cai no 500). */
function carregarApiResponse() {
    const js = ts.transpileModule(readFileSync(new URL('../http/api-response.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const NextResponse = { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) };
    const duble = new Proxy({}, { get: (_alvo, nome) => typeof nome !== 'string' ? undefined : nome.startsWith('is') ? () => false : nome === 'schemaAusente' ? () => null : class {} });
    const exports: Record<string, unknown> = {};
    new Function('require', 'exports', js)((nome: string) => nome === 'next/server' ? { NextResponse } : duble, exports);
    return exports as { apiErrorResponse(e: unknown): Response; referenciaErroInterno(): string };
}

test('API 500: referência curta, aleatória, no corpo e no log', async () => {
    const { apiErrorResponse, referenciaErroInterno } = carregarApiResponse();
    const a = referenciaErroInterno();
    assert.match(a, /^[0-9A-F]{8}$/);
    assert.notEqual(a, referenciaErroInterno());
    const original = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
        const res = apiErrorResponse(new Error('falha interna com detalhe sensível'));
        assert.equal(res.status, 500);
        const corpo = await res.json() as { erro: string; codigo: string; referencia: string };
        assert.equal(corpo.codigo, 'ERRO_INTERNO');
        assert.match(corpo.referencia, /^[0-9A-F]{8}$/);
        assert.equal(corpo.erro, `Erro interno ao processar a solicitação. Código de referência: ${corpo.referencia}.`);
        assert.equal(corpo.erro.includes('sensível'), false, 'detalhe do erro não vai ao cliente');
        assert.equal(String(logs[0]?.[0]).includes(corpo.referencia), true);
    } finally { console.error = original; }
});

test('Admin: ajuda aberta com acesso bloqueado e sem empresa; avisos apontam para ela', () => {
    assert.equal(ROTA_AJUDA, '/admin/ajuda');
    const shell = readFileSync(new URL('../../components/admin/AdminShell.tsx', import.meta.url), 'utf8');
    assert.match(shell, /ROTAS_ABERTAS_BLOQUEADO = \[[^\]]*ROTA_AJUDA\]/);
    assert.match(shell, /ROTAS_ABERTAS_SEM_EMPRESA = \['\/admin\/perfil', ROTA_AJUDA\]/);
    for (const arquivo of ['WhatsappConfiguracao.tsx', 'Assinatura.tsx', 'AssinaturaAcoes.tsx', 'atendimento/PrivacidadeAtendimento.tsx']) {
        const fonte = readFileSync(new URL(`../../components/admin/${arquivo}`, import.meta.url), 'utf8');
        assert.match(fonte, /<Link href=\{ROTA_AJUDA\}>/, arquivo);
    }
    const pagina = readFileSync(new URL('../../app/admin/ajuda/page.tsx', import.meta.url), 'utf8');
    assert.equal(/>[^<{]*a definir/.test(pagina), false, 'nenhum texto visível "a definir"');
    assert.match(pagina, /dynamic = 'force-dynamic'/);
});

function montarAjuda(env: Record<string, string>) {
    const tela = carregarComponente('app/admin/ajuda/page.tsx', {
        'next/link': { default: 'a' },
        '@/components/admin/admin.module.css': cssFalso,
        '@/components/admin/workspace.module.css': cssFalso,
        '@/lib/suporte/canais': { canaisSuporte: () => canaisSuporte(env) },
    });
    return tela.render();
}

test('página de ajuda: canais configurados viram links; sem canais, orientação sem "a definir"', () => {
    const com = montarAjuda({ SITE_ATENDIMENTO_EMAIL: 'suporte@exemplo.com.br', SITE_ATENDIMENTO_WHATSAPP: '+55 61 99999-0000', SITE_ATENDIMENTO_HORARIO: 'Seg a sex, 9h às 18h' });
    const links = elementos(com).filter((e) => typeof e.props.href === 'string').map((e) => String(e.props.href));
    assert(links.some((h) => h.startsWith('https://wa.me/5561999990000')));
    assert(links.includes('mailto:suporte@exemplo.com.br?subject=Suporte%20Kidmais%20Manager'));
    assert(links.includes('/admin/inicio') && links.includes('/admin/assinatura') && links.includes('/admin/perfil'));
    assert.match(texto(com), /Horário de atendimento: Seg a sex, 9h às 18h/);
    assert.match(texto(com), /nunca pede a sua senha/);

    const sem = montarAjuda({});
    assert.equal(texto(sem).includes('a definir'), false);
    assert.match(texto(sem), /ainda não foram publicados neste ambiente/);
    assert.equal(elementos(sem).some((e) => String(e.props.href ?? '').startsWith('mailto:') || String(e.props.href ?? '').startsWith('https://wa.me')), false);
});

test('erro do Admin: mostra o digest como referência e leva ao suporte', () => {
    const tela = carregarComponente('app/admin/error.tsx', {
        'next/link': { default: 'a' },
        '@/components/admin/admin.module.css': cssFalso,
        '@/lib/suporte/rota': { ROTA_AJUDA },
        '@/components/erro/referencia': { referenciaDoErro },
    });
    let tentou = 0;
    const comDigest = tela.render('default', { error: Object.assign(new Error('x'), { digest: '987654321' }), retry: () => { tentou++; } });
    assert.match(texto(comDigest), /Código de referência: 987654321/);
    assert(elementos(comDigest).some((e) => e.props.href === '/admin/ajuda'));
    const botao = elementos(comDigest).find((e) => e.type === 'button');
    (botao?.props.onClick as () => void)();
    assert.equal(tentou, 1);
    const semDigest = tela.render('default', { error: new Error('x'), retry: () => {} });
    assert.equal(texto(semDigest).includes('Código de referência'), false);
});
