import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';

// Executa os handlers reais do componente com hooks/transportes sintéticos.
// Nenhum SDK externo, credencial, servidor ou banco é usado neste teste.
const ROTA_CONFERIR = '/api/admin/configuracoes/whatsapp/tentativa/conferir';
const ROTA_CONFIGURACAO = '/api/admin/configuracoes/whatsapp';
const ROTA_DEMO = ROTA_CONFIGURACAO + '/demo-ativos';
const ROTA_DESCONECTAR = ROTA_CONFIGURACAO + '/desconectar';
function montar({ expiraEm = new Date(Date.now() + 60_000).toISOString(), reauthOk = true, reautenticar, iniciar, login, eventName = 'FINISH', inicial, relogio, concluirPendente = false, semJanela = false, consulta, conferir, concluirResposta, semSdk = false, montagemReal = false, verificarDemo, desconectar } = {}) {
  const slots = [], listeners = new Set(), chamadas = [], corpos = [], janelas = [];
  let consultas = 0, conferencias = 0, reautenticacoes = 0, popupBloqueado = semJanela;
  const estadoInicial = inicial ?? { estado: 'NAO_CONFIGURADA', metaConfigurada: true, conexao: null, tentativa: null };
  let resolverConcluir = null;
  let cursor = 0, gesto = false, chamadasLogin = 0, sdkInicializado = false;
  // r7: efeitos do primeiro render (para desmontar) e scripts do SDK criados pela tela.
  const efeitos = [], scripts = [];
  let primeiroRender = true;
  const window = {
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    // Janela sintética da Meta: o SDK real abre o popup com window.open dentro do FB.login.
    open() { const janela = { closed: false, close() { janela.closed = true; } }; janela.top = janela; janelas.push(janela); return janela; },
    FB: undefined,
  };
  const fb = {
    init() { sdkInicializado = true; },
    login(callback) {
        assert.equal(gesto, true, 'FB.login precisa ocorrer durante o clique, antes de qualquer await');
        assert.equal(sdkInicializado, true, 'FB.init precisa preceder o login');
        chamadasLogin++;
        if (!popupBloqueado) window.open('https://www.facebook.com/dialog/oauth');
        login?.(callback);
      },
  };
  if (!semSdk) window.FB = fb;
  const document = {
    getElementById: (id) => scripts.find((script) => script.id === id && !script.removido) ?? null,
    createElement() { const script = { ouvintes: [], addEventListener(_, fn) { script.ouvintes.push(fn); }, remove() { script.removido = true; } }; return script; },
    head: { appendChild: (script) => { scripts.push(script); } },
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = index === 0 && !montagemReal
        ? estadoInicial
        : initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback) => callback,
    useEffect(fn) { if (primeiroRender) efeitos.push(fn); },
  };
  const http = {
    reautenticarSessao() {
      reautenticacoes++;
      if (reautenticar) return reautenticar();
      return Promise.resolve({ ok: reauthOk, erro: 'Senha inválida.' });
    },
    async adminFetch(url, init) {
      chamadas.push(url);
      if (init?.body) corpos.push(JSON.parse(init.body));
      if (concluirResposta && url.endsWith('/concluir')) return concluirResposta(init);
      if (iniciar && url.endsWith('/iniciar')) {
        const resposta = iniciar(init);
        if (resposta) return resposta;
      }
      if (url === ROTA_CONFERIR) {
        conferencias++;
        if (conferir) return conferir(conferencias, init);
        return { json: async () => ({ ok: true, data: { tentativa: null } }) };
      }
      if (concluirPendente && url.endsWith('/concluir')) {
        // Conclusão que só termina quando o teste manda (ou o prazo da tela aborta o pedido).
        return new Promise((resolve, reject) => {
          resolverConcluir = (corpo) => resolve({ json: async () => corpo });
          init.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      if (url === ROTA_CONFIGURACAO) {
        consultas++;
        return consulta?.(consultas, init) ?? respostaDaConfiguracao(estadoInicial);
      }
      if (url === ROTA_DEMO && verificarDemo) return verificarDemo(init);
      if (url === ROTA_DESCONECTAR && desconectar) return desconectar(init);
      await Promise.resolve();
      return { json: async () => ({ ok: true, data: {
        tentativaId: 'tentativa-sintetica', state: 'state-sintetico', expiraEm,
        meta: { appId: '123', graphApiVersion: 'v26.0', launchOptions: {}, eventName, messageOrigins: ['https://www.facebook.com'] },
      } }) };
    },
  };
  const compiled = ts.transpileModule(fs.readFileSync(new URL('./WhatsappConfiguracao.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandboxModule = { exports: {} };
  vm.runInNewContext(compiled, { module: sandboxModule, exports: sandboxModule.exports, window, document, Date, Error, console, Math, AbortController,
    setTimeout: relogio?.setTimeout ?? setTimeout, clearTimeout: relogio?.clearTimeout ?? clearTimeout,
    require(id) {
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === '@/lib/http/admin-fetch') return http;
      if (id.endsWith('.css')) return { default: {} };
      if (id === './AdminPrimaryButton') return { AdminPrimaryButton: 'button' };
      if (id === './VoltarConfiguracoes') return { VoltarConfiguracoes: 'voltar' };
      if (id === 'next/link') return { default: 'a' };
      if (id === '@/lib/suporte/rota') return { ROTA_AJUDA: '/admin/ajuda' };
      throw Error(`Import inesperado: ${id}`);
    },
  });
  function elementos() {
    cursor = 0;
    const encontrados = [];
    function visitar(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visitar);
      encontrados.push(node);
      visitar(node.props?.children);
    }
    visitar(sandboxModule.exports.default());
    primeiroRender = false;
    return encontrados;
  }
  function clicar(label, { ignorarBloqueio = false } = {}) {
    const botao = elementos().find(node => node.type === 'button' && node.props.children === label);
    assert.ok(botao, `Botão ausente: ${label}`);
    if (!ignorarBloqueio) {
      assert.notEqual(botao.props.disabled, true);
      assert.notEqual(botao.props.carregando, true);
    }
    gesto = true;
    try { return botao.props.onClick(); }
    finally { gesto = false; }
  }
  let limpezas;
  function montarEfeitos() {
    elementos();
    limpezas ??= efeitos.map((fn) => fn());
  }
  return { clicar, chamadas, corpos, listeners, janelas, scripts, window, montarEfeitos,
    get reautenticacoes() { return reautenticacoes; },
    desmontar() { montarEfeitos(); for (const limpar of limpezas) limpar?.(); },
    /** SDK da Meta termina de carregar (fbAsyncInit). */
    instalarSdk(script = scripts.at(-1)) {
      window.FB = fb;
      document.currentScript = script;
      try { window.fbAsyncInit?.(); } finally { document.currentScript = null; }
    },
    /** Script do SDK falha ao carregar. */
    falharSdk() { const script = scripts.at(-1); script.onerror?.(); for (const fn of script.ouvintes) fn(); }, get chamadasLogin() { return chamadasLogin; }, liberarPopup() { popupBloqueado = false; },
    /** Botão visível (nome exato) e se está desabilitado. */
    botao(label) { return elementos().find(node => node.type === 'button' && node.props.children === label); }, resolverConcluir: (corpo) => resolverConcluir(corpo),
    senha() { elementos().find(node => node.type === 'input').props.onChange({ target: { value: 'senha-sintetica' } }); },
    preencherDesconexao() { for (const input of elementos().filter(node => node.type === 'input').slice(-2)) input.props.onChange({ target: { value: 'valor sintético' } }); },
    texto() { return elementos().map(node => typeof node.props?.children === 'string' ? node.props.children : '').join(' '); },
    /** Controles liberados: algum botão de preparar visível e sem carregamento. */
    livre() { return elementos().some(node => node.type === 'button' && /^(Preparar|Renovar credencial)/.test(node.props.children) && node.props.carregando === false); },
  };
}

const respostaDaConfiguracao = (data) => ({ json: async () => ({ ok: true, data }) });

test('preparação assíncrona não abre login; segundo clique chama o SDK sincronamente', async () => {
  const ui = montar();
  ui.senha();
  await ui.clicar('Preparar conexão');
  assert.equal(ui.chamadasLogin, 0);
  assert.equal(ui.clicar('Continuar na Meta'), undefined);
  assert.equal(ui.chamadasLogin, 1);
  assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO, ROTA_CONFIGURACAO + '/onboarding/iniciar']);
});

test('reautenticação recusada não inicia onboarding nem abre janela', async () => {
  const ui = montar({ reauthOk: false });
  ui.senha();
  await ui.clicar('Preparar conexão');
  assert.match(ui.texto(), /Senha inválida/);
  assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO]);
  assert.equal(ui.chamadasLogin, 0);
});

