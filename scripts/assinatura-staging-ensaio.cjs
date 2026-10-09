/* eslint-disable @typescript-eslint/no-require-imports */
// Ensaio autorizado em 09/10/2026. Nunca executar contra outro serviço/banco ou reutilizar IDs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomBytes, createHash} = require('node:crypto');
// Terceira rodada preparada; execução depende da autorização do plano de retomada.
const EMPRESA = 'e4b274ca-3a51-40c5-bef6-39012a96cfbc';
const USUARIO = '067a7b63-7588-4897-b66b-a93f9fdbd56e';
const EMAIL = 'assinatura-staging-067a7b63@example.invalid';
const BASE = 'https://kidmais-manager-staging.onrender.com';
const DIR = '/opt/render/project/src/data/ensaio-assinatura-20261009-3';
const ROTA = '/api/integracoes/asaas/webhook';
const pausa = ms => new Promise(ok => setTimeout(ok, ms));
function alvo(env) {
    assert.equal(env.RENDER, 'true'); assert.equal(env.RENDER_SERVICE_ID, 'srv-daif418ae00c73e8k2gg');
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'staging'); assert.equal(env.ASAAS_AMBIENTE, 'sandbox');
    assert.equal(env.ASSINATURA_PLANOS_ATIVOS, 'true');
    const u = new URL(env.DATABASE_URL);
    assert.equal(u.hostname, 'dpg-daidko3m8hqs73ce4jt0-a'); assert.equal(u.pathname, '/kidmais_staging_1z91');
    assert.ok(!u.port || u.port === '5432');
    assert.ok(![...u.searchParams.keys()].some(k => /^ssl/i.test(k)), 'SSL_URL_RECUSADO');
    // Reproduz lib/db/postgres.ts, sem mudar a configuração já existente do web.
    assert.ok(['true','false'].includes(env.DATABASE_SSL), 'SSL_CONFIGURACAO_RECUSADA');
    return {connectionString:u.toString(), ssl:env.DATABASE_SSL === 'true'
        ? {rejectUnauthorized:env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion:'TLSv1.2'}
        : undefined, connectionTimeoutMillis:10000};
}
function documento() {
    let d = Array.from(randomBytes(8), n => n % 10).join('') + '0001';
    for (const pesos of [[5,4,3,2,9,8,7,6,5,4,3,2],[6,5,4,3,2,9,8,7,6,5,4,3,2]]) {
        const resto = [...d].reduce((s,n,i) => s + Number(n)*pesos[i],0)%11;
        d += resto < 2 ? '0' : String(11-resto);
    }
    assert.notEqual(d,'20119900000160'); return d;
}
function cookies(headers, jar) {
    for (const v of headers.getSetCookie()) { const [par] = v.split(';'); const i=par.indexOf('=');
        const nome=par.slice(0,i), valor=par.slice(i+1); if(valor) jar.set(nome,valor); else jar.delete(nome); }
}
async function prepararWebhook(api, cfg, r, salvar) {
    const lista=await api('/webhooks?limit=100');assert.ok(!lista.hasMore,'WEBHOOKS_PAGINADOS');
    const conhecidos=[];
    for(const candidato of lista.data.filter(w=>w.url===BASE+ROTA)){
        const w=await api('/webhooks/'+encodeURIComponent(candidato.id));
        // Ausência do token na consulta não prova divergência. Não alterar webhook alheio.
        if(w?.authToken===cfg.webhookToken&&w.enabled===true&&w.interrupted===false
            &&w.events.includes('PAYMENT_RECEIVED')&&w.events.includes('PAYMENT_CONFIRMED'))conhecidos.push(w);
    }
    assert.ok(conhecidos.length<=1,'WEBHOOK_AMBIGUO');
    if(conhecidos.length){r.webhookReutilizado=true;salvar();return;}
    assert.ok(lista.totalCount<10,'LIMITE_WEBHOOKS');
    r.webhookNome='Kidmais staging ensaio '+r.empresa;
    assert.ok(!lista.data.some(w=>w.name===r.webhookNome),'WEBHOOK_NOME_PREEXISTENTE');
    r.intencaoWebhook=true;salvar();
    const w=await api('/webhooks','POST',{name:r.webhookNome,url:BASE+ROTA,email:'felipemenegaz@gmail.com',enabled:true,interrupted:false,
        authToken:cfg.webhookToken,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED'],sendType:'SEQUENTIALLY',apiVersion:3});
    assert.ok(w&&typeof w.id==='string');r.webhookId=w.id;salvar();
    const salvo=await api('/webhooks/'+encodeURIComponent(w.id));
    assert.equal(salvo.name,r.webhookNome);assert.equal(salvo.url,BASE+ROTA);
    assert.equal(salvo.enabled,true);assert.equal(salvo.interrupted,false);
    assert.ok(salvo.events.includes('PAYMENT_CONFIRMED')&&salvo.events.includes('PAYMENT_RECEIVED'));
}
async function main() {
    const opts=alvo(process.env);
    const {Client}=require('pg');
    const {configuracaoAsaas,criarClienteAsaas}=await import('../lib/assinatura/asaas.ts');
    const {criarHashSenha}=await import('../lib/autenticacao/senha.ts');
    const cfg=configuracaoAsaas(); assert.ok(cfg.ligado,'ASAAS_DESLIGADO'); const p=criarClienteAsaas(cfg.config);
    fs.mkdirSync(DIR,{recursive:true,mode:0o700});
    const arquivo=DIR+'/rodada.json'; assert.ok(!fs.existsSync(arquivo),'RODADA_EXISTENTE_REVISAR');
    const r={empresa:EMPRESA,usuario:USUARIO,inicio:new Date().toISOString(),documento:documento()};
    const salvar=()=>fs.writeFileSync(arquivo,JSON.stringify(r,null,2),{mode:0o600}); salvar();
    const db=new Client(opts); let erro, conectado=false, etapa='PRECHECK'; const jar=new Map();
    const senha='Sintetica-'+randomBytes(24).toString('hex');
    const api=async(caminho,method='GET',body)=>{
        assert.ok(/^\/(webhooks|sandbox\/payment)(\/|\?|$)/.test(caminho));
        const res=await fetch('https://api-sandbox.asaas.com/v3'+caminho,{method,redirect:'error',signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey,'User-Agent':'kidmais-staging-ensaio','Content-Type':'application/json'},
            ...(body?{body:JSON.stringify(body)}:{})});
        if(res.status===404&&method==='GET')return null;
        if(!res.ok)throw Object.assign(Error('ASAAS_HTTP'),{status:res.status});return res.json();
    };
    const requisicao=async(caminho,method='GET',body,extras={})=>{
        assert.ok(caminho.startsWith('/api/admin/'));
        const res=await fetch(BASE+caminho,{method,redirect:'error',signal:AbortSignal.timeout(60000),
            headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join(';'),'Content-Type':'application/json',...extras},
            ...(body?{body:JSON.stringify(body)}:{})}); cookies(res.headers,jar);
        const j=await res.json(); if(!res.ok||!j.ok)throw Object.assign(Error('APP_HTTP'),{status:res.status,codigo:j.codigo});return j.data;
    };
    const post=async(caminho,body)=>{const s=await requisicao('/api/admin/autenticacao');
        return requisicao(caminho,'POST',body,{Origin:BASE,'x-csrf-token':s.csrf,...(s.sessaoId?{'x-kidmais-sessao':s.sessaoId}:{})});};
    const agregado=async()=>{
        const nomes=['empresa_assinaturas','assinatura_contratacoes','assinatura_fundadores','assinatura_isencoes'];
        const hashes=[];
        for(const nome of nomes){const linhas=(await db.query(`SELECT to_jsonb(t)::text linha FROM ${nome} t WHERE empresa_id<>$1 ORDER BY to_jsonb(t)::text`,[EMPRESA])).rows;
            // Hash somente em memória: nunca imprimir registros ou PII.
            hashes.push(createHash('sha256').update(JSON.stringify(linhas)).digest('hex'));}
        return hashes;
    };
    const snapshot=async()=>({
        assinatura:(await db.query('SELECT situacao,plano,contratacao_atual_id,periodo_atual_fim FROM empresa_assinaturas WHERE empresa_id=$1',[EMPRESA])).rows,
        contratos:(await db.query('SELECT id,estado,pagamento_confirmacao_id FROM assinatura_contratacoes WHERE empresa_id=$1',[EMPRESA])).rows,
        fundadores:(await db.query('SELECT id,estado,pagamento_confirmacao_id FROM assinatura_fundadores WHERE empresa_id=$1',[EMPRESA])).rows,
    });
    const subConfere=s=>{assert.ok(s);assert.equal(s.externalReference,EMPRESA);assert.equal(s.customer,r.clienteId);assert.equal(s.valorCentavos,r.valor);};
    try {
        assert.equal(await p.buscarClientePorReferencia(EMPRESA),null,'CLIENTE_PREEXISTENTE');
        etapa='WEBHOOK_PRECHECK'; await prepararWebhook(api,cfg.config,r,salvar);
        await db.connect(); conectado=true; await db.query("SET statement_timeout='15s'");
        assert.equal((await db.query('SELECT current_database() db')).rows[0].db,'kidmais_staging_1z91');
        const schema=(await db.query("SELECT to_regclass('public.assinatura_contratacoes') IS NOT NULL AND to_regclass('public.assinatura_renovacoes') IS NOT NULL AS ok")).rows[0];
        assert.equal(schema.ok,true,'SCHEMA_RECUSADO');
        assert.equal((await db.query('SELECT 1 FROM empresas WHERE id=$1',[EMPRESA])).rowCount,0,'EMPRESA_PREEXISTENTE');
        assert.equal((await db.query('SELECT 1 FROM usuarios_administrativos WHERE id=$1 OR email=$2',[USUARIO,EMAIL])).rowCount,0,'USUARIO_PREEXISTENTE');
        assert.equal((await db.query('SELECT 1 FROM empresa_assinaturas WHERE documento_teste=$1',[r.documento])).rowCount,0);
        r.antes=await agregado(); salvar();
        etapa='FIXTURE'; await db.query('BEGIN');
        await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,'TESTE Kidmais — assinatura staging 20261009','PROVISIONAMENTO')",[EMPRESA,'ensaio-'+EMPRESA]);
        await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1",[EMPRESA]);
        await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Staging',$3,'REPRESENTANTE_AUTORIZADO',true)",[USUARIO,EMAIL,await criarHashSenha(senha)]);
        await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())",[EMPRESA,USUARIO]);
        await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2",[EMPRESA,USUARIO]);
        await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)",[EMPRESA,r.documento]);
        await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1",[USUARIO]);
        await db.query('COMMIT');r.fixture=true;salvar();
        etapa='LOGIN'; await post('/api/admin/autenticacao',{acao:'login',email:EMAIL,senha});
        await post('/api/admin/autenticacao',{acao:'selecionar-empresa',empresaId:EMPRESA});
        etapa='OFERTA'; const antes=await requisicao('/api/admin/assinatura');assert.equal(antes.acesso.nivel,'SOMENTE_LEITURA');
        assert.equal(antes.ofertas.habilitado,true);const oferta=antes.ofertas.planos.find(x=>x.id==='essencial');
        assert.equal(oferta.mensalRegular,19700);r.valor=antes.ofertas.fundador?11820:19700;
        assert.equal(oferta.mensal,r.valor);assert.equal(antes.ofertas.aguardandoVaga,false);r.fundador=antes.ofertas.fundador;salvar();
        assert.equal((await fetch(BASE+ROTA,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
        etapa='CHECKOUT'; r.intencaoCheckout=true;salvar();
        await post('/api/admin/assinatura/checkout',{plano:'essencial',ciclo:'MENSAL',valorEsperadoCentavos:r.valor,versao:antes.ofertas.versao});
        const linha=(await db.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1',[EMPRESA])).rows[0];
        r.clienteId=linha.provedor_cliente_id;r.assinaturaId=linha.provedor_assinatura_id;salvar();
        subConfere(await p.obterAssinatura(r.assinaturaId));
        etapa='CONFERENCIA_CRON'; console.log(JSON.stringify({etapa:'AGUARDANDO_CONFERENCIA_CRON',clienteCriado:true,assinaturaFicticia:true,valorCentavos:r.valor}));
        // Operador libera somente após preflight do cron encontrar a referência. Senha permanece só em memória.
        for(let i=0;!fs.existsSync(DIR+'/cron-conferido');i++){assert.ok(i<900,'CONFERENCIA_CRON_EXPIRADA');await pausa(1000);}
        assert.equal((await requisicao('/api/admin/assinatura')).acesso.nivel,'SOMENTE_LEITURA');
        const pagamentos=await p.listarCobrancasDaAssinatura(r.assinaturaId);
        const pagamento=pagamentos.filter(x=>!x.deleted).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];
        assert.ok(pagamento);assert.equal(pagamento.valorCentavos,r.valor);assert.equal(pagamento.clienteId,r.clienteId);
        assert.equal(pagamento.assinaturaId,r.assinaturaId);r.pagamentoId=pagamento.id;r.intencaoConfirmacao=true;salvar();
        etapa='PAGAMENTO'; await api('/sandbox/payment/'+encodeURIComponent(r.pagamentoId)+'/confirm','POST');
        etapa='CALLBACK'; let eventos=[];
        for(let i=0;i<180;i++){eventos=(await db.query("SELECT evento_id,tipo,situacao FROM cobranca_eventos WHERE empresa_id=$1 AND tipo IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED')",[EMPRESA])).rows;
            if(eventos.some(e=>e.situacao==='PROCESSADO'))break;assert.ok(i<179,'CALLBACK_NAO_PROCESSADO');await pausa(1000);}
        r.acessoDepois=(await requisicao('/api/admin/assinatura')).acesso.nivel;assert.equal(r.acessoDepois,'COMPLETO');
        const s=await snapshot();assert.equal(s.assinatura[0].situacao,'ATIVA');assert.equal(s.contratos.length,1);
        assert.equal(s.contratos[0].estado,'CONFIRMADA');assert.equal(s.contratos[0].pagamento_confirmacao_id,r.pagamentoId);
        assert.equal(s.fundadores.length,r.fundador?1:0);if(r.fundador)assert.equal(s.fundadores[0].estado,'CONFIRMADA');
        etapa='REPLAY'; const ev=eventos.find(e=>e.situacao==='PROCESSADO');
        const replay=await fetch(BASE+ROTA,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','asaas-access-token':cfg.config.webhookToken},
            body:JSON.stringify({id:ev.evento_id,event:ev.tipo,payment:{id:r.pagamentoId,subscription:r.assinaturaId,externalReference:EMPRESA}})});
        assert.equal(replay.status,200);await pausa(2000);assert.deepEqual(await snapshot(),s);r.replay=true;salvar();
        console.log(JSON.stringify({etapa:'PAGAMENTO_E_CALLBACK_APROVADOS',acesso:r.acessoDepois,replayIdempotente:true,aguardandoCron:true}));
        // Uma janela de 6 minutos cobre a rodada agendada de 5 minutos e inicialização do container.
        etapa='CRON_IDEMPOTENCIA'; await pausa(360000);assert.deepEqual(await snapshot(),s);r.cronSemDuplicacao=true;salvar();
        etapa='CANCELAMENTO'; await post('/api/admin/autenticacao',{acao:'reautenticar',senha});
        await post('/api/admin/assinatura/cancelamento',{confirmar:true});r.cancelamentoAplicacao=true;
        assert.equal((await requisicao('/api/admin/assinatura')).acesso.nivel,'COMPLETO');r.periodoPagoPreservado=true;salvar();
    }catch(e){erro=e;r.falha={etapa,http:e.status??null,codigo:e.codigo??null};salvar();
        console.error(JSON.stringify(r.falha));
    }finally{
        if(conectado)await db.query('ROLLBACK').catch(()=>{});
        try{if(r.intencaoCheckout){const subs=await p.listarAssinaturasPorReferencia(EMPRESA);assert.ok(subs.length<=1,'SUB_DUPLICADA');
            for(const s of subs){assert.equal(s.externalReference,EMPRESA);assert.equal(s.valorCentavos,r.valor);
                if(r.clienteId)assert.equal(s.customer,r.clienteId);if(!s.deleted)assert.equal((await p.removerAssinatura(s.id)).removida,true);
                const depois=await p.obterAssinatura(s.id);assert.ok(!depois||depois.deleted);}
            r.cancelada=true;salvar();}}
        catch{r.limpezaAssinaturaPendente=true;erro??=Error('LIMPEZA_ASSINATURA');salvar();}
        try{if(r.intencaoWebhook){if(!r.webhookId){const l=await api('/webhooks?limit=100');
                const candidatos=l.data.filter(w=>w.name===r.webhookNome&&w.url===BASE+ROTA);assert.ok(candidatos.length<=1);r.webhookId=candidatos[0]?.id;salvar();}
            if(r.webhookId){const w=await api('/webhooks/'+encodeURIComponent(r.webhookId));if(w){assert.equal(w.name,r.webhookNome);assert.equal(w.url,BASE+ROTA);
                    await api('/webhooks/'+encodeURIComponent(r.webhookId),'DELETE');}assert.equal(await api('/webhooks/'+encodeURIComponent(r.webhookId)),null);}
            r.webhookRemovido=true;salvar();}}
        catch{r.limpezaWebhookPendente=true;erro??=Error('LIMPEZA_WEBHOOK');salvar();}
        try{if(conectado&&r.fixture){await db.query('BEGIN');
            await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=$1',[USUARIO]);
            await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=$1 AND usuario_id=$2 AND status<>'REVOGADA'",[EMPRESA,USUARIO]);
            await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=$1 AND status<>'DESATIVADA'",[EMPRESA]);
            await db.query('COMMIT');r.acessoFicticioDesativado=true;assert.deepEqual(await agregado(),r.antes);r.existentesPreservados=true;salvar();}}
        catch{await db.query('ROLLBACK').catch(()=>{});r.limpezaBancoPendente=true;erro??=Error('LIMPEZA_BANCO');salvar();}
        await db.end().catch(()=>{});
    }
    r.concluido=!erro;salvar();console.log(JSON.stringify({resultado:erro?'INCOMPLETO':'PASS',acesso:r.acessoDepois,
        cancelada:r.cancelada??false,webhookRemovido:r.webhookRemovido??false,existentesPreservados:r.existentesPreservados??false,
        acessoFicticioDesativado:r.acessoFicticioDesativado??false,cronSemDuplicacao:r.cronSemDuplicacao??false}));if(erro)process.exitCode=2;
}
if(require.main===module){
    if(!process.argv.includes('--rodada-3-autorizada')){console.error('RETOMADA_AGUARDANDO_AUTORIZACAO');process.exitCode=1;}
    else main().catch(()=>{console.error('ENSAIO_RECUSADO_ANTES_DAS_MUTACOES');process.exitCode=1;});
}
module.exports={alvo,documento,cookies,prepararWebhook};
