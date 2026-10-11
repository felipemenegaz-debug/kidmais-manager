/* eslint-disable @typescript-eslint/no-require-imports */
// Vitrine final no build de produção local. Sem banco, escrita ou integração externa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:3491';
const out = path.join(root, '.local-lancamento-codex-ui');
async function main() {
    for (const f of ['.env', '.env.local', '.env.production', '.env.production.local']) assert.ok(!fs.existsSync(path.join(root, f)), 'ENV_RECUSADO');
    const env = {};
    for (const k of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {NODE_ENV:'production', NEXT_TELEMETRY_DISABLED:'1', KIDMAIS_DEPLOY_ENV:'local', SITE_URL:base, ADMIN_AUTH_ORIGIN:base,
        SITE_PRECOS_PUBLICADOS:'true', CADASTRO_PUBLICO_ATIVO:'true', USUARIOS_CRIACAO_DIRETA:'desativada',
        EMAIL_PROVIDER:'resend', RESEND_API_KEY:'fixture-sem-chave-real', EMAIL_REMETENTE:'teste@example.invalid'});
    fs.mkdirSync(out, {recursive:true});
    const log = fs.openSync(path.join(out, 'servidor.log'), 'a');
    const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '3491'], {cwd:root, env, windowsHide:true, stdio:['ignore',log,log]});
    let browser;
    const checks = [];
    try {
        let ready = false;
        for (let i=0;i<100;i++) {
            if (server.exitCode !== null) throw Error('SERVIDOR_ENCERROU');
            try { ready = (await fetch(base+'/conheca')).ok; } catch { /* aguarda */ }
            if (ready) break;
            await new Promise(r=>setTimeout(r,200));
        }
        assert.ok(ready, 'SERVIDOR_NAO_INICIOU');
        browser = await chromium.launch({headless:true, channel:'chrome'});
        const context = await browser.newContext();
        await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
        const page = await context.newPage();
        for (const width of [1280,375]) {
            await page.setViewportSize({width,height:812});
            for (const route of ['/conheca','/planos','/cadastro']) {
                await page.goto(base+route);
                await page.locator('h1').first().waitFor();
                assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'ROLAGEM_HORIZONTAL:'+route);
                const text = await page.locator('main').innerText();
                if (route === '/conheca') {
                    assert.match(text, /Em breve/);
                    for (const price of ['197','347','597']) assert.ok(text.includes(price), 'PRECO:'+price);
                    assert.doesNotMatch(text, /se fosse comprar separado/i);
                }
                await page.screenshot({path:path.join(out, `${width}-${route.slice(1)}.png`), fullPage:true});
                checks.push({width,route,resultado:'PASS'});
            }
        }
        fs.writeFileSync(path.join(out,'resultado.json'),JSON.stringify({resultado:'PASS',checks,envio:false,banco:false},null,2));
        console.log(JSON.stringify({resultado:'PASS',checks:checks.length,envio:false,banco:false}));
    } finally {
        if (browser) await browser.close();
        if (server.exitCode === null) {
            if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
            else server.kill('SIGTERM');
        }
        fs.closeSync(log);
    }
}
main().catch(e=>{console.error(e.message); process.exitCode=1;});
