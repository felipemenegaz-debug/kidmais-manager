import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as prontas from './prontas.ts';
import * as prontasLink from './prontas-link.ts';
import * as caminhoCardapio from '../../comercial/caminho-cardapio.ts';
import * as cardapioPublico from '../../comercial/cardapio-publico.ts';
import * as nomePublico from '../../perfil/nome-publico.ts';
import * as arquivos from './arquivos.ts';
import * as crypto from 'node:crypto';
import type { Pronta } from './prontas.ts';

// Banco simulado: nenhum PostgreSQL real é acessado.
const CONTRATO = '2b6f0f9e-6c1d-4a8e-9a55-3f0a5b1c2d3e';
const PRONTA = '7f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f601';
const CONVERSA = '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const linha = (x: Partial<Pronta> = {}): Pronta => ({ id: PRONTA, titulo: 'Fechamento', categoria: 'Comercial', tipo: 'TEXTO', texto: 'Olá!', link: null, midia_url: null, atalho: null, versao: 2, atualizada_em: '', ...x });
// midia: a 081 está aplicada (colunas de mídia presentes). Padrão: ausente, o comportamento da 080.
type Op = { recusa?: string; papel?: string; pronta?: Pronta | null; conversa?: { contato: string } | null; erro?: { code: string; constraint?: string }; atualizadas?: number; clientes?: { id: string; empresaId: string | null }[]; contratacoes?: { contratoId: string | null; acessoPublico: string | null }[]; origem?: string; midia?: boolean; r082?: boolean; semEscrita?: boolean };
function carregar(op: Op & { empresaPublica?: string | null; estrutura078?: boolean; categorias?: string[]; falhaOpcional?: boolean; nomePublico?: string } = {}) {
  const comandos: { sql: string; args: unknown[] }[] = [];
  const chamadas: string[] = [];
  const query = async (sql: string, args: unknown[] = []) => {
    comandos.push({ sql, args });
    if (op.erro) throw Object.assign(new Error('pg'), op.erro);
    if (sql.includes('FROM whatsapp_atendimento_conversas')) return { rows: op.conversa === null ? [] : [op.conversa ?? { contato: '5561999998888', codigo: 'buffet-a' }] };
    if (sql.includes("FROM public.empresas WHERE codigo = $1 AND status = 'ATIVA'")) return { rows: op.empresaPublica === null ? [] : [{ id: op.empresaPublica ?? 'e1' }] };
    if (sql.startsWith('SELECT to_char(clock_timestamp')) return { rows: [{ agora: '2026-11-19T20:00:00Z' }] };
    if (sql.includes("table_name = 'buffet_categorias'")) return { rows: [{ ok: op.estrutura078 !== false }] };
    if (sql.includes("AS empresas, to_regclass(")) return { rows: [{ empresas: null, concessoes: null }] };
    if (sql.startsWith('SELECT nome FROM public.empresas')) return { rows: [{ nome: op.nomePublico ?? 'Buffet A' }] };
    if (sql.includes('FROM pacotes p')) {
      if (op.falhaOpcional) throw new Error('falha de leitura simulada');
      assert.deepEqual(args, ['e1']);
      return { rows: (op.categorias ?? ['SALGADOS', 'MASSA_BOLO', 'RECHEIO_BOLO']).map(codigo => ({ codigo, nome: codigo, item: 'Sabor' })) };
    }
    if (sql.startsWith('SELECT p.id,p.titulo')) return { rows: op.pronta === null ? [] : [op.pronta ?? linha()] };
    if (sql.includes('_favoritas f JOIN')) return { rows: [{ id: PRONTA }] };
    if (/^(UPDATE|INSERT INTO whatsapp_atendimento_mensagens_prontas\()/.test(sql)) return { rows: Array.from({ length: op.atualizadas ?? 1 }, () => ({ id: PRONTA })) };
    if (sql.startsWith('SELECT id FROM whatsapp_atendimento_mensagens_prontas')) return { rows: op.pronta === null ? [] : [{ id: PRONTA }] };
    return { rows: [] };
  };
  const anterior = process.env.ADMIN_AUTH_ORIGIN;
  process.env.ADMIN_AUTH_ORIGIN = op.origem ?? 'https://admin.kidmais.com.br';
  const modulo = carregarComponente('lib/whatsapp/atendimento/prontas-servico.ts', {
    '../../clientes/repositories/cliente.repository.ts': { buscarClientesPorContatoExato: async (tel: string, empresa: string) => { chamadas.push(`cliente:${tel}:${empresa}`); return op.clientes ?? []; } },
    '../../fechamentos/contratacoes.ts': { listarContratacoes: async (_tx: unknown, empresa: string, cliente: string) => { chamadas.push(`contratacoes:${empresa}:${cliente}`); return op.contratacoes ?? []; } },
    './configuracao.ts': { ambienteAtendimento: () => 'staging' },
    './service.ts': { acessoAtendimento: async (_s: unknown, work: (tx: unknown, e: string, p: string) => unknown) => { if (op.recusa) throw new Error(op.recusa); return work({ query }, 'e1', op.papel ?? 'ADMINISTRATIVO'); }, temMidia: async () => op.midia ?? false, tem082: async () => op.r082 ?? false, exigirEscritaAtendimento: async () => { chamadas.push('escrita'); if (op.semEscrita) throw new Error('ATENDIMENTO_RECURSO_NAO_INCLUIDO'); } },
    './prontas.ts': prontas,
    './prontas-link.ts': prontasLink,
    '../../comercial/caminho-cardapio.ts': caminhoCardapio,
    '../../comercial/cardapio-publico.ts': cardapioPublico,
    '../../perfil/nome-publico.ts': nomePublico,
    './arquivos.ts': arquivos,
    'node:crypto': crypto,
  }).modulo as typeof import('./prontas-servico.ts');
  const restaurar = () => { if (anterior === undefined) delete process.env.ADMIN_AUTH_ORIGIN; else process.env.ADMIN_AUTH_ORIGIN = anterior; };
  return { modulo, comandos, chamadas, restaurar };
}
const sessao = { usuario_id: 'u1' } as never;

test('cardápio na conversa usa a empresa comprovada e o endereço do produto', async (t) => {
  const anterior = process.env.SITE_URL;
  process.env.SITE_URL = 'https://festas.exemplo.test';
  t.after(() => { if (anterior === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = anterior; });
  const dados = carregar();
  t.after(dados.restaurar);
  for (const [opcao, caminho] of [['CARDAPIO', ''], ['SALGADOS', '/salgados'], ['BOLOS', '/massa_bolo']] as const) {
    const r = await dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, cardapio: opcao });
    assert.ok(r.texto.endsWith('\n\nhttps://festas.exemplo.test/b/buffet-a/cardapio' + caminho));
  }
  for (const cmd of dados.comandos.filter(c => c.sql.includes('FROM whatsapp_atendimento_conversas'))) {
    assert.deepEqual(cmd.args, [CONVERSA, 'e1', 'staging']);
    assert.match(cmd.sql, /e\.id=c\.empresa_id WHERE c\.id=\$1 AND c\.empresa_id=\$2 AND c\.ambiente=\$3/);
  }
  const fora = carregar({ conversa: null });
  await assert.rejects(fora.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, cardapio: 'SALGADOS' }), /ATENDIMENTO_NAO_ENCONTRADO/);
  const foto = carregar({ pronta: linha({ atalho: 'BOLOS', tipo: 'IMAGEM', midia_url: 'https://foto.exemplo.test/bolo.jpg' }) });
  const r = await foto.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
  assert.equal(r.linkCardapio, 'https://festas.exemplo.test/b/buffet-a/cardapio/massa_bolo');
  assert.equal(r.texto, 'Olá!');
  assert.equal(r.midia?.prontaId, PRONTA);
  const menu = carregar({ pronta: linha({ finalidade: 'CARDAPIO' }) });
  assert.equal((await menu.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA })).linkCardapio, 'https://festas.exemplo.test/b/buffet-a/cardapio');
  process.env.SITE_URL = 'https://festas.exemplo.test/interno';
  await assert.rejects(dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, cardapio: 'CARDAPIO' }), /ATENDIMENTO_CARDAPIO_INDISPONIVEL/);
});
test('empresa sem escopo público, com outro id, sem 078, sem nome ou vazia não oferece link e preserva pronta e mídia', async () => {
  for (const estado of [{ empresaPublica: null }, { empresaPublica: 'e2' }, { estrutura078: false }, { nomePublico: '' }, { categorias: [] }]) {
    const dados = carregar({ ...estado, pronta: linha({ atalho: 'SALGADOS', tipo: 'IMAGEM', midia_url: 'https://foto.exemplo.test/prato.jpg' }) });
    try {
      await assert.rejects(dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, cardapio: 'SALGADOS' }), /ATENDIMENTO_CARDAPIO_INDISPONIVEL/);
      const personalizada = await dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
      assert.equal(personalizada.linkCardapio, undefined);
      assert.equal(personalizada.midia?.url, 'https://foto.exemplo.test/prato.jpg');
      assert.equal(personalizada.texto, 'Olá!');
      assert.equal(dados.comandos.some(c => c.sql.includes('FROM pacotes p')), 'categorias' in estado);
    } finally { dados.restaurar(); }
  }
});

