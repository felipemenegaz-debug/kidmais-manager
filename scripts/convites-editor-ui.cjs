/* eslint-disable @typescript-eslint/no-require-imports */
// Navegador local, todas as APIs interceptadas. Não usa sessão, banco ou imagens reais.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3058';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const png = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#798cc7' } }).png().toBuffer();
  const arte = n => ({ id: id(n), origem: 'UPLOAD', url: `data:image/png;base64,${png.toString('base64')}` });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const admin of [true, false]) {
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Demonstração', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Demonstração' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const dados = { conteudo: { tema: 'jardim', nome: 'Alice Sofia', idade: '5 anos', mensagem: 'Venha comemorar com a gente!', data: '2099-12-20', horario: '16:00', local: 'Jardim das Festas', endereco: 'Rua das Flores, 120', arteId: id(10), confirmarPresenca: true }, revisao: 1, publicado: true, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: true, disponiveis: 3, iaDisponivel: false, cotas: { festa: 3, festaUsado: 0, cliente: 3, clienteUsado: 0, empresa: 60, empresaUsado: 0 }, artes: [arte(10), arte(11)], respostas: [], historico: [] };
      let publicada = id(11); const comandos = [], erros = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.route('**/api/**', async route => {
        const r = route.request(), url = new URL(r.url()); let data;
        if (url.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-sintetico', nome: 'Equipe de teste', contexto, comercial: null };
        else if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
        else if (url.pathname === (admin ? '/api/admin/convites' : '/api/convites/cliente')) {
          if (!admin) assert.equal(r.headers().authorization, `Bearer ${'a'.repeat(43)}`);
          if (r.method() === 'POST') {
            const b = r.postDataJSON(); comandos.push(b);
            if (b.acao === 'excluir_arte') {
              assert.equal(b.revisao, dados.revisao);
              if (b.arteId === publicada) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Esta imagem está no convite publicado. Remova ou substitua a imagem e publique a alteração antes de excluí-la da galeria.' }) });
              dados.artes = dados.artes.filter(a => a.id !== b.arteId);
              if (dados.conteudo.arteId === b.arteId) dados.conteudo = { ...dados.conteudo, arteId: null };
              dados.revisao++; data = { excluida: true };
            } else if (b.acao === 'upload') { dados.artes.push(arte(12)); data = { arteId: id(12) }; }
            else { dados.conteudo = b.conteudo; dados.revisao++; if (b.acao === 'publicar') publicada = b.conteudo.arteId; data = { salvo: true }; }
          } else data = dados;
        } else { erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      const page = await context.newPage(); page.on('pageerror', e => erros.push(e.message));
      await page.goto(admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
      await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      if (admin) {
        await page.getByRole('heading', { name: 'Convite da festa', exact: true }).waitFor();
        assert.equal(await page.locator('main[data-editor="buffet"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(9, 13, 27)');
        assert((await page.getByRole('button', { name: 'Publicar convite', exact: true }).evaluate(el => getComputedStyle(el).backgroundImage)).includes('linear-gradient'));
      }
      await page.screenshot({ path: path.join(out, `editor-${admin ? 'buffet' : 'cliente'}-galeria-desktop.png`), fullPage: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Sem overflow em ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, `editor-${admin ? 'buffet' : 'cliente'}-galeria-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Texto ainda não salvo');
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      const modal = page.getByRole('dialog', { name: 'Excluir imagem da galeria?' });
      await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
      assert.equal(comandos.length, 0, 'Cancelar exclusão não envia escrita');
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      await modal.getByRole('button', { name: 'Confirmar exclusão' }).click();
      await modal.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('img', { name: 'Arte escolhida para o convite' }).count(), 0, 'Exclusão limpa a prévia');
      assert.equal(await page.getByLabel('Nome do aniversariante', { exact: true }).inputValue(), 'Texto ainda não salvo', 'Preserva edição pendente');
      assert.equal(dados.conteudo.nome, 'Alice Sofia', 'Não salva outros campos implicitamente');
      assert.equal(dados.artes.length, 1);
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      await modal.getByRole('button', { name: 'Confirmar exclusão' }).click();
      await modal.getByRole('alert').waitFor();
      assert.equal(dados.artes.length, 1, 'Arte publicada continua disponível');
      await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await page.getByRole('button', { name: 'Selecionar imagem 1' }).click();
      await page.getByRole('button', { name: 'Remover imagem do convite', exact: true }).click();
      assert.equal(dados.artes.length, 1, 'Remover da composição não exclui arquivo');
      await page.getByRole('button', { name: 'Publicar convite', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      await modal.getByRole('button', { name: 'Confirmar exclusão' }).click();
      await modal.waitFor({ state: 'hidden' });
      assert.equal(dados.artes.length, 0);
      await page.locator('input[type="file"]').setInputFiles({ name: 'arte-teste.png', mimeType: 'image/png', buffer: png });
      await page.getByRole('button', { name: 'Selecionar imagem 1' }).waitFor();
      await page.getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      await page.getByText('Crie uma arte com IA', { exact: false }).click();
      await page.getByRole('button', { name: 'Usar arte como referência' }).click();
      await page.getByRole('button', { name: 'Excluir imagem 1', exact: true }).click();
      await modal.getByRole('button', { name: 'Confirmar exclusão' }).click();
      await modal.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Usar arte como referência' }).count(), 0);
      await page.reload(); await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Excluir imagem/ }).count(), 0, 'Exclusão permanece ao recarregar');
      assert.deepEqual(erros, []);
      await context.close();
    }
    console.log(JSON.stringify({ ok: true, cenarios: ['buffet no tema Manager', 'cliente preservado', 'galeria desktop/celular', 'cancelar exclusão', 'excluir arte selecionada', 'preservar edição pendente', 'bloquear imagem publicada', 'remover sem excluir', 'publicar e excluir', 'upload e exclusão', 'referências limpas', 'persistência ao recarregar'], screenshots: out }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
