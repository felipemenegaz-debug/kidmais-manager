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
const ARTE = id(50), TOKEN = 'p'.repeat(43);
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

  async function abrirEditor({ admin = true, posicoes = {}, mostrar = true, viewport = { width: 1440, height: 1100 } } = {}) {
    const dados = {
      id: id(1), festaId: id(5),
      conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília',
        arteId: ARTE, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 }, confirmarPresenca: true, logoPosicoes: posicoes },
      ...(admin ? { logoBuffet: { mostrar, logoDataUrl: logoUrl }, publicadoArteId: ARTE } : {}),
      revisao: 3, publicado: true, desatualizado: false, linkPublico: `/convite/${TOKEN}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
      disponiveis: 3, iaDisponivel: true, completoDisponivel: true, geracaoIncerta: false, geracaoEmAndamento: null,
      cotas: admin ? { festa: 3, festaUsado: 1, cliente: 2, clienteUsado: 0, empresa: 60, empresaUsado: 1 } : { festa: 3, festaUsado: 1, cliente: 2, clienteUsado: 0 },
      artes: [{ id: ARTE, origem: 'IA', completo: true, url: dataUrl(arte, 'image/webp') }], respostas: [], historico: [],
    };
    // Servidor simulado: sessões por id, seq por sessão, comandos em voo, falhas e retenção sob demanda.
    const estado = { posts: [], logo: [], sessoes: new Map(), emVoo: 0, maxEmVoo: 0, erros: [], segurar: false, presos: [], falharProximo: null, expirarProximo: false, outras: new Set() };
    const context = await browser.newContext({ viewport });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (data, status = 200, extra = {}) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 300 ? { ok: true, data } : { ok: false, erro: data, ...extra }) });
      if (url.pathname === '/api/admin/autenticacao') return json({ usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null });
      if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return json({ logoDataUrl: logoUrl });
      if (!['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) { estado.outras.add(url.pathname); return json(null); }
      if (request.method() === 'GET') return json(JSON.parse(JSON.stringify(dados)));
      const b = request.postDataJSON(); estado.posts.push(b);
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
        return json({ gravado: true });
      } finally { estado.emVoo--; }
    });
    const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
    await page.goto(admin ? `${base}/admin/festas/${id(5)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
    await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    return { page, context, estado, dados };
  }
  const ultimaPosicao = estado => [...estado.logo].reverse().find(b => b.acao === 'logo_buffet' && b.posicoes?.length)?.posicoes.at(-1);
  const salvo = page => page.locator('[data-situacao-logo="salvo"]').waitFor({ timeout: 8000 });

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
      assert.deepEqual([ultimaPosicao(estado).x, ultimaPosicao(estado).y], [100, 100]);
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
      assert.deepEqual([ultimaPosicao(estado).x, ultimaPosicao(estado).y], [50, 100]);
      assert.deepEqual([dados.conteudo.logoPosicoes[ARTE].x, dados.conteudo.logoPosicoes[ARTE].y], [50, 100], 'gravado = último');

      // 8. Erro → "Tentar de novo" reenviando a mesma intenção.
      estado.falharProximo = 400;
      await page.getByRole('button', { name: 'No meio, à esquerda', exact: true }).click();
      await page.locator('[data-situacao-logo="erro"]').waitFor();
      await page.screenshot({ path: path.join(out, '05-erro-tentar-de-novo.png') });
      await page.getByRole('button', { name: 'Tentar de novo' }).click(); await salvo(page);
      assert.deepEqual([dados.conteudo.logoPosicoes[ARTE].x, dados.conteudo.logoPosicoes[ARTE].y], [0, 50]);

      // 9. Sessão expirada: renova uma vez (nova logo_sessao) e grava.
      estado.expirarProximo = true; const abrirSessao = () => estado.logo.filter(b => b.acao === 'logo_sessao').length, sessoesAntes = abrirSessao();
      await page.getByRole('button', { name: 'Em cima, à direita', exact: true }).click(); await salvo(page);
      assert.equal(abrirSessao(), sessoesAntes + 1, 'abriu uma sessão nova');
      assert.deepEqual([dados.conteudo.logoPosicoes[ARTE].x, dados.conteudo.logoPosicoes[ARTE].y], [100, 0]);

      // 10. Voltar para a faixa.
      await page.getByRole('button', { name: 'Voltar para a faixa' }).click(); await salvo(page);
      assert.equal(dados.conteudo.logoPosicoes[ARTE].modo, 'faixa');
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

    // 13–14. Página pública: logo sobre a arte; 409 na arte → relê uma vez; segunda divergência → logo no rodapé.
    for (const modo of ['uma-divergencia', 'duas-divergencias']) {
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
          const conflito = a !== '1' && (modo === 'duas-divergencias' || pub.artes.filter(x => x !== '1').length === 1);
          if (conflito) pub.conflitos++;
          return conflito ? route.fulfill({ status: 409, body: '' }) : route.fulfill({ contentType: 'image/webp', body: arte });
        }
        pub.gets++; if (pub.conflitos > 0) pub.releituras++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
          conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília', arteId: ARTE, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 }, confirmarPresenca: true },
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