test('atalhos sem a categoria abrem o completo com legenda genérica; bolos também encontra recheios', async () => {
  for (const [atalho, codigos, titulo, destino] of [
    ['SALGADOS', ['DOCES'], 'Cardápio completo', ''],
    ['BOLOS', ['DOCES', 'DECORACAO_BOLO'], 'Cardápio completo', ''],
    ['BOLOS', ['DOCES', 'RECHEIO_BOLO'], 'Bolos', '/recheio_bolo'],
  ] as const) {
    const dados = carregar({ categorias: [...codigos], pronta: linha({ atalho }) });
    try {
      const r = await dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, cardapio: atalho });
      assert.equal(r.titulo, titulo);
      const url = r.texto.split('\n\n').at(-1)!;
      assert.equal(new URL(url).pathname, '/b/buffet-a/cardapio' + destino);
      if (!destino) assert.equal(r.texto, 'Confira o nosso cardápio:\n\n' + url);
      const personalizada = await dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
      assert.equal(personalizada.linkCardapio, url);
      assert.equal(personalizada.texto, 'Olá!');
    } finally { dados.restaurar(); }
  }
});

test('falha na leitura opcional preserva o link original e recupera a transação', async () => {
  const dados = carregar({ falhaOpcional: true, pronta: linha({ tipo: 'LINK', finalidade: 'CARDAPIO', link: 'https://buffet.exemplo.test/pdf' }) });
  try {
    const r = await dados.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
    assert.equal(r.linkCardapio, undefined);
    assert.equal(r.texto, 'Olá!\n\nhttps://buffet.exemplo.test/pdf');
    assert.deepEqual(dados.comandos.slice(-2).map(c => c.sql), ['ROLLBACK TO SAVEPOINT link_cardapio_opcional', 'RELEASE SAVEPOINT link_cardapio_opcional']);
  } finally { dados.restaurar(); }
});
const nova = { titulo: 'Tabela de preços', categoria: 'Comercial', tipo: 'LINK', texto: 'Segue a tabela.', link: 'https://kidmais.com.br/tabela', atalho: 'TABELA_PRECOS' };

