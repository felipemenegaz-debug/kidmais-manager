/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {digests,snapshotPreservacao,compararPreservacao}=require('./assinatura-preservacao.cjs');
const linha=valor=>({linha:JSON.stringify(valor)});
const assinatura={empresa_id:'sintetica',situacao:'ATIVA',plano:'ESSENCIAL',periodo_atual_fim:'2026-11-09',
    provedor_situacao:'ACTIVE',contratacao_atual_id:'contrato',sincronizado_em:'antes',atualizado_em:'antes',versao:1};
test('reconciliação só de metadados muda digest integral e preserva condições',()=>{
    const a=digests('empresa_assinaturas',[linha(assinatura)]);
    const b=digests('empresa_assinaturas',[linha({...assinatura,sincronizado_em:'depois',atualizado_em:'depois',versao:2})]);
    assert.notEqual(a.integral,b.integral);assert.equal(a.comercial,b.comercial);
});
test('nenhuma mudança de acesso, plano, período, provedor ou vínculo passa como operacional',()=>{
    const a=digests('empresa_assinaturas',[linha(assinatura)]);
    for(const troca of [{situacao:'ENCERRADA'},{plano:'PREMIUM'},{periodo_atual_fim:'2026-10-09'},
        {provedor_situacao:'DELETED'},{contratacao_atual_id:'outro'},{novo_campo_comercial:19700}])
        assert.notEqual(a.comercial,digests('empresa_assinaturas',[linha({...assinatura,...troca})]).comercial);
});
test('contratos, fundador e isenções protegem todas as colunas, até nomes de metadados',()=>{
    for(const tabela of ['assinatura_contratacoes','assinatura_fundadores','assinatura_isencoes']){
        const a=digests(tabela,[linha({valor:11820,atualizado_em:'antes'})]);
        assert.notEqual(a.comercial,digests(tabela,[linha({valor:11820,atualizado_em:'depois'})]).comercial);
        assert.notEqual(a.comercial,digests(tabela,[linha({valor:19700,atualizado_em:'antes'})]).comercial);
    }
});
test('digest ignora ordem das linhas/chaves mas detecta inclusão, remoção e duplicação',()=>{
    const a=digests('empresa_assinaturas',[linha({a:1,b:2}),linha({id:2})]);
    assert.deepEqual(a,digests('empresa_assinaturas',[linha({id:2}),linha({b:2,a:1})]));
    for(const rows of [[linha({a:1,b:2})],[linha({a:1,b:2}),linha({id:2}),linha({id:2})]])
        assert.notEqual(a.comercial,digests('empresa_assinaturas',rows).comercial);
});
test('snapshot é restrito à lista de tabelas e exclui só a fixture; baseline ausente é recusado',async()=>{
    const chamadas=[];
    const a=await snapshotPreservacao({query:async(sql,args)=>{chamadas.push({sql,args});return {rows:[]};}},'fixture');
    assert.equal(chamadas.length,4);for(const c of chamadas){assert.match(c.sql,/WHERE empresa_id<>\$1$/);assert.deepEqual(c.args,['fixture']);}
    assert.equal(compararPreservacao(a,a).comercialPreservado,true);
    assert.throws(()=>compararPreservacao({},a));assert.throws(()=>digests('usuarios_administrativos',[]));
});
