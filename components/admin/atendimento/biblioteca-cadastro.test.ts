import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';
import * as prontas from '../../../lib/whatsapp/atendimento/prontas.ts';
import { LIMITE_ARQUIVO } from '../../../lib/whatsapp/atendimento/arquivos.ts';

// Rodada 40: cadastro da biblioteca simplificado — o que adicionar em cartões, área de arquivo evidente (arrastar ou
// clicar, formatos e limites visíveis), conferência do arquivo antes do envio, prévia com nome, tamanho e ações, quem
// pode enviar (só a equipe ou o Wall-e também, com o assunto) e opções avançadas recolhidas.
const responder = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
const ARQ = { id: '3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f', tipo: 'DOCUMENTO', nome: 'cardapio-completa.pdf', tamanho: 734003, caminho: '/api/admin/atendimento/arquivos/3f3f' };

function montar() {
  const chamadas: { url: string; corpo: unknown }[] = [];
  const adminFetch = async (url: string, init?: { method?: string; body?: unknown }) => {
    if (!init?.method) return responder({ prontas: [], favoritas: [], podeGerenciar: true, recursos074: true, recursos075: true, pacotes: [{ codigo: 'COMPLETA', nome: 'Completa' }], unidades: [] });
    if (url.startsWith('/api/admin/atendimento/arquivos')) { chamadas.push({ url, corpo: init.body }); return responder(ARQ); }
    chamadas.push({ url, corpo: JSON.parse(String(init.body)) }); return responder(null);
  };
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso,
  });
  const render = async () => { h.render('GerenciarMensagensProntas', { pagina: true }); h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); const t = h.render('GerenciarMensagensProntas', { pagina: true }); h.efeitos(); return t; };
  return { chamadas, render };
}
const clicar = async (e: Elemento) => { (e.props.onClick as () => unknown)(); await tique(); };
const radio = (t: unknown, valor: string) => elementos(t).find(e => e.type === 'input' && e.props.type === 'radio' && e.props.value === valor)!;
const soltar = async (alvo: Elemento, arquivo: File) => { (alvo.props.onDrop as (e: unknown) => unknown)({ preventDefault() {}, dataTransfer: { files: [arquivo] } }); await tique(); await tique(); };

test('biblioteca: adicionar arquivo por arrastar — formatos e limites visíveis, conferência antes do envio e prévia com ações', async () => {
  globalThis.window = globalThis as never;
  const m = montar();
  let t = await m.render();
  await clicar(achar(t, 'button', 'Adicionar mensagem ou arquivo'));
  t = await m.render();
  // O que adicionar: cartões de rádio (setas do teclado), com o link do contrato separado do link comum.
  const legendas = elementos(t).filter(e => e.type === 'legend').map(texto);
  assert.ok(legendas.includes('O que você quer adicionar?'));
  assert.ok(texto(achar(t, 'fieldset', /O que você quer adicionar/)).includes('Link do contrato do cliente'));
  (radio(t, 'ARQUIVO').props.onChange as () => void)();
  t = await m.render();
  const area = achar(t, 'button', /Arraste seu arquivo ou clique para escolher/);
  assert.match(texto(area), /Foto JPG ou PNG até 5 MB · Vídeo MP4 ou 3GP até 16 MB · PDF até 16 MB/);
  // Formato não aceito e arquivo grande: mensagem clara, nada é enviado.
  await soltar(area, new File(['x'], 'planilha.xlsx', { type: 'application/vnd.ms-excel' }));
  t = await m.render();
  assert.match(texto(achar(t, 'p', /não é um formato aceito/)), /“planilha\.xlsx” não é um formato aceito/);
  await soltar(achar(t, 'button', /Arraste seu arquivo/), new File([new Uint8Array(6 * 1048576)], 'festa.jpg', { type: 'image/jpeg' }));
  t = await m.render();
  assert.match(texto(achar(t, 'p', /pode ter até/)), /“festa\.jpg” tem 6 MB; foto pode ter até 5 MB\./);
  assert.equal(m.chamadas.length, 0);
  // PDF válido: enviado com o tipo do arquivo; a prévia mostra ícone, nome, tamanho e Visualizar/Substituir/Remover.
  await soltar(achar(t, 'button', /Arraste seu arquivo/), new File(['%PDF-1.4'], 'cardapio-completa.pdf', { type: 'application/pdf' }));
  t = await m.render();
  assert.equal(m.chamadas[0].url, '/api/admin/atendimento/arquivos?tipo=DOCUMENTO');
  const escolhido = texto(achar(t, 'div', /cardapio-completa\.pdf/));
  assert.match(escolhido, /PDF · 717 KB/);
  assert.ok(elementos(t).some(e => e.type === 'a' && /^Visualizar/.test(texto(e)) && e.props.target === '_blank'));
  for (const acao of [/^Substituir/, /^Remover/]) assert.ok(achar(t, 'button', acao));
  await clicar(achar(t, 'button', /^Remover cardapio/));
  t = await m.render();
  assert.ok(achar(t, 'button', /Arraste seu arquivo/), 'remover volta à área de arquivo');
});

