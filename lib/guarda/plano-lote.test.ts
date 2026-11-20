import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularMarcos, type EntradaMarcos } from './marcos.ts';
import { alcanca, execucaoDoPrazo, itensDoCliente, montarLote, primeiroDoMes, proximoDiaPrimeiro, somarDias, somarMeses } from './plano-lote.ts';

/** Guarda fase 3 (20/11/2026): plano do lote mensal (cálculo puro, nada apaga). Regra do DPA 2026-11-17 e da PR #447. */
const livre = { valorEmAberto: false, disputa: false };
const base: EntradaMarcos = { cadastradoEm: '2020-01-10', festas: [], contatos: [], saidaCampanhas: null };
const DIA_MS = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const dias = (a: string, b: string) => (t(b) - t(a)) / DIA_MS;

test('datas: dia 1º, soma de meses e dias, aviso só em dia 1º', () => {
  assert.equal(primeiroDoMes('2027-02-28'), '2027-02-01');
  assert.equal(somarMeses('2027-11-01', 2), '2028-01-01');
  assert.equal(somarDias('2027-02-01', 30), '2027-03-03');
  assert.equal(proximoDiaPrimeiro('2026-11-20'), '2026-12-01');
  assert.equal(proximoDiaPrimeiro('2026-12-01'), '2026-12-01');
  assert.throws(() => montarLote('NORMAL', '2027-01-15'), /dia 1º/);
  assert.throws(() => execucaoDoPrazo('2027-01-01', '2027-02-30'), /data inválida/);
  assert.deepEqual(montarLote('NORMAL', '2027-01-01'), { tipo: 'NORMAL', aviso: '2027-01-01', desde: '2027-03-01', ate: '2027-04-01' });
  assert.deepEqual(montarLote('PRIMEIRA', '2027-01-01'), { tipo: 'PRIMEIRA', aviso: '2027-01-01', desde: null, ate: '2027-04-01' });
});

test('casos do parecer da #447: max(1º do mês do vencimento, aviso + 30 dias)', () => {
  assert.equal(execucaoDoPrazo('2027-04-01', '2027-04-15'), '2027-05-01');
  assert.equal(execucaoDoPrazo('2027-04-01', '2027-05-15'), '2027-05-01');
  assert.equal(execucaoDoPrazo('2027-07-01', '2027-08-31'), '2027-08-01');
  assert.equal(execucaoDoPrazo('2027-02-01', '2027-03-01'), '2027-03-03');
  assert.equal(execucaoDoPrazo('2027-02-01', '2020-01-01'), '2027-03-03', 'já vencido: 30 dias depois do aviso');
});

test('varredura: todo dia 1º de 2027–2028, primeira aplicação e ciclo normal (aviso ≥ 30 dias, antecipação ≤ 30, atraso só na exceção)', () => {
  for (let m = 0; m < 24; m++) {
    const aviso = somarMeses('2027-01-01', m);
    const primeira = montarLote('PRIMEIRA', aviso);
    const normal = montarLote('NORMAL', aviso);
    for (let venc = somarDias(aviso, -400); venc < primeira.ate; venc = somarDias(venc, 1)) {
      assert.ok(alcanca(primeira, venc));
      const exec = execucaoDoPrazo(aviso, venc);
      assert.ok(dias(aviso, exec) >= 30, `aviso mínimo: ${aviso} ${venc}`);
      assert.ok(dias(exec, venc) <= 30, `antecipação máxima: ${aviso} ${venc}`);
      if (exec > venc) assert.ok(venc < somarMeses(aviso, 2) && dias(aviso, venc) < 30 && exec === somarDias(aviso, 30), `atraso só na exceção: ${aviso} ${venc}`);
      const noNormal = alcanca(normal, venc);
      assert.equal(noNormal, venc >= somarMeses(aviso, 2), `ciclo normal só alcança M+2: ${aviso} ${venc}`);
      if (noNormal) assert.ok(exec === somarMeses(aviso, 2) && exec <= venc && dias(aviso, exec) >= 59, `ciclo normal: ${aviso} ${venc}`);
    }
    assert.ok(!alcanca(primeira, primeira.ate) && !alcanca(normal, normal.ate), 'M+3 fica para o aviso seguinte');
    // Sem buraco nem repetição: o ciclo normal do mês seguinte começa onde este termina.
    assert.equal(montarLote('NORMAL', somarMeses(aviso, 1)).desde, normal.ate);
  }
});

test('interessado vencido: ANONIMIZAR_TUDO na primeira aplicação, 30 dias depois do aviso; fora do ciclo normal', () => {
  const m = calcularMarcos(base); // vence 2022-01-10
  assert.deepEqual(itensDoCliente(m, montarLote('PRIMEIRA', '2027-01-01'), livre),
    [{ medida: 'ANONIMIZAR_TUDO', prazo: 'INTERESSADO', vencimento: '2022-01-10', execucao: '2027-01-31', excecoes: [] }]);
  assert.deepEqual(itensDoCliente(m, montarLote('NORMAL', '2027-01-01'), livre), []);
  const recente = calcularMarcos({ ...base, cadastradoEm: '2025-03-20' }); // vence 2027-03-20
  assert.deepEqual(itensDoCliente(recente, montarLote('NORMAL', '2027-01-01'), livre),
    [{ medida: 'ANONIMIZAR_TUDO', prazo: 'INTERESSADO', vencimento: '2027-03-20', execucao: '2027-03-01', excecoes: [] }]);
});

