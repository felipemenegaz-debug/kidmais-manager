/* eslint-disable @typescript-eslint/no-require-imports */
/** UI com login/tenant/leitura reais no banco sintético fixo. Checkout interceptado no navegador.
 * Não é homologação HTTP do Asaas. Não restaura nem apaga bancos. Sem .env ou credenciais externas.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const root = path.resolve(__dirname,'..');
const dbname='kidmais_renovacao_075_completa', papel='kidmais_renovacao_075';
const base='http://localhost:3195';
const out=path.join(root,'.local-assinatura-interface');
async function main() {
    assert.equal(process.env.KIDMAIS_UI_AUTORIZACAO,`127.0.0.1:55475/${dbname}`);
    for(const f of ['.env','.env.local','.env.production','.env.production.local','.env.development','.env.development.local']) assert.ok(!fs.existsSync(path.join(root,f)),'Arquivo env recusado');
    await new Promise((ok,no)=>{const s=require('node:net').createServer();s.once('error',no);s.listen(3195,'127.0.0.1',()=>s.close(ok));});
    const { chromium }=require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
    const { criarHashSenha }=await import('../lib/autenticacao/senha.ts');
    const c=new Client({host:'127.0.0.1',port:55475,database:dbname,user:papel,ssl:false,password:async()=>{throw Error('Senha de banco recusada');}});
    let browser,server,log;
    try {
        await c.connect();
        const ident=(await c.query("SELECT current_database() db,current_user papel,inet_server_port() porta,host(inet_server_addr()) endereco,current_setting('cluster_name') cluster")).rows[0];
        assert.deepEqual(ident,{db:dbname,papel,porta:55475,endereco:'127.0.0.1',cluster:papel});
        const pending=(await c.query("SELECT c.empresa_id,c.valor_final_centavos FROM assinatura_contratacoes c JOIN empresas e ON e.id=c.empresa_id WHERE c.estado='EM_ABERTO' AND e.nome='Buffet sintético' ORDER BY c.id LIMIT 1")).rows[0];
        const cancelled=(await c.query("SELECT a.empresa_id FROM empresa_assinaturas a JOIN empresas e ON e.id=a.empresa_id WHERE a.situacao='CANCELADA_FIM_PERIODO' AND e.nome='Buffet sintético'")).rows;
        assert.ok(pending);assert.equal(cancelled.length,1);
        const password=`Sintetica-${randomBytes(15).toString('hex')}`,email=`ui-${randomBytes(8).toString('hex')}@example.invalid`;
        await c.query('BEGIN');
        const uid=(await c.query("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'Gestão UI sintética',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id",[email,await criarHashSenha(password)])).rows[0].id;
        await c.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1",[uid]);
        for(const id of [pending.empresa_id,cancelled[0].empresa_id]) {
            await c.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())",[id,uid]);
            await c.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2",[id,uid]);
        }
        await c.query('COMMIT');
        const before=JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows);
        fs.mkdirSync(out,{recursive:true});log=fs.openSync(path.join(out,'next.log'),'a');
        const env={...process.env};
        for(const k of Object.keys(env)) if(/^(DATABASE_|PG|ASAAS_|RESEND_|EMAIL_|ADMIN_AUTH_|OPENAI_|RENDER|KIDMAIS_DEPLOY_ENV)/.test(k)) delete env[k];
        Object.assign(env,{DATABASE_URL:`postgresql://${papel}@127.0.0.1:55475/${dbname}`,DATABASE_SSL:'false',ADMIN_AUTH_SECRET:randomBytes(32).toString('hex'),ADMIN_AUTH_ORIGIN:base,EMAIL_PROVIDER:'desativado',NODE_ENV:'development',KIDMAIS_FESTA_ISOLADO:'true',KIDMAIS_FESTA_AMBIENTE:'automated',NEXT_TELEMETRY_DISABLED:'1',ASSINATURA_PLANOS_ATIVOS:'true',ASAAS_AMBIENTE:'sandbox',ASAAS_API_KEY:'$aact_hmlg_fixture_sem_valor',ASAAS_WEBHOOK_TOKEN:'fixture-sintetica-sem-valor-32-caracteres'});
        server=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'dev','--webpack','-H','127.0.0.1','-p','3195'],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true});
        for(let i=0;i<100;i++) {
            if(server.exitCode!==null) throw Error('Servidor encerrou');
            if(await fetch(`${base}/admin/login`,{signal:AbortSignal.timeout(3000)}).then(r=>r.ok).catch(()=>false)) break;
            if(i===99) throw Error('Servidor não iniciou');
            await new Promise(r=>setTimeout(r,300));
        }
        browser=await chromium.launch({headless:true,channel:'chrome'});
        const semJs=await browser.newContext({javaScriptEnabled:false});
        const nativa=await semJs.newPage();
        await nativa.goto(`${base}/admin/login`);
        await nativa.getByLabel('Email',{exact:true}).fill('sem-js@example.invalid');
        await nativa.getByLabel('Senha',{exact:true}).fill('fixture-sem-js');
        let submissao;
        await nativa.route('**/admin/login*',async r=>{submissao=r.request();await r.fulfill({status:200,body:'Teste sintético interceptado'});});
        await nativa.getByRole('button',{name:'Entrar',exact:true}).click();
        await nativa.waitForLoadState();
        assert.equal(submissao.method(),'POST');assert.equal(new URL(submissao.url()).search,'');
        await semJs.close();
        const ctx=await browser.newContext({viewport:{width:1440,height:1000}});ctx.setDefaultTimeout(30000);
        await ctx.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
        const page=await ctx.newPage();
        await page.goto(`${base}/admin/login`);
        await page.waitForFunction(()=>{
            const f=document.querySelector('form');
            return f && Object.keys(f).some(k=>k.startsWith('__reactProps$') && typeof f[k]?.onSubmit==='function');
        });
        await page.getByLabel('Email',{exact:true}).fill(email);
        await page.getByLabel('Senha',{exact:true}).fill(password);
        await page.getByRole('button',{name:'Entrar',exact:true}).click();
        await page.waitForURL(u=>!u.pathname.includes('/login'));
        async function select(id) {
            const s=await ctx.request.get(`${base}/api/admin/autenticacao`).then(r=>r.json());
            const r=await ctx.request.post(`${base}/api/admin/autenticacao`,{headers:{origin:base,'x-csrf-token':s.data.csrf,'x-kidmais-sessao':s.data.sessaoId},data:{acao:'selecionar-empresa',empresaId:id}});
            assert.equal(r.status(),200);
            await page.goto(`${base}/admin/assinatura`);
        }
        await select(pending.empresa_id);
        await page.getByRole('button',{name:/Retomar essencial/i}).waitFor();
        let posts=0;
        await page.route('**/api/admin/assinatura/checkout',async route=>{
            posts++;const body=route.request().postDataJSON();
            assert.equal(body.plano,'essencial');assert.equal(body.ciclo,'MENSAL');assert.equal(body.valorEsperadoCentavos,pending.valor_final_centavos);
            await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data:{urlPagamento:'https://pagamento.example.invalid/fixture',vencimento:'2026-11-09',ciclo:'MENSAL',reaproveitada:true}})});
        });
        await page.getByRole('button',{name:/Retomar essencial/i}).click();
        await page.getByText('Processando: o acesso é liberado quando o pagamento for confirmado.',{exact:true}).waitFor();
        assert.equal(posts,1);
        await page.screenshot({path:path.join(out,'pagamento-pendente.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:path.join(out,'pagamento-pendente-mobile.png'),fullPage:true});
        await select(cancelled[0].empresa_id);
        await page.getByText(/cancelad/i).first().waitFor();
        assert.equal(await page.getByRole('button',{name:/Cancelar ao fim/}).count(),0);
        await page.screenshot({path:path.join(out,'cancelada-mobile.png'),fullPage:true});
        assert.equal(JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows),before,'Navegar/retornar não deve liberar acesso nem mudar assinatura');
        fs.writeFileSync(path.join(out,'resultado.json'),JSON.stringify({ok:true,login:'real sintético',tenant:'real',consulta:'real',checkout:'resposta interceptada no navegador',posts,assinaturasPreservadas:true,overflowMobile:false},null,2));
        console.log('PASS login, troca de empresa, leitura real, retomada com preço correto, pagamento pendente, mobile e cancelada; assinaturas preservadas. Checkout simulado.');
    } finally {
        await browser?.close();
        if(server&&server.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r));}
        if(log!==undefined)fs.closeSync(log);
        await c.query('ROLLBACK').catch(()=>{});await c.end();
    }
}
main().catch(e=>{console.error('FAIL',e.code??e.name,String(e.message).slice(0,1200));process.exitCode=1;});