test('biblioteca: "Wall-e também pode enviar" pede o assunto; sem legenda vai o nome; categoria e rascunho em "Mais opções"', async () => {
  globalThis.window = globalThis as never;
  const m = montar();
  let t = await m.render();
  await clicar(achar(t, 'button', 'Adicionar mensagem ou arquivo'));
  t = await m.render();
  (radio(t, 'ARQUIVO').props.onChange as () => void)();
  t = await m.render();
  await soltar(achar(t, 'button', /Arraste seu arquivo/), new File(['%PDF-1.4'], 'cardapio-completa.pdf', { type: 'application/pdf' }));
  t = await m.render();
  const nome = elementos(t).find(e => e.type === 'input' && e.props.placeholder === 'Ex.: Cardápio do Completa')!;
  (nome.props.onChange as (e: unknown) => void)({ target: { value: 'Cardápio do Completa' } });
  t = await m.render();
  // Só a equipe por padrão; o assunto do Wall-e só aparece quando ele pode enviar.
  assert.ok(!elementos(t).some(e => e.type === 'label' && /Quando o Wall-e envia/.test(texto(e))));
  const usos = elementos(t).filter(e => e.type === 'input' && e.props.type === 'radio' && String(e.props.name).endsWith('-uso'));
  assert.equal(usos.length, 2);
  (usos[1].props.onChange as () => void)();
  t = await m.render();
  assert.ok(elementos(t).some(e => e.type === 'label' && /Quando o Wall-e envia/.test(texto(e))));
  (achar(t, 'form').props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await tique();
  t = await m.render();
  assert.ok(elementos(t).some(e => e.props.role === 'alert' && /Escolha quando o Wall-e pode enviar/.test(texto(e))));
  const assunto = elementos(t).find(e => e.type === 'select' && e.props.required)!;
  (assunto.props.onChange as (e: unknown) => void)({ target: { value: 'CARDAPIO' } });
  t = await m.render();
  // Opções avançadas recolhidas.
  const mais = achar(t, 'details', /Mais opções/);
  assert.ok(!mais.props.open, '"Mais opções" começa recolhido');
  assert.ok(/Categoria/.test(texto(mais)) && /Atalho no atendimento/.test(texto(mais)) && /Guardar como rascunho/.test(texto(mais)));
  (achar(t, 'form').props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await tique(); await tique();
  const salvo = m.chamadas.find(c => (c.corpo as { acao?: string })?.acao === 'salvar')!.corpo as { pronta: Record<string, unknown> };
  assert.equal(salvo.pronta.tipo, 'DOCUMENTO');
  assert.equal(salvo.pronta.arquivoId, ARQ.id);
  assert.equal(salvo.pronta.texto, 'Cardápio do Completa', 'sem legenda, o arquivo vai com o nome');
  assert.equal(salvo.pronta.categoria, 'Geral');
  assert.equal(salvo.pronta.envioAutomatico, true);
  assert.equal(salvo.pronta.finalidade, 'CARDAPIO');
  assert.equal(salvo.pronta.estado, 'PUBLICADA');
});

test('limites mostrados na tela são os mesmos do servidor; tipo pelo navegador ou pela extensão', () => {
  assert.deepEqual(prontas.LIMITE_ANEXO_BYTES, LIMITE_ARQUIVO);
  assert.equal(prontas.tipoDoArquivo('image/png', 'a.png'), 'IMAGEM');
  assert.equal(prontas.tipoDoArquivo('', 'video.3GP'), 'VIDEO');
  assert.equal(prontas.tipoDoArquivo('application/octet-stream', 'tabela.pdf'), 'DOCUMENTO');
  assert.equal(prontas.tipoDoArquivo('image/gif', 'a.gif'), null);
});
