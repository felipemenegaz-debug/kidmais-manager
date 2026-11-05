import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Revisão do Astra (28/10/2026, P2-2): a sessão encerrada detectada pelo adminFetch, antes ou depois da requisição,
 * também volta ao consentimento depois do login. Fora do consentimento, o login continua simples.
 */
const PEDIDO = `kmp_${'B'.repeat(43)}`;
const LOGIN_COM_RETORNO = `/admin/login?voltar=${encodeURIComponent(`/admin/conexoes-ia/autorizar?pedido=${PEDIDO}`)}`;
type Leitura = { sessaoId: string | null; empresa: string | null };

function ambiente(pathname: string, search: string, sessoes: Leitura[]) {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    let leitura = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname, search, replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    g.fetch = async (input: string, init: RequestInit = {}) => {
        if (String(input) === '/api/admin/autenticacao' && (init.method ?? 'GET') === 'GET') {
            const s = sessoes[Math.min(leitura, sessoes.length - 1)];
            leitura += 1;
            return Response.json({ ok: true, data: { usuarioId: s.sessaoId ? 'u' : null, sessaoId: s.sessaoId, csrf: 'c', contexto: { empresaAtual: s.empresa ? { id: s.empresa } : null } } });
        }
        return Response.json({ ok: true });
    };
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, new Map()) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return { mod, navegacoes };
}

test('P2-2: sessão já encerrada ao carregar o consentimento → login com retorno ao pedido', async () => {
    const a = ambiente('/admin/conexoes-ia/autorizar', `?pedido=${PEDIDO}`, [{ sessaoId: null, empresa: null }]);
    await assert.rejects(a.mod.adminFetch('/api/admin/mcp/consentimento?pedido=x'));
    assert.deepEqual(a.navegacoes, [`assign:${LOGIN_COM_RETORNO}`]);
});

test('P2-2: sessão encerra durante o Permitir (depois da resposta) → login com retorno ao pedido', async () => {
    const a = ambiente('/admin/conexoes-ia/autorizar', `?pedido=${PEDIDO}`, [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: null, empresa: null }]);
    await assert.rejects(a.mod.adminFetch('/api/admin/mcp/consentimento?empresaId=A', { method: 'POST' }));
    assert.equal(a.navegacoes.at(-1), `replace:${LOGIN_COM_RETORNO}`);
});

test('P2-2: fora do consentimento, sessão encerrada continua indo ao login simples', async () => {
    const a = ambiente('/admin/clientes', '?x=1', [{ sessaoId: null, empresa: null }]);
    await assert.rejects(a.mod.adminFetch('/api/x'));
    assert.deepEqual(a.navegacoes, ['assign:/admin/login']);
});
