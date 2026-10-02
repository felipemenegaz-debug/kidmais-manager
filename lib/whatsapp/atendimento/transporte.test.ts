import assert from 'node:assert/strict';
import test from 'node:test';
import { enviarMensagem } from './transporte.ts';

test('transporte envia formulário oficial sem seguir redirects e exige aceite com identificador',async()=>{
  const nomes=['GUPSHUP_SOURCE','GUPSHUP_API_KEY','GUPSHUP_APP_NAME'] as const;
  const anteriores=nomes.map(n=>process.env[n]);
  try {
    process.env.GUPSHUP_SOURCE='5561999999999'; process.env.GUPSHUP_API_KEY='sintetico-sem-credencial-real'; process.env.GUPSHUP_APP_NAME='KidmaisManager';
    let chamadas=0;
    const buscar=(async(url,init)=>{
      chamadas++; assert.equal(url,'https://api.gupshup.io/wa/api/v1/msg'); assert.equal(init?.redirect,'error');
      const form=init?.body as URLSearchParams;
      assert.equal(form.get('destination'),'5561888888888'); assert.deepEqual(JSON.parse(form.get('message')!),{type:'text',text:'Resposta aprovada'});
      return Response.json({status:'submitted',messageId:'sintetico'},{status:202});
    }) as typeof fetch;
    assert.equal(await enviarMensagem('5561888888888','Resposta aprovada',buscar),'sintetico'); assert.equal(chamadas,1);
    await assert.rejects(enviarMensagem('5561888888888','Texto',(async()=>Response.json({status:'submitted',messageId:''},{status:202})) as typeof fetch));
    await assert.rejects(enviarMensagem('5561888888888','Texto',(async()=>new Response('x'.repeat(8193),{status:202})) as typeof fetch));
    await assert.rejects(enviarMensagem('destino-invalido','Texto',buscar)); assert.equal(chamadas,1);
  } finally { nomes.forEach((n,i)=>{if(anteriores[i]===undefined) delete process.env[n]; else process.env[n]=anteriores[i];}); }
});
