import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as prontas from './prontas.ts';
import * as prontasLink from './prontas-link.ts';
import * as arquivos from './arquivos.ts';
import * as crypto from 'node:crypto';
import type { Pronta } from './prontas.ts';

// Banco simulado: nenhum PostgreSQL real é acessado.
const CONTRATO = '2b6f0f9e-6c1d-4a8e-9a55-3f0a5b1c2d3e';
const PRONTA = '7f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f601';
const CONVERSA = '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const linha = (x: Partial<Pronta> = {}): Pronta => ({ id: PRONTA, titulo: 'Fechamento', categoria: 'Comercial', tipo: 'TEXTO', texto: 'Olá!', link: null, midia_url: null, atalho: null, versao: 2, atualizada_em: '', ...x });
// midia: a 077 está aplicada (colunas de mídia presentes). Padrão: ausente, o comportamento da 076.
type Op = { recusa?: string; papel?: string; pronta?: Pronta | null; conversa?: { contato: string } | null; erro?: { code: string; constraint?: string }; atualizadas?: number; clientes?: { id: string; empresaId: string | null }[]; contratacoes?: { contratoId: string | null; acessoPublico: string | null }[]; origem?: string; midia?: boolean; r078?: boolean };
function carregar(op: Op = {}) {
  const comandos: { sql: string; args: unknown[] }[] = [];
  const chamadas: string[] = [];
  const query = async (sql: string, args: unknown[] = []) => {
    comandos.push({ sql, args });
    if (op.erro) throw Object.assign(new Error('pg'), op.erro);
    if (sql.includes('FROM whatsapp_atendimento_conversas')) return { rows: op.conversa === null ? [] : [op.conversa ?? { contato: '5561999998888' }] };
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
    './service.ts': { acessoAtendimento: async (_s: unknown, work: (tx: unknown, e: string, p: string) => unknown) => { if (op.recusa) throw new Error(op.recusa); return work({ query }, 'e1', op.papel ?? 'ADMINISTRATIVO'); }, temMidia: async () => op.midia ?? false, tem078: async () => op.r078 ?? false },
    './prontas.ts': prontas,
    './prontas-link.ts': prontasLink,
    './arquivos.ts': arquivos,
    'node:crypto': crypto,
  }).modulo as typeof import('./prontas-servico.ts');
  const restaurar = () => { if (anterior === undefined) delete process.env.ADMIN_AUTH_ORIGIN; else process.env.ADMIN_AUTH_ORIGIN = anterior; };
  return { modulo, comandos, chamadas, restaurar };
}
const sessao = { usuario_id: 'u1' } as never;
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

test('sem a 076 a biblioteca fica indisponível; unicidade vira mensagem clara', async () => {
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
test('077: foto/vídeo e atalhos novos só com a 077; com ela, a URL de mídia é gravada; sem ela, mensagem clara e nada gravado', async () => {
  const sem = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  await assert.rejects(sem.modulo.salvarPronta(sessao, FOTO), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
  await assert.rejects(sem.modulo.salvarPronta(sessao, { ...nova, atalho: 'ENDERECO' }), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
  assert.ok(!sem.comandos.some(c => /^(INSERT|UPDATE)/.test(c.sql)), 'nada gravado sem a 077');
  assert.equal((await sem.modulo.listarProntas(sessao)).recursos077, false);
  assert.match(sem.comandos.find(c => c.sql.startsWith('SELECT p.id,p.titulo'))!.sql, /NULL::text AS midia_url/);
  const com = carregar({ papel: 'REPRESENTANTE_AUTORIZADO', midia: true });
  await com.modulo.salvarPronta(sessao, FOTO);
  const ins = com.comandos.find(c => c.sql.startsWith('INSERT'))!;
  assert.match(ins.sql, /midia_url/);
  assert.deepEqual(ins.args, ['e1', 'staging', 'Salgados da casa', 'Cardápio', 'IMAGEM', 'Nossos salgados.', null, 'https://cdn.exemplo.test/salgados.jpg', 'SALGADOS', 'u1']);
  assert.equal((await com.modulo.listarProntas(sessao)).recursos077, true);
  // Validação antes do banco: http, IP, extensão errada, URL no tipo texto e legenda longa são recusados.
  for (const ruim of [{ ...FOTO, midiaUrl: 'http://cdn.exemplo.test/s.jpg' }, { ...FOTO, midiaUrl: 'https://192.168.0.1/s.jpg' }, { ...FOTO, midiaUrl: 'https://cdn.exemplo.test/s.gif' },
    { ...FOTO, tipo: 'VIDEO', midiaUrl: 'https://cdn.exemplo.test/s.jpg' }, { ...nova, midiaUrl: 'https://cdn.exemplo.test/s.jpg' }, { ...FOTO, texto: 'a'.repeat(1025) }])
    await assert.rejects(com.modulo.salvarPronta(sessao, ruim), (e: Error) => e.name === 'ZodError', JSON.stringify(ruim).slice(0, 80));
});

test('077: rascunho de foto/vídeo devolve legenda editável e a mídia só para conferência (id e versão da pronta); nada é enviado', async () => {
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
