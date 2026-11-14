import test from 'node:test';
import assert from 'node:assert/strict';
import {linkChamar,linkNegociacao} from './acoes-ui.ts';
import {custoEstimadoPorContrato,finsDeSemanaLivres} from './resultados-ui.ts';
import {dataInicialDaCampanha} from './campanhas-ui.ts';

test('divulgação: aceita data real hoje/futura e ignora ausente, repetida, passada ou inválida',()=>{
  const hoje='2026-11-14';
  for(const data of [hoje,'2027-04-10','2028-02-29']) assert.equal(dataInicialDaCampanha(data,hoje),data);
  for(const data of [undefined,null,'',['2027-04-10'],'2026-11-13','2027-02-29','2027-04-31','2027-13-01','2027-00-01','2027-01-00','2027-4-10','10/04/2027','2027-04-10T00:00:00Z']) {
    assert.equal(dataInicialDaCampanha(data,hoje),undefined,JSON.stringify(data));
  }
});

test('Chamar só monta wa.me com texto escapado e telefone válido; negociação preserva data e convidados',()=>{
  const link = linkChamar('(11) 98888-1234','Ana & Bia');
  assert.equal(new URL(link!).hostname,'wa.me');
  assert.equal(new URL(link!).pathname,'/5511988881234');
  assert.ok(new URL(link!).searchParams.get('text')?.includes('Ana & Bia'));
  assert.equal(linkChamar(null,'Ana'),null);
  assert.equal(linkChamar('123','Ana'),null);
  const n=new URL(linkNegociacao({clienteId:'cliente',dataDesejada:'2027-04-10',convidados:80}),'http://localhost');
  assert.equal(n.pathname,'/admin/clientes/cliente/fechamento');
  assert.equal(n.searchParams.get('data'),'2027-04-10');assert.equal(n.searchParams.get('convidados'),'80');
});
test('orçamento por contrato é estimativa; ausência de orçamento ou de contratos não inventa custo zero',()=>{
  assert.equal(custoEstimadoPorContrato({orcamentoCentavos:null,contratos:2}),null);
  assert.equal(custoEstimadoPorContrato({orcamentoCentavos:50000,contratos:0}),null);
  assert.equal(custoEstimadoPorContrato({orcamentoCentavos:50000,contratos:2}),25000);
});
test('datas vagas: agrupa sábado e domingo, exclui sexta, ordena e limita a seis fins de semana',()=>{
  const dias=Array.from({length:60},(_,i)=>{const d=new Date(Date.UTC(2027,0,1+i,12));return {data:d.toISOString().slice(0,10),diaSemana:d.getUTCDay(),horariosLivres:1,fimDeSemana:[0,5,6].includes(d.getUTCDay())};});
  const grupos=finsDeSemanaLivres(dias.reverse());assert.equal(grupos.length,6);
  assert.deepEqual(grupos[0].map(d=>d.data),['2027-01-02','2027-01-03']);
  assert.ok(grupos.flat().every(d=>[0,6].includes(d.diaSemana)));
});