test('tentativa expirada exige nova preparação sem chamar a Meta', async () => {
  const ui = montar({ expiraEm: new Date(Date.now() - 1000).toISOString() });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /preparação expirou/);
  assert.equal(ui.chamadasLogin, 0);
});

test('callback sem código limpa listener e não mantém instrução contraditória', async () => {
  const ui = montar({ login: callback => callback({}) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /Clique de novo em Continuar na Meta/);
  assert.doesNotMatch(ui.texto(), /Conclua a autorização na janela/);
  assert.equal(ui.listeners.size, 0);
  // r6: a preparação continua válida; repetir não pede senha nem nova tentativa ao servidor.
  assert.ok(ui.botao('Continuar na Meta'), 'Continuar na Meta disponível de novo');
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 2);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 1, 'uma única preparação no servidor');
});

test('exceção síncrona do SDK libera estado e remove listener', async () => {
  const ui = montar({ login: () => { throw Error('Falha sintética do SDK'); } });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /Falha sintética/);
  assert.equal(ui.listeners.size, 0);
});

/** Exclui os prazos da preparação (30 s) e da carga do SDK (20 s). */
function espera(agendados) { return agendados.filter((item) => item.fn); }

/** Evento da Meta (`message`) com o nome configurado, entregue aos listeners registrados pela tela. */
function eventoMeta(ui, data, event = 'FINISH', source = ui.janelas.at(-1)) {
  for (const listener of [...ui.listeners]) listener({ origin: 'https://www.facebook.com', source, data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data }) });
}

test('D2: evento só com waba_id conclui enviando só o waba_id (o servidor resolve negócio e número)', async () => {
  const ui = montar({ login: callback => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const corpo = ui.corpos.at(-1);
  assert.ok(ui.chamadas.includes('/api/admin/configuracoes/whatsapp/onboarding/concluir'));
  assert.equal(corpo.wabaId, '2002');
  assert.equal('businessId' in corpo, false);
  assert.equal('phoneNumberId' in corpo, false);
});

test('D2: evento com os três ids envia os três', async () => {
  const ui = montar({ login: callback => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { waba_id: '2002' }, 'FINISH_ONLY_WABA'); // outro nome de evento: ignorado, a espera continua
  assert.equal(ui.listeners.size, 1);
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual({ ...ui.corpos.at(-1), tentativaId: undefined, state: undefined, authorizationCode: undefined },
    { tentativaId: undefined, state: undefined, authorizationCode: undefined, businessId: '1001', wabaId: '2002', phoneNumberId: '7001' });
});

test('evento final sem ids válidos (id não numérico ou sem waba_id) encerra a espera: erro, listener removido, preparação mantida', async () => {
  for (const ruim of [{ business_id: '1001', phone_number_id: 'abc', waba_id: '2002' }, { business_id: '1001', phone_number_id: '7001' }]) {
    for (const modo of ['conectar', 'renovar']) {
      const renovar = modo === 'renovar';
      const ui = montar({ login: callback => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: renovar ? conectada('2027-01-17T00:00:00.000Z') : undefined });
      ui.senha();
      await ui.clicar(renovar ? 'Renovar credencial' : 'Preparar conexão');
      ui.clicar('Continuar na Meta');
      eventoMeta(ui, ruim);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.match(ui.texto(), /formato diferente do configurado/, modo);
      assert.equal(ui.listeners.size, 0, `${modo}: listener removido`);
      assert.ok(ui.botao('Continuar na Meta'), `${modo}: a preparação continua para repetir Continuar na Meta`);
      assert.equal(ui.janelas.at(-1).closed, true, `${modo}: a janela da abertura encerrada é fechada`);
      eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0, `${modo}: nada é concluído com a tentativa encerrada`);
    }
  }
});

test('retorno atrasado do FB.login de uma tentativa encerrada não mexe na tentativa seguinte', async () => {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const callbacks = [];
  const ui = montar({ login: (callback) => callbacks.push(callback), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  espera(agendados)[0].fn(); // a primeira tentativa vence sem retorno da Meta
  assert.equal(ui.livre(), true);
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  assert.equal(callbacks.length, 2);
  callbacks[0]({}); // retorno atrasado SEM código: não encerra a nova tentativa
  assert.equal(ui.listeners.size, 1, 'a nova tentativa continua escutando');
  assert.equal(ui.livre(), false, 'a nova tentativa continua aguardando');
  callbacks[0]({ authResponse: { code: 'codigo-atrasado' } }); // retorno atrasado COM código: ignorado
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0, 'o código atrasado não conclui a nova tentativa');
  callbacks[1]({ authResponse: { code: 'codigo-da-tentativa' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.corpos.at(-1).authorizationCode, 'codigo-da-tentativa');
});

test('durante a conclusão a escuta acaba: evento inválido não libera os controles antes da resposta', async () => {
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), concluirPendente: true });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 1);
  assert.equal(ui.listeners.size, 0, 'escuta encerrada ao iniciar a conclusão');
  eventoMeta(ui, { business_id: '1001', phone_number_id: 'abc', waba_id: '2002' });
  assert.equal(ui.livre(), false, 'controles ocupados até a conclusão terminar');
  ui.resolverConcluir({ ok: false, erro: 'Recusa sintética.' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(ui.texto(), /Recusa sintética/);
  assert.equal(ui.livre(), true);
});

test('conclusão sem resposta no prazo: resultado incerto, estado consultado antes de liberar', async () => {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio, concluirPendente: true });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  const prazoMeta = espera(agendados)[0];
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prazoMeta.fn, null, 'o prazo da espera pela Meta foi cancelado na conclusão');
  const prazo = agendados.find((item) => item.ms === 90_000);
  assert.ok(prazo?.fn, 'prazo próprio da conclusão');
  assert.equal(ui.livre(), false);
  const antes = ui.chamadas.length;
  prazo.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(ui.chamadas.slice(antes).includes(ROTA_CONFERIR), 'o resultado foi conferido pelo id');
  assert.deepEqual(ui.corpos.at(-1), { tentativaId: 'tentativa-sintetica' });
  assert.match(ui.texto(), /resultado não foi confirmado/);
  assert.equal(ui.livre(), true);
});

