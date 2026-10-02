import assert from 'node:assert/strict';
import test from 'node:test';
import { enviarMensagem } from './transporte.ts';

const nomes=['GUPSHUP_SOURCE','GUPSHUP_API_KEY','GUPSHUP_APP_NAME'] as const;
async function comAmbiente(fn:()=>Promise<void>) {
  const anteriores=nomes.map(n=>process.env[n]);
  try { process.env.GUPSHUP_SOURCE='5561999999999'; process.env.GUPSHUP_API_KEY='sintetico-sem-credencial-real'; process.env.GUPSHUP_APP_NAME='KidmaisManager'; await fn(); }
  finally { nomes.forEach((n,i)=>{if(anteriores[i]===undefined) delete process.env[n]; else process.env[n]=anteriores[i];}); }
}
const resposta=(corpo:unknown,status:number)=>(async()=>Response.json(corpo,{status})) as typeof fetch;

test('transporte envia formulário oficial sem seguir redirects e exige aceite com identificador',()=>comAmbiente(async()=>{
  let chamadas=0;
  const buscar=(async(url,init)=>{
    chamadas++; assert.equal(url,'https://api.gupshup.io/wa/api/v1/msg'); assert.equal(init?.redirect,'error');
    const form=init?.body as URLSearchParams;
    assert.equal(form.get('destination'),'5561888888888'); assert.equal(form.get('src.name'),'KidmaisManager'); assert.deepEqual(JSON.parse(form.get('message')!),{type:'text',text:'Resposta aprovada'});
    return Response.json({status:'submitted',messageId:'sintetico'},{status:200});
  }) as typeof fetch;
  assert.equal(await enviarMensagem('5561888888888','Resposta aprovada',buscar),'sintetico'); assert.equal(chamadas,1);
  await assert.rejects(enviarMensagem('5561888888888','Texto',resposta({status:'submitted',messageId:''},200)),/RESULTADO_INCERTO/);
  await assert.rejects(enviarMensagem('5561888888888','Texto',(async()=>new Response('x'.repeat(8193),{status:200})) as typeof fetch),/RESULTADO_INCERTO/);
  await assert.rejects(enviarMensagem('destino-invalido','Texto',buscar),/NAO_CONFIGURADO/); assert.equal(chamadas,1);
}));
test('sucesso é qualquer 2xx com "submitted" (a API de sessão documenta 2XX; o exemplo usa 200)',()=>comAmbiente(async()=>{
  for (const status of [200,201,202]) assert.equal(await enviarMensagem('5561888888888','Texto',resposta({status:'submitted',messageId:`id-${status}`},status)),`id-${status}`);
}));
test('recusa do provedor (4xx documentado) é definitiva; 5xx, 408 e corpo inválido ficam incertos',()=>comAmbiente(async()=>{
  for (const status of [400,401,403,429]) await assert.rejects(enviarMensagem('5561888888888','Texto',resposta({status:'error',message:'Recusa sintética'},status)),/ATENDIMENTO_ENVIO_RECUSADO/,String(status));
  for (const status of [408,500,502,503]) await assert.rejects(enviarMensagem('5561888888888','Texto',resposta({status:'error'},status)),/RESULTADO_INCERTO/,String(status));
  await assert.rejects(enviarMensagem('5561888888888','Texto',(async()=>new Response('não é json',{status:200})) as typeof fetch));
  await assert.rejects(enviarMensagem('5561888888888','Texto',(async()=>{throw new DOMException('timeout','TimeoutError');}) as typeof fetch),/timeout/);
}));
