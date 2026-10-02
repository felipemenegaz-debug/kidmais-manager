/* eslint-disable @typescript-eslint/no-require-imports */
// Navegação real (next dev + Edge/Chrome headless via DevTools Protocol), APIs /api/* simuladas, banco inacessível.
// Sem dependências extras (WebSocket nativo do Node 22). Nenhum segredo ou .env é carregado.
// Cenários: link do Dashboard (contrato aguardando assinatura), troca entre contratos sem recarregar, voltar do
// navegador, resposta atrasada de um contrato anterior, contrato fora dos filtros da lista, contrato inacessível,
// link inválido e cada item da Agenda de hoje abrindo sua festa.
// Uso: node scripts/contratos-selecao-url.ui.cjs   (BROWSER_PATH aponta para msedge/chrome se não for o padrão)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORTA_APP = 3041, PORTA_CDP = 9233, origin = `http://127.0.0.1:${PORTA_APP}`;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(0xa1), B = id(0xb2), C = id(0xc3), D = id(0xd4), E = id(0xe5); // A/B na lista; C fora do filtro (cancelado); D inacessível; E aguardando assinatura fora da lista
const VA = id(0xa9), VB = id(0xb9), VC = id(0xc9), VE = id(0xe9);
const F1 = id(0xf1), F2 = id(0xf2);
const nomes = { [A]: 'Cliente Aguardando Assinatura', [B]: 'Cliente Segundo Contrato', [C]: 'Cliente Fora do Filtro', [E]: 'Cliente Aguardando Fora da Lista' };
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const snapshot = (nome) => ({
  contratante: { nomeCompleto: nome, email: 'contato@example.invalid' },
  aniversariante: { nome: 'Aniversariante Exemplo', idadeNoEvento: 5, temaFesta: 'Exemplo' },
  evento: { data: '2099-10-10', horarioInicio: '17:00', horarioFim: '21:00', pacote: { nome: 'Premium', codigo: 'PREMIUM' }, convidados: 50 },
  comercial: { valorFinalContrato: 1000, formaPagamentoPretendida: 'PIX_AVISTA' },
  contratacao: { adicionais: [], buffet: {} },
});
const painel = (contratoId, versaoId, status) => ({
  contrato: { id: contratoId, status, fechamento_id: id(0xe0), versao_atual: 1 },
  fluxo: { versao_vigente_id: status === 'ASSINADO' ? versaoId : null, versao_em_preparacao_id: status === 'ASSINADO' ? null : versaoId },
  versoes: [{ id: versaoId, numero_versao: 1, status: 'ATIVA', estado_edicao: status === 'ASSINADO' ? 'CONCLUIDA' : 'EM_ELABORACAO', revisao: 1, origem_versao_id: null, snapshot: snapshot(nomes[contratoId]), dados_fonte: null, criado_em: '2026-10-01T12:00:00Z', documento_revisado_id: null, motivo_nova_versao: null, gerado_por_usuario_id: null, alteracoes: null }],
  documentos: [], assinaturas: [], revisoesOperacionais: [], financeiro: [], pendencias: [],
});
const itemLista = (contratoId, status) => ({ id: contratoId, fechamento_id: id(0xe0), status, nome: nomes[contratoId], data_evento: '2099-10-10', pacote: 'Premium', convidados: '50' });
const festaDash = (festaId, contratoId, versaoId, cliente) => ({ id: festaId, contratoId, versaoId, data: hoje, cliente, pacote: 'Premium', convidados: 50, status: 'ASSINADO', hora: '17:00:00' });
const dashboard = {
  empresa: 'Empresa de Exemplo', hoje,
  numeros: { recebidoMesCentavos: 0, aReceberCentavos: 0, aPagarCentavos: 0, emAtrasoCentavos: 0, saldoPrevistoCentavos: 0 },
  agenda: [festaDash(F1, B, VB, 'Festa Agenda Um'), festaDash(F2, C, VC, 'Festa Agenda Dois')],
  proximas: [festaDash(F1, B, VB, 'Festa Agenda Um'), festaDash(F2, C, VC, 'Festa Agenda Dois')],
  atencao: [
    { tom: 'aviso', titulo: 'Contrato aguardando assinatura', detalhe: nomes[A], href: `/admin/contratos?contratoId=${A}&versaoId=${VA}#documentacao` },
    { tom: 'aviso', titulo: 'Contrato aguardando assinatura', detalhe: nomes[E], href: `/admin/contratos?contratoId=${E}&versaoId=${VE}#documentacao` },
  ],
  contratosPendentes: 1, festasProximas: 2, realizadas: 0, futuras: 2, ticketCentavos: 0, pacote: 'Premium',
};
const festaApi = (festaId, contratoId, nome) => ({
  festa: { id: festaId, contrato_id: contratoId, revisao: 1, invalidada_em: null, versao_contratual_criacao_id: id(0xee) },
  contrato: { id: contratoId, versao_id: id(0xee), status: 'ASSINADO', snapshot: snapshot(nome) },
  versoes: [], itens: { tarefas: [], pendencias: [], solicitacoes: [], registros: [], contagens: [] }, capacidades: [], areas: [], usuarios: [],
  contagens: {}, financeiro: null, buffet: null, cancelamento: null, nascimentoCrm: null, contratacaoAnterior: null,
});

