/* eslint-disable @typescript-eslint/no-require-imports */
// Prova de e-mail em produção (V6, 20/10/2026): executor com disco simulado e rede simulada. Nenhum envio real, nenhum
// acesso a /opt, Render ou banco. `fetch` global é substituído por uma função que falha: qualquer tentativa de rede real
// derruba o teste.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {createHash} = require('node:crypto'), {pathToFileURL} = require('node:url'), {spawnSync} = require('node:child_process');
const e = require('./email-producao-20261020.cjs');

globalThis.fetch = async () => { throw new Error('REDE_REAL_PROIBIDA_NOS_TESTES'); };
const root = path.resolve(__dirname, '..');
const RAIZ = '/deploy-simulado';
const CHAVE = 're_SEGREDOsinteticoNAOREAL_0123456789abcdef';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', RENDER_GIT_COMMIT: '7ce0916f672f4dad9c8bc5e25d5abc6cdf53f824',
  EMAIL_PROVIDER: 'resend', EMAIL_REMETENTE: 'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>', RESEND_API_KEY: CHAVE, NODE_ENV: 'production'});
const sha = b => createHash('sha256').update(b).digest('hex');
const enoent = () => Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
const eexist = () => Object.assign(new Error('EEXIST'), {code: 'EEXIST'});

/** Disco simulado: deploy em /deploy-simulado (transporte = arquivos reais do clone), disco montado em data/. */
function disco({montado = true, registro = null, transporte = {}, falhaWx = null} = {}) {
  const arquivos = new Map(), pastas = new Set([RAIZ]);
  for (const rel of Object.keys(e.TRANSPORTE)) arquivos.set(RAIZ + '/' + rel, transporte[rel] ?? fs.readFileSync(path.join(root, rel)));
  if (montado) pastas.add(RAIZ + '/data');
  const reg = RAIZ + '/' + e.PASTA_REL + '/' + e.REGISTRO_NOME;
  if (registro !== null) { pastas.add(RAIZ + '/' + e.PASTA_REL); arquivos.set(reg, registro); }
  const escritas = [];
  const stat = p => {
    if (pastas.has(p)) return {dev: p === RAIZ + '/data' ? 2 : 1, isDirectory: () => true, isSymbolicLink: () => false};
    if (arquivos.has(p)) return {dev: 2, isDirectory: () => false, isSymbolicLink: () => false};
    throw enoent();
  };
  const discoFs = {
    lstatSync: stat, statSync: stat,
    readFileSync(p) { if (!arquivos.has(p)) throw enoent(); return arquivos.get(p); },
    mkdirSync(p, o) { assert.equal(o.mode, 0o700); pastas.add(p); },
    writeFileSync(p, conteudo, o) {
      assert.equal(p, reg, 'só o registro é gravado'); assert.equal(o.mode, 0o600);
      if (o.flag === 'wx') { if (falhaWx) throw falhaWx(); if (arquivos.has(p)) throw eexist(); }
      arquivos.set(p, conteudo); escritas.push({conteudo, flag: o.flag ?? 'w'});
    },
  };
  return {discoFs, escritas, registro: () => arquivos.get(reg)};
}
/** Transporte simulado (contrato de lib/acessos/email.ts) que conta as chamadas. */
function transporte({falha = null, resposta = {provedor: 'resend', idExterno: 'id-sintetico-provedor'}} = {}) {
  const mensagens = [];
  let carregou = 0;
  return {mensagens, carregou: () => carregou, carregar: async () => {
    carregou++;
    return {situacaoEmail: () => ({configurado: true, provedor: 'resend', motivo: null}),
      criarEnviarEmail: () => async m => { mensagens.push(m); if (falha) throw falha(); return resposta; }};
  }};
}
const opcoes = (d, t, env = ENV) => ({env, raiz: RAIZ, discoFs: d.discoFs, carregar: t.carregar, uuid: () => '00000000-0000-4000-8000-000000000000'});
async function cli(argv, o) { const linhas = []; const codigo = await e.executar(argv, o, l => linhas.push(l)); return {codigo, saida: linhas.join('\n'), json: JSON.parse(linhas.at(-1))}; }

