/* eslint-disable @typescript-eslint/no-require-imports */
// UI real na porta manual, com registros lidos em transação READ ONLY.
// A sessão visual e as respostas GET são locais ao navegador; não cria sessão nem registros no banco.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {client,installPool,fingerprint}=require('./pagamentos-test-support.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://localhost:3017',out='.local-festa/ux-final';
const fid=process.argv.find(a=>a.startsWith('--festa-id='))?.slice(11);
assert.match(fid??'',/^[0-9a-f-]{36}$/i,'Informe --festa-id=UUID existente no clone manual.');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/'+require('../.local-festa/environments.json').manual,'Somente clone manual');
async function main(){
 fs.mkdirSync(out,{recursive:true});const migration=fs.readFileSync('database/migrations/20260911_016_festa.sql');
 const c=client();await c.connect();let browser;
 try{
  assert.equal((await c.query('select current_database() n')).rows[0].n,require('../.local-festa/environments.json').manual);
  await c.query('BEGIN READ ONLY');installPool(c);
  const before=await fingerprint(c);
  const festa=(await c.query('select * from festas where id=$1',[fid])).rows[0];assert(festa,'Festa não encontrada');
  const repo=require('../lib/festas/repository.ts'),contrato=await repo.contrato(c,festa.contrato_id),itens=await repo.filhos(c,fid),contagens=await repo.contagens(c,festa);
  const painel=await require('../lib/contratos/services/administrativo.service.ts').detalheAdministrativo(contrato.id);
  const financeiro=painel.financeiro.length?await require('../lib/pagamentos/services/financeiro-consulta.service.ts').consultarPainelFinanceiro(contrato.id):null;
  const cid=contrato.id,vid=contrato.versao_id;
  const serializar=x=>JSON.parse(JSON.stringify(x));
  const festaData=serializar({festa,contrato,itens,contagens,financeiro:financeiro?.posicao,capacidades:['FESTA_CONSULTAR','FESTA_CORRIGIR'],areas:[],usuarios:[]});
  assert((await fetch(origin+'/admin/festas')).ok,'Inicie o servidor manual na porta 3017.');
  browser=await chromium.launch({headless:true,channel:'msedge'});const context=await browser.newContext();const errors=[],blocked=[];
  await context.route('**/api/**',async route=>{
   const req=route.request(),u=new URL(req.url());if(req.method()!=='GET'){blocked.push(req.method()+' '+u.pathname);return route.abort();}
   let data;
   if(u.pathname==='/api/admin/autenticacao')data={usuarioId:'sessao-somente-visual',nome:'Validação sem gravação',papel:'REPRESENTANTE_AUTORIZADO',csrf:'visual'};
   else if(u.pathname==='/api/admin/festas')data=festaData;
   else if(u.pathname==='/api/admin/contratos/painel'){if(u.searchParams.has('contratoId')){assert.equal(u.searchParams.get('contratoId'),cid);data=painel;}else data=[{id:cid,nome:contrato.snapshot.contratante.nomeCompleto}];}
   else if(u.pathname===`/api/admin/contratos/${cid}/financeiro`){await new Promise(r=>setTimeout(r,600));data={painel:financeiro,papel:'REPRESENTANTE_AUTORIZADO'};}
   else {blocked.push(u.pathname);return route.abort();}
   return route.fulfill({json:{ok:true,data:serializar(data)}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  // Reproduz restauração tardia do Router, depois do primeiro posicionamento React.
  await page.addInitScript(()=>{const native=Element.prototype.scrollIntoView;window.__financeiroScrolls=0;Element.prototype.scrollIntoView=function(...args){native.apply(this,args);if(this.id==='financeiro'&&++window.__financeiroScrolls===1)setTimeout(()=>window.scrollTo(0,0),100);};});
  const abrir=async()=>{await page.goto(origin+'/admin/festas/'+fid);await page.getByRole('heading',{name:'Resumo da contratação',exact:true}).waitFor();};
  const selecionado=async()=>{await page.getByRole('combobox',{name:'Versão contratual',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'Contrato',exact:true}).inputValue(),cid);assert.equal(await page.getByRole('combobox',{name:'Versão contratual',exact:true}).inputValue(),vid);};
  const visivel=async id=>{await page.waitForFunction(id=>document.activeElement?.id===id,id);const box=await page.locator('#'+id).boundingBox();assert(box.y>=0&&box.y<100,`${id} fora do topo: ${box.y}`);};
  const results=[];
  for(const [label,width,height]of [['desktop',1280,900],['celular',390,844]]){
   await page.setViewportSize({width,height});await abrir();await page.getByRole('link',{name:'Ver contrato',exact:true}).click();await selecionado();assert.equal(new URL(page.url()).hash,'');
   await abrir();await page.getByRole('link',{name:'Ver pagamentos',exact:true}).first().click();await selecionado();assert.equal(new URL(page.url()).hash,'#financeiro');await page.getByText('Carregando posição financeira…',{exact:true}).waitFor();assert.notEqual(await page.evaluate(()=>document.activeElement?.id),'financeiro');await page.getByRole('heading',{name:'Financeiro da contratação',exact:true}).waitFor();await page.waitForTimeout(850);await visivel('financeiro');const n=await page.evaluate(()=>window.__financeiroScrolls);assert(n>=2&&n<=3,'Correção limitada, sem loop');await page.screenshot({path:out+'/financeiro-'+label+'.png'});
   await page.mouse.wheel(0,-700);await page.waitForTimeout(150);const y=await page.evaluate(()=>scrollY);await page.waitForTimeout(650);assert(Math.abs(await page.evaluate(()=>scrollY)-y)<2,'Não disputar scroll com o usuário');
   await abrir();await page.getByRole('link',{name:'Editar contratação',exact:true}).click();await selecionado();await visivel('alteracoes');await page.screenshot({path:out+'/alteracoes-'+label+'.png'});
   await page.getByRole('link',{name:'Voltar à festa',exact:true}).click();await page.getByRole('button',{name:'Histórico',exact:true}).click();const history=page.locator('section').filter({has:page.getByRole('heading',{name:'Histórico da festa',exact:true})});await history.waitFor();const content=await history.innerText();assert(!/Criação explícita|FESTA_|\d{2}:\d{2}:\d{2}/.test(content));assert.match(content,/\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2} • /);
   for(const titulo of ['Tarefa criada','Tarefa concluída','Festa adicionada ao Manager'])await history.getByRole('heading',{name:titulo,exact:true}).waitFor();const buffet=itens.eventos.find(e=>e.tipo==='FESTA_BUFFET');if(buffet?.dados_depois?.lembrancinha)await history.getByText('Lembrancinha: '+buffet.dados_depois.lembrancinha,{exact:true}).waitFor();await history.screenshot({path:out+'/historico-'+label+'.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   results.push({tela:label,A:true,B:true,C:true,D:true,E:true,F:true,restauracaoTardiaCorrigida:true,scrolls:n});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(await fingerprint(c),before);assert(fs.readFileSync('database/migrations/20260911_016_festa.sql').equals(migration));
  fs.writeFileSync(out+'/resultado-manual.json',JSON.stringify({results,origin,festaId:fid,contratoId:cid,versaoId:vid,eventosReais:itens.eventos.length,banco:'READ ONLY; sem gravação',sessao:'simulada no navegador para não criar sessão no banco',migrationSha256:crypto.createHash('sha256').update(migration).digest('hex')},null,2));console.log(JSON.stringify(results));
 }finally{if(browser)await browser.close();await c.query('ROLLBACK');await c.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
