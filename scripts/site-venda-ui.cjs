/* eslint-disable @typescript-eslint/no-require-imports */
/* QA local: usa Playwright do runtime, dois processos sem DATABASE_URL e sem chamadas de escrita. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs/evidencias/site-venda-20261008');
fs.mkdirSync(out, { recursive: true });
const reference = process.env.SITE_REFERENCE_HTML;
const servers = [];
const results = { screenshots: [], overflow: [], errors: [], reducedMotion: null, performance: [], scroll: null, checks: [] };
results.accessibility = [];
let browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function server(port, open) {
    const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', SITE_PRECOS_PUBLICADOS: String(open), SITE_URL: `http://127.0.0.1:${port}`, ADMIN_AUTH_ORIGIN: `http://127.0.0.1:${port}`, CADASTRO_PUBLICO_ATIVO: String(open), USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'resend', EMAIL_REMETENTE: 'fixture@example.test', RESEND_API_KEY: 'fixture-nao-envia-email', SITE_ATENDIMENTO_WHATSAPP: open ? '5511900000000' : '', ASSINATURA_TESTE_DIAS: '15' };
    for (const key of Object.keys(env)) if (/^(DATABASE_|PG|SITE_RAZAO|SITE_CNPJ|SITE_ENDERECO|SITE_ATENDIMENTO_EMAIL|SITE_ATENDIMENTO_HORARIO|SITE_ENCARREGADO)/.test(key)) delete env[key];
    const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let output = '';
    child.stdout.on('data', d => { output += d.toString(); }); child.stderr.on('data', d => { output += d.toString(); });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`Servidor local encerrou: ${output}`);
        try { const response = await fetch(url + '/conheca'); if (response.ok) return url; } catch { /* inicializando */ }
        await sleep(250);
    }
    throw new Error(`Servidor não iniciou: ${output}`);
}
async function capture(page, name, locator) {
    const file = `${name}.png`;
    if (locator) await locator.scrollIntoViewIfNeeded();
    else await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await sleep(150);
    // Nas capturas de seções altas, overlays fixos atravessariam o recorte fora da viewport.
    // O topo mantém ambos visíveis; isto só altera a imagem, nunca a aplicação.
    if (locator) await locator.screenshot({ path: path.join(out, file), animations: 'allow', style: '[data-site-venda] > header, [data-site-venda] > a[href^="https://wa.me/"], .header, .wa-float { visibility: hidden !important; }' });
    else await page.screenshot({ path: path.join(out, file), animations: 'allow' });
    results.screenshots.push(file);
}
async function observe(context) {
    await context.addInitScript(() => {
        window.__siteMetrics = { lcp: 0, cls: 0, longTasks: [] };
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__siteMetrics.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__siteMetrics.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__siteMetrics.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
    });
}
async function accessibility(page, scenario) {
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const audit = await page.evaluate(async () => {
        const result = await window.axe.run('[data-site-venda]', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
        const compact = entries => entries.map(e => ({ id: e.id, nodes: e.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }));
        return { violations: compact(result.violations), incomplete: compact(result.incomplete) };
    });
    results.accessibility.push({ scenario, ...audit });
    assert.deepEqual(audit.violations, [], `Acessibilidade: ${scenario}`);
}
(async () => {
    try {
        const live = await server(3188, true), closed = await server(3189, false);
        browser = await chromium.launch({ headless: true, ...(process.env.SITE_BROWSER_EXECUTABLE ? { executablePath: process.env.SITE_BROWSER_EXECUTABLE } : {}) });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'file:') return route.continue();
            return route.abort(); // Nenhum provedor real é acessado pelo QA.
        });
        const page = await context.newPage();
        page.on('pageerror', e => results.errors.push(e.message));
        page.on('console', msg => { if (msg.type() === 'error') results.errors.push(msg.text()); });
        await page.goto(live + '/conheca'); await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.title(), 'Kidmais Manager — gestão para buffet infantil');
        assert.equal(await page.locator('html').getAttribute('lang'), 'pt-BR');
        assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), live + '/conheca');
        assert.equal(await page.locator('script[type="application/ld+json"]').count(), 0);
        assert.equal(await page.locator('[data-site-venda] form').count(), 0);
        assert.equal(await page.locator('a[href^="https://wa.me/"]').count(), 4);
        const missing = await page.locator('[data-status="em_breve"]').evaluateAll(nodes => nodes.filter(n => !n.textContent.includes('Em breve')).length);
        assert.equal(missing, 0);
        results.checks.push('metadata, canonical, lang, ausência de formulário e JSON-LD, status e WhatsApp');
        for (const width of [360,390,560,768,1000,1280,1440]) {
            await page.setViewportSize({ width, height: 900 });
            const measure = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, bg:getComputedStyle(document.querySelector('[data-site-venda]')).backgroundColor }));
            results.overflow.push(measure); assert.ok(measure.scroll <= width, `Overflow em ${width}: ${measure.scroll}`);
            assert.equal(measure.bg, 'rgb(3, 7, 18)');
        }
        for (const width of [1280,390]) {
            await page.setViewportSize({ width, height: 900 });
            await capture(page, `${width}-topo`);
            await capture(page, `${width}-diferenciais`, page.locator('#diferenciais'));
            const labels=['Orçamento online','Agenda','Contratos','Financeiro','Importação por IA','Copiloto'];
            for (let i=0;i<labels.length;i++) {
                await page.getByRole('tab',{name:labels[i],exact:true}).click();
                assert.equal(await page.getByRole('tabpanel').count(),1);
                const semLegenda = await page.locator('[data-site-venda] [role="img"]').evaluateAll(nodes => nodes.filter(n => !/dados fictícios/i.test(n.textContent)).length);
                assert.equal(semLegenda, 0, 'Todas as ilustrações precisam de legenda de dados fictícios');
                await capture(page,`${width}-aba-${i+1}`,page.locator('#recursos'));
                if (width === 1280) await accessibility(page, `1280-aba-${i+1}`);
                const measure=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth); assert.equal(measure,true);
            }
            await capture(page,`${width}-wall-e`,page.locator('#wall-e'));
            await capture(page,`${width}-convite`,page.locator('#convite'));
            await page.getByRole('button',{name:'Mensal',exact:true}).click();
            await capture(page,`${width}-planos-mensal`,page.locator('#planos'));
            await page.getByRole('button',{name:/Anual/}).click();
            assert.match(await page.locator('#planos').innerText(),/1\.970/);
            await capture(page,`${width}-planos-anual`,page.locator('#planos'));
            if (width === 390) await accessibility(page, '390-anual');
            await capture(page,`${width}-duvidas`,page.locator('#duvidas'));
            await capture(page,`${width}-rodape`,page.locator('[data-site-venda] > footer'));
        }
        await page.getByRole('tab',{name:'Orçamento online',exact:true}).focus();
        await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('tab',{name:'Copiloto',exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('Home'); assert.equal(await page.getByRole('tab',{name:'Orçamento online',exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab',{name:'Agenda',exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('End'); assert.equal(await page.getByRole('tab',{name:'Copiloto',exact:true}).getAttribute('aria-selected'),'true');
        results.checks.push('abas por setas, Home/End, foco e aria-selected');
        await page.emulateMedia({reducedMotion:'reduce'});
        results.reducedMotion=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-site-venda], [data-site-venda] *')).flatMap(el=>[null,'::before','::after'].map(p=>{const c=getComputedStyle(el,p);return c.animationName!=='none'?{tag:el.tagName,animation:c.animationName,p}:null;})).filter(Boolean));
        assert.deepEqual(results.reducedMotion,[]); results.checks.push('reduced-motion desliga animações e pseudoelementos');
        const rootResponse=await fetch(live+'/',{redirect:'manual'}); assert.equal(rootResponse.status,307); assert.equal(rootResponse.headers.get('location'),'/disponibilidade');
        results.checks.push('/ preserva redirect 307 para /disponibilidade');
        await page.goto(closed+'/planos');
        assert.equal(await page.locator('a[href="/cadastro"]').count(),0);
        assert.match(await page.locator('main').innerText(),/O cadastro on-line abre em breve/);
        assert.doesNotMatch(await page.locator('#planos').innerText(),/R\$/);
        assert.equal(await page.locator('a[href^="https://wa.me/"]').count(),0);
        await capture(page,'390-planos-fechados-sem-precos');
        await page.goto(live+'/planos'); assert.equal(await page.locator('main a[href="/cadastro"]').count(),3);
        results.checks.push('/planos cadastro aberto/fechado; preços e WhatsApp condicionais');
        await page.goto(closed+'/cadastro'); await page.getByText('O cadastro de novas empresas ainda não está aberto. Fale com a Kidmais para começar.').waitFor();
        await page.goto(live+'/cadastro'); await page.getByLabel('Seu nome',{exact:true}).waitFor();
        results.checks.push('/cadastro mantém formulário aberto e mensagem de cadastro fechado; nenhum POST realizado');
        await page.goto(live+'/termos#cancelamento'); assert.equal(await page.locator('#cancelamento').count(),1);
        await page.goto(live+'/privacidade#tratamento-de-dados'); assert.equal(await page.locator('#tratamento-de-dados').count(),1);
        const adminResponse=await fetch(live+'/admin/login',{redirect:'manual'}); assert.match(adminResponse.headers.get('x-robots-tag')||'',/noindex/);
        results.checks.push('âncoras legais existem, admin continua noindex');
        if(reference){
            const refContext=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
            const refPage=await refContext.newPage();await refPage.goto(pathToFileURL(reference).href);await refPage.evaluate(()=>document.fonts.ready);
            await capture(refPage,'referencia-1280-topo');
            await capture(refPage,'referencia-1280-planos',refPage.locator('#planos'));
            await refPage.setViewportSize({width:390,height:900});await capture(refPage,'referencia-390-topo');
            await refContext.close();
        }
        await context.close();
        for(let run=1;run<=3;run++){
            const perfContext=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});await observe(perfContext);
            const perfPage=await perfContext.newPage();const cdp=await perfContext.newCDPSession(perfPage);
            await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
            await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:1600000/8,uploadThroughput:750000/8,connectionType:'cellular4g'});
            await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
            await perfPage.goto(live+'/conheca',{waitUntil:'load'});await sleep(6000);
            const metrics=await perfPage.evaluate(()=>window.__siteMetrics);results.performance.push({run,...metrics});
            if(run===1){results.scroll=await perfPage.evaluate(()=>new Promise(resolve=>{const intervals=[];let last=performance.now(),start=last;function step(now){intervals.push(now-last);last=now;window.scrollBy(0,30);if(now-start<4000)requestAnimationFrame(step);else resolve({frames:intervals.length,averageMs:intervals.reduce((s,n)=>s+n,0)/intervals.length,p95Ms:intervals.sort((a,b)=>a-b)[Math.floor(intervals.length*.95)],over50ms:intervals.filter(n=>n>50).length});}requestAnimationFrame(step);}));}
            await perfContext.close();console.log('Medição móvel',run,metrics.lcp,metrics.cls);
        }
        assert.deepEqual(results.errors,[]);
        results.checks.push('zero erro de console/página nas rotas verificadas');
        results.completed=true;
    } finally {
        fs.writeFileSync(path.join(out,'resultados.json'),JSON.stringify(results,null,2));
        if(browser)await browser.close(); for(const server of servers)server.kill();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
