import test from 'node:test';
import assert from 'node:assert/strict';
import { centavosInteiros, reaisCentavos, posicaoEconomica, distribuirCentavos, validarCronogramaConsolidado, situacaoAlteracao } from './alteracao-financeira-core.ts';
for (const [nome,original,delta,recebido,saldo,credito] of [
  ['aumento sem recebimento',899000n,414100n,0n,1313100n,0n],
  ['aumento parcial',899000n,414100n,500000n,813100n,0n],
  ['aumento após quitação',900000n,150000n,900000n,150000n,0n],
  ['redução sem crédito',1300000n,-200000n,500000n,600000n,0n],
  ['redução com crédito',1300000n,-200000n,1200000n,0n,100000n],
  ['redução quitada',1300000n,-200000n,1300000n,0n,200000n],
  ['ajuste zero',900000n,0n,500000n,400000n,0n],
  ['V3 contra reconhecida V1',900000n,300000n,500000n,700000n,0n],
] as const) test(nome,()=>{const p=posicaoEconomica(original,delta,recebido,0n,0n,0n);assert.equal(p.saldo,saldo);assert.equal(p.credito,credito);});
test('crédito aproveitado não é abatido duas vezes',()=>assert.equal(posicaoEconomica(1100000n,70000n,1200000n,0n,0n,0n).credito,30000n));
test('devolução pendente apenas reserva; conclusão produz saída',()=>{const p=posicaoEconomica(1100000n,0n,1200000n,0n,0n,60000n);assert.equal(p.liquido,1200000n);assert.equal(p.disponivel,40000n);assert.equal(posicaoEconomica(1100000n,0n,1200000n,0n,60000n,0n).credito,40000n);});
test('reserva incompatível não pode ser consumida implicitamente',()=>assert.throws(()=>posicaoEconomica(1100000n,70000n,1200000n,0n,0n,60000n)));
test('caso real preserva estorno de 500',()=>assert.equal(posicaoEconomica(899000n,414100n,899000n,50000n,0n,0n).saldo,464100n));
test('cancelar tentativa deixa a alteração pendente',()=>assert.equal(situacaoAlteracao(true,'CANCELADA'),'PENDENTE'));
test('distribuição inteira sem perda',()=>assert.deepEqual(distribuirCentavos(813100n,3),[271034n,271033n,271033n]));
test('valores subcentavo, inválidos e fora de limite rejeitados',()=>{for(const s of ['1.01','1e3','NaN','-1','1000000000000'])assert.throws(()=>centavosInteiros(s));assert.throws(()=>reaisCentavos('1.001'));assert.equal(reaisCentavos('9011.30'),901130n);});
test('PIX após festa rejeitado; cartão não herda restrição PIX',()=>{const parcelas=[{valorCentavos:'100',vencimento:'2026-12-02'}];assert.throws(()=>validarCronogramaConsolidado(parcelas,100n,'2026-12-01',true));validarCronogramaConsolidado(parcelas,100n,'2026-12-01',false);});
test('saldo zero aceita cronograma vazio; parcela parcial programa só saldo',()=>{validarCronogramaConsolidado([],0n,'2026-12-01',true);validarCronogramaConsolidado([{valorCentavos:'130000',vencimento:'2026-12-01'}],130000n,'2026-12-01',true);});
