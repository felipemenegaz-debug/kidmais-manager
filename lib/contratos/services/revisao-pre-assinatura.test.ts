import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { hashSnapshotContrato } from './snapshot-core.ts';
import { diferencasContratuais } from './alteracoes.ts';
const req=createRequire(import.meta.url);
function carregar(path:string,mocks:Record<string,unknown>,extra='') {
    const exports:Record<string,unknown>={};
    const code=ts.transpileModule(readFileSync(path,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    new Function('require','exports',code)((n:string)=>n in mocks?mocks[n]:['zod','node:crypto'].includes(n)?req(n):{},exports);
    return exports;
}
class Falha extends Error { code:string; constructor(code:string,message:string){super(message);this.code=code;} }
const chave='11111111-1111-4111-8111-111111111111';
function ambiente(estado='AGUARDANDO_CLIENTE',vigente=false) {
    const snapshot={contratante:{clienteId:'cl'},aniversariante:{id:'a'},fechamento:{id:'f'},evento:{data:'2026-10-01'}};
    const original={id:'v1',contratoId:'c',numeroVersao:1,status:'ATIVA',snapshot,snapshotHash:hashSnapshotContrato(snapshot)};
    const base={...structuredClone(original),id:'v0',status:'ASSINADA',numeroVersao:0};
    const versoes=vigente?[base,original]:[original],edicoes:Record<string,string>={v1:estado};
    const fluxo={versao_vigente_id:vigente?'v0':null,versao_em_preparacao_id:'v1' as string|null};
    const copias:unknown[]=[],antiga={id:'r1',operacao:{dataEvento:'2026-10-20',convidados:90},estado:'CONGELADA'};
    const auditorias:Record<string,unknown>[]=[],sqls:string[]=[];
    let contratoStatus=vigente?'ASSINADO':'AGUARDANDO_ASSINATURA';
    const tx={query:async(sql:string,p:unknown[]=[])=>{
        sqls.push(sql);let rows:unknown[]=[];
        if(sql.startsWith('SELECT id,fechamento_id,status'))rows=[{id:'c',fechamento_id:'f',status:contratoStatus}];
        else if(sql.startsWith('SELECT status FROM contratos'))rows=[{status:contratoStatus}];
        else if(sql.startsWith('SELECT * FROM contrato_fluxos'))rows=[{...fluxo}];
        else if(sql.startsWith('SELECT * FROM contrato_edicoes'))rows=[{estado:edicoes[String(p[0])],revisao:1}];
        else if(sql.startsWith('SELECT usuario_id,dados_depois'))rows=auditorias.filter(a=>(a.dadosDepois as Record<string,unknown>).chaveCriacao===p[1]).map(a=>({usuario_id:a.usuarioId,dados_depois:a.dadosDepois}));
        else if(sql.startsWith('SELECT * FROM contrato_assinaturas'))rows=[];
        else if(sql.startsWith('UPDATE contrato_edicoes')){if(sql.includes("estado='AGUARDANDO_CLIENTE'"))edicoes[String(p[0])]='AGUARDANDO_CLIENTE';else if(sql.includes("estado='CANCELADA'"))edicoes[String(p[0])]='CANCELADA';}
        else if(sql.startsWith('UPDATE contrato_versoes SET snapshot=')){const v=versoes.find(v=>v.id===p[0])!;v.snapshot=p[1] as typeof snapshot;v.snapshotHash=String(p[2]);}
        else if(sql.startsWith('UPDATE contrato_versoes'))versoes.find(v=>v.id===p[0])!.status='CANCELADA';
        else if(sql.startsWith('UPDATE contrato_fluxos'))fluxo.versao_em_preparacao_id=null;
        else if(sql.startsWith('SELECT max(numero_versao)'))rows=[{n:versoes.length+1}];
        else if(sql.startsWith('SELECT id FROM usuarios'))rows=[{id:'u'}];
        else if(sql.startsWith('INSERT INTO contrato_edicoes'))edicoes[String(p[0])]='EM_ELABORACAO';
        else if(sql.startsWith('INSERT INTO contrato_fluxos'))fluxo.versao_em_preparacao_id=String(p[1]);
        else if(!sql.includes('FOR UPDATE'))throw Error('SQL inesperado: '+sql);
        return {rows};
    }};
    const mod=carregar('lib/contratos/services/administrativo.service.ts',{
        '../../db/postgres':{withTransaction:async(fn:(tx:unknown)=>unknown)=>fn(tx)},
        '../../autenticacao/service':{consultarSessao:async()=>({usuario_id:'u',papel:'REPRESENTANTE_AUTORIZADO',autenticado_em:new Date().toISOString()})},
        '../../fechamentos/services/edicao-administrativa-schema':carregar('lib/fechamentos/services/edicao-administrativa-schema.ts',{}),
        './snapshot-core':{hashSnapshotContrato},'./errors':{ContratoServiceError:Falha},
        './alteracoes':{diferencasContratuais},
        './contrato.service':{carregarSnapshot:async()=>({snapshot})},
        '../../fechamentos/repositories':{buscarFechamentoPorIdParaAtualizacao:async()=>({id:'f'})},
        '../repositories':{buscarVersaoPorId:async(id:string)=>versoes.find(v=>v.id===id),criarContratoVersao:async(v:typeof original)=>{const next={...v,id:'v'+(versoes.length+1),status:'ATIVA'};versoes.push(next);return next;}},
        '../../fechamentos/repositories/revisao.repository':{
            buscarRevisaoDaVersao:async()=>vigente?antiga:null,
            listarItensRevisao:async()=>[{adicionalId:'extra',quantidade:2}],
            salvarOperacaoPreparada:async(_tx:unknown,_r:unknown,op:unknown,itens:unknown)=>{copias.push(structuredClone({op,itens}));return {id:'r2',operacao:op};},
        },
        '../../fechamentos/services/revisao-operacional.service':{
            cancelarPreparacao:async()=>{edicoes.v1='CANCELADA';original.status='CANCELADA';fluxo.versao_em_preparacao_id=null;},
            iniciarPreparacao:async(_tx:unknown,b:typeof base)=>{assert.equal(b.id,'v0');return {id:'r2'};},
            revalidarAgendaRevisao:async()=>{copias.push('revalidado');},
            snapshotPreparacao:async(_tx:unknown,_r:unknown,v:typeof original)=>v.snapshot,
        },
        '../../clientes/repositories':{registrarAuditoria:async(a:Record<string,unknown>)=>{auditorias.push(a);},registrarEventoHistorico:async()=>{}},
    });
    const operar=mod.operarContrato as (id:string,body:object,token:string,ctx:object)=>Promise<{versaoId:string;reutilizado?:boolean}>;
    return {original,versoes,edicoes,fluxo,sqls,auditorias,tx,operar,copias,
        substituir:(extra:object={})=>operar('v1',{acao:'substituir_preparacao',motivo:'Correção solicitada',chaveCriacao:chave,...extra},'sintetico',{requestId:chave}),
        assinarAntes:()=>{original.status='ASSINADA';edicoes.v1='CONCLUIDA';contratoStatus='ASSINADO';},
    };
}
for(const estado of ['ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE'])test(`${estado}: substitui preparação e preserva snapshot/hash/provas sem Festa ou ocupação`,async()=>{
    const a=ambiente(estado),antes=structuredClone(a.original);
    assert.equal((await a.substituir()).versaoId,'v2');
    assert.equal(a.edicoes.v1,'CANCELADA');assert.equal(a.original.status,'CANCELADA');
    assert.deepEqual(a.original.snapshot,antes.snapshot);assert.equal(a.original.snapshotHash,antes.snapshotHash);
    assert.equal(a.edicoes.v2,'EM_ELABORACAO');assert.equal(a.fluxo.versao_vigente_id,null);assert.equal(a.fluxo.versao_em_preparacao_id,'v2');
    assert(!a.sqls.some(s=>/(?:UPDATE|INSERT INTO|DELETE FROM) (?:festas|fechamentos|pagamentos|contrato_documentos|contrato_assinaturas)\b/.test(s)));
    assert(a.sqls.indexOf('SELECT id FROM contratos WHERE id=$1 FOR UPDATE')<a.sqls.findIndex(s=>s.startsWith('UPDATE contrato_edicoes')));
    assert((await a.substituir()).reutilizado);assert.equal(a.versoes.length,2);
    await assert.rejects(a.substituir({motivo:'Outra intenção'}),/outro pedido/);
    await assert.rejects(a.substituir({chaveCriacao:'22222222-2222-4222-8222-222222222222'}),/preparação mudou/);
    await assert.rejects(a.operar('v2',{acao:'liberar',revisao:1},'sintetico',{}),/assinatura Kidmais/);
    await assert.rejects(a.operar('v2',{acao:'assinar',revisao:1,documentoId:chave,chaveIdempotencia:chave},'sintetico',{}),/Revise e aprove o documento exato/);
    // Simula somente a assinatura externa ao cenário; a liberação executa o serviço real.
    a.edicoes.v2='ASSINADA_KIDMAIS';
    await a.operar('v2',{acao:'liberar',revisao:1},'sintetico',{});
    assert.equal(a.edicoes.v2,'AGUARDANDO_CLIENTE');assert.equal(a.edicoes.v1,'CANCELADA');
});
test('substituir revisão congelada de contrato com vigência conserva base/Festa e dados propostos',async()=>{
    const a=ambiente('AGUARDANDO_CLIENTE',true),base=structuredClone(a.versoes[0]);
    await a.substituir();
    assert.deepEqual(a.versoes[0],base);assert.equal(a.fluxo.versao_vigente_id,'v0');
    assert.equal(a.edicoes.v1,'CANCELADA');assert.equal(a.edicoes.v3,'EM_ELABORACAO');
    assert.deepEqual(a.copias,[{op:{dataEvento:'2026-10-20',convidados:90},itens:[{adicionalId:'extra',quantidade:2}]},'revalidado']);
    assert(!a.sqls.some(s=>/(?:UPDATE|INSERT INTO|DELETE FROM) (?:festas|fechamentos|pagamentos)\b/.test(s)));
});
test('motivo inválido e assinatura cliente concorrente recusam substituição antes de escrever',async()=>{
    const a=ambiente();await assert.rejects(a.substituir({motivo:' '}));assert.equal(a.sqls.length,0);
    a.assinarAntes();await assert.rejects(a.substituir(),/preparação mudou/);assert.equal(a.versoes.length,1);
});
test('elaboração mantém edição normal, não substituição; versão congelada não aceita edição direta',async()=>{
    await assert.rejects(ambiente('EM_ELABORACAO').substituir(),/preparação mudou/);
    const a=ambiente();await assert.rejects(a.operar('v1',{acao:'salvar',revisao:1,observacoesDocumentais:'Texto'},'sintetico',{}),/não pode ser editada/);
});
test('V2 antes da primeira formalização aceita salvar sem editar snapshot da V1',async()=>{
    const a=ambiente(),antes=structuredClone(a.original.snapshot);await a.substituir();
    await a.operar('v2',{acao:'salvar',revisao:1,observacoesDocumentais:'Texto da revisão'},'sintetico',{});
    assert.equal(a.edicoes.v2,'EM_ELABORACAO');assert.deepEqual(a.original.snapshot,antes);
    assert.equal((a.versoes[1].snapshot as unknown as {documental:{observacoes:string}}).documental.observacoes,'Texto da revisão');
});
test('token autenticado da versão encerrada recusa leitura/aceite com orientação para revisão recente',async()=>{
    const a=ambiente();await a.substituir();
    const mod=carregar('lib/contratos/services/contrato-publico.service.ts',{
        '../repositories':{buscarContratoPorId:async()=>({id:'c',fechamentoId:'f'}),buscarVersaoPorId:async()=>a.original},
        '../../fechamentos/repositories':{buscarFechamentoPorIdParaAtualizacao:async()=>({id:'f'})},
        './acesso-token':{validarContratoAcessoToken:()=>({versaoId:'v1'})},
        './administrativo.service':{edicaoDaVersao:async()=>({estado:a.edicoes.v1})},
        './errors':{ContratoServiceError:Falha},
    },'\nexport { carregarContratoComVersao as carregarParaTeste };');
    const carregarPublico=mod.carregarParaTeste as (...args:unknown[])=>Promise<unknown>;
    for(const lock of [false,true])await assert.rejects(carregarPublico('c',a.tx,lock,'token-autenticado-sintetico'),/revisão mais recente/);
});
