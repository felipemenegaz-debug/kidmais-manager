/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do seletor de pacote em /admin/disponibilidade, com PostgreSQL DESCARTÁVEL e dados sintéticos (modelo 089).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 089 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail, provedor ou serviço Render. Execute com os três KIDMAIS_* de autorização
 * do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 *   - Buffet novo, sem pacote: o seletor não traz o catálogo Kidmais ("Nenhum pacote criado", desabilitado) e a tela
 *     aponta para Configurações → Pacotes; o calendário continua com a ocupação física.
 *   - Buffet com um pacote (código POCKET, nome próprio): o seletor lista só ele, com o nome do buffet.
 *   - Dona da agenda pública (AGENDA_PUBLICA_EMPRESA_ID): continua com os sete pacotes do catálogo legado.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3159;

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
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve(process.env.KIDMAIS_DISPONIBILIDADE_UI_RELATORIOS || '.local-disponibilidade-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [receita.MODELOS['089'].banco])).rows.length > 0;
    if (!existe) await receita.construirModelo(admin, porta, '089');
    await receita.restaurar(admin, receita.TRABALHO[0], '089');
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
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`dp-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      return id;
    };
    const vinculo = async (empresaId, usuarioId, papel) => {
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [empresaId, usuarioId, papel])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
    };
    const DONA = await empresa('Buffet Dona da Agenda UI');
    const NOVA = await empresa('Buffet Novo UI');
    const COM = await empresa('Buffet Com Pacote UI');
    await vinculo(DONA, await pessoa('gestao-dona-ui@exemplo.test', 'Gestão Dona UI'), 'REPRESENTANTE_AUTORIZADO');
    await vinculo(NOVA, await pessoa('gestao-nova-ui@exemplo.test', 'Gestão Nova UI'), 'REPRESENTANTE_AUTORIZADO');
    await vinculo(COM, await pessoa('gestao-com-ui@exemplo.test', 'Gestão Com Pacote UI'), 'REPRESENTANTE_AUTORIZADO');
    await client.query(
      `INSERT INTO pacotes(empresa_id,codigo,nome,descricao,duracao_minutos,convidados_minimos,convidados_maximos,ordem_exibicao,ativo,vigente)
       VALUES($1,'POCKET','Festinha do Buffet UI',null,240,20,40,(SELECT COALESCE(MAX(ordem_exibicao),0)+1 FROM pacotes),true,true)`, [COM]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pacotes WHERE empresa_id=$1', [NOVA])).rows[0].n, 0, 'buffet novo nasce sem pacote');

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      AGENDA_PUBLICA_EMPRESA_ID: DONA, EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
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
      const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexto.setDefaultTimeout(90000);
      const page = await contexto.newPage();
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
      return { contexto, page };
    }
    async function seletorDePacote(page) {
      await page.goto(`${base}/admin/disponibilidade`);
      const seletor = page.locator('label').filter({ has: page.locator('span', { hasText: /^Pacote$/ }) }).locator('select');
      await seletor.waitFor();
      // Espera a carga do mês (os dias deixam de mostrar "…").
      await page.waitForFunction(() => !document.querySelector('button[disabled] small')?.textContent?.includes('…'));
      await page.waitForTimeout(500);
      return { seletor, opcoes: (await seletor.locator('option').allInnerTexts()).map((t) => t.trim()) };
    }

    {
      const { contexto, page } = await entrar('gestao-nova-ui@exemplo.test');
      const { seletor, opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Nenhum pacote criado']);
      assert.equal(await seletor.isDisabled(), true);
      await page.getByText('Nenhum pacote criado ainda.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Configurações → Pacotes', exact: true }).getAttribute('href'), '/admin/configuracoes/pacotes');
      const texto = await page.locator('main').innerText();
      for (const nome of ['Kidmais Pocket', 'Mini Festa Kidmais', 'Pizza Party Scienza', '-15% Dia útil']) assert.ok(!texto.includes(nome), nome);
      await page.screenshot({ path: path.join(relatorios, 'buffet-novo.png'), fullPage: true });
      await contexto.close();
      resultados.push('Buffet novo: seletor "Nenhum pacote criado" (desabilitado), aviso com link para Configurações → Pacotes, nenhum nome do catálogo Kidmais na tela');
      console.log('E2E_DISPONIBILIDADE_NOVA_OK');
    }
    {
      const { contexto, page } = await entrar('gestao-com-ui@exemplo.test');
      const { seletor, opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Festinha do Buffet UI']);
      assert.equal(await seletor.isDisabled(), false);
      assert.equal(await page.getByText('Nenhum pacote criado ainda.', { exact: false }).count(), 0);
      await page.screenshot({ path: path.join(relatorios, 'buffet-com-pacote.png'), fullPage: true });
      await contexto.close();
      resultados.push('Buffet com pacote: seletor lista só "Festinha do Buffet UI"');
      console.log('E2E_DISPONIBILIDADE_COM_PACOTE_OK');
    }
    {
      const { contexto, page } = await entrar('gestao-dona-ui@exemplo.test');
      const { opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Kidmais Pocket', 'Mini Festa Kidmais', 'Festa Compacta', 'Festa Essencial', 'Festa Completa', 'Festa Premium', 'Pizza Party Scienza']);
      await page.screenshot({ path: path.join(relatorios, 'dona-da-agenda.png'), fullPage: true });
      await contexto.close();
      resultados.push('Dona da agenda pública: os sete pacotes do catálogo legado, como antes');
      console.log('E2E_DISPONIBILIDADE_DONA_OK');
    }
    fs.writeFileSync(path.join(relatorios, 'resultados.txt'), `${resultados.join('\n')}\n`);
    console.log(`E2E_DISPONIBILIDADE_PACOTES_OK (${resultados.length} roteiros)`);
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