test('lista só da empresa/ambiente comprovados, com favoritas do próprio usuário; cadastro só para o representante', async () => {
  const { modulo, comandos } = carregar({ papel: 'ADMINISTRATIVO' });
  const r = await modulo.listarProntas(sessao);
  assert.equal(r.podeGerenciar, false); assert.deepEqual(r.favoritas, [PRONTA]);
  assert.deepEqual(comandos[0].args, ['e1', 'staging']); assert.match(comandos[0].sql, /AND p.ativa/);
  assert.deepEqual(comandos[1].args, ['u1', 'e1', 'staging']);
  await assert.rejects(modulo.salvarPronta(sessao, nova), /ATENDIMENTO_ACESSO_NEGADO/);
  await assert.rejects(modulo.arquivarPronta(sessao, { id: PRONTA, versao: 2 }), /ATENDIMENTO_ACESSO_NEGADO/);
  assert.equal((await carregar({ papel: 'REPRESENTANTE_AUTORIZADO' }).modulo.listarProntas(sessao)).podeGerenciar, true);
});

test('salvar valida, grava na empresa comprovada e controla versão; link individual nunca é gravado', async () => {
  const rep = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  await rep.modulo.salvarPronta(sessao, nova);
  const ins = rep.comandos.find(c => c.sql.startsWith('INSERT'))!;
  assert.deepEqual(ins.args, ['e1', 'staging', 'Tabela de preços', 'Comercial', 'LINK', 'Segue a tabela.', 'https://kidmais.com.br/tabela', 'TABELA_PRECOS', 'u1']);
  await assert.rejects(rep.modulo.salvarPronta(sessao, { ...nova, link: 'http://kidmais.com.br' }), (e: Error) => e.name === 'ZodError');
  const ind = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  await ind.modulo.salvarPronta(sessao, { ...nova, tipo: 'LINK_FECHAMENTO_INDIVIDUAL', link: null, atalho: 'DISPONIBILIDADE_FECHAMENTO' });
  assert.equal(ind.comandos.find(c => c.sql.startsWith('INSERT'))!.args[6], null);
  const velha = carregar({ papel: 'REPRESENTANTE_AUTORIZADO', atualizadas: 0 });
  await assert.rejects(velha.modulo.salvarPronta(sessao, { ...nova, id: PRONTA, versao: 1 }), /ATENDIMENTO_PRONTA_DESATUALIZADA/);
  assert.match(velha.comandos[0].sql, /versao=\$4 AND ativa/);
});

