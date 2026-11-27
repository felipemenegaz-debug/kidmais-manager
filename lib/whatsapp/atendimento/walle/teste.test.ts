import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente, cssFalso, elementos, texto, tique } from '../../../../components/admin/teste-componente.ts';
import * as core from '../core.ts';
import { motivoSeguro } from '../motivo-falha.ts';
import * as ent from './entendimento.ts';
import * as tipos from './tipos.ts';

/**
 * Fatia 10a ("Testar o Wall-e"): zero escrita. Nenhum insert/update/delete — mensagens, contatos, conversas,
 * oportunidades, aviso à equipe, nada — e nenhum envio. Sem banco nem rede: executores dublês registram todo SQL.
 */
const ESCRITA = /\b(insert|update|delete|merge|upsert|truncate|copy|alter|create|drop|nextval|setval|pg_notify|notify|lock)\b/i;
const config = { ativo: false, nome: 'Buffet', perguntas: [{ id: 'faq_1', pergunta: 'Pode levar bolo?', resposta: 'Pode sim.' }], limites: { respostasPor24h: 20 } };
const entrada = { empresa: 'e1', ambiente: 'staging', contato: '', texto: 'quanto custa?', historico: [], contexto: {}, config, hoje: '2026-10-09', agora: '2026-10-09T12:00:00.000Z' } as never;

type OpcoesPorta = { fontesQueEscrevem?: boolean; soRegras?: boolean; direito?: (ex: { query: (q: string) => Promise<unknown> }, empresa: string) => Promise<boolean>; prontas?: { id: string; titulo: string }[] };
function carregarPorta(registro: { sql: string[]; transacoes: string[]; proibidas: string[]; alvo?: { linkContratoProprio: () => Promise<string | null> } }, op: OpcoesPorta = {}) {
  const fontesQueEscrevem = !!op.fontesQueEscrevem;
  const proibida = (nome: string) => async () => { registro.proibidas.push(nome); throw new Error(`${nome} proibido no teste`); };
  // Executor da transação: como o PostgreSQL, recusa escrita depois de SET TRANSACTION READ ONLY.
  const executor = () => { let somenteLeitura = false; return { query: async (q: string) => {
    registro.sql.push(q);
    if (/^SET TRANSACTION READ ONLY$/.test(q)) somenteLeitura = true;
    else if (somenteLeitura && ESCRITA.test(q)) throw new Error('cannot execute in a read-only transaction');
    return { rows: [], rowCount: 0 };
  } }; };
  return carregarComponente('lib/whatsapp/atendimento/walle/porta.ts', {
    '../../../db/postgres.ts': {
      db: () => { registro.proibidas.push('db'); return executor(); },
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        try { const r = await fn(executor()); registro.transacoes.push('COMMIT'); return r; } catch (e) { registro.transacoes.push('ROLLBACK'); throw e; }
      },
    },
    '../../../clientes/repositories/cliente.repository': { buscarClientesPorContatoExato: proibida('cliente') },
    '../../../fechamentos/contratacoes.ts': { listarContratacoes: proibida('contratacoes') },
    '../core.ts': core,
    '../configuracao.ts': { entendimentoSoRegras: () => op.soRegras ?? true, modoEntendimento: () => ({ modo: 'REGRAS' }) },
    '../multiempresa.ts': { direitoAtendimentoWhatsApp: op.direito ?? proibida('direito') },
    '../motivo-falha.ts': { motivoSeguro },
    '../prontas-link.ts': { resolverLinkFechamento: proibida('linkFechamento') },
    './contexto.ts': { lerContexto: (c: unknown) => (c ?? {}) },
    './entendimento.ts': { ESQUEMA_JSON_MODELO: {}, esquemaModelo: { parse: (v: unknown) => v }, entenderPorRegras: () => ({ sinais: {} }), revalidarEntendimento: () => ({ sinais: {} }), juntarSinais: (a: unknown) => a },
    './fontes-postgres.ts': {
      catalogosWallE: async (ex: { query: (q: string) => Promise<unknown> }) => { await ex.query('SELECT catalogos'); return {}; },
      fontesPostgres: (ex: { query: (q: string) => Promise<unknown> }, alvo: { linkContratoProprio: () => Promise<string | null> }) => { registro.alvo = alvo; return { async pacotes() { await ex.query('SELECT pacotes'); if (fontesQueEscrevem) await ex.query('INSERT INTO whatsapp_mensagens VALUES (1)'); return []; }, async prontasAutorizadas() { await ex.query('SELECT prontas'); return op.prontas ?? []; } }; },
    },
    './link-disponibilidade.ts': { ambienteDoLink: () => 'staging', linkDisponibilidadeDaEmpresa: async (_e: string, _a: string, ex: () => { query: (q: string) => Promise<unknown> }) => { await ex().query('SELECT link'); return { ok: false }; } },
    './resolver.ts': { resolverWallE: async (_e: unknown, f: { pacotes: () => Promise<unknown>; prontasAutorizadas: (fin: string) => Promise<unknown> }) => { await f.pacotes(); if (op.prontas) await f.prontasAutorizadas('INFORMACAO'); await registro.alvo!.linkContratoProprio(); return { saidas: [{ texto: 'ok', anexo: null, fontes: [] }], contexto: {}, passagem: null }; } },
  }).modulo as typeof import('./porta.ts');
}

