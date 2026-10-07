import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';
import * as acessoTela from '../../../lib/whatsapp/atendimento/acesso-tela.ts';
import * as identificacao from '../../../lib/whatsapp/atendimento/identificacao.ts';
import * as encerramento from '../../../lib/whatsapp/atendimento/encerramento.ts';
import * as prontas from '../../../lib/whatsapp/atendimento/prontas.ts';

// Tela real renderizada sem DOM; API simulada; nada é enviado de verdade. Rascunho por conversa, sugestão do Wall-e
// (editável, nunca enviada sozinha), resumo e a gaveta da biblioteca com PDF.
const agora = new Date().toISOString();
const conversa = (id: string, final: string, extra: object = {}) => ({ id, empresa_id: 'e', ambiente: 'staging', contato: `55619000${final}`, contato_final: final, estado: 'HUMANO', responsavel_id: 'u',
  responsavel_nome: 'Atendente', nao_contatar: false, versao: 2, ultima_entrada_em: agora, atualizada_em: agora, interesse: { data: null, convidados: null }, nome_perfil: null, cadastro: { situacao: 'SEM_CADASTRO' }, ...extra });
const RESUMO = { interesse: ['Preços', 'Datas'], data: '2026-11-14', horario: 'Noite (17h às 21h)', convidados: 80, pacote: 'Completa', unidade: null, tema: 'Frozen', enviados: [{ titulo: 'Tabela de preços', versao: 2 }], correcoes: 1,
  passagem: { motivo: 'NEGOCIACAO', motivoTexto: 'Negociação ou exceção comercial', motivosTexto: ['Negociação ou exceção comercial'], em: agora, coletado: {}, enviados: [], pendentes: ['quantos convidados'], ultimaMensagem: 'x' } };
const DADOS = {
  usuarioId: 'u', mensagens: [], configuracao: { ativo: true, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 }, wallE: { ativo: true } }, automacaoDisponivel: true, podeConfigurar: true,
  canal: { ambiente: 'staging', receptor: true, recepcao: true, envio: true }, ia: { ia: true, orcamento: true },
  conversas: [conversa('c1', '0101'), conversa('c2', '0202', { estado: 'AGUARDANDO_HUMANO', responsavel_id: null })], wallE: { disponivel: true, conversaId: 'c1', resumo: RESUMO },
};

