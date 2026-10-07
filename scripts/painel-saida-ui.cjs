/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da saída da sessão com rede controlada (achado Astra, PR #104): o código real de components/admin/sair.ts
 * nos dois shells, com o Playwright interceptando só a rota de autenticação. Restaura SOMENTE o banco sintético do
 * runner a partir do modelo 063 (a receita prova cluster/porta/usuário antes de escrever). Nenhum .env, banco real,
 * e-mail (EMAIL_PROVIDER=desativado) ou serviço Render.
 * Execute com os três KIDMAIS_* de autorização do descartável, Playwright (KIDMAIS_PLAYWRIGHT_MODULE) e Chrome.
 *
 * Cenários (cada um confere o que o servidor registrou, não só a navegação):
 *   1. Saída confirmada (painel do desenvolvedor e Admin): um POST, login sem aviso, sessão encerrada no servidor;
 *      no painel, uma resposta tardia (401 do resumo chegando depois do clique) não muda o destino (sem ?voltar=).
 *   2. POST que nunca responde: botão em "Saindo…" (desabilitado) e, dentro do prazo, login com o aviso de prazo;
 *      a sessão continua válida no servidor e o aviso diz isso; nenhum segundo POST.
 *   3. POST recusado (500): login com o aviso "não confirmou"; sessão continua válida; sem repetição automática.
 *   4. CSRF recusado (403) e consulta prévia com 503: uma consulta, nenhum segundo POST, aviso "não confirmou".
 *   5. Sessão já encerrada no servidor: login sem aviso enganoso.
 *   6. Clique repetido: um único POST; nenhuma segunda navegação.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3141;
const PRAZO_SAIDA_MS = 8000;

async function principal() {
  const base = `http://localhost:${PORTA_WEB}`;
  for (const nome of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (fs.existsSync(nome)) throw Error('E2E_RECUSA_ARQUIVO_ENV');
  }
  await new Promise((resolve, reject) => {
    const prova = require('node:net').createServer();
    prova.once('error', () => reject(Error('E2E_PORTA_WEB_OCUPADA')));
    prova.listen(PORTA_WEB, '127.0.0.1', () => prova.close(resolve));
  });
  const playwright = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
  const { carregarModulo } = await import('../lib/acessos/teste-carregador.ts');
  const { alterarDesenvolvedor } = require('./admin-provision.cjs');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve('.local-painel-saida-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    const withTransaction = async (fn) => {
      await client.query('BEGIN');
      try { const r = await fn(client); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK'); throw e; }
    };
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, new Map());
    const senhaMod = carregar('lib/autenticacao/senha.ts');
    const sair = carregar('components/admin/sair.ts');
    assert.equal(sair.PRAZO_SAIDA_MS, PRAZO_SAIDA_MS, 'prazo da saída conhecido pelo roteiro');
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const emailDev = 'dev-saida-ui@exemplo.test', emailGestao = 'gestao-saida-ui@exemplo.test';
    const usuario = async (e, nome) => (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [e, nome, await senhaMod.criarHashSenha(password)])).rows[0].id;
    const dev = await usuario(emailDev, 'Dev Saída UI');
    const gestao = await usuario(emailGestao, 'Gestão Saída UI');
    await alterarDesenvolvedor(client, { operacao: 'conceder', email: emailDev, operador: 'E2E sintético', motivo: 'Teste da saída da sessão' });
    const codigo = `saida-ui-${randomBytes(3).toString('hex')}`;
    const empresa = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,'Contratante Saída UI','PROVISIONAMENTO') RETURNING id`, [codigo])).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresa]);
    const membership = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
      VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresa, gestao])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [membership]);
    const sessoesAbertas = async (usuarioId) => Number((await client.query('SELECT count(*)::int AS n FROM sessoes_administrativas WHERE usuario_id=$1 AND revogado_em IS NULL AND expira_em > clock_timestamp()', [usuarioId])).rows[0].n);

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME', 'RECUPERACAO_SENHA_ATIVA']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 120; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.ok).catch(() => false)) break;
      if (n === 119) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexto.setDefaultTimeout(60000);
    const page = await contexto.newPage();
    const sessaoAtual = () => contexto.request.get(`${base}/api/admin/autenticacao`).then(r => r.json());
    async function login(email) {
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
    }
    // Contagem das requisições reais de autenticação feitas pela página (as interceptadas sem resposta também contam).
    const pedidos = [];
    const cargasDoLogin = [];
    const respostasTardias = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/admin/autenticacao')) pedidos.push({ metodo: r.method(), corpo: r.postData() || '' });
      if (r.isNavigationRequest() && r.resourceType() === 'document' && new URL(r.url()).pathname === '/admin/login') cargasDoLogin.push(r.url());
    });
    page.on('response', (r) => { if (r.url().includes('/api/desenvolvedor/resumo') && r.status() === 401) respostasTardias.push(r.url()); });
    const logoutsEnviados = () => pedidos.filter(p => p.metodo === 'POST' && /"acao":"logout"/.test(p.corpo)).length;
    const consultas = () => pedidos.filter(p => p.metodo === 'GET').length;
    const zerar = () => { pedidos.length = 0; };
    const botaoSair = () => page.getByRole('button', { name: /^Sair$/ }).first();
    const noLogin = (url) => url.pathname === '/admin/login';
    const avisoNoLogin = async () => {
      await page.waitForURL(noLogin);
      const aviso = page.locator('[data-aviso-contexto]');
      return (await aviso.count()) ? (await aviso.innerText()).replace(/\s*×\s*$/, '').trim() : null;
    };
    const semAviso = (texto) => texto === null || !/sessão/i.test(texto);
    const corpoLogout = (route) => route.request().method() === 'POST' && /"acao":"logout"/.test(route.request().postData() || '');

    // 1. Saída confirmada: painel do desenvolvedor (com resposta tardia do resumo) e Admin.
    await login(emailDev);
    // O resumo demora 1,5 s e a página de login demora 3 s a chegar: a página antiga continua viva quando o 401 do
    // resumo chega depois do logout — sem a marca de saída, cliente.ts levaria a /admin/login?voltar=/desenvolvedor.
    await page.route('**/api/desenvolvedor/resumo', async (route) => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    await page.route('**/admin/login', async (route) => {
      if (route.request().resourceType() === 'document') await new Promise(r => setTimeout(r, 3000));
      await route.continue();
    });
    await page.goto(`${base}/desenvolvedor`);
    await page.getByRole('heading', { name: 'Resumo da plataforma', exact: true }).waitFor();
    await page.getByText('Sem empresa com acesso ativo no Admin', { exact: false }).waitFor(); // contexto lido: CSRF lembrado
    zerar(); cargasDoLogin.length = 0; respostasTardias.length = 0;
    await botaoSair().click();
    const aviso1 = await avisoNoLogin();
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(semAviso(aviso1), `saída confirmada não deixa aviso: ${aviso1}`);
    assert.equal(logoutsEnviados(), 1, 'um único POST de logout');
    assert.equal(consultas(), 0, 'sem consulta prévia: o CSRF da tela é reaproveitado');
    assert.equal(new URL(page.url()).search, '', 'a resposta tardia (401 do resumo) não levou a /admin/login?voltar=…');
    assert.ok(respostasTardias.length >= 1, 'o 401 tardio do resumo chegou à página antiga depois do logout (StrictMode em dev pode pedir duas vezes)');
    assert.deepEqual(cargasDoLogin, [`${base}/admin/login`], 'uma única carga do login, sem ?voltar=');
    assert.equal((await sessaoAtual()).data.usuarioId, null, 'sessão encerrada no servidor');
    assert.equal(await sessoesAbertas(dev), 0);
    await page.unroute('**/api/desenvolvedor/resumo');
    await page.unroute('**/admin/login');
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    zerar();
    await botaoSair().click();
    assert.ok(semAviso(await avisoNoLogin()));
    assert.equal(logoutsEnviados(), 1);
    assert.equal((await sessaoAtual()).data.usuarioId, null);
    assert.equal(await sessoesAbertas(gestao), 0);
    resultados.push('Saída confirmada (painel e Admin): um POST com o CSRF da tela, login sem aviso, sessão encerrada no servidor');
    console.log('E2E_SAIDA_CONFIRMADA_OK');

    // 2. POST que nunca responde.
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    const presos = [];
    cargasDoLogin.length = 0;
    await page.route('**/api/admin/autenticacao', async (route) => { if (corpoLogout(route)) presos.push(route); else await route.continue(); });
    zerar();
    const inicio = Date.now();
    await botaoSair().click();
    const saindo = page.getByRole('button', { name: 'Saindo…', exact: true }).first();
    await saindo.waitFor({ timeout: 3000 });
    assert.equal(await saindo.isDisabled(), true, 'o botão mostra "Saindo…" e não aceita outro clique');
    await page.screenshot({ path: path.join(relatorios, 'saindo-pendente.png') });
    await page.waitForURL(noLogin, { timeout: PRAZO_SAIDA_MS + 4000 });
    const decorrido = Date.now() - inicio;
    assert.ok(decorrido >= PRAZO_SAIDA_MS - 500 && decorrido <= PRAZO_SAIDA_MS + 4000, `navegou dentro do prazo (${decorrido} ms)`);
    const aviso2 = await avisoNoLogin();
    assert.equal(aviso2, sair.AVISO_SAIDA_PRAZO, 'o aviso diz que o servidor não respondeu e que a sessão pode continuar aberta');
    assert.equal(logoutsEnviados(), 1, 'nenhum segundo POST');
    assert.equal(await sessoesAbertas(gestao), 1, 'a sessão continua válida no servidor (o pedido nunca chegou): o aviso é verdadeiro');
    await page.screenshot({ path: path.join(relatorios, 'login-aviso-prazo.png') });
    await page.unroute('**/api/admin/autenticacao');
    for (const r of presos) await r.abort().catch(() => undefined);
    assert.deepEqual(cargasDoLogin, [`${base}/admin/login`], 'uma única carga do login');
    resultados.push(`POST sem resposta: "Saindo…" desabilitado, login em ${decorrido} ms com o aviso de prazo, sessão ainda válida no servidor, um só POST`);
    console.log('E2E_SAIDA_PRAZO_OK');
    // A sessão sobrevivente é encerrada aqui pelo próprio banco sintético para o próximo cenário começar limpo.
    await client.query('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [gestao]);
    await contexto.clearCookies();

    // 3. POST recusado (500).
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (corpoLogout(route)) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Falha simulada.' }) });
      else await route.continue();
    });
    zerar();
    await botaoSair().click();
    const aviso3 = await avisoNoLogin();
    assert.equal(aviso3, sair.AVISO_SAIDA_NAO_CONFIRMADA);
    assert.equal(logoutsEnviados(), 1, 'sem repetição automática');
    assert.equal(await sessoesAbertas(gestao), 1, 'sessão continua válida: o aviso é verdadeiro');
    await page.unroute('**/api/admin/autenticacao');
    resultados.push('POST com 500: login com o aviso "não confirmou", um só POST, sessão ainda válida no servidor');
    console.log('E2E_SAIDA_RECUSADA_OK');
    await client.query('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [gestao]);
    await contexto.clearCookies();

    // 4. CSRF recusado e consulta prévia com 503.
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (corpoLogout(route)) await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Verificação CSRF recusada.' }) });
      else if (route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Indisponível.' }) });
      else await route.continue();
    });
    zerar();
    await botaoSair().click();
    const aviso4 = await avisoNoLogin();
    assert.equal(aviso4, sair.AVISO_SAIDA_NAO_CONFIRMADA);
    assert.equal(logoutsEnviados(), 1, 'depois do 403 a consulta falhou: nenhum segundo POST');
    assert.equal(consultas(), 1, 'uma única consulta prévia');
    assert.equal(await sessoesAbertas(gestao), 1);
    await page.unroute('**/api/admin/autenticacao');
    resultados.push('CSRF recusado (403) + consulta com 503: uma consulta, nenhum segundo POST, aviso "não confirmou"');
    console.log('E2E_SAIDA_CONSULTA_503_OK');
    await client.query('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [gestao]);
    await contexto.clearCookies();

    // 5. Sessão já encerrada no servidor (outro dispositivo saiu, ou expirou). O shell relê a sessão a cada 15 s e ao
    //    ganhar foco; para o clique acontecer antes de a página ir ao login sozinha (corrida do roteiro, não do produto),
    //    as leituras em segundo plano recebem a última resposta válida. O POST de saída vai ao servidor real (401).
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    await page.getByText('Gestão Saída UI', { exact: false }).first().waitFor(); // contexto lido: CSRF lembrado
    const ultimaValida = JSON.stringify(await sessaoAtual());
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ status: 200, contentType: 'application/json', body: ultimaValida });
      else await route.continue();
    });
    await client.query('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [gestao]);
    zerar();
    await botaoSair().click();
    const aviso5 = await avisoNoLogin();
    assert.ok(semAviso(aviso5), `sessão já encerrada não gera aviso enganoso: ${aviso5}`);
    assert.equal(logoutsEnviados(), 1, 'o POST foi enviado e respondido com 401');
    assert.equal(await sessoesAbertas(gestao), 0);
    await page.unroute('**/api/admin/autenticacao');
    resultados.push('Sessão já encerrada: login sem aviso enganoso');
    console.log('E2E_SAIDA_JA_ENCERRADA_OK');
    await contexto.clearCookies();

    // 6. Clique repetido: dois cliques no mesmo tick (antes do React desabilitar o botão) → uma saída.
    await login(emailGestao);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('navigation', { name: 'Menu administrativo', exact: true }).waitFor();
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (corpoLogout(route)) { await new Promise(r => setTimeout(r, 700)); await route.continue(); }
      else await route.continue();
    });
    zerar(); cargasDoLogin.length = 0;
    await botaoSair().evaluate((b) => { b.click(); b.click(); });
    assert.ok(semAviso(await avisoNoLogin()));
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(logoutsEnviados(), 1, 'clique repetido compartilha a mesma saída');
    assert.deepEqual(cargasDoLogin, [`${base}/admin/login`], 'uma única carga do login');
    assert.equal(await sessoesAbertas(gestao), 0, 'sessão encerrada');
    await page.unroute('**/api/admin/autenticacao');
    resultados.push('Clique repetido: um só POST, uma só navegação, sessão encerrada');
    console.log('E2E_SAIDA_CLIQUE_REPETIDO_OK');

    fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, emailReal: 'desativado', resultados }, null, 2));
    console.log(JSON.stringify({ ok: true, resultados }));
  } finally {
    await browser?.close();
    if (servidor && servidor.exitCode === null) {
      servidor.kill();
      await new Promise(r => servidor.once('exit', r));
    }
    fs.closeSync(logfile);
    await client?.end(); await admin.end();
  }
}
principal().catch(e => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n').slice(0, 6).join(' | ').replace(/#t=[A-Za-z0-9_-]+/g, '#t=[REMOVIDO]')); process.exitCode = 1; });