test('porta sem efeito: toda leitura em transação somente leitura sempre desfeita; nenhum COMMIT, nenhum db() direto, nenhum cadastro procurado', async () => {
  const registro = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  const r = await carregarPorta(registro).criarPortaWallE(null, { semEfeito: true }).responder(entrada);
  assert.deepEqual(r.saidas.map((s) => s.texto), ['ok']);
  assert.equal(r.entendidoPor, 'REGRAS');
  assert.deepEqual(registro.transacoes, ['ROLLBACK', 'ROLLBACK'], 'catálogos e resolução: duas transações, as duas desfeitas');
  assert.deepEqual(registro.sql, ['SET TRANSACTION READ ONLY', 'SELECT catalogos', 'SET TRANSACTION READ ONLY', 'SELECT link', 'SELECT pacotes']);
  assert.ok(!registro.sql.some((q) => ESCRITA.test(q)), 'nenhuma escrita');
  assert.deepEqual(registro.proibidas, [], 'sem db() fora da transação e sem busca do contrato particular');
});

test('porta sem efeito: escrita numa fonte é recusada pela transação somente leitura e nada é confirmado', async () => {
  const registro = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  await assert.rejects(carregarPorta(registro, { fontesQueEscrevem: true }).criarPortaWallE(null, { semEfeito: true }).responder(entrada), /read-only/);
  assert.ok(!registro.transacoes.includes('COMMIT'));
});

test('porta da fila (sem semEfeito) segue igual: lê direto, sem transação, e procura o link do contrato particular', async () => {
  const registro = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  await assert.rejects(carregarPorta(registro).criarPortaWallE(null).responder({ ...(entrada as object), contato: '5561900000000' } as never), /linkFechamento/);
  assert.deepEqual(registro.transacoes, []);
  assert.ok(registro.proibidas.includes('db') && registro.proibidas.includes('linkFechamento'));
});

function carregarTeste(sql: string[], porta: { responder: (e: unknown) => Promise<unknown> }, opcoes: { tem082?: boolean } = {}) {
  const tx = { query: async (q: string) => { sql.push(q); return { rows: [], rowCount: 0 }; } };
  return carregarComponente('lib/whatsapp/atendimento/walle/teste.ts', {
    '../core.ts': core,
    '../configuracao.ts': { ambienteAtendimento: () => 'staging' },
    '../motivo-falha.ts': { motivoSeguro },
    '../service.ts': {
      acessoAtendimento: async (_s: unknown, work: (tx: unknown, e: string, p: string) => unknown) => work(tx, 'e1', 'ADMINISTRATIVO'),
      tem082: async (t: typeof tx) => { await t.query('SELECT 082'); return opcoes.tem082 ?? true; },
      configuracao: async (t: typeof tx) => { await t.query('SELECT configuracao'); return config; },
    },
    './entendimento.ts': ent,
    './tipos.ts': tipos,
  }).modulo as typeof import('./teste.ts');
}

