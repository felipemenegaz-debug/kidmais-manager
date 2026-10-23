import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as utils from './horario.utils.ts';

/**
 * Pareceres do Astra (22/10/2026), pelo serviço completo (repositórios simulados, sem banco):
 * - P3: a duração aceita é usada como veio — sem o teto de 23 h; a que não cabe no dia não gera candidatos;
 * - P2: na criação, o horário livre segue a duração do pacote vigente da empresa (wizard administrativo pela rota da
 *   agenda, preparação da IA pela porta da composição e a revalidação na gravação); o modo fixo não muda.
 */
import { EMPRESA, ESCOPO, bloqueio, minutos, servico, transpilar } from './duracao-pacote-livre.test-apoio.ts';


test('P3: serviço completo preserva 1410 e 1439 min (sem teto de 23 h); 1440 não cabe e não gera candidato', async () => {
  const { m, tx } = servico('LIVRE', null);
  for (const d of [1410, 1439]) {
    const [periodo] = (await m.consultarDisponibilidadeData('2026-11-20', tx, undefined, ESCOPO, { duracaoMinutos: d })).periodos;
    assert.ok(periodo.horarios.length > 0, String(d));
    assert.ok(periodo.horarios.every((h) => minutos(h.fim) - minutos(h.inicio) === d), String(d));
  }
  const [festaLonga] = (await m.consultarDisponibilidadeData('2026-11-20', tx, undefined, ESCOPO, { duracaoMinutos: 1410 })).periodos;
  assert.deepEqual(festaLonga.horarios.map((h) => `${h.inicio}–${h.fim}`), ['00:00–23:30']);
  const [naoCabe] = (await m.consultarDisponibilidadeData('2026-11-20', tx, undefined, ESCOPO, { duracaoMinutos: 1440 })).periodos;
  assert.equal(naoCabe.horarios.length, 0);
});

test('limite único: rotas e pacote aceitam 5–1439 min inteiros; o resto vira null', () => {
  for (const ok of [5, 180, 1439, '180']) assert.equal(utils.duracaoAceita(ok), Number(ok));
  for (const ruim of [0, 4, 1440, 90.5, 'abc', '', null, undefined, NaN]) assert.equal(utils.duracaoAceita(ruim), null, String(ruim));
});

test('P2 gravação: pacote de 3 h no horário livre aceita 15h–18h e recusa 15h–19h; pacote sem duração segue o intervalo', async () => {
  const pedido = (inicio: string, fim: string) => ({ data: '2026-11-20', configuracaoId: 'livre', inicio, fim, ajusteMinutos: minutos(inicio), pacoteCodigo: 'COMPACTA' });
  const tres = servico('LIVRE', 180, [bloqueio('18:00', '19:00')]);
  assert.equal((await tres.m.revalidarHorarioSelecionado(pedido('15:00', '18:00'), tres.tx, ESCOPO)).candidato.fim, '18:00');
  assert.deepEqual(tres.pacotes[0], [EMPRESA, 'COMPACTA']);
  const semBloqueio = servico('LIVRE', 180);
  await assert.rejects(semBloqueio.m.revalidarHorarioSelecionado(pedido('15:00', '19:00'), semBloqueio.tx, ESCOPO), /não está mais disponível/);
  const semDuracao = servico('LIVRE', null);
  assert.equal((await semDuracao.m.revalidarHorarioSelecionado(pedido('15:00', '19:00'), semDuracao.tx, ESCOPO)).candidato.fim, '19:00');
});

test('modo fixo: a duração do pacote não muda o horário configurado 15h–19h', async () => {
  const { m, tx } = servico('FIXO', 180);
  const r = await m.revalidarHorarioSelecionado({ data: '2026-11-20', configuracaoId: 'tarde', inicio: '15:00', fim: '19:00', ajusteMinutos: 0, pacoteCodigo: 'COMPACTA' }, tx, ESCOPO);
  assert.equal(r.candidato.fim, '19:00');
});

