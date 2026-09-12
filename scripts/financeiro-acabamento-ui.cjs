/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({page,workspace})=>{
 const snapshot={contratante:{nomeCompleto:'Cliente UX',email:'ux@example.invalid'},evento:{data:'2026-12-10',horarioInicio:'11:00',horarioFim:'15:00',pacote:{nome:'Essencial',codigo:'ESSENCIAL'},convidados:120},comercial:{formaPagamentoPretendida:'PIX_AVISTA',valorFinalContrato:9919}};
 const v1={id:'v1',numero_versao:1,snapshot},v4={id:'v4',numero_versao:4,snapshot};
 const fixture=()=>({original:v1,reconhecida:v1,vigente:v4,valorVigente:'991900',pagamento:{id:'p',valor_total_contratado:'8990.00',status:'PARCIALMENTE_PAGO'},posicao:{obrigacao:'899000',liquido:'849000',saldo:'50000',credito:'0',reservado:'0',disponivel:'0',devolvido:'0'},posicaoHash:'ux',motivos:['VALOR'],pendencias:[{id:'pend',versao_nova_id:'v4',situacao:'EM_TRATAMENTO',tentativas:[{id:'t',tentativa:1,estado:'EM_TRATAMENTO'}]}],futuro:[{parcelaId:'legada',valorCentavos:'50000',vencimento:'2026-11-10'}],origens:[],provas:[],timeline:[],devolucoes:[],cronograma:{id:'cronograma'}});
 let p=fixture();const posts=[];
 await page.route('**/api/admin/**',async route=>{
  const req=route.request(),u=new URL(req.url());let data;
  if(u.pathname==='/api/admin/autenticacao')data={usuarioId:'ux',csrf:'ux'};
  else if(u.pathname==='/api/admin/contratos/painel'){
   if(!u.searchParams.has('contratoId'))data=[{id:'contrato-ux',nome:'Cliente UX',data_evento:'2026-12-10',pacote:'Essencial',convidados:120,status:'ASSINADO'}];
   else data={contrato:{id:'contrato-ux',status:'ASSINADO'},fluxo:{versao_vigente_id:'v4',versao_em_preparacao_id:'v5'},versoes:[{...v4,status:'ASSINADA',estado_edicao:'CONCLUIDA',revisao:1},{id:'v5',numero_versao:5,status:'RASCUNHO',estado_edicao:'EM_ELABORACAO',revisao:8,snapshot}],documentos:[],assinaturas:[],pendencias:[],financeiro:[],revisoesOperacionais:[{id:'rev',contrato_versao_id:'v5',estado:'EM_ELABORACAO',status_fechamento:'CONFIRMADO',data_evento:'2026-12-10',data_vigente:'2026-12-10',horario_inicio:'11:00',horario_fim:'15:00',slot_alterado:false}]};
  }else if(req.method()==='GET')data={painel:p,papel:'REPRESENTANTE_AUTORIZADO'};
  else{
   const body=req.postDataJSON();posts.push({path:u.pathname,body});
   if(u.pathname.endsWith('/cancelar')){assert.equal(body.motivo,'Cancelar somente A');p={...p,devolucoes:p.devolucoes.filter(x=>x.id!=='a')};data={};}
   else if(u.pathname.endsWith('/simulacao')){const alvo=u.pathname.includes('/cronograma/')?p.posicao.obrigacao:p.valorVigente;data={delta:(BigInt(alvo)-BigInt(p.posicao.obrigacao)).toString(),depois:{...p.posicao,obrigacao:alvo,saldo:(BigInt(alvo)-BigInt(p.posicao.liquido)).toString(),credito:'0'}};}
   else throw Error('Escrita inesperada: '+u.pathname);
  }
  await route.fulfill({json:{ok:true,data}});
 });
 const ui=page.getByRole('region',{name:'Financeiro da contratação'});
 await page.goto('http://localhost:3102/validacao-credito');
 const resumo=ui.getByRole('region',{name:'Resumo da alteração pendente'});await resumo.waitFor();
 for(const label of ['Valor da versão vigente','Obrigação reconhecida','Delta projetado','Recebido líquido','Saldo projetado','Crédito projetado'])assert.equal(await resumo.getByText(label,{exact:true}).count(),1);
 await ui.getByRole('button',{name:'Retomar tratamento',exact:true}).click();
 const wizard=ui.getByRole('group',{name:/Resolver alteração financeira/});
 assert.equal(await wizard.getByText('Delta projetado',{exact:true}).count(),1);
 await ui.getByRole('button',{name:'Continuar',exact:true}).click();
 assert.match(await wizard.innerText(),/Saldo a regularizar: R\$\s1\.429,00/);
 assert.deepEqual(await ui.getByLabel('Saldo futuro',{exact:true}).locator('option').allTextContents(),['Cobrança única do saldo (PIX à vista)']);
 await ui.getByLabel('Justificativa e autorização').fill('Ajuste UX em API simulada');await ui.getByRole('button',{name:'Continuar',exact:true}).click();
 assert.equal(await ui.getByLabel('Valor da parcela 1').inputValue(),'1429,00');assert(await ui.getByLabel('Valor da parcela 1').evaluate(e=>e.readOnly));assert.equal(await ui.getByRole('button',{name:'Adicionar parcela',exact:true}).count(),0);
 await ui.getByRole('button',{name:'Continuar',exact:true}).click();
 for(const label of ['Obrigação antes','Delta','Obrigação depois','Recebido líquido','Saldo','Crédito'])assert.equal(await wizard.getByText(label,{exact:true}).count(),1);
 assert.match(await wizard.innerText(),/Cobrança 1: R\$\s1\.429,00 — vencimento 10\/11\/2026 — nova cobrança/);
 await ui.getByRole('button',{name:'Validar simulação',exact:true}).click();await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).waitFor();assert.equal(posts[0].body.parcelas.length,1);assert.equal(posts[0].body.parcelas[0].valorCentavos,'142900');
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(workspace,'ux-financeiro-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});
 p=fixture();p.pendencias=[];p.valorVigente=p.posicao.obrigacao;await page.goto('http://localhost:3102/validacao-credito');await ui.getByRole('button',{name:'Reprogramar cronograma',exact:true}).click();
 await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByLabel('Justificativa e autorização').fill('Reprogramação UX');await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByRole('button',{name:'Validar simulação',exact:true}).click();await ui.getByRole('button',{name:'Confirmar reprogramação',exact:true}).waitFor();assert.equal(await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).count(),0);
 p=fixture();p.valorVigente='836100';p.posicao={...p.posicao,obrigacao:'929000',liquido:'929000',saldo:'0'};await page.goto('http://localhost:3102/validacao-credito');await ui.getByRole('button',{name:'Retomar tratamento',exact:true}).waitFor();assert.equal(await ui.getByRole('button',{name:'Reprogramar cronograma',exact:true}).count(),0);await ui.getByRole('button',{name:'Retomar tratamento',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByLabel('Crédito',{exact:true}).selectOption('MANTER');await ui.getByRole('button',{name:'Continuar',exact:true}).click();assert.equal(await ui.getByRole('button',{name:'Adicionar parcela',exact:true}).count(),0);
 p=fixture();p.pendencias=[];p.posicao={...p.posicao,credito:'92900',disponivel:'72900',reservado:'20000'};p.devolucoes=['a','b'].map(id=>({id,valor_centavos:'10000',estado:'PENDENTE',beneficiario_snapshot:{nome:id.toUpperCase()}}));p.origens=[{id:'origem',recebimento_id:'id-tecnico-oculto',valor_bruto:'4645.00',recebido_em:'2026-09-10',meio_pagamento:'PIX',disponivel_centavos:'72900'}];p.timeline=[{id:'evento',tipo:'ALTERACAO',detalhe:'Mudança de condi��o',instante:null}];
 await page.goto('http://localhost:3102/validacao-credito');await ui.getByRole('button',{name:'Solicitar devolução de crédito',exact:true}).click();await ui.getByLabel('Motivo da solicitação',{exact:true}).fill('Solicitação que não deve vazar');
 const a=ui.getByRole('group',{name:'Devolução para A',exact:true}),b=ui.getByRole('group',{name:'Devolução para B',exact:true});assert.equal(await a.getByLabel('Motivo do cancelamento').inputValue(),'');assert.equal(await b.getByLabel('Motivo do cancelamento').inputValue(),'');await a.getByLabel('Motivo do cancelamento').fill('Cancelar somente A');assert.equal(await b.getByLabel('Motivo do cancelamento').inputValue(),'');await a.getByRole('button',{name:'Cancelar devolução pendente',exact:true}).click();await a.waitFor({state:'detached'});assert.equal(await b.getByLabel('Motivo do cancelamento').inputValue(),'');
 assert.match(await ui.innerText(),/Recebimento de R\$\s4\.645,00 — 10\/09\/2026 — PIX/);assert(!(await ui.innerText()).includes('id-tecnico-oculto'));assert.equal(await ui.getByText('Mudança de condição',{exact:true}).count(),1);assert(!(await ui.innerText()).includes('�'));assert.equal(await ui.getByRole('heading',{name:'Ações financeiras',exact:true}).count(),1);assert.equal(await ui.getByRole('heading',{name:'Devoluções',exact:true}).count(),1);
 fs.mkdirSync(path.join(workspace,'app/validacao-contrato'),{recursive:true});fs.writeFileSync(path.join(workspace,'app/validacao-contrato/page.tsx'),`import ContratoAdmin from '@/components/admin/ContratoAdmin';export default function Page(){return <ContratoAdmin/>;}`);
 await page.goto('http://localhost:3102/validacao-contrato');await page.getByLabel('Contrato',{exact:true}).selectOption('contrato-ux');assert.match(await page.getByLabel('Contrato',{exact:true}).locator('option:checked').innerText(),/Cliente UX — 10\/12\/2026 — Essencial — 120 convidados — ASSINADO — ref\./);await page.getByRole('button',{name:'Cancelar revisão',exact:true}).waitFor();await page.getByRole('button',{name:'Gerar PDF da revisão',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/Cancelar revisão \/ V2|Gerar PDF da revisão 8/}).count(),0);
 await page.screenshot({path:path.join(workspace,'ux-contrato.png'),fullPage:true});
 console.log('PASS UX: resumos, composição, PIX único, saldo zero, reprogramação, seletor de contratos, rótulos genéricos, motivos isolados, origem humana e encoding. API simulada; sem escrita real.');
};
