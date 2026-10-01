import test from 'node:test';
import assert from 'node:assert/strict';
import { separarDuracao, juntarDuracao, formatarDuracao } from './duracao.ts';

test('duração humana e valores que não são múltiplos de 15', () => {
  for (const [value, text] of [[165,'2h45min'],[210,'3h30min'],[240,'4h'],[167,'2h47min'],[1,'1min'],[1440,'24h']] as const) assert.equal(formatarDuracao(value),text);
  assert.equal(formatarDuracao(null),'Não definida');
});
test('todos os minutos válidos fazem round-trip sem arredondamento', () => {
  for (let value=1;value<=1440;value++) { const {horas,minutos}=separarDuracao(value); assert.equal(juntarDuracao(horas,minutos),value); }
  assert.deepEqual(separarDuracao(null),{horas:'',minutos:''});
  assert.equal(juntarDuracao('',''),null);
});
test('não aceita frações, minutos fora da hora ou duração além do domínio', () => {
  for (const [h,m] of [['-1','0'],['1.5','0'],['1','60'],['24','1'],['0','0'],['a','15']]) assert.throws(()=>juntarDuracao(h,m));
  for (const value of [0,-1,1441,1.5,NaN]) assert.throws(()=>separarDuracao(value));
});