test('testarWallE: só lê a configuração salva e chama a porta numa conversa nova (sem contato, histórico ou memória)', async () => {
  const sql: string[] = []; const pedidos: unknown[] = [];
  const porta = { responder: async (e: unknown) => { pedidos.push(e); return { saidas: [{ texto: 'Pode sim.', anexo: null, fontes: [{ tipo: 'CONFIGURACAO', perguntaId: 'faq_1' }] }], contexto: { pendente: null }, passagem: null, entendidoPor: 'REGRAS' }; } };
  const r = await carregarTeste(sql, porta).testarWallE({} as never, 'Pode levar bolo?', porta as never, new Date('2026-10-09T12:00:00.000Z'));
  assert.deepEqual(sql, ['SELECT 082', 'SELECT configuracao']);
  assert.deepEqual(pedidos, [{ empresa: 'e1', ambiente: 'staging', contato: '', texto: 'Pode levar bolo?', historico: [], contexto: {}, config, hoje: '2026-10-09', agora: '2026-10-09T12:00:00.000Z' }]);
  assert.deepEqual(r, { desfecho: 'RESPONDE', entendidoPor: 'REGRAS', respostas: [{ texto: 'Pode sim.', anexo: null, fontes: ['Resposta aprovada: “Pode levar bolo?”'] }], motivos: [], mensagem: 'Pode levar bolo?' });
});

test('testarWallE: pedido de parar bloqueia como na recepção, sem chamar a porta; sem a 082 recusa; falha da porta vira encaminhamento', async () => {
  let chamadas = 0; const porta = { responder: async () => { chamadas++; throw new Error('ATENDIMENTO_X'); } };
  const parar = await carregarTeste([], porta).testarWallE({} as never, 'PARAR', porta as never);
  assert.equal(parar.desfecho, 'BLOQUEIA_NA_RECEPCAO'); assert.equal(chamadas, 0);
  await assert.rejects(carregarTeste([], porta, { tem082: false }).testarWallE({} as never, 'oi', porta as never), /ATENDIMENTO_RECURSO_082_INDISPONIVEL/);
  assert.equal(chamadas, 0);
  const avisos: unknown[] = []; const aviso = console.warn; console.warn = (...a: unknown[]) => { avisos.push(a); };
  try { assert.deepEqual(await carregarTeste([], porta).testarWallE({} as never, 'quanto custa?', porta as never), { desfecho: 'FALHA', entendidoPor: null, respostas: [], motivos: [tipos.NOME_MOTIVO.FALHA], mensagem: 'quanto custa?' }); }
  finally { console.warn = aviso; }
  assert.equal(chamadas, 1); assert.ok(!JSON.stringify(avisos).includes('quanto custa'), 'o texto digitado não vai para o log');
});

test('resultadoDoTeste: desfechos do worker, legenda do anexo, fontes rotuladas sem repetição', async () => {
  const { resultadoDoTeste } = carregarTeste([], { responder: async () => null });
  const base = { contexto: {}, passagem: null };
  assert.equal(resultadoDoTeste({ ...base, saidas: [], parar: { trecho: 'x' } } as never, config).desfecho, 'BLOQUEIA');
  assert.equal(resultadoDoTeste({ ...base, saidas: [], silencio: true, passagem: { motivos: ['PARAR_A_CONFIRMAR'] } } as never, config).desfecho, 'PASSA_EM_SILENCIO');
  assert.equal(resultadoDoTeste({ ...base, saidas: [] } as never, config).desfecho, 'FALHA');
  const r = resultadoDoTeste({ ...base, passagem: { motivos: ['NEGOCIACAO'] }, saidas: [
    { texto: 'Segue o cardápio', anexo: { prontaId: 'p1', titulo: 'Cardápio 2026', tipo: 'PDF', legenda: 'Cardápio do buffet' }, fontes: [{ tipo: 'PRONTA', id: 'p1' }] },
    { texto: 'Valor', anexo: null, fontes: [{ tipo: 'PACOTE', codigo: 'BASICO' }, { tipo: 'PACOTE', codigo: 'BASICO' }, { tipo: 'AGENDA', data: '2026-11-07', escopo: 'EMPRESA' }, { tipo: 'CONFIGURACAO', perguntaId: 'sumiu' }] },
  ] } as never, config);
  assert.deepEqual(r, { desfecho: 'RESPONDE_E_PASSA', entendidoPor: null, motivos: [tipos.NOME_MOTIVO.NEGOCIACAO], respostas: [
    { texto: 'Cardápio do buffet', anexo: { titulo: 'Cardápio 2026', tipo: 'PDF' }, fontes: ['Biblioteca: Cardápio 2026'] },
    { texto: 'Valor', anexo: null, fontes: ['Pacote BASICO', 'Agenda de 07/11/2026', 'Resposta aprovada'] },
  ] });
  // Astra r1 (P2-4): duas prontas de TEXTO distintas na mesma saída (sem anexo) aparecem cada uma com o seu título; a mesma
  // pronta repetida aparece uma vez.
  const prontas = resultadoDoTeste({ ...base, titulosProntas: { t1: 'Política de bolo', t2: 'Horário de visita' }, saidas: [
    { texto: 'Pode trazer bolo. Visitas às terças.', anexo: null, fontes: [{ tipo: 'PRONTA', id: 't1', versao: 1, finalidade: 'INFORMACAO' }, { tipo: 'PRONTA', id: 't2', versao: 3, finalidade: 'INFORMACAO' }, { tipo: 'PRONTA', id: 't1', versao: 1, finalidade: 'INFORMACAO' }] },
  ] } as never, config);
  assert.deepEqual(prontas.respostas[0].fontes, ['Biblioteca: Política de bolo', 'Biblioteca: Horário de visita']);
  // Mesmo título em prontas diferentes: duas linhas (a identidade é a pronta, não o rótulo).
  const mesmoTitulo = resultadoDoTeste({ ...base, titulosProntas: { a: 'Regras', b: 'Regras' }, saidas: [
    { texto: 'x', anexo: null, fontes: [{ tipo: 'PRONTA', id: 'a', versao: 1, finalidade: 'INFORMACAO' }, { tipo: 'PRONTA', id: 'b', versao: 1, finalidade: 'INFORMACAO' }] },
  ] } as never, config);
  assert.equal(mesmoTitulo.respostas[0].fontes.length, 2);
});

