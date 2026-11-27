import assert from 'node:assert/strict';
import test from 'node:test';
import * as acessoTela from '../../../lib/whatsapp/atendimento/acesso-tela.ts';
import * as core from '../../../lib/whatsapp/atendimento/core.ts';
import * as horario from '../../../lib/whatsapp/atendimento/horario.ts';
import * as semFonteTexto from '../../../lib/whatsapp/atendimento/sem-fonte-texto.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

// Fatia 7 (desenho novo, Astra r2/r3 P3): pela tela, SEM remontar: o botão "Criar resposta" da lista abre uma pergunta
// VAZIA (o texto do cliente nunca é copiado), a pessoa escreve pergunta e resposta, salva ("Já tem resposta aprovada")
// e o botão volta depois de remover e salvar. Tela renderizada sem DOM, com a API simulada (o servidor guarda o que o POST mandou).
const GRUPO = { id: 'g1', texto: 'Tem fraldário?', ocorrencias: 2, ultimaEm: '2027-01-19T10:00:00.000Z', jaPublicada: false, precisaRevisar: false };

function montar(perguntasIniciais: { id: string; pergunta: string; resposta: string }[] = []) {
  let salva: { perguntas: { id: string; pergunta: string; resposta: string }[] } & Record<string, unknown> = { ativo: false, nome: 'Empresa sintética', perguntas: perguntasIniciais, limites: { respostasPor24h: 20 }, wallE: { ativo: false } };
  const gets: string[] = [];
  const adminFetch = async (url: string, init?: { method?: string; body?: unknown }) => {
    // O servidor guarda o que o schema devolve (pergunta e resposta sem os espaços das pontas).
    if (init?.method === 'POST') salva = core.configuracaoSchema.parse(JSON.parse(String(init.body)).configuracao) as typeof salva;
    else gets.push(url);
    const data = url.endsWith('/sem-fonte')
      ? { disponivel: true, dias: 30, grupos: [GRUPO], omitidasSensiveis: 0, limite: 30, publicadas: salva.perguntas.length }
      : { configuracao: salva, automacaoDisponivel: true, podeConfigurar: true, wallE: { disponivel: true } };
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  function Lista(props: Record<string, unknown>) { return props; }
  const deps = { '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/core': core, '@/lib/whatsapp/atendimento/sem-fonte-texto': semFonteTexto, './atendimento.module.css': cssFalso };
  const tela = carregarComponente('components/admin/atendimento/ConfiguracaoAtendimento.tsx', {
    ...deps, 'next/link': { default: (p: { children?: unknown }) => p.children }, './PerguntasSemFonte': { default: Lista }, './TestarWallE': { default: () => null },
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

const inputsPergunta = (t: unknown) => elementos(t).filter((e) => e.type === 'input' && String(e.props.id ?? '').startsWith('pergunta-')) as Elemento[];
const digitar = (el: Elemento, valor: string) => (el.props.onChange as (ev: unknown) => void)({ target: { value: valor } });

test('sem fonte na tela: botão da lista abre pergunta vazia, a pessoa escreve, salva e o botão volta depois de remover', async () => {
  const m = montar();
  let t = await m.render();
  let props = propsDaLista(t, m.Lista);
  let l = await m.renderLista(props);
  // A nota não promete texto sem dado pessoal (Astra r4, P3).
  assert.match(texto(l), /ainda podem conter dados pessoais/);
  assert.doesNotMatch(texto(l), /sem os dados pessoais/);

  // 1) Clique no botão "Criar resposta" da lista renderizada: pergunta VAZIA no formulário, ligada ao grupo → rascunho.
  (achar(l, 'button', /Criar resposta/).props.onClick as () => void)();
  t = await m.render();
  const [campo] = inputsPergunta(t);
  assert.ok(campo, 'o formulário ganhou uma pergunta');
  assert.equal(campo.props.value, '', 'o texto do cliente não é copiado para o formulário');
  props = propsDaLista(t, m.Lista);
  assert.deepEqual(Object.values(props.vinculos as Record<string, string>), [GRUPO.id]);
  l = await m.renderLista(props);
  assert.match(texto(l), /Resposta em edição no formulário/);
  assert.doesNotMatch(texto(l), /Já tem resposta aprovada/);

  // 2) A pessoa escreve a pergunta (com as palavras dela) e a resposta; salva: a configuração é recarregada da API.
  // Com espaço no fim (Astra r4, P3): o servidor tira, o formulário mantém, o selo compara como o servidor.
  digitar(campo, 'O salão tem trocador para bebê? ');
  t = await m.render();
  const resposta = elementos(t).find((e) => e.type === 'textarea' && String(e.props.id).startsWith('resposta-')) as Elemento;
  digitar(resposta, 'Temos fraldário nos dois banheiros.');
  t = await m.render();
  await submeter(t);
  assert.deepEqual(m.salva().perguntas.map((p) => p.pergunta), ['O salão tem trocador para bebê?']);
  t = await m.render();
  props = propsDaLista(t, m.Lista);
  l = await m.renderLista(props);
  assert.match(texto(l), /Já tem resposta aprovada/);

  // 3) Remove e salva: a configuração recarregada não tem a pergunta e o botão volta (sem remontar a tela).
  (achar(t, 'button', /Remover resposta/).props.onClick as () => void)();
  t = await m.render();
  l = await m.renderLista(propsDaLista(t, m.Lista));
  assert.ok(achar(l, 'button', /Criar resposta/), 'removida do formulário: botão antes de salvar');
  await submeter(t);
  assert.deepEqual(m.salva().perguntas, []);
  t = await m.render();
  l = await m.renderLista(propsDaLista(t, m.Lista));
  assert.ok(achar(l, 'button', /Criar resposta/));
  assert.doesNotMatch(texto(l), /Já tem resposta aprovada|Resposta em edição/);
  assert.equal(m.gets.filter((g) => g === '/api/admin/atendimento').length >= 3, true, 'recarregou depois de cada salvar');
});

test('sem fonte na tela: pergunta antiga salva com dado pessoal não é marcada (o servidor aceita igual); nova ou alterada é (Astra r3, P3)', async () => {
  const antiga = { id: 'faq_antiga', pergunta: 'Tem wi-fi? me liga 11987654321', resposta: 'Sim.' };
  const m = montar([antiga]);
  let t = await m.render();
  let [campo] = inputsPergunta(t);
  assert.equal(campo.props['aria-invalid'], undefined, 'mesmo id e mesmo texto da configuração salva');
  digitar(campo, ` ${antiga.pergunta} `);
  t = await m.render();
  [campo] = inputsPergunta(t);
  assert.equal(campo.props['aria-invalid'], undefined, 'só espaço nas pontas: o servidor aceita igual (Astra r4, P3)');
  digitar(campo, 'Tem wi-fi? me liga 11987654322');
  t = await m.render();
  [campo] = inputsPergunta(t);
  assert.equal(campo.props['aria-invalid'], true, 'alterada: a tela aponta como o servidor');
});
