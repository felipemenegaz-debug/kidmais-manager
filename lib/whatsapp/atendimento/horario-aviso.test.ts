import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuracaoSchema, ehEncaminhamentoFixo, fonteEncaminhamento, MENSAGEM_ENCAMINHAMENTO, mensagemEncaminhamento } from './core.ts';
import { avisoEquipeSchema, horaFalada, horarioEquipeSchema, momentoLocal, retornoForaDoHorario, situacaoHorario, type HorarioEquipe } from './horario.ts';
import { chaveDoAviso, contextoNaFila, MAX_TENTATIVAS, marcaNaFila, mensagemAvisoEquipe, planoDoAviso, REPETIR_APOS_MINUTOS, seloAguardandoEquipe } from './aviso-equipe.ts';
import { createHash } from 'node:crypto';

// 25/11/2026 é quarta-feira. São Paulo = UTC-3 (sem horário de verão).
const util = { inicio: '09:00', fim: '18:00' };
const semana: HorarioEquipe = { seg: util, ter: util, qua: util, qui: util, sex: util };
const sp = (local: string) => new Date(local + '-03:00');

test('momento local em São Paulo: virada do dia à meia-noite local, não à meia-noite UTC', () => {
  assert.deepEqual(momentoLocal(new Date('2026-11-26T02:59:00.000Z')), { dia: 'qua', minuto: 23 * 60 + 59 });
  assert.deepEqual(momentoLocal(new Date('2026-11-26T03:00:00.000Z')), { dia: 'qui', minuto: 0 });
  assert.equal(horaFalada('09:00'), '9h');
  assert.equal(horaFalada('13:30'), '13h30');
});

test('situação do horário: dentro, antes de abrir, depois de fechar, fim de semana, dia único e fim exclusivo', () => {
  assert.deepEqual(situacaoHorario(undefined, sp('2026-11-25T03:00:00')), { configurado: false });
  assert.deepEqual(situacaoHorario({}, sp('2026-11-25T03:00:00')), { configurado: false }, 'nenhum dia: como não configurado');
  assert.deepEqual(situacaoHorario(semana, sp('2026-11-25T09:00:00')), { configurado: true, dentro: true }, 'início inclusivo');
  assert.deepEqual(situacaoHorario(semana, sp('2026-11-25T17:59:00')), { configurado: true, dentro: true });
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-25T12:00:00')), '');
  assert.equal(retornoForaDoHorario(undefined, sp('2026-11-25T23:00:00')), '');
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-25T07:00:00')), 'Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na quarta-feira a partir das 9h.');
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-25T18:00:00')), 'Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na quinta-feira a partir das 9h.', 'fim exclusivo');
  // Astra r3 (P2): composta na quarta 23:59 local (UTC já é quinta 02:59) e enviada na quinta 00:01: a mesma frase continua
  // certa nos dois relógios, porque diz o dia da semana e nunca "hoje"/"amanhã".
  const composta = retornoForaDoHorario(semana, new Date('2026-11-26T02:59:00.000Z'));
  assert.match(composta, /na quinta-feira a partir das 9h\.$/);
  assert.equal(retornoForaDoHorario(semana, new Date('2026-11-26T03:01:00.000Z')), composta, 'depois da meia-noite, o mesmo dia');
  for (const t of ['2026-11-25T07:00:00', '2026-11-25T18:00:00', '2026-11-29T23:00:00', '2026-11-30T00:30:00']) assert.doesNotMatch(retornoForaDoHorario(semana, sp(t)), /hoje|amanhã/, t);
  // Sexta à noite, sábado e domingo: segunda (domingo 23:59 e segunda 00:01 dizem a mesma coisa).
  for (const t of ['2026-11-27T19:00:00', '2026-11-28T10:00:00']) assert.match(retornoForaDoHorario(semana, sp(t)), /na segunda-feira a partir das 9h\.$/, t);
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-29T23:59:00')), retornoForaDoHorario(semana, sp('2026-11-30T00:01:00')));
  assert.match(retornoForaDoHorario(semana, sp('2026-11-29T23:00:00')), /na segunda-feira a partir das 9h\.$/);
  assert.match(retornoForaDoHorario({ ...semana, sab: { inicio: '10:00', fim: '14:00' } }, sp('2026-11-27T19:00:00')), /no sábado a partir das 10h\.$/);
  // Só um dia na semana e ele já passou: a próxima ocorrência é daqui a 7 dias.
  assert.match(retornoForaDoHorario({ qua: { inicio: '13:30', fim: '17:00' } }, sp('2026-11-25T18:00:00')), /na próxima quarta-feira a partir das 13h30\.$/);
  assert.match(retornoForaDoHorario({ sab: { inicio: '09:00', fim: '12:00' } }, sp('2026-11-28T13:00:00')), /no próximo sábado a partir das 9h\.$/);
  assert.match(retornoForaDoHorario({ qua: { inicio: '13:30', fim: '17:00' } }, sp('2026-11-25T08:00:00')), /na quarta-feira a partir das 13h30\.$/);
  // Dia marcado como sem atendimento (null) conta como fechado.
  assert.match(retornoForaDoHorario({ ...semana, qui: null }, sp('2026-11-25T20:00:00')), /na sexta-feira a partir das 9h\.$/);
});

