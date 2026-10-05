import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, talvez, texto, tique } from '../teste-componente.ts';
import * as prontas from '../../../lib/whatsapp/atendimento/prontas.ts';

// Componente real renderizado sem DOM; a API é simulada e os retornos são liberados na ordem que o teste escolhe.
const A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const IND = { id: '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d', titulo: 'Contrato para assinatura', categoria: 'Comercial', tipo: 'LINK_FECHAMENTO_INDIVIDUAL', texto: 'Seu contrato:', link: null, atalho: 'DISPONIBILIDADE_FECHAMENTO', versao: 0, atualizada_em: '' };
const TXT = { id: '2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e2e', titulo: 'Endereço', categoria: 'Informações', tipo: 'TEXTO', texto: 'Rua das Festas, 100.', link: null, atalho: null, versao: 0, atualizada_em: '' };
const LINK_A = 'https://admin.kidmais.com.br/contrato/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function montar() {
  const pendentes: { conversaId: string; id: string; liberar: (d: unknown) => void }[] = [];
  const responder = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return responder({ prontas: [IND, TXT], favoritas: [], podeGerenciar: false });
    const b = JSON.parse(init.body!);
    if (b.acao !== 'rascunho') return responder(null);
    return new Promise(res => pendentes.push({ conversaId: b.conversaId, id: b.id, liberar: d => res(responder(d)) }));
  };
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso,
  });
  const usados: { texto: string; conversaId: string }[] = [];
  const props = (conversaId: string) => ({ conversaId, podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: (texto: string, origem: string) => usados.push({ texto, conversaId: origem }) });
  let arvore: unknown;
  const render = async (conversaId: string) => { arvore = h.render('MensagensProntas', props(conversaId)); h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render('MensagensProntas', props(conversaId)); return arvore; };
  return { h, pendentes, usados, render, arvore: () => arvore };
}
const previa = (arvore: unknown) => elementos(arvore).find(e => e.type === 'textarea');
const colocar = (arvore: unknown) => elementos(arvore).find(e => e.type === 'button' && /Colocar na resposta|Substituir a resposta/.test(texto(e)));
const clicar = async (e: { props: Record<string, unknown> }) => { (e.props.onClick as () => unknown)(); await tique(); };

test('A → B com retorno ATRASADO de A (link individual): a prévia de A não aparece em B nem vai para a resposta', async () => {
  globalThis.window = globalThis as never;
  const m = montar();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', 'Disponibilidade / fechamento'));       // pede a prévia de A (fica pendente)
  assert.equal(m.pendentes.length, 1); assert.equal(m.pendentes[0].conversaId, A);
  t = await m.render(B);                                                     // troca para B antes do retorno
  m.pendentes[0].liberar({ titulo: IND.titulo, texto: `Seu contrato:\n\n${LINK_A}`, linkIndividual: 'PREENCHIDO', aviso: null });
  await tique(); await tique();
  t = await m.render(B);
  assert.equal(previa(t), undefined, 'retorno atrasado de A descartado: nenhuma prévia em B');
  assert.equal(colocar(t), undefined);
  assert.ok(!JSON.stringify(elementos(t).map(texto)).includes(LINK_A), 'o link individual de A não aparece em B');
  assert.deepEqual(m.usados, []);
  // B segue funcionando: a prévia dele aparece e vai para a resposta com a origem B.
  await clicar(achar(t, 'button', /Endereço/));
  assert.equal(m.pendentes.at(-1)!.conversaId, B);
  m.pendentes.at(-1)!.liberar({ titulo: TXT.titulo, texto: TXT.texto, linkIndividual: null, aviso: null });
  await tique(); await tique();
  t = await m.render(B);
  assert.equal(previa(t)!.props.value, TXT.texto);
  await clicar(colocar(t)!);
  assert.deepEqual(m.usados, [{ texto: TXT.texto, conversaId: B }]);
});

test('prévia de A já exibida some ao trocar para B (antes mesmo do efeito) e não pode ser colocada em B', async () => {
  globalThis.window = globalThis as never;
  const m = montar();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', 'Disponibilidade / fechamento'));
  m.pendentes[0].liberar({ titulo: IND.titulo, texto: `Seu contrato:\n\n${LINK_A}`, linkIndividual: 'PREENCHIDO', aviso: null });
  await tique(); await tique();
  t = await m.render(A);
  assert.match(String(previa(t)!.props.value), /contrato\/aaaa/, 'em A a prévia com o link de A aparece');
  const colocarDeA = colocar(t)!;
  // Render de B sem rodar efeitos: o filtro por conversa já esconde a prévia de A.
  t = m.h.render('MensagensProntas', { conversaId: B, podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: () => assert.fail('não pode usar') });
  assert.equal(previa(t), undefined);
  m.h.efeitos(); await new Promise(r => setTimeout(r, 5));
  // O clique de um botão antigo de A, já em B, também não coloca nada (vínculo conferido no clique).
  await clicar(colocarDeA);
  assert.deepEqual(m.usados, []);
  assert.equal(talvez(m.h.render('MensagensProntas', { conversaId: B, podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: () => {} }), 'p', 'Rascunho colocado no campo de resposta. Revise e envie quando quiser.'), undefined);
});

test('pedido anterior na MESMA conversa também é descartado quando outro foi pedido depois', async () => {
  globalThis.window = globalThis as never;
  const m = montar();
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', 'Disponibilidade / fechamento'));
  // Conversa trocada e trocada de volta: o pedido antigo de A continua inválido (outro "ciclo" da conversa).
  await m.render(B); t = await m.render(A);
  await clicar(achar(t, 'button', /Endereço/));
  m.pendentes[1].liberar({ titulo: TXT.titulo, texto: TXT.texto, linkIndividual: null, aviso: null });
  await tique(); await tique();
  m.pendentes[0].liberar({ titulo: IND.titulo, texto: `Seu contrato:\n\n${LINK_A}`, linkIndividual: 'PREENCHIDO', aviso: null });
  await tique(); await tique();
  t = await m.render(A);
  assert.equal(previa(t)!.props.value, TXT.texto, 'vale o último pedido; o retorno atrasado do anterior não sobrescreve');
});