test('mensagem atrasada da janela de uma tentativa anterior é ignorada; só a janela (ou um quadro dela) da tentativa atual conclui', async () => {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const callbacks = [];
  const ui = montar({ login: (callback) => callbacks.push(callback), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  const janelaA = ui.janelas[0];
  espera(agendados)[0].fn(); // a tentativa A vence sem retorno
  assert.equal(janelaA.closed, true, 'a janela da tentativa vencida é fechada');
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  const janelaB = ui.janelas[1];
  callbacks[1]({ authResponse: { code: 'codigo-de-b' } });
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' }, 'FINISH', janelaA);
  eventoMeta(ui, { waba_id: 'abc' }, 'FINISH', janelaA); // formato ruim da janela antiga: não encerra B
  eventoMeta(ui, { waba_id: '2002' }, 'FINISH', null);
  eventoMeta(ui, { waba_id: '2002' }, 'FINISH', { top: janelaA });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0, 'nada da janela antiga (nem sem origem) conclui B');
  assert.equal(ui.livre(), false, 'B continua aguardando');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2003' }, 'FINISH', { top: janelaB }); // quadro dentro da janela de B
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 1);
  assert.deepEqual([ui.corpos.at(-1).authorizationCode, ui.corpos.at(-1).wabaId], ['codigo-de-b', '2003']);
});

test('janela da Meta que não abre (pop-up bloqueado): aviso, nenhuma mensagem aceita, e Continuar na Meta funciona de novo', async () => {
  const ui = montar({ login: () => undefined, semJanela: true, inicial: conectada('2027-01-17T00:00:00.000Z') });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /janela da Meta não abriu/);
  assert.match(ui.texto(), /clique de novo em Continuar na Meta/);
  assert.equal(ui.listeners.size, 0);
  assert.ok(ui.botao('Continuar na Meta'), 'a preparação continua');
  ui.liberarPopup();
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 2);
  assert.equal(ui.janelas.length, 1);
  assert.equal(ui.listeners.size, 1, 'a segunda abertura escuta');
  assert.match(ui.texto(), /Conclua a autorização na janela/);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 1, 'sem nova preparação (o servidor recusaria com 409)');
});

test('abertura anterior encerrada: retorno sem código atrasado não mexe na abertura seguinte da mesma preparação', async () => {
  const callbacks = [];
  const ui = montar({ login: (callback) => callbacks.push(callback), inicial: conectada('2027-01-17T00:00:00.000Z') });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  callbacks[0]({}); // a Meta voltou sem código: a preparação continua
  ui.clicar('Continuar na Meta');
  callbacks[0]({}); // retorno repetido da abertura anterior: ignorado
  callbacks[0]({ authResponse: { code: 'codigo-velho' } });
  assert.equal(ui.listeners.size, 1, 'a segunda abertura continua escutando');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' }, 'FINISH', ui.janelas[0]);
  await esperar();
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0, 'nem o código nem a janela da abertura anterior concluem');
  callbacks[1]({ authResponse: { code: 'codigo-novo' } });
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  assert.equal(ui.corpos.at(-1).authorizationCode, 'codigo-novo');
});

function estadoCom(tentativa) {
  return { json: async () => ({ ok: true, data: { tentativa } }) };
}
const pendurada = (init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
async function concluirSemResposta(conferir, extra = {}) {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio, concluirPendente: true, conferir, ...extra });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  agendados.find((item) => item.ms === 90_000).fn();
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { ui, agendados };
}

test('conferência sem resposta no prazo próprio: dados possivelmente velhos, novas tentativas bloqueadas até Conferir de novo confirmar', async () => {
  const { ui, agendados } = await concluirSemResposta((n, init) => n === 1
    ? pendurada(init)
    : Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'CONCLUIDA', expira_em: '2027-01-01T00:00:00.000Z' })));
  const prazoConsulta = agendados.find((item) => item.ms === 15_000 && item.fn);
  assert.ok(prazoConsulta?.fn, 'a consulta tem prazo próprio');
  assert.equal(ui.livre(), false, 'ocupado enquanto a consulta não volta');
  prazoConsulta.fn();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(ui.texto(), /podem estar desatualizados/);
  assert.equal(ui.botao('Renovar credencial').props.disabled, true, 'nova tentativa bloqueada');
  assert.equal(ui.botao('Desconectar').props.disabled, true, 'desconectar bloqueado');
  ui.senha();
  await ui.clicar('Conferir de novo');
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(ui.texto(), /Autorização renovada/);
  assert.equal(ui.botao('Conferir de novo'), undefined);
});

test('conferência pelo id da tentativa: INICIADA e VALIDANDO mantêm o bloqueio; FALHOU e EXPIRADA dizem que nada mudou; ausente ou de outro id fica incerta', async () => {
  for (const status of ['INICIADA', 'VALIDANDO']) {
    const pendente = await concluirSemResposta(() => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status, expira_em: '2027-01-01T00:00:00.000Z' })));
    assert.match(pendente.ui.texto(), /ainda está em andamento/, status);
    assert.ok(pendente.ui.botao('Conferir de novo'), status);
    assert.equal(pendente.ui.botao('Renovar credencial').props.disabled, true, status + ': nova tentativa bloqueada');
  }
  // VALIDANDO vencida: o servidor fecha como EXPIRADA na conferência e a tela é liberada.
  for (const status of ['FALHOU', 'EXPIRADA']) {
    const terminal = await concluirSemResposta(() => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status, expira_em: '2026-01-01T00:00:00.000Z' })));
    assert.match(terminal.ui.texto(), /não foi concluída e nada mudou/, status);
    assert.equal(terminal.ui.botao('Conferir de novo'), undefined, status);
    assert.equal(terminal.ui.livre(), true, status);
  }
  for (const tentativa of [{ id: 'outra-tentativa', status: 'CONCLUIDA', expira_em: '2027-01-01T00:00:00.000Z' }, null]) {
    const incerta = await concluirSemResposta(() => Promise.resolve(estadoCom(tentativa)));
    assert.match(incerta.ui.texto(), /resultado não foi confirmado/);
    assert.doesNotMatch(incerta.ui.texto(), /Autorização renovada/);
    assert.equal(incerta.ui.livre(), true);
  }
});

