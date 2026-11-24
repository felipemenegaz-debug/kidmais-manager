import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from '../admin/teste-componente.ts';

/** 23/11/2026 (pedido de Felipe): Contratantes abre em "Em uso" e avisa quantas desativadas ficaram de fora, com atalho para vê-las. */
function tela(busca: string | null, ocultas: number) {
    const consultas: string[] = [];
    const dados = { itens: [], total: 0, pagina: 1, porPagina: 25, desativadasOcultas: ocultas };
    const t = carregarComponente('components/desenvolvedor/Empresas.tsx', {
        'next/link': { default: (p: { children?: unknown }) => p.children },
        'next/navigation': { useSearchParams: () => new URLSearchParams(busca ?? '') },
        '@/components/admin/admin.module.css': cssFalso, '@/components/admin/workspace.module.css': cssFalso, './desenvolvedor.module.css': cssFalso,
        './cliente': { chamar: async (url: string) => { consultas.push(url); return { ok: true, data: dados }; }, formatarData: (s: string) => s },
        './ComercialEmpresa': { rotuloComercial: () => '' },
    });
    const carregar = async () => { t.render(); t.efeitos(); await tique(); await tique(); return t.render(); };
    return { t, consultas, carregar };
}

test('abre em "Em uso" e mostra o aviso com o botão Ver desativadas, que troca o filtro', async () => {
    const { t, consultas, carregar } = tela(null, 4);
    const arvore = await carregar();
    assert.match(consultas[0], /situacao=EM_USO/);
    const emUso = achar(arvore, 'button', 'Em uso');
    assert.equal(emUso.props['aria-pressed'], true);
    assert.match(texto(achar(arvore, 'p', /desativadas não aparecem/)), /^4 empresas desativadas não aparecem aqui\./);
    (achar(arvore, 'button', 'Ver desativadas').props.onClick as () => void)();
    const depois = t.render();
    assert.equal(achar(depois, 'button', 'Desativadas').props['aria-pressed'], true);
    assert.equal(elementos(depois).some((e) => e.props['data-desativadas-ocultas'] !== undefined), false, 'sem aviso fora de Em uso');
});

test('singular, sem aviso quando não há ocultas, e link do painel com situação continua valendo', async () => {
    assert.match(texto(achar(await tela(null, 1).carregar(), 'p', /desativada não aparece/)), /^1 empresa desativada não aparece aqui\./);
    assert.equal(elementos(await tela(null, 0).carregar()).some((e) => e.props['data-desativadas-ocultas'] !== undefined), false);
    const doPainel = tela('situacao=SUSPENSA', 4);
    await doPainel.carregar();
    assert.match(doPainel.consultas[0], /situacao=SUSPENSA/);
    const todas = tela('situacao=TODAS', 4);
    assert.equal(elementos(await todas.carregar()).some((e) => e.props['data-desativadas-ocultas'] !== undefined), false);
});
