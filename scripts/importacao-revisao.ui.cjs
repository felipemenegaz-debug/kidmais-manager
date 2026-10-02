/* eslint-disable @typescript-eslint/no-require-imports */
// Importação de contrato antigo — navegação real (next dev + Edge/Chrome headless via DevTools Protocol), APIs /api/*
// simuladas, banco inacessível, nenhum segredo ou .env. Sem dependências extras (WebSocket nativo do Node 22).
// Cenários: sem demonstração automática (importação desabilitada e falha de verificação), demonstração só por escolha
// explícita; modo real: corrigir campo, "Não consta no documento", cancelar com confirmação (continuar e confirmar);
// modo demonstração: editar, "Não consta no documento", cancelar com confirmação (recusar e aceitar).
// Uso: node scripts/importacao-revisao.ui.cjs   (BROWSER_PATH aponta para msedge/chrome se não for o padrão)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORTA_APP = 3043, PORTA_CDP = 9235, origin = `http://127.0.0.1:${PORTA_APP}`;
const IMPORTACAO = '00000000-0000-4000-8000-0000000000a1', DOCUMENTO = '00000000-0000-4000-8000-0000000000d1';

function extracaoInicial() {
  return {
    fonte: 'DOCUMENTO', arquivo: { nome: 'contrato-exemplo.pdf', tipo: 'application/pdf', tamanhoBytes: 1234 },
    secoes: [
      { id: 'contratante', titulo: 'Contratante', campos: [
        { id: 'contratante.nomeCompleto', rotulo: 'Nome do contratante', valor: 'Pessoa Exemplo', estado: 'ENCONTRADO', evidencia: { pagina: 1, trecho: 'Pessoa Exemplo', conferida: true } },
        { id: 'contratante.email', rotulo: 'E-mail', valor: 'contato@example.invalid', estado: 'ENCONTRADO', evidencia: { pagina: 1, trecho: 'contato@example.invalid', conferida: true } },
        { id: 'contratante.whatsapp', rotulo: 'WhatsApp', valor: null, estado: 'NAO_ENCONTRADO', motivo: 'WhatsApp não localizado.' },
      ] },
      { id: 'evento', titulo: 'Evento', campos: [
        { id: 'evento.data', rotulo: 'Data do evento', valor: '10/10/2099', estado: 'PRECISA_REVISAO', motivo: 'Confira a data.', evidencia: { pagina: 1, trecho: 'Evento em 10/10/2099', conferida: true } },
      ] },
    ],
  };
}
const plano = { pronto: false, bloqueios: ['Confirme a data do evento.'], avisos: [], match: { estado: 'NOVO_CLIENTE', clienteId: null, candidatos: [], motivo: 'Nenhum cliente com este nome.' } };
const festaImportada = { id: IMPORTACAO, origem: 'IMPORTACAO', clienteId: DOCUMENTO, snapshot: { contratante: { nomeCompleto: 'Pessoa Exemplo' }, aniversariante: { nome: 'Aniversariante Exemplo', idadeNoEvento: 4 }, evento: { data: '2099-10-10', horarioInicio: '10:00', horarioFim: '14:00', convidados: 50, tema: 'Carros', pacote: { nome: 'Pacote original' } } }, itens: 'Itens do contrato', buffet: { itens: 'Salgados' }, observacoes: null };

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pendentes = new Map(), ouvintes = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendentes.has(msg.id)) { const { ok, fail } = pendentes.get(msg.id); pendentes.delete(msg.id); return msg.error ? fail(new Error(msg.error.message)) : ok(msg.result); }
    for (const f of ouvintes.get(msg.method) ?? []) f(msg.params);
  };
  return {
    aberto: new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; }),
    enviar: (method, params = {}) => new Promise((ok, fail) => { const n = ++seq; pendentes.set(n, { ok, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
    on: (method, f) => ouvintes.set(method, [...(ouvintes.get(method) ?? []), f]),
    fechar: () => ws.close(),
  };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assert(!fs.readdirSync('.').some((n) => n === '.env' || (n.startsWith('.env.') && n !== '.env.example')), 'Execute em worktree sem arquivos .env.');
  const navegador = process.env.BROWSER_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
  assert(navegador, 'Navegador Chromium não encontrado (defina BROWSER_PATH).');
  const out = '.local-ux/importacao-revisao'; fs.mkdirSync(out, { recursive: true });
  const gerados = ['next-env.d.ts', 'tsconfig.json'].map((p) => [p, fs.readFileSync(p)]);
  const arquivoPdf = path.resolve(out, 'contrato-exemplo.pdf');
  fs.writeFileSync(arquivoPdf, '%PDF-1.4\n% arquivo sintético de teste\n');
  const log = fs.openSync(`${out}/server.log`, 'w');
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', String(PORTA_APP)], { windowsHide: true, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: 'postgres://indisponivel.invalid:1/nenhum' }, stdio: ['ignore', log, log] });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-cdp-'));
  let browser, cliente;
  const erros = [], inesperados = [], posts = [], resultados = [];
  let modoEstado = 'habilitado';                                                   // habilitado | desabilitado | falha
  let importacao = null;
  let statusAbertura = 'EM_REVISAO';
  const dialogos = [];                                                             // mensagens de window.confirm
  let respostaConfirm = false;
  const continuar = process.env.UI_CONTINUAR_APOS_FALHA === '1';                  // só para controle negativo
  const falhas = [];
  const caso = async (nome, fn) => {
    try { await fn(); resultados.push(nome); console.log(`ok - ${nome}`); }
    catch (e) { if (!continuar) throw e; falhas.push(nome); console.log(`not ok - ${nome}: ${String(e.message).split(/\r?\n/)[0]}`); }
  };
  try {
    let pronto = false;
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${origin}/admin/login`)).ok) { pronto = true; break; } } catch { /* iniciando */ } await esperar(500); }
    assert(pronto, 'Servidor indisponível.');
    browser = spawn(navegador, ['--headless=new', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let alvo;
    for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* subindo */ } if (!alvo) await esperar(250); }
    assert(alvo, 'DevTools do navegador indisponível.');
    cliente = cdp(alvo.webSocketDebuggerUrl); await cliente.aberto;
    cliente.on('Runtime.exceptionThrown', (p) => erros.push(p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text));
    cliente.on('Page.javascriptDialogOpening', (p) => { dialogos.push(p.message); void cliente.enviar('Page.handleJavaScriptDialog', { accept: respostaConfirm }); });
    cliente.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      const json = (status, corpo) => cliente.enviar('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(corpo)).toString('base64') });
      const ok = (data) => json(200, { ok: true, data });
      try {
        if (url.pathname === '/api/admin/autenticacao') return ok({ usuarioId: '00000000-0000-4000-8000-000000000009', nome: 'Revisão visual', papel: 'REPRESENTANTE_AUTORIZADO', csrf: 'csrf-sintetico' });
        if (url.pathname === '/api/admin/festas' && p.request.method === 'GET') return ok(url.searchParams.has('importacaoId') ? { importada: festaImportada } : { festas: [], importadas: [festaImportada], elegiveis: [], capacidades: ['FESTA_CONSULTAR'], areas: [], usuarios: [] });
        if (url.pathname === '/api/admin/inteligencia/documentos' && p.request.method === 'POST') { posts.push({ url: url.pathname, corpo: 'multipart' }); return ok({ documentoId: DOCUMENTO, avisos: [] }); }
        if (url.pathname === '/api/admin/inteligencia/importacoes' && p.request.method === 'POST') {
          const corpo = JSON.parse(p.request.postData ?? '{}'); posts.push({ url: url.pathname, corpo });
          if (corpo.acao === 'estado') {
            if (modoEstado === 'falha') return cliente.enviar('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
            if (modoEstado === 'desabilitado') return ok({ habilitado: false, envioExterno: false });
            return ok({ habilitado: true, envioExterno: false });
          }
          if (corpo.acao === 'abrir') { importacao = { id: IMPORTACAO, documentoId: DOCUMENTO, versao: 1, status: statusAbertura, resultado: statusAbertura === 'IMPORTADA' ? { clienteId: DOCUMENTO, destino: `/clientes/${DOCUMENTO}`, importadoEm: '2026-10-02T12:00:00Z', pendencias: [] } : null, extracao: extracaoInicial(), revisados: [], decisaoCliente: null }; return ok({ importacao, plano: statusAbertura === 'EM_REVISAO' ? plano : null, avisos: [] }); }
          if (corpo.acao === 'ler' && corpo.importacaoId === IMPORTACAO) return ok({ importacao, plano: null });
          if (importacao?.status !== 'EM_REVISAO') return json(409, { ok: false, codigo: 'IMPORTACAO_ENCERRADA', erro: 'Esta importação já foi encerrada.' });
          if (corpo.importacaoId !== IMPORTACAO || corpo.versao !== importacao?.versao) return json(409, { ok: false, codigo: 'IMPORTACAO_DESATUALIZADA', erro: 'A revisão mudou em outra aba. Atualize a página.' });
          if (corpo.acao === 'revisar') {
            const campos = importacao.extracao.secoes.flatMap((s) => s.campos);
            const campo = campos.find((c) => c.id === corpo.campoId);
            if (!campo) return json(422, { ok: false, codigo: 'DADOS_INVALIDOS', erro: 'Campo não pode ser revisado.' });
            if (corpo.valor !== undefined) {
              const texto = String(corpo.valor).trim();
              Object.assign(campo, texto ? { valor: texto, estado: 'ENCONTRADO', motivo: undefined, evidencia: undefined, origem: 'Informado na revisão' } : { valor: null, estado: 'NAO_ENCONTRADO', motivo: 'Removido na revisão.', evidencia: undefined });
            }
            importacao = { ...importacao, versao: importacao.versao + 1 };
            return ok({ importacao, plano });
          }
          if (corpo.acao === 'descartar') { importacao = { ...importacao, versao: importacao.versao + 1, status: 'DESCARTADA' }; return ok({ importacao, plano: null }); }
          return json(400, { ok: false, erro: 'Ação não simulada.' });
        }
        inesperados.push(`${p.request.method} ${url.pathname}`);
        return json(404, { ok: false, erro: 'Não simulado.' });
      } catch { /* página fechada */ }
    });
    await cliente.enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    await cliente.enviar('Runtime.enable'); await cliente.enviar('Page.enable'); await cliente.enviar('DOM.enable');
    const avaliar = async (expr) => { const r = await cliente.enviar('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
    const aguardar = async (expr, descricao, ms = 120000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (await avaliar(expr).catch(() => false)) return; await esperar(100); } throw new Error(`Tempo esgotado: ${descricao}`); };
    const ir = (u) => cliente.enviar('Page.navigate', { url: `${origin}${u}` });
    const texto = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
    const botao = (rotulo, extra = '') => `[...document.querySelectorAll('button')].find(b => (b.textContent.trim() === ${JSON.stringify(rotulo)} || b.getAttribute('aria-label') === ${JSON.stringify(rotulo)}) && b.offsetParent !== null ${extra})`;
    const clicar = async (rotulo) => { assert.equal(await avaliar(`(() => { const b = ${botao(rotulo)}; if (!b || b.disabled) return false; b.click(); return true; })()`), true, `botão "${rotulo}"`); };
    const existeBotao = (rotulo) => avaliar(`!!(${botao(rotulo)})`);
    const digitar = (seletor, valor) => avaliar(`(() => { const i = document.querySelector(${JSON.stringify(seletor)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(valor)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const enviarArquivo = async () => {
      const { root } = await cliente.enviar('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await cliente.enviar('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
      assert(nodeId, 'campo de arquivo');
      await cliente.enviar('DOM.setFileInputFiles', { nodeId, files: [arquivoPdf] });
    };
    const posteriores = (n) => posts.slice(n).filter((x) => x.url === '/api/admin/inteligencia/importacoes' && x.corpo.acao !== 'estado').map((x) => x.corpo);
    const fotografar = async (nome) => {
      const { data } = await cliente.enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${out}/${nome}.png`, Buffer.from(data, 'base64'));
    };

    await caso('Importação desabilitada para a empresa: erro explícito, sem abrir demonstração automaticamente', async () => {
      modoEstado = 'desabilitado';
      await ir('/admin/contratos/importar');
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('não está habilitada neste ambiente'))`, 'alerta de desabilitada');
      await esperar(800);
      assert.equal(await avaliar(texto('Arraste o contrato para cá')), false, 'não abre envio (demonstração) sozinho');
      assert.equal(await existeBotao('Abrir demonstração com dados fictícios'), true);
    });

    await caso('Falha ao verificar a importação: erro explícito, sem demonstração automática', async () => {
      modoEstado = 'falha';
      await ir('/admin/contratos/importar');
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('Não foi possível concluir agora'))`, 'alerta de falha');
      await esperar(800);
      assert.equal(await avaliar(texto('Arraste o contrato para cá')), false);
    });

    await caso('Demonstração só por escolha explícita: editar, "Não consta no documento" e cancelar com confirmação', async () => {
      await clicar('Abrir demonstração com dados fictícios');
      await aguardar(texto('Arraste o contrato para cá'), 'envio da demonstração');
      await enviarArquivo();
      await aguardar(`!!(${botao('Cancelar importação')})`, 'revisão da demonstração', 60000);
      // Editar o primeiro campo editável
      const rotulo = await avaliar(`(() => { const b = ${botao('Editar')}; const dl = b?.closest('div'); return dl?.querySelector('dt')?.textContent ?? null; })()`);
      assert(rotulo, 'campo editável na demonstração');
      await clicar('Editar');
      await aguardar(`!!document.querySelector('input[aria-label="Correção de ${rotulo}"]')`, 'editor do campo');
      await digitar(`input[aria-label="Correção de ${rotulo}"]`, 'Valor corrigido na revisão');
      await clicar('Salvar correção');
      await aguardar(texto('Valor corrigido na revisão'), 'valor corrigido exibido');
      // Não consta no documento — em outro campo, para não apagar a correção acima
      const outro = await avaliar(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Não consta no documento' && x.offsetParent !== null && x.closest('div')?.querySelector('dt')?.textContent !== ${JSON.stringify(rotulo)}); if (!b) return null; const nome = b.closest('div').querySelector('dt').textContent; b.click(); return nome; })()`);
      assert(outro, 'outro campo com valor');
      await aguardar(`(() => { const d = [...document.querySelectorAll('div')].find(x => x.querySelector(':scope > dt')?.textContent === ${JSON.stringify(outro)}); return !!d && d.textContent.includes('Não localizado no contrato'); })()`, 'campo marcado como não consta');
      // Cancelar: recusar mantém a revisão; aceitar volta ao envio
      respostaConfirm = false; const d0 = dialogos.length;
      await clicar('Cancelar importação');
      await aguardar(`true`, 'confirm'); await esperar(300);
      assert.equal(dialogos.length, d0 + 1, 'confirmação exibida');
      assert.match(dialogos.at(-1), /Descartar esta revisão\? Nenhum dado será gravado\./);
      assert.equal(await existeBotao('Cancelar importação'), true, 'recusar mantém a revisão');
      assert.equal(await avaliar(texto('Valor corrigido na revisão')), true, 'a correção continua');
      respostaConfirm = true;
      await clicar('Cancelar importação');
      await aguardar(texto('Arraste o contrato para cá'), 'volta ao envio');
      respostaConfirm = false;
    });

    await caso('Modo real: corrigir campo envia a revisão e mostra o valor corrigido', async () => {
      modoEstado = 'habilitado';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio real');
      const n = posts.length;
      await enviarArquivo();
      await aguardar(texto('Pessoa Exemplo'), 'revisão real');
      assert(posts.slice(n).some((x) => x.url === '/api/admin/inteligencia/documentos'), 'documento enviado');
      assert.equal(await existeBotao('Não consta no documento'), false, 'remoção não compete com a leitura');
      assert.equal(await avaliar(`document.querySelector('details')?.open`), false, 'trecho encontrado começa recolhido');
      await avaliar(`document.querySelector('details summary').click()`);
      assert.equal(await avaliar(`document.querySelector('details')?.open`), true, 'trecho continua acessível');
      await avaliar(`document.querySelector('details summary').click()`);
      assert.equal(await avaliar(`[...document.querySelectorAll('details')].at(-1)?.open`), true, 'evidência pendente permanece visível');
      await fotografar('revisao-desktop');
      await clicar('Corrigir Nome do contratante');
      await aguardar(`!!document.querySelector('#editar-contratante\\\\.nomeCompleto')`, 'editor real');
      await digitar('#editar-contratante\\.nomeCompleto', 'Pessoa Exemplo Corrigida');
      const m = posts.length;
      await clicar('Salvar');
      await aguardar(texto('Pessoa Exemplo Corrigida'), 'valor corrigido');
      assert.deepEqual(posteriores(m), [{ acao: 'revisar', campoId: 'contratante.nomeCompleto', valor: 'Pessoa Exemplo Corrigida', importacaoId: IMPORTACAO, versao: 1 }]);
    });

    await caso('Modo real: "Não consta no documento" remove o valor (revisar com valor vazio)', async () => {
      const m = posts.length;
      const botaoDoEmail = `[...document.querySelectorAll('div')].find(d => d.querySelector(':scope > dt')?.textContent === 'E-mail')`;
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Não consta no documento')})`, 'remoção dentro da edição');
      await clicar('Cancelar');
      await aguardar(`!(${botao('Não consta no documento')})`, 'cancelar fecha edição');
      assert.deepEqual(posteriores(m), [], 'abrir e cancelar edição não salva nem remove');
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Não consta no documento')})`, 'editor reaberto');
      for (const width of [390, 320]) {
        await cliente.enviar('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
        await esperar(150);
        assert.equal(await avaliar('document.documentElement.scrollWidth <= window.innerWidth'), true, `sem rolagem horizontal a ${width}px`);
        const tamanho = await avaliar(`(${botao('Não consta no documento')}).getBoundingClientRect().height`);
        assert(tamanho <= 40 && tamanho >= 24, 'ação secundária compacta e clicável');
        await avaliar(`(${botao('Não consta no documento')}).scrollIntoView({block:'center'})`);
        await fotografar(`edicao-mobile-${width}`);
      }
      await cliente.enviar('Emulation.clearDeviceMetricsOverride');
      assert.equal(await avaliar(`(() => { const b = [...(${botaoDoEmail})?.querySelectorAll('button') ?? []].find(x => x.textContent.trim() === 'Não consta no documento'); if (!b) return false; b.click(); return true; })()`), true);
      await aguardar(`(() => { const d = ${botaoDoEmail}; return !!d && d.textContent.includes('Não localizado no contrato') && d.textContent.includes('Removido na revisão.'); })()`, 'e-mail removido');
      assert.equal(await avaliar(texto('contato@example.invalid')), false);
      assert.deepEqual(posteriores(m), [{ acao: 'revisar', campoId: 'contratante.email', valor: '', importacaoId: IMPORTACAO, versao: 2 }]);
      assert.equal(await avaliar(`[...(${botaoDoEmail})?.querySelectorAll('button') ?? []].some(x => x.textContent.trim() === 'Não consta no documento')`), false, 'sem valor, o botão some');
    });

    await caso('Modo real: cancelar pede confirmação; "Continuar revisão" preserva; "Sim, cancelar" descarta', async () => {
      const m = posts.length;
      await clicar('Cancelar importação');
      await aguardar(`document.querySelector('dialog')?.open === true`, 'diálogo aberto');
      assert.equal(await avaliar(`document.querySelector('dialog h2')?.textContent`), 'Descartar esta revisão?');
      assert.deepEqual(posteriores(m), [], 'abrir o diálogo não descarta');
      await clicar('Continuar revisão');
      await aguardar(`document.querySelector('dialog')?.open === false`, 'diálogo fechado');
      assert.equal(await avaliar(texto('Pessoa Exemplo Corrigida')), true, 'a revisão continua');
      assert.deepEqual(posteriores(m), [], 'continuar não descarta');
      await clicar('Cancelar importação');
      await aguardar(`document.querySelector('dialog')?.open === true`, 'diálogo aberto de novo');
      await clicar('Sim, cancelar importação');
      await aguardar(texto('Arraste o contrato para cá'), 'volta ao envio');
      assert.deepEqual(posteriores(m), [{ acao: 'descartar', importacaoId: IMPORTACAO, versao: 3 }]);
    });

    await caso('Reenvio de contrato importado abre resultado, sem edição nem confirmação duplicada; festa aparece em Próximas e abre detalhe', async () => {
      statusAbertura = 'IMPORTADA';
      for (let vez = 0; vez < 2; vez++) {
        await ir('/admin/contratos/importar');
        await aguardar(texto('Arraste o contrato para cá'), 'envio para recuperar resultado');
        const m = posts.length;
        await enviarArquivo();
        await aguardar(texto('Este contrato já foi importado.'), 'resultado da importação anterior');
        assert.equal(await existeBotao('Revisar importação'), false);
        assert.equal(await existeBotao('Corrigir Nome do contratante'), false);
        assert.equal(await existeBotao('Cancelar importação'), false);
        assert.deepEqual(posteriores(m), [{ acao: 'abrir', documentoId: DOCUMENTO }]);
      }
      await fotografar('contrato-ja-importado');
      await avaliar(`document.querySelector('a[href="/admin/festas?visao=proximas"]').click()`);
      await aguardar(texto('Aniversariante Exemplo — 4 anos'), 'festa importada na lista');
      assert.equal(await avaliar(`(${botao('Próximas')}).getAttribute('aria-pressed')`), 'true');
      assert.equal(await avaliar(texto('50 convidados')), true);
      await fotografar('proximas-importada');
      await avaliar(`document.querySelector('a[href="/admin/festas/importadas/${IMPORTACAO}"]').click()`);
      await aguardar(texto('Festa de contrato importado'), 'detalhe importado');
      await aguardar(texto('Itens do contrato'), 'dados confirmados no detalhe');
      assert.equal(await avaliar(texto('Carros')), true);
      await fotografar('festa-importada');
    });

    await caso('Revisão encerrada em outra aba é atualizada para resultado após tentativa de correção', async () => {
      statusAbertura = 'EM_REVISAO';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio real');
      await enviarArquivo();
      await aguardar(texto('Pessoa Exemplo'), 'revisão aberta');
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Salvar')})`, 'editor aberto');
      importacao.status = 'IMPORTADA';
      const m = posts.length;
      await clicar('Salvar');
      await aguardar(texto('Este contrato já foi importado.'), 'atualiza estado encerrado');
      assert.deepEqual(posteriores(m).map(p => p.acao), ['revisar', 'ler']);
      assert.equal(await existeBotao('Salvar'), false);
    });

    await caso('Revisão cancelada não abre editor; reenviar permite começar de novo', async () => {
      statusAbertura = 'DESCARTADA';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio');
      await enviarArquivo();
      await aguardar(texto('Esta revisão foi cancelada.'), 'cancelamento legível');
      assert.equal(await existeBotao('Revisar importação'), false);
      await clicar('Enviar contrato novamente');
      statusAbertura = 'EM_REVISAO';
      await enviarArquivo();
      await aguardar(`!!(${botao('Corrigir E-mail')})`, 'nova revisão editável');
    });

    assert.deepEqual(falhas, [], `cenários com falha: ${falhas.join(' | ')}`);
    assert.deepEqual(erros, [], `erros de página: ${erros.join(' | ')}`);
    console.log(`PASS ${resultados.length} cenários; chamadas não simuladas: ${JSON.stringify([...new Set(inesperados)])}`);
  } finally {
    try { cliente?.fechar(); } catch { /* fechado */ }
    browser?.kill(); server.kill();
    for (const [p, conteudo] of gerados) fs.writeFileSync(p, conteudo);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch { /* em uso */ }
  }
}
main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
