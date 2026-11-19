import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularMarcos, lerMarcosDoCliente, somarAnos } from './marcos.ts';

/** Guarda fase 1b (19/11/2026): datas-base dos prazos dos textos legais de 17/11. Cálculo puro + leitura só SELECT. */
const base = { cadastradoEm: '2024-01-10', festas: [], contatos: [], saidaCampanhas: null };

test('somarAnos: dia comum e 29/02 vai para 28/02 em ano não bissexto (nunca passa do prazo)', () => {
  assert.equal(somarAnos('2026-11-19', 5), '2031-11-19');
  assert.equal(somarAnos('2024-02-29', 5), '2029-02-28');
  assert.equal(somarAnos('2024-02-29', 4), '2028-02-29');
  assert.equal(somarAnos('2000-02-29', 100), '2100-02-28');
  assert.throws(() => somarAnos('19/11/2026', 1), /data inválida/);
});

test('interessado sem contato: 2 anos do cadastro, origem CADASTRO', () => {
  const m = calcularMarcos(base);
  assert.equal(m.categoria, 'INTERESSADO');
  assert.deepEqual(m.ultimoContato, { dia: '2024-01-10', origem: 'CADASTRO' });
  assert.deepEqual(m.interessado, { data: '2026-01-10', marco: '2024-01-10', motivo: '2 anos do cadastro, sem contato registrado' });
  assert.equal(m.contrato, null); assert.equal(m.campanhas, null);
  assert.equal(m.todosVencidosEm, '2026-01-10');
});

test('interessado: o contato mais recente (de qualquer origem) renova os 2 anos', () => {
  const m = calcularMarcos({ ...base, contatos: [{ dia: '2025-03-01', origem: 'FORMULARIO_SITE' }, { dia: '2025-08-20T13:00:00Z', origem: 'WHATSAPP' }, { dia: '2024-12-01', origem: 'PESQUISA' }] });
  assert.deepEqual(m.ultimoContato, { dia: '2025-08-20', origem: 'WHATSAPP' });
  assert.equal(m.interessado?.data, '2027-08-20');
  assert.equal(m.interessado?.motivo, '2 anos sem contato');
});

test('contratou: contrato conta da festa; pagamento depois da festa empurra o marco', () => {
  const semPagamento = calcularMarcos({ ...base, festas: [{ dataEvento: '2025-05-10', ultimoPagamento: '2025-04-01', canceladaEm: null }] });
  assert.equal(semPagamento.categoria, 'CONTRATOU');
  assert.deepEqual(semPagamento.contrato, { data: '2030-05-10', marco: '2025-05-10', motivo: '5 anos da data da festa' });
  assert.equal(semPagamento.interessado, null);
  const pagouDepois = calcularMarcos({ ...base, festas: [{ dataEvento: '2025-05-10', ultimoPagamento: '2025-07-02', canceladaEm: null }] });
  assert.deepEqual(pagouDepois.contrato, { data: '2030-07-02', marco: '2025-07-02', motivo: '5 anos do último pagamento' });
  assert.equal(pagouDepois.ultimoPagamento, '2025-07-02');
});

test('festa futura: o prazo do contrato conta da data futura da festa', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2027-03-20', ultimoPagamento: '2026-11-01', canceladaEm: null }] });
  assert.equal(m.ultimaFesta, '2027-03-20');
  assert.equal(m.contrato?.data, '2032-03-20');
  assert.equal(m.campanhas?.data, '2032-03-20');
});

test('festa cancelada: contrato conta do cancelamento e ela não vira "última festa"', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2027-03-20', ultimoPagamento: '2026-02-01', canceladaEm: '2026-03-15' }] });
  assert.equal(m.ultimaFesta, null);
  assert.deepEqual(m.contrato, { data: '2031-03-15', marco: '2026-03-15', motivo: '5 anos do cancelamento da festa' });
  assert.equal(m.campanhas?.marco, '2026-03-15', 'sem festa realizada nem contato, campanhas contam do cancelamento');
});

test('várias festas: vale o contrato que vence mais tarde; contato recente renova campanhas, não o contrato', () => {
  const m = calcularMarcos({ ...base,
    festas: [{ dataEvento: '2022-06-01', ultimoPagamento: null, canceladaEm: null }, { dataEvento: '2024-09-09', ultimoPagamento: null, canceladaEm: null }],
    contatos: [{ dia: '2026-10-01', origem: 'PESQUISA' }] });
  assert.equal(m.contrato?.data, '2029-09-09');
  assert.deepEqual(m.campanhas, { data: '2031-10-01', marco: '2026-10-01', motivo: '5 anos sem festa nem contato' });
  assert.equal(m.todosVencidosEm, '2031-10-01');
});

