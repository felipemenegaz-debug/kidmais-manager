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