test('testarWallE: pedido de pausa vai à equipe em silêncio como na recepção, sem chamar a porta (Astra r1, P2-1)', async () => {
  let chamadas = 0; const porta = { responder: async () => { chamadas++; throw new Error('a porta não pode ser chamada'); } };
  const texto = 'por enquanto não precisa me mandar mais nada, depois eu chamo vocês';
  assert.ok(core.pausaPedidaNaRecepcao(texto), 'o exemplo é pausa para a recepção');
  const r = await carregarTeste([], porta).testarWallE({} as never, texto, porta as never, new Date('2026-10-09T12:00:00.000Z'));
  assert.equal(chamadas, 0);
  assert.deepEqual(r, { desfecho: 'PASSA_EM_SILENCIO', entendidoPor: null, respostas: [], motivos: ent.registroDaPausa(texto, '2026-10-09T12:00:00.000Z', {}).motivos.map((m) => tipos.NOME_MOTIVO[m]), mensagem: texto });
  assert.ok(r.motivos.includes(tipos.NOME_MOTIVO.PARAR_A_CONFIRMAR));
});

test('testarWallE: parar com reclamação bloqueia e deixa a reclamação com a equipe, como registroDoBloqueio (Astra r1, P2-2)', async () => {
  let chamadas = 0; const porta = { responder: async () => { chamadas++; throw new Error('a porta não pode ser chamada'); } };
  const texto = 'não quero mais propaganda de vcs. aliás a festa do meu filho foi péssima, salgado frio e monitor sumido';
  const r = await carregarTeste([], porta).testarWallE({} as never, texto, porta as never);
  assert.equal(chamadas, 0);
  assert.equal(r.desfecho, 'BLOQUEIA_NA_RECEPCAO');
  assert.deepEqual(r.motivos, [tipos.NOME_MOTIVO.RECLAMACAO, tipos.NOME_MOTIVO.BLOQUEADO_A_PEDIDO]);
  assert.equal(r.reclamacaoParaEquipe, true);
  const simples = await carregarTeste([], porta).testarWallE({} as never, 'PARAR', porta as never);
  assert.deepEqual(simples.motivos, [tipos.NOME_MOTIVO.BLOQUEADO_A_PEDIDO]);
  assert.equal(simples.reclamacaoParaEquipe, undefined);
});

