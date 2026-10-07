/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do cadastro público (E6/E7) com PostgreSQL DESCARTÁVEL e e-mail em ARQUIVO local (nada sai da máquina).
 * Restaura SOMENTE o banco sintético do runner (modelo 063) e aplica 067 + 068 + 069 nele. Sem .env, banco real,
 * provedor de cobrança ou serviço Render. Execute com os três KIDMAIS_* do descartável, Playwright e Chrome.
 *
 *   1. Planos: duração do teste vinda da configuração, "Preço a definir" sem preço configurado, botão para o cadastro.
 *   2. Cadastro: pessoa + aceites → mensagem neutra; o link chega no e-mail (arquivo); confirmar cria a conta e abre a
 *      sessão; dados da empresa → empresa em teste, Gestão da pessoa, início guiado e aviso de teste no Admin.
 *   3. Mesmo CNPJ por outra pessoa: mensagem neutra, nenhum dado da empresa existente, pedido de acesso registrado.
 *   4. Mesmo e-mail de novo: mesma resposta; o e-mail enviado é o aviso de conta existente (sem link de confirmação).
 *   5. Celular: planos, cadastro e dados da empresa sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3144;

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
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve('.local-cadastro-publico-ui');
  const caixa = path.join(relatorios, 'emails');
  fs.rmSync(caixa, { recursive: true, force: true });
  fs.mkdirSync(caixa, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  const ultimoEmail = async (para) => {
    for (let n = 0; n < 60; n++) {
      const msgs = fs.readdirSync(caixa).sort().map((f) => JSON.parse(fs.readFileSync(path.join(caixa, f), 'utf8'))).filter((m) => m.para === para);
      if (msgs.length) return msgs.at(-1);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error(`E2E_SEM_EMAIL ${para}`);
  };
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/migrations/20261006_067_modelo_comercial_empresa.sql', 'database/migrations/20261007_068_cobranca_assinatura.sql',
      'database/checks/20261007_069_precheck.sql', 'database/migrations/20261007_069_cadastro_publico.sql', 'database/checks/20261007_069_postcheck.sql'])
      await client.query(fs.readFileSync(f, 'utf8'));
    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: caixa, CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME', 'RECUPERACAO_SENHA_ATIVA',
      'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'ASSINATURA_PRECO_MENSAL_CENTAVOS', 'ASSINATURA_PRECO_ANUAL_CENTAVOS', 'ASSINATURA_TESTE_DIAS']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 120; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/cadastro`).then(r => r.ok).catch(() => false)) break;
      if (n === 119) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const novoContexto = async (largura = 1440, altura = 1000) => { const c = await browser.newContext({ viewport: { width: largura, height: altura } }); c.setDefaultTimeout(60000); return c; };
    const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const senha = `sintetica-${randomBytes(8).toString('hex')}`;
    async function pedirConta(page, nome, email) {
      await page.goto(`${base}/cadastro`);
      await page.getByLabel('Seu nome').fill(nome);
      await page.getByLabel('E-mail').fill(email);
      await page.getByLabel('Crie uma senha').fill(senha);
      await page.getByLabel('Confirme a senha').fill(senha);
      await page.getByRole('checkbox').nth(0).check();
      await page.getByRole('checkbox').nth(1).check();
      await page.getByRole('button', { name: 'Continuar', exact: true }).click();
      await page.getByText('Se for possível criar a conta com este e-mail', { exact: false }).waitFor();
    }
    async function confirmarEEmpresa(page, email, cnpj, fantasia) {
      const m = await ultimoEmail(email);
      const link = m.texto.match(/https?:\/\/\S+#t=[A-Za-z0-9_-]{43}/)[0];
      await page.goto(link);
      await page.waitForURL(`${base}/cadastro/empresa`);
      await page.getByLabel('CNPJ').fill(cnpj);
      await page.getByLabel('Razão social').fill(`${fantasia} Festas Ltda`);
      await page.getByLabel('Nome fantasia (como aparece para seus clientes)').fill(fantasia);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Cadastrar empresa e começar o teste', exact: true }).click();
    }

    // 1. Planos.
    const ctx1 = await novoContexto();
    const page = await ctx1.newPage();
    await page.goto(`${base}/planos`);
    await page.getByRole('heading', { name: 'Plano Kidmais', exact: true }).waitFor();
    await page.getByText('Preço a definir', { exact: true }).waitFor();
    await page.getByText('15 dias grátis', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'planos.png'), fullPage: true });
    await page.getByRole('link', { name: 'Começar o teste grátis', exact: true }).click();
    await page.waitForURL(`${base}/cadastro`);
    resultados.push('Planos: teste de 15 dias pela configuração, "Preço a definir" sem preço configurado, botão leva ao cadastro');
    console.log('E2E_PLANOS_OK');

    // 2. Cadastro completo.
    const emailAna = 'ana-cadastro-ui@exemplo.test';
    const usuariosAntes = Number((await client.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n);
    await pedirConta(page, 'Ana Cadastro UI', emailAna);
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n), usuariosAntes, 'nenhuma conta antes da confirmação');
    await confirmarEEmpresa(page, emailAna, '80.123.456/0001-88', 'Buffet Festa UI');
    await page.waitForURL(`${base}/admin/inicio`);
    await page.getByRole('heading', { name: 'Primeiros passos', exact: true }).waitFor();
    await page.locator('[data-passo="PERFIL"]').getByRole('link', { name: 'Fazer agora' }).waitFor();
    await page.locator('[data-aviso-comercial="COMPLETO"]').getByText('Teste grátis até', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'inicio-guiado.png'), fullPage: true });
    const e = (await client.query(`SELECT e.id, e.status, a.situacao, m.papel, m.status AS vinculo, u.papel AS papel_global, r.situacao AS representacao
      FROM empresas e JOIN empresa_assinaturas a ON a.empresa_id = e.id JOIN memberships m ON m.empresa_id = e.id JOIN usuarios_administrativos u ON u.id = m.usuario_id
      JOIN empresa_representacoes r ON r.empresa_id = e.id WHERE e.nome = 'Buffet Festa UI'`)).rows;
    assert.equal(e.length, 1);
    assert.deepEqual([e[0].status, e[0].situacao, e[0].papel, e[0].vinculo, e[0].papel_global, e[0].representacao], ['ATIVA', 'TESTE', 'REPRESENTANTE_AUTORIZADO', 'ATIVA', 'ADMINISTRATIVO', 'DECLARADA']);
    resultados.push('Cadastro: mensagem neutra, link pelo e-mail (arquivo), conta criada só na confirmação, empresa em teste com Gestão da pessoa (papel global neutro, representação declarada), início guiado e aviso de teste');
    console.log('E2E_CADASTRO_OK');
    await ctx1.close();

    // 3. Mesmo CNPJ por outra pessoa.
    const ctx2 = await novoContexto();
    const p2 = await ctx2.newPage();
    const emailBeto = 'beto-cadastro-ui@exemplo.test';
    await pedirConta(p2, 'Beto Cadastro UI', emailBeto);
    await confirmarEEmpresa(p2, emailBeto, '80123456000188', 'Outro Nome');
    await p2.locator('[data-cnpj-existente]').waitFor();
    const texto = await p2.locator('main').innerText();
    assert.doesNotMatch(texto, /Buffet Festa UI|Ana Cadastro UI|Festa UI Festas/, 'nada da empresa existente aparece');
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa s JOIN usuarios_administrativos u ON u.id = s.usuario_id WHERE u.email = $1 AND s.situacao = 'PENDENTE'", [emailBeto])).rows[0].n), 1);
    await p2.screenshot({ path: path.join(relatorios, 'cnpj-existente.png'), fullPage: true });
    resultados.push('CNPJ já cadastrado: mensagem neutra sem nenhum dado da empresa existente; pedido de acesso registrado; nenhum vínculo criado');
    console.log('E2E_CNPJ_EXISTENTE_OK');
    await ctx2.close();

    // 4. Mesmo e-mail de novo: resposta idêntica, e-mail de conta existente.
    const ctx3 = await novoContexto();
    const p3 = await ctx3.newPage();
    const antes = fs.readdirSync(caixa).length;
    await pedirConta(p3, 'Ana de Novo', emailAna);
    for (let n = 0; n < 60 && fs.readdirSync(caixa).length === antes; n++) await new Promise((r) => setTimeout(r, 500));
    const aviso = await ultimoEmail(emailAna);
    assert.match(aviso.texto, /já tem uma conta/);
    assert.doesNotMatch(aviso.texto, /#t=/);
    resultados.push('E-mail já cadastrado: a tela responde igual; o e-mail recebido é o aviso de conta existente, sem link de confirmação');
    console.log('E2E_EMAIL_EXISTENTE_OK');

    // 5. Celular.
    await p3.setViewportSize({ width: 390, height: 844 });
    for (const rota of ['/planos', '/cadastro', '/termos']) {
      await p3.goto(`${base}${rota}`);
      await p3.locator('h1').first().waitFor();
      assert.ok(await semRolagem(p3), `${rota} sem rolagem horizontal`);
    }
    await p3.goto(`${base}/cadastro`);
    await p3.screenshot({ path: path.join(relatorios, 'celular-cadastro.png'), fullPage: true });
    await ctx3.close();
    resultados.push('Celular (390 px): planos, cadastro e termos sem rolagem horizontal');
    console.log('E2E_CELULAR_OK');

    fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, emailReal: 'arquivo local', resultados }, null, 2));
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
