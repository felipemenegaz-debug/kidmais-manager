import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, talvez, texto, tique } from '../teste-componente.ts';
import * as prontas from '../../../lib/whatsapp/atendimento/prontas.ts';

// Componente real renderizado sem DOM; a API é simulada e os retornos são liberados na ordem que o teste escolhe.
const A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const IND = { id: '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d', titulo: 'Contrato para assinatura', categoria: 'Comercial', tipo: 'LINK_FECHAMENTO_INDIVIDUAL', texto: 'Seu contrato:', link: null, atalho: 'DISPONIBILIDADE_FECHAMENTO', versao: 0, atualizada_em: '' };
const TXT = { id: '2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e2e', titulo: 'Como chegar', categoria: 'Informações', tipo: 'TEXTO', texto: 'Rua das Festas, 100.', link: null, atalho: null, versao: 0, atualizada_em: '' };
const LINK_A = 'https://admin.kidmais.com.br/contrato/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function montar(opcoes: { prontas?: unknown[]; recursos074?: boolean } = {}) {
  const pendentes: { conversaId: string; id: string; liberar: (d: unknown) => void }[] = [];
  const responder = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return responder({ prontas: opcoes.prontas ?? [IND, TXT], favoritas: [], podeGerenciar: false, recursos074: opcoes.recursos074 ?? false });
    const b = JSON.parse(init.body!);
    if (b.acao !== 'rascunho') return responder(null);
    return new Promise(res => pendentes.push({ conversaId: b.conversaId, id: b.id, liberar: d => res(responder(d)) }));
  };
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', {
    '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso,
  });
  const usados: { texto: string; conversaId: string }[] = [], midias: unknown[] = [];
  const props = (conversaId: string) => ({ conversaId, podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: (texto: string, origem: string, midia: unknown) => { usados.push({ texto, conversaId: origem }); midias.push(midia); } });
  let arvore: unknown;
  const render = async (conversaId: string) => { arvore = h.render('MensagensProntas', props(conversaId)); h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render('MensagensProntas', props(conversaId)); return arvore; };
  return { h, pendentes, usados, midias, render, props, arvore: () => arvore };
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
  await clicar(achar(t, 'button', /Como chegar/));
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
  await clicar(achar(t, 'button', /Como chegar/));
  m.pendentes[1].liberar({ titulo: TXT.titulo, texto: TXT.texto, linkIndividual: null, aviso: null });
  await tique(); await tique();
  m.pendentes[0].liberar({ titulo: IND.titulo, texto: `Seu contrato:\n\n${LINK_A}`, linkIndividual: 'PREENCHIDO', aviso: null });
  await tique(); await tique();
  t = await m.render(A);
  assert.equal(previa(t)!.props.value, TXT.texto, 'vale o último pedido; o retorno atrasado do anterior não sobrescreve');
});

