/* eslint-disable @typescript-eslint/no-require-imports */
// Logo do buffet sobre a arte (etapa 3): somente servidor local e APIs simuladas; nenhuma geração real é enviada.
// Cobre: convite completo antigo abre sem gravar nada; "Colocar a logo sobre a arte" (logo_sessao → logo_buffet);
// arraste com o mouse e Esc; setas e Shift; os 9 lugares; tamanho e fundo; duas mudanças rápidas com resposta presa
// (nunca dois comandos em voo, a última posição vence); erro → "Tentar de novo"; sessão expirada → renova uma vez;
// "Voltar para a faixa"; página pública com a logo sobre a arte, uma releitura em 409 e, na segunda divergência,
// a logo de volta ao rodapé; editor da família sem controles da logo.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/logo-sobre'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;
const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
const ARTE = id(50), ARTE_B = id(51), TOKEN = 'p'.repeat(43);
const esperar = ms => new Promise(r => setTimeout(r, ms));
async function ate(cond, msg, ms = 8000) { const fim = Date.now() + ms; while (Date.now() < fim) { if (await cond()) return; await esperar(50); } throw new Error(`tempo esgotado: ${msg}`); }

(async () => {
  // Arte: faixa de cima lisa (lugar livre), resto com textura. Logo: retângulo opaco com borda transparente.
  const W = 1024, H = 1536, cru = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, liso = y < 300;
    cru[i] = liso ? 60 : (x * 7 + y * 3) % 255; cru[i + 1] = liso ? 47 : (x * 3 + y * 11) % 255; cru[i + 2] = liso ? 107 : (x ^ y) % 255;
  }
  const arte = await sharp(cru, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 90 }).toBuffer();
  const logo = await sharp({ create: { width: 240, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 200, height: 90, channels: 4, background: { r: 230, g: 40, b: 60, alpha: 1 } } }).png().toBuffer(), left: 20, top: 15 }]).png().toBuffer();
  const logoUrl = dataUrl(logo, 'image/png');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];

  async function abrirEditor({ admin = true, posicoes = {}, mostrar = true, viewport = { width: 1440, height: 1100 }, hasTouch = false, arteAtrasada = false, falharGets = [], esperarEditor = true, segurarGets = false } = {}) {
    const dados = {
      id: id(1), festaId: id(5),
      conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília',
        arteId: ARTE, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 }, confirmarPresenca: true, logoPosicoes: posicoes },
      ...(admin ? { logoBuffet: { mostrar, logoDataUrl: logoUrl }, publicadoArteId: ARTE } : {}),
      revisao: 3, publicado: true, desatualizado: false, linkPublico: `/convite/${TOKEN}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
      disponiveis: 3, iaDisponivel: true, completoDisponivel: true, geracaoIncerta: false, geracaoEmAndamento: null,
      cotas: admin ? { festa: 3, festaUsado: 1, cliente: 2, clienteUsado: 0, empresa: 60, empresaUsado: 1 } : { festa: 3, festaUsado: 1, cliente: 2, clienteUsado: 0 },
      artes: [{ id: ARTE, origem: 'IA', completo: true, url: arteAtrasada ? `${base}/__arte-atrasada.webp` : dataUrl(arte, 'image/webp') }], respostas: [], historico: [],
    };
    // Servidor simulado: sessões por id, seq por sessão, comandos em voo, falhas e retenção sob demanda.
    const estado = { posts: [], logo: [], sessoes: new Map(), emVoo: 0, maxEmVoo: 0, erros: [], segurar: false, presos: [], falharProximo: null, expirarProximo: false, outras: new Set(),
      // r3/r4: GETs contados; leitura segurada (devolve o JSON do momento do pedido) e falhas de leitura em fila.
      gets: 0, segurarGet: segurarGets, getsPresos: [], falharGets: [...falharGets], liberarArte: null };
    const context = await browser.newContext({ viewport, hasTouch, acceptDownloads: true });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
      if (url.pathname === '/__arte-atrasada.webp') { await new Promise(r => { estado.liberarArte = r; }); return route.fulfill({ status: 200, contentType: 'image/webp', body: arte }); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (data, status = 200, extra = {}) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 300 ? { ok: true, data } : { ok: false, erro: data, ...extra }) });
      if (url.pathname === '/api/admin/autenticacao') return json({ usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null });
      if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return json({ logoDataUrl: logoUrl });
      if (!['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) { estado.outras.add(url.pathname); return json(null); }
      if (request.method() === 'GET') {
        estado.gets++;
        const foto = JSON.parse(JSON.stringify(dados));
        // r4: um GET segurado pode ter sido abortado pela página; responder a ele então falha e é ignorado.
        const segurado = estado.segurarGet;
        if (segurado) await new Promise(r => estado.getsPresos.push(r));
        const responder = p => p.catch(e => { if (!segurado) throw e; });
        const falha = estado.falharGets.shift();
        if (falha === 'sem-logo') { delete foto.logoBuffet; return responder(json(foto)); }
        if (falha) return responder(json('Falha simulada da leitura.', falha));
        return responder(json(foto));
      }
      const b = request.postDataJSON(); estado.posts.push(b);
      // r2 (Astra r1, P1): todo comando da logo vai para a URL com o UUID deste convite na query, desde a primeira abertura.
      if (['logo_sessao', 'logo_buffet'].includes(b.acao) && url.searchParams.get('conviteId') !== dados.id) estado.erros.push(`comando ${b.acao} sem o conviteId na query: ${url.search}`);
      if (b.acao === 'salvar') { dados.revisao++; return json({ salvo: true }); }
      if (b.acao === 'logo_sessao') {
        assert.ok(admin, 'família nunca abre sessão da logo');
        const s = id(900 + estado.sessoes.size); estado.sessoes.set(s, 0); estado.logo.push(b);
        return json({ logoSessao: s });
      }
      if (b.acao !== 'logo_buffet') { estado.erros.push(`ação inesperada: ${b.acao}`); return json('Ação inesperada.', 400); }
      assert.ok(admin, 'família nunca grava a logo');
      estado.logo.push(b); estado.emVoo++; estado.maxEmVoo = Math.max(estado.maxEmVoo, estado.emVoo);
      try {
        if (estado.segurar) await new Promise(r => estado.presos.push(r));
        if (estado.expirarProximo) { estado.expirarProximo = false; estado.sessoes.delete(b.sessao); return json('A sessão da logo expirou.', 409, { codigo: 'sessao_expirada' }); }
        if (estado.falharProximo) { const st = estado.falharProximo; estado.falharProximo = null; return json('Não foi possível salvar a logo.', st); }
        if (!estado.sessoes.has(b.sessao)) return json('A sessão da logo expirou.', 409, { codigo: 'sessao_expirada' });
        assert.ok(b.seq > estado.sessoes.get(b.sessao), `seq cresce por sessão (${b.seq})`); estado.sessoes.set(b.sessao, b.seq);
        if (typeof b.mostrar === 'boolean') dados.logoBuffet.mostrar = b.mostrar;
        for (const p of b.posicoes ?? []) dados.conteudo.logoPosicoes[p.arteId] = { ...p };
        // Mesmo formato do servidor (service.ts): o que foi aplicado por campo e as artes ausentes.
        const aplicado = {};
        if (typeof b.mostrar === 'boolean') aplicado.mostrar = true;
        if (b.posicoes?.length) aplicado.posicoes = Object.fromEntries(b.posicoes.map(p => [p.arteId, true]));
        return json({ aplicado, artesAusentes: [] });
      } finally { estado.emVoo--; }
    });
    const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
    await page.goto(admin ? `${base}/admin/festas/${id(5)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
    if (esperarEditor) await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    return { page, context, estado, dados };
  }
  const ultimaPosicao = estado => [...estado.logo].reverse().find(b => b.acao === 'logo_buffet' && b.posicoes?.length)?.posicoes.at(-1);
  const salvo = page => page.locator('[data-situacao-logo="salvo"]').waitFor({ timeout: 8000 });
  // r2 (Astra r1, P3): o lugar escolhido grava o centro que aparece na tela (sem zona morta perto da borda).
  // Confere o canto aproximado e que a posição gravada é o centro exibido do controle (±0,6%).
  async function noLugar(page, pos, [ex, ey], msg) {
    const perto = (v, e) => (e === 0 ? v < 20 : e === 100 ? v > 80 : Math.abs(v - e) < 0.6);
    assert.ok(perto(pos.x, ex) && perto(pos.y, ey), `${msg}: (${pos.x},${pos.y}) perto de (${ex},${ey})`);
    await ate(async () => {
      const c = await page.evaluate(() => { const b = document.querySelector('[aria-label="Logo do buffet sobre a arte"]'); if (!b) return null; const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); return { x: ((r.left + r.width / 2 - p.left) / p.width) * 100, y: ((r.top + r.height / 2 - p.top) / p.height) * 100 }; });
      return c && Math.abs(c.x - pos.x) < 0.6 && Math.abs(c.y - pos.y) < 0.6;
    }, `${msg}: centro exibido = posição gravada (${pos.x},${pos.y})`, 3000);
  }

  try {
    // 1. Convite completo antigo (sem entrada de posição): abrir não grava nada; logo no rodapé e oferta de colocar sobre a arte.
    {
      const { page, context, estado, dados } = await abrirEditor();
      await page.getByRole('checkbox', { name: 'Mostrar a logo do buffet neste convite' }).waitFor();
      await esperar(1500);
      assert.equal(estado.logo.length, 0, 'abrir o convite antigo não chama logo_sessao/logo_buffet');
      assert.equal(await page.getByRole('button', { name: 'Logo do buffet sobre a arte' }).count(), 0);
      await page.getByRole('button', { name: 'Colocar a logo sobre a arte' }).waitFor();
      await page.locator('[data-logo-buffet]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '01-antigo-faixa-oferta.png') });

      // 2. Colocar sobre a arte: sessão nasce no servidor, depois um logo_buffet com modo "sobre".
      await page.getByRole('button', { name: 'Colocar a logo sobre a arte' }).click();
      await salvo(page);
      assert.deepEqual(estado.logo.map(b => b.acao), ['logo_sessao', 'logo_buffet']);
      const sugerida = ultimaPosicao(estado);
      assert.equal(sugerida.modo, 'sobre'); assert.equal(sugerida.arteId, ARTE);
      assert.ok(sugerida.y < 30, `sugestão cai na faixa lisa de cima (y=${sugerida.y})`);
      const controle = page.getByRole('button', { name: 'Logo do buffet sobre a arte' });
      await controle.waitFor();
      await page.locator('[data-camada-logo="pronta"]').first().waitFor();
      await page.screenshot({ path: path.join(out, '02-logo-sobre-sugerida.png') });

      // 3. Arraste com o mouse: um único comando ao soltar, com a posição nova.
      const n0 = estado.logo.length;
      await controle.scrollIntoViewIfNeeded(); let caixa = await controle.boundingBox();
      await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2); await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(caixa.x + caixa.width / 2 + i * 12, caixa.y + caixa.height / 2 + i * 30);
      assert.equal(estado.logo.length, n0, 'nada é enviado durante o arraste');
      await page.screenshot({ path: path.join(out, '03-arrastando.png') });
      await page.mouse.up(); await salvo(page);
      assert.equal(estado.logo.length, n0 + 1, 'um comando ao soltar');
      const arrastada = ultimaPosicao(estado);
      assert.ok(arrastada.x > sugerida.x && arrastada.y > sugerida.y, `posição andou (${sugerida.x},${sugerida.y}) → (${arrastada.x},${arrastada.y})`);

      // 4. Esc cancela o arraste: nada enviado, a logo volta para onde estava.
      caixa = await controle.boundingBox();
      await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2); await page.mouse.down();
      await page.mouse.move(caixa.x + caixa.width / 2 + 150, caixa.y + caixa.height / 2 + 150, { steps: 4 });
      await page.keyboard.press('Escape'); await page.mouse.up(); await esperar(900);
      assert.equal(estado.logo.length, n0 + 1, 'Esc não envia');
      const depoisEsc = await controle.boundingBox();
      assert.ok(Math.abs(depoisEsc.x - caixa.x) < 2 && Math.abs(depoisEsc.y - caixa.y) < 2, 'controle voltou ao lugar gravado');

      // 5. Teclado: → (1%) e Shift+↓ (5%) agrupados num só comando depois da espera.
      await controle.focus();
      const n1 = estado.logo.length;
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
      await ate(() => estado.logo.length > n1, 'comando do teclado'); await salvo(page);
      assert.equal(estado.logo.length, n1 + 1, 'duas teclas seguidas = um comando');
      const teclado = ultimaPosicao(estado);
      assert.equal(Math.round((teclado.x - arrastada.x) * 100) / 100, 1); assert.equal(Math.round((teclado.y - arrastada.y) * 100) / 100, 5);
      assert.match(await page.locator('[data-anuncio-logo]').textContent(), /\S/, 'anúncio para leitor de tela');

      // 6. Os 9 lugares, tamanho e fundo.
      await page.getByRole('button', { name: 'Embaixo, à direita', exact: true }).click(); await salvo(page);
      await noLugar(page, ultimaPosicao(estado), [100, 100], 'embaixo à direita');
      await page.getByRole('radio', { name: 'Grande' }).check(); await salvo(page);
      assert.equal(ultimaPosicao(estado).largura, 26);
      const fundo = page.getByRole('checkbox', { name: 'Fundo claro atrás da logo' }), tinhaFundo = await fundo.isChecked();
      await fundo.click(); await salvo(page);
      assert.equal(ultimaPosicao(estado).fundo, !tinhaFundo);
      await page.screenshot({ path: path.join(out, '04-canto-grande-fundo.png') });

      // 7. Mudanças rápidas com a resposta presa: nunca dois comandos em voo; a última posição vence.
      estado.segurar = true; const n2 = estado.logo.length;
      await page.getByRole('button', { name: 'Em cima, à esquerda', exact: true }).click();
      await ate(() => estado.presos.length === 1, 'primeiro comando preso');
      await page.getByRole('button', { name: 'No centro', exact: true }).click();
      await page.getByRole('button', { name: 'Embaixo, no centro', exact: true }).click();
      await page.locator('[data-situacao-logo="salvando"]').waitFor();
      await esperar(500);
      assert.equal(estado.logo.length, n2 + 1, 'segundo comando espera o primeiro');
      estado.segurar = false; estado.presos.splice(0).forEach(r => r());
      await salvo(page);
      assert.equal(estado.maxEmVoo, 1, 'no máximo um comando em voo');
      assert.ok(estado.logo.length <= n2 + 2, 'intermediária absorvida');
      await noLugar(page, ultimaPosicao(estado), [50, 100], 'embaixo no centro');
      assert.deepEqual(dados.conteudo.logoPosicoes[ARTE], ultimaPosicao(estado), 'gravado = último');

      // 8. Erro → "Tentar de novo" reenviando a mesma intenção.
      estado.falharProximo = 400;
      await page.getByRole('button', { name: 'No meio, à esquerda', exact: true }).click();
      await page.locator('[data-situacao-logo="erro"]').waitFor();
      await page.screenshot({ path: path.join(out, '05-erro-tentar-de-novo.png') });
      await page.getByRole('button', { name: 'Tentar de novo' }).click(); await salvo(page);
      await noLugar(page, dados.conteudo.logoPosicoes[ARTE], [0, 50], 'meio à esquerda');

      // 9. Sessão expirada: renova uma vez (nova logo_sessao) e grava.
      estado.expirarProximo = true; const abrirSessao = () => estado.logo.filter(b => b.acao === 'logo_sessao').length, sessoesAntes = abrirSessao();
      await page.getByRole('button', { name: 'Em cima, à direita', exact: true }).click(); await salvo(page);
      assert.equal(abrirSessao(), sessoesAntes + 1, 'abriu uma sessão nova');
      await noLugar(page, dados.conteudo.logoPosicoes[ARTE], [100, 0], 'em cima à direita');

      // 9b. PNG baixado (Astra r1, validação pendente): a logo vermelha aparece no canto de cima à direita da arte
      // e não no canto de cima à esquerda; a faixa lisa de cima da arte segue com a cor dela fora da logo.
      {
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar imagem' }).click()]);
        const arquivo = path.join(out, '10-baixado-logo-sobre.png'); await download.saveAs(arquivo);
        const { data, info } = await sharp(arquivo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const vermelhos = (x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * info.width + x) * 3; if (data[i] > 190 && data[i + 1] < 90 && data[i + 2] < 110) n++; } return n; };
        const q = Math.round(info.width / 2), alto = Math.round(info.height * 0.18); // só a faixa lisa (a textura começa em 300/1536)
        const direita = vermelhos(q, info.width, 0, alto), esquerda = vermelhos(0, q, 0, alto);
        assert.ok(direita > 2000, `logo no PNG em cima à direita (${direita} px vermelhos)`);
        assert.ok(esquerda < direita / 20, `nada da logo em cima à esquerda (${esquerda} px)`);
        resumo.push({ cenario: 'png-baixado', largura: info.width, altura: info.height, vermelhosDireita: direita, vermelhosEsquerda: esquerda });
      }

      // 10. "Sugerir lugar" e, no mesmo instante, "Voltar para a faixa" (r2, Astra r1 P2): a sugestão que termina
      // depois não desfaz a faixa; nenhum comando "sobre" sai depois do "faixa".
      await page.evaluate(() => {
        const botao = nome => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === nome);
        botao('Sugerir lugar').click(); botao('Voltar para a faixa').click();
      });
      await salvo(page); await esperar(2000); await salvo(page);
      assert.equal(dados.conteudo.logoPosicoes[ARTE].modo, 'faixa', 'a faixa vence a sugestão atrasada');
      assert.equal(ultimaPosicao(estado).modo, 'faixa', 'o último comando enviado é a faixa');
      await page.getByRole('button', { name: 'Colocar a logo sobre a arte' }).waitFor();
      assert.equal(await controle.count(), 0);

      // Nenhum salvar de textos levou campos da logo.
      for (const b of estado.posts.filter(p => p.acao === 'salvar')) assert.ok(!('logoPosicoes' in (b.conteudo ?? {})) && !('logoBuffet' in (b.conteudo ?? {})), 'salvar sem a logo');
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'editor-buffet', comandos: estado.logo.length, sessoes: estado.logo.filter(b => b.acao === 'logo_sessao').length, maxEmVoo: estado.maxEmVoo, outrasApis: [...estado.outras] });
      await context.close();
    }

    // 11. Celular: controles cabem sem rolagem horizontal.
    {
      const { page, context, estado } = await abrirEditor({ viewport: { width: 390, height: 844 }, posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 80, y: 10, largura: 18, fundo: true, origem: 'sugerida' } } });
      await page.getByRole('group', { name: 'Lugar da logo' }).waitFor();
      await page.locator('[data-logo-buffet]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '06-celular-controles.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sem rolagem horizontal a 390 px');
      assert.equal(estado.logo.length, 0); assert.deepEqual(estado.erros, []);
      await context.close();
    }

    // 11b. Toque (Astra r1, validação pendente): arrastar com o dedo grava um comando ao soltar; touchcancel
    // (pointercancel no controle) descarta o arraste sem enviar nada e a logo volta para onde estava.
    {
      const { page, context, estado } = await abrirEditor({ hasTouch: true, viewport: { width: 390, height: 844 }, posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 50, y: 50, largura: 18, fundo: true, origem: 'sugerida' } } });
      const controle = page.getByRole('button', { name: 'Logo do buffet sobre a arte' });
      await controle.waitFor(); await controle.scrollIntoViewIfNeeded(); await page.locator('[data-camada-logo="pronta"]').first().waitFor();
      const cdp = await context.newCDPSession(page);
      const toque = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] });
      await page.evaluate(() => { window.__cancel = 0; document.addEventListener('pointercancel', e => { if (e.pointerType === 'touch') window.__cancel++; }, true); });
      let c = await controle.boundingBox(); const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
      await toque('touchStart', cx, cy); for (let i = 1; i <= 5; i++) await toque('touchMove', cx + i * 8, cy - i * 20);
      assert.equal(estado.logo.length, 0, 'nada é enviado durante o arraste com o dedo');
      await toque('touchEnd'); await salvo(page);
      const comToque = ultimaPosicao(estado);
      assert.ok(comToque && comToque.x > 50 && comToque.y < 50, `toque moveu a logo (${comToque?.x},${comToque?.y})`);
      const n = estado.logo.length; c = await controle.boundingBox();
      const tx = c.x + c.width / 2, ty = c.y + c.height / 2;
      await toque('touchStart', tx, ty); for (let i = 1; i <= 4; i++) await toque('touchMove', tx - i * 15, ty + i * 25);
      await toque('touchCancel'); await esperar(900);
      assert.ok(await page.evaluate(() => window.__cancel) >= 1, 'o navegador disparou pointercancel de toque');
      assert.equal(estado.logo.length, n, 'pointercancel não envia');
      const depois = await controle.boundingBox();
      assert.ok(Math.abs(depois.x - c.x) < 2 && Math.abs(depois.y - c.y) < 2, 'controle voltou ao lugar gravado depois do pointercancel');
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'toque', comandos: estado.logo.length, pointercancel: await page.evaluate(() => window.__cancel) });
      await page.screenshot({ path: path.join(out, '11-toque-celular.png') });
      await context.close();
    }

    // 12. Editor da família: sem controles da logo e sem comandos da logo.
    {
      const { page, context, estado } = await abrirEditor({ admin: false });
      await esperar(1000);
      assert.equal(await page.getByRole('checkbox', { name: 'Mostrar a logo do buffet neste convite' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Logo do buffet sobre a arte' }).count(), 0);
      assert.equal(await page.locator('[data-logo-buffet]').count(), 0);
      assert.equal(estado.logo.length, 0); assert.deepEqual(estado.erros, []);
      await page.screenshot({ path: path.join(out, '07-familia-sem-controles.png') });
      await context.close();
    }

    // 16. r4 (Felipe 16/11: "Cortar releitura"): sem releitura automática. Depois de uma confirmação, outra aba muda a
    // posição no servidor; foco e volta à aba não fazem GET e a tela continua com a escolha desta aba.
    {
      const { page, context, estado, dados } = await abrirEditor({ posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 50, y: 50, largura: 18, fundo: true, origem: 'sugerida' } } });
      const lugar = page.getByRole('button', { name: 'Em cima, à esquerda', exact: true });
      await ate(async () => !(await lugar.isDisabled()), 'lugar habilitado com a caixa pronta');
      const g0 = estado.gets;
      await lugar.click(); await salvo(page);
      const nova = ultimaPosicao(estado); assert.ok(nova.x < 20 && nova.y < 20, 'comando confirmado no canto');
      dados.conteudo.logoPosicoes[ARTE] = { ...nova, x: 70, y: 75 };
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await esperar(2000);
      assert.equal(estado.gets, g0, `nenhum GET no foco (${estado.gets - g0})`);
      await noLugar(page, nova, [0, 0], 'a tela fica com a escolha desta aba');
      assert.equal(await page.locator('[data-logo-conferindo]').count(), 0);
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'sem-releitura', gets: estado.gets - g0 });
      await context.close();
    }
    // 17. r4 (Astra r3, P2): a primeira carga tem limite e uma nova tentativa. 500 e depois JSON sem a logo: para em
    // duas leituras e mostra "Tentar de novo"; o clique lê uma vez e abre o editor. 404 (sem convite) não repete.
    {
      const { page, context, estado } = await abrirEditor({ falharGets: [500, 'sem-logo'], esperarEditor: false, posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 50, y: 50, largura: 18, fundo: true, origem: 'sugerida' } } });
      const aviso = page.locator('[data-falha-carga]'); await aviso.waitFor({ timeout: 8000 });
      await esperar(3000);
      assert.equal(estado.gets, 2, `duas leituras e para (${estado.gets})`);
      assert.equal(await page.getByLabel('Nome do aniversariante', { exact: true }).count(), 0, 'editor não abre com a carga falhando');
      await page.screenshot({ path: path.join(out, '13-falha-carga.png') });
      await aviso.getByRole('button', { name: 'Tentar de novo' }).click();
      await page.getByRole('button', { name: 'Logo do buffet sobre a arte' }).waitFor();
      await esperar(500);
      assert.equal(estado.gets, 3, 'Tentar de novo faz uma leitura');
      assert.equal(await aviso.count(), 0);
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'falha-carga', gets: estado.gets });
      await context.close();
    }
    {
      const { page, context, estado } = await abrirEditor({ falharGets: [404], esperarEditor: false });
      await page.getByRole('button', { name: 'Criar convite da festa' }).waitFor({ timeout: 8000 });
      await esperar(2500);
      assert.equal(estado.gets, 1, '404 não repete');
      assert.equal(await page.locator('[data-falha-carga]').count(), 0, '404 segue o painel de criação');
      resumo.push({ cenario: 'sem-convite-404', gets: estado.gets });
      await context.close();
    }
    // 17b. r4 (Astra r3, P2): o limite aborta o pedido. O primeiro GET fica sem resposta; depois de 10 s a página
    // aborta esse fetch (requestfailed) antes da nova tentativa, que abre o editor.
    {
      const abortados = [];
      const { page, context, estado } = await abrirEditor({ segurarGets: true, esperarEditor: false });
      page.on('requestfailed', r => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/admin/convites') abortados.push(estado.gets); });
      await ate(async () => estado.gets === 1, 'primeiro GET preso', 8000);
      await ate(async () => abortados.length === 1, 'GET abortado no limite', 14000);
      assert.equal(abortados[0], 1, 'abortado antes da nova tentativa');
      estado.segurarGet = false;
      await ate(async () => estado.gets === 2, 'nova tentativa', 5000);
      estado.getsPresos.splice(0).forEach(r => r());
      await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      assert.equal(estado.gets, 2);
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'limite-aborta-fetch', gets: estado.gets, abortados: abortados.length });
      await context.close();
    }
    // 18. r3 (Astra r2, P3): arte atrasada. Lugares e setas ficam desligados até a caixa da arte existir; nada grava 0/0.
    {
      const { page, context, estado } = await abrirEditor({ arteAtrasada: true, posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 50, y: 50, largura: 18, fundo: true, origem: 'sugerida' } } });
      const campo = page.getByRole('group', { name: 'Posição da logo sobre a arte' }); await campo.waitFor();
      const lugar = page.getByRole('button', { name: 'Em cima, à esquerda', exact: true }), seta = page.getByRole('button', { name: 'Mover para a direita' });
      await ate(async () => estado.liberarArte !== null, 'arte pedida e presa');
      assert.ok(await lugar.isDisabled(), 'lugar desligado sem caixa'); assert.ok(await seta.isDisabled(), 'seta desligada sem caixa');
      assert.equal(await page.getByRole('button', { name: 'Logo do buffet sobre a arte' }).count(), 0, 'sem controle de arraste sem caixa');
      await page.screenshot({ path: path.join(out, '14-arte-atrasada-sem-caixa.png') });
      const n0 = estado.logo.length;
      estado.liberarArte();
      await ate(async () => !(await lugar.isDisabled()) && !(await seta.isDisabled()), 'liga com a caixa pronta');
      assert.equal(estado.logo.length, n0, 'nada gravado antes da caixa');
      await lugar.click(); await salvo(page);
      const pos = ultimaPosicao(estado);
      assert.ok(pos.x > 0 && pos.y > 0, `canto grava o centro exibido, não 0/0 (${pos.x},${pos.y})`);
      await noLugar(page, pos, [0, 0], 'canto com a caixa pronta');
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'arte-atrasada', posicao: [pos.x, pos.y] });
      await context.close();
    }
    // 19. r4 (Astra r3, P3): o tamanho muda durante o arraste. O gesto é cancelado: soltar não grava a largura velha
    // e a logo fica onde estava, já com o tamanho novo.
    {
      const { page, context, estado } = await abrirEditor({ posicoes: { [ARTE]: { modo: 'sobre', arteId: ARTE, x: 50, y: 50, largura: 18, fundo: true, origem: 'sugerida' } } });
      const controle = page.getByRole('button', { name: 'Logo do buffet sobre a arte' }); await controle.waitFor();
      await page.locator('[data-camada-logo="pronta"]').first().waitFor();
      const caixa = await controle.boundingBox();
      await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2); await page.mouse.down();
      await page.mouse.move(caixa.x + caixa.width / 2 + 60, caixa.y + caixa.height / 2 + 80, { steps: 3 });
      const n0 = estado.logo.length;
      // Outra parte da tela muda o tamanho enquanto o botão do mouse continua apertado.
      await page.evaluate(() => { const r = [...document.querySelectorAll('[role="radiogroup"][aria-label="Tamanho da logo"] label')].find(l => l.textContent.includes('Grande')); r.querySelector('input').click(); });
      await salvo(page);
      await page.mouse.move(caixa.x + caixa.width / 2 + 120, caixa.y + caixa.height / 2 + 140, { steps: 3 });
      await page.mouse.up(); await esperar(900);
      const depois = estado.logo.slice(n0).filter(b => b.acao === 'logo_buffet' && b.posicoes?.length).flatMap(b => b.posicoes);
      assert.ok(depois.length >= 1, 'o tamanho foi gravado');
      assert.ok(depois.every(p => p.largura === 26), `nada gravado com a largura do início do arraste (${JSON.stringify(depois)})`);
      const ultima = ultimaPosicao(estado);
      assert.deepEqual([ultima.x, ultima.y, ultima.largura], [50, 50, 26], 'soltar não move: o gesto foi cancelado');
      assert.equal(await controle.getAttribute('data-arrastando'), 'false');
      await noLugar(page, ultima, [50, 50], 'logo no lugar de antes, com o tamanho novo');
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'arraste-geometria-mudou', ultima: [ultima.x, ultima.y, ultima.largura] });
      await context.close();
    }
    // 13–15. Página pública: logo sobre a arte; 409 na arte → relê uma vez; segunda divergência → logo no rodapé.
    // r2 (Astra r1, P2): troca A → B com a releitura do JSON atrasada; a arte A não é pedida de novo enquanto o JSON
    // não chega, e a arte B (outro id) entra com a logo sobre ela, sem cair no rodapé.
    for (const modo of ['uma-divergencia', 'duas-divergencias', 'a-para-b-atrasado']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const pub = { gets: 0, releituras: 0, conflitos: 0, artes: [], logos: 0, outras: [] };
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (url.pathname !== `/api/convites/publico/${TOKEN}`) { pub.outras.push(url.pathname); return route.abort(); }
        if (url.searchParams.has('logo')) { pub.logos++; return route.fulfill({ contentType: 'image/png', body: logo }); }
        const a = url.searchParams.get('arte');
        if (a) {
          pub.artes.push(a);
          const conflito = modo === 'a-para-b-atrasado' ? a === ARTE : a !== '1' && (modo === 'duas-divergencias' || pub.artes.filter(x => x !== '1').length === 1);
          if (conflito) pub.conflitos++;
          return conflito ? route.fulfill({ status: 409, body: '' }) : route.fulfill({ contentType: 'image/webp', body: arte });
        }
        pub.gets++; if (pub.conflitos > 0) pub.releituras++;
        const trocou = modo === 'a-para-b-atrasado' && pub.conflitos > 0; // só a releitura depois do 409 (o modo dev pede o JSON duas vezes ao montar)
        if (trocou) await esperar(1800);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
          conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília', arteId: trocou ? ARTE_B : ARTE, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 }, confirmarPresenca: true },
          marcaKidmais: false, logoBuffet: true, logoSobre: { x: 80, y: 8, largura: 18, fundo: true }, buffet: 'Buffet Teste', familia: null } }) });
      });
      const page = await context.newPage(); const erros = []; page.on('pageerror', e => erros.push(e.message));
      await page.goto(`${base}/convite/${TOKEN}`);
      await page.getByRole('heading', { name: 'Vamos celebrar juntos.' }).waitFor();
      const rodape = page.locator('footer img[alt="Logo do buffet"]');
      if (modo === 'uma-divergencia') {
        await page.locator('[data-camada-logo="pronta"]').waitFor({ timeout: 10000 });
        assert.equal(pub.releituras, 1, 'uma releitura do JSON depois do 409');
        assert.equal(await rodape.count(), 0, 'rodapé sem logo com a logo sobre a arte');
        assert.ok(pub.artes.every(a => a === ARTE), 'pede a arte pelo id');
        await page.screenshot({ path: path.join(out, '08-publico-logo-sobre.png') });
      } else if (modo === 'a-para-b-atrasado') {
        await page.locator('[data-camada-logo="pronta"]').waitFor({ timeout: 10000 });
        await esperar(600);
        assert.deepEqual(pub.artes, [ARTE, ARTE_B], `A uma vez, depois B (${pub.artes.join(',')})`);
        assert.equal(pub.releituras, 1, 'uma releitura'); assert.equal(pub.conflitos, 1, 'uma divergência');
        assert.equal(await rodape.count(), 0, 'logo segue sobre a arte B');
        await page.screenshot({ path: path.join(out, '12-publico-a-para-b.png') });
      } else {
        await rodape.waitFor({ timeout: 10000 });
        assert.equal(await page.locator('[data-camada-logo]').count(), 0, 'sem sobreposição na segunda divergência');
        assert.equal(pub.releituras, 1, 'só uma releitura'); assert.equal(pub.conflitos, 2, 'duas divergências');
        assert.ok(pub.artes.includes('1'), 'cai para a arte publicada atual');
        await page.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
        await page.screenshot({ path: path.join(out, '09-publico-segunda-divergencia-rodape.png'), fullPage: true });
      }
      assert.deepEqual(erros, []); assert.deepEqual(pub.outras.filter(p => p !== '/api/endereco-atual'), []); // endereço do site: fora do escopo, abortado
      resumo.push({ cenario: `publico-${modo}`, gets: pub.gets, releituras: pub.releituras, conflitos: pub.conflitos, artes: pub.artes.length });
      await context.close();
    }
    console.log(JSON.stringify({ ok: true, resumo, capturas: out }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
