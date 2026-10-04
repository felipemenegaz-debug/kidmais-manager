import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';
import * as prontas from '../../../lib/whatsapp/atendimento/prontas.ts';

// Foco na biblioteca de mensagens prontas (validação no navegador de 04/10/2026: o foco caía no topo da página ao
// preparar, abrir o cadastro, salvar e arquivar; o Tab seguinte pulava o formulário). Componente real, sem DOM:
// cada elemento com `ref` recebe um nó falso que registra quem recebeu o foco.
const A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const IND = { id: '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d', titulo: 'Contrato para assinatura', categoria: 'Comercial', tipo: 'LINK_FECHAMENTO_INDIVIDUAL', texto: 'Seu contrato:', link: null, atalho: 'DISPONIBILIDADE_FECHAMENTO', versao: 0, atualizada_em: '' };
const TXT = { id: '2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e2e', titulo: 'Endereço', categoria: 'Informações', tipo: 'TEXTO', texto: 'Rua das Festas, 100.', link: null, atalho: null, versao: 0, atualizada_em: '' };

/** Liga os refs da árvore a nós falsos; `focos` recebe o nome do nó a cada focus(). */
function ligarRefs(arvore: unknown, focos: string[]) {
  for (const e of elementos(arvore) as Elemento[]) {
    const ref = e.props.ref as ((n: unknown) => void) | { current: unknown } | undefined;
    if (!ref) continue;
    const nome = `${String(e.type)}:${String(e.props['aria-label'] ?? (texto(e) || e.props.id || ''))}`;
    const no = { focus: () => focos.push(nome) };
    if (typeof ref === 'function') ref(no); else ref.current = no;
  }
}
const responder = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });

function montarBiblioteca() {
  const pendentes: { conversaId: string; liberar: (d: unknown) => void }[] = [];
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return responder({ prontas: [IND, TXT], favoritas: [], podeGerenciar: false });
    const b = JSON.parse(init.body!);
    return new Promise(res => pendentes.push({ conversaId: b.conversaId, liberar: d => res(responder(d)) }));
  };
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso,
  });
  const focos: string[] = [];
  const props = (conversaId: string) => ({ conversaId, podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: () => {} });
  // Render "como o React": monta, liga os refs (commit) e roda os efeitos.
  const render = async (conversaId: string) => {
    let t = h.render('MensagensProntas', props(conversaId)); ligarRefs(t, focos); h.efeitos();
    await new Promise(r => setTimeout(r, 5)); await tique();
    t = h.render('MensagensProntas', props(conversaId)); ligarRefs(t, focos); h.efeitos();
    return t;
  };
  return { h, pendentes, focos, render };
}
const clicar = async (e: Elemento) => { (e.props.onClick as () => unknown)(); await tique(); };

test('preparar prévia: botão não é desabilitado durante o pedido e a prévia recebe o foco ao chegar', async () => {
  globalThis.window = globalThis as never;
  const m = montarBiblioteca();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', /Endereço/));
  t = await m.render(A);
  const item = achar(t, 'button', /Endereço/);
  assert.notEqual(item.props.disabled, true, 'disabled jogaria o foco para o topo da página');
  assert.equal(item.props['aria-disabled'], true, 'ocupado é anunciado sem tirar o foco');
  assert.equal(achar(t, 'button', 'Disponibilidade / fechamento').props.disabled, false);
  m.focos.length = 0;
  m.pendentes[0].liberar({ titulo: TXT.titulo, texto: TXT.texto, linkIndividual: null, aviso: null });
  await tique(); await tique();
  t = await m.render(A);
  const campo = elementos(t).find(e => e.type === 'textarea')!;
  assert.deepEqual(m.focos, [`textarea:${String(campo.props.id)}`], 'foco na edição da prévia, uma única vez');
  // Editar a prévia (novo objeto de rascunho) não rouba o foco de novo.
  (campo.props.onChange as (e: unknown) => void)({ target: { value: 'Rua das Festas, 100. Até lá!' } });
  await m.render(A);
  assert.equal(m.focos.length, 1);
});

test('retorno atrasado de outra conversa não move o foco', async () => {
  globalThis.window = globalThis as never;
  const m = montarBiblioteca();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', 'Disponibilidade / fechamento'));
  await m.render(B);
  m.focos.length = 0;
  m.pendentes[0].liberar({ titulo: IND.titulo, texto: 'Seu contrato:', linkIndividual: 'NAO_PREENCHIDO', aviso: 'x' });
  await tique(); await tique();
  await m.render(B); await m.render(B);
  assert.deepEqual(m.focos, [], 'nenhum foco roubado em B');
});

