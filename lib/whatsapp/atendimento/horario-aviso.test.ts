import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuracaoSchema } from './core.ts';
import { avisoEquipeSchema, horaFalada, horarioEquipeSchema, momentoLocal, retornoForaDoHorario, situacaoHorario, type HorarioEquipe } from './horario.ts';
import { chaveDoAviso, mensagemAvisoEquipe, MOTIVO_RECENTE_MINUTOS, motivosRecentes } from './aviso-equipe.ts';

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
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-25T07:00:00')), 'Agora estamos fora do horário de atendimento: a equipe responde hoje a partir das 9h.');
  assert.equal(retornoForaDoHorario(semana, sp('2026-11-25T18:00:00')), 'Agora estamos fora do horário de atendimento: a equipe responde amanhã a partir das 9h.', 'fim exclusivo');
  // Quarta 23:59 local (UTC já é quinta 02:59): amanhã. Quinta 00:00 local: hoje.
  assert.match(retornoForaDoHorario(semana, new Date('2026-11-26T02:59:00.000Z')), /amanhã a partir das 9h\.$/);
  assert.match(retornoForaDoHorario(semana, new Date('2026-11-26T03:00:00.000Z')), /hoje a partir das 9h\.$/);
  // Sexta à noite, sábado e domingo: segunda (domingo à noite, segunda é "amanhã").
  for (const t of ['2026-11-27T19:00:00', '2026-11-28T10:00:00']) assert.match(retornoForaDoHorario(semana, sp(t)), /na segunda-feira a partir das 9h\.$/, t);
  assert.match(retornoForaDoHorario(semana, sp('2026-11-29T23:00:00')), /amanhã a partir das 9h\.$/);
  assert.match(retornoForaDoHorario({ ...semana, sab: { inicio: '10:00', fim: '14:00' } }, sp('2026-11-27T19:00:00')), /amanhã a partir das 10h\.$/);
  // Só um dia na semana e ele já passou: a próxima ocorrência é daqui a 7 dias.
  assert.match(retornoForaDoHorario({ qua: { inicio: '13:30', fim: '17:00' } }, sp('2026-11-25T18:00:00')), /na próxima quarta-feira a partir das 13h30\.$/);
  assert.match(retornoForaDoHorario({ sab: { inicio: '09:00', fim: '12:00' } }, sp('2026-11-28T13:00:00')), /no próximo sábado a partir das 9h\.$/);
  assert.match(retornoForaDoHorario({ qua: { inicio: '13:30', fim: '17:00' } }, sp('2026-11-25T08:00:00')), /hoje a partir das 13h30\.$/);
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

test('motivos do aviso: só da passagem recente e só valores conhecidos', () => {
  const agora = new Date('2026-11-25T15:00:00.000Z');
  const em = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();
  assert.deepEqual(motivosRecentes({ motivos: ['PAGAMENTO', 'PAGAMENTO', 'INVENTADO', 3], em: em(5) }, agora), ['PAGAMENTO']);
  assert.deepEqual(motivosRecentes({ motivos: ['PAGAMENTO'], em: em(MOTIVO_RECENTE_MINUTOS + 1) }, agora), [], 'passagem antiga');
  assert.deepEqual(motivosRecentes({ motivos: ['PAGAMENTO'], em: em(-5) }, agora), [], 'no futuro');
  assert.deepEqual(motivosRecentes(null, agora), []);
  assert.deepEqual(motivosRecentes({ motivos: 'PAGAMENTO', em: em(1) }, agora), []);
});