test('esquemas: configuração antiga continua válida; faixas e e-mails validados', () => {
  const antiga = configuracaoSchema.parse({ ativo: true, nome: 'Atendimento', perguntas: [], wallE: { ativo: true } });
  assert.equal(antiga.horarioEquipe, undefined);
  assert.equal(antiga.avisoEquipe, undefined);
  assert.equal(horarioEquipeSchema.safeParse({ seg: { inicio: '18:00', fim: '09:00' } }).success, false, 'início depois do fim');
  assert.equal(horarioEquipeSchema.safeParse({ seg: { inicio: '09:00', fim: '09:00' } }).success, false, 'faixa vazia');
  assert.equal(horarioEquipeSchema.safeParse({ seg: { inicio: '9:00', fim: '18:00' } }).success, false, 'formato HH:MM');
  assert.equal(horarioEquipeSchema.safeParse({ seg: { inicio: '24:00', fim: '25:00' } }).success, false);
  assert.equal(horarioEquipeSchema.safeParse({ segunda: util }).success, false, 'dia desconhecido');
  assert.equal(horarioEquipeSchema.safeParse({ seg: null, dom: util }).success, true);
  assert.deepEqual(avisoEquipeSchema.parse({ emails: ['  Ana@Buffet.com.br '] }).emails, ['ana@buffet.com.br']);
  assert.equal(avisoEquipeSchema.safeParse({ emails: ['a@b.co', 'A@B.co'] }).success, false, 'repetido depois de minúsculas');
  assert.equal(avisoEquipeSchema.safeParse({ emails: ['não é e-mail'] }).success, false);
  assert.equal(avisoEquipeSchema.safeParse({ emails: ['a@b.co', 'b@b.co', 'c@b.co', 'd@b.co', 'e@b.co', 'f@b.co'] }).success, false, 'no máximo 5');
  assert.equal(avisoEquipeSchema.safeParse({ emails: [], extra: 1 }).success, false, 'estrito');
});