test('P2 wizard administrativo: a rota da agenda usa a duração do pacote da empresa comprovada; ?duracao= prevalece', async () => {
  const { m, tx } = servico('LIVRE', 180, [bloqueio('18:00', '19:00')]);
  const rota = transpilar('app/api/admin/disponibilidade/route.ts', {
    'next/server': { NextResponse: { json: (b: unknown, i?: ResponseInit) => Response.json(b, i) } },
    zod: { z }, path: { default: path }, fs: nodeFs,
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u' }) },
    '@/lib/http/api-response': { apiErrorResponse: (e: Error) => Response.json({ erro: e.message }, { status: 500 }) },
    '@/lib/saas/provar-tenant': { withTenantTransaction: async (_s: unknown, _e: unknown, fn: (t: unknown, tenant: object) => unknown) => fn(tx, { empresaComprovada: EMPRESA }) },
    '@/lib/disponibilidade/escopo': { escopoDaEmpresa: async () => ESCOPO, agendaPorEscopoInstalada: async () => false, unidadesDaEmpresa: async () => [] },
    '@/lib/disponibilidade/services': { ...m, duracaoAceita: utils.duracaoAceita },
    '@/lib/fechamentos/comercial-input': { PACOTE_CODIGO_BANCO: { compacta: 'COMPACTA' } },
    '@/lib/disponibilidade/config-legada': { ehDonaDaConfigLegada: async () => false, exigirDonaDaConfigLegada: async () => {} },
  }, false) as { GET: (r: object) => Promise<Response> };
  const get = async (q: string) => (await (await rota.GET({ nextUrl: new URL(`https://x.invalid/api/admin/disponibilidade?${q}`) })).json()) as { dias: Array<{ periodos: Array<{ horarios: Array<{ inicio: string; fim: string; status: string }> }> }> };
  const pacote = await get('data=2026-11-20&pacote=compacta');
  assert.deepEqual(pacote.dias[0].periodos[0].horarios.find((h) => h.inicio === '15:00'), { inicio: '15:00', fim: '18:00', ajusteMinutos: 900, status: 'DISPONIVEL' });
  const explicita = await get('data=2026-11-20&pacote=compacta&duracao=240');
  assert.equal(explicita.dias[0].periodos[0].horarios.find((h) => h.inicio === '15:00')?.fim, '19:00');
  const fonte = readFileSync('components/admin/FechamentoAdminWizard.tsx', 'utf8');
  assert.match(fonte, /agendaAdmin\(\{ data, pacote \}\)/);
  assert.match(fonte, /agendaAdmin\(\{ inicio, fim, pacote: form\.pacote \}\)/);
  assert.match(fonte, /aplicada\.horarioDesejado, aplicada\.form\.pacote\)/);
  assert.match(fonte, /onChange=\{e => \{[^}]*limparAgenda\(\); campo\('pacote'/, 'trocar o pacote limpa a agenda e exige nova consulta');
});

test('P2 preparação da IA: a porta de horários consulta com a duração do pacote', async () => {
  const { m, tx } = servico('LIVRE', 180, [bloqueio('18:00', '19:00')]);
  const composicao = transpilar('app/api/admin/inteligencia/operacoes/composicao.ts', {
    '@/lib/disponibilidade/services': { ...m, periodoDoTurno: (periodos: unknown[]) => periodos[0] },
    '@/lib/disponibilidade/escopo': { escopoDaEmpresa: async () => ESCOPO },
  }, false) as { portaContratacao: { horarios: (tx: unknown, e: string, d: string, t: string, p?: string) => Promise<{ horarios: Array<{ inicio: string; fim: string }> } | null> } };
  const agenda = await composicao.portaContratacao.horarios(tx, EMPRESA, '2026-11-20', 'noite', 'COMPACTA');
  assert.ok(agenda?.horarios.some((h) => h.inicio === '15:00' && h.fim === '18:00'));
  assert.ok(agenda?.horarios.every((h) => minutos(h.fim) - minutos(h.inicio) === 180));
  const chamadas = ['lib/inteligencia/acoes/contratacao.ts', 'lib/inteligencia/acoes/contratacao-revisao.ts'].map((f) => readFileSync(f, 'utf8'));
  assert.match(chamadas[0], /porta\.horarios\(tx, empresaId, p\.data, p\.turno, CODIGO_BANCO\[p\.pacote\]\)/);
  assert.match(chamadas[1], /porta\.horarios\(tx, ctx\.empresaId, payload\.data, payload\.turno, CODIGO_BANCO\[payload\.pacote\]\)/);
});

// Parecer do Astra (delta 5): P2-1 calendário público / entrada sem pacote; P2-2 duração cadastrada fora do limite.
const pedidoLivre = (inicio: string, fim: string) => ({ data: '2026-11-20', configuracaoId: 'livre', inicio, fim, ajusteMinutos: minutos(inicio), pacoteCodigo: 'COMPACTA' });

test('P2-2: duração cadastrada fora do limite é recusada explicitamente (nunca vira 4 h); ausente continua null', async () => {
  for (const ruim of [1440, 3, 2000]) {
    const { m, tx } = servico('LIVRE', ruim);
    await assert.rejects(m.duracaoDoPacoteDaEmpresa(tx, EMPRESA, 'COMPACTA'), (e: { code?: string; message: string }) => e.code === 'PACOTE_DURACAO_INVALIDA' && e.message.includes(`${ruim} min`));
    await assert.rejects(m.revalidarHorarioSelecionado(pedidoLivre('15:00', '19:00'), tx, ESCOPO), (e: { code?: string }) => e.code === 'PACOTE_DURACAO_INVALIDA', String(ruim));
  }
  const ausente = servico('LIVRE', null);
  assert.equal(await ausente.m.duracaoDoPacoteDaEmpresa(ausente.tx, EMPRESA, 'COMPACTA'), null);
});

test('P2-1: sem duração informada, o horário livre usa o pacote mais curto da empresa (não 4 h universais)', async () => {
  const curto = servico('LIVRE', null, [bloqueio('18:00', '19:00')], 180);
  const [periodo] = (await curto.m.consultarDisponibilidadeData('2026-11-20', curto.tx, undefined, ESCOPO)).periodos;
  assert.deepEqual(periodo.horarios.find((h) => h.inicio === '15:00'), { inicio: '15:00', fim: '18:00', ajusteMinutos: 900, status: 'DISPONIVEL' });
  assert.deepEqual(curto.menores[0], [EMPRESA, 5, 1439]);
  const nenhum = servico('LIVRE', null, [], null);
  const [padrao] = (await nenhum.m.consultarDisponibilidadeData('2026-11-20', nenhum.tx, undefined, ESCOPO)).periodos;
  assert.equal(padrao.horarios.find((h) => h.inicio === '15:00')?.fim, '19:00', 'sem pacote com duração: 4 h');
  const informada = servico('LIVRE', null, [], 180);
  await informada.m.consultarDisponibilidadeData('2026-11-20', informada.tx, undefined, ESCOPO, { duracaoMinutos: 300 });
  assert.equal(informada.menores.length, 0, 'duração informada prevalece');
  const fixo = servico('FIXO', null, [], 180);
  await fixo.m.consultarDisponibilidadeData('2026-11-20', fixo.tx, undefined, ESCOPO);
  assert.equal(fixo.menores.length, 0, 'modo fixo não consulta pacotes');
});

test('P2-1: calendário público consulta com a duração do pacote escolhido; o wizard passa a do pacote', async () => {
  const urls: string[] = [];
  const cal = transpilar('components/fechamento/CalendarioDisponibilidade.tsx', {
    '../../lib/fechamentos/rota-publica': { apiPublica: (u: string) => u },
  }, false) as { consultaPublica: (i: string, f: string, e: string | null, d?: number | null) => Promise<unknown> };
  const fetchAntes = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { urls.push(u); return Response.json({ data: [] }); }) as typeof fetch;
  try {
    await cal.consultaPublica('2026-11-01', '2026-11-30', null, 180);
    await cal.consultaPublica('2026-11-01', '2026-11-30', null, null);
  } finally { globalThis.fetch = fetchAntes; }
  assert.equal(urls[0], '/api/disponibilidade?inicio=2026-11-01&fim=2026-11-30&duracao=180');
  assert.equal(urls[1], '/api/disponibilidade?inicio=2026-11-01&fim=2026-11-30');
  const calendario = readFileSync('components/fechamento/CalendarioDisponibilidade.tsx', 'utf8');
  assert.match(calendario, /consultaPublica\(inicio, fim, empresa, duracaoMinutos\)\), \[consultar, empresa, duracaoMinutos\]\)/, 'muda a duração → recarrega o mês');
  assert.match(readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8'), /duracaoMinutos=\{fato\?\.duracaoMinutos \?\? null\}/);
});

