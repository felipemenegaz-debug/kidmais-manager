/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const assert = require('node:assert/strict');
const path = require('node:path');
async function main() {
    const state = JSON.parse(fs.readFileSync('.tmp/revisao-operacional-resultados.json'));
    assert.match(state.banco, /^kidmais_revisao_\d+$/);
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + state.banco;
    const env = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: 'development', ADMIN_AUTH_ORIGIN: 'http://localhost:3101', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex') };
    const password = randomBytes(24).toString('base64url'), email = `visual-${Date.now()}@example.invalid`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await require('./admin-provision.cjs').provisionar(c, { acao: 'criar', email, nome: 'Representante visual sintético', papel: 'REPRESENTANTE_AUTORIZADO', senha: password });
    await c.end();
    // O servidor do operador continua rodando. UI de teste em cópia isolada e banco clonado.
    const workspace = path.resolve('.tmp/ui-revisao-' + Date.now());
    fs.mkdirSync(workspace, { recursive: true });
    for (const e of fs.readdirSync('.', { withFileTypes: true })) {
        if (['node_modules', '.next', '.tmp', '.backups', '.git', '.env.local', 'tsconfig.tsbuildinfo'].includes(e.name))
            continue;
        fs.cpSync(e.name, path.join(workspace, e.name), { recursive: true });
    }
    fs.symlinkSync(path.resolve('node_modules'), path.join(workspace, 'node_modules'), 'junction');
    const log = fs.openSync('.tmp/next-validacao-revisao.log', 'w');
    const server = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--webpack', '-p', '3101'], { env, cwd: workspace, stdio: ['ignore', log, log], windowsHide: true });
    let browser;
    try {
        for (let i = 0; i < 90; i++) {
            if (server.exitCode !== null)
                throw Error('Servidor isolado encerrou. Consulte .tmp/next-validacao-revisao.log');
            try {
                if ((await fetch(env.ADMIN_AUTH_ORIGIN + '/admin/login')).ok)
                    break;
            }
            catch { }
            await new Promise(r => setTimeout(r, 500));
        }
        const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
        browser = await chromium.launch({ headless: true, channel: 'msedge' });
        const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await browserContext.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(env.ADMIN_AUTH_ORIGIN + '/admin/contratos');
        await page.waitForURL('**/admin/login');
        await page.screenshot({ path: '.tmp/revisao-login.png', fullPage: true });
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Senha', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Entrar', exact: true }).click();
        await page.waitForURL('**/admin/contratos');
        await page.getByRole('heading', { name: 'Contratos', exact: true }).waitFor();
        await require('./financeiro-ui-015.cjs')({page,url:url.toString()});

        await page.getByLabel('Contrato',{exact:true}).selectOption(state.fixtures.b.cid);
        await page.getByLabel('Versão contratual',{exact:true}).selectOption(state.fixtures.vb);
        assert.equal(await page.getByTestId('aviso-preparacao').count(),0,'V2 concluída não anuncia preparação');
        const historica = await page.getByLabel('Versão contratual',{exact:true}).locator('option').evaluateAll(options=>options.find(o=>o.textContent.startsWith('V1 '))?.value);
        assert(historica);await page.getByLabel('Versão contratual',{exact:true}).selectOption(historica);
        await page.getByText('Esta é uma versão histórica. A versão vigente atual é V2.',{exact:true}).waitFor();
        assert.equal(await page.getByTestId('aviso-preparacao').count(),0,'V1 histórica não anuncia preparação');
        await page.getByLabel('Versão contratual',{exact:true}).selectOption(state.fixtures.vb);
        page.on('dialog',dialog=>dialog.type()==='prompt'?dialog.accept('Cancelamento validado no navegador'):dialog.accept());
        await page.getByLabel('Motivo',{exact:true}).fill('Revisão operacional pelo navegador');
        await page.getByRole('button',{name:'Iniciar elaboração',exact:true}).click();
        await page.getByRole('button',{name:'Editar festa',exact:true}).waitFor();
        await page.getByTestId('aviso-preparacao').filter({hasText:'está em elaboração'}).waitFor();
        await page.getByRole('heading',{name:'Agenda da revisão',exact:true}).waitFor();
        await page.getByText(/RESERVA CONFIRMADA/).waitFor();
        await page.getByText(/RESERVA CONFIRMADA — data e horário mantidos/).waitFor();
        assert.equal(await page.getByText(/HOLD DE REMARCAÇÃO/).count(),0);
        await page.screenshot({path:'.tmp/revisao-mesmo-slot.png',fullPage:true});
        async function abrir(){await page.getByRole('button',{name:'Editar festa',exact:true}).click();await page.getByLabel('Convidados pagantes',{exact:true}).waitFor();}
        async function salvar(){await page.getByLabel('Motivo da alteração administrativa',{exact:true}).fill('Alteração operacional pelo navegador');await page.getByRole('button',{name:'Salvar alteração da festa',exact:true}).click();await page.locator('#editar-festa').waitFor({state:'detached'});}
        // Troca apenas de horário, na mesma data, continua sendo remarcação.
        await abrir();await page.locator('summary').filter({hasText:'Dados da festa'}).click();
        const horario=page.getByLabel('Horário',{exact:true}),original=await horario.inputValue();
        const outro=await horario.locator('option').evaluateAll((options,current)=>options.find(o=>!o.disabled&&o.value!==current&&o.textContent.includes('DISPONIVEL'))?.value,original);
        assert(outro,'Outro horário oficial disponível');await horario.selectOption(outro);await salvar();
        await page.getByText(/HOLD DE REMARCAÇÃO/).waitFor();
        await abrir();await page.locator('summary').filter({hasText:'Dados da festa'}).click();await page.getByLabel('Horário',{exact:true}).selectOption(original);await salvar();
        await page.getByText(/RESERVA CONFIRMADA — data e horário mantidos/).waitFor();assert.equal(await page.getByText(/HOLD DE REMARCAÇÃO/).count(),0);
        await abrir();
        for(const n of [110,130,140]){await page.locator('#editar-festa').getByRole('button',{name:String(n),exact:true}).click();assert.equal(await page.getByLabel('Convidados pagantes',{exact:true}).inputValue(),String(n));await salvar();await page.getByText(new RegExp(n+' convidados')).first().waitFor();await abrir();}
        await page.getByLabel('Convidados pagantes',{exact:true}).fill('67');
        await page.locator('summary').filter({hasText:'Dados da festa'}).click();
        await page.getByLabel('Data da festa',{exact:true}).fill('2097-09-28');
        await salvar();await page.getByText(/HOLD DE REMARCAÇÃO/).waitFor();
        await page.screenshot({path:'.tmp/revisao-painel-desktop.png',fullPage:true});
        await abrir();await page.getByLabel('Pacote',{exact:true}).selectOption({label:'Festa Premium · DISPONIVEL'});await salvar();assert.equal(await page.getByText(/Este pacote ainda não possui modelo oficial/).count(),0);
        await abrir();await page.getByLabel('Pacote',{exact:true}).selectOption({label:'Festa Completa · DISPONIVEL'});await salvar();
        await abrir();await page.locator('summary').filter({hasText:'Escolhas do buffet'}).click();await page.getByLabel('Definição do buffet',{exact:true}).selectOption('DEFINIDO');await page.getByLabel('Bolo',{exact:true}).fill('Chocolate');
        await page.locator('summary').filter({hasText:'Condições comerciais'}).click();await page.getByLabel('Revisar e aprovar condição comercial nesta edição').check();await page.getByLabel('Forma de pagamento',{exact:true}).selectOption('PIX_PARCELADO');await page.getByLabel('Base negociada (opcional)',{exact:true}).fill('9290');await page.getByLabel('Quantidade de parcelas acordada',{exact:true}).fill('3');await salvar();await page.getByText(/9.011,30/).first().waitFor();
        await page.setViewportSize({width:390,height:844});await abrir();await page.locator('summary').filter({hasText:'Trocar vínculos da contratação'}).click();await page.getByLabel('Contratante proposto',{exact:true}).waitFor();await page.screenshot({path:'.tmp/revisao-editor-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Sem overflow horizontal mobile');await page.getByRole('button',{name:'Cancelar edição',exact:true}).click();
        await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:/Gerar PDF da revisão/}).click();await page.getByRole('button',{name:'Confirmar revisão deste PDF',exact:true}).click();await page.getByLabel('Confirme sua senha',{exact:true}).fill(password);await page.getByRole('button',{name:'APROVAR E ASSINAR PELA KIDMAIS',exact:true}).click();await page.getByRole('button',{name:'LIBERAR PARA O CLIENTE',exact:true}).waitFor();
        await page.getByTestId('aviso-preparacao').filter({hasText:'aguarda liberação para o cliente'}).waitFor();
        await page.getByRole('button',{name:'LIBERAR PARA O CLIENTE',exact:true}).click();
        await page.getByTestId('aviso-preparacao').filter({hasText:'aguarda a assinatura do cliente'}).waitFor();
        assert.equal(await page.getByRole('button',{name:'Editar festa',exact:true}).count(),0);await page.screenshot({path:'.tmp/revisao-congelada.png',fullPage:true});await page.getByRole('button',{name:'Cancelar revisão',exact:true}).click();await page.getByText('CANCELADA',{exact:true}).first().waitFor();assert.equal(await page.getByTestId('aviso-preparacao').count(),0);assert.equal(await page.getByText(/HOLD DE REMARCAÇÃO/).count(),0);await page.getByText(/KIDMAIS:/).waitFor();
        const privacy=require('node:child_process').spawnSync(process.execPath,['-r','./scripts/pagamentos-test-support.cjs','-e',"require('./scripts/identidade-api-consultar-cpf.integration.ts')"],{env:{...env,KIDMAIS_TEST_BASE_URL:env.ADMIN_AUTH_ORIGIN},encoding:'utf8',timeout:30000});
        fs.writeFileSync('.tmp/identidade-http-014.log',(privacy.stdout||'')+(privacy.stderr||''));assert.equal(privacy.status,0,privacy.stdout+privacy.stderr);
        assert.deepEqual(errors,[]);
        fs.writeFileSync('.tmp/navegador-revisao.json',JSON.stringify({banco:state.banco,passed:['Aviso ausente na V2 concluída e V1 histórica; versões acessíveis; presente em elaboração, assinado Kidmais e aguardando cliente; ausente após cancelamento','V2 operacional criada por formulário','slot idêntico sem rótulo de remarcação; alteração só de horário mostra hold; retorno ao horário original oculta rótulo','110/130/140 salvos e manual 67','remarcação e hold','upgrade Premium com modelo oficial disponível','retorno Completa e revisão de buffet','PIX parcelado base9290 final9011.30','vínculos disponíveis no formulário mobile','mobile sem overflow','PDF, revisão, reautenticação e assinatura pelos botões','editor indisponível após assinatura','cancelar congelada preserva prova e libera hold','HTTP consultar CPF: canais mascarados e nenhum dado pessoal exposto'],pageErrors:errors},null,2));
        console.log('Navegador 014: edição operacional desktop/mobile, remarcação, assinatura e cancelamento passaram.');
    }finally{if(browser)await browser.close();server.kill();fs.closeSync(log);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
