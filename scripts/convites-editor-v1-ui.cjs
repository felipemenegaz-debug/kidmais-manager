/* eslint-disable @typescript-eslint/no-require-imports */
// Editor V1 (convite completo): somente servidor local e API simulada; nenhuma geração real é enviada.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/editor-v1'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;

(async () => {
  const foto = await sharp({ create: { width: 240, height: 180, channels: 3, background: '#e6aa94' } }).png().toBuffer();
  const miniatura = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#8fb3a6' } }).webp().toBuffer();
  const completa = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#3b2f6b' } }).webp({ quality: 92 }).toBuffer();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];
  try {
    for (const admin of [true, false]) {
      const quem = admin ? 'buffet' : 'cliente';
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const artes = Array.from({ length: 12 }, (_, n) => ({ id: id(100 + n), origem: 'UPLOAD', completo: false, url: dataUrl(miniatura, 'image/webp') }));
      const dados = { conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília', arteId: null, confirmarPresenca: true },
        revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
        disponiveis: 3, iaDisponivel: true, completoDisponivel: true, geracaoIncerta: false, podeRecuperarGeracao: admin, geracoesPendentes: [], decisoesRecuperacao: [],
        cotas: admin ? { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0, empresa: 60, empresaUsado: 0 } : { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 },
        artes, respostas: [], historico: [] };
      const comandos = [], erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data;
        if (url.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null };
        else if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        else if (['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) {
          if (request.method() === 'POST') {
            const b = request.postDataJSON(); comandos.push(b);
            assert(['salvar', 'publicar', 'gerar'].includes(b.acao), `Ação inesperada: ${b.acao}`);
            if (b.acao === 'gerar') {
              // Simula o servidor: uma arte completa WebP 1024×1536 por chave; nenhuma chamada externa.
              dados.artes = [{ id: id(50), origem: 'IA', completo: true, url: dataUrl(completa, 'image/webp') }, ...dados.artes];
              dados.disponiveis--; data = { arteId: id(50), estado: 'CONCLUIDA', completo: true };
            } else { dados.conteudo = b.conteudo; dados.revisao++; if (b.acao === 'publicar') dados.publicado = true; data = { salvo: true }; }
          } else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      const url = admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`;
      await page.goto(url); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();

      // 1. Coluna central: dados → arte → IA; painel de IA aberto sem clique; molduras e controles do laboratório ausentes.
      const topo = async loc => (await loc.boundingBox()).y;
      const yDados = await topo(page.getByRole('heading', { name: 'Dados da festa' }));
      const yArte = await topo(page.getByRole('article', { name: 'Prévia do convite' }));
      const yIA = await topo(page.getByRole('heading', { name: 'Crie uma arte com IA' }));
      assert(yDados < yArte && yArte < yIA, `ordem ${yDados} ${yArte} ${yIA}`);
      const pedido = page.getByRole('textbox', { name: 'Descreva a arte do convite' });
      assert(await pedido.isVisible(), 'Painel de IA aberto');
      for (const nome of ['Bases neutras', 'Mais modelos', 'Qualidade da imagem', 'Opções avançadas']) assert.equal(await page.getByRole('button', { name: nome }).count(), 0, nome);
      assert.equal(await page.getByText('Criar avatar').count(), 0);
      assert.equal(await page.getByText('Acesso do cliente e limites').count(), admin ? 1 : 0);

      // 2. Galeria: três linhas (9 no computador).
      await page.getByText('Imagens anteriores', { exact: true }).click();
      const selecionar = page.getByRole('button', { name: /^Selecionar imagem/ });
      assert.equal(await selecionar.count(), 9);
      await page.getByRole('button', { name: 'Próxima →' }).click();
      assert.equal(await selecionar.count(), 3);
      await page.getByRole('button', { name: '← Anterior' }).click();
      assert(await page.getByText('Usar uma arte própria').first().isVisible(), 'Envio de arte própria preservado');

      // 3. Seletor de estilo pelo teclado.
      const estilo = page.getByRole('button', { name: 'Estilo da arte' });
      assert.match(await estilo.innerText(), /Cartoon 3D/);
      await estilo.focus(); await page.keyboard.press('ArrowDown');
      await page.getByRole('listbox', { name: 'Estilo da arte' }).waitFor();
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.match(await estilo.innerText(), /Desenho 2D/);
      assert.equal(await page.getByRole('listbox', { name: 'Estilo da arte' }).count(), 0);
      await estilo.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('listbox', { name: 'Estilo da arte' }).count(), 0);

      // 4. Corretor local: botão direito sobre a palavra, sugestão aplicada só ao escolher.
      await pedido.fill('Festa de aniversario na fazenda, verde e amarelo, com um cavalo');
      await pedido.evaluate(t => t.setSelectionRange(9, 20));
      await pedido.click({ button: 'right', position: { x: 60, y: 14 } });
      const correcao = page.getByRole('dialog', { name: 'Correção de aniversario' });
      await correcao.getByRole('button', { name: 'aniversário', exact: true }).waitFor({ timeout: 20000 });
      assert.equal(await pedido.inputValue(), 'Festa de aniversario na fazenda, verde e amarelo, com um cavalo', 'Nada muda antes da escolha');
      await correcao.getByRole('button', { name: 'aniversário', exact: true }).click();
      assert.equal(await pedido.inputValue(), 'Festa de aniversário na fazenda, verde e amarelo, com um cavalo');

      // 5. Conflito com os dados da festa: nenhuma chamada.
      const gerar = page.getByRole('button', { name: 'Gerar convite completo · 1 crédito' });
      await pedido.fill('Convite da Maria 7 anos na fazenda');
      await gerar.click();
      await page.getByRole('alert').filter({ hasText: 'Confira o nome e a idade antes de gerar' }).waitFor();
      assert.equal(comandos.filter(c => c.acao === 'gerar').length, 0);
      await page.getByRole('button', { name: 'Usar dados da festa' }).click();
      assert.match(await pedido.inputValue(), /Lucas/);
      await pedido.fill('Festa na fazenda, verde e amarelo, com um cavalo');

      // 6. Foto opcional com autorização; dados alterados são salvos antes; um clique = uma geração.
      await page.getByText('Foto do aniversariante · opcional').click();
      await page.locator('details', { hasText: 'Foto do aniversariante' }).locator('input[type="file"]').first().setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: foto });
      await page.getByRole('img', { name: 'Foto de referência do aniversariante' }).waitFor();
      await page.getByLabel('Mensagem').fill('Venha para a fazenda!');
      await gerar.click();
      await page.getByRole('alert').filter({ hasText: 'Confirme a autorização' }).waitFor();
      assert.equal(comandos.filter(c => c.acao === 'gerar').length, 0);
      await page.getByLabel(/Tenho autorização para enviar esta foto/).check();
      await gerar.dblclick();
      await page.getByRole('status').filter({ hasText: 'Convite pronto' }).waitFor();
      const geracoes = comandos.filter(c => c.acao === 'gerar');
      assert.equal(geracoes.length, 1, 'Duplo clique não gera duas vezes');
      const [g] = geracoes;
      assert.equal(g.completo, true); assert.equal(g.estilo, 'cartoon2d'); assert.equal(g.autorizacaoFoto, true);
      assert.match(g.foto, /^data:image\/png;base64,/); assert.deepEqual(g.referencias, []);
      for (const campo of ['qualidade', 'modelo', 'campos', 'provedor']) assert.equal(g[campo], undefined, campo);
      const ordem = comandos.map(c => c.acao); assert.deepEqual(ordem.slice(-2), ['salvar', 'gerar'], 'Salva os dados antes da geração');
      assert.equal(dados.conteudo.mensagem, 'Venha para a fazenda!');

      // 7. Arte completa: prévia sem textos sobrepostos, download nas dimensões naturais, persistência após recarregar.
      const previa = page.getByRole('article', { name: 'Prévia do convite' });
      await previa.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Imagem no topo' }).count(), 0);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
      const arquivo = path.join(out, `${quem}-completo.png`); await (await download).saveAs(arquivo);
      const meta = await sharp(arquivo).metadata(); assert.equal(meta.width, 1024); assert.equal(meta.height, 1536);
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
      assert.equal(dados.conteudo.arteId, id(50)); assert.equal(dados.conteudo.visual.modo, 'completa');
      await page.reload(); await previa.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      await previa.screenshot({ path: path.join(out, `${quem}-previa-completa.png`) });

      // 8. Computador e celular: sem rolagem horizontal; galeria com 6 por página no celular.
      for (const [largura, porPagina] of [[1440, 9], [390, 6]]) {
        await page.setViewportSize({ width: largura, height: 1000 });
        await page.reload(); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
        await page.getByText('Imagens anteriores', { exact: true }).click();
        assert.equal(await page.getByRole('button', { name: /^Selecionar imagem/ }).count(), porPagina, `${largura}px`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sem rolagem horizontal em ${largura}px`);
        await page.screenshot({ path: path.join(out, `${quem}-${largura}.png`), fullPage: true });
      }
      assert.deepEqual(erros, []);
      resumo.push(`${quem}: ok (${comandos.length} comandos simulados, 1 geração)`);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(resumo.join('\n'));
  console.log(`Capturas: ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