test('conclusão que termina sem resposta legível (queda da rede, corpo truncado, resposta sem ok) confere pelo id antes de liberar', async () => {
  const falhas = {
    rede: () => Promise.reject(new TypeError('Failed to fetch')),
    truncado: () => Promise.resolve({ json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }),
    semOk: () => Promise.resolve({ json: async () => ({ data: {} }) }),
  };
  for (const [nome, concluirResposta] of Object.entries(falhas)) {
    const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), concluirResposta,
      conferir: () => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'CONCLUIDA', expira_em: '2027-01-01T00:00:00.000Z' })) });
    ui.senha();
    await ui.clicar('Renovar credencial');
    ui.clicar('Continuar na Meta');
    eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
    for (let i = 0; i < 5; i++) await esperar();
    assert.ok(ui.chamadas.includes(ROTA_CONFERIR), nome + ': conferido pelo id');
    assert.match(ui.texto(), /Autorização renovada/, nome);
    assert.equal(ui.livre(), true, nome);
  }
});

test('sucesso com atualização da tela pendurada: o prazo da atualização libera a tela, o sucesso fica e uma nova renovação conclui', async () => {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio,
    consulta: (n, init) => n === 2 ? pendurada(init) : undefined });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  for (let i = 0; i < 3; i++) await esperar();
  const prazoAtualizacao = agendados.find((item) => item.ms === 15_000 && item.fn);
  assert.ok(prazoAtualizacao?.fn, 'a atualização depois do sucesso tem prazo próprio');
  assert.equal(ui.livre(), false, 'ocupado enquanto atualiza');
  prazoAtualizacao.fn();
  for (let i = 0; i < 3; i++) await esperar();
  assert.match(ui.texto(), /Autorização renovada/);
  assert.match(ui.texto(), /A tela não foi atualizada/);
  assert.equal(ui.livre(), true);
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/renovacao/concluir')).length, 2, 'a conclusão anterior não deixou a tela presa');
});

test('conferência CONCLUIDA com atualização pendurada: prazo próprio, sucesso mantido e aviso para recarregar', async () => {
  const { ui, agendados } = await concluirSemResposta(() => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'CONCLUIDA', expira_em: '2027-01-01T00:00:00.000Z' })),
    { consulta: (n, init) => n === 2 ? pendurada(init) : undefined });
  const prazos = agendados.filter((item) => item.ms === 15_000 && item.fn);
  assert.equal(prazos.length, 1, 'só a atualização pendente');
  prazos[0].fn();
  for (let i = 0; i < 3; i++) await esperar();
  assert.match(ui.texto(), /Autorização renovada/);
  assert.match(ui.texto(), /A tela não foi atualizada/);
  assert.equal(ui.livre(), true);
});

test('evento da Meta que nunca chega: a espera acaba quando a tentativa vence e libera os controles', async () => {
  const agendados = [];
  const relogio = { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } };
  const ui = montar({ login: callback => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), relogio });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  assert.equal(espera(agendados).length, 1, 'um prazo agendado');
  assert.ok(espera(agendados)[0].ms > 0 && espera(agendados)[0].ms <= 60_000, 'prazo até a tentativa vencer');
  assert.equal(ui.livre(), false, 'aguardando a Meta');
  espera(agendados)[0].fn();
  assert.match(ui.texto(), /não respondeu a tempo/);
  assert.equal(ui.listeners.size, 0);
  assert.equal(ui.livre(), true);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0);
});

/**
 * C2: evento real do fluxo do WhatsApp Business App (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `data` só com
 * `waba_id`) com o nome configurado igual. A conclusão exige o código OAuth E o evento, em qualquer ordem, uma única vez.
 */
const COEXISTENCIA = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const esperar = () => new Promise((resolve) => setTimeout(resolve, 0));
const conclusoes = (ui) => ui.chamadas.filter((url) => url.endsWith('/onboarding/concluir')).length;

test('C2: evento de coexistência ANTES do código OAuth conclui uma vez, só com waba_id', async () => {
  let callbackMeta;
  const ui = montar({ eventName: COEXISTENCIA, login: (callback) => { callbackMeta = callback; } });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { waba_id: '2002' }, COEXISTENCIA);
  await esperar();
  assert.equal(conclusoes(ui), 0, 'sem o código OAuth ainda não conclui');
  callbackMeta({ authResponse: { code: 'codigo-sintetico' } });
  await esperar();
  assert.equal(conclusoes(ui), 1);
  assert.deepEqual([ui.corpos.at(-1).wabaId, 'businessId' in ui.corpos.at(-1), 'phoneNumberId' in ui.corpos.at(-1)], ['2002', false, false]);
});

