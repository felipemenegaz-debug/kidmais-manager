/* eslint-disable @typescript-eslint/no-require-imports */
/** Rodada única autorizada: cliente de exemplo, mensalidade 118,20, pagamento simulado e cancelamento.
 * Só sandbox, nenhuma conexão SQL/email. Intenções persistidas antes de POST; nunca repete criação incerta.
 */
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const arquivo=path.resolve(__dirname,'../.local-assinatura-sandbox/ciclo-assinatura.json');
async function main(){
    const {configuracaoAsaas,criarClienteAsaas}=await import('../lib/assinatura/asaas.ts');
    const cfg=configuracaoAsaas(process.env);assert.ok(cfg.ligado,'CONFIGURACAO_SANDBOX_INVALIDA');
    let r;
    if(fs.existsSync(arquivo))r=JSON.parse(fs.readFileSync(arquivo,'utf8'));
    else {r={referencia:`kidmais-homologacao-${randomUUID()}`,inicio:new Date().toISOString(),valorCentavos:11820};fs.writeFileSync(arquivo,JSON.stringify(r,null,2),{flag:'wx'});}
    const salvar=()=>fs.writeFileSync(arquivo,JSON.stringify(r,null,2));
    if(r.concluido){console.log('PASS rodada já concluída; nenhuma mutação repetida.');return;}
    const p=criarClienteAsaas(cfg.config,{fetch:async(url,init)=>{
        assert.equal(new URL(url).origin,'https://api-sandbox.asaas.com');
        return fetch(url,{...init,redirect:'error'});
    }});
    const conferirSub=s=>{assert.ok(s&&!s.deleted,'ASSINATURA_AUSENTE');assert.equal(s.externalReference,r.referencia);assert.equal(s.customer,r.clienteId);assert.equal(s.valorCentavos,r.valorCentavos);assert.equal(s.cycle,'MONTHLY');};
    const conferirPagamento=x=>{assert.ok(x&&!x.deleted,'COBRANCA_AUSENTE');assert.equal(x.assinaturaId,r.assinaturaId);assert.equal(x.clienteId,r.clienteId);assert.equal(x.valorCentavos,r.valorCentavos);};
    let erro;
    try{
        if(!r.clienteId){
            let c=await p.buscarClientePorReferencia(r.referencia);
            if(!c){assert.ok(!r.intencaoCliente,'CLIENTE_INCERTO_RECONSULTAR');r.intencaoCliente=true;salvar();
                // Documento do exemplo público da referência oficial Asaas; nenhum documento da Kidmais.
                c=await p.criarCliente({nome:'TESTE Kidmais Manager - Homologacao',cpfCnpj:'24971563792',referencia:r.referencia});}
            assert.equal(c.externalReference,r.referencia);r.clienteId=c.id;salvar();
        }
        if(!r.assinaturaId){
            const existentes=await p.listarAssinaturasPorReferencia(r.referencia);assert.ok(existentes.length<=1,'MULTIPLAS_ASSINATURAS');
            let s=existentes[0];
            if(!s){assert.ok(!r.intencaoAssinatura,'ASSINATURA_INCERTA_RECONSULTAR');r.intencaoAssinatura=true;salvar();
                const dia=new Date();dia.setUTCDate(dia.getUTCDate()+1);
                s=await p.criarAssinatura({cliente:r.clienteId,valorCentavos:r.valorCentavos,ciclo:'MENSAL',vencimento:dia.toISOString().slice(0,10),referencia:r.referencia,descricao:'TESTE - Kidmais Manager Essencial Fundador - sem cobranca real'});}
            conferirSub(s);r.assinaturaId=s.id;salvar();
        }
        conferirSub(await p.obterAssinatura(r.assinaturaId));
        let parcelas=[];
        for(let i=0;i<8;i++){
            parcelas=await p.listarCobrancasDaAssinatura(r.assinaturaId);
            if(parcelas.some(x=>!x.deleted))break;
            await new Promise(ok=>setTimeout(ok,1000));
        }
        const primeira=parcelas.filter(x=>!x.deleted).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];conferirPagamento(primeira);
        r.pagamentoId=primeira.id;r.statusAntes=primeira.status;salvar();
        if(!['RECEIVED','CONFIRMED'].includes(primeira.status)){
            assert.ok(!r.intencaoConfirmacao,'CONFIRMACAO_INCERTA_RECONSULTAR');r.intencaoConfirmacao=true;salvar();
            const resposta=await fetch(`https://api-sandbox.asaas.com/v3/sandbox/payment/${encodeURIComponent(r.pagamentoId)}/confirm`,{method:'POST',headers:{access_token:cfg.config.apiKey,'User-Agent':'kidmais-manager-homologacao','Content-Type':'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});
            if(!resposta.ok)throw Object.assign(Error('CONFIRMACAO_RECUSADA'),{status:resposta.status});
        }
        let confirmado;
        for(let i=0;i<10;i++){
            confirmado=await p.obterCobranca(r.pagamentoId);conferirPagamento(confirmado);
            if(['RECEIVED','CONFIRMED'].includes(confirmado.status))break;
            await new Promise(ok=>setTimeout(ok,1000));
        }
        assert.ok(['RECEIVED','CONFIRMED'].includes(confirmado.status),'PAGAMENTO_NAO_CONFIRMADO');
        r.statusPago=confirmado.status;salvar();
        console.log('PASS assinatura mensal, valor/vínculos e confirmação simulada do pagamento.');
    }catch(e){erro=e;r.falha={codigo:e.code??e.name,status:e.status??null};salvar();}
    finally{
        if(r.assinaturaId){
            try{
                const s=await p.obterAssinatura(r.assinaturaId);
                if(s&&!s.deleted){conferirSub(s);r.intencaoCancelamento=true;salvar();assert.ok((await p.removerAssinatura(r.assinaturaId)).removida);}
                const depois=await p.obterAssinatura(r.assinaturaId);assert.ok(!depois||depois.deleted,'RECORRENCIA_AINDA_ATIVA');r.cancelada=true;
                if(r.statusPago){const pago=await p.obterCobranca(r.pagamentoId);conferirPagamento(pago);assert.ok(['RECEIVED','CONFIRMED'].includes(pago.status));r.pagamentoPreservado=true;}
                salvar();console.log('PASS recorrência encerrada; cobrança paga simulada preservada quando confirmada.');
            }catch(e){r.cancelamentoPendente=true;salvar();erro??=e;}
        }
    }
    if(erro){console.error(JSON.stringify({resultado:'INCOMPLETO',status:erro.status??null,codigo:erro.code??erro.name,cancelada:r.cancelada===true}));process.exitCode=2;return;}
    r.concluido=true;delete r.falha;salvar();
    console.log(JSON.stringify({resultado:'PASS',valorCentavos:r.valorCentavos,statusPago:r.statusPago,cancelada:r.cancelada,pagamentoPreservado:r.pagamentoPreservado,webhook:'NAO_TESTADO',bancoKidmais:'NAO_ACESSADO'}));
}
main().catch(()=>{console.error('Teste interrompido; consultar evidência local sem credenciais.');process.exitCode=1;});
