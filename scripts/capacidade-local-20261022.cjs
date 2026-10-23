/* eslint-disable @typescript-eslint/no-require-imports */
// Ensaio sintético: 5/10/20/40 sessões, Next START e PostgreSQL descartável 55831.
// Não reproduz a CPU nem impõe cgroup de 512 MB do Render. Relata RSS observado e violações do orçamento.
// Exige build pronto, ausência de .env, os três KIDMAIS_* do runner e autorização literal abaixo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const receita = require('./regressao-v1-postgres-receita.cjs');
const WEB = 35831;
const ORIGEM = 'https://capacidade.example.test';
const sha = b => createHash('sha256').update(b).digest('hex');
const esperar = ms => new Promise(r => setTimeout(r, ms));
const p95 = a => [...a].sort((x,y) => x-y)[Math.max(0, Math.ceil(a.length * .95) - 1)] ?? 0;

async function main() {
  assert.equal(process.env.KIDMAIS_CAPACIDADE_AUTORIZACAO, 'SINTETICO-55831-35831');
  assert.equal(process.env.KIDMAIS_DESCARTAVEL_PORTA, '55831');
  for (const name of fs.readdirSync('.')) assert.ok(!/^\.env($|\.)/.test(name), 'arquivo env recusado');
  assert.ok(fs.existsSync('.next/BUILD_ID'), 'build de produção necessário');
  await new Promise((resolve,reject) => { const s=net.createServer(); s.once('error',reject); s.listen(WEB,'127.0.0.1',()=>s.close(resolve)); });
  const dir = path.resolve('.local-capacidade-' + new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(dir);
  const metricas = path.join(dir,'memoria.jsonl');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let c, servidor;
  const logs = fs.openSync(path.join(dir,'next.log'),'a');
  const resultado = { node: process.version, build: fs.readFileSync('.next/BUILD_ID','utf8').trim(),
    ambiente: 'Windows local, CPU livre, PostgreSQL local; orçamento observado 512 MiB, sem cgroup; sessões pré-autenticadas', cenarios: [] };
  try {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[receita.MODELOS['089'].banco])).rows.length)
      await receita.construirModelo(admin,porta,'089');
    await receita.restaurar(admin,receita.TRABALHO[0],'089');
    c = await receita.conectar(porta,receita.TRABALHO[0]);
    await c.query('BEGIN');
    const { montarEmpresaCom, SENHA_FALSA } = await import('../lib/exportacao/fixture.postgres.test-apoio.ts');
    const fixtureDb = { async query(sql,args=[]) {
      if(sql.startsWith('INSERT INTO contrato_edicoes')) {
        sql=sql.replace('revisado_em)', 'revisado_em, revisao_comercial_aprovada, aprovado_comercial_por_usuario_id, aprovado_comercial_em, liberado_por_usuario_id, liberado_em)').replace('$3::uuid, now())', '$3::uuid, now(), 1, $3::uuid, now(), $3::uuid, now())');
      }
      if(sql.startsWith('INSERT INTO contrato_assinaturas') && sql.includes("'KIDMAIS'")) {
        args=[...args];
        const u=(await c.query('SELECT nome,cargo FROM usuarios_administrativos WHERE id=$1',[args[2]])).rows[0];
        args[4]=JSON.stringify({usuarioId:args[2],papel:'REPRESENTANTE_AUTORIZADO',nome:u.nome,cargo:u.cargo});
        await c.query(`INSERT INTO sessoes_administrativas(id,usuario_id,token_hash,csrf_hash,autenticado_em,ultima_atividade_em,expira_em)
          VALUES($1,$2,$3,$4,now(),now(),now()+interval '8 hours')`,[args[3],args[2],sha(randomBytes(32)),sha(randomBytes(32))]);
      }
      if(sql.startsWith('INSERT INTO contrato_assinaturas') && sql.includes("'CLIENTE'")) {
        await c.query("UPDATE validacoes_identidade_cliente SET finalidade='CONTRATO_ACEITE',status='CONSUMIDA',consumido_por_contrato_versao_id=$2,consumido_em=now() WHERE id=$1",[args[2],args[0]]);
      }
      return c.query(sql,args);
    } };
    const f = await montarEmpresaCom(fixtureDb,'Capacidade',async (db,email,nome) => (await db.query(
      "INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,$2,$3,'ADMINISTRATIVO',true) RETURNING id",[email,nome,SENHA_FALSA])).rows[0].id);
    // Volume não vazio; PDF incompressível sintético, sem arquivo/dado real.
    await c.query("INSERT INTO clientes(nome_completo,empresa_id) SELECT 'Cliente sintético '||g,$1 FROM generate_series(1,1000) g",[f.empresa]);
    const v=(await c.query('SELECT contrato_versao_id AS v,snapshot_hash AS h FROM contrato_documentos WHERE id=$1',[f.documento])).rows[0];
    // A fixture de exportação é usada pelas suítes com ROLLBACK; aqui precisa satisfazer também os gatilhos no COMMIT.
    await c.query('UPDATE contratos SET versao_atual=1 WHERE id=(SELECT contrato_id FROM contrato_versoes WHERE id=$1)',[v.v]);
    await c.query(`INSERT INTO empresa_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo)
      SELECT empresa_id,id,'CONTRATO_ASSINAR_EMPRESA',$2,'Fixture sintética capacidade' FROM memberships WHERE empresa_id=$1 AND usuario_id=$2`,[f.empresa,f.gestao]);
    for(let i=0;i<4;i++) {
      const b=randomBytes(35*1024*1024);
      await c.query(`INSERT INTO contrato_documentos(contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf,gerado_por_usuario_id)
        VALUES($1,'CONTRATO',$2,$3,'CONTRATO_E1',1,$4,$5,$6,$7)`,[v.v,10+i,v.h,sha(b),b.length,b,f.gestao]);
    }
    const sessoes=[];
    for(let i=0;i<40;i++) {
      const uid=(await c.query("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,$2,$3,'ADMINISTRATIVO',true) RETURNING id",[`carga-${i}@example.test`,`Carga ${i}`,SENHA_FALSA])).rows[0].id;
      const m=(await c.query("INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',now(),'REPRESENTANTE_AUTORIZADO') RETURNING id",[f.empresa,uid])).rows[0].id;
      await c.query("UPDATE memberships SET status='ATIVA' WHERE id=$1",[m]);
      await c.query("INSERT INTO festa_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo) VALUES($1,$2,'FESTA_CONSULTAR',$3,'Fixture sintética capacidade')",[f.empresa,m,uid]);
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
      const s=(await c.query(`INSERT INTO sessoes_administrativas(usuario_id,token_hash,csrf_hash,autenticado_em,ultima_atividade_em,expira_em,empresa_ativa_id)
        VALUES($1,$2,$3,now(),now(),now()+interval '8 hours',$4) RETURNING id`,[uid,sha(token),sha(csrf),f.empresa])).rows[0];
      sessoes.push({ cookie:`__Host-kidmais_admin=${token}; __Host-kidmais_admin_csrf=${csrf}`,csrf,id:s.id });
    }
    await c.query('COMMIT');
    const env={};
    for(const k of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','COMSPEC','PATHEXT']) if(process.env[k]) env[k]=process.env[k];
    Object.assign(env,{NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',DATABASE_URL:`postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL:'false',ADMIN_AUTH_SECRET:randomBytes(32).toString('hex'),ADMIN_AUTH_ORIGIN:ORIGEM,
      RENDER:'true',KIDMAIS_DEPLOY_ENV:'staging',FESTA_ENABLED:'true',EMAIL_PROVIDER:'desativado',KIDMAIS_CAPACIDADE_METRICAS:metricas});
    servidor=spawn(process.execPath,['--require',path.resolve('scripts/capacidade-local-sonda.cjs'),'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(WEB)],{env,stdio:['ignore',logs,logs],windowsHide:true});
    async function req(url,s=sessoes[0],body) {
      return new Promise((resolve,reject)=>{
        const request=http.request({hostname:'127.0.0.1',port:WEB,path:url,method:body?'POST':'GET',headers:{host:'capacidade.example.test','x-forwarded-host':'capacidade.example.test','x-forwarded-proto':'https',origin:ORIGEM,cookie:s.cookie,
          'x-csrf-token':s.csrf,'x-kidmais-sessao':s.id,'content-type':'application/json'}},r=>{
          let bytes=0; r.on('data',b=>bytes+=b.length); r.on('error',reject); r.on('end',()=>resolve({status:r.statusCode,bytes}));
        });
        request.on('error',reject); request.setTimeout(120000,()=>request.destroy(Error('prazo HTTP')));
        request.end(body?JSON.stringify(body):undefined);
      });
    }
    for(let i=0;i<120;i++) { if(servidor.exitCode!==null) throw Error('servidor encerrou'); try { const r=await req('/api/admin/clientes'); if(r.status===200) break; if(i===119) throw Error('autenticação: '+r.status); } catch(e) {if(i===119) throw e;} await esperar(500); }
    const rotas=['/api/admin/clientes?limit=50','/api/admin/dashboard','/api/admin/contratos/painel','/api/admin/festas','/admin/assinatura'];
    for(const rota of rotas) assert.equal((await req(rota)).status,200,`preflight ${rota}`);
    for(const usuarios of [5,10,20,40]) for(const exportando of [false,true]) {
      const inicio=Date.now(), fim=inicio+30000, tempos=[], erros=[], porRota={}; let seq=0;
      const exportacao=exportando ? (async()=>{await esperar(3000); const t=Date.now(); const r=await req('/api/admin/exportacao',sessoes[0],{tipo:'completa'}); return {...r,ms:Date.now()-t,inicio:t,fim:Date.now()};})() : Promise.resolve(null);
      await Promise.all(Array.from({length:usuarios},async(_,u)=>{
        let iter=u;
        while(Date.now()<fim) {
          const escrita=iter%10===9, rota=escrita?'/api/admin/clientes':rotas[iter%rotas.length], t=Date.now();
          try {
            const cadastro=escrita?{nomeCompleto:`Cliente Carga ${usuarios} ${seq}`,telefone:String(11900000000+seq++)}:undefined;
            const r=await req(rota,sessoes[u],cadastro);
            const ms=Date.now()-t; tempos.push(ms); (porRota[rota]??=[]).push(ms);
            if(r.status!==(escrita?201:200)) erros.push({rota,status:r.status});
          } catch(e) {erros.push({rota,erro:e.message});}
          iter++; await esperar(500);
        }
      }));
      const ex=await exportacao;
      const final=Date.now();
      const amostras=fs.readFileSync(metricas,'utf8').trim().split('\n').map(JSON.parse).filter(s=>s.t>=inicio && s.t<=final);
      const rss=Math.max(...amostras.map(s=>s.rss))/1048576;
      const primeiro=amostras[0],ultimo=amostras.at(-1);
      const cpuCores=(ultimo.cpu.user+ultimo.cpu.system-primeiro.cpu.user-primeiro.cpu.system)/((ultimo.t-primeiro.t)*1000);
      const item={usuarios,exportando,requisicoes:tempos.length,erros,ms:final-inicio,p95Ms:p95(tempos),picoRssMiB:Math.round(rss),acima512MiB:rss>512,cpuCoresMedios:Math.round(cpuCores*100)/100,
        porRota:Object.fromEntries(Object.entries(porRota).map(([r,ts])=>[r,{n:ts.length,p95Ms:p95(ts)}])),exportacao:ex};
      resultado.cenarios.push(item); fs.writeFileSync(path.join(dir,'resultado.json'),JSON.stringify(resultado,null,2)); console.log(JSON.stringify(item));
      assert.equal(erros.length,0,'erros de carga'); if(ex) assert.equal(ex.status,200,'exportação recusada');
    }
  } finally {
    if(servidor && servidor.exitCode===null) {servidor.kill(); await new Promise(r=>servidor.once('exit',r));}
    fs.closeSync(logs); if(c) await c.end(); await admin.end();
    fs.writeFileSync(path.join(dir,'resultado.json'),JSON.stringify(resultado,null,2)); console.log('RELATORIO '+dir);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