test('e-mail de aviso: motivo e link, nunca texto do cliente; HTML escapado; chave aceita pela porta de e-mail', () => {
  const empresa = '11111111-1111-4111-8111-111111111111', conversa = '22222222-2222-4222-8222-222222222222';
  const idem = chaveDoAviso(empresa, conversa, 'abc-123', 'ana@buffet.com.br');
  assert.match(idem, /^[A-Za-z0-9_:/-]{1,200}$/);
  assert.doesNotMatch(idem, /ana|buffet/, 'o e-mail do destinatário entra só como hash');
  assert.notEqual(idem, chaveDoAviso(empresa, conversa, 'abc-123', 'bia@buffet.com.br'));
  const m = mensagemAvisoEquipe({ para: 'ana@buffet.com.br', empresaNome: 'Buffet <Alegria> & Cia', motivos: ['CONTRATACAO', 'RECLAMACAO'], link: 'https://painel.exemplo/admin/atendimento?conversa=x&y=1', idempotencia: idem });
  assert.equal(m.idempotencia, idem);
  assert.match(m.html ?? '', /Buffet &lt;Alegria&gt; &amp; Cia/);
  assert.doesNotMatch(m.html ?? '', /<Alegria>/);
  assert.match(m.html ?? '', /conversa=x&amp;y=1/);
  assert.match(m.texto, /Motivos:/);
  assert.match(m.texto, /https:\/\/painel\.exemplo\/admin\/atendimento\?conversa=x&y=1/);
  assert.match(m.texto, /não traz mensagens nem dados do cliente/);
  const generico = mensagemAvisoEquipe({ para: 'ana@buffet.com.br', empresaNome: 'X', motivos: [], link: 'https://p/x', idempotencia: idem });
  assert.match(generico.texto, /Motivo:\n- A conversa aguarda a equipe\./);
  // Não existe campo para mensagem do cliente (ultimaMensagem fica de fora por construção).
  assert.deepEqual(Object.keys(m).sort(), ['assunto', 'html', 'idempotencia', 'para', 'texto']);
});