test('cada prazo pela sua finalidade: pediu para sair = PARAR_CAMPANHA; contrato fica até os 5 anos dele', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2024-06-01', ultimoPagamento: '2024-06-10', canceladaEm: null }], saidaCampanhas: '2024-07-01' });
  assert.deepEqual(itensDoCliente(m, montarLote('PRIMEIRA', '2027-01-01'), livre),
    [{ medida: 'PARAR_CAMPANHA', prazo: 'CAMPANHAS', vencimento: '2024-07-01', execucao: '2027-01-31', excecoes: [] }]);
  // O contrato vence em 2029-06-10: no lote de abril/2029 (aviso 1º/04) é a anonimização completa.
  assert.deepEqual(itensDoCliente(m, montarLote('NORMAL', '2029-04-01'), { valorEmAberto: true, disputa: false }),
    [{ medida: 'ANONIMIZAR_TUDO', prazo: 'CONTRATO', vencimento: '2029-06-10', execucao: '2029-06-01', excecoes: ['VALOR_EM_ABERTO'] }]);
});

test('contrato vence antes do contato (contato renovado): ELIMINAR_SO_CONTRATO, com exceção de valor em aberto/disputa', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2021-05-10', ultimoPagamento: null, canceladaEm: null }],
    contatos: [{ dia: '2025-02-01', origem: 'WHATSAPP' }] });
  assert.equal(m.contrato?.data, '2026-05-10'); assert.equal(m.campanhas?.data, '2030-02-01');
  assert.deepEqual(itensDoCliente(m, montarLote('PRIMEIRA', '2027-01-01'), { valorEmAberto: true, disputa: true }),
    [{ medida: 'ELIMINAR_SO_CONTRATO', prazo: 'CONTRATO', vencimento: '2026-05-10', execucao: '2027-01-31', excecoes: ['VALOR_EM_ABERTO', 'DISPUTA'] }]);
  assert.deepEqual(itensDoCliente(m, montarLote('NORMAL', '2029-12-01'), { valorEmAberto: true, disputa: false }),
    [{ medida: 'ANONIMIZAR_TUDO', prazo: 'CAMPANHAS', vencimento: '2030-02-01', execucao: '2030-02-01', excecoes: ['VALOR_EM_ABERTO'] }]);
});

test('dois prazos no mesmo lote: o parcial anterior fica, o parcial do mesmo dia é absorvido pela anonimização', () => {
  // Festa 2020-03-10 sem contato: contrato e campanhas vencem em 2025-03-10 → um item só.
  const junto = calcularMarcos({ ...base, festas: [{ dataEvento: '2020-03-10', ultimoPagamento: null, canceladaEm: null }] });
  assert.deepEqual(itensDoCliente(junto, montarLote('PRIMEIRA', '2027-01-01'), livre),
    [{ medida: 'ANONIMIZAR_TUDO', prazo: 'CONTRATO', vencimento: '2025-03-10', execucao: '2027-01-31', excecoes: [] }]);
  // Saída das campanhas vencida e contrato que vence no mês M+1: PARAR_CAMPANHA antes, ANONIMIZAR_TUDO depois.
  const separado = calcularMarcos({ ...base, festas: [{ dataEvento: '2022-02-20', ultimoPagamento: null, canceladaEm: null }], saidaCampanhas: '2023-01-05' });
  assert.deepEqual(itensDoCliente(separado, montarLote('PRIMEIRA', '2027-01-01'), livre), [
    { medida: 'ANONIMIZAR_TUDO', prazo: 'CONTRATO', vencimento: '2027-02-20', execucao: '2027-02-01', excecoes: [] },
    { medida: 'PARAR_CAMPANHA', prazo: 'CAMPANHAS', vencimento: '2023-01-05', execucao: '2027-01-31', excecoes: [] },
  ]);
  // Mesmo aviso, mas o contrato vence em M (janeiro): execução 31/01 = a do parcial → só a anonimização.
  const mesmoDia = calcularMarcos({ ...base, festas: [{ dataEvento: '2022-01-20', ultimoPagamento: null, canceladaEm: null }], saidaCampanhas: '2023-01-05' });
  assert.deepEqual(itensDoCliente(mesmoDia, montarLote('PRIMEIRA', '2027-01-01'), livre).map((i) => i.medida), ['ANONIMIZAR_TUDO']);
});

test('fora da janela: nada no lote (vence depois de M+2)', () => {
  const m = calcularMarcos({ ...base, cadastradoEm: '2026-11-01' }); // vence 2028-11-01
  assert.deepEqual(itensDoCliente(m, montarLote('PRIMEIRA', '2027-01-01'), livre), []);
  assert.deepEqual(itensDoCliente(m, montarLote('NORMAL', '2028-09-01'), livre).map((i) => i.execucao), ['2028-11-01']);
});
