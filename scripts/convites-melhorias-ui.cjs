/* eslint-disable @typescript-eslint/no-require-imports */
// Navegador local e APIs simuladas: nenhum dado real, banco ou chamada paga.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const { conteudoSchema } = require('../lib/convites/domain.ts');
const { contraste } = require('../lib/convites/visual.ts');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3058';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><path fill="#e04070" d="M0 0h400v900H0z"/><path fill="#258b71" d="M400 0h400v900H400z"/><path fill="#344fb7" d="M800 0h400v900H800z"/></svg>')).png().toBuffer();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const admin of [true, false]) {
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Demonstração', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Demonstração' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const dados = { conteudo: { tema: 'jardim', nome: 'Alice Sofia', idade: '5 anos', mensagem: 'Venha comemorar!', data: '2099-12-20', horario: '16:00', local: 'Jardim das Festas', endereco: 'Rua das Flores, 120', arteId: id(10), confirmarPresenca: true }, revisao: 1, publicado: true, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: true, disponiveis: 3, iaDisponivel: false, cotas: { festa: 3, festaUsado: 0, cliente: 3, clienteUsado: 0 }, artes: [{ id: id(10), origem: 'UPLOAD', url: `data:image/png;base64,${png.toString('base64')}` }], respostas: [{ nome: 'Família Souza', presenca: true, adultos: 2, criancas: 1 }, { nome: 'Família Lima', presenca: false, adultos: 0, criancas: 0 }], convidadosContratados: 2, historico: [] };
      let publicado = structuredClone(dados.conteudo); const comandos = [], erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      await context.route('**/api/**', async route => {
        const r = route.request(), u = new URL(r.url()); let data;
        if (u.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-sintetico', nome: 'Equipe de teste', contexto, comercial: null };
        else if (u.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        else if (u.pathname === (admin ? '/api/admin/convites' : '/api/convites/cliente')) {
          if (r.method() === 'POST') {
            const b = r.postDataJSON(); comandos.push(b); assert(['salvar', 'publicar'].includes(b.acao));
            assert.equal(b.revisao, dados.revisao); dados.conteudo = conteudoSchema.parse(b.conteudo); dados.revisao++;
            if (b.acao === 'publicar') publicado = structuredClone(dados.conteudo);
            data = { salvo: true };
          } else data = dados;
        } else if (u.pathname === `/api/convites/publico/${'p'.repeat(43)}`) {
          if (u.searchParams.has('arte')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
          data = { conteudo: publicado };
        } else { erros.push(`API inesperada: ${u.pathname}`); return route.abort(); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      await page.goto(admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
      await page.getByRole('button', { name: 'Arte completa', exact: true }).click();
      const quadro = page.getByRole('article', { name: 'Prévia do convite' });
      const tamanho = await quadro.boundingBox(); assert(Math.abs(tamanho.width / tamanho.height - .75) < .01, 'Arte completa ocupa 3:4 sem texto extra');
      await page.getByRole('button', { name: 'Preencher e recortar', exact: true }).click();
      await page.getByLabel(/Posição horizontal/).fill('100');
      await page.getByRole('button', { name: 'Usar cores da imagem', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Cores extraídas' }).waitFor();
      assert.equal(comandos.length, 0, 'Enquadrar e extrair cores não chama API');
      await page.getByLabel('Cor: Fundo', { exact: true }).fill('#777777');
      await page.getByLabel('Cor: Texto', { exact: true }).fill('#777777');
      await page.getByText('O texto foi ajustado automaticamente', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
      assert.equal(publicado.visual, undefined, 'Rascunho não altera público');
      await page.reload(); await page.getByRole('button', { name: 'Arte completa', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Arte completa', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByLabel(/Posição horizontal/).inputValue(), '100');
      const downloadP = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
      const download = await downloadP, arquivo = path.join(out, `convite-completo-${admin ? 'buffet' : 'cliente'}.png`); await download.saveAs(arquivo);
      const pixel = await sharp(arquivo).extract({ left: 1000, top: 1000, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      assert.deepEqual([...pixel], [52, 79, 183], 'PNG respeita recorte à direita e não sobrepõe texto');
      const painel = page.getByRole('region', { name: 'Confirmações de presença' });
      await painel.getByText('1 pessoa acima', { exact: false }).waitFor();
      await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Texto ainda não salvo');
      await painel.getByRole('button', { name: 'Atualizar confirmações' }).click();
      await page.getByRole('status').filter({ hasText: 'Confirmações atualizadas' }).waitFor();
      assert.equal(await page.getByLabel('Nome do aniversariante', { exact: true }).inputValue(), 'Texto ainda não salvo');
      await painel.getByLabel('Buscar família').fill('souza');
      assert.equal(await painel.locator('tbody tr').count(), 1);
      const csvP = page.waitForEvent('download'); await painel.getByRole('button', { name: 'Exportar lista filtrada (CSV)' }).click();
      const csv = await csvP, csvFile = path.join(out, 'confirmacoes-teste.csv'); await csv.saveAs(csvFile);
      assert(fs.readFileSync(csvFile, 'utf8').includes('Souza')); assert(!fs.readFileSync(csvFile, 'utf8').includes('Lima'));
      await painel.getByLabel('Buscar família').fill(''); await painel.getByRole('button', { name: 'Não vão', exact: true }).click();
      assert.equal(await painel.locator('tbody tr').count(), 1);
      await painel.getByRole('button', { name: 'Todas', exact: true }).click();
      await page.getByRole('button', { name: 'Usar cores da imagem', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Cores extraídas' }).waitFor();
      await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
      assert.equal(comandos.length, 2, 'Somente salvar e publicar consomem requisições de escrita');
      await page.screenshot({ path: path.join(out, `melhorias-${admin ? 'buffet' : 'cliente'}-desktop.png`), fullPage: true });
      for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, cls: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })).slice(0, 15)))); }
      await page.screenshot({ path: path.join(out, `melhorias-${admin ? 'buffet' : 'cliente'}-mobile.png`), fullPage: true });
      await page.goto(`${base}${dados.linkPublico}`); await page.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      const cores = await page.locator('main').evaluate(el => { const c = getComputedStyle(el); return { fundo: c.getPropertyValue('--convite-fundo').trim(), tinta: c.getPropertyValue('--convite-tinta').trim(), destaque: c.getPropertyValue('--convite-destaque').trim(), textoBotao: c.getPropertyValue('--botao-tinta').trim() }; });
      assert.equal(cores.fundo, publicado.visual.cores.fundo); assert(contraste(cores.fundo, cores.tinta) >= 4.5); assert(contraste(cores.destaque, cores.textoBotao) >= 4.5);
      assert.equal(await page.getByRole('region', { name: 'Confirmações de presença' }).count(), 0, 'Lista privada ausente no público');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(out, 'melhorias-publico-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1365, height: 1000 }); await page.screenshot({ path: path.join(out, 'melhorias-publico-desktop.png'), fullPage: true });
      assert.deepEqual(erros, []); await context.close();
    }
    console.log(JSON.stringify({ ok: true, cenarios: ['arte completa sem texto repetido', 'recorte preservado no PNG', 'cores locais sem créditos', 'contraste automático', 'rascunho separado da publicação', 'persistência', 'comparação contratual', 'busca e CSV filtrado', 'atualização preserva edição', 'buffet e cliente em 320/390px', 'público com cores publicadas'] }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
