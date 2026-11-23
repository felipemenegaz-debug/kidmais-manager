import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, cssFalso, tique } from '../teste-componente.ts';

// Wall-e 1a r4 (P1-2): o link "a revisar" da Privacidade do atendimento abre /admin/marketing/origens?contato=<id> e a
// tela abre direto o detalhe desse cartão (carregado pela API, que corta por empresa e ambiente). Id fora do formato: nada.
const K = '44444444-4444-4444-8444-444444444444';

async function montar(search: string) {
  const urls: string[] = [];
  const useMarketing = (url: string) => { urls.push(url); return { dados: null, falha: null, carregando: true, recarregar: () => undefined }; };
  const h = carregarComponente('components/admin/marketing/MarketingOrigens.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children }, 'next/navigation': { useRouter: () => ({ push: () => undefined }) },
    '@/lib/clientes/utils': { statusFechamentoLabel: () => '' }, '@/lib/marketing/acoes-ui': { linkChamar: () => '', linkNegociacao: () => '' },
    '@/lib/http/admin-fetch': { adminFetch: async () => ({ ok: true, json: async () => ({}) }) },
    '@/lib/marketing/apresentacao': { clientesDaBusca: () => [], dataBr: () => '', dataHoraBr: () => '', ROTULO_STATUS_CONTATO: {} },
    '../AdminPrimaryButton': { AdminPrimaryButton: () => null }, './AtribuicaoExplicada': { AtribuicaoExplicada: () => null },
    './comum': { CabecalhoMarketing: () => null, EstadoCarga: () => null, enviarMarketing: async () => ({}), novaChave: () => 'k', useMarketing },
    './marketing.module.css': cssFalso,
  });
  globalThis.window = { setTimeout, clearTimeout, location: { search } } as never;
  globalThis.document = { addEventListener: () => undefined, removeEventListener: () => undefined } as never;
  h.render(); h.efeitos(); await new Promise((r) => setTimeout(r, 5)); await tique();
  const arvore = h.render(); h.efeitos();
  return { urls, arvore, h };
}

test('r4: ?contato=<uuid> abre o detalhe do cartão; id fora do formato é ignorado', async () => {
  const certo = await montar(`?contato=${K}`);
  const detalhe = (u: string) => u.startsWith('/api/admin/marketing/contatos?id=');
  // O detalhe é um componente filho: renderiza-o pela árvore da tela.
  const filhos = JSON.stringify(certo.arvore, (_k, v) => typeof v === 'function' ? undefined : v);
  assert.ok(filhos.includes(K), 'o detalhe do cartão pedido está aberto');
  const errado = await montar('?contato=javascript:alert(1)');
  const filhosErrado = JSON.stringify(errado.arvore, (_k, v) => typeof v === 'function' ? undefined : v);
  assert.equal(filhosErrado.includes('alert'), false, 'nada aberto com id fora do formato');
  assert.equal(errado.urls.some(detalhe), false);
});
