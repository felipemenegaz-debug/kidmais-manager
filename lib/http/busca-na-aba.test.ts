import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Busca guardada na aba (decisão de Felipe em 08/11/2026): volta só para a mesma sessão e empresa, dentro do prazo, e sai
 * no início da saída, em todo descarte de contexto e na tela de login. Sem navegador: sessionStorage em memória.
 */
type Fn = (...a: unknown[]) => unknown;
function ambiente(opcoes: { semArmazenamento?: boolean; gravacaoFalha?: () => boolean } = {}) {
    const armazenado = new Map<string, string>();
    const navegacoes: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/contratos', host: 'kidmais.test', hostname: 'kidmais.test', origin: 'https://kidmais.test', href: 'https://kidmais.test/admin/contratos', replace: (u: string) => navegacoes.push(u), assign: (u: string) => navegacoes.push(u) } };
    const falha = () => { throw new DOMException('bloqueado', 'SecurityError'); };
    g.sessionStorage = opcoes.semArmazenamento
        ? { getItem: falha, setItem: falha, removeItem: falha, key: falha, get length() { return falha(); } }
        : {
            getItem: (k: string) => armazenado.get(k) ?? null,
            setItem: (k: string, v: string) => { if (opcoes.gravacaoFalha?.()) throw new DOMException('cheio', 'QuotaExceededError'); armazenado.set(k, String(v)); },
            removeItem: (k: string) => { armazenado.delete(k); },
            key: (i: number) => [...armazenado.keys()][i] ?? null,
            get length() { return armazenado.size; },
        };
    const cache = new Map<string, Record<string, unknown>>();
    const aba = carregarModulo('lib/http/busca-na-aba.ts', {}, cache) as Record<string, Fn> & { PRAZO_BUSCA_NA_ABA_MS: number };
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as Record<string, Fn>;
    return { aba, ctx, armazenado, navegacoes };
}
const CHAVE = 'kidmais-busca:contratos';

test('mesma sessão e empresa: guarda e devolve o termo; o registro não leva o identificador cru da sessão', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', ' Helena ', 1000);
    const bruto = a.armazenado.get(CHAVE)!;
    assert.equal(JSON.parse(bruto).termo, 'Helena');
    assert.doesNotMatch(bruto, /sessao-1|empresa-A/);
    assert.equal(a.aba.lerBuscaDaAba('contratos', 2000), 'Helena');
});

test('outra sessão ou outra empresa na mesma aba: não lê e apaga', () => {
    for (const [sessao, empresa] of [['sessao-2', 'empresa-A'], ['sessao-1', 'empresa-B'], ['sessao-1', null]] as const) {
        const a = ambiente();
        a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
        a.aba.guardarBuscaNaAba('contratos', 'Helena', 1000);
        const registro = a.armazenado.get(CHAVE)!;
        const b = ambiente();
        b.armazenado.set(CHAVE, registro);
        b.ctx.registrarContextoEmpresa(sessao, empresa);
        assert.equal(b.aba.lerBuscaDaAba('contratos', 2000), '', `${sessao}/${empresa}`);
        assert.equal(b.armazenado.has(CHAVE), false, `${sessao}/${empresa}`);
    }
});

test('página sem contexto confirmado: não guarda e não lê', () => {
    const a = ambiente();
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 1000);
    assert.equal(a.armazenado.has(CHAVE), false);
    a.armazenado.set(CHAVE, JSON.stringify({ v: 1, termo: 'Helena', ctx: 'x', em: 1000 }));
    assert.equal(a.aba.lerBuscaDaAba('contratos', 1000), '');
    assert.equal(a.armazenado.has(CHAVE), false);
});

test('prazo: vence 30 minutos depois da última busca; ler (montar, F5, voltar) não renova', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    const prazo = a.aba.PRAZO_BUSCA_NA_ABA_MS;
    assert.equal(prazo, 30 * 60 * 1000);
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    const bruto = a.armazenado.get(CHAVE);
    assert.equal(a.aba.lerBuscaDaAba('contratos', prazo - 1), 'Helena');
    assert.equal(a.armazenado.get(CHAVE), bruto, 'a leitura não regrava');
    assert.equal(a.aba.lerBuscaDaAba('contratos', prazo), 'Helena', 'no limite ainda vale');
    assert.equal(a.aba.lerBuscaDaAba('contratos', prazo + 1), '', 'passou do prazo, mesmo lido antes');
    assert.equal(a.armazenado.has(CHAVE), false);
    // Uso real (nova busca ou filtro) renova.
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 10);
    a.aba.guardarBuscaNaAba('contratos', 'Helena', prazo);
    assert.equal(a.aba.lerBuscaDaAba('contratos', 2 * prazo), 'Helena');
});