test('transporte fixado = lib/acessos/email.ts e erros.ts desta árvore (LF), o mesmo módulo do app', () => {
  for (const [rel, h] of Object.entries(e.TRANSPORTE)) {
    const b = fs.readFileSync(path.join(root, rel));
    assert.ok(!b.includes(13), rel + ' sem CR'); assert.equal(sha(b), h, rel);
  }
  assert.match(fs.readFileSync(path.join(root, 'lib/acessos/email.ts'), 'utf8'), /import \{ erroAcesso \} from '\.\/erros\.ts'/);
});

test('guarda de alvo: outro serviço, staging, fora do Render ou sem RENDER_SERVICE_ID recusam com código 1 antes de ler disco', async () => {
  for (const o of [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, {RENDER_SERVICE_ID: undefined}, {RENDER: undefined}, {KIDMAIS_DEPLOY_ENV: 'staging'}, {KIDMAIS_DEPLOY_ENV: undefined}]) {
    const lido = [];
    const d = {discoFs: new Proxy({}, {get: (_, k) => () => { lido.push(k); throw new Error('DISCO_NAO_DEVERIA_SER_LIDO'); }})};
    const t = transporte();
    for (const modo of ['--conferir', '--enviar-autorizado']) {
      const r = await cli([modo], opcoes(d, t, {...ENV, ...o}));
      assert.equal(r.codigo, 1, JSON.stringify(o)); assert.equal(r.json.resultado, 'RECUSADO_NADA_GRAVADO_NADA_ENVIADO');
    }
    assert.deepEqual(lido, []); assert.equal(t.carregou(), 0); assert.equal(t.mensagens.length, 0);
  }
  assert.equal((await cli(['--enviar-autorizado'], opcoes(disco(), transporte(), {...ENV, RENDER_SERVICE_ID: 'srv-outro'}))).json.motivo, 'SERVICO_RECUSADO');
});

test('env do e-mail ausente ou inválida recusa (código 1), sem gravar nem enviar', async () => {
  const casos = [[{EMAIL_PROVIDER: undefined}, 'EMAIL_PROVIDER_DIVERGENTE'], [{EMAIL_PROVIDER: 'arquivo'}, 'EMAIL_PROVIDER_DIVERGENTE'], [{EMAIL_PROVIDER: 'Resend'}, 'EMAIL_PROVIDER_DIVERGENTE'],
    [{EMAIL_REMETENTE: undefined}, 'EMAIL_REMETENTE_DIVERGENTE'], [{EMAIL_REMETENTE: 'nao-responda@notificacoes.kidmaisfestas.com'}, 'EMAIL_REMETENTE_DIVERGENTE'],
    [{EMAIL_REMETENTE: 'Kidmais Manager <onboarding@resend.dev>'}, 'EMAIL_REMETENTE_DIVERGENTE'],
    [{RESEND_API_KEY: undefined}, 'RESEND_API_KEY_AUSENTE'], [{RESEND_API_KEY: ''}, 'RESEND_API_KEY_AUSENTE'], [{RESEND_API_KEY: 'sk_abcdefghijkl'}, 'RESEND_API_KEY_FORMATO'],
    [{RESEND_API_KEY: 're_curta'}, 'RESEND_API_KEY_FORMATO'], [{RESEND_API_KEY: ' re_abcdefghijklmnop'}, 'RESEND_API_KEY_FORMATO'], [{RESEND_API_KEY: 're_abc def ghijklmn'}, 'RESEND_API_KEY_FORMATO']];
  for (const [o, motivo] of casos) {
    const d = disco(), t = transporte(), r = await cli(['--enviar-autorizado'], opcoes(d, t, {...ENV, ...o}));
    assert.equal(r.codigo, 1); assert.equal(r.json.motivo, motivo, JSON.stringify(o));
    assert.equal(d.escritas.length, 0); assert.equal(t.mensagens.length, 0);
  }
});