// 074: foto/vídeo. A prévia mostra o tipo e um link para conferir (nova aba, sem referrer); só a legenda é editável;
// "Anexar à resposta" entrega texto + mídia (id da pronta) para a conversa de origem. Nada é enviado aqui.
const FOTO = { id: '3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f', titulo: 'Salgados da casa', categoria: 'Cardápio', tipo: 'IMAGEM', texto: 'Nossos salgados.', link: null, midia_url: 'https://cdn.exemplo.test/salgados.jpg', atalho: 'SALGADOS', versao: 3, atualizada_em: '' };
test('074: prévia de foto com legenda editável e link de conferência; anexar entrega a mídia só para a conversa de origem', async () => {
  globalThis.window = globalThis as never;
  const m = montar({ prontas: [FOTO, TXT], recursos074: true });
  let t = await m.render(A);
  await clicar(achar(t, 'button', 'Mensagens prontas'));
  t = await m.render(A);
  await clicar(achar(t, 'button', 'Salgados'));                               // atalho novo, com a foto cadastrada
  assert.equal(m.pendentes.at(-1)!.id, FOTO.id);
  m.pendentes.at(-1)!.liberar({ titulo: FOTO.titulo, texto: FOTO.texto, linkIndividual: null, aviso: null, midia: { tipo: 'IMAGEM', url: FOTO.midia_url, prontaId: FOTO.id, versao: 3 } });
  await tique(); await tique();
  t = await m.render(A);
  const link = elementos(t).find(e => e.type === 'a' && e.props.href === FOTO.midia_url)!;
  assert.equal(link.props.target, '_blank'); assert.equal(link.props.rel, 'noopener noreferrer');
  assert.ok(!elementos(t).some(e => e.type === 'img'), 'a foto não é carregada automaticamente na tela');
  assert.equal(previa(t)!.props.maxLength, 1024);
  assert.ok(elementos(t).some(e => e.type === 'label' && /Legenda de “Salgados da casa”/.test(texto(e))));
  await clicar(elementos(t).find(e => e.type === 'button' && texto(e) === 'Anexar à resposta')!);
  assert.deepEqual(m.usados, [{ texto: FOTO.texto, conversaId: A }]);
  assert.deepEqual(m.midias, [{ tipo: 'IMAGEM', url: FOTO.midia_url, prontaId: FOTO.id, versao: 3, titulo: FOTO.titulo }], 'a versão vista na prévia vai com o anexo');
  // Aviso "anexada" vale só no ciclo da resposta em que foi dado: a tela muda o ciclo no envio aceito (ou anexo removido/recusado).
  const aviso = (arvore: unknown) => elementos(arvore).find(e => e.type === 'p' && e.props.role === 'status' && /anexada à resposta/.test(texto(e)));
  t = m.h.render('MensagensProntas', { ...m.props(A), cicloResposta: 0 });
  assert.match(texto(aviso(t)!), /^Foto anexada à resposta, com a legenda no campo/);
  t = m.h.render('MensagensProntas', { ...m.props(A), cicloResposta: 1 });
  assert.equal(aviso(t), undefined, 'depois do envio aceito o aviso some');
});
test('074: atalhos sem mensagem num aviso por motivo (fora da linha de botões), ligado a cada botão desabilitado', async () => {
  globalThis.window = globalThis as never;
  const casos = [
    [false, { 'Ainda sem mensagem cadastrada: Tabela de preços.': ['Tabela de preços'], 'Indisponíveis neste ambiente: Salgados, Bolos, Endereço, Localização.': ['Salgados', 'Bolos', 'Endereço', 'Localização'] }],
    [true, { 'Ainda sem mensagem cadastrada: Tabela de preços, Salgados, Bolos, Endereço, Localização.': ['Tabela de preços', 'Salgados', 'Bolos', 'Endereço', 'Localização'] }],
  ] as const;
  for (const [recursos074, avisos] of casos) {
    const m = montar({ recursos074 });                                         // IND ocupa "Disponibilidade / fechamento"
    let t = await m.render(A);
    await clicar(achar(t, 'button', 'Mensagens prontas'));
    t = await m.render(A);
    const grupo = elementos(t).find(e => e.props['aria-label'] === 'Atalhos')!;
    assert.ok(!elementos(grupo).some(e => e.type === 'span' || e.type === 'p'), 'nenhum aviso entre os botões');
    assert.equal(achar(t, 'button', 'Disponibilidade / fechamento').props.disabled, false);
    const paragrafos = elementos(t).filter(e => e.type === 'p' && /^(Ainda sem mensagem|Indisponíve)/.test(texto(e)));
    assert.deepEqual(paragrafos.map(texto), Object.keys(avisos), `074=${recursos074}`);
    for (const p of paragrafos) for (const nome of avisos[texto(p) as keyof typeof avisos] as readonly string[]) {
      const b = achar(t, 'button', nome);
      assert.equal(b.props.disabled, true, nome);
      assert.equal(b.props['aria-describedby'], p.props.id, `${nome} descrito pelo aviso do seu motivo`);
    }
  }
});
