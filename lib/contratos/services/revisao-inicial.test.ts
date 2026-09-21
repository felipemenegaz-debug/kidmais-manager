import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hashSnapshotContrato } from './snapshot-core.ts';

function carregar(mocks: Record<string, unknown> = {}) {
    const exports: Record<string, unknown> = {};
    const js = ts.transpileModule(readFileSync('lib/contratos/services/revisao-inicial.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const deps = { './snapshot-core': { hashSnapshotContrato }, './errors': {
        ContratoServiceError: class extends Error { constructor(_code: string, message: string) { super(message); } },
    }, ...mocks };
    new Function('require','exports',js)((id: string) => deps[id as keyof typeof deps] ?? {}, exports);
    return exports;
}
type Versao = { id: string; contratoId: string; status: string };
type Edicao = { contrato_id: string; contrato_versao_id: string; estado: string };
const v: Versao = { id: 'v2', contratoId: 'c', status: 'ATIVA' };
const e: Edicao = { contrato_id: 'c', contrato_versao_id: 'v2', estado: 'EM_ELABORACAO' };
const exigir = carregar().exigirVersaoEditavel as (v: Versao,e: Edicao|null,c: string,p: string|null,s: boolean)=>void;
for(const historico of ['Kidmais assinou V1','ambas as partes assinaram V1']) test(`${historico}: V2 ativa sem assinatura própria permanece editável`,()=>{
    assert.doesNotThrow(()=>exigir(v,e,'c','v2',false));
});
for(const status of ['ASSINADA','CANCELADA','SUBSTITUIDA']) test(`versão ${status} recusa edição mesmo com ponteiro ativo`,()=>{
    assert.throws(()=>exigir({...v,status},e,'c','v2',false),/não pode ser editada/);
});
for(const estado of ['ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE','CONCLUIDA','CANCELADA']) test(`edição ${estado} recusa alteração`,()=>{
    assert.throws(()=>exigir(v,{...e,estado},'c','v2',false));
});
test('assinatura própria recusa edição mesmo se estado informado ainda disser elaboração',()=>{
    assert.throws(()=>exigir(v,e,'c','v2',true),/não pode ser editada/);
});
test('versão fora do contrato, edição de outra versão e ponteiro inativo são recusados',()=>{
    assert.throws(()=>exigir({...v,contratoId:'outro'},e,'c','v2',false));
    assert.throws(()=>exigir(v,{...e,contrato_id:'outro'},'c','v2',false));
    assert.throws(()=>exigir(v,{...e,contrato_versao_id:'v1'},'c','v2',false));
    assert.throws(()=>exigir(v,e,'c','v1',false));
    assert.throws(()=>exigir(v,e,'c',null,false));
    assert.throws(()=>exigir(v,null,'c','v2',false));
});
test('reabrir edição usa proposta V2, sem reverter para campos do fechamento original',async()=>{
    const proposta={fechamento:{convidados:60},cliente:{id:'cl'},aniversariante:{id:'a'},resumo:{adicionais:{itens:[{codigo:'MESA_CAFE',quantidade:2}]}},baseHash:'base'};
    const queries:string[]=[];
    const tx={query:async(sql:string,p:unknown[])=>{queries.push(sql);assert.deepEqual(p,['v2']);return {rows:[{dados_fonte:{revisaoInicial:proposta}}]};}};
    const fn=carregar().fonteDaRevisaoInicial as (v:unknown,f:unknown,t:unknown)=>Promise<{fechamento:{convidados:number};adicionais:unknown;fonteHash:string}>;
    const result=await fn({...v,snapshotHash:'hash-v2'},{fechamento:{convidados:50}},tx);
    assert.equal(result.fechamento.convidados,60);assert.deepEqual(result.adicionais,[{codigo:'MESA_CAFE',quantidade:2}]);
    assert.equal(result.fonteHash,hashSnapshotContrato({versao:'v2',snapshot:'hash-v2',proposta}));
    assert(queries.every(sql=>sql.startsWith('SELECT')));
});
test('fonte desatualizada impede cálculo e persistência da proposta',async()=>{
    const fn=carregar().prepararEdicaoInicial as (...args:unknown[])=>Promise<unknown>;
    await assert.rejects(fn({},v,e,{fonteHash:'atual'},{fonteHash:'antiga'}),/revisão mudou/);
});
for(const partes of [[],['KIDMAIS'],['CLIENTE']]) test(`promoção sem dupla assinatura é recusada: ${partes.join(',')||'nenhuma'}`,async()=>{
    const fn=carregar().aplicarRevisaoInicial as (...args:unknown[])=>Promise<unknown>;
    const tx={query:async(sql:string)=>{assert(sql.startsWith('SELECT'));return {rows:sql.includes('contrato_fluxos')?[{versao_vigente_id:null,versao_em_preparacao_id:'v2'}]:partes.map(parte=>({parte}))};}};
    await assert.rejects(fn(tx,{...v,status:'ASSINADA'},{}),/dupla assinatura/);
});
