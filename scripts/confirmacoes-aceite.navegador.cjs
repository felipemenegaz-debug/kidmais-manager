/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const ts = require('typescript');
const sharp = require('sharp');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origem = 'http://127.0.0.1:3427';
const saida = process.env.KIDMAIS_EVIDENCIA_DIR || '.local-ux/confirmacoes-aceite';
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const id = uuid(1), versaoId = uuid(2), pdfId = uuid(3);
let navegador, servidor;
async function iniciarServidor() {
  if (servidor) return;
  assert(fs.existsSync('.next/BUILD_ID'), 'Faça o build de produção antes do roteiro.');
  assert(!fs.readdirSync('.').some(f => /^\.env(?:$|\.(?:production|local)(?:\.local)?$)/.test(f)), 'Use um clone sem configuração real.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|temp|tmp|userprofile|appdata|localappdata|comspec|pathext)$/i.test(k)));
  servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3427'], {
    windowsHide: true, env: { ...env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', KIDMAIS_PREVIEW_UX: '1',
      AGENDA_PUBLICA_EMPRESA_ID: uuid(8), DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/sintetico' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stderr.pipe(process.stderr);
  await new Promise((resolve, reject) => {
    const prazo = setTimeout(() => reject(Error('Servidor local demorou para iniciar.')), 30000);
    servidor.once('exit', codigo => { clearTimeout(prazo); reject(Error('Servidor encerrou com código ' + codigo)); });
    servidor.once('error', erro => { clearTimeout(prazo); reject(erro); });
    servidor.stdout.on('data', dados => {
      if (dados.toString().includes('Ready')) { clearTimeout(prazo); resolve(); }
    });
  });
}
before(async () => {
  fs.mkdirSync(saida, { recursive: true });
  navegador = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  try { await navegador?.close(); }
  finally {
    if (servidor && servidor.exitCode === null && !servidor.signalCode) {
      const encerrado = once(servidor, 'exit');
      servidor.kill();
      await encerrado;
    }
  }
});

test('janela isolada distingue cancelar, entrada vazia e valor inicial; bloqueia reentrada', async () => {
  const pagina = await navegador.newPage();
  try {
    await pagina.setContent('<button id="origem">Editar</button>');
    const codigo = ts.transpileModule(fs.readFileSync('components/JanelaConfirmacao.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await pagina.addScriptTag({content: 'var exports = {};\n' + codigo});
    await pagina.locator('#origem').focus();
    await pagina.evaluate(() => { window.resposta = exports.dialogo.perguntar('Continuar', 'Motivo', 'Valor inicial'); });
    const campo = pagina.getByRole('textbox', { name: 'Motivo' });
    assert.equal(await campo.inputValue(), 'Valor inicial');
    assert.equal(await pagina.evaluate(() => exports.dialogo.confirmar('Excluir', 'Outro pedido')), false);
    await campo.fill('');
    await pagina.getByRole('button', { name: 'Continuar' }).click();
    assert.equal(await pagina.evaluate(() => window.resposta), '');
    assert.equal(await pagina.evaluate(() => document.activeElement.id), 'origem');
    await pagina.evaluate(() => {
      const origem = document.getElementById('origem');
      origem.blur();
      origem.onclick = evento => { window.resposta = exports.dialogo.perguntar('Continuar', 'Motivo', '', evento.currentTarget); };
      if (document.activeElement === origem) throw Error('O clique precisa começar sem foco no botão.');
      origem.click();
    });
    await pagina.keyboard.press('Escape');
    assert.equal(await pagina.evaluate(() => window.resposta), null);
    assert.equal(await pagina.evaluate(() => document.activeElement.id), 'origem');
  } finally { await pagina.close(); }
});

for (const width of [375, 1440]) test('contrato e revisão do PDF em ' + width + ' px', async () => {
  await iniciarServidor();
  const ctx = await navegador.newContext({ viewport: { width, height: width === 375 ? 812 : 960 }, serviceWorkers: 'block' });
  try {
    const pagina = await ctx.newPage();
    const nativos = [], erros = [], gravacoes = [];
    pagina.on('dialog', async d => { nativos.push(d.type()); await d.dismiss(); });
    pagina.on('pageerror', e => erros.push(e.message));
    const pdf = await ctx.newPage();
    async function documento(titulo) {
      await pdf.setContent('<h1>' + titulo + '</h1><p>Buffet Aurora · Documento fictício para conferência visual.</p>');
      return pdf.pdf();
    }
    const resumo = await documento('Resumo comercial'), oficial = await documento('Contrato oficial');
    await pdf.close();
    let envioIndisponivel = true, revisado = false, aceitePermitido = true, documentoPdfHash = 'pdf';
    const aceites = [];
    const marca = width === 375 ? {kidmais: false, nome: 'Buffet Aurora'} : {kidmais: true, nome: 'Kidmais'};
    const canal = { canal: 'EMAIL', destinoMascarado: 'a***@example.invalid' };
    const evento = { data: '2099-09-30', horarioInicio: '17:00', horarioFim: '21:00', pacote: 'Premium', aniversariante: 'Cris Exemplo', valorFinalContrato: 9800 };
    const snapshot = { contratante: { nomeCompleto: 'Cliente Exemplo' }, aniversariante: { nome: evento.aniversariante, idadeNoEvento: 7 }, evento: { ...evento, pacote: { nome: 'Premium', codigo: 'PREMIUM' }, convidados: 70 }, comercial: { valorFinalContrato: 9800 }, contratacao: { adicionais: [], buffet: {} } };
    const versao = { id: versaoId, numero_versao: 1, revisao: 3, status: 'ATIVA', estado_edicao: 'EM_ELABORACAO', snapshot, dados_fonte: null };
    await ctx.route(/^https?:\/\//, async route => {
      const u = new URL(route.request().url());
      if (u.origin !== origem) return route.abort();
      if (!u.pathname.startsWith('/api/')) return route.continue();
      const ok = data => route.fulfill({ json: { ok: true, data } });
      switch (u.pathname) {
        case '/api/admin/autenticacao': return ok({ usuarioId: uuid(9), sessaoId: 'local', nome: 'Gestão', papel: 'REPRESENTANTE_AUTORIZADO', contexto: { empresaAtual: {id: uuid(8), nome: 'Buffet Aurora', papel: 'REPRESENTANTE_AUTORIZADO'}, empresas: [], gestaoNaEmpresa: true, selecaoNecessaria: false }, csrf: 'simulado' });
        case '/api/admin/contratos/painel': return ok({ contrato: { id, status: 'AGUARDANDO_ASSINATURA' }, fluxo: { versao_em_preparacao_id: versaoId }, versoes: [{ ...versao, documento_revisado_id: revisado ? pdfId : null }], documentos: [{ id: pdfId, contrato_versao_id: versaoId, categoria: 'CONTRATO', revisao: 3 }], assinaturas: [], revisoesOperacionais: [], financeiro: [], pendencias: [] });
        case '/api/admin/contratos/versoes/' + versaoId:
          gravacoes.push(route.request().postDataJSON());
          revisado = true;
          return ok({ versaoId });
        case '/api/contratos/' + id + '/acesso': return ok({ canais: [canal] });
        case '/api/contratos/' + id + '/identidade/iniciar':
          if (envioIndisponivel) { envioIndisponivel = false; return route.fulfill({status: 503, json: {erro: 'Envio do código indisponível.'}}); }
          return ok({ ...canal, validacaoId: 'local', acessoToken: 'local' });
        case '/api/identidade/confirmar-codigo': return route.fulfill({ json: { provaToken: 'simulada' } });
        case '/api/contratos/' + id + '/contexto': return ok({ contrato: {id, status: 'AGUARDANDO_ASSINATURA'}, evento, marca, versao: {id: versaoId, numero: 1, status: 'ATIVA', snapshotHash: 'snapshot', documentoPdfHash, contratoOficial: {disponivel: true, homologadoParaProducao: true}}, aceitePermitido });
        case '/api/contratos/' + id + '/resumo': return route.fulfill({contentType:'application/pdf', body: resumo});
        case '/api/contratos/' + id + '/pdf': return route.fulfill({contentType:'application/pdf', body: oficial});
        case '/api/contratos/' + id + '/aceite': aceites.push(route.request().postDataJSON()); return ok({});
        default: return route.fulfill({status: 404, json: {ok: false}});
      }
    });
    async function foto(nome, alvo) {
      if (alvo) await alvo.scrollIntoViewIfNeeded();
      assert(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await pagina.screenshot({path: path.join(saida, width + '-' + nome + '.png')});
    }
    const botao = nome => pagina.getByRole('button', {name: nome, exact: true});
    const marcaPlataforma = pagina.getByRole('img', { name: 'iA.Fest', exact: true });
    const logoBuffet = pagina.getByAltText('Kidmais', { exact: true });
    const logoCabecalho = pagina.locator('main header img');
    const nomeBuffet = nome => pagina.getByText(nome, { exact: true });
    async function conferirMarcaAntesDaProva() {
      assert(await marcaPlataforma.isVisible());
      assert.equal(await logoCabecalho.count(), 1, 'somente o logotipo iA.Fest');
      assert.equal(await logoBuffet.count(), 0);
      for (const nome of ['Buffet Aurora', 'Kidmais']) {
        assert(!new RegExp(nome, 'i').test(await pagina.locator('main').innerText()), `nome do buffet antes da prova: ${nome}`);
      }
    }
    async function provarIdentidade(capturar = false) {
      await pagina.goto(origem + '/contrato/' + id);
      await pagina.getByLabel('CPF ou CNPJ do contratante').fill('00000000000');
      await conferirMarcaAntesDaProva();
      if (capturar) await foto('identidade');
      await botao('Continuar').click();
      await botao('Enviar código').waitFor();
      await conferirMarcaAntesDaProva();
      if (capturar) await foto('canal');
      if (envioIndisponivel) {
        await botao('Enviar código').click();
        await pagina.getByRole('alert').filter({hasText:'Tente enviar o código novamente'}).waitFor();
        await conferirMarcaAntesDaProva();
        if (capturar) await foto('erro-envio');
      }
      await botao('Enviar código').click();
      await pagina.getByLabel('Código de validação').fill('000000');
      await conferirMarcaAntesDaProva();
      if (capturar) await foto('codigo');
      await botao('Abrir documentos').click();
      await (marca.kidmais ? logoBuffet : nomeBuffet(marca.nome)).waitFor();
    }
    const assinar = botao('Aceitar e assinar eletronicamente');
    const declaracao = pagina.getByRole('checkbox');
    const abrirOficial = () => pagina.getByRole('button', {name: /2\. Contrato Oficial/}).click();
    async function exigirAceiteBloqueado(motivo) {
      assert(await assinar.isDisabled(), motivo);
      await assinar.evaluate(botao => botao.click());
      assert.equal(aceites.length, 0, motivo);
    }
    aceitePermitido = false;
    await provarIdentidade();
    await abrirOficial();
    await declaracao.check();
    await exigirAceiteBloqueado('a permissão é obrigatória mesmo com o contrato aberto e a declaração marcada');

    aceitePermitido = true;
    documentoPdfHash = null;
    await provarIdentidade();
    await abrirOficial();
    await declaracao.check();
    await pagina.getByText(/PDF desta versão está sem o código de verificação/).waitFor();
    await exigirAceiteBloqueado('o PDF precisa ter um código de verificação');

    documentoPdfHash = 'pdf';
    envioIndisponivel = true;
    await provarIdentidade(true);
    await foto('resumo');
    await declaracao.check();
    await exigirAceiteBloqueado('marcar a declaração sem abrir o contrato não libera o aceite');
    await declaracao.uncheck();
    await abrirOficial();
    await exigirAceiteBloqueado('abrir o contrato sem marcar a declaração não libera o aceite');
    const leitor = pagina.getByTitle('Contrato Oficial');
    await leitor.scrollIntoViewIfNeeded();
    assert.equal(await leitor.evaluate(async frame => (await (await fetch(frame.src)).text()).slice(0, 5)), '%PDF-');
    // O leitor do Chrome pinta o PDF em outro processo após o load do iframe.
    // A página sintética é branca, enquanto o leitor ainda vazio é cinza.
    let renderizado = false;
    for (let tentativa = 0; tentativa < 30 && !renderizado; tentativa++) {
      const amostra = await sharp(await leitor.screenshot()).resize(1, 1).raw().toBuffer();
      renderizado = amostra[0] > 145 && amostra[1] > 145 && amostra[2] > 145;
      if (!renderizado) await pagina.waitForTimeout(200);
    }
    assert(renderizado, 'O leitor deve pintar o PDF antes da captura.');
    await foto('contrato-oficial', leitor);
    await declaracao.check();
    assert(await assinar.isEnabled());
    await foto('aceite', assinar);
    await assinar.evaluate(botao => { botao.click(); botao.click(); });
    await pagina.getByText('✓ Aceite registrado com sucesso').waitFor();
    assert.deepEqual(aceites, [{ provaToken: 'simulada', acessoToken: 'local', versaoId, snapshotHash: 'snapshot', documentoPdfHash: 'pdf' }]);
    await pagina.goto(origem + '/preview-ux/contratos-perfil?tela=contratos&contratoId=' + id);
    const abrir = botao('Confirmar revisão do PDF');
    await abrir.click();
    const modal = pagina.getByRole('dialog', {name: 'Confirmar revisão do PDF'});
    assert.equal(await pagina.evaluate(() => document.activeElement.textContent), 'Voltar');
    await pagina.keyboard.press('Shift+Tab');
    assert.equal(await pagina.evaluate(() => document.activeElement.textContent), 'Confirmar revisão do PDF');
    await pagina.keyboard.press('Tab');
    assert.equal(await pagina.evaluate(() => document.activeElement.textContent), 'Voltar');
    await pagina.keyboard.press('Escape');
    assert.equal(gravacoes.length, 0);
    await abrir.click();
    const texto = await modal.innerText();
    for (const esperado of [/Cliente Exemplo/, /2099/, /Premium/, /9\.800,00/, /Versão 1 · Revisão 3/, /Confirmo que revisei o PDF/]) assert.match(texto, esperado);
    assert(!texto.includes(pdfId));
    await foto('revisao-pdf', modal);
    await modal.getByRole('button', {name:'Confirmar revisão do PDF'}).evaluate(b => { b.click(); b.click(); });
    await modal.waitFor({state:'detached'});
    assert.deepEqual(gravacoes, [{acao:'revisar', revisao:3, documentoId:pdfId}]);
    assert.deepEqual(nativos, []);
    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});
