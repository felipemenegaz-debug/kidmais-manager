/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in dos adicionais do buffet (070) no navegador e nas APIs, com PostgreSQL DESCARTÁVEL e dados sintéticos.
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 e aplica a 070 nele (a receita prova
 * cluster/porta/usuário antes de escrever). Nenhum .env, banco real, e-mail ou serviço Render. Execute com os três
 * KIDMAIS_* de autorização do descartável, Playwright e Chrome.
 *
 *   - Empresa sintética com o pacote POCKET publicado (20–30 convidados) e gestão (REPRESENTANTE_AUTORIZADO).
 *   - Itens do Buffet › Categorias › Salgados › "Vender como adicional": preço, cento, até 3 opções, só no Pocket.
 *   - Outros adicionais › novo "Mesa de café" com preço e pacote.
 *   - Fechamento admin: a rota de adicionais devolve os dois, o de categoria com as opções ativas.
 *   - Empresa sem tabela publicada: aviso na tela e preço recusado com orientação.
 *   - Celular sem rolagem horizontal com o painel aberto.
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
  const { carregarModulo } = await import('../lib/acessos/teste-carregador.ts');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve('.local-adicionais-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/checks/20261007_070_precheck.sql', 'database/migrations/20261007_070_adicionais_do_buffet.sql', 'database/checks/20261007_070_postcheck.sql'])
      await client.query(fs.readFileSync(f, 'utf8'));
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
    const senhaMod = carregar('lib/autenticacao/senha.ts');
    const precos = await import('../lib/comercial/pacote-precos.ts');
    const tx = { query: async (t, v) => { const r = await client.query(t, v); return { rows: r.rows, rowCount: r.rowCount }; } };
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const email = 'pessoa-adicionais-ui@exemplo.test';
    const pessoa = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Pessoa Adicionais UI',$2,'ADMINISTRATIVO') RETURNING id`,
      [email, await senhaMod.criarHashSenha(password)])).rows[0].id;
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [pessoa]);
    const empresas = {};
    for (const [chave, nome] of [['A', 'Buffet Adicionais UI'], ['S', 'Buffet Sem Tabela UI']]) {
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`ad-${chave.toLowerCase()}-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [id, pessoa])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
      const pacote = (await client.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
        VALUES ($1, 'POCKET', 'Kidmais Pocket', 1, true, true, 20, 30) RETURNING id`, [id])).rows[0].id;
      empresas[chave] = { id, nome, pacote };
    }
    await client.query('BEGIN');
    await precos.gravarFaixasPacote(tx, empresas.A.id, empresas.A.pacote, [{ convidadosMin: 20, convidadosMax: 30, valor: '1500.00' }],
      { minimo: 20, maximo: 30 }, { empresaId: empresas.A.id, usuarioId: pessoa, requestId: require('node:crypto').randomUUID(), motivo: 'PACOTE_EDITADO' });
    await client.query('COMMIT');
    const salgados = (await client.query("SELECT id FROM buffet_categorias WHERE nome = 'Salgados'")).rows[0].id;

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'AGENDA_PUBLICA_EMPRESA_ID']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 160; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.ok).catch(() => false)) break;
      if (n === 159) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexto.setDefaultTimeout(90000);
    const page = await contexto.newPage();
    const sessaoAtual = () => contexto.request.get(`${base}/api/admin/autenticacao`).then(r => r.json());
    await page.goto(`${base}/admin/login`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Senha', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    async function selecionar(chave) {
      const s = await sessaoAtual();
      const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: empresas[chave].id } });
      assert.equal(r.status(), 200, `selecionar ${chave}`);
      return sessaoAtual();
    }
    const semRolagem = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const falhar = async (nome, e) => { await page.screenshot({ path: path.join(relatorios, `falha-${nome}.png`), fullPage: true }); fs.writeFileSync(path.join(relatorios, `falha-${nome}.txt`), await page.locator('body').innerText()); throw e; };

    // 1. Categoria Salgados vira um adicional único.
    let s = await selecionar('A');
    await page.goto(`${base}/admin/configuracoes/catalogo`);
    await page.getByRole('heading', { name: 'Itens do Buffet' }).waitFor();
    await page.getByRole('button', { name: 'Ações de Salgados' }).click();
    await page.getByRole('menuitem', { name: 'Vender como adicional' }).click();
    const painel = page.getByRole('dialog', { name: 'Adicional' });
    await painel.getByRole('heading', { name: 'Salgados como adicional' }).waitFor();
    await painel.getByLabel('Nome no fechamento *').fill('Cento de salgados extra');
    assert.equal(await painel.getByLabel('Cobrança').inputValue(), 'CENTO');
    await painel.getByLabel('Preço (R$)').fill('120,00');
    await painel.getByLabel('Máximo de opções que o cliente escolhe').fill('3');
    await page.screenshot({ path: path.join(relatorios, 'categoria-painel.png'), fullPage: true });
    assert.equal(await painel.getByRole('checkbox', { name: 'Kidmais Pocket' }).isChecked(), false, 'nenhum pacote até marcar');
    await painel.getByRole('checkbox', { name: 'Kidmais Pocket' }).check();
    await painel.getByRole('button', { name: 'Salvar adicional' }).click();
    await page.getByText('Adicional salvo.').waitFor().catch((e) => falhar('categoria', e));
    const linhaSalgados = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Salgados', exact: true }) });
    await linhaSalgados.getByText('R$ 120,00 por cento').waitFor();
    await page.screenshot({ path: path.join(relatorios, 'categorias-com-adicional.png'), fullPage: true });
    resultados.push('Categoria Salgados → "Cento de salgados extra": R$ 120,00 por cento, até 3 opções, só no Pocket (nenhum pacote marcado de início)');
    console.log('E2E_ADICIONAIS_CATEGORIA_OK');

    // 2. Outros adicionais: novo com preço e pacote.
    await page.getByRole('button', { name: 'Outros adicionais' }).click();
    await page.getByRole('button', { name: '+ Novo adicional' }).click();
    await painel.getByRole('heading', { name: 'Novo adicional' }).waitFor();
    await painel.getByLabel('Nome no fechamento *').fill('Mesa de café');
    await painel.getByLabel('Grupo').selectOption('MESA');
    await painel.getByLabel('Preço (R$)').fill('350');
    await painel.getByRole('checkbox', { name: 'Kidmais Pocket' }).check();
    await painel.getByRole('button', { name: 'Salvar adicional' }).click();
    await page.getByRole('row').filter({ hasText: 'Mesa de café' }).getByText('R$ 350,00').waitFor().catch((e) => falhar('outros', e));
    await page.screenshot({ path: path.join(relatorios, 'outros-adicionais.png'), fullPage: true });
    resultados.push('Outros adicionais: "Mesa de café" R$ 350,00 no grupo Mesas, oferecida no Pocket');
    console.log('E2E_ADICIONAIS_OUTROS_OK');

    // 3. Rota do fechamento admin devolve os dois; o de categoria com as opções ativas da categoria.
    s = await sessaoAtual();
    const data = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const r = await contexto.request.get(`${base}/api/admin/fechamentos/adicionais?pacote=pocket&data=${data}&convidados=25`, { headers: { 'x-kidmais-sessao': s.data.sessaoId } });
    const corpo = await r.json();
    assert.equal(r.status(), 200, JSON.stringify(corpo));
    const porNome = Object.fromEntries(corpo.adicionais.map((a) => [a.nome, a]));
    assert.deepEqual(Object.keys(porNome).sort(), ['Cento de salgados extra', 'Mesa de café']);
    const cento = porNome['Cento de salgados extra'];
    assert.equal(cento.preco, 120);
    assert.equal(cento.unidadeCobranca, 'CENTO');
    assert.equal(cento.escolhas.max, 3);
    const ativos = Number((await client.query('SELECT count(*)::int AS n FROM buffet_itens WHERE categoria_id = $1 AND ativo', [salgados])).rows[0].n);
    assert.equal(cento.escolhas.itens.length, ativos);
    assert.equal(cento.id, cento.codigo, 'adicional novo usa o código como id na tela');
    resultados.push(`Fechamento admin: /api/admin/fechamentos/adicionais devolve os 2 adicionais; o cento traz ${ativos} opções ativas e máximo 3`);
    console.log('E2E_ADICIONAIS_FECHAMENTO_OK');

    // 4. Empresa sem tabela publicada: aviso e preço recusado com orientação.
    await selecionar('S');
    await page.goto(`${base}/admin/configuracoes/catalogo`);
    await page.getByText('Não há tabela de preços publicada', { exact: false }).waitFor();
    const semTabela = await contexto.request.get(`${base}/api/admin/fechamentos/adicionais?pacote=pocket&data=${data}&convidados=25`, { headers: { 'x-kidmais-sessao': (await sessaoAtual()).data.sessaoId } });
    assert.equal(semTabela.status(), 409);
    assert.equal((await semTabela.json()).codigo, 'PRECO_INDISPONIVEL');
    await page.screenshot({ path: path.join(relatorios, 'sem-tabela.png'), fullPage: true });
    resultados.push('Empresa sem tabela publicada: aviso "Não há tabela de preços publicada" e consulta do fechamento 409 PRECO_INDISPONIVEL (mensagem própria nas telas)');
    console.log('E2E_ADICIONAIS_SEM_TABELA_OK');

    // 5. Celular: painel aberto sem rolagem horizontal.
    await selecionar('A');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/admin/configuracoes/catalogo`);
    await page.getByRole('heading', { name: 'Itens do Buffet' }).waitFor();
    await page.getByRole('button', { name: 'Itens', exact: true }).click();
    await page.locator('article').filter({ hasText: 'Coxinha com catupiry' }).getByRole('button', { name: 'Vender como adicional' }).click();
    await painel.getByRole('heading', { name: 'Coxinha com catupiry como adicional' }).waitFor();
    assert.equal(await painel.getByLabel('Cobrança').inputValue(), 'UNIDADE');
    assert.ok(await semRolagem(), 'celular sem rolagem horizontal');
    await page.screenshot({ path: path.join(relatorios, 'celular-item.png'), fullPage: true });
    resultados.push('Celular (390 px): item "Coxinha com catupiry" abre o painel (cobrança por unidade) sem rolagem horizontal');
    console.log('E2E_ADICIONAIS_CELULAR_OK');

    fs.writeFileSync(path.join(relatorios, 'resultado.txt'), resultados.join('\n') + '\n');
    console.log(resultados.join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (servidor && servidor.exitCode === null) {
      if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/pid', String(servidor.pid), '/t', '/f'], { windowsHide: true });
      else servidor.kill('SIGTERM');
    }
    if (client) await client.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

principal().catch((e) => { console.error(e); process.exit(1); });
