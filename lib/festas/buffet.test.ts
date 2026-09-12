import test from 'node:test';
import assert from 'node:assert/strict';
import {camposBuffet,escolhasEfetivas,nomeComIdade,rotulosBuffet} from './buffet.ts';
test('A/B/C: campos por pacote e adicional formal, sem parser de texto',()=>{
 assert.deepEqual(camposBuffet('ESSENCIAL'),['salgados','doces','bolo','bebidas']);
 for(const p of ['COMPLETA','MINI_FESTA'])assert.deepEqual(camposBuffet(p),['salgados','doces','bolo','bebidas','lembrancinha']);
 assert.deepEqual(camposBuffet('PREMIUM'),['salgados','doces','bolo','bebidas','lembrancinha','empratado','bombom']);
 assert.deepEqual(camposBuffet('POCKET',['BOMBOM','EMPRATADO_PREMIUM']),['salgados','doces','bolo','bebidas','empratado','bombom']);
 assert(!camposBuffet('ESSENCIAL',['Texto com bombom']).includes('bombom'));
 assert.equal(rotulosBuffet.bebidas,'Bebidas e sucos');
});
test('D/E/F: herança por campo, vazio explícito e ausência não fabricada',()=>{
 const base={salgados:'Coxinha',bebidas:'Laranja e água',lembrancinha:'Bola'};
 const antes=JSON.stringify(base),r=escolhasEfetivas(base,{salgados:'Kibe',lembrancinha:''});
 assert.equal(r.salgados,'Kibe');assert.equal(r.bebidas,'Laranja e água');assert.equal(r.lembrancinha,'');assert.equal(r.bombom,'');assert.equal(JSON.stringify(base),antes);
});
test('H/I: idade do evento tem prioridade; nascimento confiável e ausência',()=>{
 const snapshot={aniversariante:{nome:'Catarina',idadeNoEvento:7,dataNascimento:'2020-09-12'},evento:{data:'2026-09-12'}};
 assert.equal(nomeComIdade(snapshot),'Catarina — 7 anos');
 assert.equal(nomeComIdade({...snapshot,aniversariante:{nome:'Catarina',idadeNoEvento:1}}),'Catarina — 1 ano');
 assert.equal(nomeComIdade({aniversariante:{nome:'Catarina'},evento:{data:'2026-09-12'}},'2019-09-13'),'Catarina — 6 anos');
 assert.equal(nomeComIdade({aniversariante:{nome:'Catarina'}}),'Catarina — Idade não informada');
});
