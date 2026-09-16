// Navegador real, aplicação local e todas as APIs simuladas. Não conecta a banco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

test('lixeira: motivo, duas etapas, cancelamento, erro, retry, exclusão e restauração', {timeout:120000}, async()=>{
    const origin='http://127.0.0.1:3137',id='11111111-1111-4111-8111-111111111111';
    const server=spawn(process.execPath,[path.resolve('node_modules/next/dist/bin/next'),'start','-p','3137'],{
        env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',DATABASE_URL:'postgresql://invalid:invalid@127.0.0.1:1/nao_usar'},stdio:'ignore',windowsHide:true,
    });
    let browser;
    try {
        let ready=false;
        for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('Servidor local encerrou');try{await fetch(origin);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
        assert(ready,'Servidor local disponível');
        browser=await chromium.launch({headless:true,channel:'msedge'});
        const context=await browser.newContext();
        const cliente={id,nomeCompleto:'Cliente Sintético Lixeira',status:'ATIVO',criadoEm:'2026-09-16T12:00:00Z',atualizadoEm:'2026-09-16T12:00:00Z'};
        const registro=()=>({id,nome:cliente.nomeCompleto,status:cliente.status,atualizadoEm:cliente.atualizadoEm,situacao:cliente.status==='ATIVO'?'Ativo':'Na lixeira',contato:null,email:null,quando:null,responsavel:null,motivo:null,retencao90Dias:false});
        const posts=[],unexpected=[],errors=[];let falhar=true;
        await context.route('**/*',async route=>{
            const r=route.request(),url=new URL(r.url());
            if(url.origin!==origin)return route.abort();
            if(!url.pathname.startsWith('/api/'))return route.continue();
            const ok=data=>route.fulfill({json:{ok:true,data}});
            if(url.pathname==='/api/admin/autenticacao')return ok({usuarioId:id,nome:'Operador Sintético',papel:'REPRESENTANTE_AUTORIZADO',csrf:'sintetico'});
            if(url.pathname===`/api/admin/clientes/${id}/lixeira`){
                if(r.method()==='GET')return ok(registro());
                assert.equal(r.method(),'POST');const body=r.postDataJSON();posts.push(body);
                if(falhar){falhar=false;return route.fulfill({status:503,json:{ok:false,erro:'Falha simulada. Tente novamente.'}});}
                assert(body.motivo.trim().length>=3);
                if(body.acao!=='RESTAURAR')assert(body.confirmarRemocao&&body.confirmarHistorico);
                await new Promise(resolve=>setTimeout(resolve,200));
                cliente.status=body.acao==='RESTAURAR'?'ATIVO':'INATIVO';cliente.atualizadoEm='2026-09-16T13:00:00Z';return ok({reutilizado:false});
            }
            if(url.pathname===`/api/admin/clientes/${id}`)return ok({cliente,aniversariantes:[],responsaveis:[],cadastro:{completoParaContrato:true,camposFaltantes:[]}});
            if(url.pathname==='/api/admin/clientes/lixeira')return ok(cliente.status==='INATIVO'?[registro()]:[]);
            if(url.pathname==='/api/admin/clientes')return ok(cliente.status==='ATIVO'?[{cliente,cadastroCompleto:true,camposFaltantes:[]}]:[]);
            unexpected.push(url.pathname);return route.abort();
        });
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.goto(origin+'/clientes/'+id);
        const panel=page.getByRole('region',{name:'Situação do cadastro'});
        await panel.getByRole('button',{name:'Excluir / Arquivar cliente'}).click();
        await panel.getByRole('button',{name:'Continuar para segunda confirmação'}).click();
        await panel.getByRole('alert').filter({hasText:'pelo menos 3 caracteres'}).waitFor();assert.equal(posts.length,0);
        const motivo=panel.getByRole('textbox',{name:/Motivo obrigatório/});await motivo.fill('Cadastro sintético duplicado');
        await panel.getByRole('button',{name:'Continuar para segunda confirmação'}).click();
        await panel.getByText('Cliente: '+cliente.nomeCompleto,{exact:true}).waitFor();
        await panel.getByText('Ação: Excluir logicamente',{exact:true}).waitFor();
        await panel.getByText('Motivo: Cadastro sintético duplicado',{exact:true}).waitFor();assert.equal(posts.length,0);
        await panel.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(posts.length,0);
        await panel.getByRole('button',{name:'Excluir / Arquivar cliente'}).click();await motivo.fill('Cadastro sintético duplicado');
        await panel.getByRole('button',{name:'Continuar para segunda confirmação'}).click();
        await panel.getByRole('button',{name:'Confirmar exclusão lógica'}).evaluate(el=>{el.click();el.click();});
        await panel.getByRole('alert').filter({hasText:'Falha simulada'}).waitFor();assert.equal(cliente.status,'ATIVO');
        await panel.getByRole('button',{name:'Confirmar exclusão lógica'}).click();
        await panel.getByRole('button',{name:'Restaurar cliente'}).waitFor();
        assert.equal(posts.length,2);assert.equal(posts[0].chave,posts[1].chave);
        await page.goto(origin+'/clientes');await page.getByRole('heading',{name:'Nenhum cliente encontrado'}).waitFor();
        assert.equal(await page.locator(`a[href="/clientes/${id}"]`).count(),0);
        await page.goto(origin+'/clientes/lixeira');await page.getByRole('heading',{name:cliente.nomeCompleto}).waitFor();
        await page.getByRole('button',{name:'Restaurar cliente',exact:true}).click();
        await page.getByRole('textbox',{name:/Motivo obrigatório/}).fill('Restaurar cadastro sintético');
        await page.getByRole('button',{name:'Restaurar cliente',exact:true}).click();
        await page.getByText('Nenhum cliente na lixeira ou arquivado.').waitFor();
        await page.goto(origin+'/clientes');await page.locator(`a[href="/clientes/${id}"]`).first().waitFor();
        assert.equal(cliente.id,id);assert.equal(posts.length,3);assert.equal(posts[2].acao,'RESTAURAR');
        await page.setViewportSize({width:390,height:844});await page.goto(origin+'/clientes/'+id);
        await panel.getByRole('button',{name:'Excluir / Arquivar cliente'}).click();
        await panel.getByRole('combobox',{name:'Ação'}).selectOption('ARQUIVAR');
        await motivo.fill('Arquivamento sintético');
        assert(await motivo.isVisible());
        await panel.getByRole('button',{name:'Continuar para segunda confirmação'}).click();
        await panel.getByText('Ação: Arquivar',{exact:true}).waitFor();
        await panel.getByRole('button',{name:'Confirmar arquivamento'}).click();
        await panel.getByRole('button',{name:'Restaurar cliente'}).waitFor();assert.equal(posts[3].acao,'ARQUIVAR');
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    } finally {if(browser)await browser.close();server.kill();}
});
