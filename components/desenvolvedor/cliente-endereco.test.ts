import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/** Helper real de /desenvolvedor durante a troca de host (plano D4, H23). */
type Resultado = { ok: boolean; erro?: string; codigo?: string | null; data?: unknown; status?: number };
function ambiente(resposta: () => Promise<Response>, comeca = false) {
    let final = comeca;
    const navegacoes: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/desenvolvedor', assign: (u: string) => navegacoes.push(u) } };
    g.fetch = resposta;
    const mod = carregarModulo('components/desenvolvedor/cliente.ts', {
        'http/admin-fetch': { adminFetch: async () => { throw new Error('não usado'); }, reautenticarSessao: async () => ({ ok: true }), lerCorpoOuNulo: (r: Response) => r.json().catch(() => null) },
        'http/contexto-empresa-cliente': { saidaDaSessaoEmAndamento: () => false },
        'enderecos/cliente': { enderecoFinal: () => final },
    }) as unknown as { chamar: (u: string) => Promise<Resultado> };
    return { mod, navegacoes, finalizar: () => { final = true; } };
}

test('aba final: 401 tardio não leva ao login e não mostra sessão terminada', async () => {
    const a = ambiente(async () => new Response('{}', { status: 401 }), true);
    const r = await a.mod.chamar('/api/admin/x');
    assert.equal(r.ok, false);
    assert.equal(r.codigo, 'ENDERECO_EM_VERIFICACAO');
    assert.deepEqual(a.navegacoes, []);
});

test('final chegando durante a leitura do corpo: dados não entregues', async () => {
    let a: ReturnType<typeof ambiente> | null = null;
    const r = new Response('{"ok":true,"data":1}');
    const ler = r.json.bind(r);
    r.json = async () => { a!.finalizar(); return ler(); };
    a = ambiente(async () => r);
    const res = await a.mod.chamar('/api/admin/x');
    assert.equal(res.ok, false);
    assert.equal(res.codigo, 'ENDERECO_EM_VERIFICACAO');
});

test('fora do estado final: 401 vai ao login e os dados chegam, como hoje', async () => {
    const a = ambiente(async () => new Response('{}', { status: 401 }));
    assert.equal((await a.mod.chamar('/api/admin/x')).codigo, 'AUTENTICACAO');
    assert.match(a.navegacoes[0]!, /^\/admin\/login\?voltar=/);
    const b = ambiente(async () => new Response('{"ok":true,"data":1}'));
    assert.deepEqual(await b.mod.chamar('/api/admin/x'), { ok: true, data: 1 });
});