test('flags da venda: ligada ou valor inesperado recusa; ausente, vazia ou "false" passa e aparece no CONFERIR', async () => {
  for (const k of e.FLAGS_VENDA) {
    for (const [v, motivo] of [['true', 'FLAG_VENDA_LIGADA ' + k], [' TRUE ', 'FLAG_VENDA_LIGADA ' + k], ['1', 'FLAG_VENDA_VALOR_INESPERADO ' + k], ['sim', 'FLAG_VENDA_VALOR_INESPERADO ' + k]]) {
      const d = disco(), t = transporte(), r = await cli(['--enviar-autorizado'], opcoes(d, t, {...ENV, [k]: v}));
      assert.equal(r.codigo, 1); assert.equal(r.json.motivo, motivo); assert.equal(d.escritas.length, 0); assert.equal(t.mensagens.length, 0);
    }
  }
  const r = await cli(['--conferir'], opcoes(disco(), transporte(), {...ENV, CADASTRO_PUBLICO_ATIVO: 'false', ASSINATURA_PLANOS_ATIVOS: '', RECUPERACAO_SENHA_ATIVA: undefined}));
  assert.equal(r.codigo, 0, r.saida);
  assert.deepEqual(r.json.flags, {CADASTRO_PUBLICO_ATIVO: 'desligada', ASSINATURA_PLANOS_ATIVOS: 'desligada', RECUPERACAO_SENHA_ATIVA: 'desligada'});
});

test('CONFERIR: somente leitura (nada gravado, nada enviado), chave só como presença/tamanho/prefixo', async () => {
  const d = disco(), t = transporte(), r = await cli(['--conferir'], opcoes(d, t));
  assert.equal(r.codigo, 0); assert.equal(r.json.resultado, 'CONFERIDO_PRONTO_PARA_ENVIO');
  assert.deepEqual(r.json.chave, {presente: true, tamanho: CHAVE.length, prefixoRe: true});
  assert.equal(r.json.destinatario, 'contato@demerzellabs.com.br'); assert.equal(r.json.transporte, 'CONFERIDO');
  assert.equal(d.escritas.length, 0); assert.equal(t.mensagens.length, 0); assert.equal(t.carregou(), 1);
  assert.ok(!r.saida.includes(CHAVE));
});

test('transporte do deploy divergente/ausente, disco não montado ou pasta-link recusam com código 1', async () => {
  const casos = [[{transporte: {'lib/acessos/email.ts': Buffer.from('// outro\n')}}, 'TRANSPORTE_DIVERGENTE EMAIL'],
    [{transporte: {'lib/acessos/erros.ts': Buffer.from('// outro\n')}}, 'TRANSPORTE_DIVERGENTE ERROS'], [{montado: false}, 'DISCO_PERSISTENTE_AUSENTE']];
  for (const [o, motivo] of casos) {
    for (const modo of ['--conferir', '--enviar-autorizado']) {
      const d = disco(o), t = transporte(), r = await cli([modo], opcoes(d, t));
      assert.equal(r.codigo, 1); assert.equal(r.json.motivo, motivo); assert.equal(d.escritas.length, 0); assert.equal(t.mensagens.length, 0);
    }
  }
  const d = disco(); const lstat = d.discoFs.lstatSync;
  d.discoFs.lstatSync = p => p.endsWith(e.PASTA_REL) ? {isDirectory: () => true, isSymbolicLink: () => true} : lstat(p);
  const r = await cli(['--enviar-autorizado'], opcoes(d, transporte()));
  assert.equal(r.codigo, 1); assert.equal(r.json.motivo, 'PASTA_REGISTRO_RECUSADA');
  const semModulo = await cli(['--enviar-autorizado'], {...opcoes(disco(), transporte()), carregar: async () => { throw new Error('import'); }});
  assert.equal(semModulo.codigo, 1); assert.equal(semModulo.json.motivo, 'TRANSPORTE_NAO_CARREGOU');
  const naoConfig = await cli(['--enviar-autorizado'], {...opcoes(disco(), transporte()), carregar: async () => ({criarEnviarEmail: () => null, situacaoEmail: () => ({configurado: false, provedor: 'resend'})})});
  assert.equal(naoConfig.codigo, 1); assert.equal(naoConfig.json.motivo, 'EMAIL_NAO_CONFIGURADO_NO_PRODUTO');
});