test('formato estrito: campo a mais, campo faltando, lista, chave repetida ou texto reformatado apagam', () => {
    const a0 = ambiente();
    a0.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a0.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    const ctx = JSON.parse(a0.armazenado.get(CHAVE)!).ctx;
    const casos = [
        JSON.stringify({ v: 1, termo: 'Helena', ctx, em: 0, extra: 'Theo' }),
        JSON.stringify({ v: 1, termo: 'Helena', em: 0 }),
        JSON.stringify([1, 'Helena', ctx, 0]),
        '{"v":1,"termo":"Theo","termo":"Helena","ctx":"' + ctx + '","em":0}',
        JSON.stringify({ v: 1, termo: 'Helena', ctx, em: 0 }, null, 1),
        JSON.stringify({ termo: 'Helena', v: 1, ctx, em: 0 }),
        '',
    ];
    for (const bruto of casos) {
        const a = ambiente();
        a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
        a.armazenado.set(CHAVE, bruto);
        assert.equal(a.aba.lerBuscaDaAba('contratos', 10), '', bruto);
        assert.equal(a.armazenado.has(CHAVE), false, bruto);
    }
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.armazenado.set(CHAVE, JSON.stringify({ v: 1, termo: 'Helena', ctx, em: 0 }));
    assert.equal(a.aba.lerBuscaDaAba('contratos', 10), 'Helena', 'o formato gravado continua aceito');
});

test('falha ao gravar (armazenamento cheio): a busca anterior não fica restaurável', () => {
    let falhar = false;
    const a = ambiente({ gravacaoFalha: () => falhar });
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    falhar = true;
    a.aba.guardarBuscaNaAba('contratos', 'Theo', 1);
    assert.equal(a.armazenado.has(CHAVE), false);
    assert.equal(a.aba.lerBuscaDaAba('contratos', 2), '');
});

test('relógio para trás, registro ilegível ou adulterado: apaga', () => {
    const casos = ['{', 'null', '"Helena"', JSON.stringify({ v: 2, termo: 'Helena', em: 0 }), JSON.stringify({ v: 1, termo: '', em: 0 }), JSON.stringify({ v: 1, termo: 'x'.repeat(81), em: 0 }), JSON.stringify({ v: 1, termo: 'Helena', em: '0' })];
    for (const bruto of casos) {
        const a = ambiente();
        a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
        a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
        const ctx = JSON.parse(a.armazenado.get(CHAVE)!).ctx;
        a.armazenado.set(CHAVE, bruto.startsWith('{"v"') ? JSON.stringify({ ...JSON.parse(bruto), ctx }) : bruto);
        assert.equal(a.aba.lerBuscaDaAba('contratos', 10), '', bruto);
        assert.equal(a.armazenado.has(CHAVE), false, bruto);
    }
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 5000);
    assert.equal(a.aba.lerBuscaDaAba('contratos', 4999), '', 'relógio para trás');
});

test('termo vazio (Limpar) apaga; termo longo é cortado no limite da busca', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    a.aba.guardarBuscaNaAba('contratos', '   ', 1);
    assert.equal(a.armazenado.has(CHAVE), false);
    a.aba.guardarBuscaNaAba('contratos', 'y'.repeat(200), 2);
    assert.equal(JSON.parse(a.armazenado.get(CHAVE)!).termo.length, 80);
});

test('saída: o início do Sair apaga só as buscas guardadas e bloqueia gravar e ler até a página ser trocada', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    a.armazenado.set('kidmais-busca:outra-tela', 'x');
    a.armazenado.set('convite-pedido:1', 'manter');
    a.ctx.marcarSaidaDaSessao();
    assert.deepEqual([...a.armazenado.keys()], ['convite-pedido:1']);
    // A lista segue interativa enquanto o logout não termina: trocar filtro ou busca não regrava.
    a.aba.guardarBuscaNaAba('contratos', 'Theo', 1);
    assert.equal(a.armazenado.has(CHAVE), false, 'gravação bloqueada');
    a.armazenado.set(CHAVE, JSON.stringify({ v: 1, termo: 'Helena', ctx: a.aba.resumoDoContexto('sessao-1:empresa-A'), em: 1 }));
    assert.equal(a.aba.lerBuscaDaAba('contratos', 2), '', 'leitura bloqueada');
    assert.equal(a.armazenado.has(CHAVE), false);
});

