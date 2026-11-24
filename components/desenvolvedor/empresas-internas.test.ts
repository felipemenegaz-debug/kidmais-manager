import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from '../admin/teste-componente.ts';

/**
 * Contratantes fase 2 (23/11/2026, D-INT-1 "esconder internas"): "Em uso" deixa de fora as internas e o aviso diz quantas,
 * com o atalho Ver internas; a linha e a ficha mostram o selo Interna; a ficha marca Cliente/Interna com motivo.
 * Sem a 134 (usoDisponivel false) o filtro Internas some e a ficha só avisa.
 */
const ACHA = (e: { props: Record<string, unknown> }, attr: string) => e.props[attr] !== undefined;

function lista(busca: string | null, dados: Record<string, unknown>) {
    const consultas: string[] = [];
    const t = carregarComponente('components/desenvolvedor/Empresas.tsx', {
        'next/link': { default: (p: { children?: unknown }) => p.children },
        'next/navigation': { useSearchParams: () => new URLSearchParams(busca ?? '') },
        '@/components/admin/admin.module.css': cssFalso, '@/components/admin/workspace.module.css': cssFalso, './desenvolvedor.module.css': cssFalso,
        './cliente': { chamar: async (url: string) => { consultas.push(url); return { ok: true, data: { itens: [], total: 0, pagina: 1, porPagina: 25, ...dados } }; }, formatarData: (s: string) => s },
        './ComercialEmpresa': { rotuloComercial: () => '' },
    });
    const carregar = async () => { t.render(); t.efeitos(); await tique(); await tique(); return t.render(); };
    return { t, consultas, carregar };
}

test('textoOcultas: só desativadas, só internas, as duas, singular', () => {
    const { textoOcultas } = carregarComponente('components/desenvolvedor/Empresas.tsx', {
        'next/link': { default: () => null }, 'next/navigation': { useSearchParams: () => new URLSearchParams() },
        '@/components/admin/admin.module.css': cssFalso, '@/components/admin/workspace.module.css': cssFalso, './desenvolvedor.module.css': cssFalso,
        './cliente': { chamar: async () => ({ ok: false, erro: '' }), formatarData: (s: string) => s }, './ComercialEmpresa': { rotuloComercial: () => '' },
    }).modulo as { textoOcultas: (d: number, i: number) => string };
    assert.equal(textoOcultas(21, 0), '21 empresas desativadas não aparecem aqui.');
    assert.equal(textoOcultas(1, 0), '1 empresa desativada não aparece aqui.');
    assert.equal(textoOcultas(0, 3), '3 empresas internas não aparecem aqui.');
    assert.equal(textoOcultas(0, 1), '1 empresa interna não aparece aqui.');
    assert.equal(textoOcultas(21, 3), '21 desativadas e 3 internas não aparecem aqui.');
    assert.equal(textoOcultas(1, 1), '1 desativada e 1 interna não aparecem aqui.');
});

test('Em uso com desativadas e internas ocultas: um aviso, dois atalhos; Ver internas troca o filtro', async () => {
    const { t, carregar } = lista(null, { desativadasOcultas: 21, internasOcultas: 3, usoDisponivel: true });
    const arvore = await carregar();
    assert.equal(texto(achar(arvore, 'p', /não aparecem aqui/)).startsWith('21 desativadas e 3 internas não aparecem aqui.'), true);
    achar(arvore, 'button', 'Ver desativadas');
    (achar(arvore, 'button', 'Ver internas').props.onClick as () => void)();
    const depois = t.render();
    assert.equal(achar(depois, 'button', 'Internas').props['aria-pressed'], true);
    assert.equal(elementos(depois).some((e) => ACHA(e, 'data-desativadas-ocultas')), false, 'sem aviso fora de Em uso');
});

test('só internas ocultas: aviso sem o atalho Ver desativadas', async () => {
    const arvore = await lista(null, { desativadasOcultas: 0, internasOcultas: 2, usoDisponivel: true }).carregar();
    assert.equal(texto(achar(arvore, 'p', /não aparecem aqui/)).startsWith('2 empresas internas não aparecem aqui.'), true);
    assert.equal(elementos(arvore).some((e) => e.type === 'button' && texto(e) === 'Ver desativadas'), false);
});

test('sem a 134: o filtro Internas não aparece (salvo se pedido pela URL)', async () => {
    const sem = await lista(null, { desativadasOcultas: 0, internasOcultas: 0, usoDisponivel: false }).carregar();
    assert.equal(elementos(sem).some((e) => e.type === 'button' && texto(e) === 'Internas'), false);
    // Astra r1 (P3): antes da resposta (lista ainda nula) o filtro também não aparece.
    const antes = lista(null, { usoDisponivel: true }).t.render();
    assert.equal(elementos(antes).some((e) => e.type === 'button' && texto(e) === 'Internas'), false);
    const com =await lista(null, { desativadasOcultas: 0, internasOcultas: 0, usoDisponivel: true }).carregar();
    achar(com, 'button', 'Internas');
    const pedido = lista('situacao=INTERNAS', { usoDisponivel: false });
    const arvore = await pedido.carregar();
    assert.match(pedido.consultas[0], /situacao=INTERNAS/);
    assert.equal(achar(arvore, 'button', 'Internas').props['aria-pressed'], true);
});

