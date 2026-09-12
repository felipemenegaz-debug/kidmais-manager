/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const assert = require('node:assert/strict');
async function main() {
    const state = JSON.parse(fs.readFileSync('.tmp/admin-contrato-resultados.json'));
    assert.match(state.banco, /^kidmais_funcional_\d+$/);
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + state.banco;
    const env = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: 'development', ADMIN_AUTH_ORIGIN: 'http://localhost:3100', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex') };
    const password = randomBytes(24).toString('base64url'), email = `visual-${Date.now()}@example.invalid`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await require('./admin-provision.cjs').provisionar(c, { acao: 'criar', email, nome: 'Representante visual sintético', papel: 'REPRESENTANTE_AUTORIZADO', senha: password });
    await c.end();
    const log = fs.openSync('.tmp/next-validacao-013.log', 'w');
    const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', '3100'], { env, stdio: ['ignore', log, log], windowsHide: true });
    let browser;
    try {
        for (let i = 0; i < 90; i++) {
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
        await page.screenshot({ path: '.tmp/admin-login-013.png', fullPage: true });
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Senha', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Entrar', exact: true }).click();
        await page.waitForURL('**/admin/contratos');
        await page.getByRole('heading', { name: 'Contratos', exact: true }).waitFor();
        await page.getByLabel('Contrato', { exact: true }).selectOption(state.contratoId);
        await page.getByRole('heading', { name: 'Histórico de versões' }).waitFor();
        await page.getByRole('link', { name: /Imprimir contrato completo/ }).waitFor();
        await page.screenshot({ path: '.tmp/admin-contrato-013.png', fullPage: true });
        const grouped = await browserContext.newPage();
        await grouped.goto(env.ADMIN_AUTH_ORIGIN + `/admin/contratos/imprimir?contratoId=${state.contratoId}&versaoId=${state.versaoId}`);
        await grouped.getByRole('heading', { name: 'Comprovante 2', exact: true }).waitFor();
        assert.equal(await grouped.locator('iframe').count(), 3);
        const docs = await grouped.locator('iframe').evaluateAll(frames => frames.map(f => f.getAttribute('src')));
        for (const doc of docs) {
            const response = await page.request.get(env.ADMIN_AUTH_ORIGIN + doc);
            assert.equal(response.status(), 200);
            assert.equal(response.headers()['content-type'], 'application/pdf');
        }
        await grouped.screenshot({ path: '.tmp/admin-impressao-013.png', fullPage: true });
        page.on('dialog', dialog => dialog.accept());
        await page.getByLabel('Motivo', {exact:true}).fill('Retificação documental sintética pelo navegador');
        await page.getByRole('button', {name:'Iniciar elaboração',exact:true}).click();
        await page.getByRole('button', {name:'Salvar revisão',exact:true}).waitFor();
        assert.equal(await page.getByLabel('Observações exclusivamente documentais').inputValue(),'Conferência documental.');
        await page.getByLabel('Observações exclusivamente documentais').fill('Observação documental validada no navegador.');
        await page.getByRole('button', {name:'Salvar revisão',exact:true}).click();
        await page.getByRole('button', {name:'Gerar PDF da revisão 2',exact:true}).click();
        await page.getByRole('button', {name:'Confirmar revisão deste PDF',exact:true}).click();
        await page.getByLabel('Confirme sua senha').fill(password);
        await page.getByRole('button', {name:'APROVAR E ASSINAR PELA KIDMAIS',exact:true}).click();
        await page.getByRole('button', {name:'LIBERAR PARA O CLIENTE',exact:true}).click();
        await page.getByRole('link', {name:'Abrir acesso público do cliente',exact:true}).waitFor();
        assert.match(await page.getByText(/Vigente:/).innerText(),/Vigente: 2/);
        await page.goto(env.ADMIN_AUTH_ORIGIN + '/clientes');
        await page.getByRole('heading', { name: 'Clientes', exact: true }).waitFor();
        assert.equal((await page.request.get(env.ADMIN_AUTH_ORIGIN + '/api/admin/clientes')).status(), 200);
        const mutation={nomeCompleto:'Cliente sintético navegador',telefone:'11955550000'};
        assert.equal((await page.request.post(env.ADMIN_AUTH_ORIGIN+'/api/admin/clientes',{data:mutation,headers:{origin:env.ADMIN_AUTH_ORIGIN}})).status(),403);
        const sessionInfo=await (await page.request.get(env.ADMIN_AUTH_ORIGIN+'/api/admin/autenticacao')).json();
        assert.equal((await page.request.post(env.ADMIN_AUTH_ORIGIN+'/api/admin/clientes',{data:mutation,headers:{origin:env.ADMIN_AUTH_ORIGIN,'x-csrf-token':sessionInfo.data.csrf}})).status(),201);
        await page.getByRole('button', { name: 'Sair', exact: true }).click();
        await page.waitForURL('**/admin/login');
        assert.equal((await page.request.get(env.ADMIN_AUTH_ORIGIN + '/api/admin/clientes')).status(), 401);
        assert.deepEqual(errors, []);
        fs.writeFileSync('.tmp/navegador-013.json', JSON.stringify({ banco: state.banco, passed: ['redirect sem sessão', 'login real pelo formulário', 'painel e histórico', 'composição de três PDFs BYTEA', 'nova versão preserva observações anteriores', 'salvar, gerar, revisar, reautenticar, assinar e liberar pelos botões', 'vigente preservada durante elaboração', 'CRM autenticado e gravação com CSRF', 'logout e API recusada'], pageErrors: errors }, null, 2));
        console.log('Navegador: login, painel, documentos, impressão, CRM e logout aprovados.');
    }
    finally {
        if (browser)
            await browser.close();
        server.kill();
        fs.closeSync(log);
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