test('pedido de saída encerra as campanhas na hora, sem mexer no prazo do contrato', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2025-05-10', ultimoPagamento: null, canceladaEm: null }], saidaCampanhas: '2026-01-02' });
  assert.deepEqual(m.campanhas, { data: '2026-01-02', marco: '2026-01-02', motivo: 'pediu para sair das campanhas' });
  assert.equal(m.contrato?.data, '2030-05-10');
  assert.equal(m.todosVencidosEm, '2030-05-10');
});

test('contratou sem contato registrado: último contato fica vazio (não usa o cadastro)', () => {
  const m = calcularMarcos({ ...base, festas: [{ dataEvento: '2025-05-10', ultimoPagamento: null, canceladaEm: null }] });
  assert.equal(m.ultimoContato, null);
});

// ---- leitura (mock: só SELECT, empresa sempre no filtro, mescla resolvida para o principal) ----
const EMPRESA = '00000000-0000-4000-8000-000000000001';
const CLIENTE = '00000000-0000-4000-8000-0000000000c1';
const PRINCIPAL = '00000000-0000-4000-8000-0000000000c9';

function banco(opcoes: { semTabelas?: boolean; outraEmpresa?: boolean } = {}) {
  const sqls: { sql: string; params: unknown[] }[] = [];
  const tx = {
    async query(sql: string, params: unknown[] = []) {
      sqls.push({ sql, params });
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i, 'marcos só leem');
      if (sql.includes('guarda:marcos-cliente')) {
        assert.deepEqual(params, [EMPRESA, CLIENTE]);
        return opcoes.outraEmpresa ? { rows: [], rowCount: 0 } : { rows: [{ id: PRINCIPAL, cadastrado_em: '2023-05-01' }], rowCount: 1 };
      }
      if (sql.includes('guarda:marcos-tabelas')) {
        const v = !opcoes.semTabelas;
        return { rows: [{ conversas: v, contatos: v, satisfacao: v, saidas: v, importacoes: v, integracao: v }], rowCount: 1 };
      }
      assert.deepEqual(params, [EMPRESA, PRINCIPAL], 'depois de resolver a mescla, tudo é lido pelo principal');
      if (sql.includes('guarda:marcos-festas')) return { rows: [{ data_evento: '2024-08-01', ultimo_pagamento: '2024-08-05', cancelada_em: null }], rowCount: 1 };
      if (sql.includes('guarda:marcos-importadas')) {
        assert.match(sql, /NOT EXISTS \(SELECT 1 FROM contrato_importacoes/, 'importação já integrada não conta duas vezes');
        return { rows: [{ data_evento: '2025-02-02' }], rowCount: 1 };
      }
      if (sql.includes('guarda:marcos-contatos')) return { rows: [{ origem: 'WHATSAPP', dia: '2026-06-01' }, { origem: 'PESQUISA', dia: '2025-01-01' }], rowCount: 2 };
      if (sql.includes('guarda:marcos-saida')) return { rows: [{ dia: null }], rowCount: 1 };
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  return { tx, sqls };
}

test('leitura: mescla resolvida, importado não integrado conta como festa, contatos somados', async () => {
  const b = banco();
  const m = await lerMarcosDoCliente(b.tx as never, EMPRESA, CLIENTE);
  assert.equal(m?.clienteId, PRINCIPAL);
  assert.equal(m?.ultimaFesta, '2025-02-02');
  assert.equal(m?.contrato?.data, '2030-02-02');
  assert.deepEqual(m?.ultimoContato, { dia: '2026-06-01', origem: 'WHATSAPP' });
  assert.equal(m?.campanhas?.data, '2031-06-01');
  assert.match(b.sqls[0].sql, /c\.empresa_id = \$1::uuid AND p\.empresa_id = \$1::uuid/);
});

test('leitura: cliente de outra empresa → null, sem outras consultas', async () => {
  const b = banco({ outraEmpresa: true });
  assert.equal(await lerMarcosDoCliente(b.tx as never, EMPRESA, CLIENTE), null);
  assert.equal(b.sqls.length, 1);
});

test('leitura: sem tabelas opcionais (060/085/110/127/importação) só lê cliente e festas', async () => {
  const b = banco({ semTabelas: true });
  const m = await lerMarcosDoCliente(b.tx as never, EMPRESA, CLIENTE);
  assert.equal(m?.contrato?.data, '2029-08-05');
  assert.equal(m?.ultimoContato, null);
  assert.deepEqual(b.sqls.map((s) => /guarda:([a-z-]+)/.exec(s.sql)?.[1]), ['marcos-cliente', 'marcos-festas', 'marcos-tabelas']);
});
