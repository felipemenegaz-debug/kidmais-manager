import assert from 'node:assert/strict';
import test from 'node:test';
import { conteudoDaMensagem, enviarMensagem, mensagemGupshup, type ConteudoSaida } from './transporte.ts';

const nomes=['GUPSHUP_SOURCE','GUPSHUP_API_KEY','GUPSHUP_APP_NAME'] as const;
async function comAmbiente(fn:()=>Promise<void>) {
  const anteriores=nomes.map(n=>process.env[n]);
  try { process.env.GUPSHUP_SOURCE='5561999999999'; process.env.GUPSHUP_API_KEY='sintetico-sem-credencial-real'; process.env.GUPSHUP_APP_NAME='KidmaisManager'; await fn(); }
  finally { nomes.forEach((n,i)=>{if(anteriores[i]===undefined) delete process.env[n]; else process.env[n]=anteriores[i];}); }
}
const resposta=(corpo:unknown,status:number)=>(async()=>Response.json(corpo,{status})) as typeof fetch;
const T=(texto:string):ConteudoSaida=>({tipo:'TEXTO',texto});

test('transporte envia formulário oficial sem seguir redirects e exige aceite com identificador',()=>comAmbiente(async()=>{
  let chamadas=0;
  const buscar=(async(url,init)=>{
    chamadas++; assert.equal(url,'https://api.gupshup.io/wa/api/v1/msg'); assert.equal(init?.redirect,'error');
    const form=init?.body as URLSearchParams;
    assert.equal(form.get('destination'),'5561888888888'); assert.equal(form.get('src.name'),'KidmaisManager'); assert.deepEqual(JSON.parse(form.get('message')!),{type:'text',text:'Resposta aprovada'});
    return Response.json({status:'submitted',messageId:'sintetico'},{status:200});
  }) as typeof fetch;
  assert.equal(await enviarMensagem('5561888888888',T('Resposta aprovada'),buscar),'sintetico'); assert.equal(chamadas,1);
  await assert.rejects(enviarMensagem('5561888888888',T('Texto'),resposta({status:'submitted',messageId:''},200)),/RESULTADO_INCERTO/);
  await assert.rejects(enviarMensagem('5561888888888',T('Texto'),(async()=>new Response('x'.repeat(8193),{status:200})) as typeof fetch),/RESULTADO_INCERTO/);
  await assert.rejects(enviarMensagem('destino-invalido',T('Texto'),buscar),/NAO_CONFIGURADO/); assert.equal(chamadas,1);
}));
test('sucesso é qualquer 2xx com "submitted" (a API de sessão documenta 2XX; o exemplo usa 200)',()=>comAmbiente(async()=>{
  for (const status of [200,201,202]) assert.equal(await enviarMensagem('5561888888888',T('Texto'),resposta({status:'submitted',messageId:`id-${status}`},status)),`id-${status}`);
}));
test('recusa do provedor (4xx documentado) é definitiva; 5xx, 408 e corpo inválido ficam incertos',()=>comAmbiente(async()=>{
  for (const status of [400,401,403,429]) await assert.rejects(enviarMensagem('5561888888888',T('Texto'),resposta({status:'error',message:'Recusa sintética'},status)),/ATENDIMENTO_ENVIO_RECUSADO/,String(status));
  for (const status of [408,500,502,503]) await assert.rejects(enviarMensagem('5561888888888',T('Texto'),resposta({status:'error'},status)),/RESULTADO_INCERTO/,String(status));
  await assert.rejects(enviarMensagem('5561888888888',T('Texto'),(async()=>new Response('não é json',{status:200})) as typeof fetch));
  await assert.rejects(enviarMensagem('5561888888888',T('Texto'),(async()=>{throw new DOMException('timeout','TimeoutError');}) as typeof fetch),/timeout/);
}));

// 074: formato do `message` conforme a documentação da API de sessão do Gupshup (transporte simulado, nada sai).
test('foto: {type:image, originalUrl, previewUrl, caption}; vídeo: {type:video, url, caption}; legenda vazia não vai',()=>{
  assert.deepEqual(mensagemGupshup({tipo:'IMAGEM',url:'https://cdn.exemplo.test/s.jpg',legenda:'Salgados'}),{type:'image',originalUrl:'https://cdn.exemplo.test/s.jpg',previewUrl:'https://cdn.exemplo.test/s.jpg',caption:'Salgados'});
  assert.deepEqual(mensagemGupshup({tipo:'IMAGEM',url:'https://cdn.exemplo.test/s.jpg',legenda:'  '}),{type:'image',originalUrl:'https://cdn.exemplo.test/s.jpg',previewUrl:'https://cdn.exemplo.test/s.jpg'});
  assert.deepEqual(mensagemGupshup({tipo:'VIDEO',url:'https://cdn.exemplo.test/t.mp4',legenda:'Tour'}),{type:'video',url:'https://cdn.exemplo.test/t.mp4',caption:'Tour'});
  assert.deepEqual(mensagemGupshup({tipo:'VIDEO',url:'https://cdn.exemplo.test/t.mp4',legenda:null}),{type:'video',url:'https://cdn.exemplo.test/t.mp4'});
  assert.deepEqual(mensagemGupshup(T('Oi')),{type:'text',text:'Oi'});
});
test('conteúdo da linha: mídia só com tipo E URL (074); sem colunas de mídia, é texto; sem mídia e sem texto, recusa',()=>{
  assert.deepEqual(conteudoDaMensagem({texto:'Legenda',midia_tipo:'IMAGEM',midia_url:'https://cdn.exemplo.test/s.jpg'}),{tipo:'IMAGEM',url:'https://cdn.exemplo.test/s.jpg',legenda:'Legenda'});
  assert.deepEqual(conteudoDaMensagem({texto:null,midia_tipo:'VIDEO',midia_url:'https://cdn.exemplo.test/t.mp4'}),{tipo:'VIDEO',url:'https://cdn.exemplo.test/t.mp4',legenda:null});
  assert.deepEqual(conteudoDaMensagem({texto:'Oi'}),T('Oi'));
  assert.deepEqual(conteudoDaMensagem({texto:'Oi',midia_tipo:'IMAGEM',midia_url:null}),T('Oi'));
  // Foto lida sem as colunas da 074 (legenda vazia): nada vazio chega ao provedor; o worker grava FALHOU.
  for (const texto of [null,'','   ']) assert.throws(()=>conteudoDaMensagem({texto}),/ATENDIMENTO_ENVIO_RECUSADO/);
});
test('envio de foto pelo transporte simulado leva o formulário oficial; URL não https nunca chega ao provedor',()=>comAmbiente(async()=>{
  let corpo:unknown=null, chamadas=0;
  const buscar=(async(_url,init)=>{ chamadas++; corpo=JSON.parse((init?.body as URLSearchParams).get('message')!); return Response.json({status:'submitted',messageId:'midia-1'},{status:200}); }) as typeof fetch;
  assert.equal(await enviarMensagem('5561888888888',{tipo:'IMAGEM',url:'https://cdn.exemplo.test/s.png',legenda:'Bolo'},buscar),'midia-1');
  assert.deepEqual(corpo,{type:'image',originalUrl:'https://cdn.exemplo.test/s.png',previewUrl:'https://cdn.exemplo.test/s.png',caption:'Bolo'});
  await assert.rejects(enviarMensagem('5561888888888',{tipo:'VIDEO',url:'http://cdn.exemplo.test/t.mp4',legenda:null},buscar),/NAO_CONFIGURADO/);
  assert.equal(chamadas,1,'URL http recusada antes de qualquer chamada');
}));