test('P2-2: cadastro (tela, rotas, serviço e IA) segue o limite único 5–1439', async () => {
  const { juntarDuracao } = await import('../../comercial/duracao.ts');
  assert.equal(juntarDuracao('23', '59'), 1439);
  assert.equal(juntarDuracao('0', '05'), 5);
  for (const [h, m] of [['24', '00'], ['0', '04'], ['23', '60']]) assert.throws(() => juntarDuracao(h, m), /entre 5min e 23h59/);
  for (const f of ['app/api/admin/configuracoes/pacotes/route.ts', 'app/api/admin/configuracoes/pacotes/[id]/route.ts', 'lib/inteligencia/acoes/pacotes.ts']) {
    const fonte = readFileSync(f, 'utf8');
    assert.doesNotMatch(fonte, /max\(1440\)/, f);
    assert.match(fonte, /min\(DURACAO_MINIMA_MINUTOS\)\.max\(DURACAO_MAXIMA_MINUTOS\)/, f);
  }
  assert.match(readFileSync('lib/comercial/pacote-comercial.ts', 'utf8'), /duracaoAceita\(input\.duracaoMinutos\) === null/);
});

// Parecer do Astra (delta 6): Wall-e com pacote escolhido; IA com duração inválida; gravações centrais de pacote.
test('Wall-e: com pacote de 4 h e só 15h–18h livre, não há horário; o pacote de 3 h tem — a fonte usa a duração do pacote', async () => {
  const dia = [bloqueio('00:00', '15:00'), bloqueio('18:00', '23:59')];
  const longo = servico('LIVRE', 240, dia, 180);
  const curto = servico('LIVRE', 180, dia, 180);
  const livres = async (s: ReturnType<typeof servico>) => {
    const opcoes: unknown[] = [];
    const fontes = transpilar('lib/whatsapp/atendimento/walle/fontes-postgres.ts', {
      '../../../disponibilidade/services/availability.service.ts': {
        duracaoDoPacoteDaEmpresa: s.m.duracaoDoPacoteDaEmpresa,
        consultarDisponibilidadePeriodo: async (i: string, fim: string, tx: unknown, ex: unknown, esc: unknown, op: unknown) => {
          opcoes.push(op);
          return [await s.m.consultarDisponibilidadeData(i, s.tx, undefined, ESCOPO, op)].map((d) => ({ ...d, data: i }));
        },
      },
      '../../../disponibilidade/escopo.ts': { agendaPorEscopoInstalada: async () => false, unidadesDaEmpresa: async () => [] },
    }, false) as { fontesPostgres: (ex: unknown, alvo: object) => { disponibilidade: (d: string, u: string | null, p?: string | null) => Promise<{ periodos: Array<{ disponivel: boolean }> }>; alternativas: (d: string, u: string | null, t: string | null, q: number, p?: string | null) => Promise<unknown[]> } };
    const f = fontes.fontesPostgres(s.tx, { empresaId: EMPRESA, ambiente: 'teste', hoje: '2026-11-01', linkContratoProprio: async () => null });
    const r = await f.disponibilidade('2026-11-20', null, 'PREMIUM');
    await f.alternativas('2026-11-20', null, null, 3, 'PREMIUM');
    return { livre: r.periodos.some((p) => p.disponivel), opcoes };
  };
  const quatro = await livres(longo);
  assert.equal(quatro.livre, false, 'pacote de 4 h: nenhum horário cabe em 15h–18h');
  assert.deepEqual(quatro.opcoes, [{ duracaoMinutos: 240 }, { duracaoMinutos: 240 }], 'agenda e alternativas com a duração do pacote');
  assert.equal((await livres(curto)).livre, true);
});