test('porta sem efeito: o direito ao modelo é lido dentro da transação somente leitura, nunca pelo pool (Astra r1, P2-3)', async () => {
  const registro = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  const porta = carregarPorta(registro, { soRegras: false, direito: async (ex) => { await ex.query('SELECT direito'); return false; } });
  const r = await porta.criarPortaWallE(async () => { throw new Error('sem direito: o modelo não pode ser chamado'); }, { semEfeito: true, direitoModelo: porta.direitoModeloAtendimento }).responder(entrada);
  assert.equal(r.entendidoPor, 'REGRAS');
  assert.deepEqual(registro.proibidas, [], 'nenhum db() direto');
  const i = registro.sql.indexOf('SELECT direito');
  assert.ok(i > 0 && registro.sql[i - 1] === 'SET TRANSACTION READ ONLY', `direito na própria transação somente leitura: ${JSON.stringify(registro.sql)}`);
  assert.deepEqual(registro.transacoes, ['ROLLBACK', 'ROLLBACK', 'ROLLBACK'], 'catálogos, direito e resolução: todas desfeitas');
  assert.ok(!registro.transacoes.includes('COMMIT'));
  // Na fila (sem semEfeito), o direito segue pelo pool, como antes.
  const fila = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  const pf = carregarPorta(fila, { soRegras: false, direito: async (ex) => { await ex.query('SELECT direito'); return false; } });
  await assert.rejects(pf.criarPortaWallE(async () => { throw new Error('x'); }, { direitoModelo: pf.direitoModeloAtendimento }).responder({ ...(entrada as object), contato: '5561900000000' } as never), /linkFechamento/);
  assert.ok(fila.sql.includes('SELECT direito') && !fila.sql.includes('SET TRANSACTION READ ONLY')); assert.ok(fila.proibidas.includes('db'));
});

test('porta sem efeito: devolve o título de cada pronta lida, inclusive texto e link (Astra r1, P2-4)', async () => {
  const registro = { sql: [] as string[], transacoes: [] as string[], proibidas: [] as string[] };
  const prontas = [{ id: 't1', titulo: 'Política de bolo' }, { id: 't2', titulo: 'Horário de visita' }];
  const r = await carregarPorta(registro, { prontas }).criarPortaWallE(null, { semEfeito: true }).responder(entrada);
  assert.deepEqual(r.titulosProntas, { t1: 'Política de bolo', t2: 'Horário de visita' });
});

test('tela: testa pelo POST "testar", mostra desfecho, respostas, fontes e quem entendeu; nada é guardado além da tela', async () => {
  const pedidos: { url: string; corpo: unknown }[] = [];
  let resposta: Record<string, unknown> = { desfecho: 'RESPONDE', entendidoPor: 'MODELO', motivos: [], mensagem: 'Pode levar bolo?', respostas: [{ texto: 'Pode sim.', anexo: null, fontes: ['Resposta aprovada: “Pode levar bolo?”'] }] };
  const tela = carregarComponente('components/admin/atendimento/TestarWallE.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async (url: string, init: { body: string }) => { pedidos.push({ url, corpo: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, data: resposta }) }; } },
    './atendimento.module.css': cssFalso,
  });
  let arvore = tela.render();
  const area = elementos(arvore).find((e) => e.type === 'textarea')!;
  (area.props.onChange as (e: unknown) => void)({ target: { value: '  Pode levar bolo?  ' } });
  arvore = tela.render();
  const form = elementos(arvore).find((e) => e.type === 'form')!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  await tique(); await tique();
  arvore = tela.render();
  assert.deepEqual(pedidos, [{ url: '/api/admin/atendimento', corpo: { acao: 'testar', texto: 'Pode levar bolo?' } }]);
  const t = texto(arvore);
  assert.match(t, /nada é enviado nem gravado/);
  assert.match(t, /O Wall-e responderia assim:/);
  assert.match(t, /Pode sim\./);
  assert.match(t, /Fonte: Resposta aprovada: “Pode levar bolo\?”/);
  assert.match(t, /entendida pelo modelo de IA/);
  // Astra r1 (P3): a mensagem testada aparece com o resultado, mesmo que o campo mude depois.
  assert.match(t, /Mensagem testada: “Pode levar bolo\?”/);
  (elementos(tela.render()).find((e) => e.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: 'outra coisa' } });
  assert.match(texto(tela.render()), /Mensagem testada: “Pode levar bolo\?”/);
  // Bloqueio com reclamação: a tela diz que a reclamação iria para a equipe.
  resposta = { desfecho: 'BLOQUEIA_NA_RECEPCAO', entendidoPor: null, motivos: [tipos.NOME_MOTIVO.RECLAMACAO, tipos.NOME_MOTIVO.BLOQUEADO_A_PEDIDO], respostas: [], mensagem: 'outra coisa', reclamacaoParaEquipe: true };
  (elementos(tela.render()).find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  await tique(); await tique();
  assert.match(texto(tela.render()), /reclamação, a conversa iria para a equipe/);
});