test('ENVIAR: UMA mensagem ao destinatário fixo, sem link, intenção gravada (wx 0600) antes do envio, registro final com id', async () => {
  const d = disco(), t = transporte(), r = await cli(['--enviar-autorizado'], opcoes(d, t));
  assert.equal(r.codigo, 0, r.saida);
  assert.deepEqual(r.json, {resultado: 'ACEITO_PROVEDOR_ENTREGA_PENDENTE', provedor: 'resend', idExterno: 'id-sintetico-provedor', destinatario: 'contato@demerzellabs.com.br',
    servico: 'srv-dak77m2d0e5s73b8rkkg', commit: ENV.RENDER_GIT_COMMIT, registro: 'data/lancamento-email-producao-20261020/teste-envio.json', registroFinal: 'GRAVADO',
    chave: {presente: true, tamanho: CHAVE.length, prefixoRe: true}});
  assert.equal(t.mensagens.length, 1);
  const m = t.mensagens[0];
  assert.equal(m.para, 'contato@demerzellabs.com.br'); assert.equal(m.assunto, e.ASSUNTO);
  assert.equal(m.idempotencia, 'kidmais-email-producao-20261020/00000000-0000-4000-8000-000000000000');
  assert.doesNotMatch(m.texto + m.html, /https?:|href|token|senha/i);
  assert.equal(d.escritas.length, 2); assert.equal(d.escritas[0].flag, 'wx');
  assert.equal(JSON.parse(d.escritas[0].conteudo).situacao, 'ENVIO_PREPARADO');
  assert.deepEqual(Object.keys(JSON.parse(d.registro())).sort(), ['commit', 'destinatario', 'em', 'idExterno', 'idempotencia', 'servico', 'situacao']);
  assert.equal(JSON.parse(d.registro()).situacao, 'ACEITO_PROVEDOR_ENTREGA_PENDENTE');
  assert.ok(!d.registro().includes(CHAVE));
});

test('sem parâmetro de destinatário: argumentos extras ou desconhecidos recusam; --plano não lê ambiente', async () => {
  for (const argv of [[], ['--enviar-autorizado', 'outro@example.com'], ['--para=outro@example.com'], ['--enviar'], ['--conferir', '--enviar-autorizado']]) {
    const r = await cli(argv, opcoes(disco(), transporte()));
    assert.equal(r.codigo, 1); assert.equal(r.json.motivo, 'ARGUMENTOS_RECUSADOS');
  }
  const p = await cli(['--plano'], {env: {}});
  assert.equal(p.codigo, 0); assert.equal(p.json.destinatario, 'contato@demerzellabs.com.br'); assert.deepEqual(p.json.transporte, {...e.TRANSPORTE});
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'email-producao-20261020.cjs'), 'utf8'), /process\.argv\.slice\(3\)|DESTINATARIO\s*=\s*(?:env|process|argv)/);
});

test('falha do provedor: uma chamada, sem retentativa, registro NAO_REPETIR (código 2); recusa HTTP distinguida de incerto', async () => {
  const casos = [[() => Object.assign(new Error('O provedor de e-mail não respondeu. Nada foi enviado.'), {code: 'EMAIL_FALHOU'}), 'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR'],
    [() => Object.assign(new Error('O provedor de e-mail recusou o envio. Nada foi enviado.'), {code: 'EMAIL_FALHOU'}), 'RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR'],
    [() => new Error('falha qualquer ' + CHAVE), 'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR']];
  for (const [falha, situacao] of casos) {
    const d = disco(), t = transporte({falha}), r = await cli(['--enviar-autorizado'], opcoes(d, t));
    assert.equal(r.codigo, 2); assert.equal(r.json.resultado, 'ENVIO_NAO_CONCLUIDO_NAO_REPETIR'); assert.equal(r.json.motivo, situacao);
    assert.equal(t.mensagens.length, 1, 'nenhuma retentativa'); assert.equal(JSON.parse(d.registro()).situacao, situacao);
    assert.ok(!r.saida.includes(CHAVE) && !d.registro().includes(CHAVE));
  }
  for (const resposta of [{provedor: 'resend', idExterno: null}, {provedor: 'arquivo', idExterno: 'x'}, {provedor: 'resend', idExterno: 'id com espaco'}]) {
    const d = disco(), t = transporte({resposta}), r = await cli(['--enviar-autorizado'], opcoes(d, t));
    assert.equal(r.codigo, 2); assert.equal(r.json.motivo, 'ACEITO_SEM_IDENTIFICADOR_NAO_REPETIR'); assert.equal(t.mensagens.length, 1);
  }
});