test('gravações centrais de pacote recusam duração fora do limite antes de escrever (duplicação, edição, revisão, criação)', async () => {
  const admin = await import('../../comercial/pacotes-admin.ts');
  const escritas: string[] = [];
  const linha = { id: 'p1', empresa_id: EMPRESA, codigo: 'X', nome: 'Festa', descricao: null, duracao_minutos: 1440, convidados_minimos: null, convidados_maximos: null, ativo: true, vigente: true, arquivado_em: null, revisao_anterior_id: null, utilizado: false };
  const tx = { query: async (sql: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) escritas.push(sql.trim().slice(0, 30));
    return { rows: [linha], rowCount: 1 };
  } };
  const ctx = { empresaId: EMPRESA, usuarioId: 'u', requestId: 'r', motivo: 'Correção' };
  const invalida = (e: { code?: string; message: string }) => e.code === 'DURACAO_INVALIDA' && e.message.includes('1440 min');
  await assert.rejects(admin.duplicarPacoteAdmin(tx as never, 'p1', undefined, ctx), invalida);
  const dados = { nome: 'Festa', descricao: null, duracaoMinutos: 1440 };
  await assert.rejects(admin.criarPacoteAdmin(tx as never, { empresaId: EMPRESA, ...dados }, ctx), invalida);
  await assert.rejects(admin.editarPacoteNaoUtilizado(tx as never, 'p1', dados, ctx), invalida);
  await assert.rejects(admin.criarRevisaoPacoteAdmin(tx as never, 'p1', dados, ctx), invalida);
  await assert.rejects(admin.promoverRevisaoPacoteAdmin(tx as never, 'p1', 'p2', dados, ctx), invalida);
  assert.deepEqual(escritas, [], 'nada é escrito');
  // A importação de tabela grava pelas mesmas funções (revisão/edição).
  const importacao = readFileSync('lib/comercial/importacao-tabela/servico.ts', 'utf8');
  assert.match(importacao, /if \(a\.usado\) await criarRevisaoPacoteAdmin\(tx, a\.id, dados, contexto\);\s*else await editarPacoteNaoUtilizado\(tx, a\.id, dados, contexto\);/);
});
