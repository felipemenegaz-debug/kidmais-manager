import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/**
 * Faixa de aviso de contexto (25/11/2026): o aviso lido na carga aparece só na tela que a carga abriu e some na próxima
 * troca de rota da navegação interna. Hooks dublados: cada `renderizar` chama o componente e roda os efeitos cujas
 * dependências mudaram, como o React faz depois do commit.
 */
function ambiente(avisoGuardado: string | null) {
    let rota = '/admin/dashboard';
    let leituras = 0;
    const estados: unknown[] = [];
    const efeitos: Array<{ deps?: unknown[]; limpar?: (() => void) | void }> = [];
    let iEstado = 0;
    let iEfeito = 0;
    const pendentes: Array<() => void> = [];
    const react = {
        useSyncExternalStore: (_s: unknown, snapshot: () => unknown) => snapshot(),
        useState: (inicial: unknown) => {
            const i = iEstado++;
            if (!(i in estados)) estados[i] = inicial;
            return [estados[i], (v: unknown) => { estados[i] = v; }];
        },
        useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
            const i = iEfeito++;
            const antes = efeitos[i];
            if (!antes || !deps || deps.some((d, k) => d !== antes.deps?.[k]))
                pendentes.push(() => { efeitos[i]?.limpar?.(); efeitos[i] = { deps, limpar: fn() }; });
            else efeitos[i] = { deps, limpar: antes.limpar };
        },
    };
    const mod = carregarModulo('components/admin/AvisoContexto.tsx', {
        react,
        'next/navigation': { usePathname: () => rota },
        'lib/http/contexto-empresa-cliente': { lerAvisoDeContexto: () => { leituras += 1; return avisoGuardado; } },
    }, new Map()) as { default: (p: object) => { props: { children: unknown[] } } | null };
    // Cada instância montada tem os próprios estados/efeitos; `desmontar` roda as limpezas e esquece a instância (a próxima
    // renderização é uma montagem nova, ex.: tela de login ou outro layout).
    function desmontar() {
        efeitos.forEach((e) => e.limpar?.());
        estados.length = 0;
        efeitos.length = 0;
    }
    function renderizar(nova?: string) {
        if (nova) rota = nova;
        iEstado = 0;
        iEfeito = 0;
        // O que a pessoa vê é o commit desta renderização, ANTES dos efeitos (useEffect roda depois da pintura).
        const commit = mod.default({});
        // Efeitos depois do commit; um setState neles provoca nova renderização.
        while (pendentes.length) {
            const estadoAntes = JSON.stringify(estados);
            pendentes.splice(0).forEach((fn) => fn());
            if (JSON.stringify(estados) !== estadoAntes) { iEstado = 0; iEfeito = 0; mod.default({}); }
        }
        return commit === null ? null : String((commit.props.children as Array<{ props: { children: unknown } }>)[0].props.children);
    }
    return { renderizar, desmontar, leituras: () => leituras };
}

const AVISO = 'Não foi possível confirmar a empresa ativa depois da leitura. Os dados recebidos foram descartados por segurança.';

test('aviso aparece na tela que a carga abriu e some na primeira troca de rota', () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizar(), AVISO);
    assert.equal(a.renderizar(), AVISO, 'nova renderização na mesma rota mantém o aviso');
    assert.equal(a.renderizar('/admin/disponibilidade'), null);
    assert.equal(a.renderizar('/admin/pre-reservas/devolucoes'), null);
    assert.equal(a.leituras(), 1, 'lido uma vez por carga');
});

test('voltar à rota onde o aviso apareceu não o traz de volta', () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizar(), AVISO);
    assert.equal(a.renderizar('/admin/disponibilidade'), null);
    assert.equal(a.renderizar('/admin/dashboard'), null);
});

test('componente montado de novo em outra rota (outro layout) também não mostra o aviso já encerrado', () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizar(), AVISO);
    a.desmontar();
    assert.equal(a.renderizar('/clientes'), null);
});

const tique = () => new Promise((r) => setTimeout(r, 0));

test('A → B sem a faixa → A: o aviso termina quando a instância que o mostrava sai da árvore', async () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizar(), AVISO);
    a.desmontar();
    await tique();
    assert.equal(a.renderizar('/admin/dashboard'), null);
});

test('Strict Mode (desmonta e monta de novo na mesma rota, sem tique): o aviso continua', async () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizar(), AVISO);
    a.desmontar();
    assert.equal(a.renderizar(), AVISO);
    await tique();
    assert.equal(a.renderizar(), AVISO, 'o encerramento agendado foi cancelado pela nova montagem');
});

test('aviso de resultado de escrita continua visível na tela que a navegação de descarte abriu', () => {
    const escrita = 'A operação foi concluída, mas não foi possível confirmar a empresa ativa em seguida. A tela foi recarregada; confira o resultado.';
    const a = ambiente(escrita);
    assert.equal(a.renderizar(), escrita);
    assert.equal(a.renderizar(), escrita);
});

test('sem aviso guardado, nada aparece em nenhuma rota', () => {
    const a = ambiente(null);
    assert.equal(a.renderizar(), null);
    assert.equal(a.renderizar('/admin/disponibilidade'), null);
});