test('C2: código OAuth ANTES do evento de coexistência conclui uma vez', async () => {
  const ui = montar({ eventName: COEXISTENCIA, login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  await esperar();
  assert.equal(conclusoes(ui), 0, 'sem o evento ainda não conclui');
  eventoMeta(ui, { waba_id: '2002' }, COEXISTENCIA);
  await esperar();
  assert.equal(conclusoes(ui), 1);
});

test('C2: mensagens repetidas (durante e depois da conclusão) não duplicam a conclusão', async () => {
  const ui = montar({ eventName: COEXISTENCIA, login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { waba_id: '2002' }, COEXISTENCIA);
  eventoMeta(ui, { waba_id: '2002' }, COEXISTENCIA);
  await esperar();
  eventoMeta(ui, { waba_id: '2002' }, COEXISTENCIA);
  await esperar();
  assert.equal(conclusoes(ui), 1);
  assert.equal(ui.listeners.size, 0, 'o listener sai depois da conclusão');
});

test('C2: com o nome configurado de coexistência, o evento FINISH genérico é ignorado', async () => {
  const ui = montar({ eventName: COEXISTENCIA, login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' }, 'FINISH');
  await esperar();
  assert.equal(conclusoes(ui), 0);
});

/** Renovação (20/11/2026): empresa já conectada; mesmo fluxo da Meta, rotas próprias, sem desconectar. */
const conectada = (tokenExpiraEm) => ({ estado: 'CONFIGURADA_SEM_WEBHOOK_OTP', metaConfigurada: true, tentativa: null,
  conexao: { id: 'conexao-sintetica', status: 'CONFIGURADA', tokenExpiraEm } });

test('renovação: prepara por /renovacao/iniciar e conclui por /renovacao/concluir, nunca pelas rotas de conexão', async () => {
  const ui = montar({ inicial: conectada('2027-01-17T00:00:00.000Z'), login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  assert.match(ui.texto(), /Renovar autorização da Meta/);
  ui.senha();
  await ui.clicar('Renovar credencial');
  assert.equal(ui.chamadasLogin, 0);
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  assert.deepEqual(ui.chamadas.filter((url) => url.includes('/renovacao/') || url.includes('/onboarding/')),
    ['/api/admin/configuracoes/whatsapp/renovacao/iniciar', '/api/admin/configuracoes/whatsapp/renovacao/concluir']);
  assert.deepEqual(ui.corpos[0], { conexaoId: 'conexao-sintetica' }, 'o início fica preso à conexão exibida');
  assert.equal('conexaoId' in ui.corpos.at(-1), false, 'a conclusão usa a conexão da tentativa já gravada');
  assert.match(ui.texto(), /Autorização renovada/);
});

test('renovação: senha recusada não inicia nem abre a Meta', async () => {
  const ui = montar({ inicial: conectada(null), reauthOk: false });
  ui.senha();
  await ui.clicar('Renovar credencial');
  assert.match(ui.texto(), /Senha inválida/);
  assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO]);
  assert.equal(ui.chamadasLogin, 0);
});

test('textoValidade: sem data (desconhecida, nunca "permanente"), vencida, perto do vencimento e longe dele', async () => {
  const compiled = ts.transpileModule(fs.readFileSync(new URL('./WhatsappConfiguracao.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(compiled, { module: m, exports: m.exports, Date, Error, console, require: (id) => id === 'react/jsx-runtime' ? jsxRuntime : {} });
  const { textoValidade } = m.exports;
  const agora = Date.parse('2026-11-20T12:00:00.000Z'), dia = 86_400_000;
  assert.deepEqual({ ...textoValidade(null, agora) }, { texto: 'Data de vencimento da autorização da Meta não informada.', alerta: false });
  const vencida = textoValidade(new Date(agora - dia).toISOString(), agora);
  assert.equal(vencida.alerta, true); assert.match(vencida.texto, /venceu em .*O iA\.Fest não consegue enviar mensagens por este número até você renovar a autorização\./);
  assert.equal(textoValidade(new Date(agora + 15 * dia).toISOString(), agora).alerta, true);
  const longe = textoValidade('2027-01-17T12:00:00.000Z', agora);
  assert.equal(longe.alerta, false); assert.match(longe.texto, /vale até 17\/01\/2027/);
  assert.equal(textoValidade('nao-e-data', agora).alerta, true);
});

/** r7: relógio sintético que guarda os prazos agendados pela tela. */
function relogioFalso() {
  const agendados = [];
  return { agendados, relogio: { setTimeout: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, clearTimeout: (id) => { if (agendados[id - 1]) agendados[id - 1].fn = null; } } };
}
const CONCLUIDA = () => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'CONCLUIDA', expira_em: '2027-01-01T00:00:00.000Z' }));
const recusa = (corpo) => () => Promise.resolve({ json: async () => ({ ok: false, ...corpo }) });
async function renovarAteConcluir(opcoes) {
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'), ...opcoes });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  for (let i = 0; i < 6; i++) await esperar();
  return ui;
}

test('r7 P2-1: conclusão presa depois da resposta (confirmação de sessão sem sinal) é liberada pelo prazo e a entrega tardia é descartada', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregarConclusao;
  // Ignora o sinal de propósito: é o caso do adminFetch que espera a confirmação de sessão depois da resposta.
  const ui = await renovarAteConcluir({ relogio, concluirResposta: () => new Promise((resolve) => { entregarConclusao = resolve; }), conferir: CONCLUIDA });
  assert.equal(ui.livre(), false, 'aguardando a conclusão');
  agendados.find((item) => item.ms === 90_000).fn();
  for (let i = 0; i < 6; i++) await esperar();
  assert.ok(ui.chamadas.includes(ROTA_CONFERIR), 'conferido pelo id depois do prazo');
  assert.match(ui.texto(), /Autorização renovada/);
  assert.equal(ui.livre(), true);
  entregarConclusao({ json: async () => ({ ok: false, erro: 'Resposta tardia sintética.' }) });
  for (let i = 0; i < 3; i++) await esperar();
  assert.doesNotMatch(ui.texto(), /Resposta tardia/, 'a entrega tardia não mexe na tela');
  assert.match(ui.texto(), /Autorização renovada/);
});

test('r7 P2-1: conferência presa depois da resposta é liberada pelo prazo próprio; a entrega tardia é descartada', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregarConferencia;
  const ui = await renovarAteConcluir({ relogio, concluirResposta: () => Promise.reject(new TypeError('Failed to fetch')),
    conferir: (n) => n === 1 ? new Promise((resolve) => { entregarConferencia = resolve; }) : CONCLUIDA() });
  assert.equal(ui.livre(), false, 'conferindo');
  agendados.find((item) => item.ms === 15_000 && item.fn).fn();
  for (let i = 0; i < 3; i++) await esperar();
  assert.match(ui.texto(), /podem estar desatualizados/);
  assert.ok(ui.botao('Conferir de novo'));
  entregarConferencia(estadoCom({ id: 'tentativa-sintetica', status: 'FALHOU', expira_em: '2027-01-01T00:00:00.000Z' }));
  for (let i = 0; i < 3; i++) await esperar();
  assert.doesNotMatch(ui.texto(), /nada mudou/, 'a conferência tardia não mexe na tela');
  assert.ok(ui.botao('Conferir de novo'), 'segue bloqueada até conferir de novo');
});

test('r7 P2-2: recusa legível (ok:false) é conferida pelo id antes de liberar', async () => {
  // 500 genérico com a tentativa em VALIDANDO: segue pendente e bloqueada.
  const pendente = await renovarAteConcluir({ concluirResposta: recusa({ erro: 'Erro interno sintético.' }),
    conferir: () => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'VALIDANDO', expira_em: '2027-01-01T00:00:00.000Z' })) });
  assert.ok(pendente.chamadas.includes(ROTA_CONFERIR));
  assert.match(pendente.texto(), /Erro interno sintético\..*ainda está em andamento/);
  assert.ok(pendente.botao('Conferir de novo'));
  assert.equal(pendente.botao('Renovar credencial').props.disabled, true, 'nova tentativa bloqueada');
  // Recusa com a tentativa terminal: diz que nada mudou e libera.
  const terminal = await renovarAteConcluir({ concluirResposta: recusa({ erro: 'Recusa sintética.', codigo: 'WHATSAPP_META_RECUSOU' }),
    conferir: () => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'FALHOU', expira_em: '2027-01-01T00:00:00.000Z' })) });
  assert.match(terminal.texto(), /Recusa sintética\..*não foi concluída e nada mudou/);
  assert.equal(terminal.livre(), true);
  // Recusa com a tentativa intacta (INICIADA) ou ausente: libera e pede nova preparação.
  for (const tentativa of [{ id: 'tentativa-sintetica', status: 'INICIADA', expira_em: '2027-01-01T00:00:00.000Z' }, null]) {
    const intacta = await renovarAteConcluir({ concluirResposta: recusa({ erro: 'Dados recusados.', codigo: 'WHATSAPP_DADOS_INVALIDOS' }), conferir: () => Promise.resolve(estadoCom(tentativa)) });
    assert.match(intacta.texto(), /Dados recusados\. Nada mudou\. Prepare de novo/);
    assert.equal(intacta.botao('Conferir de novo'), undefined);
    assert.equal(intacta.livre(), true);
  }
});

test('r7 P2-2: senha vencida (403 de reautenticação) com a tentativa intacta libera, explica e a nova preparação chama o servidor de novo', async () => {
  const ui = await renovarAteConcluir({ concluirResposta: recusa({ erro: 'Confirme sua senha novamente.', codigo: 'WHATSAPP_REAUTENTICACAO_NECESSARIA' }),
    conferir: () => Promise.resolve(estadoCom({ id: 'tentativa-sintetica', status: 'INICIADA', expira_em: '2027-01-01T00:00:00.000Z' })) });
  assert.match(ui.texto(), /vale 5 minutos e venceu antes de concluir/);
  assert.equal(ui.botao('Conferir de novo'), undefined);
  assert.equal(ui.livre(), true);
  ui.senha();
  await ui.clicar('Renovar credencial');
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/renovacao/iniciar')).length, 2, 'a preparação nova vai ao servidor (que substitui a anterior)');
  assert.ok(ui.botao('Continuar na Meta'));
});

