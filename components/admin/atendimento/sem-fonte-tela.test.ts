import assert from 'node:assert/strict';
import test from 'node:test';
import * as acessoTela from '../../../lib/whatsapp/atendimento/acesso-tela.ts';
import * as core from '../../../lib/whatsapp/atendimento/core.ts';
import * as horario from '../../../lib/whatsapp/atendimento/horario.ts';
import * as semFonteTexto from '../../../lib/whatsapp/atendimento/sem-fonte-texto.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

// Fatia 7 (Astra r2, P3): o selo da lista acompanha a tela de configuração SEM remontar: rascunho logo depois de
// "Criar resposta", "Já tem resposta aprovada" depois de salvar (a configuração é recarregada da API) e o botão de volta
// depois de remover e salvar. Tela renderizada sem DOM, com a API simulada (o servidor guarda o que o POST mandou).
const GRUPO = { id: 'g1', texto: 'Tem fraldário?', ocorrencias: 2, ultimaEm: '2027-01-19T10:00:00.000Z', jaPublicada: false, precisaRevisar: false };

function montar() {
  let salva: { perguntas: { id: string; pergunta: string; resposta: string }[] } & Record<string, unknown> = { ativo: false, nome: 'Empresa sintética', perguntas: [], limites: { respostasPor24h: 20 }, wallE: { ativo: false } };
  const gets: string[] = [];
  const adminFetch = async (url: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') salva = JSON.parse(String(init.body)).configuracao;
    else gets.push(url);
    const data = url.endsWith('/sem-fonte')
      ? { disponivel: true, dias: 30, grupos: [GRUPO], omitidasSensiveis: 0, limite: 30, publicadas: salva.perguntas.length }
      : { configuracao: salva, automacaoDisponivel: true, podeConfigurar: true, wallE: { disponivel: true } };
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  function Lista(props: Record<string, unknown>) { return props; }
  const deps = { '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/core': core, '@/lib/whatsapp/atendimento/sem-fonte-texto': semFonteTexto, './atendimento.module.css': cssFalso };
  const tela = carregarComponente('components/admin/atendimento/ConfiguracaoAtendimento.tsx', {
    ...deps, 'next/link': { default: (p: { children?: unknown }) => p.children }, './PerguntasSemFonte': { default: Lista },
    '@/lib/whatsapp/atendimento/acesso-tela': acessoTela, '@/lib/whatsapp/atendimento/horario': horario,
  });
  const lista = carregarComponente('components/admin/atendimento/PerguntasSemFonte.tsx', deps);
  globalThis.window = { setTimeout, clearTimeout } as never;
  globalThis.document = { getElementById: () => null } as never;
  const espera = async () => { await new Promise((r) => setTimeout(r, 5)); await tique(); };
  const render = async () => { tela.render(); tela.efeitos(); await espera(); const t = tela.render(); tela.efeitos(); return t; };
  /** A lista real, com as props que a tela passou neste render. */
  const renderLista = async (props: Record<string, unknown>) => { lista.render('default', props); lista.efeitos(); await espera(); return lista.render('default', props); };
  return { render, renderLista, Lista, gets, salva: () => salva };
}
const propsDaLista = (t: unknown, Lista: unknown) => elementos(t).find((e) => e.type === Lista)!.props;
const submeter = async (t: unknown) => { (achar(t, 'form').props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 5)); await tique(); await tique(); };

test('sem fonte na tela: rascunho, publicada depois de salvar e o botão de volta depois de remover e salvar', async () => {
  const m = montar();
  let t = await m.render();
  let props = propsDaLista(t, m.Lista);
  let l = await m.renderLista(props);
  assert.ok(achar(l, 'button', /Criar resposta/));

  // 1) Criar resposta: só no formulário → rascunho (nunca "Já tem resposta aprovada" antes de salvar).
  (props.onCriar as (x: string) => void)(GRUPO.texto);
  t = await m.render();
  props = propsDaLista(t, m.Lista);
  assert.deepEqual([props.perguntasPublicadas, props.perguntasNoFormulario], [[], [GRUPO.texto]]);
  l = await m.renderLista(props);
  assert.match(texto(l), /Resposta em edição no formulário/);
  assert.doesNotMatch(texto(l), /Já tem resposta aprovada/);

  // 2) Escreve a resposta e salva: a tela recarrega a configuração da API e o selo vira "Já tem resposta aprovada".
  const resposta = elementos(t).find((e) => e.type === 'textarea' && String(e.props.id).startsWith('resposta-')) as Elemento;
  (resposta.props.onChange as (ev: unknown) => void)({ target: { value: 'Temos fraldário nos dois banheiros.' } });
  t = await m.render();
  await submeter(t);
  assert.deepEqual(m.salva().perguntas.map((p) => p.pergunta), [GRUPO.texto]);
  t = await m.render();
  props = propsDaLista(t, m.Lista);
  assert.deepEqual([props.perguntasPublicadas, props.perguntasNoFormulario], [[GRUPO.texto], [GRUPO.texto]]);
  l = await m.renderLista(props);
  assert.match(texto(l), /Já tem resposta aprovada/);

  // 3) Remove e salva: a configuração recarregada não tem a pergunta e o botão volta (sem remontar a tela).
  (achar(t, 'button', /Remover resposta/).props.onClick as () => void)();
  t = await m.render();
  props = propsDaLista(t, m.Lista);
  l = await m.renderLista(props);
  assert.ok(achar(l, 'button', /Criar resposta/), 'removida do formulário: botão antes de salvar');
  await submeter(t);
  assert.deepEqual(m.salva().perguntas, []);
  t = await m.render();
  props = propsDaLista(t, m.Lista);
  assert.deepEqual([props.perguntasPublicadas, props.perguntasNoFormulario], [[], []]);
  l = await m.renderLista(props);
  assert.ok(achar(l, 'button', /Criar resposta/));
  assert.doesNotMatch(texto(l), /Já tem resposta aprovada|Resposta em edição/);
  assert.equal(m.gets.filter((g) => g === '/api/admin/atendimento').length >= 3, true, 'recarregou depois de cada salvar');
});