test('fim da sessão confirmado (expirada, revogada, recusada): encerrarBuscasDaAba apaga e bloqueia', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    a.ctx.encerrarBuscasDaAba();
    assert.equal(a.armazenado.has(CHAVE), false);
    a.aba.guardarBuscaNaAba('contratos', 'Theo', 1);
    assert.equal(a.armazenado.has(CHAVE), false);
    assert.equal(a.ctx.buscasDaAbaBloqueadas(), true);
});

test('pontos de fim de sessão chamam encerrarBuscasDaAba antes de navegar ao login', async () => {
    const { readFileSync } = await import('node:fs');
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /encerrarBuscasDaAba\(\);\s*setName\(null\);\s*window\.location\.replace\(loginDestaPagina\(\)\)/, 'leitura da sessão sem usuário');
    assert.match(shell, /\{ encerrarBuscasDaAba\(\); router\.replace\(loginDestaPagina\(\)\); \}/, 'falha da leitura da sessão');
    const fetch = readFileSync('lib/http/admin-fetch.ts', 'utf8');
    assert.equal(fetch.split('window.location.assign(loginDestaPagina())').length - 1, 3, 'três idas ao login em admin-fetch');
    // Rodada 12: a trava sai das idas ao login e passa para antes de qualquer ramo, inclusive o do estado final do endereço.
    // Duas idas vêm de uma confirmação de fim vigente (prévia da lista e da troca): a trava é a do ponto comum.
    assert.match(fetch, /async function confirmarSessao\(\): Promise<Confirmacao> \{\s*const confirmacao = await lerSessao\(\);\s*if \(fimConfirmado\(confirmacao\)\) encerrarBuscasDaAba\(\);\s*return confirmacao;\s*\}/, 'fim vigente trava ao chegar');
    assert.equal(fetch.split('await lerSessao()').length - 1, 1, 'nenhuma confirmação contorna o ponto comum');
    // A terceira é o 401 do POST da troca: trava antes do estado final.
    assert.match(fetch, /if \(resposta\.status === 401\) encerrarBuscasDaAba\(\);\s*pararSeEnderecoFinal\('escrita', situacao\);/, '401 da troca trava antes do estado final');
});

test('descarte de contexto (troca de empresa, outra sessão, outra aba): apaga antes de navegar', () => {
    const a = ambiente();
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    a.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    assert.equal(a.ctx.registrarContextoEmpresa('sessao-2', 'empresa-B'), false);
    assert.equal(a.armazenado.has(CHAVE), false);
    assert.deepEqual(a.navegacoes, ['/admin/dashboard']);
    const b = ambiente();
    b.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    b.aba.guardarBuscaNaAba('contratos', 'Helena', 0);
    b.ctx.reiniciarContextoEmpresa('A empresa ativa foi trocada em outra aba.');
    assert.equal(b.armazenado.has(CHAVE), false);
    b.aba.guardarBuscaNaAba('contratos', 'Theo', 1);
    assert.equal(b.armazenado.has(CHAVE), false, 'depois do descarte, a página que sai não regrava');
});

test('sem armazenamento disponível: nada quebra e nada volta da aba (a busca vale só com a lista aberta)', () => {
    const a = ambiente({ semArmazenamento: true });
    a.ctx.registrarContextoEmpresa('sessao-1', 'empresa-A');
    assert.doesNotThrow(() => a.aba.guardarBuscaNaAba('contratos', 'Helena', 0));
    assert.equal(a.aba.lerBuscaDaAba('contratos', 0), '');
    assert.doesNotThrow(() => a.ctx.esquecerBuscasDaAba());
});

test('tela de login apaga as buscas guardadas ao abrir (sessão expirada ou encerrada)', async () => {
    const { readFileSync } = await import('node:fs');
    const login = readFileSync('app/admin/login/page.tsx', 'utf8');
    assert.match(login, /useEffect\(\(\) => \{ esquecerBuscasDaAba\(\); \}, \[\]\);/);
});