test('r7 P2-3: tela desmontada invalida a abertura: janela fechada, listener removido, retorno atrasado e evento não concluem', async () => {
  let callbackMeta;
  const ui = montar({ login: (callback) => { callbackMeta = callback; } });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.equal(ui.listeners.size, 1);
  ui.desmontar();
  assert.equal(ui.listeners.size, 0, 'listener removido');
  assert.equal(ui.janelas[0].closed, true, 'janela da Meta fechada');
  callbackMeta({ authResponse: { code: 'codigo-atrasado' } });
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0, 'nenhuma conclusão depois de sair da tela');
});

test('r7 P2-3: conclusão que termina depois da desmontagem não confere nem mexe na tela', async () => {
  let entregar;
  const ui = montar({ login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }), inicial: conectada('2027-01-17T00:00:00.000Z'),
    concluirResposta: () => new Promise((resolve) => { entregar = resolve; }) });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  ui.desmontar();
  entregar({ json: async () => ({ ok: false, erro: 'Recusa depois de sair.' }) });
  for (let i = 0; i < 4; i++) await esperar();
  assert.equal(ui.chamadas.includes(ROTA_CONFERIR), false, 'sem conferência depois de sair da tela');
  assert.doesNotMatch(ui.texto(), /Recusa depois de sair/);
});

test('r7 P3-1: retorno síncrono sem código dentro do FB.login fecha a janela que acabou de abrir', async () => {
  const ui = montar({ login: (callback) => callback({}) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.equal(ui.janelas.length, 1);
  assert.equal(ui.janelas[0].closed, true, 'a janela foi registrada na interceptação e fechada');
  assert.match(ui.texto(), /Clique de novo em Continuar na Meta/);
});

test('r7 P3-2: SDK que falha ao carregar mantém a preparação; Continuar na Meta carrega de novo sem nova preparação', async () => {
  const ui = montar({ semSdk: true, login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  for (let i = 0; i < 4 && ui.scripts.length === 0; i++) await esperar();
  assert.equal(ui.scripts.length, 1, 'script do SDK criado');
  ui.falharSdk();
  await preparando;
  assert.match(ui.texto(), /janela da Meta não carregou/);
  assert.equal(ui.scripts[0].removido, true, 'o script que falhou sai do documento');
  assert.ok(ui.botao('Continuar na Meta'), 'preparação mantida');
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 0, 'sem SDK não abre a Meta');
  assert.equal(ui.scripts.length, 2, 'nova carga do SDK');
  ui.instalarSdk();
  for (let i = 0; i < 3; i++) await esperar();
  assert.match(ui.texto(), /A janela da Meta está pronta/);
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await esperar();
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 1, 'uma única preparação no servidor');
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 1);
});

test('r7 P3-2: SDK que não carrega no prazo mantém a preparação; a nova carga abre a Meta', async () => {
  const { agendados, relogio } = relogioFalso();
  const ui = montar({ semSdk: true, relogio, login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  for (let i = 0; i < 4 && !agendados.some((item) => item.ms === 20_000); i++) await esperar();
  const prazoSdk = agendados.find((item) => item.ms === 20_000);
  assert.ok(prazoSdk?.fn, 'a carga do SDK tem prazo');
  const inicializarAntigo = ui.window.fbAsyncInit;
  prazoSdk.fn();
  await preparando;
  assert.match(ui.texto(), /janela da Meta não carregou/);
  assert.ok(ui.botao('Continuar na Meta'));
  assert.equal(ui.livre(), false, 'Preparar não aparece: a preparação segue valendo');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /Carregando a janela da Meta/);
  assert.equal(ui.scripts[0].removido, true);
  assert.equal(ui.scripts.length, 2, 'o primeiro script segue sem resposta e o segundo é solicitado');
  inicializarAntigo();
  ui.instalarSdk(ui.scripts[0]);
  await esperar();
  assert.match(ui.texto(), /Carregando a janela da Meta/, 'callback da primeira carga descartado');
  assert.equal(ui.botao('Continuar na Meta'), undefined);
  ui.instalarSdk();
  for (let i = 0; i < 3; i++) await esperar();
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 1);
});

test('SDK disponível depois do prazo é inicializado antes de abrir a Meta', async () => {
  const { agendados, relogio } = relogioFalso();
  const ui = montar({ semSdk: true, relogio });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  agendados.find((item) => item.ms === 20_000 && item.fn).fn();
  await preparando;
  ui.instalarSdk();
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 1);
});

test('remontar durante VALIDANDO recupera a conferência e impede reautenticação até o estado terminal', async () => {
  const tentativa = { id: 'tentativa-anterior', status: 'VALIDANDO', expira_em: '2027-01-01T00:00:00.000Z' };
  const ui = montar({ montagemReal: true, inicial: { ...conectada(null), tentativa },
    consulta: (n) => n > 1 ? respostaDaConfiguracao(conectada(null)) : undefined,
    conferir: async (n) => estadoCom(n === 1 ? tentativa : { ...tentativa, status: 'EXPIRADA' }) });
  ui.montarEfeitos();
  await esperar();
  ui.senha();
  ui.preencherDesconexao();
  for (const rodada of [1, 2]) {
    for (const rotulo of ['Renovar credencial', 'Desconectar']) {
      const botao = ui.botao(rotulo);
      assert.equal(botao.props.disabled, true);
      await botao.props.onClick();
    }
    assert.equal(ui.reautenticacoes, 0);
    await ui.clicar('Conferir de novo');
    assert.equal(ui.corpos[rodada - 1].tentativaId, tentativa.id);
  }
  assert.match(ui.texto(), /não foi concluída e nada mudou/);
  assert.equal(ui.botao('Renovar credencial').props.disabled, false);
  assert.equal(ui.botao('Desconectar').props.disabled, false);
});

test('conferência EXPIRADA do id antigo recupera a nova tentativa em VALIDANDO na atualização', async () => {
  const nova = { id: 'tentativa-nova', status: 'VALIDANDO' };
  const ui = await renovarAteConcluir({
    concluirResposta: recusa({ erro: 'Esta tentativa já foi utilizada.' }),
    conferir: (n) => estadoCom(n === 1 ? { id: 'tentativa-sintetica', status: 'EXPIRADA' } : nova),
    consulta: (n) => n > 1 ? respostaDaConfiguracao({ ...conectada(null), tentativa: nova }) : undefined,
  });

  ui.senha();
  ui.preencherDesconexao();
  assert.match(ui.texto(), /ainda está em andamento/);
  assert.equal(ui.botao('Renovar credencial').props.disabled, true);
  assert.equal(ui.botao('Desconectar').props.disabled, true);
  await ui.botao('Renovar credencial').props.onClick();
  await ui.botao('Desconectar').props.onClick();
  assert.equal(ui.reautenticacoes, 1);
  await ui.clicar('Conferir de novo');
  assert.deepEqual(ui.corpos.slice(-2).map(({ tentativaId }) => tentativaId), ['tentativa-sintetica', nova.id]);
});

