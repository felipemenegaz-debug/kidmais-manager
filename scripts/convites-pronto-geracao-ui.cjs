/* eslint-disable @typescript-eslint/no-require-imports */
// "Convite pronto" × caminhos automáticos da geração (conclusão imediata, recuperação após recarga, pedido de
// outra pessoa) e laboratório local. Só servidor local e API simulada: nenhuma geração real é enviada.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/convite-pronto-geracao'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;
const cor = async c => dataUrl(await sharp({ create: { width: 300, height: 400, channels: 3, background: c } }).webp().toBuffer(), 'image/webp');

(async () => {
  const urls = { 200: await cor('#1b1f5c'), 201: await cor('#5c1b2a'), 202: await cor('#1b5c33'), 203: await cor('#5c4d1b') };
  const arte = n => ({ id: id(n), origem: n === 200 ? 'UPLOAD' : 'IA', completo: false, url: urls[n] });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];
  try {
    for (const admin of [true, false]) {
      const quem = admin ? 'buffet' : 'cliente';
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const pronto = { modo: 'completa', ajuste: 'conter', x: 50, y: 50 };
      const dados = { id: id(1), conteudo: { tema: 'celebrar', nome: 'Felipe', idade: '41 anos', mensagem: 'Venha!', data: '2027-03-03', horario: '17:00', local: 'Kidmais Asa Norte', endereco: 'Asa Norte', arteId: id(200), confirmarPresenca: true, visual: pronto },
        revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
        disponiveis: 3, iaDisponivel: true, completoDisponivel: false, geracaoIncerta: false, geracaoEmAndamento: null, podeRecuperarGeracao: admin, geracoesPendentes: [], decisoesRecuperacao: [],
        cotas: admin ? { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0, empresa: 60, empresaUsado: 0 } : { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 },
        artes: [arte(200)], respostas: [], historico: [] };
      // Roteiro do servidor simulado por cenário: o que "gerar" responde e o que cada consulta ?geracao= devolve.
      // esperada: a única chave que o servidor conhece; qualquer outra consulta recebe 404 e fica registrada.
      const cenario = { gerar: null, consultas: [], esperada: null };
      const comandos = [], erros = [], pendentes = [], consultadas = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data;
        if (url.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null };
        else if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        else if (['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) {
          const geracao = url.searchParams.get('geracao');
          if (request.method() === 'POST') {
            const b = request.postDataJSON(); comandos.push(b);
            assert(['salvar', 'gerar'].includes(b.acao), `Ação inesperada: ${b.acao}`);
            if (b.acao === 'gerar') {
              assert.equal(b.completo, undefined, 'geração simples');
              const r = cenario.gerar(b);
              if (r === 'pendurar') { pendentes.push(route); return; } // resposta nunca chega: a aba é recarregada
              data = r;
            } else { assert.equal(b.revisao, dados.revisao); dados.conteudo = b.conteudo; dados.revisao++; data = { salvo: true }; }
          } else if (geracao) {
            consultadas.push(geracao);
            if (geracao !== cenario.esperada) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Pedido não encontrado.' }) });
            const r = cenario.consultas.shift();
            if (!r) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Pedido não encontrado.' }) });
            data = typeof r === 'function' ? r(geracao) : r;
          } else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      const editor = admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`;
      const previa = page.getByRole('article', { name: 'Prévia do convite' });
      const grupo = page.getByRole('group', { name: 'Posição da imagem' });
      const marcado = async () => { const r = []; for (const n of ['Imagem como fundo', 'Imagem no topo', 'Convite pronto']) { const b = grupo.getByRole('button', { name: n, exact: true }); if (await b.count() && await b.getAttribute('aria-pressed') === 'true') r.push(n); } return r; };
      const imagemDaPrevia = async () => {
        const img = previa.getByRole('img', { name: 'Arte escolhida para o convite' });
        if (await img.count()) return img.getAttribute('src');
        return previa.locator('svg image').first().getAttribute('href');
      };
      const local = page.getByLabel('Local da festa', { exact: true });
      const pedido = page.getByRole('textbox', { name: 'Descreva a arte do convite' });
      const gerar = page.getByRole('button', { name: 'Gerar arte · 1 crédito', exact: true });
      const status = texto => page.getByRole('status').filter({ hasText: texto });

      await page.goto(editor); await grupo.waitFor();
      assert.deepEqual(await marcado(), ['Convite pronto']);

      // A. Conclusão imediata devolvendo a MESMA arte já selecionada: composição e campo não salvo preservados.
      await local.fill('Salão novo (não salvo)');
      cenario.gerar = () => ({ chave: 'x', estado: 'CONCLUIDA', arteId: id(200) });
      await pedido.fill('Festa no espaço, azul e roxo, com foguetes');
      await gerar.click(); await status('Confira a arte e publique').waitFor();
      assert.deepEqual(await marcado(), ['Convite pronto'], 'A: mesma arte não desfaz Convite pronto');
      assert.equal(await local.inputValue(), 'Salão novo (não salvo)', 'A: campo local preservado');
      assert.equal(await imagemDaPrevia(), urls[200]);
      assert.equal(dados.conteudo.local, 'Kidmais Asa Norte', 'A: nada salvo sem o usuário');

      // B. Conclusão imediata com arte NOVA comum: seleciona a nova, volta à composição, campo local preservado.
      cenario.gerar = () => { dados.artes = [arte(201), ...dados.artes]; return { chave: 'y', estado: 'CONCLUIDA', arteId: id(201) }; };
      await pedido.fill('Festa no espaço, vermelho, com foguetes');
      await gerar.click(); await status('Confira a arte e publique').waitFor();
      assert.deepEqual(await marcado(), ['Imagem como fundo'], 'B: arte nova comum volta à composição');
      assert.equal(await imagemDaPrevia(), urls[201]);
      assert.equal(await local.inputValue(), 'Salão novo (não salvo)', 'B: campo local preservado');
      await previa.screenshot({ path: path.join(out, `${quem}-B-nova.png`) });

      // C. Recuperação após recarga: pedido guardado na aba, resposta perdida; após recarregar, a consulta conclui
      //    com a arte já selecionada no rascunho salvo (Convite pronto) e a composição é preservada.
      await local.fill('Kidmais Asa Norte');
      await page.getByText('Imagens anteriores', { exact: true }).click();
      await page.getByRole('button', { name: 'Selecionar imagem 2', exact: true }).click(); // id(200), a imagem enviada
      await grupo.getByRole('button', { name: 'Convite pronto', exact: true }).click();
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await status('Rascunho salvo').waitFor();
      assert.equal(dados.conteudo.arteId, id(200)); assert.equal(dados.conteudo.visual.modo, 'completa');
      // Recarga com o POST pendente: a chave do POST, a guardada na aba e a consultada após recarregar são a mesma.
      const recuperar = async (rotulo, consultas) => {
        cenario.gerar = () => 'pendurar';
        const enviosAntes = comandos.filter(c => c.acao === 'gerar').length, pendentesAntes = pendentes.length;
        await gerar.click(); await status('Gerando sua arte').waitFor();
        for (let i = 0; i < 100 && pendentes.length === pendentesAntes; i++) await page.waitForTimeout(50);
        assert.equal(pendentes.length, pendentesAntes + 1, `${rotulo}: POST chegou ao servidor e ficou sem resposta antes da recarga`);
        assert.equal(comandos.filter(c => c.acao === 'gerar').length, enviosAntes + 1);
        const enviado = comandos.filter(c => c.acao === 'gerar').at(-1).chave;
        const guardada = await page.evaluate(k => JSON.parse(sessionStorage.getItem(k) || 'null')?.chave, `convite-pedido:${id(1)}`);
        assert(enviado && guardada === enviado, `${rotulo}: chave guardada na aba = chave do POST pendente`);
        cenario.esperada = enviado; cenario.consultas = consultas(enviado); consultadas.length = 0;
        await page.reload(); await grupo.waitFor();
        await page.waitForFunction(() => !document.body.innerText.includes('Gerando sua arte'), null, { timeout: 20000 });
        assert.equal(cenario.consultas.length, 0, `${rotulo}: acompanhou até concluir`);
        assert(consultadas.length >= 1 && consultadas.every(c => c === enviado), `${rotulo}: após recarregar só consultou a chave do POST (${consultadas.join(',')})`);
        assert.equal(comandos.filter(c => c.acao === 'gerar').length, enviosAntes + 1, `${rotulo}: nenhum reenvio após recarregar`);
        assert.equal(await page.evaluate(k => sessionStorage.getItem(k), `convite-pedido:${id(1)}`), null, `${rotulo}: pedido esquecido ao concluir`);
        cenario.esperada = null;
      };
      await pedido.fill('Festa no espaço, verde, com foguetes');
      await recuperar('C', chave => [{ chave, estado: 'EM_ANDAMENTO' }, { chave, estado: 'CONCLUIDA', arteId: id(200) }]);
      assert.deepEqual(await marcado(), ['Convite pronto'], 'C: recuperação com a mesma arte preserva Convite pronto');
      assert.equal(await imagemDaPrevia(), urls[200]);

      // C2. Recuperação concluindo com arte NOVA: seleciona a nova e volta à composição.
      await pedido.fill('Festa no espaço, dourado, com foguetes');
      await recuperar('C2', chave => [() => { dados.artes = [arte(202), ...dados.artes]; return { chave, estado: 'CONCLUIDA', arteId: id(202) }; }]);
      assert.equal(await imagemDaPrevia(), urls[202]); assert.deepEqual(await marcado(), ['Imagem como fundo']);

      // D. Pedido de OUTRA pessoa em andamento ao abrir: só acompanha; prévia, composição e campo local intactos.
      await page.getByText('Imagens anteriores', { exact: true }).click();
      await page.getByRole('button', { name: /^Selecionar imagem/ }).last().click(); // id(200)
      await grupo.getByRole('button', { name: 'Convite pronto', exact: true }).click();
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await status('Rascunho salvo').waitFor();
      dados.geracaoEmAndamento = 'chave-de-outra-pessoa'; cenario.esperada = 'chave-de-outra-pessoa'; consultadas.length = 0;
      cenario.consultas = [{ chave: 'chave-de-outra-pessoa', estado: 'EM_ANDAMENTO' },
        () => { dados.artes = [arte(203), ...dados.artes]; dados.geracaoEmAndamento = null; return { chave: 'chave-de-outra-pessoa', estado: 'CONCLUIDA', arteId: id(203) }; }];
      await page.reload(); await grupo.waitFor();
      await status('Gerando sua arte').waitFor();
      await local.fill('Editado durante a geração alheia');
      await status('A arte gerada já está nas imagens da festa').waitFor({ timeout: 20000 });
      assert.deepEqual(await marcado(), ['Convite pronto'], 'D: composição intacta');
      assert.equal(await imagemDaPrevia(), urls[200], 'D: prévia intacta');
      assert.equal(await local.inputValue(), 'Editado durante a geração alheia', 'D: campo local preservado');
      assert(consultadas.length >= 2 && consultadas.every(c => c === 'chave-de-outra-pessoa'), 'D: só acompanhou a chave da outra pessoa');
      assert.equal(comandos.filter(c => c.acao === 'gerar').length, 4, 'D: nenhum envio de geração');
      // A arte alheia aparece na galeria RENDERIZADA, sem ser selecionada; a do convite continua a única selecionada.
      const galeria = page.locator('details', { hasText: 'Imagens anteriores' }).last();
      if (!await galeria.evaluate(d => d.open)) await galeria.locator('summary').first().click();
      const itens = galeria.getByRole('button', { name: /^Selecionar imagem/ });
      await itens.first().waitFor();
      const fontes = await itens.evaluateAll(bs => bs.map(b => ({ src: b.querySelector('img')?.getAttribute('src'), marcado: b.getAttribute('aria-pressed') })));
      const alheia = fontes.find(x => x.src === urls[203]), escolhida = fontes.find(x => x.src === urls[200]);
      assert(alheia, 'D: arte alheia exibida na galeria'); assert.equal(alheia.marcado, 'false', 'D: arte alheia não selecionada');
      assert.equal(escolhida?.marcado, 'true', 'D: a imagem do convite continua a selecionada');
      assert.equal(fontes.filter(x => x.marcado === 'true').length, 1, 'D: uma única imagem selecionada');
      await previa.screenshot({ path: path.join(out, `${quem}-D-alheia.png`) });

      for (const r of pendentes) await r.abort().catch(() => undefined);
      assert.deepEqual(erros, []);
      resumo.push(`${quem}: caminhos automáticos ok (${comandos.filter(c => c.acao === 'gerar').length} envios de geração, nenhum reenvio)`);
      await context.close();
    }

    // E. Laboratório local: fundo/topo disponíveis e preservados para arte comum; sem "Convite pronto".
    {
      const dados = { laboratorioLocal: true, conteudo: { tema: 'celebrar', nome: 'Felipe', idade: '41 anos', mensagem: '', data: '2027-03-03', horario: '17:00', local: 'Kidmais', endereco: 'Asa Norte', arteId: id(200), confirmarPresenca: true },
        revisao: 1, publicado: false, desatualizado: false, linkPublico: '', clienteHabilitado: false, familias: [], disponiveis: 3, iaDisponivel: true, completoDisponivel: false,
        geradoresLocais: [], trabalhosLocais: [], cotas: { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 }, artes: [arte(200)], respostas: [], historico: [] };
      const erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let data;
        if (url.pathname === '/api/convites/cliente') {
          if (request.method() === 'POST') { const b = request.postDataJSON(); assert.equal(b.acao, 'salvar'); dados.conteudo = b.conteudo; dados.revisao++; data = { salvo: true }; }
          else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      await page.goto(`${base}/convites/criar#${'a'.repeat(43)}`);
      const grupo = page.getByRole('group', { name: 'Posição da imagem' }); await grupo.waitFor();
      assert.deepEqual(await grupo.getByRole('button').allTextContents(), ['Imagem como fundo', 'Imagem no topo'], 'E: sem Convite pronto no laboratório');
      await grupo.getByRole('button', { name: 'Imagem no topo', exact: true }).click();
      assert.equal(await grupo.getByRole('button', { name: 'Imagem no topo', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
      assert.equal(dados.conteudo.visual.posicao, 'topo'); assert.equal(dados.conteudo.visual.modo, 'modelo');
      await page.reload(); await grupo.waitFor();
      assert.equal(await grupo.getByRole('button', { name: 'Imagem no topo', exact: true }).getAttribute('aria-pressed'), 'true', 'E: topo preservado ao recarregar');
      assert.equal(await page.getByText('Convite pronto', { exact: true }).count(), 0);
      await page.screenshot({ path: path.join(out, 'laboratorio.png') });
      assert.deepEqual(erros, []);
      resumo.push('laboratório: ok (fundo/topo, sem Convite pronto, topo preservado)');
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(resumo.join('\n'));
  console.log(`Capturas: ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