test('sem a 080 a biblioteca fica indisponível; unicidade vira mensagem clara', async () => {
  await assert.rejects(carregar({ erro: { code: '42P01' } }).modulo.listarProntas(sessao), /ATENDIMENTO_PRONTAS_INDISPONIVEL/);
  await assert.rejects(carregar({ papel: 'REPRESENTANTE_AUTORIZADO', erro: { code: '23505', constraint: 'whatsapp_prontas_atalho_unico' } }).modulo.salvarPronta(sessao, nova), /ATENDIMENTO_PRONTA_ATALHO_EM_USO/);
  await assert.rejects(carregar({ papel: 'REPRESENTANTE_AUTORIZADO', erro: { code: '23505', constraint: 'whatsapp_prontas_titulo_unico' } }).modulo.salvarPronta(sessao, nova), /ATENDIMENTO_PRONTA_TITULO_EM_USO/);
});

test('favorita só de mensagem ativa da mesma empresa, sempre do próprio usuário', async () => {
  const f = carregar();
  await f.modulo.favoritarPronta(sessao, { id: PRONTA, favorita: true });
  assert.deepEqual(f.comandos.at(-1)!.args, ['u1', PRONTA, 'e1', 'staging']);
  await assert.rejects(carregar({ pronta: null }).modulo.favoritarPronta(sessao, { id: PRONTA, favorita: true }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/);
  const d = carregar(); await d.modulo.favoritarPronta(sessao, { id: PRONTA, favorita: false });
  assert.match(d.comandos[0].sql, /DELETE .* WHERE usuario_id=\$1 AND mensagem_pronta_id=\$2 AND empresa_id=\$3 AND ambiente=\$4/);
});

test('rascunho: conversa e mensagem da empresa comprovada; texto e link fixo; nada é enviado; telefone não volta', async () => {
  const t = carregar({ pronta: linha({ tipo: 'LINK', link: 'https://kidmais.com.br/tabela' }) });
  const r = await t.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
  assert.deepEqual(r, { titulo: 'Fechamento', texto: 'Olá!\n\nhttps://kidmais.com.br/tabela', linkIndividual: null, aviso: null });
  assert.deepEqual(t.comandos[0].args, [CONVERSA, 'e1', 'staging']); assert.deepEqual(t.comandos[1].args, [PRONTA, 'e1', 'staging']);
  assert.ok(!t.comandos.some(c => /INSERT INTO whatsapp_atendimento_mensagens\(|UPDATE whatsapp_atendimento_conversas/.test(c.sql)), 'rascunho não grava nem envia');
  assert.ok(!JSON.stringify(r).includes('99999'), 'telefone não volta para a tela');
  t.restaurar();
  await assert.rejects(carregar({ conversa: null }).modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA }), /ATENDIMENTO_NAO_ENCONTRADO/);
  await assert.rejects(carregar({ pronta: null }).modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/);
});

