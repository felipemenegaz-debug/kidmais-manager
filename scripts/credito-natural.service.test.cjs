/* eslint-disable @typescript-eslint/no-require-imports */
// Exercita a validação real de simulação sem acessar PostgreSQL.
require('./pagamentos-test-support.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
globalThis.__kidmaisPgPool={query(){throw Error('Este teste não pode acessar banco');},connect(){throw Error('Este teste não pode acessar banco');}};
const {simularPosicao}=require('../lib/pagamentos/services/alteracao-financeira.service.ts');
test('Servidor aceita NAO_SE_APLICA para absorção natural de 42900 e programa somente 50000',()=>{
 const p={posicaoHash:'teste',valorVigente:929000n,posicao:{obrigacao:836100n,credito:42900n,recebido:929000n,estornado:0n,devolvido:50000n,reservado:0n},motivos:['VALOR'],vigente:{snapshot:{evento:{data:'2098-10-10'},comercial:{formaPagamentoPretendida:'PIX_PARCELADO'}}},futuro:[],recebimentos:[]};
 const input={posicaoHash:'teste',modo:'REPROGRAMAR',parcelas:[{valorCentavos:'50000',vencimento:'2098-10-01'}],credito:'NAO_SE_APLICA',decisaoContratante:'NAO_SE_APLICA',justificativa:'Aumento posterior com absorção econômica natural'};
 const antes=structuredClone(p),r=simularPosicao(p,input);
 assert.equal(r.delta,92900n);assert.equal(r.depois.liquido,879000n);assert.equal(r.depois.saldo,50000n);assert.equal(r.depois.credito,0n);
 assert.deepEqual(r.parcelas,input.parcelas);assert.deepEqual(p,antes);
 assert.throws(()=>simularPosicao(p,{...input,parcelas:[{valorCentavos:'7100',vencimento:'2098-10-01'}]}),'Não subtrair o crédito antigo duas vezes');
});
