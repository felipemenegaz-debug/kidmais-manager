/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in: restaura SOMENTE o banco sintético do runner a partir do modelo 063 já construído.
 * Nenhum .env, banco real, e-mail ou serviço Render. Usa a receita que prova cluster/porta/usuário antes de escrever.
 * Execute com os três KIDMAIS_* de autorização do descartável e Playwright disponível.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

async function principal() {
  const base = 'http://localhost:3137';
  for (const nome of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (fs.existsSync(nome)) throw Error('E2E_RECUSA_ARQUIVO_ENV');
  }
  await new Promise((resolve, reject) => {
    const prova = require('node:net').createServer();
    prova.once('error', () => reject(Error('E2E_PORTA_WEB_OCUPADA')));
    prova.listen(3137, '127.0.0.1', () => prova.close(resolve));
  });
  const playwright = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
  const { carregarModulo } = await import('../lib/acessos/teste-carregador.ts');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve('.local-painel-multi-ui');
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
    const cache = new Map();
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache);
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const email = 'multi-ui@exemplo.test';
    const senha = carregar('lib/autenticacao/senha.ts');
    const user = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES($1,'Pessoa Multi UI',$2,'ADMINISTRATIVO') RETURNING id`, [email, await senha.criarHashSenha(password)])).rows[0].id;
    const empresas = [];
    for (const [nome, papel] of [['Alfa UI', 'REPRESENTANTE_AUTORIZADO'], ['Beta UI', 'ADMINISTRATIVO']]) {
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`,
        [`ui-${randomBytes(5).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      if (papel === 'REPRESENTANTE_AUTORIZADO') {
        const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
          VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [id, user, papel])).rows[0].id;
        await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
      }
      await client.query('INSERT INTO clientes(empresa_id,nome_completo) VALUES($1,$2)', [id, `Cliente exclusivo ${nome}`]);
      empresas.push(id);
    }
    const convite = await withTransaction(tx => carregar('lib/acessos/convites.ts').criarConviteNaTransacao(tx,
      { gerarToken: () => randomBytes(32).toString('base64url') },
      { empresaId: empresas[1], email, nomeSugerido: null, papel: 'ADMINISTRATIVO', criadoPor: user }));
    // O token permanece só em memória. Não se configura provedor de e-mail para este ensaio.
    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3137'],
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
    async function login() {
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
    }
    async function clientes(nome, ausente) {
      await page.goto(`${base}/clientes`);
      await page.getByText(`Cliente exclusivo ${nome}`, { exact: true }).first().waitFor();
      assert.equal(await page.getByText(`Cliente exclusivo ${ausente}`, { exact: true }).count(), 0);
    }
    async function trocar(id) {
      await Promise.all([page.waitForEvent('load'), page.getByLabel('Empresa ativa', { exact: true }).first().selectOption(id)]);
      await page.waitForURL(`${base}/admin/dashboard`);
    }
    await login();
    console.log('E2E_LOGIN_INICIAL_OK');
    await clientes('Alfa UI', 'Beta UI');
    await page.goto(`${base}/acesso/convite#t=${convite.token}`);
    await page.getByLabel('Senha atual', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Aceitar convite', exact: true }).click();
    await page.getByText('Pronto!', { exact: false }).waitFor();
    resultados.push('Conta existente aceitou convite para Beta pela interface');
    console.log('E2E_CONVITE_OK');
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('heading', { name: 'Empresa ativa', exact: true }).waitFor();
    await trocar(empresas[0]);
    await clientes('Alfa UI', 'Beta UI');
    assert.equal(await page.getByRole('link', { name: 'Usuários e acessos', exact: true }).count(), 1);
    const antiga = await contexto.request.get(`${base}/api/admin/autenticacao`).then(r => r.json());
    const cookiesAntigos = await contexto.cookies();
    const outraAba = await contexto.newPage();
    await outraAba.goto(`${base}/clientes`);
    await outraAba.getByText('Cliente exclusivo Alfa UI', { exact: true }).first().waitFor();
    await trocar(empresas[1]);
    await clientes('Beta UI', 'Alfa UI');
    assert.equal(await page.getByRole('link', { name: 'Usuários e acessos', exact: true }).count(), 0);
    await outraAba.waitForURL(`${base}/admin/dashboard`);
    assert.equal(await outraAba.getByText('Cliente exclusivo Alfa UI', { exact: true }).count(), 0);
    const atual = await contexto.request.get(`${base}/api/admin/autenticacao`).then(r => r.json());
    assert.equal(atual.data.contexto.empresaAtual.id, empresas[1]);
    assert.equal(atual.data.contexto.gestaoNaEmpresa, false);
    const acessoCruzado = await contexto.request.get(`${base}/api/admin/clientes?empresaId=${empresas[0]}`);
    assert.equal(acessoCruzado.status(), 403);
    const permissao = await contexto.request.get(`${base}/api/admin/configuracoes/usuarios`);
    assert.equal(permissao.status(), 403);
    const velha = await contexto.request.get(`${base}/api/admin/clientes`, { headers: { 'x-kidmais-sessao': antiga.data.sessaoId } });
    assert.equal(velha.status(), 409);
    const csrf = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base }, data: { acao: 'selecionar-empresa', empresaId: empresas[0] } });
    assert.equal(csrf.status(), 403);
    const naoMembro = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': atual.data.csrf },
      data: { acao: 'selecionar-empresa', empresaId: '00000000-0000-4000-8000-0000000000ff' } });
    assert.equal(naoMembro.status(), 403);
    const oldContext = await browser.newContext();
    await oldContext.addCookies(cookiesAntigos);
    assert.equal((await oldContext.request.get(`${base}/api/admin/clientes`)).status(), 401);
    await oldContext.close();
    resultados.push('Gestão em Alfa / Equipe em Beta: menu, API, clientes e aba antiga isolados; CSRF e sessão antiga recusados');
    console.log('E2E_ALTERNANCIA_OK');
    await page.screenshot({ path: path.join(relatorios, 'beta-equipe.png'), fullPage: true });
    await trocar(empresas[0]);
    await clientes('Alfa UI', 'Beta UI');
    await page.screenshot({ path: path.join(relatorios, 'alfa-gestao.png'), fullPage: true });
    resultados.push('Retorno a Alfa sem dados ou permissões de Beta');
    await client.query("UPDATE empresas SET status='SUSPENSA' WHERE id=$1", [empresas[0]]);
    await page.reload();
    await page.waitForURL(`${base}/admin/login`);
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresas[0]]);
    await login();
    await page.getByRole('heading', { name: 'Empresa ativa', exact: true }).waitFor();
    resultados.push('Suspensão encerrou seleção; reativação não restaurou a sessão/empresa antiga');
    await trocar(empresas[1]);
    await client.query("UPDATE memberships SET status='REVOGADA' WHERE usuario_id=$1 AND empresa_id=$2", [user, empresas[1]]);
    await page.reload();
    await page.waitForURL(`${base}/admin/login`);
    resultados.push('Revogação invalidou a sessão selecionada');
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
principal().catch(e => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n')[0].replace(/#t=[A-Za-z0-9_-]+/g, '#t=[REMOVIDO]')); process.exitCode = 1; });
