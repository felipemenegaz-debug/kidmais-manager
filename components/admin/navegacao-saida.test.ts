import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Navegação e saída (E): ninguém fica preso em 404, seleção vazia ou "Verificando sessão…"; sair funciona a partir de
 * qualquer tela; o painel reflete os acessos reais; rotas sem autorização continuam ocultas. Conferência estática das
 * telas; o comportamento no navegador é coberto por scripts/painel-implantacao-ui.cjs (opt-in, Playwright).
 */
const adminShell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
const devShell = readFileSync('components/desenvolvedor/DesenvolvedorShell.tsx', 'utf8');
const sair = readFileSync('components/admin/sair.ts', 'utf8');
const naoEncontrado = readFileSync('app/not-found.tsx', 'utf8');

test('Admin sem empresa ativa: estado explícito com perfil, painel (se concedido) e sair; nada de negócio no menu', () => {
    assert.match(adminShell, /const semEmpresa = !vitrine && contexto !== null && contexto\.empresas\.length === 0/);
    assert.match(adminShell, /const itens = semEmpresa \? \[\] : itensNavegacao\(permissoes\)/);
    assert.match(adminShell, /Sem empresa ativa/);
    assert.match(adminShell, /href="\/admin\/perfil"/);
    assert.match(adminShell, /empresa\?\.desenvolvedor && <li><Link href="\/desenvolvedor">Painel do desenvolvedor<\/Link><\/li>/);
    assert.match(adminShell, /semEmpresa && <div><p className=\{styles\.grupo\}>Conta<\/p>/);
    assert.doesNotMatch(adminShell, /Nenhuma empresa com acesso ativo\.<\/p>/, 'a seleção vazia antiga foi substituída pelo estado com saídas');
});

test('"Verificando sessão…" tem prazo: depois dele a tela oferece tentar de novo e ir ao login', () => {
    assert.match(adminShell, /DEMORA_VERIFICACAO_MS = 8000/);
    assert.match(adminShell, /setDemorou\(true\)/);
    assert.match(adminShell, /Tentar novamente/);
    assert.match(adminShell, /href="\/admin\/login"[^>]*>Ir para o login/);
});

test('sair: um único caminho para Admin e painel; as telas lembram o CSRF e liberam o botão quando a saída termina (comportamento em sair.test.ts)', () => {
    assert.match(adminShell, /import \{ lembrarCsrf, sairDaSessao \} from '\.\/sair'/);
    assert.match(devShell, /import \{ lembrarCsrf, sairDaSessao \} from '@\/components\/admin\/sair'/);
    assert.match(adminShell, /lembrarCsrf\(b\.data\.csrf\)/);
    assert.match(devShell, /lembrarCsrf\(b\?\.data\?\.csrf\)/);
    assert.match(adminShell, /sairDaSessao\(\)\.finally\(\(\) => setSaindo\(false\)\)/);
    assert.match(devShell, /sairDaSessao\(\)\.finally\(\(\) => setSaindo\(false\)\)/);
    assert.doesNotMatch(adminShell, /acao: 'logout'/, 'o shell não monta o logout por conta própria');
    assert.doesNotMatch(devShell, /acao: 'logout'/);
    assert.doesNotMatch(sair, /adminFetch/, 'sair não depende da confirmação de contexto das operações de negócio');
    // Respostas tardias (401 / contexto mudado) não sobrepõem a saída: os dois caminhos de redirecionamento consultam a marca.
    assert.match(sair, /marcarSaidaDaSessao\(\)/);
    const cliente = readFileSync('components/desenvolvedor/cliente.ts', 'utf8');
    const adminFetch = readFileSync('lib/http/admin-fetch.ts', 'utf8');
    const contexto = readFileSync('lib/http/contexto-empresa-cliente.ts', 'utf8');
    assert.match(cliente, /if \(!saidaDaSessaoEmAndamento\(\)\) \{\s*\n\s*\/\/ eslint-disable-next-line[^\n]*\n\s*window\.location\.assign\(`\/admin\/login\?voltar=/);
    assert.match(adminFetch, /if \(!saidaDaSessaoEmAndamento\(\)\) \{/);
    assert.match(contexto, /export function reiniciarContextoEmpresa\(aviso\?: string, destino\?: string\) \{\r?\n\s*if \(saidaDaSessao\) return;/);
});

test('painel do desenvolvedor: "Ir para o Admin" só com empresa ativa; Atividade no menu; Escape fecha o menu', () => {
    assert.match(devShell, /acessos\.carregado && acessos\.empresasAtivas > 0 && <Link href="\/admin\/dashboard"/);
    assert.match(devShell, /Sem empresa com acesso ativo no Admin/);
    assert.match(devShell, /href: '\/desenvolvedor\/atividade', rotulo: 'Atividade'/);
    assert.match(devShell, /evento\.key !== 'Escape'/);
    assert.match(devShell, /aria-expanded=\{aberto\}/);
});

test('404 único e neutro: não revela áreas ocultas e oferece saídas seguras', () => {
    assert.match(naoEncontrado, /Página não encontrada/);
    assert.match(naoEncontrado, /robots: \{ index: false, follow: false \}/);
    for (const destino of ['/admin/dashboard', '/admin/perfil', '/admin/login'])
        assert.match(naoEncontrado, new RegExp(`href="${destino}"`));
    assert.doesNotMatch(naoEncontrado, /desenvolvedor|concess/i, 'não menciona o painel oculto');
    const guarda = readFileSync('lib/desenvolvedor/pagina.ts', 'utf8');
    assert.match(guarda, /notFound\(\)/, 'sem concessão continua 404');
});