for (const acao of ['Renovar credencial', 'Desconectar']) {
  test(`aba já montada consulta antes de ${acao} enquanto outra espera a Meta`, async () => {
    const conexaoAtual = conectada(null);
    let atual = conexaoAtual;
    let concluir;
    const tentativa = { id: 'tentativa-sintetica', status: 'VALIDANDO' };
    const opcoes = { montagemReal: true, consulta: () => respostaDaConfiguracao(atual) };
    const abaA = montar({ ...opcoes,
      login: (callback) => callback({ authResponse: { code: 'codigo-sintetico' } }),
      concluirResposta: () => {
        atual = { ...conexaoAtual, tentativa };
        return new Promise((resolve) => { concluir = resolve; });
      },
    });
    const abaB = montar(opcoes);
    abaA.montarEfeitos();
    abaB.montarEfeitos();
    await esperar();

    abaA.senha();
    await abaA.clicar('Renovar credencial');
    abaA.clicar('Continuar na Meta');
    eventoMeta(abaA, { waba_id: '2002' });
    assert.equal(typeof concluir, 'function');
    try {
      abaB.senha();
      abaB.preencherDesconexao();
      await abaB.clicar(acao);
      assert.deepEqual(abaB.chamadas, [ROTA_CONFIGURACAO, ROTA_CONFIGURACAO]);
      assert.equal(abaB.reautenticacoes, 0);
      assert.ok(abaB.botao('Conferir de novo'));
      assert.equal(abaB.botao('Renovar credencial').props.disabled, true);
      assert.equal(abaB.botao('Desconectar').props.disabled, true);
    } finally {
      atual = conexaoAtual;
      concluir({ json: async () => ({ ok: true }) });
      await esperar();
    }
  });

  test(`consulta pendente no corpo impede reautenticação para ${acao}`, async () => {
    const { agendados, relogio } = relogioFalso();
    let sinal;
    const ui = montar({ inicial: conectada(null), relogio, consulta: (_, init) => {
      sinal = init.signal;
      return { json: () => new Promise(() => {}) };
    } });
    ui.senha();
    ui.preencherDesconexao();
    const operacao = ui.clicar(acao);
    await esperar();
    assert.equal(ui.reautenticacoes, 0);
    agendados.find((item) => item.ms === 15_000 && item.fn).fn();
    await operacao;
    assert.equal(sinal.aborted, true);
    assert.equal(ui.reautenticacoes, 0);
    assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO]);
    assert.match(ui.texto(), /Não foi possível confirmar o estado atual/);
    assert.equal(ui.botao(acao).props.carregando, false);
  });
}

test('a troca da conexão exibida impede reautenticação e início da renovação até um novo clique', async () => {
  const antiga = conectada(null);
  const atual = { ...antiga, conexao: { ...antiga.conexao, id: 'conexao-nova' } };
  const ui = montar({ inicial: antiga, consulta: () => respostaDaConfiguracao(atual) });
  ui.senha();
  await ui.clicar('Renovar credencial');
  assert.equal(ui.reautenticacoes, 0);
  assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO]);
  assert.match(ui.texto(), /conexão do WhatsApp mudou.*clique de novo/);
  assert.equal(ui.botao('Renovar credencial').props.disabled, true, 'pede a senha novamente');

  ui.senha();
  await ui.clicar('Renovar credencial');
  assert.equal(ui.reautenticacoes, 1);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/renovacao/iniciar')).length, 1);
  assert.ok(ui.botao('Continuar na Meta'));
});

test('verificação de ativos com corpo pendente vence e permite continuar a mesma renovação', async () => {
  const { agendados, relogio } = relogioFalso();
  let sinal, entregarCorpo;
  const ui = montar({ inicial: { ...conectada(null), demoAtivosTeste: true }, relogio, verificarDemo: (init) => {
    sinal = init.signal;
    return { json: () => new Promise((resolve) => { entregarCorpo = resolve; }) };
  } });
  ui.senha();
  await ui.clicar('Renovar credencial');
  const verificando = ui.clicar('Verificar ativos de teste');
  await esperar();
  assert.equal(typeof entregarCorpo, 'function');
  assert.equal(ui.botao('Continuar na Meta').props.disabled, true);
  const prazo = agendados.find((item) => item.ms === 15_000 && item.fn);
  assert.ok(prazo, 'a verificação tem prazo de 15 segundos');
  prazo.fn();
  await verificando;
  assert.equal(sinal.aborted, true);
  assert.match(ui.texto(), /verificação dos ativos de teste demorou demais/);
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
  assert.equal(ui.reautenticacoes, 1);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/renovacao/iniciar')).length, 1);

  entregarCorpo({ ok: true, data: { portfolio: { id: '123', possuiWabaTeste: true }, waba: { id: '456' }, numeros: [], aviso: 'Resultado tardio' } });
  await esperar();
  assert.doesNotMatch(ui.texto(), /Resultado tardio/);
  assert.match(ui.texto(), /Conclua a autorização na janela da Meta/);
});

test('desconexão com reautenticação pendente bloqueia Continuar na Meta e descarta a preparação ao confirmar', async () => {
  let reautenticarDesconexao;
  let numReautenticacoes = 0;
  const ui = montar({ inicial: conectada(null),
    reautenticar: () => ++numReautenticacoes === 1 ? Promise.resolve({ ok: true }) : new Promise((resolve) => { reautenticarDesconexao = resolve; }),
    consulta: (n) => n === 3 ? { json: async () => ({ ok: false }) } : undefined,
  });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.preencherDesconexao();
  const desconectando = ui.clicar('Desconectar');
  await esperar();
  assert.equal(typeof reautenticarDesconexao, 'function');
  const continuar = ui.botao('Continuar na Meta');
  assert.equal(continuar.props.disabled, true);
  ui.clicar('Continuar na Meta', { ignorarBloqueio: true });
  assert.equal(ui.chamadasLogin, 0);
  reautenticarDesconexao({ ok: true });
  await desconectando;
  assert.match(ui.texto(), /WhatsApp desconectado/);
  assert.match(ui.texto(), /A tela não foi atualizada/);
  assert.ok(ui.botao('Renovar credencial'));
  assert.equal(ui.botao('Continuar na Meta'), undefined);
  assert.equal(ui.chamadasLogin, 0);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/desconectar')).length, 1);
});

test('prazo da reautenticação da desconexão mantém a preparação e impede POST tardio', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregar;
  let reautenticacoes = 0;
  const ui = montar({ relogio, inicial: conectada(null),
    reautenticar: () => ++reautenticacoes === 1 ? Promise.resolve({ ok: true }) : new Promise((resolve) => { entregar = resolve; }),
  });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.preencherDesconexao();
  const pendente = ui.clicar('Desconectar');
  await esperar();
  assert.equal(ui.botao('Continuar na Meta').props.disabled, true);
  const prazo = agendados.find((item) => item.ms === 30_000 && item.fn);
  assert.ok(prazo);
  prazo.fn();
  await pendente;
  assert.match(ui.texto(), /A desconexão não foi enviada/);
  assert.equal(ui.botao('Continuar na Meta').props.disabled, false);
  entregar({ ok: true });
  await esperar();
  assert.equal(ui.chamadas.includes(ROTA_DESCONECTAR), false);
  ui.clicar('Continuar na Meta');
  assert.equal(ui.chamadasLogin, 1);
});

