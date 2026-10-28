import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { PedidoTela } from './ConsentimentoAssistente';

// Renderiza o formulário real do consentimento MCP. CSS e rede são isolados; não abre banco ou navegador.
const semRede = () => { throw new Error('Rede proibida no teste do consentimento.'); };
const css = { 'workspace.module.css': {}, 'admin.module.css': {}, 'visual.module.css': {}, 'http/admin-fetch': { adminFetch: semRede } };
const cache = new Map<string, Record<string, unknown>>();
const { FormularioConsentimento } = carregarModulo('components/admin/ConsentimentoAssistente.tsx', css, cache) as {
    FormularioConsentimento: ComponentType<{ pedido: PedidoTela; empresa: { id: string; nome: string }; ocupado: boolean; enviar: () => void }>;
};

function tela(empresaNoPiloto: boolean) {
    const pedido: PedidoTela = { clienteNome: 'ChatGPT', clientHost: 'chatgpt.com', redirectHost: 'chatgpt.com', escopos: ['agenda:read'], expiraEm: '2026-10-28T10:00:00Z', empresaNoPiloto };
    return renderToStaticMarkup(createElement(FormularioConsentimento, { pedido, empresa: { id: 'e1', nome: 'Buffet Sintético' }, ocupado: false, enviar: semRede })).replace(/ /g, ' ');
}

test('teste real (28/10): a tela diz que a conexão vale só para a empresa ativa e como trocar', () => {
    const html = tela(true);
    assert.match(html, /data-empresa="true">Buffet Sintético/);
    assert.match(html, /data-aviso-empresa/);
    assert.match(html, /troque a empresa ativa no menu do KidMais e recarregue esta página/);
    assert.match(html, /data-permitir/);
    assert.doesNotMatch(html, /data-fora-do-piloto/);
});

test('teste real (28/10): empresa ativa fora do piloto não mostra Permitir; avisa e deixa recusar', () => {
    const html = tela(false);
    assert.match(html, /data-fora-do-piloto/);
    assert.match(html, /ainda não participa do piloto/);
    assert.doesNotMatch(html, /data-permitir/);
    assert.match(html, /data-negar/);
});

// Revisão do Astra (28/10, P2-1): a carga tem prazo, cancela as requisições e diz se dá para tentar de novo.
const { carregarPedido } = carregarModulo('components/admin/ConsentimentoAssistente.tsx', css, cache) as {
    carregarPedido: (deps: { lerPedido: (s: AbortSignal) => Promise<Response>; lerSessao: (s: AbortSignal) => Promise<Response>; prazoMs: number; cancelamento?: AbortSignal }) =>
        Promise<{ ok: true; pedido: PedidoTela; empresa: { id: string; nome: string } } | { ok: false; erro: string; recuperavel: boolean }>;
};
const PEDIDO_OK = { clienteNome: 'Claude', clientHost: 'claude.ai', redirectHost: 'claude.ai', escopos: ['agenda:read'], expiraEm: '2026-10-28T10:00:00Z', empresaNoPiloto: true };
const sessaoOk = async () => Response.json({ ok: true, data: { contexto: { empresaAtual: { id: 'e1', nome: 'Buffet Sintético' } } } });
const pendurado = (sinais: AbortSignal[]) => (s: AbortSignal) => { sinais.push(s); return new Promise<Response>(() => undefined); };

test('P2-1: pedido pendurado vence no prazo, aborta as requisições e é recuperável', async () => {
    const sinais: AbortSignal[] = [];
    const inicio = Date.now();
    const c = await carregarPedido({ lerPedido: pendurado(sinais), lerSessao: (s) => { sinais.push(s); return sessaoOk(); }, prazoMs: 60 });
    assert.ok(Date.now() - inicio < 1000);
    assert.equal(c.ok, false);
    assert.equal(c.ok === false && c.recuperavel, true);
    assert.match(c.ok === false ? c.erro : '', /demorou/);
    assert.ok(sinais.length === 2 && sinais.every((s) => s.aborted), 'as duas requisições foram abortadas');
});

test('P2-1: corpo que nunca termina também vence no prazo', async () => {
    const corpoPreso = { ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response;
    const c = await carregarPedido({ lerPedido: async () => corpoPreso, lerSessao: sessaoOk, prazoMs: 60 });
    assert.equal(c.ok === false && c.recuperavel, true);
});

test('P2-1: pedido inválido não é recuperável (mensagem do servidor); 5xx e falha de rede são', async () => {
    const invalido = await carregarPedido({ lerPedido: async () => Response.json({ ok: false, erro: 'Pedido de conexão inválido ou expirado. Volte ao aplicativo e conecte novamente.' }, { status: 404 }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.deepEqual(invalido, { ok: false, erro: 'Pedido de conexão inválido ou expirado. Volte ao aplicativo e conecte novamente.', recuperavel: false });
    const indisponivel = await carregarPedido({ lerPedido: async () => Response.json({ ok: false, erro: 'Indisponível' }, { status: 503 }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.equal(indisponivel.ok === false && indisponivel.recuperavel, true);
    const rede = await carregarPedido({ lerPedido: async () => { throw new TypeError('fetch failed'); }, lerSessao: sessaoOk, prazoMs: 1000 });
    assert.equal(rede.ok === false && rede.recuperavel, true);
});

test('P2-1: carga normal entrega pedido e empresa; sair da tela aborta', async () => {
    const ok = await carregarPedido({ lerPedido: async () => Response.json({ ok: true, data: PEDIDO_OK }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.deepEqual(ok, { ok: true, pedido: PEDIDO_OK, empresa: { id: 'e1', nome: 'Buffet Sintético' } });
    const sinais: AbortSignal[] = [];
    const saida = new AbortController();
    const carga = carregarPedido({ lerPedido: pendurado(sinais), lerSessao: pendurado(sinais), prazoMs: 200, cancelamento: saida.signal });
    saida.abort();
    assert.ok(sinais.every((s) => s.aborted), 'desmontar a tela aborta as requisições');
    await carga;
});
