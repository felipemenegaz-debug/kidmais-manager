/* eslint-disable @typescript-eslint/no-require-imports */
// Somente servidor local, respostas sintéticas e imagens públicas da biblioteca.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/biblioteca'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const admin of [true, false]) {
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const dados = { conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília', arteId: null, confirmarPresenca: true }, revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: true, disponiveis: 0, iaDisponivel: false, cotas: { festa: 0, festaUsado: 0, cliente: 0, clienteUsado: 0, empresa: 0, empresaUsado: 0 }, artes: [], respostas: [], familias: [], historico: [] };
      let publicado; const comandos = [], erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data;
        if (url.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null };
        else if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        else if (url.pathname === `/api/convites/publico/${'p'.repeat(43)}`) data = { conteudo: publicado };
        else if (['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) {
          if (request.method() === 'POST') {
            const b = request.postDataJSON(); comandos.push(b);
            assert(['salvar', 'publicar'].includes(b.acao), 'Nenhuma geração paga');
            dados.conteudo = b.conteudo; dados.revisao++;
            if (b.acao === 'publicar') { publicado = structuredClone(b.conteudo); dados.publicado = true; }
            data = { salvo: true };
          } else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      const url = admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`;
      await page.goto(url); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      for (const [tema, nome] of [['planetas', 'Planetas'], ['arco', 'Arco clássico'], ['ondulada', 'Moldura ondulada']]) {
        await page.getByRole('button', { name: new RegExp(`^${nome}`) }).click();
        const preview = page.getByRole('article', { name: 'Prévia do convite' });
        await preview.locator('svg').waitFor();
        assert.equal(await preview.locator('svg text').filter({ hasText: 'Lucas' }).count(), 1);
        await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
        assert.equal(dados.conteudo.tema, tema);
        await page.reload(); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: new RegExp(`^${nome}`) }).getAttribute('aria-pressed'), 'true');
        const downloaded = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
        const png = path.join(out, `${admin ? 'buffet' : 'cliente'}-${tema}.png`);
        await (await downloaded).saveAs(png);
        const meta = await sharp(png).metadata(); assert.equal(meta.width, 1080); assert.equal(meta.height, 1800);
        await preview.screenshot({ path: path.join(out, `preview-${admin ? 'buffet' : 'cliente'}-${tema}.png`) });
      }
      await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Maria Eduarda Aparecida de Albuquerque e Vasconcelos');
      await page.getByRole('textbox', { name: /^Mensagem/ }).fill('Venha comemorar com a nossa família! '.repeat(11));
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.getByRole('article', { name: 'Prévia do convite' }).screenshot({ path: path.join(out, `longo-${admin ? 'buffet' : 'cliente'}.png`) });
      await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
      const publica = await context.newPage(); await publica.goto(`${base}${dados.linkPublico}`);
      await publica.getByRole('heading', { name: 'Confirme sua presença' }).waitFor();
      assert.equal(await publica.locator('main').getAttribute('data-tema'), 'ondulada');
      assert((await publica.getByRole('article', { name: 'Prévia do convite' }).textContent()).includes('Maria Eduarda'));
      await publica.setViewportSize({ width: 390, height: 844 });
      assert(await publica.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(comandos.every(c => ['salvar', 'publicar'].includes(c.acao)));
      assert.equal(dados.disponiveis, 0); assert.deepEqual(erros, []);
      await context.close();
    }
    console.log('PASS biblioteca: buffet/cliente, três modelos, salvar/reabrir, PNG, textos longos, celular, publicação e RSVP; nenhum crédito consumido.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
