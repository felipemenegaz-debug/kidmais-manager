/* eslint-disable @typescript-eslint/no-require-imports */
// Teste de componente no navegador: API interceptada, sem conexão ou escrita no PostgreSQL.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
async function main(){
 const root=path.resolve(__dirname,'..'),workspace=path.join(root,'.tmp','credito-projetado-ui-'+Date.now());
 fs.mkdirSync(workspace,{recursive:true});
 for(const e of fs.readdirSync(root,{withFileTypes:true})){
  if(['node_modules','.next','.tmp','.backups','.git'].includes(e.name)||e.name.startsWith('.env')||e.name==='tsconfig.tsbuildinfo')continue;
  fs.cpSync(path.join(root,e.name),path.join(workspace,e.name),{recursive:true});
 }
 fs.symlinkSync(path.join(root,'node_modules'),path.join(workspace,'node_modules'),'junction');
 fs.mkdirSync(path.join(workspace,'app/validacao-credito'),{recursive:true});
 fs.writeFileSync(path.join(workspace,'app/validacao-credito/page.tsx'),`import FinanceiroContrato from '@/components/admin/FinanceiroContrato'; export default function Page(){return <FinanceiroContrato contratoId="00000000-0000-4000-8000-000000000015"/>;}`);
 const log=fs.openSync(path.join(workspace,'next.log'),'w');
 const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--webpack','-p','3102'],{cwd:workspace,env:{...process.env,DATABASE_URL:'',NODE_ENV:'development'},stdio:['ignore',log,log],windowsHide:true});
 let browser;
 try{
  for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('Servidor de teste encerrou');try{if((await fetch('http://localhost:3102/validacao-credito')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const {chromium}=require('C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const v1={id:'v1',numero_versao:1,snapshot:{evento:{data:'2026-12-10'},comercial:{formaPagamentoPretendida:'PIX_PARCELADO'}}},v3={...v1,id:'v3',numero_versao:3};
  function fixture(){return {original:v1,reconhecida:v1,vigente:v3,valorVigente:'836100',pagamento:{id:'p',valor_total_contratado:'9290.00',status:'QUITADO'},posicao:{obrigacao:'929000',liquido:'929000',saldo:'0',credito:'0',reservado:'0',disponivel:'0',devolvido:'0'},posicaoHash:'hash-teste',motivos:['VALOR'],pendencias:[{id:'pend',versao_nova_id:'v3',situacao:'EM_TRATAMENTO',tentativas:[{id:'tentativa',tentativa:1,estado:'EM_TRATAMENTO'}]}],futuro:[],origens:[],provas:[],timeline:[],devolucoes:[],cronograma:null};}
  let painel=fixture(),aumento=false;const posts=[];
  await page.route('**/api/admin/**',async route=>{
   const req=route.request(),url=new URL(req.url());let data;
   if(url.pathname==='/api/admin/autenticacao')data={usuarioId:'sintetico',csrf:'teste'};
   else if(req.method()==='GET')data={painel,papel:'REPRESENTANTE_AUTORIZADO'};
   else{
    const body=req.postDataJSON();posts.push({path:url.pathname,body});
    if(aumento){assert.equal(body.credito,'NAO_SE_APLICA');assert.equal(body.parcelas.length,1);assert.equal(body.parcelas[0].valorCentavos,'50000');}
    else{assert.equal(body.credito,'MANTER');assert.equal(body.modo,'SEM_SALDO');assert.deepEqual(body.parcelas,[]);}
    const depois=aumento?{...painel.posicao,obrigacao:'929000',saldo:'50000',credito:'0',disponivel:'0'}:{...painel.posicao,obrigacao:'836100',credito:'92900',disponivel:'92900'};
    if(url.pathname.endsWith('/simulacao'))data={delta:aumento?'92900':'-92900',depois};
    else if(url.pathname.endsWith('/resolver')){painel={...painel,posicao:depois,reconhecida:v3,pendencias:[]};data={resultado:{creditoCentavos:'92900'}};}
    else throw Error('Comando inesperado: '+url.pathname);
   }
   await route.fulfill({json:{ok:true,data}});
  });
  const ui=page.getByRole('region',{name:'Financeiro da contratação'});
  for(const escolha of ['MANTER','SOLICITAR_DEVOLUCAO']){
   painel=fixture();posts.length=0;await page.goto('http://localhost:3102/validacao-credito');
   await ui.getByRole('button',{name:'Retomar tratamento',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();
   await ui.getByText(/Crédito projetado:/).waitFor();assert.match(await ui.getByText(/Crédito projetado:/).innerText(),/929,00/);
   assert.equal(await ui.getByLabel('Crédito',{exact:true}).inputValue(),'');
   assert.deepEqual(await ui.getByLabel('Crédito',{exact:true}).locator('option:not([disabled])').allTextContents(),['Manter crédito na contratação','Solicitar devolução']);
   assert(await ui.getByRole('button',{name:'Continuar',exact:true}).isDisabled());
   assert.equal(painel.posicao.disponivel,'0');assert.equal(posts.length,0);
   await ui.getByLabel('Crédito',{exact:true}).selectOption(escolha);await ui.getByLabel('Justificativa e autorização').fill('Redução quitada sintética');
   await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();
   await ui.getByRole('button',{name:'Validar simulação',exact:true}).click();await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).waitFor();
   assert.equal(painel.posicao.disponivel,'0');assert.equal(posts.length,1);assert(posts[0].path.endsWith('/simulacao'));
   await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).click();await ui.getByText('Tratamento confirmado. Nenhum recebimento foi criado.',{exact:true}).waitFor();
   assert.equal(posts.length,2);assert(posts[1].path.endsWith('/resolver'));
   assert.equal(await ui.getByRole('group',{name:'Solicitar devolução — reserva de crédito'}).count(),escolha==='SOLICITAR_DEVOLUCAO'?1:0);
  }
  aumento=true;painel=fixture();painel.reconhecida=v3;painel.vigente={...v3,id:'v4',numero_versao:4};painel.valorVigente='929000';painel.pendencias[0].versao_nova_id='v4';
  painel.posicao={...painel.posicao,obrigacao:'836100',liquido:'879000',credito:'42900',disponivel:'42900',devolvido:'50000'};posts.length=0;
  await page.goto('http://localhost:3102/validacao-credito');await ui.getByRole('button',{name:'Retomar tratamento',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();
  assert.equal(await ui.getByLabel('Crédito',{exact:true}).inputValue(),'NAO_SE_APLICA');
  assert.deepEqual(await ui.getByLabel('Crédito',{exact:true}).locator('option').allTextContents(),['Não se aplica']);
  assert.match(await ui.getByText(/Crédito projetado:/).innerText(),/0,00/);assert(await ui.getByRole('button',{name:'Continuar',exact:true}).isEnabled());
  await ui.getByLabel('Justificativa e autorização').fill('Absorção natural de crédito anterior');await ui.getByRole('button',{name:'Continuar',exact:true}).click();
  assert.equal(await ui.getByLabel('Valor da parcela 1',{exact:true}).inputValue(),'500,00');assert.equal(await ui.locator('input[aria-label^="Valor da parcela"]').count(),1);
  await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByRole('button',{name:'Validar simulação',exact:true}).click();await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).waitFor();
  assert.equal(posts.length,1);assert(posts[0].path.endsWith('/simulacao'));assert.equal(painel.posicao.obrigacao,'836100');
  await require('./financeiro-acabamento-ui.cjs')({page,workspace});
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(workspace,'credito-projetado.png'),fullPage:true});
  console.log('PASS aumento posterior: NAO_SE_APLICA automático, Continuar habilitado, Etapa 3 programa 50000 e somente simulação enviada.');
  console.log('PASS navegador: crédito projetado 92900, escolha explícita, opções coerentes, serialização MANTER e devolução somente após confirmação. PostgreSQL não acessado.');
 }finally{if(browser)await browser.close();server.kill();fs.closeSync(log);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
