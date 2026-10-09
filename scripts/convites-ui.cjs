/* eslint-disable @typescript-eslint/no-require-imports */
// Next.js local + respostas sintéticas no navegador. Nenhuma requisição /api chega ao servidor.
// PLAYWRIGHT_MODULE: caminho do pacote Playwright; CONVITES_TEST_URL: servidor local previamente iniciado.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3058';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Teste limitado ao servidor local');
const out = path.resolve('.local-convites-qa'); fs.mkdirSync(out, { recursive: true });
const token = 'a'.repeat(43), publico = 'p'.repeat(43);
const conteudo = { tema: 'celebrar', nome: 'Alice', idade: '5 anos', mensagem: 'Um dia especial fica ainda melhor com você. Venha comemorar com a gente!', data: '2099-12-20', horario: '16:00', local: 'Jardim das Festas', endereco: 'Rua das Flores, 120 · São Paulo', arteId: null, confirmarPresenca: true };
const dados = { conteudo, revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${publico}`, clienteHabilitado: true, disponiveis: 3, iaDisponivel: false, cotas: { festa: 3, festaUsado: 0, cliente: 3, clienteUsado: 0 }, artes: [], respostas: [], historico: [] };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1050 }, acceptDownloads: true });
    const errors = [], comandos = [];
    await context.route('**/api/**', async route => {
      const r = route.request(), u = new URL(r.url()); let data;
      if (u.pathname === '/api/convites/cliente') {
        assert.equal(r.headers().authorization, `Bearer ${token}`);
        if (r.method() === 'POST') { const b = r.postDataJSON(); comandos.push(b); if (b.conteudo) dados.conteudo = b.conteudo; dados.revisao++; if (b.acao === 'publicar') dados.publicado = true; }
        data = dados;
      } else if (u.pathname === `/api/convites/publico/${publico}`) {
        if (r.method() === 'POST') { comandos.push(r.postDataJSON()); data = { confirmado: true }; }
        else data = { conteudo: dados.conteudo };
      } else throw new Error(`API inesperada: ${u.pathname}`);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/convites/criar#${token}`);
    await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Alice Sofia');
    await page.getByRole('button', { name: 'Jardim encantado' }).click();
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
    assert.equal(comandos.length, 1); assert.equal(comandos[0].acao, 'salvar');
    await page.screenshot({ path: path.join(out, 'editor-desktop.png'), fullPage: true });
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar imagem' }).click();
    const download = await downloadPromise; await download.saveAs(path.join(out, 'convite.png'));
    assert.equal(comandos.length, 1, 'Download não faz geração');
    await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
    await page.getByRole('link', { name: 'Abrir convite publicado' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'editor-mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Sem overflow no celular');
    await page.goto(`${base}/convite/${publico}`);
    await page.getByRole('heading', { name: 'Alice Sofia' }).waitFor();
    await page.getByLabel('Seu nome', { exact: true }).fill('Família Souza');
    await page.getByLabel('Crianças', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Enviar resposta' }).click();
    await page.getByRole('status').filter({ hasText: 'Resposta salva' }).waitFor();
    const chave = comandos.at(-1).chave;
    await page.getByLabel('Sua resposta').selectOption('nao');
    await page.getByRole('button', { name: 'Enviar resposta' }).click();
    await page.getByRole('button', { name: 'Enviar resposta' }).waitFor();
    assert.equal(comandos.at(-1).chave, chave, 'Atualiza a mesma resposta neste dispositivo');
    await page.screenshot({ path: path.join(out, 'publico-mobile.png'), fullPage: true });
    assert.equal(await page.getByText('Família Souza', { exact: true }).count(), 0, 'Lista de convidados não é pública');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, cenarios: ['editor cliente', 'troca de tema sem IA', 'salvar', 'download sem geração', 'publicar', 'mobile sem overflow', 'RSVP e atualização'], screenshots: out }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
