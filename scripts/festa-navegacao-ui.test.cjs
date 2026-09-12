/* eslint-disable @typescript-eslint/no-require-imports */
// Navegação com respostas simuladas: não autentica usuários reais nem grava no banco.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const playwrightModule=process.env.PLAYWRIGHT_MODULE||(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright'):'playwright');
const {chromium}=require(playwrightModule);
const out='.local-festa/ux-navegacao',origin='http://127.0.0.1:3027';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),fid=id(16),cid=id(100),vid=id(102);
const snapshot={contratante:{nomeCompleto:'Felipe Marra Menegaz',email:'teste@example.invalid'},aniversariante:{nome:'Catarina',idadeNoEvento:1,temaFesta:null},evento:{data:'2099-09-12',horarioInicio:'11:00:00',horarioFim:'15:00:00',pacote:{nome:'Festa Completa',codigo:'COMPLETA'},convidados:120},comercial:{valorFinalContrato:13131,formaPagamentoPretendida:'PIX_AVISTA'},contratacao:{adicionais:[],buffet:{}}};
const evento=(tipo,depois,antes=null,motivo='')=>({id:tipo+Math.random(),tipo,dados_antes:antes,dados_depois:depois,motivo,criado_em:'2026-09-11T09:55:00Z',identidade_snapshot:{nome:'Felipe'}});
const festa={festa:{id:fid,revisao:1},contrato:{id:cid,status:'ASSINADO',versao_id:vid,numero_versao:2,snapshot},capacidades:['FESTA_CONSULTAR','FESTA_CORRIGIR','FESTA_OPERAR'],areas:[],usuarios:[],itens:{eventos:[evento('FESTA_CRIADA',{id:fid},null,'Criação explícita'),evento('FESTA_TAREFA',{titulo:'Confirmar decoração',estado:'PENDENTE'}),evento('FESTA_TAREFA',{titulo:'Confirmar decoração',estado:'CONCLUIDA'},{estado:'PENDENTE'}),evento('FESTA_BUFFET',{lembrancinha:'Bola',id:'interno'}),evento('FESTA_DESCONHECIDO',{},undefined,'{"comando":"FESTA_X"}')]},contagens:{atual:null},financeiroPendente:false};
const versao={id:vid,numero_versao:2,status:'ASSINADA',estado_edicao:'CONCLUIDA',revisao:1,origem_versao_id:id(101),snapshot,dados_fonte:null};
const painel={contrato:{id:cid,status:'ASSINADO'},fluxo:{versao_vigente_id:vid,versao_em_preparacao_id:null},versoes:[{...versao,id:id(101),numero_versao:1},versao],documentos:[],assinaturas:[],revisoesOperacionais:[],financeiro:[{id:id(200)}],pendencias:[]};
const financeiro={pagamento:{id:id(200),valor_total_contratado:'13131',status:'PAGO'},original:versao,vigente:versao,reconhecida:versao,valorVigente:'1313100',posicao:{obrigacao:'1313100',liquido:'1313100',saldo:'0',credito:'0',reservado:'0',disponivel:'0',devolvido:'0'},posicaoHash:'simulada',pendencias:[],origens:[],provas:[],timeline:[],futuro:[],devolucoes:[],motivos:[]};
async function main(){
 fs.mkdirSync(out,{recursive:true});const generated=['next-env.d.ts','tsconfig.json'].map(p=>[p,fs.readFileSync(p)]);
 let occupied=false;try{await fetch(origin);occupied=true;}catch{}assert(!occupied,'Porta ocupada');
 const log=fs.openSync(out+'/server.log','w'),server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','-p','3027','--hostname','127.0.0.1'],{env:{...process.env,NODE_ENV:'development',KIDMAIS_FESTA_ISOLADO:'true',KIDMAIS_FESTA_AMBIENTE:'ux',DATABASE_URL:'postgresql://ux:ux@127.0.0.1:1/ux_no_database'},stdio:['ignore',log,log],windowsHide:true});
 let browser;const errors=[],unexpected=[],results=[];let liberarFinanceiro=null,bloquearFinanceiro=false,semPagamento=false;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/admin/festas')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(ready,'Servidor indisponível');
  const executablePath=chromium.executablePath();const launchOptions=fs.existsSync(executablePath)?{headless:true,executablePath}:process.platform==='win32'?{headless:true,channel:'msedge'}:{headless:true};
  browser=await chromium.launch(launchOptions);const context=await browser.newContext();
  await context.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){unexpected.push(req.method()+' '+url.pathname);return route.abort();}
   const ok=data=>route.fulfill({json:{ok:true,data}});
   if(url.pathname==='/api/admin/autenticacao')return ok({usuarioId:id(1),nome:'Teste visual',papel:'REPRESENTANTE_AUTORIZADO',csrf:'simulado'});
   if(url.pathname==='/api/admin/festas')return ok(festa);
   if(url.pathname==='/api/admin/contratos/painel'){
    await new Promise(r=>setTimeout(r,250));
    if(url.searchParams.has('contratoId')){assert.equal(url.searchParams.get('contratoId'),cid);return ok({...painel,financeiro:semPagamento?[]:painel.financeiro});}
    return ok([{id:cid,nome:snapshot.contratante.nomeCompleto,data_evento:snapshot.evento.data,pacote:'Festa Completa',convidados:120,status:'ASSINADO'}]);
   }
   if(url.pathname===`/api/admin/contratos/${cid}/financeiro`){if(bloquearFinanceiro)await new Promise(resolve=>{liberarFinanceiro=resolve;});return ok({painel:financeiro,papel:'REPRESENTANTE_AUTORIZADO'});}
   unexpected.push(url.pathname);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const abrirFesta=async()=>{await page.goto(origin+'/admin/festas/'+fid);await page.getByRole('heading',{name:'Resumo da contratação'}).waitFor();};
  const validarContrato=async(hash)=>{await page.locator('select[aria-label="Versão contratual"]').waitFor();assert.equal(await page.getByRole('combobox',{name:'Contrato',exact:true}).inputValue(),cid);assert.equal(await page.getByRole('combobox',{name:'Versão contratual',exact:true}).inputValue(),vid);const url=new URL(page.url());assert.equal(url.hash,hash);assert.equal(url.searchParams.get('versaoId'),vid);};
  const foco=async id=>{await page.waitForFunction(id=>document.activeElement?.id===id,id);const box=await page.locator('#'+id).boundingBox();assert(box.y>=0&&box.y<120,'Seção não posicionada: '+box.y);};
  for(const [label,width,height] of [['desktop',1280,900],['celular',390,844]]){
   await page.setViewportSize({width,height});await abrirFesta();await page.getByRole('link',{name:'Ver contrato',exact:true}).click();await validarContrato('');await page.getByRole('link',{name:'Voltar à festa',exact:true}).click();await page.waitForURL(origin+'/admin/festas/'+fid);
   await page.getByRole('heading',{name:'Resumo da contratação'}).waitFor();bloquearFinanceiro=true;await page.getByRole('link',{name:'Ver pagamentos',exact:true}).first().click();await validarContrato('#financeiro');await page.getByText('Carregando posição financeira…',{exact:true}).waitFor();assert.notEqual(await page.evaluate(()=>document.activeElement?.id),'financeiro');assert(liberarFinanceiro);liberarFinanceiro();liberarFinanceiro=null;bloquearFinanceiro=false;await page.getByRole('heading',{name:'Financeiro da contratação',exact:true}).waitFor();await foco('financeiro');await page.screenshot({path:out+'/financeiro-'+label+'.png'});
   await page.getByRole('link',{name:'Voltar à festa',exact:true}).click();await page.getByRole('heading',{name:'Resumo da contratação'}).waitFor();await page.getByRole('link',{name:'Editar contratação',exact:true}).click();await validarContrato('#alteracoes');await foco('alteracoes');await page.getByRole('heading',{name:'Iniciar uma alteração',exact:true}).waitFor();assert(await page.getByRole('button',{name:'Iniciar elaboração',exact:true}).isDisabled());await page.screenshot({path:out+'/alteracoes-'+label+'.png'});
   await page.getByRole('link',{name:'Voltar à festa',exact:true}).click();await page.getByRole('navigation',{name:'Seções da Festa'}).getByRole('button',{name:'Histórico',exact:true}).click();await page.getByRole('heading',{name:'Histórico da festa',exact:true}).waitFor();for(const name of ['Tarefa criada','Tarefa concluída','Escolhas do buffet atualizadas','Festa adicionada ao Manager'])await page.getByRole('heading',{name,exact:true}).waitFor();await page.getByText('Lembrancinha: Bola',{exact:true}).waitFor();const historico=page.locator('section').filter({has:page.getByRole('heading',{name:'Histórico da festa',exact:true})});assert(!/Criação explícita|FESTA_|\{"|Checklist atualizado/.test(await historico.innerText()));await historico.screenshot({path:out+'/historico-'+label+'.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   results.push({viewport:label,contratoVersao:true,financeiroAposCarga:true,alteracoes:true,retorno:true,historico:true});
  }
  semPagamento=true;await page.goto(origin+`/admin/contratos?contratoId=${cid}&versaoId=${vid}#financeiro`);await page.getByText('Nenhum Pagamento criado para este Fechamento.',{exact:true}).waitFor();await foco('financeiro');
  await page.goto(origin+`/admin/contratos?contratoId=${cid}&versaoId=${vid}&returnTo=https%3A%2F%2Fexample.com#alteracoes`);await validarContrato('#alteracoes');await foco('alteracoes');assert.equal(await page.getByRole('link',{name:'Voltar à festa',exact:true}).count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);fs.writeFileSync(out+'/resultados.json',JSON.stringify({ok:true,results,semPagamento:true,retornoInseguroRejeitado:true,errors,unexpected,dados:'Simulados; banco inacessível; todas as APIs interceptadas'},null,2));console.log(JSON.stringify(results));
 }finally{if(liberarFinanceiro)liberarFinanceiro();if(browser)await browser.close();if(process.platform==='win32')execFileSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill('SIGTERM');fs.closeSync(log);for(const [p,b]of generated)fs.writeFileSync(p,b);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