test('composição: a caixa usa a porta da fila em modo sem efeito, e a rota "testar" passa exatamente essa porta', async () => {
  const z = (await import('zod')).z;
  // modelo.ts (composition root): mesma porta da fila (sinais do JEV, direito ao modelo), com semEfeito ligado.
  const chamadas: { entender: unknown; opcoes: Record<string, unknown> }[] = [];
  const direitoModeloAtendimento = async () => true;
  const modelo = carregarComponente('app/api/admin/inteligencia/whatsapp/modelo.ts', {
    'node:crypto': { randomUUID: () => 'u' }, '@/lib/db/postgres': {}, '@/lib/ia-persistencia/uso': {}, '@/lib/inteligencia/modelos/orcamento.ts': {},
    '@/lib/inteligencia/modelos/precos.ts': {}, '@/lib/inteligencia/modelos/roteador.ts': {}, '@/lib/whatsapp/atendimento/core': {},
    '@/lib/inteligencia/flags': { inteligenciaAtiva: () => false }, '@/lib/whatsapp/atendimento/worker': {}, '@/lib/whatsapp/atendimento/meta': {},
    '@/lib/whatsapp/atendimento/walle/porta': { criarPortaWallE: (entender: unknown, opcoes: Record<string, unknown>) => { chamadas.push({ entender, opcoes }); return { porta: 'teste' }; }, direitoModeloAtendimento },
    '@/lib/inteligencia/jev/motor': { triagemMensagem: () => ({ intent: 'OUTRO', reasonCodes: [] }) },
  }).modulo as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(modelo.portaTesteWallE({}), { porta: 'teste' });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].entender, null, 'chave-mestra desligada: só regras');
  assert.deepEqual(Object.keys(chamadas[0].opcoes).sort(), ['direitoModelo', 'semEfeito', 'sinais']);
  assert.equal(chamadas[0].opcoes.semEfeito, true);
  assert.equal(chamadas[0].opcoes.sinais, modelo.sinaisJev);
  assert.equal(chamadas[0].opcoes.direitoModelo, direitoModeloAtendimento);

  // route.ts: "testar" chama testarWallE com a sessão, o texto aparado e a porta de teste; nada do controle da fila.
  const portaTeste = { porta: 'teste' }, sessao = { usuario: 'u1' };
  const testes: unknown[][] = [], proibidas: string[] = [];
  const proibida = (nome: string) => async () => { proibidas.push(nome); throw new Error(nome); };
  const rota = carregarComponente('app/api/admin/atendimento/route.ts', {
    'next/server': { NextResponse: { json: (corpo: unknown, init: { status: number }) => ({ corpo, status: init.status }) } }, zod: { z },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => sessao },
    '@/lib/clientes/services/errors': { isClienteServiceError: () => false }, '@/lib/comercial/pacotes-admin': { PacoteAdminError: class {} },
    '@/lib/whatsapp/atendimento/service': { listarAtendimento: proibida('listar'), controlarAtendimento: proibida('controlar'), salvarConfiguracao: proibida('configurar') },
    '@/lib/whatsapp/atendimento/erros': { respostaDeErroAtendimento: () => ({ corpo: { ok: false }, status: 500 }) },
    '@/app/api/admin/inteligencia/whatsapp/modelo': { estadoIaAtendimento: () => ({ ia: true }), portaTesteWallE: () => portaTeste },
    '@/lib/whatsapp/atendimento/walle/resumo': { estadoWallE: proibida('estado') }, '@/lib/whatsapp/atendimento/walle/sugestao': { sugerirResposta: proibida('sugerir') },
    '@/lib/whatsapp/atendimento/walle/teste': { LIMITE_TEXTO_TESTE: 1000, testarWallE: async (...a: unknown[]) => { testes.push(a); return { desfecho: 'RESPONDE' }; } },
  }).modulo as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const post = (corpo: unknown) => rota.POST({ json: async () => corpo });
  assert.deepEqual(await post({ acao: 'testar', texto: '  quanto custa?  ' }), { corpo: { ok: true, data: { desfecho: 'RESPONDE' } }, status: 200 });
  assert.equal(testes.length, 1);
  assert.equal(testes[0][0], sessao); assert.equal(testes[0][1], 'quanto custa?'); assert.equal(testes[0][2], portaTeste);
  // Campo a mais, texto vazio ou longo demais: recusa sem testar.
  for (const corpo of [{ acao: 'testar', texto: 'oi', conversaId: '00000000-0000-4000-8000-000000000000' }, { acao: 'testar', texto: '   ' }, { acao: 'testar', texto: 'x'.repeat(1001) }]) {
    assert.equal((await post(corpo)).status, 400);
  }
  assert.equal(testes.length, 1);
  assert.deepEqual(proibidas, []);
});