test('link individual: preenchido só com vínculo inequívoco na empresa comprovada; sem vínculo, não preenche e explica', async () => {
  const ind = linha({ tipo: 'LINK_FECHAMENTO_INDIVIDUAL', texto: 'Seu contrato está pronto:' });
  const ok = carregar({ pronta: ind, clientes: [{ id: 'c1', empresaId: 'e1' }], contratacoes: [{ contratoId: CONTRATO, acessoPublico: `/contrato/${CONTRATO}` }] });
  const r = await ok.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA });
  ok.restaurar();
  assert.equal(r.texto, `Seu contrato está pronto:\n\nhttps://admin.kidmais.com.br/contrato/${CONTRATO}`); assert.equal(r.linkIndividual, 'PREENCHIDO');
  assert.deepEqual(ok.chamadas, ['cliente:5561999998888:e1', 'cliente:61999998888:e1', 'contratacoes:e1:c1'], 'consultas sempre com a empresa comprovada');
  const ambiguo = carregar({ pronta: ind, clientes: [{ id: 'c1', empresaId: 'e1' }, { id: 'c2', empresaId: 'e1' }] });
  const a = await ambiguo.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA }); ambiguo.restaurar();
  assert.equal(a.texto, 'Seu contrato está pronto:'); assert.equal(a.linkIndividual, 'NAO_PREENCHIDO'); assert.match(a.aviso!, /Mais de um cliente/);
  const http = carregar({ pronta: ind, clientes: [{ id: 'c1', empresaId: 'e1' }], contratacoes: [{ contratoId: CONTRATO, acessoPublico: 'x' }], origem: 'http://localhost:3040' });
  const h = await http.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA }); http.restaurar();
  assert.equal(h.linkIndividual, 'NAO_PREENCHIDO'); assert.doesNotMatch(h.texto, /contrato\//);
});