test('corpo pendente da desconexão vence, consulta o estado com controles bloqueados e ignora o corpo tardio', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregarCorpo, entregarEstado, sinal;
  const inicial = conectada(null);
  const ui = montar({ relogio, inicial,
    desconectar: (init) => {
      sinal = init.signal;
      return { json: () => new Promise((resolve) => { entregarCorpo = resolve; }) };
    },
    consulta: (n) => n === 3 ? new Promise((resolve) => { entregarEstado = resolve; }) : undefined,
  });
  ui.senha();
  await ui.clicar('Renovar credencial');
  ui.preencherDesconexao();
  const pendente = ui.clicar('Desconectar');
  await esperar();
  assert.equal(typeof entregarCorpo, 'function');
  assert.equal(ui.livre(), false);
  const prazo = agendados.find((item) => item.ms === 30_000 && item.fn);
  assert.ok(prazo);
  prazo.fn();
  await esperar();
  assert.equal(sinal.aborted, true);
  assert.equal(ui.chamadas.at(-1), ROTA_CONFIGURACAO);
  assert.equal(ui.livre(), false);
  assert.doesNotMatch(ui.texto(), /WhatsApp desconectado/);
  entregarEstado(respostaDaConfiguracao({ ...inicial, estado: 'NAO_CONFIGURADA', conexao: null }));
  await pendente;
  assert.match(ui.texto(), /WhatsApp desconectado/);
  assert.equal(ui.livre(), true);
  entregarCorpo({ ok: false, erro: 'recusa tardia' });
  await esperar();
  assert.doesNotMatch(ui.texto(), /recusa tardia/);
});

test('carga inicial com corpo pendente vence, permite repetir e descarta a resposta antiga', async () => {
  const { agendados, relogio } = relogioFalso();
  const tentativa = { id: 'tentativa-no-retry', status: 'VALIDANDO' };
  let entregarCorpo, sinal;
  const ui = montar({ montagemReal: true, relogio, consulta: (n, init) => {
    if (n > 1) return respostaDaConfiguracao({ ...conectada(null), tentativa });
    sinal = init.signal;
    return { json: () => new Promise((resolve) => { entregarCorpo = resolve; }) };
  } });
  ui.montarEfeitos();
  await esperar();
  assert.match(ui.texto(), /Carregando/);
  agendados.find((item) => item.ms === 15_000 && item.fn).fn();
  await esperar();
  assert.equal(sinal.aborted, true);
  assert.match(ui.texto(), /Não foi possível carregar/);
  await ui.clicar('Tentar carregar de novo');
  entregarCorpo({ ok: true, data: { estado: 'NAO_CONFIGURADA', conexao: null, tentativa: null } });
  await esperar();
  assert.equal(ui.botao('Tentar carregar de novo'), undefined);
  assert.equal(ui.botao('Renovar credencial').props.disabled, true);
  await ui.clicar('Conferir de novo');
  assert.equal(ui.corpos.at(-1).tentativaId, tentativa.id);
});

test('403 de reautenticação permanece na conferência após prazo e libera com INICIADA', async () => {
  const { agendados, relogio } = relogioFalso();
  const ui = await renovarAteConcluir({ relogio,
    concluirResposta: async () => ({ status: 403, json: async () => ({ ok: false, erro: 'Confirme sua senha novamente.', codigo: 'WHATSAPP_REAUTENTICACAO_NECESSARIA' }) }),
    conferir: async (n) => n === 1 ? new Promise(() => {}) : estadoCom({ id: 'tentativa-sintetica', status: 'INICIADA' }) });
  agendados.find((item) => item.ms === 15_000 && item.fn).fn();
  await esperar();
  assert.match(ui.texto(), /Confirme sua senha novamente.*Não foi possível conferir/);
  await ui.clicar('Conferir de novo');
  assert.match(ui.texto(), /vale 5 minutos e venceu antes de concluir/);
  assert.equal(ui.botao('Conferir de novo'), undefined);
  assert.equal(ui.livre(), true);
});

test('corpo de início pendente vence no prazo e a próxima preparação descarta a resposta anterior', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregarCorpo, sinal;
  const ui = montar({ relogio, iniciar: (init) => {
    if (entregarCorpo) return;
    sinal = init.signal;
    return { json: () => new Promise((resolve) => { entregarCorpo = resolve; }) };
  } });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  assert.equal(typeof entregarCorpo, 'function');
  agendados.find((item) => item.ms === 30_000 && item.fn).fn();
  await preparando;
  assert.equal(sinal.aborted, true);
  assert.match(ui.texto(), /Confirme sua senha e prepare de novo/);
  assert.equal(ui.livre(), true);
  ui.senha();
  await ui.clicar('Preparar conexão');
  entregarCorpo({ ok: false, erro: 'Resposta de início tardia.' });
  await esperar();
  assert.ok(ui.botao('Continuar na Meta'));
  assert.doesNotMatch(ui.texto(), /Resposta de início tardia/);
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/iniciar')).length, 2);
});

test('reauth tardia no limite do prazo não dispara início', async () => {
  const { agendados, relogio } = relogioFalso();
  let entregar;
  const ui = montar({ relogio, reautenticar: () => new Promise((resolve) => { entregar = resolve; }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  entregar({ ok: true });
  agendados.find((item) => item.ms === 30_000 && item.fn).fn();
  await preparando;
  await esperar();
  assert.equal(ui.livre(), true);
  assert.deepEqual(ui.chamadas, [ROTA_CONFIGURACAO]);
});

test('desmontar durante a reautenticação impede o retorno de iniciar uma tentativa', async () => {
  let entregar;
  const ui = montar({ reautenticar: () => new Promise((resolve) => { entregar = resolve; }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  ui.desmontar();
  entregar({ ok: true });
  await preparando;
  assert.equal(ui.chamadas.some((url) => url.endsWith('/iniciar')), false);
});

test('desmontar durante o início impede o retorno de ler o corpo ou carregar o SDK', async () => {
  let entregar, leuCorpo = false;
  const ui = montar({ semSdk: true, iniciar: () => new Promise((resolve) => { entregar = resolve; }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  ui.desmontar();
  entregar({ json: async () => {
    leuCorpo = true;
    return { ok: true, data: { meta: {} } };
  } });
  await preparando;
  assert.equal(leuCorpo, false);
  assert.equal(ui.scripts.length, 0);
});

test('desmontar durante o corpo do início impede carregar o SDK', async () => {
  const { relogio } = relogioFalso();
  let entregar;
  const ui = montar({ semSdk: true, relogio, iniciar: () => ({ json: () => new Promise((resolve) => { entregar = resolve; }) }) });
  ui.senha();
  const preparando = ui.clicar('Preparar conexão');
  await esperar();
  ui.desmontar();
  entregar({ ok: true, data: { meta: {} } });
  await esperar();
  assert.equal(ui.scripts.length, 0);
  await preparando;
  assert.equal(ui.botao('Continuar na Meta'), undefined);
});
