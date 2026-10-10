/* eslint-disable @typescript-eslint/no-require-imports */
// PostgreSQL real no alvo autorizado; provedor simulado para falhas determinísticas. Sem rede externa/segredos.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { executarCiclo } = require('./assinatura-reconciliar.cjs');
const banco = 'kidmais_webhook_20261009_sintetica', papel = 'kidmais_renovacao_075';
const dir = path.resolve(__dirname,'../.local-assinatura-recuperacao');
const arquivo = path.join(dir,'resultado.json');
global.fetch = async () => { throw Error('REDE_EXTERNA_PROIBIDA'); };
async function conectar() {
    assert.equal(process.env.KIDMAIS_RECUPERACAO_AUTORIZACAO, `127.0.0.1:55475/${banco}`);
    assert.ok(!process.env.DATABASE_URL && !Object.keys(process.env).some(k=>/^(PG|ASAAS_|RESEND_)/.test(k)));
    const c = new Client({host:'127.0.0.1',port:55475,user:papel,database:banco,ssl:false,connectionTimeoutMillis:5000,password:async()=>{throw Error('SENHA_RECUSADA');}});
    await c.connect();
    assert.deepEqual((await c.query("SELECT current_database() db,current_user papel,current_setting('cluster_name') cluster,host(inet_server_addr()) host,inet_server_port() porta")).rows[0],{db:banco,papel,cluster:papel,host:'127.0.0.1',porta:55475});
    await c.query("SET statement_timeout='15s'");await c.query("SET lock_timeout='5s'");return c;
}
async function main() {
    const c=await conectar();
    const sinc=await import('../lib/assinatura/sincronizacao.ts');
    const { prepararOferta }=await import('../lib/assinatura/ofertas.ts');
    const { receberWebhookAsaas }=await import('../lib/assinatura/webhook-asaas.ts');
    const { AsaasFalhou }=await import('../lib/assinatura/asaas.ts');
    const tx=async f=>{await c.query('BEGIN');try{const r=await f(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}};
    let r;
    const salvar=()=>fs.writeFileSync(arquivo,JSON.stringify(r,null,2));
    try {
        fs.mkdirSync(dir,{recursive:true});
        r=fs.existsSync(arquivo)?JSON.parse(fs.readFileSync(arquivo,'utf8')):{casos:[],inicio:new Date().toISOString()};
        const modo=process.argv[2];
        const provedor={
            obterAssinatura:async id=>{const f=r.casos.find(x=>x.sub===id);assert.ok(f,'ASSINATURA_FORA_DA_RODADA');return{id,status:'ACTIVE',deleted:false,cycle:'MONTHLY',customer:f.cus,externalReference:f.empresa,valorCentavos:11820};},
            listarCobrancasDaAssinatura:async id=>{const f=r.casos.find(x=>x.sub===id);assert.ok(f);return[{id:f.pay,status:'RECEIVED',dueDate:r.hoje,paymentDate:r.hoje,deleted:false,assinaturaId:f.sub,clienteId:f.cus,valorCentavos:11820,invoiceUrl:null}];},
        };
        if(modo==='--receber-e-cair') {
            const token='token-sintetico-recuperacao-sem-valor-123';
            for(const f of r.casos) {
                const resposta=await receberWebhookAsaas(new Request('https://teste.invalid/webhook',{method:'POST',headers:{'content-type':'application/json','asaas-access-token':token},body:JSON.stringify({id:f.evento,event:'PAYMENT_RECEIVED',payment:{id:f.pay,subscription:f.sub,externalReference:f.empresa}})}),{
                    env:{ASAAS_AMBIENTE:'sandbox',ASAAS_API_KEY:'$aact_hmlg_fixture_sem_valor',ASAAS_WEBHOOK_TOKEN:token},ip:'127.0.0.1',withTransaction:tx,consumirLimite:async()=>true,agendar:()=>{},
                });assert.equal(resposta.status,200);
            }
            // Encerramento sem finally: simula processo perdido após persistir e produzir HTTP 200.
            process.exit(77);
        }
        const ids=r.casos.map(f=>f.empresa);
        const eventos=()=>c.query('SELECT id,evento_id,situacao,tentativas FROM cobranca_eventos WHERE referencia_externa=ANY($1::text[]) ORDER BY evento_id',[ids]).then(q=>q.rows);
        if(modo==='--processar-e-cair') {
            const ev=(await eventos()).find(e=>e.evento_id===r.casos[2].evento);
            await c.query('BEGIN');assert.equal((await sinc.processarEvento(c,ev.id,{provedor})).situacao,'PROCESSADO');
            process.exit(78); // Alterações não commitadas devem desaparecer, evento durável deve continuar pendente.
        }
        if(modo==='--recuperar') {
            // Seleção delimitada às fixtures; funções de processamento e ciclo são as mesmas do CLI.
            const limitado={...sinc,eventosPendentes:async()=> (await eventos()).filter(e=>['PENDENTE','FALHOU'].includes(e.situacao)).map(e=>e.id),empresasComProvedor:async()=>ids};
            const relatorio=await executarCiclo({client:c,provedor,aplicar:true,banco,sinc:limitado});
            assert.equal(relatorio.incompleto,false);console.log(JSON.stringify(relatorio));return;
        }
        assert.ok(!modo,'MODO_INVALIDO');
        if(r.concluido){console.log('PASS recuperação já validada; nenhuma escrita repetida.');return;}
        assert.equal(r.casos.length,0,'RETOMADA_EXIGE_REVISAO');
        r.hoje=(await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') dia")).rows[0].dia;
        const preservado=JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows);
        await tx(async p=>{
            for(let i=0;i<3;i++) {
                const empresa=randomUUID(),usuario=randomUUID();
                const b64=n=>randomBytes(n).toString('base64');
                const hash=`scrypt$v=1$N=131072$r=8$p=1$${b64(16)}$${b64(64)}`;
                const f={empresa,usuario,sub:`sub_rec_${empresa}`,cus:`cus_rec_${empresa}`,pay:`pay_rec_${empresa}`,evento:`evt_rec_${empresa}&${i}`};
                await p.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,'TESTE Recuperação','PROVISIONAMENTO')",[empresa,`rec-${empresa}`]);
                await p.query("UPDATE empresas SET status='ATIVA' WHERE id=$1",[empresa]);
                await p.query("INSERT INTO usuarios_administrativos(id,nome,email,senha_hash,papel,ativo) VALUES($1,'Gestão sintética',$2,$3,'REPRESENTANTE_AUTORIZADO',true)",[usuario,`rec-${usuario}@example.invalid`,hash]);
                await p.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())",[empresa,usuario]);
                await p.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2",[empresa,usuario]);
                const doc=BigInt('0x'+randomBytes(5).toString('hex')).toString().padStart(14,'0');
                await p.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 day',$2)",[empresa,doc]);
                await prepararOferta(p,empresa,usuario,{plano:'essencial',ciclo:'MENSAL',valorEsperadoCentavos:11820,versao:'2026-10-09'});
                await p.query("UPDATE empresa_assinaturas SET provedor='ASAAS',provedor_cliente_id=$2,provedor_assinatura_id=$3,ciclo='MENSAL' WHERE empresa_id=$1",[empresa,f.cus,f.sub]);
                r.casos.push(f);
            }
        });salvar();ids.push(...r.casos.map(f=>f.empresa));
        const filho=modo=>new Promise((ok,no)=>{
            const proc=spawn(process.execPath,[__filename,modo],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
            let saida='';proc.stdout.on('data',b=>{saida+=b;});proc.stderr.on('data',()=>{});proc.once('error',no);proc.once('exit',code=>ok({code,saida}));
        });
        assert.equal((await filho('--receber-e-cair')).code,77);
        assert.equal((await eventos()).filter(e=>e.situacao==='PENDENTE').length,3);
        const evFalha=(await eventos()).find(e=>e.evento_id===r.casos[1].evento);
        const fora={...provedor,obterAssinatura:async()=>{throw new AsaasFalhou('consultar assinatura',503,'HTTP');}};
        assert.equal((await tx(p=>sinc.processarEvento(p,evFalha.id,{provedor:fora}))).situacao,'FALHOU');
        assert.equal((await filho('--processar-e-cair')).code,78);
        const antes=(await c.query('SELECT situacao FROM empresa_assinaturas WHERE empresa_id=ANY($1::uuid[])',[ids])).rows;
        assert.ok(antes.every(a=>a.situacao==='TESTE'),'QUEDA_NAO_PODE_CONFIRMAR_PARCIALMENTE');
        const primeira=await filho('--recuperar');assert.equal(primeira.code,0,primeira.saida);
        assert.ok((await eventos()).every(e=>e.situacao==='PROCESSADO'));
        assert.deepEqual((await eventos()).map(e=>e.tentativas).sort(),[1,1,2]);
        const final=(await c.query('SELECT situacao,periodo_atual_fim FROM empresa_assinaturas WHERE empresa_id=ANY($1::uuid[])',[ids])).rows;
        assert.ok(final.every(a=>a.situacao==='ATIVA'&&a.periodo_atual_fim>new Date()));
        const snapshot=async()=>JSON.stringify({contratos:(await c.query('SELECT * FROM assinatura_contratacoes WHERE empresa_id=ANY($1::uuid[]) ORDER BY empresa_id',[ids])).rows,fundadores:(await c.query('SELECT * FROM assinatura_fundadores WHERE empresa_id=ANY($1::uuid[]) ORDER BY empresa_id',[ids])).rows,eventos:await eventos()});
        const confirmado=await snapshot();assert.equal((await filho('--recuperar')).code,0);assert.equal(await snapshot(),confirmado);
        assert.equal(JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas WHERE NOT(empresa_id=ANY($1::uuid[])) ORDER BY empresa_id',[ids])).rows),preservado);
        r.concluido=true;r.resultado={quedaApos200:true,falhaProvedor:true,quedaAntesCommit:true,recuperados:3,segundaRodadaIdempotente:true,assinaturasAnterioresPreservadas:true,provedor:'SIMULADO',postgres:'REAL'};salvar();console.log(JSON.stringify(r.resultado));
    } finally {await c.query('ROLLBACK').catch(()=>{});await c.end();}
}
main().catch(e=>{console.error('FAIL recuperação',e.code??e.name,e.message);process.exitCode=1;});
