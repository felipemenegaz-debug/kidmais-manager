import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts';
import { validarAmbienteFesta } from './ambiente.ts';
import { assinaturaEstruturaFesta016 } from './estrutura-016.ts';

test('flag explícita + estrutura final independem do nome físico do banco',async()=>{
    const anterior=process.env.FESTA_ENABLED;
    try{
        process.env.FESTA_ENABLED='true';
        const tx={query:async(sql:string)=>{assert(!/current_database|kidmais_016_/i.test(sql));assert(!/\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/.test(sql));return {rows:[{assinatura:assinaturaEstruturaFesta016,valida:true,nome:'kidmais_cloud_producao'}],rowCount:1};}} as DbExecutor;
        await validarAmbienteFesta(tx);
    }finally{if(anterior===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=anterior;}
});
test('desabilitada ou indefinida recusa sem consultar banco; apenas true habilita',async()=>{
    const anterior=process.env.FESTA_ENABLED;
    try{for(const flag of [undefined,'false','','1','TRUE']){
        if(flag===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=flag;
        await assert.rejects(validarAmbienteFesta({query:async()=>{throw Error('Não deveria consultar');}}),e=>e instanceof Error&&'status' in e&&e.status===503&&e.message==='Módulo Festa indisponível neste ambiente.');
    }}finally{if(anterior===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=anterior;}
});
test('estrutura ausente/incompleta ou falha de catálogo devolve erro seguro',async()=>{
    const anterior=process.env.FESTA_ENABLED;process.env.FESTA_ENABLED='true';
    try{for(const tx of [{query:async()=>({rows:[],rowCount:0})},{query:async()=>({rows:[{assinatura:'incompleta'}],rowCount:1})},{query:async()=>{throw Error('senha e SQL internos');}}]){
        await assert.rejects(validarAmbienteFesta(tx as DbExecutor),e=>e instanceof Error&&'status' in e&&e.status===503&&e.message==='Módulo Festa indisponível: instalação não validada.');
    }}finally{if(anterior===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=anterior;}
});

test('baseline 016 válida sem delta 019 não habilita a formalização',async()=>{
    const anterior=process.env.FESTA_ENABLED;process.env.FESTA_ENABLED='true';
    try {
        const tx={query:async()=>({rows:[{assinatura:assinaturaEstruturaFesta016,valida:false}],rowCount:1})} as DbExecutor;
        await assert.rejects(validarAmbienteFesta(tx),/instalação não validada/);
    } finally {if(anterior===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=anterior;}
});
