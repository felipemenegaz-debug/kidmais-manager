import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

// Tela de privacidade (12/10/2026), renderizada sem DOM com a API simulada: seções de retenção, conversas e arquivos;
// toda ação pede a senha (reautenticação) antes do POST; excluir e revogar pedem também a palavra de confirmação; senha
// errada ou palavra errada não enviam nada.
const CONVERSA = { id: '11111111-1111-4111-8111-111111111111', contatoFinal: '0831', estado: 'AGUARDANDO_HUMANO', naoContatar: false, pausa: true, mensagens: 4, atualizadaEm: '2026-10-10T12:00:00.000Z' };
const ARQUIVO = { id: '22222222-2222-4222-8222-222222222222', nome: 'tabela.pdf', tipo: 'DOCUMENTO', tamanho: 100, criadoEm: '2026-10-01T12:00:00.000Z', expiraEm: null, revogadoEm: null, disponivel: true, vencido: false, enviosSemConfirmacao: 0, caminho: '/api/publico/x' };
const VENCIDO = { ...ARQUIVO, id: '33333333-3333-4333-8333-333333333333', nome: 'antigo.pdf', expiraEm: '2026-10-02T12:00:00.000Z', disponivel: false, vencido: true, caminho: null };
const DADOS = { busca: 'RECENTES', conversas: [CONVERSA], arquivos: [ARQUIVO, VENCIDO], retencao: { prazoDias: null, definidoEm: null, atrasada: false, ultimaExecucao: null }, registro: [] };

function montar(senhaCerta = true, opcoes: { dados?: unknown; statusPost?: number } = {}) {
  const posts: unknown[] = []; const gets: string[] = []; let reautenticacoes = 0;
  const adminFetch = async (url: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (opcoes.statusPost && opcoes.statusPost >= 400) return { ok: false, status: opcoes.statusPost, json: async () => { throw new SyntaxError('corpo ilegível'); } };
    } else gets.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true, data: opcoes.dados ?? DADOS }) };
  };
  const reautenticarSessao = async () => { reautenticacoes++; return senhaCerta ? { ok: true } : { ok: false, erro: 'Senha incorreta.', senhaIncorreta: true }; };
  const h = carregarComponente('components/admin/atendimento/PrivacidadeAtendimento.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children }, '@/lib/http/admin-fetch': { adminFetch, reautenticarSessao }, './atendimento.module.css': cssFalso,
  });
  globalThis.window = { setTimeout, clearTimeout } as never;
  const render = async () => { h.render(); h.efeitos(); await new Promise((r) => setTimeout(r, 5)); await tique(); const t = h.render(); h.efeitos(); return t; };
  return { posts, gets, render, reautenticacoes: () => reautenticacoes };
}
const clicar = async (e: Elemento) => { (e.props.onClick as () => unknown)(); await tique(); await tique(); };
const digitar = (e: Elemento, valor: string) => (e.props.onChange as (ev: unknown) => void)({ target: { value: valor } });
const campo = (t: unknown, nome: string) => elementos(t).find((e) => e.type === 'input' && e.props.name === nome)!;

