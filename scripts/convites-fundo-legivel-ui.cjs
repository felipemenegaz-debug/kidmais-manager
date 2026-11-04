/* eslint-disable @typescript-eslint/no-require-imports */
// E-CP2 "Imagem como fundo" legível: faixa translúcida e sem textos de exemplo. Só servidor local e API simulada.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/fundo-legivel'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;
const token = 'f'.repeat(43);
const exemplos = ['Nome do aniversariante', 'Um dia muito especial', 'Data da festa', '00:00', 'Local da festa', 'Endereço do evento'];

/** Foto clara e movimentada: listras e quadrados de cores claras e escuras. */
async function fotoMovimentada(tipo) {
  const w = 900, h = 1200, px = Buffer.alloc(w * h * 3), cores = [[255, 255, 255], [250, 220, 60], [30, 30, 30], [120, 200, 255], [255, 120, 180]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = cores[(Math.floor(x / 37) + Math.floor(y / 53) * 3) % cores.length]; px.set(c, (y * w + x) * 3); }
  const img = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  return tipo === 'png' ? img.png().toBuffer() : img.webp({ quality: 85 }).toBuffer();
}
const lisa = cor => sharp({ create: { width: 900, height: 1200, channels: 3, background: cor } }).png().toBuffer();

function montar(browser, { admin, conteudo, artes, publicadoInicial = null }) {
  const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
  const estado = { publicado: publicadoInicial, comandos: [], respostas: [], erros: [], arteServida: null };
  const dados = { conteudo, revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${token}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
    disponiveis: 0, iaDisponivel: false, completoDisponivel: false, geracaoIncerta: false, podeRecuperarGeracao: admin, geracoesPendentes: [], decisoesRecuperacao: [],
    cotas: { festa: 3, festaUsado: 3, cliente: 2, clienteUsado: 2 }, artes, respostas: [], historico: [] };
  estado.dados = dados;
  return browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true }).then(async context => {
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
        if (!estado.publicado) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Convite indisponível.' }) });
        if (url.searchParams.get('arte') === '1') return route.fulfill({ contentType: 'image/webp', body: estado.arteServida });
        if (request.method() === 'POST') { estado.respostas.push(request.postDataJSON()); data = { salvo: true }; }
        else data = { conteudo: estado.publicado, familia: null };
      } else if (['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) {
        if (request.method() === 'POST') {
          const b = request.postDataJSON(); estado.comandos.push(b);
          assert(['upload', 'salvar', 'publicar'].includes(b.acao), `Ação inesperada: ${b.acao}`);
          if (b.acao === 'upload') {
            assert.match(b.imagem, /^data:image\/png;base64,/);
            dados.artes = [{ id: id(200), origem: 'UPLOAD', completo: false, url: dataUrl(estado.uploadServido, 'image/webp') }, ...dados.artes]; data = { arteId: id(200) };
          } else { assert.equal(b.revisao, dados.revisao); dados.conteudo = b.conteudo; dados.revisao++; if (b.acao === 'publicar') { dados.publicado = true; estado.publicado = b.conteudo; } data = { salvo: true }; }
        } else data = dados;
      } else { estado.erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    });
    return { context, estado };
  });
}
const editorUrl = admin => admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`;
async function textoDoSvg(loc) { return loc.locator('svg').first().evaluate(s => [...s.querySelectorAll('text')].map(t => t.textContent)); }
async function faixa(loc) { return loc.locator('svg rect[fill-opacity]').evaluateAll(rs => rs.map(r => ({ fill: r.getAttribute('fill'), alfa: r.getAttribute('fill-opacity') }))); }
async function baixar(page, arquivo) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
  await (await download).saveAs(arquivo);
  return arquivo;
}

(async () => {
  const movimentadaPng = await fotoMovimentada('png'), movimentadaWebp = await fotoMovimentada('webp');
  const upload = path.join(out, 'foto-movimentada.png'); fs.writeFileSync(upload, movimentadaPng);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];
  try {
    // A. Fluxo completo, buffet e cliente: idade vazia (o único exemplo que chegava ao público).
    for (const admin of [true, false]) {
      const quem = admin ? 'buffet' : 'cliente';
      const conteudo = { tema: 'celebrar', nome: 'Felipe', idade: '', mensagem: 'Venha comemorar comigo!', data: '2027-03-03', horario: '17:00', local: 'Kidmais Asa Norte', endereco: 'Asa Norte · Brasília', arteId: null, confirmarPresenca: true };
      const { context, estado } = await montar(browser, { admin, conteudo, artes: [] });
      estado.uploadServido = movimentadaWebp; estado.arteServida = movimentadaWebp;
      const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
      await page.goto(editorUrl(admin)); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      const previa = page.getByRole('article', { name: 'Prévia do convite' });
      const grupo = page.getByRole('group', { name: 'Posição da imagem' });
      const botao = nome => grupo.getByRole('button', { name: nome, exact: true });

      await page.getByLabel('Usar uma arte própria').first().setInputFiles(upload);
      await grupo.waitFor();
      assert.equal(await botao('Imagem como fundo').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await faixa(previa), [{ fill: '#fff3df', alfa: '0.8' }], 'fundo: uma faixa na cor do tema');
      const textos = await textoDoSvg(previa);
      for (const ex of exemplos) assert(!textos.includes(ex), `exemplo sobre a foto: ${ex}`);
      assert(textos.includes('Felipe') && textos.includes('3 de março · 17:00'));
      await previa.screenshot({ path: path.join(out, `${quem}-1-fundo.png`) });

      // Topo e Convite pronto: sem faixa.
      await botao('Imagem no topo').click();
      assert.deepEqual(await faixa(previa), []);
      assert((await textoDoSvg(previa)).includes('Um dia muito especial'), 'topo segue o modelo atual (byte a byte)');
      await botao('Convite pronto').click();
      assert.equal(await previa.locator('svg').count(), 0);
      await botao('Imagem como fundo').click();
      assert.equal((await faixa(previa)).length, 1);

      // Download do fundo: PNG 1080×1440 com a faixa.
      const png = await baixar(page, path.join(out, `${quem}-download.png`));
      const meta = await sharp(png).metadata(); assert.equal(meta.width, 1080); assert.equal(meta.height, 1440);

      // Publicar → página pública com a faixa, sem exemplo e com RSVP.
      await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
      assert.equal(estado.publicado.idade, '');
      const pub = await context.newPage(); pub.on('pageerror', e => estado.erros.push(e.message));
      await pub.goto(`${base}/convite/${token}`);
      const arte = pub.getByRole('region', { name: 'Convite da festa' });
      await arte.locator('svg').waitFor();
      assert.deepEqual(await faixa(arte), [{ fill: '#fff3df', alfa: '0.8' }]);
      const textosPub = await textoDoSvg(arte);
      for (const ex of exemplos) assert(!textosPub.includes(ex), `exemplo no público: ${ex}`);
      await pub.getByLabel('Seu nome', { exact: false }).first().fill('Convidado Teste');
      await pub.getByRole('button', { name: 'Enviar resposta', exact: true }).click();
      await pub.getByText(/Resposta salva/).waitFor();
      assert.equal(estado.respostas.length, 1);
      await arte.screenshot({ path: path.join(out, `${quem}-2-publico.png`) });
      await pub.close();
      assert(!estado.comandos.some(c => c.acao === 'gerar'));
      assert.deepEqual(estado.erros, []);
      resumo.push(`${quem}: ok (${estado.comandos.map(c => c.acao).join(', ')})`);
      await context.close();
    }

    // B. Fronteira no PNG: cores próprias #777777/#000000 → alfa 0,98 (0,80 daria outro pixel).
    for (const [nomeFoto, cor, esperado] of [['branca', '#ffffff', .98 * 119 + .02 * 255], ['preta', '#000000', .98 * 119]]) {
      const foto = await lisa(cor);
      const conteudo = { tema: 'celebrar', nome: 'Ana', idade: '5 anos', mensagem: '', data: '2027-04-20', horario: '15:00', local: 'Buffet', endereco: 'Rua das Flores', arteId: id(300), confirmarPresenca: true,
        visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, cores: { fundo: '#777777', tinta: '#000000', destaque: '#aa3300' } } };
      const { context, estado } = await montar(browser, { admin: true, conteudo, artes: [{ id: id(300), origem: 'UPLOAD', completo: false, url: dataUrl(foto, 'image/png') }] });
      const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
      await page.goto(editorUrl(true)); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      const previa = page.getByRole('article', { name: 'Prévia do convite' });
      await previa.locator('svg').waitFor();
      // O pixel do PNG é conferido ANTES do atributo: um SVG com opacidade errada tem de cair pelo próprio PNG.
      const png = await baixar(page, path.join(out, `fronteira-${nomeFoto}.png`));
      // x=140 fica dentro da faixa (120–960) e fora da área de texto (170–910); y no meio do conjunto.
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const amostra = [600, 800, 1000].map(y => data[(y * info.width + 140) * info.channels]);
      for (const v of amostra) assert(Math.abs(v - esperado) <= 2, `foto ${nomeFoto}: pixel ${v}, esperado ${esperado.toFixed(1)} (alfa 0,98)`);
      assert.deepEqual(await faixa(previa), [{ fill: '#777777', alfa: '0.98' }]);
      assert.deepEqual(estado.erros, []);
      resumo.push(`fronteira ${nomeFoto}: ok (pixels ${amostra.join('/')}, esperado ${esperado.toFixed(1)})`);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(resumo.join('\n'));
  console.log(`Capturas: ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
