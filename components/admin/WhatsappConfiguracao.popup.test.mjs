import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';

// Executa os handlers reais do componente com hooks/transportes sintéticos.
// Nenhum SDK externo, credencial, servidor ou banco é usado neste teste.
function montar({ expiraEm = new Date(Date.now() + 60_000).toISOString(), reauthOk = true, login, eventName = 'FINISH' } = {}) {
  const slots = [], listeners = new Set(), chamadas = [], corpos = [];
  let cursor = 0, gesto = false, chamadasLogin = 0;
  const window = {
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    FB: {
      init() {},
      login(callback) {
        assert.equal(gesto, true, 'FB.login precisa ocorrer durante o clique, antes de qualquer await');
        chamadasLogin++;
        login?.(callback);
      },
    },
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = index === 0
        ? { estado: 'NAO_CONFIGURADA', metaConfigurada: true, conexao: null, tentativa: null }
        : initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback) => callback,
    useEffect() {},
  };
  const http = {
    async reautenticarSessao() { await Promise.resolve(); return { ok: reauthOk, erro: 'Senha inválida.' }; },
    async adminFetch(url, init) {
      chamadas.push(url);
      if (init?.body) corpos.push(JSON.parse(init.body));
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
  vm.runInNewContext(compiled, { module: sandboxModule, exports: sandboxModule.exports, window, Date, Error, console,
    require(id) {
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === '@/lib/http/admin-fetch') return http;
      if (id.endsWith('.css')) return { default: {} };
      if (id === './AdminPrimaryButton') return { AdminPrimaryButton: 'button' };
      if (id === './VoltarConfiguracoes') return { VoltarConfiguracoes: 'voltar' };
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
    return encontrados;
  }
  function clicar(label) {
    const botao = elementos().find(node => node.type === 'button' && node.props.children === label);
    assert.ok(botao, `Botão ausente: ${label}`);
    assert.notEqual(botao.props.disabled, true);
    gesto = true;
    try { return botao.props.onClick(); }
    finally { gesto = false; }
  }
  return { clicar, chamadas, corpos, listeners, get chamadasLogin() { return chamadasLogin; },
    senha() { elementos().find(node => node.type === 'input').props.onChange({ target: { value: 'senha-sintetica' } }); },
    texto() { return elementos().map(node => typeof node.props?.children === 'string' ? node.props.children : '').join(' '); },
  };
}

test('preparação assíncrona não abre login; segundo clique chama o SDK sincronamente', async () => {
  const ui = montar();
  ui.senha();
  await ui.clicar('Preparar conexão');
  assert.equal(ui.chamadasLogin, 0);
  assert.equal(ui.clicar('Continuar na Meta'), undefined);
  assert.equal(ui.chamadasLogin, 1);
  assert.equal(ui.chamadas.length, 1);
});

test('reautenticação recusada não inicia onboarding nem abre janela', async () => {
  const ui = montar({ reauthOk: false });
  ui.senha();
  await ui.clicar('Preparar conexão');
  assert.match(ui.texto(), /Senha inválida/);
  assert.equal(ui.chamadas.length, 0);
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
  assert.match(ui.texto(), /Se a janela não abriu/);
  assert.doesNotMatch(ui.texto(), /Conclua a autorização na janela/);
  assert.equal(ui.listeners.size, 0);
});

test('exceção síncrona do SDK libera estado e remove listener', async () => {
  const ui = montar({ login: () => { throw Error('Falha sintética do SDK'); } });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  assert.match(ui.texto(), /Falha sintética/);
  assert.equal(ui.listeners.size, 0);
});

/** Evento da Meta (`message`) com o nome configurado, entregue aos listeners registrados pela tela. */
function eventoMeta(ui, data, event = 'FINISH') {
  for (const listener of [...ui.listeners]) listener({ origin: 'https://www.facebook.com', data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data }) });
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

test('D2: evento com os três ids envia os três; id não numérico ou sem waba_id não conclui', async () => {
  const ui = montar({ login: callback => callback({ authResponse: { code: 'codigo-sintetico' } }) });
  ui.senha();
  await ui.clicar('Preparar conexão');
  ui.clicar('Continuar na Meta');
  eventoMeta(ui, { business_id: '1001', phone_number_id: 'abc', waba_id: '2002' });
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001' });
  eventoMeta(ui, { waba_id: '2002' }, 'FINISH_ONLY_WABA');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.chamadas.filter((url) => url.endsWith('/concluir')).length, 0);
  assert.match(ui.texto(), /formato diferente do configurado/);
  eventoMeta(ui, { business_id: '1001', phone_number_id: '7001', waba_id: '2002' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual({ ...ui.corpos.at(-1), tentativaId: undefined, state: undefined, authorizationCode: undefined },
    { tentativaId: undefined, state: undefined, authorizationCode: undefined, businessId: '1001', wabaId: '2002', phoneNumberId: '7001' });
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
