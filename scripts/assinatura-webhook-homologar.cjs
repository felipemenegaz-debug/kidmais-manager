/* eslint-disable @typescript-eslint/no-require-imports */
// Rodada autorizada por Felipe: banco fixo sintético, sandbox, túnel com uma única rota.
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { criarPorta, ROTA } = require('./assinatura-webhook-porta.cjs');
const raiz = path.resolve(__dirname, '..'), dir = path.join(raiz, '.local-assinatura-webhook');
const banco = 'kidmais_webhook_20261009_sintetica', papel = 'kidmais_renovacao_075';
const base = 'http://localhost:3195';
const pausa = ms => new Promise(ok => setTimeout(ok, ms));
function documentoSintetico() {
    let d = Array.from(randomBytes(8), n => n % 10).join('') + '0001';
    for (const pesos of [[5,4,3,2,9,8,7,6,5,4,3,2],[6,5,4,3,2,9,8,7,6,5,4,3,2]]) {
        const resto = [...d].reduce((s, n, i) => s + Number(n) * pesos[i], 0) % 11;
        d += resto < 2 ? '0' : String(11 - resto);
    }
    assert.notEqual(d, '20119900000160'); return d;
}
async function main() {
    assert.equal(process.env.KIDMAIS_WEBHOOK_AUTORIZACAO, `127.0.0.1:55475/${banco}`);
    assert.equal(process.env.ASAAS_AMBIENTE, 'sandbox');
    for (const nome of ['.env','.env.local','.env.production','.env.production.local','.env.development','.env.development.local'])
        assert.ok(!fs.existsSync(path.join(raiz, nome)), 'ARQUIVO_ENV_RECUSADO');
    assert.ok(!process.env.DATABASE_URL && !Object.keys(process.env).some(k => /^PG/.test(k)), 'CONEXAO_HERDADA_RECUSADA');
    const { configuracaoAsaas, criarClienteAsaas } = await import('../lib/assinatura/asaas.ts');
    const { criarHashSenha } = await import('../lib/autenticacao/senha.ts');
    const cfg = configuracaoAsaas(process.env); assert.ok(cfg.ligado, 'SANDBOX_NAO_CONFIGURADO');
    const p = criarClienteAsaas(cfg.config);
    const arquivo = path.join(dir, 'rodada.json');
    fs.mkdirSync(dir, { recursive: true });
    const r = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8'))
        : { empresa: randomUUID(), usuario: randomUUID(), documento: documentoSintetico(), inicio: new Date().toISOString() };
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2));
    if (r.concluido) { console.log('PASS rodada concluída; nenhuma mutação repetida.'); return; }
    // Não reiniciar uma rodada já encerrada no provedor como se fosse nova.
    assert.ok(!r.cancelada && !r.intencaoCheckout, 'RODADA_EXISTENTE_EXIGE_RETOMADA_REVISADA'); salvar();
    const exe = path.join(dir, 'cloudflared.exe');
    const integridade = JSON.parse(fs.readFileSync(path.join(dir, 'cloudflared-integridade.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), integridade.sha256);
    const c = new Client({ host:'127.0.0.1', port:55475, database:banco, user:papel, ssl:false,
        connectionTimeoutMillis:5000, password:async () => { throw Error('SENHA_DB_RECUSADA'); } });
    let server, tunnel, porta, ctx, log, erro;
    const arquivosNext = ['tsconfig.json', 'next-env.d.ts'].map(n => [n, fs.readFileSync(path.join(raiz,n))]);
    const api = async (caminho, method='GET', body) => {
        assert.ok(/^\/(webhooks|sandbox\/payment)(\/|\?|$)/.test(caminho));
        const res = await fetch('https://api-sandbox.asaas.com/v3' + caminho, {
            method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{ access_token:cfg.config.apiKey, 'User-Agent':'kidmais-webhook-homologacao', 'Content-Type':'application/json' },
            ...(body ? { body:JSON.stringify(body) } : {}),
        });
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP_RECUSADO'), { status:res.status, operacao:method + ' ' + caminho.split('/')[1] });
        return res.json();
    };
    const webhookConfere = w => { assert.ok(w); assert.equal(w.name, r.webhookNome); assert.equal(w.url, r.url + ROTA); };
    const subConfere = s => { assert.ok(s); assert.equal(s.externalReference, r.empresa); assert.equal(s.valorCentavos,11820); };
    try {
        await c.connect();
        const identidade = (await c.query("SELECT current_database() db,current_user papel,inet_server_port() porta,host(inet_server_addr()) endereco,current_setting('cluster_name') cluster,EXISTS(SELECT 1 FROM pg_database WHERE datname='kidmais_manager') tem_real")).rows[0];
        assert.deepEqual(identidade,{db:banco,papel,porta:55475,endereco:'127.0.0.1',cluster:papel,tem_real:false});
        await c.query("SET statement_timeout='15s'");
        const senha = `Sintetica-${randomBytes(20).toString('hex')}`, email = `webhook-${r.usuario}@example.invalid`;
        await c.query('BEGIN');
        if (!(await c.query('SELECT 1 FROM empresas WHERE id=$1',[r.empresa])).rowCount) {
            await c.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,'TESTE Kidmais Webhook','PROVISIONAMENTO')",[r.empresa,`wh-${r.empresa}`]);
            await c.query("UPDATE empresas SET status='ATIVA' WHERE id=$1",[r.empresa]);
            await c.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Webhook Sintética',$3,'REPRESENTANTE_AUTORIZADO',true)",[r.usuario,email,await criarHashSenha(senha)]);
            await c.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())",[r.empresa,r.usuario]);
            await c.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2",[r.empresa,r.usuario]);
            // Trial já encerrado na fixture: demonstra passagem de consulta para acesso completo após pagamento.
            await c.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 day',$2)",[r.empresa,r.documento]);
        } else {
            await c.query('UPDATE usuarios_administrativos SET senha_hash=$2 WHERE id=$1',[r.usuario,await criarHashSenha(senha)]);
        }
        await c.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1",[r.usuario]);
        await c.query('COMMIT'); r.fixture=true; salvar();
        for (const port of [3195,3196]) await new Promise((ok,no) => {
            const probe=require('node:net').createServer(); probe.once('error',no); probe.listen(port,'127.0.0.1',()=>probe.close(ok));
        });
        const env={...process.env};
        for(const k of Object.keys(env)) if(/^(DATABASE_|PG|ASAAS_|RESEND_|EMAIL_|ADMIN_AUTH_|OPENAI_|RENDER|KIDMAIS_DEPLOY_ENV)/.test(k)) delete env[k];
        Object.assign(env,{DATABASE_URL:`postgresql://${papel}@127.0.0.1:55475/${banco}`,DATABASE_SSL:'false',ADMIN_AUTH_SECRET:randomBytes(32).toString('hex'),ADMIN_AUTH_ORIGIN:base,EMAIL_PROVIDER:'desativado',NODE_ENV:'development',KIDMAIS_FESTA_ISOLADO:'true',KIDMAIS_FESTA_AMBIENTE:'automated',NEXT_TELEMETRY_DISABLED:'1',ASSINATURA_PLANOS_ATIVOS:'true',ASAAS_AMBIENTE:'sandbox',ASAAS_API_KEY:cfg.config.apiKey,ASAAS_WEBHOOK_TOKEN:cfg.config.webhookToken});
        log=fs.openSync(path.join(dir,'next.log'),'a');
        server=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'dev','--webpack','-H','127.0.0.1','-p','3195'],{cwd:raiz,env,stdio:['ignore',log,log],windowsHide:true});
        for(let i=0;i<100;i++) {
            if(server.exitCode!==null) throw Error('APP_ENCERROU');
            if(await fetch(base+'/api/admin/autenticacao',{signal:AbortSignal.timeout(3000)}).then(x=>x.ok).catch(()=>false)) break;
            if(i===99) throw Error('APP_NAO_INICIOU'); await pausa(500);
        }
        const { request }=require('C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
        ctx=await request.newContext({baseURL:base,timeout:60000});
        const ler=async caminho=>{
            const res=await ctx.get(caminho); const j=await res.json();
            if(!res.ok() || !j.ok) throw Object.assign(Error('APP_GET_RECUSADO'),{status:res.status(),codigo:j.codigo});
            return j.data;
        };
        const post=async(caminho,data)=>{
            const sessao=await ler('/api/admin/autenticacao');
            const res=await ctx.post(caminho,{headers:{origin:base,'x-csrf-token':sessao.csrf,...(sessao.sessaoId?{'x-kidmais-sessao':sessao.sessaoId}:{})},data});
            const j=await res.json();
            if(!res.ok() || !j.ok) throw Object.assign(Error('APP_POST_RECUSADO'),{status:res.status(),codigo:j.codigo});
            return j.data;
        };
        await post('/api/admin/autenticacao',{acao:'login',email,senha});
        await post('/api/admin/autenticacao',{acao:'selecionar-empresa',empresaId:r.empresa});
        r.acessoAntes=(await ler('/api/admin/assinatura')).acesso;
        assert.equal(r.acessoAntes.nivel,'SOMENTE_LEITURA'); salvar();
        // Aquecer o handler sem autenticação: token inválido não pode persistir evento.
        assert.equal((await fetch(base+ROTA,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
        porta=criarPorta({token:cfg.config.webhookToken});
        await new Promise((ok,no)=>{porta.once('error',no);porta.listen(3196,'127.0.0.1',ok);});
        let saida='';
        // cloudflared recebe apenas ambiente básico; nenhuma chave Asaas/Resend/banco é herdada.
        const tunnelEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMDRIVE)$/i.test(k)));
        tunnel=spawn(exe,['tunnel','--url','http://127.0.0.1:3196','--no-autoupdate','--protocol','http2'],{cwd:dir,env:tunnelEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
        for(const stream of [tunnel.stdout,tunnel.stderr]) stream.on('data',b=>{saida=(saida+b.toString()).slice(-30000);});
        for(let i=0;i<90;i++) {
            const url=saida.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if(url){r.url=url[0];salvar();break;}
            if(tunnel.exitCode!==null) throw Error('TUNEL_ENCERROU');
            if(i===89) throw Error('TUNEL_SEM_URL');await pausa(1000);
        }
        fs.writeFileSync(path.join(dir,'tunnel.log'),saida);
        for(let i=0;i<30;i++) {
            const codigo=await fetch(r.url+'/admin/login',{redirect:'error',signal:AbortSignal.timeout(5000)}).then(x=>x.status).catch(()=>0);
            if(codigo===404) break;
            if(i===29) throw Error('TUNEL_INACESSIVEL');await pausa(1000);
        }
        assert.equal((await fetch(r.url+ROTA,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)})).status,401);
        console.log('PASS login real, trial encerrado e túnel HTTPS restrito; painel não exposto.');
        r.webhookNome=`Kidmais homologacao ${r.empresa}`;
        assert.ok(!r.intencaoWebhook,'WEBHOOK_INCERTO_REVISAR');
        const existentes=await api('/webhooks?limit=100');
        assert.ok(existentes.totalCount<10,'LIMITE_WEBHOOKS');
        assert.ok(!existentes.data.some(w=>w.name===r.webhookNome),'WEBHOOK_JA_EXISTE');
        r.intencaoWebhook=true;salvar();
        const w=await api('/webhooks','POST',{name:r.webhookNome,url:r.url+ROTA,email:'felipemenegaz@gmail.com',enabled:true,interrupted:false,authToken:cfg.config.webhookToken,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED'],sendType:'SEQUENTIALLY',apiVersion:3});
        r.webhookId=w.id;salvar();webhookConfere(await api('/webhooks/'+encodeURIComponent(r.webhookId)));
        r.intencaoCheckout=true;salvar();
        await post('/api/admin/assinatura/checkout',{plano:'essencial',ciclo:'MENSAL',valorEsperadoCentavos:11820,versao:'2026-10-09'});
        const linha=(await c.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1',[r.empresa])).rows[0];
        r.clienteId=linha.provedor_cliente_id;r.assinaturaId=linha.provedor_assinatura_id;salvar();
        const sub=await p.obterAssinatura(r.assinaturaId);subConfere(sub);assert.equal(sub.customer,r.clienteId);assert.equal(sub.cycle,'MONTHLY');
        const pagamentos=await p.listarCobrancasDaAssinatura(r.assinaturaId);
        const pagamento=pagamentos.filter(x=>!x.deleted).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];
        assert.ok(pagamento);assert.equal(pagamento.valorCentavos,11820);assert.equal(pagamento.clienteId,r.clienteId);
        r.pagamentoId=pagamento.id;salvar();
        assert.equal((await ler('/api/admin/assinatura')).acesso.nivel,'SOMENTE_LEITURA');
        r.intencaoConfirmacao=true;salvar();
        await api('/sandbox/payment/'+encodeURIComponent(r.pagamentoId)+'/confirm','POST');
        console.log('Pagamento simulado; aguardando callback externo e processamento automático.');
        let eventos=[];
        for(let i=0;i<150;i++) {
            eventos=(await c.query("SELECT evento_id,tipo,situacao,tentativas,ultimo_erro FROM cobranca_eventos WHERE empresa_id=$1 AND tipo IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED')",[r.empresa])).rows;
            if(eventos.some(e=>e.situacao==='PROCESSADO')) break;
            if(i===149) {r.eventos=eventos;salvar();throw Error('CALLBACK_NAO_PROCESSADO');}
            await pausa(1000);
        }
        r.eventosExternos=eventos;r.acessoDepois=(await ler('/api/admin/assinatura')).acesso;
        assert.equal(r.acessoDepois.nivel,'COMPLETO');assert.equal(r.acessoDepois.motivo,'ASSINATURA_ATIVA');
        const snapshot=async()=>({
            assinatura:(await c.query('SELECT situacao,plano,contratacao_atual_id,periodo_atual_fim FROM empresa_assinaturas WHERE empresa_id=$1',[r.empresa])).rows,
            contratos:(await c.query('SELECT id,estado,pagamento_confirmacao_id FROM assinatura_contratacoes WHERE empresa_id=$1',[r.empresa])).rows,
            fundadores:(await c.query('SELECT id,estado,pagamento_confirmacao_id FROM assinatura_fundadores WHERE empresa_id=$1',[r.empresa])).rows,
        });
        const antesReplay=await snapshot();
        assert.equal(antesReplay.assinatura[0].situacao,'ATIVA');assert.equal(antesReplay.contratos.length,1);assert.equal(antesReplay.fundadores.length,1);
        assert.equal(antesReplay.contratos[0].estado,'CONFIRMADA');assert.equal(antesReplay.fundadores[0].estado,'CONFIRMADA');
        assert.equal(antesReplay.contratos[0].pagamento_confirmacao_id,r.pagamentoId);
        const ev=eventos.find(x=>x.situacao==='PROCESSADO');
        const replay=await fetch('http://127.0.0.1:3196'+ROTA,{method:'POST',headers:{'content-type':'application/json','asaas-access-token':cfg.config.webhookToken},body:JSON.stringify({id:ev.evento_id,event:ev.tipo,payment:{id:r.pagamentoId,subscription:r.assinaturaId,externalReference:r.empresa}})});
        assert.equal(replay.status,200);await pausa(500);assert.deepEqual(await snapshot(),antesReplay);
        r.replayLocalIdempotente=true;r.webhookExterno=true;salvar();
        console.log('PASS webhook externo → contratação/Fundador confirmados → acesso completo; replay local sem duplicação.');
        // Cancelamento passa também pela autenticação recente e serviço real da aplicação.
        await post('/api/admin/autenticacao',{acao:'reautenticar',senha});
        await post('/api/admin/assinatura/cancelamento',{confirmar:true});
        r.cancelamentoAplicacao=true;r.acessoCancelado=(await ler('/api/admin/assinatura')).acesso;salvar();
    } catch(e) {
        erro=e;r.falha={codigo:e.codigo??e.code??e.message,status:e.status??null};salvar();
        console.error(JSON.stringify({etapa:'INCOMPLETA',...r.falha}));
    } finally {
        await c.query('ROLLBACK').catch(()=>{});
        // Recuperar IDs pelo vínculo ou pela referência da rodada antes de encerrar recorrências.
        try {
            if(r.intencaoCheckout) {
                const subs=await p.listarAssinaturasPorReferencia(r.empresa);
                for(const sub of subs) {
                    subConfere(sub);if(!sub.deleted) assert.ok((await p.removerAssinatura(sub.id)).removida);
                    const depois=await p.obterAssinatura(sub.id);assert.ok(!depois||depois.deleted);
                }
                r.cancelada=true;
                if(r.pagamentoId) {const pago=await p.obterCobranca(r.pagamentoId);r.pagamentoPreservado=!!pago&&!pago.deleted&&['RECEIVED','CONFIRMED'].includes(pago.status);}
                salvar();
            }
        } catch(e) {r.limpezaAssinaturaPendente=true;erro??=e;salvar();}
        try {
            if(r.intencaoWebhook && !r.webhookRemovido) {
                if(!r.webhookId) {
                    const lista=await api('/webhooks?limit=100');const candidatos=lista.data.filter(w=>w.name===r.webhookNome&&w.url===r.url+ROTA);
                    assert.ok(candidatos.length<=1);r.webhookId=candidatos[0]?.id;salvar();
                }
                if(r.webhookId){const w=await api('/webhooks/'+encodeURIComponent(r.webhookId));if(w){webhookConfere(w);await api('/webhooks/'+encodeURIComponent(r.webhookId),'DELETE');}
                    assert.equal(await api('/webhooks/'+encodeURIComponent(r.webhookId)),null);}
                r.webhookRemovido=true;salvar();
            }
        } catch(e) {r.limpezaWebhookPendente=true;erro??=e;salvar();}
        await ctx?.dispose();
        for(const filho of [tunnel,server]) if(filho&&filho.exitCode===null){filho.kill();await new Promise(ok=>filho.once('exit',ok));}
        if(porta) await new Promise(ok=>{porta.close(ok);porta.closeAllConnections();});
        if(log!==undefined) fs.closeSync(log);
        // Next dev ajusta estes dois arquivos automaticamente; preservar exatamente o conteúdo anterior.
        for(const [nome,conteudo] of arquivosNext) fs.writeFileSync(path.join(raiz,nome),conteudo);
        await c.end();
    }
    if(erro){process.exitCode=2;return;}
    r.concluido=true;delete r.falha;salvar();
    console.log(JSON.stringify({resultado:'PASS',webhookExterno:r.webhookExterno,replayIdempotente:r.replayLocalIdempotente,acesso:r.acessoDepois.nivel,cancelada:r.cancelada,webhookRemovido:r.webhookRemovido,pagamentoPreservado:r.pagamentoPreservado}));
}
main().catch(e=>{console.error('Homologação interrompida:',e.code??e.message);process.exitCode=1;});
