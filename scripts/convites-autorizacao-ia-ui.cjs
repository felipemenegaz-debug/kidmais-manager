/* eslint-disable @typescript-eslint/no-require-imports */
/* Autorização de IA (088) no editor do cliente. Next.js local + respostas sintéticas no navegador (padrão de scripts/convites-ui.cjs). Nenhuma /api chega ao servidor. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3071';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Teste limitado ao servidor local');
const out = process.env.SAIDA || path.resolve('.local-convites-qa', 'autorizacao-ia'); fs.mkdirSync(out, { recursive: true });
const token = 'a'.repeat(43);
const conteudo = { tema: 'celebrar', nome: 'Alice', idade: '5 anos', mensagem: 'Venha comemorar!', data: '2099-12-20', horario: '16:00', local: 'Jardim', endereco: 'Rua Sintética, 1', arteId: null, confirmarPresenca: true };
const textos = {
  versao: 'convites-ia-20261021.1', provedor: 'openai', provedorNome: 'OpenAI', operador: 'CLIENTE',
  aviso: 'Para criar este convite com IA, enviaremos à OpenAI os dados selecionados da festa, que podem incluir nome e idade da criança e informações do evento. A fotografia só será enviada se você autorizar separadamente. A imagem gerada será armazenada no Kidmais e poderá conter esses dados. Consulte as condições de tratamento e retenção antes de continuar.',
  consentimento: 'Declaro ser responsável legal pela criança e autorizo especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Sei que posso escolher uma alternativa sem IA e revogar esta autorização para usos futuros.',
  foto: 'Autorizo também o envio desta fotografia ao provedor indicado (OpenAI) para gerar a arte.',
  imagens: 'Sem a autorização da fotografia, nenhuma foto nem imagem da festa usada como referência é enviada ao provedor.',
  alternativa: 'Prefere não usar IA? Use uma arte própria ou o visual padrão do convite: nada é enviado a provedores de IA.',
  hashes: { semFoto: 'a'.repeat(64), comFoto: 'b'.repeat(64) }, vigente: null, precisaRenovar: false,
};
const dados = { conteudo, revisao: 1, publicado: false, desatualizado: false, linkPublico: '/convite/' + 'p'.repeat(43), clienteHabilitado: true, disponiveis: 2, iaDisponivel: true, completoDisponivel: true,
  cotas: { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 }, artes: [], respostas: [], familias: [], historico: [], id: '00000000-0000-4000-8000-000000000001', autorizacaoIA: textos };
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const resultado = [];
  try {
    for (const viewport of [{ width: 1365, height: 1050 }, { width: 375, height: 812 }]) {
      dados.autorizacaoIA = { ...textos, vigente: null };
      const context = await browser.newContext({ viewport });
      const errors = [], comandos = [];
      await context.route('**/api/**', async route => {
        const r = route.request(), u = new URL(r.url());
        assert.equal(u.pathname, '/api/convites/cliente', 'API inesperada: ' + u.pathname);
        let data = dados;
        if (r.method() === 'POST') {
          const b = r.postDataJSON(); comandos.push(b);
          if (b.acao === 'autorizar_ia') { dados.autorizacaoIA = { ...dados.autorizacaoIA, vigente: { id: 'x', provedor: 'openai', foto: b.foto, operador: 'CLIENTE', vinculo: b.vinculo, meio: 'PROPRIO_RESPONSAVEL', registradaEm: '2026-10-21T08:00:00.000Z' } }; data = { autorizacaoId: 'x' }; }
          else if (b.acao === 'revogar_autorizacao_ia') { dados.autorizacaoIA = { ...dados.autorizacaoIA, vigente: null }; data = { revogada: true }; }
          else throw new Error('comando inesperado ' + b.acao);
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/convites/criar#${token}`);
      await page.getByRole('heading', { name: 'Antes de gerar com IA · OpenAI' }).waitFor();
      assert.ok(await page.getByText('enviaremos à OpenAI os dados selecionados da festa', { exact: false }).isVisible());
      await page.getByLabel('Descreva a arte do convite').fill('Tema jardim, verde e amarelo, com borboletas');
      const gerar = page.getByRole('button', { name: /Gerar convite completo/ });
      assert.equal(await gerar.isDisabled(), true, 'sem autorização o botão fica desabilitado');
      const consentir = page.getByLabel(textos.consentimento), fotoCheck = page.getByLabel(textos.foto);
      assert.equal(await consentir.isChecked(), false); assert.equal(await fotoCheck.isChecked(), false, 'foto desmarcada por padrão');
      const registrar = page.getByRole('button', { name: 'Registrar autorização' });
      assert.equal(await registrar.isDisabled(), true);
      await page.screenshot({ path: path.join(out, `antes-${viewport.width}.png`), fullPage: true });
      await page.getByLabel('Seu nome (responsável legal)').fill('Responsável Sintético');
      await page.getByLabel('Vínculo com a criança').selectOption('MAE');
      await consentir.check();
      await registrar.click();
      await page.getByText('Autorização registrada, sem a fotografia.').waitFor();
      const autorizar = comandos.find(c => c.acao === 'autorizar_ia');
      assert.deepEqual(autorizar, { acao: 'autorizar_ia', versao: textos.versao, provedor: 'openai', textoHash: textos.hashes.semFoto, responsavelNome: 'Responsável Sintético', vinculo: 'MAE', declaracao: true, foto: false });
      await page.getByText('Fotografia e imagens de referência:').waitFor();
      assert.equal(await gerar.isDisabled(), false, 'com autorização o botão habilita');
      await page.getByRole('heading', { name: 'Antes de gerar com IA · OpenAI' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `depois-${viewport.width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Revogar autorização' }).click();
      await page.getByText('Autorização revogada.', { exact: false }).waitFor();
      assert.equal(await gerar.isDisabled(), true, 'revogada: o botão volta a ficar desabilitado');
      await page.getByRole('button', { name: 'Usar arte própria, sem IA' }).click();
      assert.equal(await page.locator('details').filter({ hasText: 'Imagens anteriores' }).evaluate(d => d.open), true, 'alternativa sem IA abre a arte própria');
      const larguraPagina = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(larguraPagina <= viewport.width + 1, `sem rolagem horizontal (${larguraPagina})`);
      assert.deepEqual(errors, []);
      resultado.push({ viewport: viewport.width, comandos: comandos.map(c => c.acao), larguraPagina });
      await context.close();
    }
    console.log('PASS', JSON.stringify(resultado));
  } finally { await browser.close(); }
})().catch(e => { console.error('FALHA', e); process.exit(1); });
