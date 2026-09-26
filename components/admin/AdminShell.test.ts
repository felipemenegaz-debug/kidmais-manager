import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ler = (arquivo: string) => readFileSync(new URL(arquivo, import.meta.url), 'utf8');
const shell = ler('./AdminShell.tsx');
const css = ler('./shell.module.css');
const tokens = ler('./tokens.module.css');
const semComentarios = (texto: string) => texto.replace(/\/\*[\s\S]*?\*\//g, '');

test('os tokens oficiais do UX Admin V1 estão centralizados com os valores literais', () => {
    const oficiais: Record<string, string> = {
        '--main-bg': '#090D1B',
        '--card-bg': '#151B2E',
        '--primary-violet': '#7C3AED',
        '--emerald-accent': '#5DE3B0',
        '--lilac-accent': '#C9B6FF',
        '--main-text': '#F5F7FC',
        '--secondary-text': '#B8C2D8',
        '--brand-blue': '#2563EB',
        '--border-navy': 'rgba(255, 255, 255, 0.05)',
    };
    for (const [nome, valor] of Object.entries(oficiais))
        assert.ok(tokens.includes(`${nome}: ${valor};`), nome);
    assert.match(tokens, /--input-fonte: 14px;/);
    assert.match(tokens, /--input-fonte-mobile: 16px;/);
    assert.match(tokens, /--input-padding: 12px 16px;/);
    assert.match(tokens, /--input-raio: 12px;/);
    assert.match(tokens, /--input-borda: rgba\(255, 255, 255, 0\.08\);/);
    assert.match(tokens, /--input-fundo: rgba\(255, 255, 255, 0\.03\);/);
    assert.match(tokens, /--input-fundo-foco: rgba\(255, 255, 255, 0\.06\);/);
    assert.match(tokens, /--sidebar-ativo-fundo: rgba\(124, 58, 237, 0\.1\);/);
    assert.match(tokens, /--sidebar-ativo-borda: 3px solid var\(--primary-violet\);/);
    assert.match(tokens, /--sidebar-hover-fundo: rgba\(255, 255, 255, 0\.03\);/);
    assert.match(tokens, /--glass-header-fundo: rgba\(9, 13, 27, 0\.8\);/);
    assert.match(tokens, /--btn-primary-fundo: linear-gradient\(135deg, var\(--brand-blue\), var\(--primary-violet\)\);/);
    assert.match(tokens, /--fonte-ui: var\(--fonte-inter\), Inter/);
});

test('o shell não espalha cores soltas fora dos tokens', () => {
    assert.doesNotMatch(semComentarios(css), /#[0-9a-f]{3,8}\b|rgba?\(/i);
    assert.match(shell, /tokens\.tema/);
    assert.match(css, /\.barra, \.sidebar \{ font-family: var\(--fonte-ui\)/);
});

test('o conteúdo legado fica isolado do tema escuro da casca', () => {
    assert.match(css, /\.conteudo \{[^}]*background: var\(--shell-conteudo-fundo\);[^}]*color: var\(--shell-conteudo-texto\);[^}]*color-scheme: light;/);
    assert.doesNotMatch(css, /\.conteudo \{[^}]*font-family/);
    assert.match(css, /\.sidebar \{[^}]*background: var\(--main-bg\);/);
});

test('a gaveta mobile preserva o comportamento funcional de 45f639a', () => {
    assert.match(css, /@media \(max-width: 800px\)/);
    assert.match(css, /\.sidebar\[data-aberto=true\] \{ display: flex; position: fixed; inset: 0;[^}]*width: 100%; height: 100vh; height: 100dvh; overflow-y: auto;/);
    assert.match(shell, /window\.matchMedia\('\(min-width: 801px\)'\)/);
    assert.match(shell, /evento\.key !== 'Escape'/);
    assert.match(shell, /document\.body\.style\.overflow = 'hidden'/);
    assert.match(shell, /fecharRef\.current\?\.focus\(\)/);
    assert.match(shell, /menuRef\.current\?\.focus\(\)/);
    assert.match(shell, /className=\{styles\.barra\} inert=\{aberto\}/);
    assert.match(shell, /className=\{styles\.conteudo\} inert=\{aberto\}/);
    assert.doesNotMatch(shell, /id="menu-admin"[^>]*inert/);
    assert.match(shell, />Abrir menu</);
    assert.match(shell, /aria-expanded=\{aberto\} aria-controls="menu-admin"/);
    assert.match(shell, />Fechar menu</);
    assert.match(shell, /onClick=\{\(\) => setAberto\(false\)\}>\{item\.rotulo\}/);
    assert.match(shell, /aria-label="Menu administrativo"/);
});

test('no desktop a sidebar permanece expandida, sem controle de recolher', () => {
    assert.match(tokens, /--shell-sidebar-largura: 16rem;/);
    assert.doesNotMatch(tokens, /--shell-sidebar-recolhida|4\.5rem/);
    assert.match(css, /\.sidebar \{[^}]*width: var\(--shell-sidebar-largura\);/);
    assert.doesNotMatch(css, /data-recolhido|text-overflow:\s*ellipsis|\.recolher/);
    assert.doesNotMatch(shell, /Recolher menu|Expandir menu|setRecolhido|data-recolhido/);
    assert.match(shell, /<Link key=\{item\.href\} href=\{item\.href\}[^\n]*onClick=\{\(\) => setAberto\(false\)\}>\{item\.rotulo\}<\/Link>/);
    assert.doesNotMatch(shell, /aria-hidden|tabIndex/);
    assert.match(shell, /aria-labelledby=\{rotulo\}/);
});

test('a raiz não ativa viewport-fit=cover nem troca a fonte pública', () => {
    const raiz = ler('../../app/layout.tsx');
    assert.doesNotMatch(raiz, /viewport-fit|viewportFit/);
    assert.doesNotMatch(raiz, /Inter/);
    for (const layout of ['../../app/admin/layout.tsx', '../../app/clientes/layout.tsx'])
        assert.match(ler(layout), /classeFonte=\{fonteAdmin\.variable\}/);
});