test('linha da empresa interna leva o selo Interna; cliente não', async () => {
    const item = (id: string, uso: string) => ({ id, codigo: id, nome: 'Buffet ' + id, status: 'ATIVA', situacao: 'ATIVA', situacaoRotulo: 'Ativa', criadoEm: '2026-11-01',
        atualizadoEm: '2026-11-01', implantacaoRotulo: null, responsavelNome: null, email: null, membrosAtivos: 1, convitesPendentes: 0, temCadastro: true, uso, comercial: { instalado: false, cobrado: false, situacao: null, nivel: null, ate: null } });
    const arvore = await lista('situacao=TODAS', { itens: [item('a', 'INTERNA'), item('b', 'CLIENTE')], total: 2, usoDisponivel: true }).carregar();
    assert.equal(elementos(arvore).filter((e) => ACHA(e, 'data-uso-interna')).length, 1);
});

function ficha(empresa: Record<string, unknown>, usoDisponivel: boolean) {
    const chamadas: Array<{ url: string; metodo?: string; corpo?: unknown }> = [];
    const dados = {
        empresa: { id: '00000000-0000-4000-8000-0000000000e1', codigo: 'buffet-x', nome: 'Buffet X', status: 'ATIVA', situacao: 'ATIVA', situacaoRotulo: 'Ativa',
            criadoEm: '2026-11-01', atualizadoEm: '2026-11-01', implantacaoRotulo: null, cadastro: null, ...empresa },
        membros: [], convites: [], atividade: [], implantacao: null, envioEmail: { configurado: true, motivo: null }, comercial: null, representacao: null, whatsapp: null, usoDisponivel,
    };
    const nulo = () => null;
    const t = carregarComponente('components/desenvolvedor/EmpresaFicha.tsx', {
        'next/link': { default: (p: { children?: unknown }) => p.children },
        '@/components/admin/admin.module.css': cssFalso, '@/components/admin/workspace.module.css': cssFalso, './desenvolvedor.module.css': cssFalso,
        './cliente': {
            chamar: async (url: string, metodo?: string, corpo?: unknown) => { chamadas.push({ url, metodo, corpo }); return metodo === 'POST' ? { ok: true, data: { uso: 'INTERNA', alterado: true } } : { ok: true, data: dados }; },
            formatarData: (s: string) => s, formatarDocumento: (s: string) => s ?? '—', formatarTelefone: (s: string) => s ?? '—', rotuloAcao: (s: string) => s,
        },
        './Reautenticacao': { useReautenticacao: () => ({ executar: async (op: () => Promise<unknown>, depois: (r: unknown) => Promise<void>) => depois(await op()), dialogo: null }) },
        './ComercialEmpresa': { default: nulo }, './RepresentacaoEmpresa': { default: nulo }, './SincronizarCobranca': { default: nulo }, './PendenciasCobranca': { default: nulo },
        './Empresas': { tomSituacao: () => 'ok' }, './PainelResumo': { rotuloResultado: (s: string) => s },
    });
    const p = { id: dados.empresa.id };
    const render = () => t.render('default', p);
    const carregar = async () => { render(); t.efeitos(); await tique(); await tique(); return render(); };
    return { t: { render }, chamadas, carregar };
}

test('ficha: marcar como interna pede motivo e envia acao uso; sem a 134 só avisa', async () => {
    const f = ficha({ uso: 'CLIENTE' }, true);
    let arvore = await f.carregar();
    assert.equal(elementos(arvore).some((e) => ACHA(e, 'data-uso-interna')), false);
    assert.match(texto(achar(arvore, 'h2', /Uso da empresa/)), /Cliente/);
    (achar(arvore, 'button', 'Marcar como interna…').props.onClick as () => void)();
    arvore = f.t.render();
    const confirmar = achar(arvore, 'button', 'Confirmar: interna');
    assert.equal(confirmar.props.disabled, true, 'sem motivo não confirma');
    const motivo = elementos(arvore).find((e) => e.type === 'input' && e.props.maxLength === 500 && e.props.value === '')!;
    (motivo.props.onChange as (ev: unknown) => void)({ target: { value: 'conta de demonstração' } });
    arvore = f.t.render();
    assert.equal(achar(arvore, 'button', 'Confirmar: interna').props.disabled, false);
    const form = elementos(arvore).find((e) => e.type === 'form' && elementos(e).some((x) => x.type === 'button' && texto(x) === 'Confirmar: interna'))!;
    (form.props.onSubmit as (ev: unknown) => void)({ preventDefault: () => undefined });
    await tique(); await tique();
    const post = f.chamadas.find((c) => c.metodo === 'POST')!;
    assert.match(post.url, /\/api\/desenvolvedor\/empresas\/00000000-0000-4000-8000-0000000000e1$/);
    assert.deepEqual(post.corpo, { acao: 'uso', dados: { uso: 'INTERNA', motivo: 'conta de demonstração' } });
    assert.match(texto(achar(f.t.render(), 'p', /marcada como interna/)), /Empresa marcada como interna\./);

    const interna = await ficha({ uso: 'INTERNA' }, true).carregar();
    assert.equal(elementos(interna).filter((e) => ACHA(e, 'data-uso-interna')).length, 1, 'selo no título');
    achar(interna, 'button', 'Marcar como cliente…');

    const sem = await ficha({}, false).carregar();
    assert.equal(elementos(sem).some((e) => ACHA(e, 'data-uso-indisponivel')), true);
    assert.equal(elementos(sem).some((e) => e.type === 'button' && /Marcar como/.test(texto(e))), false);
});