function montar() {
  const corpos: Record<string, unknown>[] = [];
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return { ok: true, status: 200, json: async () => ({ ok: true, data: DADOS }) };
    const b = JSON.parse(init.body!); corpos.push(b);
    if (b.acao === 'sugerir') return { ok: true, status: 200, json: async () => ({ ok: true, data: { texto: 'Pelo modelo de contrato vigente (versão 4)…', materiais: [{ prontaId: 'p1', titulo: 'Tabela de preços', tipo: 'DOCUMENTO' }], motivos: ['Negociação ou exceção comercial'] } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  const Biblioteca = () => null;
  const h = carregarComponente('components/admin/atendimento/AtendimentoWhatsapp.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children },
    '@/lib/http/admin-fetch': { adminFetch },
    './atendimento.module.css': cssFalso,
    './MensagensProntas': { MensagensProntas: Biblioteca },
    '@/lib/whatsapp/atendimento/encerramento': encerramento,
    '@/lib/whatsapp/atendimento/identificacao': identificacao,
    '@/lib/whatsapp/atendimento/acesso-tela': acessoTela,
  });
  globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined } as never;
  globalThis.document = { hidden: false } as never;
  let arvore: unknown = h.render();
  const ciclo = async () => { h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render(); h.efeitos(); arvore = h.render(); };
  const re = async () => { await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render(); };
  const botao = (rotulo: RegExp) => elementos(arvore).find(e => e.type === 'button' && rotulo.test(texto(e)));
  const campo = () => elementos(arvore).find(e => e.type === 'textarea')!;
  const digitar = (valor: string) => (campo().props.onChange as (e: unknown) => void)({ target: { value: valor } });
  const props = () => elementos(arvore).find(e => e.type === Biblioteca)!.props as { onUsar: (t: string, c: string, m: unknown) => void; pedirPronta: { id: string; n: number } | null; conversaId: string };
  return { h, ciclo, re, botao, campo, digitar, props, corpos, arvore: () => arvore };
}

test('rascunho por conversa: texto e anexo ficam com o contato certo ao trocar e voltar; o envio leva só o da conversa aberta', async () => {
  const m = montar();
  await m.ciclo();
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  m.digitar('Olá, cliente A'); await m.re();
  m.props().onUsar('Legenda do PDF', 'c1', { tipo: 'DOCUMENTO', url: '/api/publico/x/tabela.pdf', prontaId: 'p1', versao: 2, titulo: 'Tabela', nome: 'tabela.pdf' }); await m.re();
  assert.match(texto(elementos(m.arvore()).find(e => e.props['aria-label'] === 'Anexo da resposta')), /PDF anexado: “Tabela”/);
  (m.botao(/0202/)!.props.onClick as () => void)(); await m.ciclo();
  assert.equal(m.campo().props.value, '', 'B começa sem o rascunho de A');
  assert.equal(elementos(m.arvore()).find(e => e.props['aria-label'] === 'Anexo da resposta'), undefined, 'o anexo de A não aparece em B');
  assert.ok(elementos(m.arvore()).some(e => e.type === 'button' && /0101/.test(texto(e)) && /rascunho/.test(texto(e))), 'o cartão de A indica rascunho guardado');
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  assert.equal(m.campo().props.value, 'Legenda do PDF', 'voltar a A devolve o rascunho');
  assert.ok(m.botao(/^Enviar PDF$/), 'o anexo de A continua com A');
  (elementos(m.arvore()).find(e => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await m.re(); await m.re();
  assert.deepEqual(m.corpos.at(-1), { acao: 'enviar', conversaId: 'c1', versao: 2, prontaMidiaId: 'p1', prontaVersao: 2, texto: 'Legenda do PDF' });
  await m.re();
  assert.equal(m.campo().props.value, '', 'depois do envio aceito o rascunho de A é limpo');
});

test('sugestão do Wall-e: só leitura; o atendente revisa no campo e envia com o próprio clique; material vira prévia da biblioteca', async () => {
  const m = montar();
  await m.ciclo();
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  const resumo = elementos(m.arvore()).find(e => e.props['aria-label'] === 'Resumo da conversa');
  // Resumo começa fechado fora da tela larga; abre pelo botão.
  if (!resumo) { (m.botao(/^Resumo$/)!.props.onClick as () => void)(); await m.re(); }
  const painel = elementos(m.arvore()).find(e => e.props['aria-label'] === 'Resumo da conversa')!;
  assert.match(texto(painel), /Interesse.*Preços, Datas/);
  assert.match(texto(painel), /14\/11\/2026/); assert.match(texto(painel), /Noite \(17h às 21h\)/); assert.match(texto(painel), /Completa/); assert.match(texto(painel), /Frozen/);
  assert.match(texto(painel), /Passado para a equipe: Negociação/); assert.match(texto(painel), /Falta saber: quantos convidados/);
  (m.botao(/^Sugerir resposta$/)!.props.onClick as () => void)(); await m.re(); await m.re();
  assert.deepEqual(m.corpos.at(-1), { acao: 'sugerir', conversaId: 'c1' });
  assert.match(texto(m.arvore()), /Pelo modelo de contrato vigente \(versão 4\)/);
  assert.match(texto(m.arvore()), /Atenção da equipe: Negociação/);
  assert.equal(m.corpos.filter(c => c.acao === 'enviar').length, 0, 'sugerir não envia');
  (m.botao(/^Preparar anexo$/)!.props.onClick as () => void)(); await m.re();
  assert.deepEqual(m.props().pedirPronta, { id: 'p1', n: 1 }, 'o material vai para a prévia da biblioteca (presa à versão)');
  (m.botao(/^Usar na resposta$/)!.props.onClick as () => void)(); await m.re(); await m.re();
  assert.equal(m.campo().props.value, 'Pelo modelo de contrato vigente (versão 4)…');
  assert.equal(m.corpos.filter(c => c.acao === 'enviar').length, 0, 'usar a sugestão não envia');
});

test('estados com nomes da equipe e filtro por situação; celular: voltar fecha a conversa e guarda o rascunho', async () => {
  const m = montar();
  await m.ciclo();
  const lista = () => elementos(m.arvore()).find(e => e.props['aria-label'] === 'Lista de conversas')!;
  assert.match(texto(lista()), /Com você/); assert.match(texto(lista()), /Aguardando equipe/);
  (m.botao(/^Aguardando equipe$/)!.props.onClick as () => void)(); await m.re();
  const cartoes = () => elementos(lista()).filter(e => e.type === 'button' && /\d{4}/.test(texto(e)));
  assert.deepEqual(cartoes().map(e => /0202/.test(texto(e))), [true], 'só a conversa aguardando a equipe');
  (m.botao(/^Todas$/)!.props.onClick as () => void)(); await m.re();
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  m.digitar('Rascunho guardado'); await m.re();
  (m.botao(/^Voltar às conversas$/)!.props.onClick as () => void)(); await m.re();
  assert.match(texto(m.arvore()), /Selecione uma conversa/, 'no celular a lista volta a ser a tela');
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  assert.equal(m.campo().props.value, 'Rascunho guardado');
});

test('biblioteca: gaveta lateral (diálogo), Esc fecha; "Anexar arquivo" mostra só anexos; PDF vai à resposta com o nome', async () => {
  globalThis.window = globalThis as never;
  const PDF = { id: '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a', titulo: 'Tabela de preços', categoria: 'Comercial', tipo: 'DOCUMENTO', texto: 'Tabela 2027', link: null, midia_url: null, atalho: null, versao: 2, atualizada_em: '' };
  const TXT = { id: '2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e2e', titulo: 'Como chegar', categoria: 'Informações', tipo: 'TEXTO', texto: 'Rua das Festas, 100.', link: null, atalho: null, versao: 0, atualizada_em: '' };
  const pendentes: ((d: unknown) => void)[] = [];
  const responder = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => !init?.method ? responder({ prontas: [PDF, TXT], favoritas: [], podeGerenciar: false, recursos074: true, recursos075: true })
    : new Promise(res => pendentes.push(d => res(responder(d))));
  const h = carregarComponente('components/admin/atendimento/MensagensProntas.tsx', { '@/lib/http/admin-fetch': { adminFetch }, '@/lib/whatsapp/atendimento/prontas': prontas, './atendimento.module.css': cssFalso });
  const usados: unknown[] = [];
  const props = { conversaId: 'c1', podeUsar: true, motivoBloqueio: '', textoAtual: '', onUsar: (t: string, c: string, m: unknown) => usados.push({ t, c, m }) };
  const render = async () => { let t = h.render('MensagensProntas', props); h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); t = h.render('MensagensProntas', props); return t; };
  let t = await render();
  await (achar(t, 'button', 'Anexar arquivo').props.onClick as () => Promise<void>)(); t = await render();
  const gaveta = elementos(t).find(e => e.type === 'section' && e.props.role === 'dialog')!;
  assert.ok(gaveta, 'a biblioteca abre como gaveta (diálogo), fora do campo de resposta');
  const itens = elementos(gaveta).filter(e => e.type === 'button' && /Comercial|Informações/.test(texto(e))).map(texto);
  assert.deepEqual(itens, ['Tabela de preçosComercial · PDF'], '"Anexar arquivo" mostra só foto, vídeo e PDF');
  (achar(t, 'button', /Tabela de preçosComercial/).props.onClick as () => void)(); await tique();
  pendentes[0]({ titulo: PDF.titulo, texto: PDF.texto, linkIndividual: null, aviso: null, midia: { tipo: 'DOCUMENTO', url: '/api/publico/atendimento/arquivos/x/y/tabela.pdf', prontaId: PDF.id, versao: 2, nome: 'tabela.pdf' } });
  await tique(); await tique(); t = await render();
  assert.match(texto(t), /PDF desta mensagem pronta \(tabela\.pdf\)/);
  (achar(t, 'button', 'Anexar à resposta').props.onClick as () => void)(); t = await render();
  assert.deepEqual(usados, [{ t: 'Tabela 2027', c: 'c1', m: { tipo: 'DOCUMENTO', url: '/api/publico/atendimento/arquivos/x/y/tabela.pdf', prontaId: PDF.id, versao: 2, nome: 'tabela.pdf', titulo: PDF.titulo } }]);
  assert.equal(elementos(t).find(e => e.props.role === 'dialog'), undefined, 'usar fecha a gaveta');
  assert.match(texto(elementos(t).find(e => e.props.role === 'status')), /^PDF anexado à resposta/);
  // Esc fecha a gaveta.
  await (achar(t, 'button', 'Mensagens prontas').props.onClick as () => Promise<void>)(); t = await render();
  (elementos(t).find(e => e.props.role === 'dialog')!.props.onKeyDown as (e: unknown) => void)({ key: 'Escape', stopPropagation() {} }); t = await render();
  assert.equal(elementos(t).find(e => e.props.role === 'dialog'), undefined);
});
