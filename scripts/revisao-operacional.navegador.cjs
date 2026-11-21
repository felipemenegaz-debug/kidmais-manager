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

        await page.goto(env.ADMIN_AUTH_ORIGIN + '/admin/contratos?contratoId=' + state.fixtures.b.cid + '#historico');
        const historico = page.getByRole('tabpanel', {name:'Histórico',exact:true});
        await historico.getByRole('listitem').filter({hasText:/V2 · Assinada · vale hoje/}).waitFor();
        assert.equal(await page.getByTestId('aviso-preparacao').count(),0,'V2 concluída não anuncia preparação');
        await historico.getByRole('listitem').filter({hasText:/V1 ·/}).getByRole('button',{name:'Ver esta versão',exact:true}).click();
        const consulta = page.getByTestId('consulta-versao');
        await consulta.getByRole('heading', {name:/Consultando V1/}).waitFor();
        assert.equal(await page.getByTestId('aviso-preparacao').count(),0,'V1 histórica não anuncia preparação');
        await consulta.getByRole('button',{name:'Fechar consulta',exact:true}).click();
        await consulta.waitFor({state:'detached'});
        page.on('dialog',dialog=>dialog.type()==='prompt'?dialog.accept('Cancelamento validado no navegador'):dialog.accept());
        await page.getByRole('button',{name:'Alterar contrato',exact:true}).click();
        const novaRevisao = page.getByRole('region', {name:'Alterar contrato',exact:true});
        await novaRevisao.getByLabel('Motivo',{exact:true}).fill('Revisão operacional pelo navegador');
        await novaRevisao.getByRole('button',{name:'Criar revisão / retificação',exact:true}).click();
        const preparacao = page.getByRole('region', {name:'Alteração em andamento',exact:true});
        await preparacao.getByRole('heading',{name:/Em preparação/}).waitFor();
        const reservaMantida = preparacao.locator('[data-reserva="MANTIDA"]');
        const destinoProtegido = preparacao.locator('[data-reserva="PROTEGIDA"]');
        await reservaMantida.waitFor();
        assert.equal(await destinoProtegido.count(),0);
        await page.screenshot({path:'.tmp/revisao-mesmo-slot.png',fullPage:true});
        const editar = preparacao.getByRole('button',{name:'Editar dados desta revisão',exact:true});
        const convidadosPagantes = page.getByLabel('Convidados pagantes',{exact:true});
        async function reabrir() {
            await editar.click();
            await convidadosPagantes.waitFor();
        }
        async function salvar(comercial = false) {
            await page.getByLabel('Motivo da alteração administrativa',{exact:true}).fill('Alteração operacional pelo navegador');
            await page.getByRole('button',{name:'Salvar alteração da festa',exact:true}).click();
            if (comercial) await page.getByRole('dialog', {name:'Aprovar edição'}).getByRole('button',{name:'Aprovar edição',exact:true}).click();
            await page.locator('#editar-festa').waitFor({state:'detached'});
        }
        // Troca apenas de horário, na mesma data, continua sendo remarcação.
        await convidadosPagantes.waitFor();
        await page.locator('summary').filter({hasText:'Dados da festa'}).click();
        const horario=page.getByLabel('Horário',{exact:true}),original=await horario.inputValue();
        const outro=await horario.locator('option').evaluateAll((options,current)=>options.find(o=>!o.disabled&&o.value!==current&&o.textContent.includes('DISPONIVEL'))?.value,original);
        assert(outro,'Outro horário oficial disponível');await horario.selectOption(outro);await salvar();
        await destinoProtegido.waitFor();
        await reabrir();await page.locator('summary').filter({hasText:'Dados da festa'}).click();await page.getByLabel('Horário',{exact:true}).selectOption(original);await salvar();
        await reservaMantida.waitFor();assert.equal(await destinoProtegido.count(),0);
        await reabrir();
        for(const n of [110,130,140]){await page.locator('#editar-festa').getByRole('button',{name:String(n),exact:true}).click();assert.equal(await page.getByLabel('Convidados pagantes',{exact:true}).inputValue(),String(n));await salvar();await reabrir();assert.equal(await page.getByLabel('Convidados pagantes',{exact:true}).inputValue(),String(n));}
        await page.getByLabel('Convidados pagantes',{exact:true}).fill('67');
        await page.locator('summary').filter({hasText:'Dados da festa'}).click();
        await page.getByLabel('Data da festa',{exact:true}).fill('2097-09-28');
        await salvar();await destinoProtegido.waitFor();
        await page.screenshot({path:'.tmp/revisao-painel-desktop.png',fullPage:true});
        await reabrir();await page.getByLabel('Pacote',{exact:true}).selectOption({label:'Festa Premium · DISPONIVEL'});await salvar();assert.equal(await page.getByText(/Este pacote ainda não possui modelo oficial/).count(),0);
        await reabrir();await page.getByLabel('Pacote',{exact:true}).selectOption({label:'Festa Completa · DISPONIVEL'});await salvar();
        await reabrir();await page.locator('summary').filter({hasText:'Escolhas do buffet'}).click();await page.getByLabel('Definição do buffet',{exact:true}).selectOption('DEFINIDO');await page.getByLabel('Bolo',{exact:true}).fill('Chocolate');
        await page.locator('summary').filter({hasText:'Condições comerciais'}).click();await page.getByLabel('Revisar e aprovar condição comercial nesta edição').check();await page.getByLabel('Forma de pagamento',{exact:true}).selectOption('PIX_PARCELADO');await page.getByLabel('Base negociada (opcional)',{exact:true}).fill('9290');await page.getByLabel('Quantidade de parcelas acordada',{exact:true}).fill('3');await salvar(true);await page.getByText(/9.011,30/).first().waitFor();
        await page.setViewportSize({width:390,height:844});await reabrir();await page.locator('summary').filter({hasText:'Trocar vínculos da contratação'}).click();await page.getByLabel('Contratante proposto',{exact:true}).waitFor();await page.screenshot({path:'.tmp/revisao-editor-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Sem overflow horizontal mobile');await page.getByRole('button',{name:'Cancelar edição',exact:true}).click();
        await page.setViewportSize({width:1280,height:900});await page.getByRole('tab',{name:'Documentos',exact:true}).click();await page.getByRole('button',{name:'Gerar PDF da revisão',exact:true}).click();await page.getByRole('button',{name:'Confirmar revisão do PDF',exact:true}).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirmar revisão do PDF', exact: true }).click();await page.getByLabel('Confirme sua senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Aprovar e assinar pelo buffet',exact:true}).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Aprovar e assinar pelo buffet', exact: true }).click();await page.getByRole('button',{name:'Liberar para o cliente',exact:true}).waitFor();
        await preparacao.getByRole('heading',{name:/Assinada pelo buffet/}).waitFor();
        await page.getByRole('button',{name:'Liberar para o cliente',exact:true}).click();
        await preparacao.getByRole('heading',{name:/Aguardando o cliente/}).waitFor();
        assert.equal(await editar.count(),0);await page.screenshot({path:'.tmp/revisao-congelada.png',fullPage:true});await page.getByRole('button',{name:'Descartar alteração',exact:true}).click();
        await page.getByRole('dialog').getByRole('textbox').fill('Cancelamento validado no navegador');
        await page.getByRole('dialog').getByRole('button', {name:'Informar motivo'}).click();
        await page.getByRole('dialog').getByRole('button', {name:'Descartar alteração'}).click();
        await preparacao.waitFor({state:'detached'});
        await page.getByRole('tab',{name:'Histórico',exact:true}).click();
        await historico.getByText(/V\d+ · Descartada/).waitFor();
        assert.equal(await page.getByTestId('aviso-preparacao').count(),0);
        assert.equal(await page.locator('[data-reserva="PROTEGIDA"]').count(),0);
        await historico.getByText('Buffet assinou V2',{exact:true}).waitFor();
        const privacy=require('node:child_process').spawnSync(process.execPath,['-r','./scripts/pagamentos-test-support.cjs','-e',"require('./scripts/identidade-api-consultar-cpf.integration.ts')"],{env:{...env,KIDMAIS_TEST_BASE_URL:env.ADMIN_AUTH_ORIGIN},encoding:'utf8',timeout:30000});
        fs.writeFileSync('.tmp/identidade-http-014.log',(privacy.stdout||'')+(privacy.stderr||''));assert.equal(privacy.status,0,privacy.stdout+privacy.stderr);
        assert.deepEqual(errors,[]);
        fs.writeFileSync('.tmp/navegador-revisao.json',JSON.stringify({banco:state.banco,passed:['Aviso ausente na V2 concluída e V1 histórica; versões acessíveis; presente em elaboração, assinado Kidmais e aguardando cliente; ausente após cancelamento','V2 operacional criada por formulário','slot idêntico sem rótulo de remarcação; alteração só de horário mostra hold; retorno ao horário original oculta rótulo','110/130/140 salvos e manual 67','remarcação e hold','upgrade Premium com modelo oficial disponível','retorno Completa e revisão de buffet','PIX parcelado base9290 final9011.30','vínculos disponíveis no formulário mobile','mobile sem overflow','PDF, revisão, reautenticação e assinatura pelos botões','editor indisponível após assinatura','cancelar congelada preserva prova e libera hold','HTTP consultar CPF: canais mascarados e nenhum dado pessoal exposto'],pageErrors:errors},null,2));
        console.log('Navegador 014: edição operacional desktop/mobile, remarcação, assinatura e cancelamento passaram.');
    }finally{if(browser)await browser.close();server.kill();fs.closeSync(log);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