test('replay: registro existente recusa (código 3) antes de carregar o transporte, em CONFERIR e ENVIAR; corrida no wx também', async () => {
  for (const registro of ['{"situacao":"ACEITO_PROVEDOR_ENTREGA_PENDENTE"}', '{"situacao":"ENVIO_PREPARADO"}', '']) {
    for (const modo of ['--conferir', '--enviar-autorizado']) {
      const d = disco({registro}), t = transporte(), r = await cli([modo], opcoes(d, t));
      assert.equal(r.codigo, 3); assert.equal(r.json.resultado, 'REPLAY_RECUSADO_NADA_ENVIADO'); assert.equal(r.json.motivo, 'REGISTRO_JA_EXISTE_REPLAY_RECUSADO');
      assert.equal(t.carregou(), 0); assert.equal(t.mensagens.length, 0); assert.equal(d.escritas.length, 0); assert.equal(d.registro(), registro);
    }
  }
  const d = disco({falhaWx: eexist}), t = transporte(), r = await cli(['--enviar-autorizado'], opcoes(d, t));
  assert.equal(r.codigo, 3); assert.equal(t.mensagens.length, 0);
  const d2 = disco(), t2 = transporte();
  assert.equal((await cli(['--enviar-autorizado'], opcoes(d2, t2))).codigo, 0);
  const segunda = await cli(['--enviar-autorizado'], opcoes(d2, t2));
  assert.equal(segunda.codigo, 3); assert.equal(t2.mensagens.length, 1, 'a segunda execução não envia');
});

test('transporte TypeScript REAL do produto com rede simulada: uma chamada à API do Resend, cabeçalhos certos, sem vazar a chave', async () => {
  const modulo = await import(pathToFileURL(path.join(root, 'lib/acessos/email.ts')).href);
  for (const [status, corpo, codigo, motivo] of [[200, {id: 'id-mock-produto'}, 0, null], [422, {message: 'invalid ' + CHAVE}, 2, 'RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR'], [500, {}, 2, 'RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR'], [0, null, 2, 'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR']]) {
    const chamadas = [];
    const rede = async (url, init) => {
      chamadas.push({url, init});
      if (status === 0) throw new Error('timeout ' + CHAVE);
      return new Response(JSON.stringify(corpo), {status});
    };
    const avisos = [], warn = console.warn; console.warn = (...a) => avisos.push(a.join(' '));
    const d = disco();
    let r;
    try { r = await cli(['--enviar-autorizado'], {...opcoes(d, {carregar: null}), carregar: async () => ({situacaoEmail: modulo.situacaoEmail, criarEnviarEmail: env => modulo.criarEnviarEmail(env, rede)})}); }
    finally { console.warn = warn; }
    assert.equal(r.codigo, codigo, r.saida); assert.equal(chamadas.length, 1, 'uma chamada, sem retentativa');
    const {url, init} = chamadas[0], body = JSON.parse(init.body);
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer ' + CHAVE, 'a chave só vai no cabeçalho para o provedor');
    assert.equal(init.headers['Idempotency-Key'], 'kidmais-email-producao-20261020/00000000-0000-4000-8000-000000000000');
    assert.equal(body.from, ENV.EMAIL_REMETENTE); assert.deepEqual(body.to, ['contato@demerzellabs.com.br']); assert.equal(body.subject, e.ASSUNTO);
    if (codigo === 0) assert.equal(r.json.idExterno, 'id-mock-produto'); else assert.equal(r.json.motivo, motivo);
    for (const texto of [r.saida, d.registro(), ...avisos]) assert.ok(!texto.includes(CHAVE), 'chave fora da saída, do registro e dos logs');
    assert.doesNotMatch(r.saida, /Authorization|Bearer|Idempotency-Key|invalid/);
  }
});

test('sigilo na CLI real: processo com a chave sintética recusa fora de /opt sem imprimir a chave em stdout/stderr', () => {
  for (const argv of [['--conferir'], ['--enviar-autorizado'], ['--enviar-autorizado', 'x']]) {
    const env = {...process.env, ...ENV};
    for (const k of Object.keys(env)) if (/^(DATABASE_|PG)/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, ['--experimental-strip-types', path.join(__dirname, 'email-producao-20261020.cjs'), ...argv], {encoding: 'utf8', env});
    const saida = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 1, saida); assert.ok(!saida.includes(CHAVE));
    assert.match(r.stdout, /"resultado":"RECUSADO_NADA_GRAVADO_NADA_ENVIADO"/);
  }
});
