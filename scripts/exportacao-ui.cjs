/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da exportação verificável no navegador, com PostgreSQL DESCARTÁVEL e dados sintéticos (modelo 088).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 088 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail, provedor ou serviço Render. Execute com os três KIDMAIS_* de autorização
 * do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 *   - Gestão de empresa ATIVA: /admin/assinatura → "Baixar pacote completo (ZIP)" → arquivo baixado; manifesto, hashes,
 *     linhas e o código de conferência mostrado na tela conferem; links CSV avulsos continuam.
 *   - Equipe: 403 no pacote.
 *   - Gestão de empresa SUSPENSA: tela "Sem empresa ativa" oferece o pacote da suspensa; o download confere.
 *   - Celular (390 px): sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3157;
const sha = (b) => createHash('sha256').update(b).digest('hex');

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
  const { lerZip } = await import('../lib/exportacao/zip.ts');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve(process.env.KIDMAIS_EXPORTACAO_UI_RELATORIOS || '.local-exportacao-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [receita.MODELOS['088'].banco])).rows.length > 0;
    if (!existe) await receita.construirModelo(admin, porta, '088');
    await receita.restaurar(admin, receita.TRABALHO[0], '088');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
    const senhaMod = carregar('lib/autenticacao/senha.ts');
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const hash = await senhaMod.criarHashSenha(password);
    const pessoa = async (email, nome) => {
      const id = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [email, nome, hash])).rows[0].id;
      await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [id]);
      return id;
    };
    const empresa = async (nome) => {
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`ex-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      return id;
    };
    const vinculo = async (empresaId, usuarioId, papel) => {
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [empresaId, usuarioId, papel])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
    };
    const A = await empresa('Buffet Exporta UI');
    const S = await empresa('Buffet Suspenso UI');
    const gestaoA = await pessoa('gestao-exporta-ui@exemplo.test', 'Gestão Exporta UI');
    const equipeA = await pessoa('equipe-exporta-ui@exemplo.test', 'Equipe Exporta UI');
    const gestaoS = await pessoa('gestao-suspensa-ui@exemplo.test', 'Gestão Suspensa UI');
    await vinculo(A, gestaoA, 'REPRESENTANTE_AUTORIZADO');
    await vinculo(A, equipeA, 'ADMINISTRATIVO');
    await vinculo(S, gestaoS, 'REPRESENTANTE_AUTORIZADO');
    for (const [e, n] of [[A, 'Cliente Exporta UI 1'], [A, 'Cliente Exporta UI 2'], [S, 'Cliente Suspenso UI']])
      await client.query('INSERT INTO clientes(nome_completo, empresa_id) VALUES($1,$2)', [n, e]);
    await client.query("UPDATE empresas SET status='SUSPENSA' WHERE id=$1", [S]);

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 180; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.status < 500).catch(() => false)) break;
      if (n === 179) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });

    async function entrar(email) {
      const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      contexto.setDefaultTimeout(90000);
      const page = await contexto.newPage();
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
      return { contexto, page };
    }
    async function conferirPacote(download, codigoNaTela, empresaId, nomeArquivo) {
      const destino = path.join(relatorios, nomeArquivo);
      await download.saveAs(destino);
      const zip = fs.readFileSync(destino);
      const arquivos = lerZip(zip);
      const manifestoBuf = arquivos.get('MANIFESTO.json');
      assert.equal(sha(manifestoBuf), codigoNaTela, 'código de conferência da tela = SHA-256 do MANIFESTO baixado');
      const m = JSON.parse(manifestoBuf.toString('utf8'));
      assert.equal(m.empresa.id, empresaId);
      for (const a of m.arquivos) assert.equal(sha(arquivos.get(a.caminho)), a.sha256, a.caminho);
      const auditado = (await client.query(`SELECT dados_depois->>'manifestoSha256' AS h FROM auditoria WHERE acao='EXPORTACAO_DADOS' AND entidade_id=$1 ORDER BY criado_em DESC LIMIT 1`, [empresaId])).rows[0];
      assert.equal(auditado.h, codigoNaTela, 'auditoria guarda o mesmo hash');
      return m;
    }

    // Gestão da empresa ativa: botão na tela Assinatura.
    {
      const { contexto, page } = await entrar('gestao-exporta-ui@exemplo.test');
      await page.goto(`${base}/admin/assinatura`);
      await page.getByRole('heading', { name: 'Exportar dados', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Clientes (CSV)', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Contas a receber (CSV)', exact: true }).waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar pacote completo (ZIP)', exact: true }).click()]);
      await page.locator('[data-exportacao-pronta]').waitFor();
      const codigo = (await page.locator('[data-manifesto-sha256]').innerText()).trim();
      assert.match(download.suggestedFilename(), /^kidmais-exportacao-ex-[0-9a-f]{6}-\d{8}T\d{6}Z\.zip$/);
      const m = await conferirPacote(download, codigo, A, 'ativa.zip');
      assert.equal(m.arquivos.find(a => a.entidade === 'clientes/clientes').linhas, 2);
      await page.screenshot({ path: path.join(relatorios, 'assinatura-exportacao.png'), fullPage: true });
      // CSV avulso continua.
      const csv = await contexto.request.get(`${base}/api/admin/exportacao?tipo=clientes`);
      assert.equal(csv.status(), 200);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/admin/assinatura`);
      await page.getByRole('button', { name: 'Baixar pacote completo (ZIP)', exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem horizontal no celular');
      await page.screenshot({ path: path.join(relatorios, 'celular-exportacao.png'), fullPage: true });
      await contexto.close();
      resultados.push('Gestão (ativa): botão na tela Assinatura baixou o ZIP; código da tela = SHA-256 do MANIFESTO = auditoria; hashes e linhas conferem; CSV avulso 200; celular sem rolagem');
      console.log('E2E_EXPORTACAO_ATIVA_OK');
    }
    // Equipe: recusada.
    {
      const { contexto } = await entrar('equipe-exporta-ui@exemplo.test');
      const r = await contexto.request.get(`${base}/api/admin/exportacao?tipo=completa`);
      assert.equal(r.status(), 403);
      assert.equal((await r.json()).codigo, 'PAPEL_NAO_AUTORIZADO');
      await contexto.close();
      resultados.push('Equipe: 403 PAPEL_NAO_AUTORIZADO no pacote completo');
      console.log('E2E_EXPORTACAO_EQUIPE_OK');
    }
    // Gestão de empresa suspensa: tela "Sem empresa ativa" com o pacote da suspensa.
    {
      const { contexto, page } = await entrar('gestao-suspensa-ui@exemplo.test');
      await page.goto(`${base}/admin/dashboard`);
      await page.getByRole('heading', { name: 'Sem empresa ativa', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Exportar dados de empresa suspensa', exact: true }).waitFor();
      assert.equal((await contexto.request.get(`${base}/api/admin/clientes`)).status() >= 400, true, 'o resto continua fechado');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar pacote completo (ZIP)', exact: true }).click()]);
      await page.locator('[data-exportacao-pronta]').waitFor();
      const codigo = (await page.locator('[data-manifesto-sha256]').innerText()).trim();
      const m = await conferirPacote(download, codigo, S, 'suspensa.zip');
      assert.equal(m.empresa.situacao, 'SUSPENSA');
      assert.equal(m.arquivos.find(a => a.entidade === 'clientes/clientes').linhas, 1);
      await page.screenshot({ path: path.join(relatorios, 'suspensa-exportacao.png'), fullPage: true });
      // Sem empresaId a guarda não adivinha a suspensa.
      assert.equal((await contexto.request.get(`${base}/api/admin/exportacao?tipo=completa`)).status(), 403);
      await contexto.close();
      resultados.push('Gestão (suspensa): "Sem empresa ativa" oferece o pacote; download confere (situação SUSPENSA, 1 cliente); sem empresaId → 403; demais APIs continuam fechadas');
      console.log('E2E_EXPORTACAO_SUSPENSA_OK');
    }
    fs.writeFileSync(path.join(relatorios, 'resultados.txt'), `${resultados.join('\n')}\n`);
    console.log(`E2E_EXPORTACAO_OK (${resultados.length} roteiros)`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (servidor && servidor.exitCode === null) servidor.kill();
    if (client) await client.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

principal().catch((erro) => {
  console.error(erro instanceof Error ? erro.stack : String(erro));
  process.exit(1);
});
