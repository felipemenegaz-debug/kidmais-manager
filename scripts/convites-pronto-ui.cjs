/* eslint-disable @typescript-eslint/no-require-imports */
// "Convite pronto" (imagem própria já montada): só servidor local e API simulada, sem IA nem créditos.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/convite-pronto'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;
const token = 'p'.repeat(43);

(async () => {
  // Arte "montada" já reduzida como o servidor guarda (até 1400 px, WebP): o download deve manter essas dimensões.
  const montada = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#1b1f5c' } }).webp({ quality: 85 }).toBuffer();
  const upload = path.join(out, 'convite-montado.png');
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#1b1f5c' } }).png().toFile(upload);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];
  try {
    for (const admin of [true, false]) {
      const quem = admin ? 'buffet' : 'cliente';
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      // IA desligada e sem cota: Convite pronto não depende de geração nem de crédito.
      const dados = { conteudo: { tema: 'celebrar', nome: 'Felipe', idade: '41 anos', mensagem: 'Venha comemorar comigo!', data: '2027-03-03', horario: '17:00', local: 'Kidmais Asa Norte', endereco: 'Asa Norte · Brasília', arteId: null, confirmarPresenca: true },
        revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${token}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
        disponiveis: 0, iaDisponivel: false, completoDisponivel: false, geracaoIncerta: false, podeRecuperarGeracao: admin, geracoesPendentes: [], decisoesRecuperacao: [],
        cotas: admin ? { festa: 3, festaUsado: 3, cliente: 2, clienteUsado: 2, empresa: 60, empresaUsado: 60 } : { festa: 3, festaUsado: 3, cliente: 2, clienteUsado: 2 },
        artes: [], respostas: [], historico: [] };
      let publicado = null; const comandos = [], respostas = [], erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data;
        if (url.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null };
        else if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        // AdminShell de staging (assistente da agenda): buffet já configurado, nenhuma unidade pendente.
        else if (url.pathname === '/api/admin/configuracoes/agenda' && url.searchParams.get('pendentes') === '1') data = { instalada: true, pendentes: [] };
        else if (url.pathname === `/api/convites/publico/${token}`) {
          if (!publicado) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Convite indisponível.' }) });
          if (url.searchParams.get('arte') === '1') return route.fulfill({ contentType: 'image/webp', body: montada });
          if (request.method() === 'POST') { respostas.push(request.postDataJSON()); data = { salvo: true }; }
          else data = { conteudo: publicado, familia: null };
        } else if (['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) {
          if (request.method() === 'POST') {
            const b = request.postDataJSON(); comandos.push(b);
            assert(['upload', 'salvar', 'publicar', 'excluir_arte'].includes(b.acao), `Ação inesperada: ${b.acao}`);
            if (b.acao === 'upload') {
              assert.match(b.imagem, /^data:image\/png;base64,/);
              dados.artes = [{ id: id(200), origem: 'UPLOAD', completo: false, url: dataUrl(montada, 'image/webp') }, ...dados.artes]; data = { arteId: id(200) };
            } else if (b.acao === 'excluir_arte') {
              // Mesma regra do servidor: sem imagem, "completa" volta a "modelo" no rascunho persistido.
              assert.equal(b.revisao, dados.revisao); dados.artes = dados.artes.filter(a => a.id !== b.arteId);
              if (dados.conteudo.arteId === b.arteId) dados.conteudo = { ...dados.conteudo, arteId: null, ...(dados.conteudo.visual?.modo === 'completa' ? { visual: { ...dados.conteudo.visual, modo: 'modelo' } } : {}) };
              dados.revisao++; data = { excluida: true };
            } else { assert.equal(b.revisao, dados.revisao); dados.conteudo = b.conteudo; dados.revisao++; if (b.acao === 'publicar') { dados.publicado = true; publicado = b.conteudo; } data = { salvo: true }; }
          } else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      const editor = admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`;
      await page.goto(editor); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      const previa = page.getByRole('article', { name: 'Prévia do convite' });
      const grupo = page.getByRole('group', { name: 'Posição da imagem' });
      const botao = nome => grupo.getByRole('button', { name: nome, exact: true });
      const marcado = async () => { const r = []; for (const n of ['Imagem como fundo', 'Imagem no topo', 'Convite pronto']) if (await botao(n).getAttribute('aria-pressed') === 'true') r.push(n); return r; };
      assert.equal(await grupo.count(), 0, 'sem imagem não há seletor');

      // 1. Enviar a arte própria: dica do Convite pronto; composição começa em "fundo" (comportamento atual).
      const envio = page.getByLabel('Usar uma arte própria');
      assert(await envio.count() >= 1, 'campo de envio da arte própria');
      await envio.first().setInputFiles(upload);
      await page.getByRole('status').filter({ hasText: 'Convite pronto' }).waitFor({ timeout: 10000 }).catch(async e => {
        console.error('comandos:', comandos.map(c => c.acao), 'alertas:', await page.getByRole('alert').allTextContents(), 'status:', await page.getByRole('status').allTextContents());
        throw e;
      });
      await grupo.waitFor();
      assert.deepEqual(await marcado(), ['Imagem como fundo']);
      assert.equal(await previa.locator('svg').count(), 1, 'fundo: modelo SVG com os textos sobre a imagem');
      await previa.screenshot({ path: path.join(out, `${quem}-1-fundo.png`) });

      // 2. Convite pronto: só a imagem, sem SVG nem texto visível; dados acessíveis e aviso de conferência.
      await botao('Convite pronto').click();
      assert.deepEqual(await marcado(), ['Convite pronto']);
      await previa.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      assert.equal(await previa.locator('svg').count(), 0);
      const acessivel = previa.locator('h2');
      assert.equal(await acessivel.textContent(), 'Felipe');
      const caixa = await acessivel.evaluate(e => { const r = e.parentElement.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert(caixa.w <= 1 && caixa.h <= 1, `texto só para leitor de tela (${JSON.stringify(caixa)})`);
      const aviso = page.locator('[data-conferencia-convite]');
      assert.match(await aviso.textContent(), /3 de março às 17:00, Kidmais Asa Norte/);
      await page.getByLabel('Local da festa', { exact: true }).fill('Kidmais Lago Sul');
      assert.match(await aviso.textContent(), /Kidmais Lago Sul/);
      assert.equal(await previa.getByText('Kidmais Lago Sul').count(), 1, 'texto acessível acompanha a edição');
      await page.getByLabel('Local da festa', { exact: true }).fill('Kidmais Asa Norte');
      await previa.screenshot({ path: path.join(out, `${quem}-2-pronto.png`) });

      // 3. Voltar e ir pelo teclado; um único item marcado de cada vez.
      await botao('Imagem no topo').focus(); await page.keyboard.press('Enter');
      assert.deepEqual(await marcado(), ['Imagem no topo']); assert.equal(await aviso.count(), 0);
      await botao('Convite pronto').focus(); await page.keyboard.press('Space');
      assert.deepEqual(await marcado(), ['Convite pronto']);

      // 4. Salvar e recarregar: modo persistido sem "posicao"; reclicar a mesma imagem não desfaz.
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
      assert.equal(dados.conteudo.visual.modo, 'completa'); assert.equal(dados.conteudo.visual.posicao, undefined); assert.equal(dados.conteudo.arteId, id(200));
      await page.reload(); await grupo.waitFor();
      assert.deepEqual(await marcado(), ['Convite pronto']);
      await page.getByText('Imagens anteriores', { exact: true }).click();
      await page.getByRole('button', { name: 'Selecionar imagem 1', exact: true }).click();
      assert.deepEqual(await marcado(), ['Convite pronto']);
      assert.equal(await page.getByText('Alterações não salvas').count(), 0, 'reclicar não altera o rascunho');

      // 5. Baixar: a própria imagem armazenada, nas dimensões dela.
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
      const arquivo = path.join(out, `${quem}-download.png`); await (await download).saveAs(arquivo);
      const meta = await sharp(arquivo).metadata(); assert.equal(meta.width, 900); assert.equal(meta.height, 1200);

      // 6. Publicar e abrir a página pública: imagem sem sobreposição, RSVP funcionando.
      await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
      assert.equal(publicado.visual.modo, 'completa');
      const pub = await context.newPage(); pub.on('pageerror', e => erros.push(e.message));
      await pub.goto(`${base}/convite/${token}`);
      const arte = pub.getByRole('region', { name: 'Convite da festa' });
      await arte.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      assert.equal(await arte.locator('svg').count(), 0);
      await pub.getByLabel('Seu nome', { exact: false }).first().fill('Convidado Teste');
      await pub.getByRole('button', { name: 'Enviar resposta', exact: true }).click();
      await pub.getByText(/Resposta salva/).waitFor();
      assert.equal(respostas.length, 1);
      await pub.screenshot({ path: path.join(out, `${quem}-6-publico.png`), fullPage: true });
      await pub.close();

      // 7. Despublicado não interessa aqui; excluir a imagem selecionada e recarregar SEM salvar: volta à composição.
      publicado = null; dados.publicado = false;
      await page.reload(); await grupo.waitFor();
      await page.getByText('Imagens anteriores', { exact: true }).click();
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar exclusão', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Imagem excluída' }).waitFor();
      assert.equal(await grupo.count(), 0);
      await page.reload(); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      assert.equal(dados.conteudo.arteId, null); assert.equal(dados.conteudo.visual.modo, 'modelo');
      assert.equal(await grupo.count(), 0); assert.equal(await previa.getByRole('img', { name: 'Arte escolhida para o convite' }).count(), 0);

      assert(!comandos.some(c => c.acao === 'gerar'), 'nenhuma geração');
      assert.deepEqual(erros, []);
      resumo.push(`${quem}: ok (${comandos.map(c => c.acao).join(', ')})`);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(resumo.join('\n'));
  console.log(`Capturas: ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
