/* eslint-disable @typescript-eslint/no-require-imports */
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const TABELAS=Object.freeze(['empresa_assinaturas','assinatura_contratacoes','assinatura_fundadores','assinatura_isencoes']);
/** Mantém digest integral e digest comercial. Só três metadados da assinatura
 * são separados; situação, período, preço, plano e vínculos continuam protegidos. */
function digests(tabela, linhas) {
    assert.ok(TABELAS.includes(tabela));
    const serializar=operacional=>linhas.map(({linha})=>{
        const valor=JSON.parse(linha);
        if(operacional&&tabela==='empresa_assinaturas')
            for(const chave of ['sincronizado_em','atualizado_em','versao'])delete valor[chave];
        return JSON.stringify(Object.fromEntries(Object.keys(valor).sort().map(k=>[k,valor[k]])));
    }).sort();
    const hash=valores=>createHash('sha256').update(JSON.stringify(valores)).digest('hex');
    return {integral:hash(serializar(false)),comercial:hash(serializar(true))};
}
async function snapshotPreservacao(db,empresa) {
    const resultado={};
    for(const tabela of TABELAS){
        const linhas=(await db.query(`SELECT to_jsonb(t)::text linha FROM ${tabela} t WHERE empresa_id<>$1`,[empresa])).rows;
        resultado[tabela]=digests(tabela,linhas);
    }
    return resultado;
}
function compararPreservacao(antes,depois) {
    const tabelas={};
    for(const tabela of TABELAS){
        assert.match(antes[tabela]?.integral??'',/^[a-f0-9]{64}$/);
        assert.match(antes[tabela]?.comercial??'',/^[a-f0-9]{64}$/);
        assert.match(depois[tabela]?.integral??'',/^[a-f0-9]{64}$/);
        assert.match(depois[tabela]?.comercial??'',/^[a-f0-9]{64}$/);
        tabelas[tabela]={integral:antes[tabela].integral===depois[tabela].integral,
            comercial:antes[tabela].comercial===depois[tabela].comercial};
    }
    return {tabelas,comercialPreservado:Object.values(tabelas).every(t=>t.comercial),
        integralPreservado:Object.values(tabelas).every(t=>t.integral)};
}
module.exports={digests,snapshotPreservacao,compararPreservacao};