test('descartar prévia devolve o foco ao item que a originou', async () => {
  globalThis.window = globalThis as never;
  const m = montarBiblioteca();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', /Endereço/));
  m.pendentes[0].liberar({ titulo: TXT.titulo, texto: TXT.texto, linkIndividual: null, aviso: null });
  await tique(); await tique();
  t = await m.render(A);
  m.focos.length = 0;
  await clicar(achar(t, 'button', 'Descartar prévia'));
  assert.equal(m.focos.length, 1);
  assert.match(m.focos[0], /^button:EndereçoInformações · Texto$/, 'foco no item "Endereço"');
  t = await m.render(A);
  assert.equal(elementos(t).find(e => e.type === 'textarea'), undefined);
});

function montarCadastro() {
  const lista = [IND, TXT].map(p => ({ ...p }));
  const chamadas: string[] = [];
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return responder({ prontas: lista.filter(p => !('arquivada' in p)), favoritas: [], podeGerenciar: true });
    const b = JSON.parse(init.body!); chamadas.push(b.acao);
    if (b.acao === 'arquivar') Object.assign(lista.find(p => p.id === b.id)!, { arquivada: true });
    return responder(null);
  };
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso,
  });
  const focos: string[] = [];
  const render = async () => {
    let t = h.render('GerenciarMensagensProntas'); ligarRefs(t, focos); h.efeitos();
    await new Promise(r => setTimeout(r, 5)); await tique();
    t = h.render('GerenciarMensagensProntas'); ligarRefs(t, focos); h.efeitos();
    return t;
  };
  return { h, focos, chamadas, render };
}
const titulo = (focos: string[]) => focos.at(-1) === 'input:';

test('cadastro: Nova → Título; Cancelar → Nova; Editar → Título; Salvar → Editar do item; Remover → Nova', async () => {
  globalThis.window = globalThis as never;
  (globalThis as { confirm?: () => boolean }).confirm = () => true;
  const m = montarCadastro();
  let t = await m.render();
  (achar(t, 'details').props.onToggle as (e: unknown) => void)({ target: { open: true } });
  t = await m.render();

  await clicar(achar(t, 'button', 'Nova mensagem pronta'));
  t = await m.render();
  assert.ok(titulo(m.focos), `abrir o cadastro foca o Título (foco: ${m.focos.at(-1)})`);

  await clicar(achar(t, 'button', 'Cancelar'));
  t = await m.render();
  assert.equal(m.focos.at(-1), 'button:Nova mensagem pronta', 'cancelar volta a "Nova mensagem pronta"');

  await clicar(achar(t, 'button', /^Editar Endereço$/));
  t = await m.render();
  assert.ok(titulo(m.focos), 'abrir a edição foca o Título');

  (achar(t, 'form').props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  await tique(); await tique(); await new Promise(r => setTimeout(r, 5));
  t = await m.render();
  assert.equal(m.focos.at(-1), 'button:Editar Endereço', 'salvar volta ao "Editar" do item salvo');
  assert.ok(elementos(t).some(e => e.props.role === 'status' && texto(e) === 'Mensagem pronta salva.'));

  await clicar(achar(t, 'button', /^Remover Endereço$/));
  await tique(); await new Promise(r => setTimeout(r, 5));
  t = await m.render();
  assert.equal(m.focos.at(-1), 'button:Nova mensagem pronta', 'arquivar volta a "Nova mensagem pronta"');
  assert.ok(!elementos(t).some(e => /Editar Endereço/.test(texto(e))), 'o item arquivado saiu da lista');
  assert.deepEqual(m.chamadas, ['salvar', 'arquivar']);
});

test('salvar não desabilita o botão em foco durante o pedido', () => {
  const fonte = readFileSync('components/admin/atendimento/MensagensProntas.tsx', 'utf8');
  assert.match(fonte, /type="submit" className=\{styles\.primario\} aria-disabled=\{ocupado \|\| undefined\}/);
  assert.doesNotMatch(fonte, /disabled=\{ocupado\}/, 'nenhum botão da biblioteca usa disabled durante pedido');
});

test('celular: título e alvos de foco param abaixo do menu fixo do admin', () => {
  const shell = readFileSync('components/admin/shell.module.css', 'utf8');
  const menu = shell.match(/@media\(max-width:(\d+)px\)[\s\S]*?\.menu \{[^}]*top:(\d+)px;[^}]*height:(\d+)px/);
  assert.ok(menu, 'regra do menu fixo encontrada');
  const [, largura, topo, altura] = menu!.map(Number);
  const css = readFileSync('components/admin/atendimento/atendimento.module.css', 'utf8');
  const regra = css.match(/@media\(max-width:(\d+)px\)\{([^{}]*h2:focus[^{}]*)\{scroll-margin-top:(\d+)px\}\}/);
  assert.ok(regra, 'regra de scroll-margin do atendimento encontrada');
  assert.ok(Number(regra![1]) >= largura, 'vale em toda a faixa em que o menu é fixo');
  assert.ok(Number(regra![3]) >= topo + altura + 8, `margem ${regra![3]}px cobre o menu (${topo}+${altura}px) com folga`);
  for (const alvo of ['.pagina h2', '.pagina h2:focus', 'input', 'textarea', 'button', 'summary']) assert.ok(regra![2].includes(alvo), `inclui ${alvo}`);
});
