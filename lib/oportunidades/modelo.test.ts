import test from 'node:test';
import assert from 'node:assert/strict';
import {comandoSchema,etapaDoEstado,perdaSchema} from './modelo.ts';
import {carregarModulo} from '../acessos/teste-carregador.ts';
const id='00000000-0000-4000-8000-000000000001';
test('etapas seguem exclusivamente o estado real',()=>{
 for(const s of ['NOVO','EM_ATENDIMENTO'])assert.equal(etapaDoEstado(s,true),'Novo contato');
 for(const s of ['RASCUNHO','AGUARDANDO_APROVACAO','APROVADO'])assert.equal(etapaDoEstado(s),'Proposta');
 assert.equal(etapaDoEstado('AGUARDANDO_CONTRATO'),'Contrato');
 for(const s of ['CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO'])assert.equal(etapaDoEstado(s),'Sinal');
 for(const s of ['CONFIRMADO','CANCELADO','RECUSADO','EXPIRADO'])assert.equal(etapaDoEstado(s),null);
});
test('conclusão pede ação seguinte; perda exige motivo fixo e data válida',()=>{
 const base={acao:'concluir',alvo:{tipo:'CONTATO',id},esperada:id};
 assert.equal(comandoSchema.safeParse(base).success,false);
 assert.equal(comandoSchema.safeParse({...base,proxima:{tipo:'Ligar',data:'2026-02-30',responsavelId:id}}).success,false);
 assert.equal(comandoSchema.safeParse({...base,proxima:{tipo:'Ligar',data:'2026-11-14',responsavelId:id}}).success,true);
 for(const entrada of [{},{motivo:'Porque sim'},{motivo:''}])assert.equal(perdaSchema.safeParse(entrada).success,false);
 assert.equal(perdaSchema.safeParse({motivo:'Preço'}).success,true);
});
test('resumo desligado não consulta nem envia; mensagem escapa texto do cliente',async()=>{
 const mod=carregarModulo('lib/oportunidades/resumo.ts',{'saas/provar-tenant':{},'oportunidades/consultas':{},'assinatura/recursos-plano':{},'marketing/capacidades':{}}) as {
 enviarResumosDiarios(d:unknown):Promise<unknown>;mensagemResumo(...a:unknown[]):{html:string;texto:string;assunto:string;idempotencia:string};};
 let chamadas=0;
 assert.deepEqual(await mod.enviarResumosDiarios({env:{},transacao:()=>{chamadas++;},enviar:()=>{chamadas++;}}),{desligado:true,enviados:0,falhas:0});
 assert.equal(chamadas,0);
 const m=mod.mensagemResumo('sintetico@example.test',id,id,'2026-11-14',[{nome:'<img src=x>',proxima:{data:'2026-11-13',tipo:'Ligar'}}],'Buffet <Aurora>');
 assert(m.texto.includes('Atrasada'));assert(!m.html.includes('<img'));assert(m.html.includes('&lt;img'));
 assert(m.assunto.includes('Buffet <Aurora>'));assert(m.texto.startsWith('iA.Fest — Buffet <Aurora>'));assert(m.html.includes('Buffet &lt;Aurora&gt;'));
 assert.equal(m.idempotencia,`oportunidades/${id}/${id}/2026-11-14`);
});
