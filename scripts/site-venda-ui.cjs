/* eslint-disable @typescript-eslint/no-require-imports */
/* QA local: usa Playwright do runtime, três processos sem DATABASE_URL e sem chamadas de escrita. */
/* Atualizado em 24/11/2026 para o site atual: sem selo "Em breve", sem ciclo anual (D-LAN-5), sem horário nobre, */
/* abas em #modulos lidas do DOM e cenário de vitrine como production (cadastro fechado + "Agendar demonstração"). */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
// SITE_EVIDENCIAS_DIR evita sobrescrever as evidências versionadas de 08/10 ao repetir o QA.
const out = process.env.SITE_EVIDENCIAS_DIR ? path.resolve(process.env.SITE_EVIDENCIAS_DIR) : path.join(root, 'docs/evidencias/site-venda-20261008');
fs.mkdirSync(out, { recursive: true });
const reference = process.env.SITE_REFERENCE_HTML;
const servers = [];
const results = { screenshots: [], overflow: [], errors: [], reducedMotion: null, performance: [], scroll: null, checks: [] };
results.accessibility = [];
let browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WHATSAPP = '5511900000000';
const CADASTRO_FECHADO = 'Fale com a equipe iA.Fest para agendar uma demonstração.';
/** cadastro: CADASTRO_PUBLICO_ATIVO; precos: SITE_PRECOS_PUBLICADOS; whatsapp: SITE_ATENDIMENTO_WHATSAPP comercial. */
async function server(port, { cadastro, precos, whatsapp }) {
    const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', SITE_PRECOS_PUBLICADOS: String(precos), SITE_URL: `http://127.0.0.1:${port}`, ADMIN_AUTH_ORIGIN: `http://127.0.0.1:${port}`, CADASTRO_PUBLICO_ATIVO: String(cadastro), USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'resend', EMAIL_REMETENTE: 'fixture@example.test', RESEND_API_KEY: 'fixture-nao-envia-email', SITE_ATENDIMENTO_WHATSAPP: whatsapp ? WHATSAPP : '', ASSINATURA_TESTE_DIAS: '15' };
    for (const key of Object.keys(env)) if (/^(DATABASE_|PG|SITE_RAZAO|SITE_CNPJ|SITE_ENDERECO|SITE_ATENDIMENTO_EMAIL|SITE_ATENDIMENTO_HORARIO|SITE_ENCARREGADO)/.test(key)) delete env[key];
    const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let output = '';
    child.stdout.on('data', d => { output += d.toString(); }); child.stderr.on('data', d => { output += d.toString(); });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 240; i++) {
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
/** Todo link wa.me aponta para o WhatsApp comercial configurado e abre em nova aba. */
async function whatsappCoerente(page) {
    const links = await page.locator('a[href^="https://wa.me/"]').evaluateAll(nodes => nodes.map(n => ({ href: n.getAttribute('href'), target: n.getAttribute('target'), rel: n.getAttribute('rel') || '' })));
    for (const l of links) {
        assert.ok(l.href.startsWith(`https://wa.me/${WHATSAPP}`), `WhatsApp fora do canal comercial: ${l.href}`);
        assert.equal(l.target, '_blank'); assert.match(l.rel, /noopener/);
    }
    return links.length;
}
/** Sem selo "Em breve", sem ciclo anual e sem horário nobre no texto visível do site. */
async function semTextosAntigos(page, cenario) {
    const texto = await page.locator('[data-site-venda]').innerText();
    assert.equal(await page.locator('[data-status="em_breve"]').count(), 0, `selo em_breve: ${cenario}`);
    assert.doesNotMatch(texto, /em breve/i, `"em breve": ${cenario}`);
    assert.doesNotMatch(texto, /hor[aá]rio nobre/i, `horário nobre: ${cenario}`);
    assert.doesNotMatch(texto, /\/ano\b|2 meses grátis|Total por ano|Ciclo de cobrança/i, `ciclo anual: ${cenario}`);
}
(async () => {
    try {
        const [live, closed, vitrine] = await Promise.all([
            server(3188, { cadastro: true, precos: true, whatsapp: true }),
            server(3189, { cadastro: false, precos: false, whatsapp: false }),
            server(3190, { cadastro: false, precos: true, whatsapp: true }), // como production em 24/11/2026
        ]);
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
        assert.equal(await page.title(), 'iA.Fest — gestão para buffet infantil');
        assert.equal(await page.locator('html').getAttribute('lang'), 'pt-BR');
        assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), live + '/conheca');
        assert.equal(await page.locator('script[type="application/ld+json"]').count(), 0);
        // Único formulário: a simulação "monte uma festa", sem action e sem envio (onSubmit só previne).
        const formularios = await page.locator('[data-site-venda] form').evaluateAll(nodes => nodes.map(n => [n.getAttribute('aria-label') || '', n.getAttribute('action'), n.getAttribute('method')]));
        for (const [rotulo, action, method] of formularios) { assert.match(rotulo, /^Simulação/); assert.equal(action, null); assert.equal(method, null); }
        results.whatsappConheca = await whatsappCoerente(page);
        assert.ok(results.whatsappConheca > 0, 'WhatsApp configurado precisa aparecer em /conheca');
        await semTextosAntigos(page, 'conheca aberto');
        results.checks.push('metadata, canonical, lang, só o formulário de simulação, sem JSON-LD, sem "Em breve"/anual/horário nobre, WhatsApp comercial');
        for (const width of [360,390,560,768,1000,1280,1440]) {
            await page.setViewportSize({ width, height: 900 });
            const measure = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, bg:getComputedStyle(document.querySelector('[data-site-venda]')).backgroundColor }));
            results.overflow.push(measure); assert.ok(measure.scroll <= width, `Overflow em ${width}: ${measure.scroll}`);
            assert.equal(measure.bg, 'rgb(3, 7, 18)');
        }
        const abas = page.locator('#modulos [role="tab"]');
        const labels = (await abas.allInnerTexts()).map(t => t.trim());
        assert.ok(labels.length >= 2, 'Módulos precisam de ao menos duas abas');
        results.abas = labels;
        for (const width of [1280,390]) {
            await page.setViewportSize({ width, height: 900 });
            await capture(page, `${width}-topo`);
            await capture(page, `${width}-antes-depois`, page.locator('#antes-depois'));
            await capture(page, `${width}-recursos`, page.locator('#recursos'));
            for (let i=0;i<labels.length;i++) {
                await page.getByRole('tab',{name:labels[i],exact:true}).click();
                assert.equal(await page.locator('#modulos').getByRole('tabpanel').count(),1);
                const semLegenda = await page.locator('[data-site-venda] [role="img"]:not([aria-label^="Código:"])').evaluateAll(nodes => nodes.filter(n => !/dados fictícios/i.test(n.textContent + ' ' + (n.getAttribute('aria-label') || ''))).length);
                // O indicador de dígitos da assinatura por código (aria-label "Código: …") não é tela com dados.
                assert.equal(semLegenda, 0, 'Todas as ilustrações precisam de legenda de dados fictícios');
                await capture(page,`${width}-aba-${i+1}`,page.locator('#modulos'));
                if (width === 1280) await accessibility(page, `1280-aba-${i+1}`);
                const measure=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth); assert.equal(measure,true);
            }
            if (await page.locator('#wall-e').count()) await capture(page,`${width}-wall-e`,page.locator('#wall-e'));
            await capture(page,`${width}-como-funciona`,page.locator('#como-funciona'));
            await capture(page,`${width}-confianca`,page.locator('#confianca'));
            // D-LAN-5: só o ciclo mensal é vendido; sem alternador Mensal/Anual.
            const planos = page.locator('#planos');
            assert.equal(await planos.getByRole('button',{name:/Mensal|Anual/}).count(),0);
            assert.equal(await planos.locator('[data-valor-ciclo="mensal"]').count(),3);
            assert.equal(await planos.locator('[data-valor-ciclo="anual"]').count(),0);
            assert.match(await planos.innerText(),/R\$/);
            await capture(page,`${width}-planos`,planos);
            if (width === 390) await accessibility(page, '390-planos');
            await capture(page,`${width}-duvidas`,page.locator('#duvidas'));
            await capture(page,`${width}-rodape`,page.locator('[data-site-venda] > footer'));
        }
        results.checks.push('planos só mensais (3 cards), sem alternador anual');
        const ultima = labels[labels.length - 1];
        await page.getByRole('tab',{name:labels[0],exact:true}).focus();
        await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('tab',{name:ultima,exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('Home'); assert.equal(await page.getByRole('tab',{name:labels[0],exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab',{name:labels[1],exact:true}).getAttribute('aria-selected'),'true');
        await page.keyboard.press('End'); assert.equal(await page.getByRole('tab',{name:ultima,exact:true}).getAttribute('aria-selected'),'true');
        results.checks.push('abas dos módulos por setas, Home/End, foco e aria-selected');
        // animationName vazio (ex.: <track> de vídeo, sem estilo computado) não é animação.
        await page.emulateMedia({reducedMotion:'reduce'});
        results.reducedMotion=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-site-venda], [data-site-venda] *')).flatMap(el=>[null,'::before','::after'].map(p=>{const c=getComputedStyle(el,p);return c.animationName&&c.animationName!=='none'?{tag:el.tagName,animation:c.animationName,p}:null;})).filter(Boolean));
        assert.deepEqual(results.reducedMotion,[]); results.checks.push('reduced-motion desliga animações e pseudoelementos');
        await page.emulateMedia({reducedMotion:'no-preference'});
        const rootResponse=await fetch(live+'/',{redirect:'manual'}); assert.equal(rootResponse.status,307); assert.equal(rootResponse.headers.get('location'),'/disponibilidade');
        results.checks.push('/ preserva redirect 307 para /disponibilidade');
        // Cadastro fechado, sem preços e sem canal: só o aviso, sem link.
        await page.goto(closed+'/planos');
        assert.equal(await page.locator('a[href="/cadastro"]').count(),0);
        assert.equal(await page.locator('[data-agendar-demonstracao]').count(),0);
        assert.match(await page.locator('main').innerText(),new RegExp(CADASTRO_FECHADO.replace(/\./g,'\\.')));
        assert.doesNotMatch(await page.locator('#planos').innerText(),/R\$/);
        assert.equal(await page.locator('a[href^="https://wa.me/"]').count(),0);
        await semTextosAntigos(page, 'planos fechado sem canal');
        await capture(page,'planos-fechados-sem-precos');
        // Cadastro fechado com WhatsApp comercial (como production): "Agendar demonstração" em cada plano, nunca /cadastro.
        await page.goto(vitrine+'/planos');
        assert.equal(await page.locator('a[href="/cadastro"]').count(),0);
        assert.equal(await page.locator('#planos [data-agendar-demonstracao]').count(),3);
        const agendar = await page.locator('[data-agendar-demonstracao]').evaluateAll(nodes => nodes.map(n => [n.textContent.trim(), n.getAttribute('href')]));
        for (const [texto, href] of agendar) { assert.equal(texto,'Agendar demonstração'); assert.ok(href.startsWith(`https://wa.me/${WHATSAPP}`), href); }
        assert.match(await page.locator('#planos').innerText(),/R\$/);
        await whatsappCoerente(page);
        await semTextosAntigos(page, 'planos vitrine');
        await capture(page,'planos-vitrine-agendar-demonstracao');
        await page.goto(vitrine+'/conheca');
        assert.equal(await page.locator('main a[href="/cadastro"]').count(),0);
        assert.ok(await page.locator('main [data-agendar-demonstracao]').count() > 0);
        await whatsappCoerente(page);
        await semTextosAntigos(page, 'conheca vitrine');
        await page.goto(live+'/planos'); assert.equal(await page.locator('main a[href="/cadastro"]').count(),3);
        results.checks.push('/planos aberto (/cadastro), fechado sem canal (aviso) e vitrine (Agendar demonstração pelo WhatsApp); preços condicionais');
        await page.goto(closed+'/cadastro'); await page.getByText('O cadastro de novas empresas ainda não está aberto. Fale com a equipe iA.Fest para começar.').waitFor();
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
