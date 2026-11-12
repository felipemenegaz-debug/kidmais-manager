import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogoAdicionais from './catalogo-adicionais.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';

/**
 * S-A2 (103), parecer do Astra de 26/10/2026 (P2-2): o botão "Adicionar serviços comuns" na seção Outros adicionais.
 * - só aparece com a categoria global Serviços instalada (e adicionais disponíveis, 070);
 * - envia o POST sem empresa no corpo (a empresa é a da sessão, comprovada no servidor);
 * - mostra o resultado de cada um dos quatro serviços e recarrega a lista; erro do servidor (ex.: sem Gestão) aparece;
 * - não reenvia enquanto o pedido está em curso.
 */
function Botao(props: { children?: unknown }) { return props.children; }
const SERVICOS = { codigo: 'SERVICOS', nome: 'Serviços' };
const adicionaisCom = (categorias: Array<{ codigo: string; nome: string }>, migracaoPendente = false) => ({
  migracaoPendente, tabelaCorrente: true, aviso: null, categorias, pacotes: [], adicionais: [],
});
const RESULTADO = [
  { codigo: 'SERVICO_ANIMACAO', nome: 'Animação e personagem', situacao: 'CRIADO', texto: 'criado' },
  { codigo: 'SERVICO_GERENTE', nome: 'Gerente de festa', situacao: 'JA_EXISTIA', texto: 'já existia' },
  { codigo: 'SERVICO_MONITORES', nome: 'Monitores de recreação', situacao: 'INATIVO', texto: 'já existe, mas está inativo (não foi reativado)' },
  { codigo: 'SERVICO_RECREACAO', nome: 'Recreação', situacao: 'CONFLITO', texto: 'o código já é usado por outro adicional (nada foi alterado)' },
];

function tela(adicionais: unknown, post: () => Promise<Response>) {
  const chamadas: Array<{ url: string; metodo: string; corpo: string | null }> = [];
  const adminFetch = async (url: string, init?: RequestInit) => {
    chamadas.push({ url, metodo: init?.method ?? 'GET', corpo: init?.body ? String(init.body) : null });
    if (init?.method === 'POST') return post();
    if (url.includes('/catalogo')) return Response.json({ ok: true, data: { categorias: [], itens: [] } });
    return Response.json({ ok: true, data: adicionais });
  };
  const t = carregarComponente('components/admin/CatalogoEditor.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, './catalogo-adicionais': catalogoAdicionais,
    './workspace.module.css': cssFalso, './catalogo-editor.module.css': cssFalso,
  });
  return { t, chamadas };
}

async function naSecaoOutros(t: ReturnType<typeof tela>['t']) {
  t.render();
  t.efeitos();
  await tique(); await tique();
  (achar(t.render(), 'button', 'Outros adicionais').props.onClick as () => void)();
  return () => t.render();
}

test('sem a categoria Serviços (103 ausente) ou com a 070 pendente, o botão não aparece', async () => {
  for (const adicionais of [adicionaisCom([{ codigo: 'DECORACAO', nome: 'Decoração' }]), adicionaisCom([SERVICOS], true)]) {
    const { t } = tela(adicionais, async () => Response.json({ ok: true, data: RESULTADO }));
    const render = await naSecaoOutros(t);
    assert.equal(elementos(render()).some((e) => e.props['data-servicos-comuns'] !== undefined), false);
  }
});

test('com a 103: o clique envia o POST sem empresa, mostra o resultado de cada serviço e recarrega os adicionais', async () => {
  const { t, chamadas } = tela(adicionaisCom([SERVICOS]), async () => Response.json({ ok: true, data: RESULTADO }));
  const render = await naSecaoOutros(t);
  const getsAntes = chamadas.filter((c) => c.metodo === 'GET' && c.url.includes('/adicionais')).length;
  (achar(render(), 'button', 'Adicionar serviços comuns').props.onClick as () => void)();
  await tique(); await tique(); await tique();
  const post = chamadas.filter((c) => c.metodo === 'POST');
  assert.equal(post.length, 1);
  assert.equal(post[0]!.url, '/api/admin/configuracoes/adicionais/servicos-comuns');
  assert.equal(post[0]!.corpo, '{}', 'sem empresaId: a empresa vem da sessão');
  const arvore = render();
  for (const r of RESULTADO) assert.match(texto(arvore), new RegExp(`${r.nome}: ${r.texto.replace(/[()]/g, '\\$&')}`));
  assert.match(texto(arvore), /1 serviço\(s\) adicionado\(s\) sem preço/);
  assert.equal(chamadas.filter((c) => c.metodo === 'GET' && c.url.includes('/adicionais')).length, getsAntes + 1, 'lista recarregada');
});

test('erro do servidor (ex.: sem Gestão) aparece; o botão fica desabilitado durante o pedido e não reenvia', async () => {
  let liberar!: (r: Response) => void;
  const pendente = new Promise<Response>((fim) => { liberar = fim; });
  const { t, chamadas } = tela(adicionaisCom([SERVICOS]), () => pendente);
  const render = await naSecaoOutros(t);
  const clicar = () => (achar(render(), 'button', /Adicionar serviços comuns|Adicionando/).props.onClick as () => void)();
  clicar();
  await tique();
  assert.equal(achar(render(), 'button', 'Adicionando…').props.disabled, true);
  clicar();
  assert.equal(chamadas.filter((c) => c.metodo === 'POST').length, 1, 'não reenvia');
  liberar(Response.json({ ok: false, erro: 'Apenas o proprietário pode editar os adicionais.', codigo: 'PAPEL_NAO_AUTORIZADO' }, { status: 403 }));
  await tique(); await tique();
  assert.match(texto(render()), /Apenas o proprietário pode editar os adicionais\./);
  assert.equal(achar(render(), 'button', 'Adicionar serviços comuns').props.disabled, false);
});
