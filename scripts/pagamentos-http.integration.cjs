/* eslint-disable @typescript-eslint/no-require-imports -- Runner HTTP CommonJS com handlers Next reais. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { rollbackTest, fixture, plano } = require('./pagamentos-test-support.cjs');
const { NextRequest } = require('next/server');
const base = require('../app/api/admin/pagamentos/route.ts');
const routes = Object.fromEntries(['recebimentos','estornos','plano','comprovantes'].map(name =>
  [name, require(`../app/api/admin/pagamentos/[pagamentoId]/${name}/route.ts`)]));
async function main(c) {
  process.env.NODE_ENV='test';
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const url=new URL(req.url,process.env.ADMIN_AUTH_ORIGIN);
      const parts=url.pathname.split('/');
      const handler=parts.length===4 ? base[req.method] : routes[parts[5]]?.[req.method];
      if(!handler){res.writeHead(404);res.end();return;}
      const request=new NextRequest(url,{method:req.method,headers:req.headers,...(req.method==='GET'?{}:{body:Buffer.concat(chunks)})});
      const response=await handler(request,{params:Promise.resolve({pagamentoId:parts[4]})});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(e){res.writeHead(500);res.end();console.error(e);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}/api/admin/pagamentos`;
  const authenticated=await require('./admin-test-support.cjs').autenticarTeste(c,`http://localhost:${server.address().port}`);
  let authenticatedHeaders=authenticated.headers();
  let n=0;
  async function call(suffix,body,status,code,method='POST') {
    const response=await fetch(origin+suffix,{method,headers:authenticatedHeaders,...(method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));
    assert.equal(response.headers.get('cache-control'),'no-store');if(code)assert.equal(json.codigo,code);n++;return json.data;
  }
  try {
    const f=await fixture(c);
    await call('',{},400,'DADOS_INVALIDOS');await call('', '{',400,'DADOS_INVALIDOS');
    await call('?fechamentoId=invalido',null,400,'DADOS_INVALIDOS','GET');
    const made=await call('',{fechamentoId:f.fechamentoId,plano},201);
    await call('',{fechamentoId:f.fechamentoId,plano},200);
    const d=made.detalhe;const prefix=`/${d.pagamento.id}`;
    await call('?fechamentoId='+f.fechamentoId,null,200,null,'GET');
    for(const route of Object.keys(routes)) {
      await call('/invalido/'+route,{},400,'DADOS_INVALIDOS');await call(prefix+'/'+route,'{',400,'DADOS_INVALIDOS');
    }
    const rec={meioPagamento:'PIX',valorBruto:10,chaveIdempotencia:randomUUID(),alocacoes:[{parcelaId:d.parcelas[0].id,valor:10}]};
    await call(prefix+'/recebimentos',{...rec,extra:'não permitido'},400,'DADOS_INVALIDOS');
    await call(prefix+'/recebimentos',{...rec,valorBruto:true},400,'DADOS_INVALIDOS');
    await call(prefix+'/recebimentos',{...rec,referenciaExterna:'sem-provedor'},400,'RECEBIMENTO_INVALIDO');
    await call(prefix+'/recebimentos',{...rec,valorBruto:10.001},400,'PLANO_PAGAMENTO_INVALIDO');
    await call(prefix+'/recebimentos',{...rec,valorBruto:10.0000000001},400,'PLANO_PAGAMENTO_INVALIDO');
    await call(prefix+'/recebimentos',{...rec,valorBruto:'10.0000000000000000001'},400,'DADOS_INVALIDOS');
    const a=await call(prefix+'/recebimentos',rec,201);await call(prefix+'/recebimentos',rec,200);
    await call(prefix.toUpperCase()+'/recebimentos',{...rec,alocacoes:[{parcelaId:d.parcelas[0].id.toUpperCase(),valor:10}]},200);
    await call(prefix+'/recebimentos',{...rec,valorBruto:11},409,'RECEBIMENTO_INVALIDO');
    await call(prefix+'/plano',{motivo:'Teste',plano},409,'PLANO_NAO_PODE_SER_SUBSTITUIDO');
    const est={recebimentoId:a.recebimento.id,parcelaId:d.parcelas[0].id,valor:2,chaveIdempotencia:randomUUID()};
    await call(prefix+'/estornos',{...est,chaveIdempotencia:null,confirmarAgora:false},400,'ESTORNO_INVALIDO');
    await call(prefix+'/estornos',est,201);await call(prefix+'/estornos',est,200);
    await call(prefix.toUpperCase()+'/estornos',{...est,recebimentoId:est.recebimentoId.toUpperCase(),parcelaId:est.parcelaId.toUpperCase()},200);
    await call(prefix+'/estornos',{...est,chaveIdempotencia:randomUUID(),valor:9},409,'ESTORNO_INVALIDO');
    const proof={recebimentoId:a.recebimento.id,nomeArquivo:'teste.pdf',mimeType:'application/pdf',tamanhoBytes:10,sha256:'b'.repeat(64),localizadorArquivo:'test-fixture://arquivo'};
    await call(prefix+'/comprovantes',proof,201);await call(prefix+'/comprovantes',proof,200);
    await call('/'+randomUUID()+'/recebimentos',rec,404,'PAGAMENTO_NAO_ENCONTRADO');
    authenticatedHeaders={'Content-Type':'application/json'};await call('',{},401,'AUTENTICACAO_ADMINISTRATIVA');
    authenticatedHeaders={...authenticated.headers(),'x-csrf-token':'forjado'};await call('',{},403,'AUTENTICACAO_ADMINISTRATIVA');
    console.log(`${n} requisições HTTP aprovadas, com handlers Next e PostgreSQL reais.`);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
rollbackTest(main).then(()=>console.log('ROLLBACK e fingerprint aprovados.')).catch(e=>{console.error(e);process.exitCode=1;});