test('marca do aviso nasce na transição para a fila (Astra r2, P2): SQL da marca e dos motivos', () => {
  const sql = contextoNaFila('contexto', "'AGUARDANDO_HUMANO'", '$2::jsonb');
  // Só quando a conversa ENTRA na fila (o estado antigo, lido pelo UPDATE, não era AGUARDANDO_HUMANO).
  assert.match(sql, /estado IS DISTINCT FROM 'AGUARDANDO_HUMANO'/);
  assert.match(sql, /'estado','PENDENTE'/);
  assert.match(sql, /'motivos',\(CASE WHEN jsonb_typeof\(\(\$2::jsonb\)->'motivos'\)='array'/);
  // Passagem reescrita antes do 1º envio atualiza os motivos; passagem nula não apaga.
  assert.match(sql, /WHEN \(\$2::jsonb\) IS NOT NULL AND .*'PENDENTE' THEN jsonb_set/);
  assert.match(sql, /ELSE contexto END$/);
  // Sem passagem no comando: motivos vazios (e-mail com motivo genérico), sem o 2º ramo.
  const sem = contextoNaFila();
  assert.match(sem, /'motivos','\[\]'::jsonb/);
  assert.doesNotMatch(sem, /jsonb_set/);
  assert.equal(marcaNaFila(false), '', 'sem a 082 não há onde gravar');
  assert.ok(marcaNaFila(true, '$3::text').startsWith(",contexto=CASE WHEN ($3::text)='AGUARDANDO_HUMANO'"));
});

test('tentativas por destinatário (Astra r2, P2): quem falha sempre não impede o próximo', () => {
  const agora = new Date('2026-11-25T15:00:00.000Z');
  const r = (e: string) => createHash('sha256').update(e).digest('hex').slice(0, 16);
  const em = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();
  const [a, b] = ['a@buffet.test', 'b@buffet.test'];
  // A tentou 1x agora há pouco: B (nunca tentado) é chamado; A espera o intervalo.
  let p = planoDoAviso([a, b], [], { [r(a)]: { n: 1, em: em(1) } }, agora);
  assert.deepEqual(p.prontos, [b]);
  // Os dois liberados: o menos tentado primeiro.
  p = planoDoAviso([a, b], [], { [r(a)]: { n: 2, em: em(REPETIR_APOS_MINUTOS) }, [r(b)]: { n: 1, em: em(REPETIR_APOS_MINUTOS) } }, agora);
  assert.deepEqual(p.prontos, [b, a]);
  // A esgotou; B ainda tem tentativa: FALHOU (segue tentando B), nunca ESGOTADO.
  p = planoDoAviso([a, b], [], { [r(a)]: { n: MAX_TENTATIVAS, em: em(60) } }, agora);
  assert.deepEqual(p.prontos, [b]);
  p = planoDoAviso([a, b], [], { [r(a)]: { n: MAX_TENTATIVAS, em: em(60) }, [r(b)]: { n: 1, em: em(1) } }, agora);
  assert.deepEqual(p.prontos, []);
  assert.equal(p.semEnvio, 'FALHOU');
  p = planoDoAviso([a, b], [r(b)], { [r(a)]: { n: MAX_TENTATIVAS, em: em(60) } }, agora);
  assert.equal(p.semEnvio, 'ESGOTADO');
  assert.equal(planoDoAviso([a, b], [r(a), r(b)], {}, agora).semEnvio, 'ENVIADO');
  assert.equal(planoDoAviso([], [], {}, agora).semEnvio, 'SEM_DESTINATARIO');
});

test('encaminhamento de contingência: frase de horário fora do expediente, texto antigo sem horário (Astra r1, P2)', () => {
  assert.equal(mensagemEncaminhamento(undefined, sp('2026-11-25T23:00:00')), MENSAGEM_ENCAMINHAMENTO, 'sem horário: igual a antes');
  assert.equal(mensagemEncaminhamento(semana, sp('2026-11-25T10:00:00')), MENSAGEM_ENCAMINHAMENTO, 'dentro do horário: igual a antes');
  const fora = mensagemEncaminhamento(semana, sp('2026-11-25T23:00:00'));
  assert.equal(fora, 'Não consigo responder automaticamente agora. Encaminhei sua mensagem para a equipe. ' + retornoForaDoHorario(semana, sp('2026-11-25T23:00:00')));
  assert.match(fora, /fora do horário de atendimento: a equipe responde na quinta-feira a partir das 9h.$/);
  const sabado = mensagemEncaminhamento(semana, sp('2026-11-28T10:00:00'));
  assert.notEqual(sabado, MENSAGEM_ENCAMINHAMENTO);
  // Todos os textos fixos continuam isentos da revogação por configuração no envio; textos do modelo não.
  // Astra r2 (P2): a isenção vem da origem gravada na saída, não do texto.
  const origem = JSON.parse(fonteEncaminhamento());
  for (const t of [MENSAGEM_ENCAMINHAMENTO, fora, sabado]) assert.ok(ehEncaminhamentoFixo({ texto: t, fonte: origem }), t);
  // FAQ/Wall-e com exatamente o mesmo texto: não isenta.
  for (const t of [MENSAGEM_ENCAMINHAMENTO, fora]) {
    assert.ok(!ehEncaminhamentoFixo({ texto: t, fonte: { tipo: 'WALLE', fontes: [{ tipo: 'PRONTA', id: 'x', versao: 1 }] } }), 'Wall-e com o mesmo texto');
    assert.ok(!ehEncaminhamentoFixo({ texto: t, fonte: { tipo: 'PRONTA', id: 'x', versao: 1, por: 'ATENDENTE' } }), 'pronta com o mesmo texto');
    assert.ok(!ehEncaminhamentoFixo({ texto: t, fonte: { origem: 'ENCAMINHAMENTO_FIXO', tipo: 'WALLE' } }), 'origem misturada');
  }
  // Astra r3 (P2): sem origem gravada (FAQ da fase B, base sem a 082, linha antiga) não há isenção, nem com o texto exato.
  for (const t of [MENSAGEM_ENCAMINHAMENTO, fora, sabado, 'Oi! Encaminhei sua mensagem para a equipe.', null, undefined]) {
    assert.ok(!ehEncaminhamentoFixo({ texto: t }), String(t));
    assert.ok(!ehEncaminhamentoFixo({ texto: t, fonte: null }), String(t));
  }
});

test('selo do menu: ambiente inválido ou banco fora dão 0, sem derrubar a sessão (Astra r1, P1)', async () => {
  const banco = (n: number) => ({ query: async () => ({ rows: [{ n }] }) }) as never;
  assert.equal(await seloAguardandoEquipe(banco(3), 'e', () => 'staging'), 3);
  assert.equal(await seloAguardandoEquipe(banco(3), 'e', () => { throw new Error('KIDMAIS_DEPLOY_ENV ausente'); }), 0, 'ambiente lança de forma síncrona');
  assert.equal(await seloAguardandoEquipe({ query: async () => { throw new Error('42P01'); } } as never, 'e', () => 'staging'), 0, 'banco falha');
});

// Fatia 9 (Astra r4 da fatia 8, P-F8-2 e P-F8-4), relógio fixo.
test('P-F8-2: passagens da fase B (pedido de atendente e interesse completo) usam o horário vigente', async () => {
  const { responder } = await import('./core.ts');
  const humano = { intencao: 'HUMANO' as const, perguntaId: null, data: null, convidados: null };
  const interesse = { intencao: 'INTERESSE' as const, perguntaId: null, data: '2027-03-10', convidados: 50 };
  const cfg = (horarioEquipe?: HorarioEquipe) => configuracaoSchema.parse({ ativo: true, nome: 'Buffet', perguntas: [], horarioEquipe });
  const domingo = sp('2026-11-29T10:00:00');
  const ANTIGO = 'Vou encaminhar seu pedido para um atendente. A resposta dependerá do horário da equipe.';
  assert.equal(responder(cfg({ seg: util }), humano, { data: null, convidados: null }, '2026-11-29', domingo).texto,
    'Vou encaminhar seu pedido para um atendente. Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na segunda-feira a partir das 9h.');
  assert.equal(responder(cfg(), humano, { data: null, convidados: null }, '2026-11-29', domingo).texto, ANTIGO, 'sem horário: texto antigo');
  assert.equal(responder(cfg({ dom: util }), humano, { data: null, convidados: null }, '2026-11-29', domingo).texto, ANTIGO, 'dentro do horário: texto antigo');
  const r = responder(cfg({ seg: util }), interesse, { data: '2027-03-10', convidados: 50 }, '2026-11-29', domingo);
  assert.equal(r.humano, true);
  assert.equal(r.texto, 'Registrei seu interesse para 10/03/2027 e 50 pessoas. Vou encaminhar para a equipe conferir disponibilidade, pacote e valores. A data ainda não está reservada. Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na segunda-feira a partir das 9h.');
  assert.ok(responder(cfg(), interesse, { data: '2027-03-10', convidados: 50 }, '2026-11-29', domingo).texto?.endsWith('A data ainda não está reservada.'), 'sem horário: texto antigo');
});
test('P-F8-4: a frase fala do momento da passagem; composta antes da abertura continua verdadeira depois dela', () => {
  const composta = retornoForaDoHorario(semana, sp('2026-11-30T08:59:00'));
  assert.equal(composta, 'Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na segunda-feira a partir das 9h.');
  assert.doesNotMatch(composta, /Agora|estamos fora/);
  // No envio, às 09h01, a equipe já está aberta: o fecho recomposto (contingência, worker.ts) é o texto sem previsão.
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-30T09:01:00')), '');
  assert.equal(mensagemEncaminhamento(semana, sp('2026-11-30T09:01:00')), MENSAGEM_ENCAMINHAMENTO);
  assert.match(mensagemEncaminhamento(semana, sp('2026-11-30T08:59:00')), /foi encaminhada fora do horário/);
});