test('tela: retenção sem prazo padrão, conversas e arquivos com situação; limites da exclusão visíveis', async () => {
  const m = montar(); const t = await m.render();
  assert.match(texto(t), /Sem exclusão automática: nenhum prazo foi definido/);
  assert.match(texto(t), /A rotina de retenção ainda não foi executada/);
  assert.match(texto(t), /Final 0831 · 4 mensagem\(ns\).*pediu pausa/);
  assert.match(texto(t), /tabela\.pdf · Disponível/); assert.match(texto(t), /antigo\.pdf · Vencido/);
  assert.match(texto(t), /Não alcança cópias que o WhatsApp, o cliente ou os backups já guardaram/);
  assert.ok(achar(t, 'button', 'Reativar'), 'arquivo vencido oferece reativar (com link novo)');
});
test('excluir: palavra errada não envia; senha e palavra certas reautenticam e enviam com a confirmação', async () => {
  const m = montar(); let t = await m.render();
  await clicar(achar(t, 'button', 'Excluir dados')); t = await m.render();
  assert.match(texto(t), /Excluir os dados desta conversa/); assert.match(texto(t), /O pedido de parar\/pausa continua valendo/);
  digitar(campo(t, 'senha'), 'senha-sintetica'); digitar(campo(t, 'confirmacao'), 'apagar'); t = await m.render();
  await clicar(achar(t, 'button', 'Confirmar')); t = await m.render();
  assert.equal(m.posts.length, 0); assert.equal(m.reautenticacoes(), 0); assert.match(texto(t), /Digite EXCLUIR para confirmar/);
  digitar(campo(t, 'senha'), 'senha-sintetica'); digitar(campo(t, 'confirmacao'), 'EXCLUIR'); t = await m.render();
  await clicar(achar(t, 'button', 'Confirmar')); await m.render();
  assert.equal(m.reautenticacoes(), 1);
  assert.deepEqual(m.posts, [{ acao: 'excluir_conversa', conversaId: CONVERSA.id, motivo: 'PEDIDO_DO_TITULAR', confirmacao: 'EXCLUIR' }]);
});
test('revogar com senha errada: nada é enviado; retenção e troca de link pedem senha', async () => {
  const errada = montar(false); let t = await errada.render();
  await clicar(achar(t, 'button', 'Revogar')); t = await errada.render();
  digitar(campo(t, 'senha'), 'x'); digitar(campo(t, 'confirmacao'), 'REVOGAR'); t = await errada.render();
  await clicar(achar(t, 'button', 'Confirmar')); t = await errada.render();
  assert.equal(errada.posts.length, 0); assert.match(texto(t), /Senha incorreta. Nada foi alterado./);
  const m = montar(); t = await m.render();
  digitar(campo(t, 'prazo'), '90'); t = await m.render();
  await clicar(achar(t, 'button', 'Definir prazo')); t = await m.render();
  digitar(campo(t, 'senha'), 's'); t = await m.render(); await clicar(achar(t, 'button', 'Confirmar')); t = await m.render();
  await clicar(achar(t, 'button', 'Trocar link')); t = await m.render();
  digitar(campo(t, 'senha'), 's'); t = await m.render(); await clicar(achar(t, 'button', 'Confirmar')); await m.render();
  assert.deepEqual(m.posts, [{ acao: 'retencao', prazoDias: 90 }, { acao: 'trocar_link', arquivoId: ARQUIVO.id }]);
  assert.equal(m.reautenticacoes(), 2);
});

test('revisão de 69dc301: busca pelo número completo (M4), atraso sem números globais (M5), aviso de envio sem confirmação (B1)', async () => {
  const dados = { ...DADOS, retencao: { prazoDias: 30, definidoEm: '2026-10-10T12:00:00.000Z', atrasada: true, ultimaExecucao: { iniciadaEm: '2026-10-09T03:00:00.000Z', terminadaEm: '2026-10-09T03:01:00.000Z', situacao: 'EXECUTADA', excluidasDestaEmpresa: 2 } },
    arquivos: [{ ...ARQUIVO, enviosSemConfirmacao: 2 }] };
  const m = montar(true, { dados }); let t = await m.render();
  assert.match(texto(t), /executada; 2 conversa\(s\) desta empresa/); assert.doesNotMatch(texto(t), /falha/);
  assert.match(texto(t), /não terminou nas últimas 36 horas/);
  assert.match(texto(t), /busque pelo número completo/);
  digitar(campo(t, 'busca'), '+55 (61) 90000-0831'); t = await m.render();
  const form = elementos(t).find((e) => e.type === 'form')!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await tique(); t = await m.render();
  assert.equal(m.gets.at(-1), '/api/admin/atendimento/privacidade?contato=5561900000831', 'M4: só dígitos, busca exata no servidor');
  await clicar(achar(t, 'button', 'Revogar')); t = await m.render();
  assert.match(texto(t), /2 envio\(s\) deste arquivo ainda sem confirmação de entrega/, 'B1: aviso antes de revogar');
});
test('revisão de 69dc301: falha do servidor (5xx) não afirma que nada mudou (B3)', async () => {
  const m = montar(true, { statusPost: 503 }); let t = await m.render();
  await clicar(achar(t, 'button', 'Trocar link')); t = await m.render();
  digitar(campo(t, 'senha'), 's'); t = await m.render(); await clicar(achar(t, 'button', 'Confirmar')); t = await m.render();
  assert.match(texto(t), /Não foi possível confirmar o resultado/); assert.doesNotMatch(texto(t), /Nada foi alterado/);
});
