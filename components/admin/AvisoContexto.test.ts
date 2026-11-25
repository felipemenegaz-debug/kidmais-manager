import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/**
 * Faixa de aviso de contexto (25/11/2026, r3): o aviso lido na carga aparece só na rota inicial do documento e some de vez
 * na primeira troca de rota da navegação interna, inclusive quando a tela seguinte não tem a faixa (Astra r2, P2). O
 * ObservadorDeRota do layout raiz renderiza em toda navegação; a faixa só nas telas que a montam. Hooks dublados.
 */
const g = globalThis as { window?: unknown };
g.window = {};

/** `armazenamento` faz o papel do sessionStorage da aba: ler o aviso o remove (dois documentos podem compartilhá-lo). */
function ambiente(avisoGuardado: string | null, inicial = '/admin/dashboard', armazenamento = { aviso: avisoGuardado }) {
    let rota = inicial;
    let leituras = 0;
    const estados: unknown[] = [];
    let iEstado = 0;
    const react = {
        useSyncExternalStore: (_s: unknown, snapshot: () => unknown) => snapshot(),
        useState: (v: unknown) => {
            const i = iEstado++;
            if (!(i in estados)) estados[i] = v;
            return [estados[i], (n: unknown) => { estados[i] = n; }];
        },
    };
    const dubles = {
        react,
        'next/navigation': { usePathname: () => rota },
        'lib/http/contexto-empresa-cliente': { lerAvisoDeContexto: () => { leituras += 1; const t = armazenamento.aviso; armazenamento.aviso = null; return t; } },
    };
    const cache = new Map();
    const observador = carregarModulo('components/ObservadorDeRota.tsx', dubles, cache) as { default: () => null };
    const faixa = carregarModulo('components/admin/AvisoContexto.tsx', dubles, cache) as { default: (p: object) => { props: { children: Array<{ props: { children: unknown; onClick?: () => void } }> } } | null };
    /** Uma navegação (ou a carga): o layout raiz renderiza o observador antes das páginas; `comFaixa` = a tela monta a faixa. */
    function ir(nova?: string, comFaixa = true) {
        if (nova) rota = nova;
        observador.default();
        if (!comFaixa) { estados.length = 0; return null; }
        iEstado = 0;
        const r = faixa.default({});
        return r === null ? null : String(r.props.children[0].props.children);
    }
    /** Só a faixa renderiza de novo (ex.: Strict Mode, ou o próprio estado mudou), sem troca de rota. */
    function renderizarFaixa() {
        iEstado = 0;
        const r = faixa.default({});
        return r === null ? null : String(r.props.children[0].props.children);
    }
    /** Clica no × da faixa visível. */
    function fechar() {
        iEstado = 0;
        faixa.default({})?.props.children[1].props.onClick?.();
    }
    return { ir, renderizarFaixa, fechar, observar: () => observador.default(), desmontar: () => { estados.length = 0; }, leituras: () => leituras };
}

const AVISO = 'Não foi possível confirmar a empresa ativa depois da leitura. Os dados recebidos foram descartados por segurança.';

test('aviso aparece na tela que a carga abriu e some na primeira troca de rota', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    assert.equal(a.ir(), AVISO, 'nova renderização na mesma rota mantém o aviso');
    assert.equal(a.ir('/admin/disponibilidade'), null);
    assert.equal(a.ir('/admin/pre-reservas/devolucoes'), null);
    assert.equal(a.leituras(), 1, 'lido uma vez por carga');
});

test('voltar à rota onde o aviso apareceu não o traz de volta', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    assert.equal(a.ir('/admin/disponibilidade'), null);
    assert.equal(a.ir('/admin/dashboard'), null);
});

test('A → B sem a faixa → A imediato (sem tique): o aviso não volta', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    assert.equal(a.ir('/admin/login', false), null);
    assert.equal(a.ir('/admin/dashboard'), null);
});

test('carga numa tela sem a faixa e 1ª montagem da faixa depois de navegar: o aviso não aparece na 2ª tela', () => {
    const a = ambiente(AVISO, '/admin/login');
    assert.equal(a.ir(undefined, false), null);
    assert.equal(a.ir('/admin/dashboard'), null);
    assert.equal(a.ir('/admin/login'), null, 'nem ao voltar à rota inicial depois de sair');
});

test('montagem tardia da faixa ainda na rota inicial mostra o aviso', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(undefined, false), null);
    assert.equal(a.ir(), AVISO);
});

test('a faixa renderizada antes do observador na carga registra a própria rota e mostra o aviso', () => {
    const a = ambiente(AVISO);
    assert.equal(a.renderizarFaixa(), AVISO);
    a.observar();
    assert.equal(a.renderizarFaixa(), AVISO);
    assert.equal(a.ir('/admin/disponibilidade'), null);
});

test('aviso consumido por documento sem a faixa não reaparece no documento seguinte da mesma aba (Astra r3, P2)', () => {
    const aba = { aviso: AVISO as string | null };
    const doc1 = ambiente(null, '/admin/login', aba);
    assert.equal(doc1.ir(undefined, false), null);
    assert.equal(doc1.ir('/admin/esqueci-senha', false), null);
    assert.equal(doc1.leituras(), 1, 'o observador consumiu o aviso na 1ª renderização cliente, sem faixa');
    const doc2 = ambiente(null, '/admin/dashboard', aba);
    assert.equal(doc2.ir(), null, 'navegação completa para a Gestão: o aviso antigo não aparece');
});

test('controle positivo: documento seguinte mostra o aviso que ainda está guardado', () => {
    const aba = { aviso: AVISO as string | null };
    const doc2 = ambiente(null, '/admin/dashboard', aba);
    assert.equal(doc2.ir(), AVISO);
});

test('componente montado de novo em outra rota (outro layout) também não mostra o aviso', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    a.desmontar();
    assert.equal(a.ir('/clientes'), null);
});

test('Strict Mode (desmonta e monta de novo na mesma rota): o aviso continua', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    a.desmontar();
    assert.equal(a.renderizarFaixa(), AVISO);
    assert.equal(a.renderizarFaixa(), AVISO);
});

test('fechar o aviso o esconde nesta instância', () => {
    const a = ambiente(AVISO);
    assert.equal(a.ir(), AVISO);
    a.fechar();
    assert.equal(a.renderizarFaixa(), null);
    assert.equal(a.ir(), null, 'continua fechado na mesma rota');
});

test('aviso de resultado de escrita continua visível na tela que a navegação de descarte abriu', () => {
    const escrita = 'A operação foi concluída, mas não foi possível confirmar a empresa ativa em seguida. A tela foi recarregada; confira o resultado.';
    const a = ambiente(escrita);
    assert.equal(a.ir(), escrita);
    assert.equal(a.ir(), escrita);
});

test('sem aviso guardado, nada aparece em nenhuma rota', () => {
    const a = ambiente(null);
    assert.equal(a.ir(), null);
    assert.equal(a.ir('/admin/disponibilidade'), null);
});

test('no servidor o observador não registra rota (estado do módulo seria compartilhado entre requisições)', () => {
    const a = ambiente(AVISO);
    const janela = g.window;
    delete g.window;
    try { assert.equal(a.ir('/admin/outra', false), null); }
    finally { g.window = janela; }
    assert.equal(a.ir('/admin/dashboard'), AVISO, 'a rota inicial é a do cliente, não a vista no servidor');
});