// ---- Cliente CDP mínimo ----------------------------------------------------------------------------------------
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
  const out = '.local-ux/contratos-selecao-url'; fs.mkdirSync(out, { recursive: true });
  const gerados = ['next-env.d.ts', 'tsconfig.json'].map((p) => [p, fs.readFileSync(p)]);
  const log = fs.openSync(`${out}/server.log`, 'w');
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', String(PORTA_APP)], { windowsHide: true, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: 'postgres://indisponivel.invalid:1/nenhum' }, stdio: ['ignore', log, log] });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-cdp-'));
  let browser, cliente;
  const erros = [], inesperados = [], pedidosDetalhe = [], pedidosFesta = [], resultados = [];
  const atrasos = new Map();                                                     // contratoId → ms de atraso do detalhe
  const continuar = process.env.UI_CONTINUAR_APOS_FALHA === '1';                  // só para controle negativo
  const falhas = [];
  const caso = async (nome, fn) => {
    try { await fn(); resultados.push(`ok - ${nome}`); console.log(`ok - ${nome}`); }
    catch (e) { if (!continuar) throw e; falhas.push(nome); console.log(`not ok - ${nome}: ${e.message.split(/\r?\n/)[0]}`); }
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
    cliente.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      const json = (status, corpo) => cliente.enviar('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(corpo)).toString('base64') });
      const ok = (data) => json(200, { ok: true, data });
      try {
        if (url.origin !== origin) { inesperados.push(url.origin); return cliente.enviar('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); }
        if (url.pathname === '/api/admin/autenticacao') return ok({ usuarioId: id(9), nome: 'Revisão visual', papel: 'REPRESENTANTE_AUTORIZADO', csrf: 'csrf-sintetico' });
        if (url.pathname === '/api/admin/dashboard') return ok(dashboard);
        if (url.pathname === '/api/admin/contratos/painel') {
          const cid = url.searchParams.get('contratoId');
          if (!cid) return ok(url.searchParams.get('incluirCancelados') === '1' ? [itemLista(A, 'AGUARDANDO_ASSINATURA'), itemLista(B, 'ASSINADO'), itemLista(C, 'CANCELADO')] : [itemLista(A, 'AGUARDANDO_ASSINATURA'), itemLista(B, 'ASSINADO')]);
          pedidosDetalhe.push(cid);
          await esperar(atrasos.get(cid) ?? 50);
          if (cid === A) return ok(painel(A, VA, 'AGUARDANDO_ASSINATURA'));
          if (cid === B) return ok(painel(B, VB, 'ASSINADO'));
          if (cid === C) return ok(painel(C, VC, 'CANCELADO'));
          if (cid === E) return ok(painel(E, VE, 'AGUARDANDO_ASSINATURA'));
          return json(404, { ok: false, codigo: 'NAO_ENCONTRADO', erro: 'Contrato não encontrado.' });
        }
        if (url.pathname === '/api/admin/festas' && url.searchParams.get('id')) {
          const fid = url.searchParams.get('id'); pedidosFesta.push(fid);
          if (fid === F1) return ok(festaApi(F1, B, 'Festa Agenda Um'));
          if (fid === F2) return ok(festaApi(F2, C, 'Festa Agenda Dois'));
          return json(404, { ok: false, erro: 'Festa não encontrada.' });
        }
        inesperados.push(`${p.request.method} ${url.pathname}`);
        return json(404, { ok: false, erro: 'Não simulado.' });
      } catch { /* página fechada */ }
    });
    await cliente.enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    await cliente.enviar('Runtime.enable'); await cliente.enviar('Page.enable');
    const avaliar = async (expr) => { const r = await cliente.enviar('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
    const aguardar = async (expr, descricao, ms = 120000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (await avaliar(expr).catch(() => false)) return; await esperar(100); } throw new Error(`Tempo esgotado: ${descricao}`); };
    const ir = async (url) => { await cliente.enviar('Page.navigate', { url: `${origin}${url}` }); };
    const url = () => avaliar('location.pathname + location.search');
    const titulo = (nome) => `[...document.querySelectorAll('h1,h2,h3')].some(h => h.textContent.trim() === ${JSON.stringify(nome)})`;
    const clicarLink = (texto) => avaliar(`(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.includes(${JSON.stringify(texto)}) && x.offsetParent !== null); if (!a) return false; a.click(); return true; })()`);
    const selecionado = () => avaliar(`document.querySelector('select[aria-label="Contrato"]')?.value ?? null`);
    const escolher = (valor) => avaliar(`(() => { const s = document.querySelector('select[aria-label="Contrato"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(valor)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const alerta = () => avaliar(`[...document.querySelectorAll('[role="alert"]')].map(e => e.textContent.trim()).join(' | ')`);

    await caso('Dashboard: "Contrato aguardando assinatura" abre e seleciona o contrato do link', async () => {
      await ir('/admin/dashboard');
      await aguardar(`[...document.querySelectorAll('a')].some(a => a.textContent.includes('Contrato aguardando assinatura'))`, 'card de atenção');
      assert.equal(await clicarLink('Contrato aguardando assinatura'), true);
      await aguardar(titulo(nomes[A]), 'contrato A aberto');
      assert.equal(await selecionado(), A);
      assert.match(await url(), new RegExp(`contratoId=${A}`));
    });

    await caso('Dashboard: card de contrato aguardando assinatura que não está na lista abre e seleciona o contrato', async () => {
      await ir('/admin/dashboard');
      await aguardar(`[...document.querySelectorAll('a')].some(a => a.textContent.includes(${JSON.stringify(nomes[E])}))`, 'card do contrato E');
      assert.equal(await clicarLink(nomes[E]), true);
      await aguardar(titulo(nomes[E]), 'contrato E aberto', 15000);
      assert.equal(await selecionado(), E);
      await ir('/admin/dashboard');
      await aguardar(`[...document.querySelectorAll('a')].some(a => a.textContent.includes(${JSON.stringify(nomes[A])}))`, 'card do contrato A');
      assert.equal(await clicarLink(nomes[A]), true);
      await aguardar(titulo(nomes[A]), 'contrato A aberto');
    });

    await caso('Troca entre contratos sem recarregar: o seletor muda a URL e carrega o novo contrato', async () => {
      await avaliar('window.__semRecarga = true');
      await escolher(B);
      await aguardar(titulo(nomes[B]), 'contrato B aberto');
      assert.equal(await selecionado(), B);
      assert.match(await url(), new RegExp(`contratoId=${B}`));
      assert.doesNotMatch(await url(), /versaoId=/, 'a versão do contrato anterior não acompanha a troca');
      assert.equal(await avaliar('window.__semRecarga === true'), true, 'a página não recarregou');
    });

    await caso('Voltar do navegador (mudança de contratoId na URL, mesma tela) volta a selecionar o contrato anterior', async () => {
      await avaliar('history.back()');
      await aguardar(titulo(nomes[A]), 'contrato A de novo');
      assert.equal(await selecionado(), A);
      assert.equal(await avaliar('window.__semRecarga === true'), true, 'a página não recarregou');
    });

    await caso('Resposta atrasada: o contrato clicado antes não substitui o último escolhido', async () => {
      await escolher(B);                                                            // ponto de partida: B carregado
      await aguardar(titulo(nomes[B]), 'contrato B aberto');
      atrasos.set(A, 2500);
      const antes = pedidosDetalhe.length;
      await escolher(A);                                                            // pedido lento (A)…
      await aguardar(`location.search.includes(${JSON.stringify(A)})`, 'URL de A');
      await esperar(200);
      await escolher(B);                                                            // …e logo depois o rápido (B)
      await aguardar(titulo(nomes[B]), 'contrato B aberto de novo');
      await esperar(3200);                                                          // a resposta atrasada de A chega aqui
      assert.equal(await avaliar(titulo(nomes[A])), false, 'contrato A não pode reaparecer');
      assert.equal(await avaliar(titulo(nomes[B])), true);
      assert.equal(await selecionado(), B);
      assert(pedidosDetalhe.slice(antes).includes(A), 'o pedido lento de A foi feito');
      atrasos.clear();
    });

    await caso('Contrato fora dos filtros da lista (ex.: cancelado) abre pelo link e aparece no seletor', async () => {
      await ir(`/admin/contratos?contratoId=${C}`);
      await aguardar(titulo(nomes[C]), 'contrato C aberto');
      assert.equal(await selecionado(), C);
      const opcao = await avaliar(`[...document.querySelectorAll('select[aria-label="Contrato"] option')].find(o => o.value === ${JSON.stringify(C)})?.textContent ?? ''`);
      assert.match(opcao, /fora dos filtros da lista/);
      assert.equal(await alerta(), '');
    });

    await caso('Contrato inexistente ou de outra empresa: mensagem clara e nenhum contrato selecionado', async () => {
      await ir(`/admin/contratos?contratoId=${D}`);
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('não encontrado nesta empresa'))`, 'mensagem de inacessível');
      assert.equal(await selecionado(), '');
      for (const nome of Object.values(nomes)) assert.equal(await avaliar(titulo(nome)), false);
    });

    await caso('Link com contratoId inválido: mensagem clara, sem chamada ao detalhe', async () => {
      const antes = pedidosDetalhe.length;
      await ir('/admin/contratos?contratoId=nao-e-uuid');
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('link do contrato é inválido'))`, 'mensagem de link inválido');
      await esperar(500);
      assert.equal(pedidosDetalhe.length, antes);
    });

    await caso('Agenda de hoje: cada item abre a sua festa', async () => {
      for (const [festaId, nome] of [[F1, 'Festa Agenda Um'], [F2, 'Festa Agenda Dois']]) {
        await ir('/admin/dashboard');
        await aguardar(`[...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/admin/festas/${festaId}')`, 'item da agenda');
        const hrefs = await avaliar(`[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Agenda de hoje')?.querySelectorAll('a[href^="/admin/festas/"]').length ?? 0`);
        assert.equal(hrefs, 2, 'os dois itens da agenda apontam para /admin/festas/{id}');
        const antes = pedidosFesta.length;
        assert.equal(await avaliar(`(() => { const sec = [...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Agenda de hoje'); const a = sec?.querySelector('a[href="/admin/festas/${festaId}"]'); if (!a) return false; a.click(); return true; })()`), true);
        await aguardar(`location.pathname === '/admin/festas/${festaId}'`, 'rota da festa');
        await aguardar(titulo(nome), `festa ${nome} aberta`);
        assert.deepEqual(pedidosFesta.slice(antes).filter((x, i, l) => l.indexOf(x) === i), [festaId], 'a API foi consultada só para a festa clicada');
      }
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