const FOTO = { titulo: 'Salgados da casa', categoria: 'Cardápio', tipo: 'IMAGEM', texto: 'Nossos salgados.', link: null, midiaUrl: 'https://cdn.exemplo.test/salgados.jpg', atalho: 'SALGADOS' };
test('081: foto/vídeo e atalhos novos só com a 081; com ela, a URL de mídia é gravada; sem ela, mensagem clara e nada gravado', async () => {
  const sem = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  await assert.rejects(sem.modulo.salvarPronta(sessao, FOTO), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
  await assert.rejects(sem.modulo.salvarPronta(sessao, { ...nova, atalho: 'ENDERECO' }), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
  assert.ok(!sem.comandos.some(c => /^(INSERT|UPDATE)/.test(c.sql)), 'nada gravado sem a 081');
  assert.equal((await sem.modulo.listarProntas(sessao)).recursos081, false);
  assert.match(sem.comandos.find(c => c.sql.startsWith('SELECT p.id,p.titulo'))!.sql, /NULL::text AS midia_url/);
  const com = carregar({ papel: 'REPRESENTANTE_AUTORIZADO', midia: true });
  await com.modulo.salvarPronta(sessao, FOTO);
  const ins = com.comandos.find(c => c.sql.startsWith('INSERT'))!;
  assert.match(ins.sql, /midia_url/);
  assert.deepEqual(ins.args, ['e1', 'staging', 'Salgados da casa', 'Cardápio', 'IMAGEM', 'Nossos salgados.', null, 'https://cdn.exemplo.test/salgados.jpg', 'SALGADOS', 'u1']);
  assert.equal((await com.modulo.listarProntas(sessao)).recursos081, true);
  // Validação antes do banco: http, IP, extensão errada, URL no tipo texto e legenda longa são recusados.
  for (const ruim of [{ ...FOTO, midiaUrl: 'http://cdn.exemplo.test/s.jpg' }, { ...FOTO, midiaUrl: 'https://192.168.0.1/s.jpg' }, { ...FOTO, midiaUrl: 'https://cdn.exemplo.test/s.gif' },
    { ...FOTO, tipo: 'VIDEO', midiaUrl: 'https://cdn.exemplo.test/s.jpg' }, { ...nova, midiaUrl: 'https://cdn.exemplo.test/s.jpg' }, { ...FOTO, texto: 'a'.repeat(1025) }])
    await assert.rejects(com.modulo.salvarPronta(sessao, ruim), (e: Error) => e.name === 'ZodError', JSON.stringify(ruim).slice(0, 80));
});

test('081: rascunho de foto/vídeo devolve legenda editável e a mídia só para conferência (id e versão da pronta); nada é enviado', async () => {
  const t = carregar({ midia: true, pronta: linha({ tipo: 'VIDEO', texto: 'Tour pelo salão', midia_url: 'https://cdn.exemplo.test/tour.mp4' }) });
  const r = await t.modulo.prepararRascunho(sessao, { conversaId: CONVERSA, id: PRONTA }); t.restaurar();
  assert.deepEqual(r, { titulo: 'Fechamento', texto: 'Tour pelo salão', linkIndividual: null, aviso: null, midia: { tipo: 'VIDEO', url: 'https://cdn.exemplo.test/tour.mp4', prontaId: PRONTA, versao: 2 } }, 'a versão vista na prévia vai junto (o envio é preso a ela)');
  assert.deepEqual(t.comandos[1].args, [PRONTA, 'e1', 'staging'], 'a pronta é lida só na empresa/ambiente comprovados');
  assert.ok(!t.comandos.some(c => /INSERT INTO whatsapp_atendimento_mensagens\(/.test(c.sql)), 'rascunho não grava nem envia');
});

test('recusas de acesso (empresa divergente, seleção pendente, sem acesso) chegam às rotas da biblioteca sem tradução e sem consulta', async () => {
  for (const recusa of ['ATENDIMENTO_EMPRESA_DIVERGENTE', 'ATENDIMENTO_EMPRESA_NAO_SELECIONADA', 'ATENDIMENTO_SEM_ACESSO']) {
    const { modulo, comandos, restaurar } = carregar({ recusa });
    try {
      await assert.rejects(modulo.listarProntas({ usuario_id: 'u', papel: 'REPRESENTANTE_AUTORIZADO' } as never), new RegExp(recusa));
      assert.equal(comandos.length, 0);
    } finally { restaurar(); }
  }
});

// E-ME1 r2 (F4): toda ESCRITA na biblioteca passa pelo portão de modo (exigirEscritaAtendimento) antes de tocar o banco;
// recusada, nada é gravado. Ler (listar, rascunho) não passa por ele.
test('E-ME1 F4: escrita na biblioteca recusada pelo modo não grava nada; leitura continua', async () => {
  const pedidos: [string, (m: Record<string, (s: unknown, v: unknown) => Promise<unknown>>) => Promise<unknown>][] = [
    ['salvar', (m) => m.salvarPronta(sessao, nova)],
    ['publicar', (m) => m.publicarPronta(sessao, { id: PRONTA, versao: 1, publicar: true })],
    ['arquivar', (m) => m.arquivarPronta(sessao, { id: PRONTA, versao: 1 })],
    ['favoritar', (m) => m.favoritarPronta(sessao, { id: PRONTA, favorita: true })],
  ];
  for (const [rotulo, pedir] of pedidos) {
    const c = carregar({ papel: 'REPRESENTANTE_AUTORIZADO', r082: true, midia: true, semEscrita: true });
    try {
      await assert.rejects(pedir(c.modulo as never), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, rotulo);
      assert.ok(!c.comandos.some((x: { sql: string }) => /^(INSERT|UPDATE|DELETE)/.test(x.sql.trim())), rotulo + ': nada gravado');
    } finally { c.restaurar(); }
  }
  const leitura = carregar({ papel: 'REPRESENTANTE_AUTORIZADO', semEscrita: true });
  try { await leitura.modulo.listarProntas(sessao, { gerenciar: true }); assert.ok(!leitura.chamadas.includes('escrita'), 'listar não passa pelo portão de escrita'); }
  finally { leitura.restaurar(); }
});
