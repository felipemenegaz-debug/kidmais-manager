/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do paywall (E4) no navegador e nas APIs, com PostgreSQL DESCARTÁVEL e dados sintéticos.
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 e aplica 067 + 068 nele (a receita prova
 * cluster/porta/usuário antes de escrever). Nenhum .env, banco real, e-mail (EMAIL_PROVIDER=desativado), provedor de
 * cobrança ou serviço Render. Execute com os três KIDMAIS_* de autorização do descartável, Playwright e Chrome.
 *
 * Uma pessoa com quatro vínculos: Gestão em T (teste em andamento), L (teste vencido → somente leitura) e
 * X (vencido há muito → bloqueado); Equipe em S (sem cobrança, como a Kidmais e as empresas atuais).
 *   - T e S: escrita não é barrada pelo paywall; T mostra "Teste grátis até"; S não mostra aviso.
 *   - L: GET 200, POST/PATCH 402 ASSINATURA_NECESSARIA; aviso "Modo somente leitura"; sessão continua válida.
 *   - X: GET 402 nas APIs de dados; tela "Acesso suspenso"; Assinatura, perfil/senha e autenticação continuam.
 *   - Troca de empresa revalida tudo no servidor; celular sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3143;

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
  const relatorios = path.resolve('.local-assinatura-paywall-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/migrations/20261006_067_modelo_comercial_empresa.sql', 'database/checks/20261007_068_precheck.sql',
      'database/migrations/20261007_068_cobranca_assinatura.sql', 'database/checks/20261007_068_postcheck.sql'])
      await client.query(fs.readFileSync(f, 'utf8'));
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
    const senhaMod = carregar('lib/autenticacao/senha.ts');
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const email = 'pessoa-paywall-ui@exemplo.test';
    const pessoa = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Pessoa Paywall UI',$2,'ADMINISTRATIVO') RETURNING id`,
      [email, await senhaMod.criarHashSenha(password)])).rows[0].id;
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [pessoa]);
    const empresas = {};
    for (const [chave, nome, papel] of [['T', 'Buffet Teste UI', 'REPRESENTANTE_AUTORIZADO'], ['L', 'Buffet Leitura UI', 'REPRESENTANTE_AUTORIZADO'],
      ['X', 'Buffet Bloqueado UI', 'REPRESENTANTE_AUTORIZADO'], ['S', 'Buffet Sem Cobrança UI', 'ADMINISTRATIVO']]) {
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`pw-${chave.toLowerCase()}-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [id, pessoa, papel])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
      empresas[chave] = { id, nome };
    }
    const assinatura = (id, cnpj, inicio, fim) => client.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
      VALUES($1,'TESTE',clock_timestamp() + $3::interval,clock_timestamp() + $4::interval,$2)`, [id, cnpj, inicio, fim]);
    await assinatura(empresas.T.id, '11222333000181', '-2 days', '13 days');
    await assinatura(empresas.L.id, '45723174000110', '-20 days', '-5 days');
    await assinatura(empresas.X.id, '04252011000110', '-200 days', '-185 days');

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'ASSINATURA_PRECO_MENSAL_CENTAVOS', 'ASSINATURA_PRECO_ANUAL_CENTAVOS']) delete env[k];
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
    await page.goto(`${base}/admin/login`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Senha', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));

    async function selecionar(chave) {
      const s = await sessaoAtual();
      const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: empresas[chave].id } });
      assert.equal(r.status(), 200, `selecionar ${chave}`);
      const depois = await sessaoAtual();
      assert.equal(depois.data.contexto.empresaAtual.id, empresas[chave].id);
      return depois;
    }
    async function api(metodo, rota, s) {
      const headers = { origin: base, 'x-csrf-token': s.data.csrf, 'x-kidmais-sessao': s.data.sessaoId, 'content-type': 'application/json' };
      const r = await contexto.request.fetch(`${base}${rota}`, { method: metodo, headers, data: metodo === 'GET' ? undefined : '{}' });
      return { status: r.status(), corpo: await r.json().catch(() => null) };
    }
    const semRolagem = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // T: teste em andamento — escrita não barrada pelo paywall, aviso de teste.
    let s = await selecionar('T');
    assert.deepEqual([s.data.comercial.nivel, s.data.comercial.motivo], ['COMPLETO', 'TESTE']);
    const postT = await api('POST', '/api/admin/clientes', s);
    assert.notEqual(postT.status, 402, 'teste em andamento não é barrado (corpo vazio cai na validação)');
    await page.goto(`${base}/admin/assinatura`);
    await page.getByRole('heading', { name: 'Teste grátis', exact: true }).waitFor();
    await page.locator('[data-aviso-comercial="COMPLETO"]').getByText('Teste grátis até', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'teste-em-andamento.png'), fullPage: true });
    resultados.push('Teste em andamento: aviso "Teste grátis até" e tela Assinatura; escrita não barrada pelo paywall');
    console.log('E2E_PAYWALL_TESTE_OK');

    // L: somente leitura — GET 200, escrita 402 com código próprio; sessão não cai.
    s = await selecionar('L');
    assert.deepEqual([s.data.comercial.nivel, s.data.comercial.motivo], ['SOMENTE_LEITURA', 'TESTE_ENCERRADO']);
    assert.equal((await api('GET', '/api/admin/clientes', s)).status, 200);
    assert.equal((await api('GET', '/api/admin/dashboard', s)).status, 200);
    for (const [m, rota] of [['POST', '/api/admin/clientes'], ['POST', '/api/admin/pagamentos'], ['POST', '/api/admin/configuracoes/pix'], ['PATCH', '/api/admin/configuracoes/catalogo'], ['POST', '/api/admin/disponibilidade'], ['POST', '/api/admin/contratos']]) {
      const r = await api(m, rota, s);
      assert.equal(r.status, 402, `${m} ${rota}`);
      assert.equal(r.corpo.codigo, 'ASSINATURA_NECESSARIA', `${m} ${rota}`);
    }
    assert.equal((await api('GET', '/api/admin/assinatura', s)).status, 200);
    assert.equal((await sessaoAtual()).data.usuarioId, pessoa, 'a sessão continua válida depois das recusas');
    await page.goto(`${base}/admin/dashboard`);
    await page.locator('[data-aviso-comercial="SOMENTE_LEITURA"]').getByText('Modo somente leitura até', { exact: false }).waitFor({ timeout: 20000 })
      .catch(async (e) => { await page.screenshot({ path: path.join(relatorios, 'falha-leitura.png'), fullPage: true }); fs.writeFileSync(path.join(relatorios, 'falha-leitura.txt'), await page.locator('body').innerText()); throw e; });
    // A consulta continua funcionando na tela (o Dashboard carrega por GET).
    await page.locator('main[aria-busy="true"]').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Não foi possível carregar o dashboard' }).count(), 0);
    await page.screenshot({ path: path.join(relatorios, 'somente-leitura.png'), fullPage: true });
    resultados.push('Somente leitura: GET 200 (clientes, dashboard, assinatura); POST em clientes, pagamentos, Pix, disponibilidade e contratos; PATCH no catálogo → 402 ASSINATURA_NECESSARIA; sessão preservada; aviso na tela');
    console.log('E2E_PAYWALL_LEITURA_OK');

    // X: bloqueado — dados recusados até no GET; conta e cobrança continuam.
    s = await selecionar('X');
    assert.equal(s.data.comercial.nivel, 'BLOQUEADO');
    for (const rota of ['/api/admin/clientes', '/api/admin/dashboard', '/api/admin/financeiro'])
      assert.equal((await api('GET', rota, s)).status, 402, rota);
    assert.equal((await api('GET', '/api/admin/assinatura', s)).status, 200);
    for (const tipo of ['clientes', 'contas-receber']) {
      const exp = await contexto.request.get(`${base}/api/admin/exportacao?tipo=${tipo}`);
      assert.equal(exp.status(), 200, `exportação ${tipo} com acesso bloqueado`);
      assert.match(exp.headers()['content-type'], /^text\/csv/);
      assert.match(exp.headers()['content-disposition'], new RegExp(`kidmais-${tipo}-`));
      assert.ok((await exp.text()).startsWith('﻿'), 'CSV com BOM');
    }
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM auditoria WHERE acao='EXPORTACAO_DADOS' AND entidade_id=$1", [empresas.X.id])).rows[0].n), 2, 'exportações auditadas');
    assert.equal(await client.query('SELECT count(*)::int AS n FROM empresas WHERE id=$1 AND status=$2', [empresas.X.id, 'ATIVA']).then(r => r.rows[0].n), 1, 'empresa não é suspensa por vencimento');
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('heading', { name: 'Acesso suspenso até a assinatura', exact: true }).waitFor();
    await page.getByText('Nada foi apagado', { exact: false }).waitFor();
    await page.getByRole('link', { name: 'Ver assinatura e regularizar', exact: true }).click();
    await page.waitForURL(`${base}/admin/assinatura`);
    await page.getByRole('heading', { name: 'Teste grátis', exact: true }).waitFor();
    await page.getByText('Nenhum dado é apagado por vencimento', { exact: false }).waitFor();
    await page.goto(`${base}/admin/perfil`);
    await page.getByRole('heading', { name: 'Meu perfil', exact: true }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'bloqueado-perfil.png'), fullPage: true });
    resultados.push('Bloqueado: GET de dados → 402; exportação CSV (clientes e contas a receber) 200 e auditada; tela "Acesso suspenso" com saída para Assinatura; perfil/senha e Assinatura abertos; empresa continua ATIVA (vencimento não suspende)');
    console.log('E2E_PAYWALL_BLOQUEADO_OK');

    // S: sem cobrança (como a Kidmais): nada muda; troca de empresa revalidada no servidor.
    s = await selecionar('S');
    assert.deepEqual([s.data.comercial.cobrado, s.data.comercial.nivel], [false, 'COMPLETO']);
    assert.notEqual((await api('POST', '/api/admin/clientes', s)).status, 402);
    const expEquipe = await contexto.request.get(`${base}/api/admin/exportacao?tipo=clientes`);
    assert.equal(expEquipe.status(), 403, 'Equipe não exporta');
    await page.goto(`${base}/admin/assinatura`);
    await page.getByRole('heading', { name: 'Sem cobrança', exact: true }).waitFor();
    assert.equal(await page.locator('[data-aviso-comercial]').count(), 0, 'empresa sem cobrança não mostra aviso');
    resultados.push('Sem cobrança (Equipe): nenhum aviso, escrita não barrada; Equipe não exporta (403); a mesma pessoa vê situações diferentes por empresa');
    console.log('E2E_PAYWALL_SEM_COBRANCA_OK');

    // Celular: tela Assinatura e aviso sem rolagem horizontal.
    await selecionar('L');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/admin/assinatura`);
    await page.getByRole('heading', { name: 'Teste grátis', exact: true }).waitFor();
    assert.ok(await semRolagem(), 'assinatura sem rolagem horizontal no celular');
    await page.screenshot({ path: path.join(relatorios, 'celular-assinatura.png'), fullPage: true });
    resultados.push('Celular (390 px): tela Assinatura e aviso sem rolagem horizontal');
    console.log('E2E_PAYWALL_CELULAR_OK');

    // E5 (painel comercial), quando presente nesta árvore: o desenvolvedor concede acesso excepcional pela ficha.
    if (fs.existsSync('components/desenvolvedor/ComercialEmpresa.tsx')) {
      const { alterarDesenvolvedor } = require('./admin-provision.cjs');
      const emailDev = 'dev-paywall-ui@exemplo.test';
      const dev = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Dev Paywall UI',$2,'ADMINISTRATIVO') RETURNING id`, [emailDev, await senhaMod.criarHashSenha(password)])).rows[0].id;
      await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [dev]);
      await alterarDesenvolvedor(client, { operacao: 'conceder', email: emailDev, operador: 'E2E sintético', motivo: 'Teste do painel comercial' });
      const ctxDev = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      ctxDev.setDefaultTimeout(60000);
      const p = await ctxDev.newPage();
      await p.goto(`${base}/admin/login`);
      await p.getByLabel('Email', { exact: true }).fill(emailDev);
      await p.getByLabel('Senha', { exact: true }).fill(password);
      await p.getByRole('button', { name: 'Entrar', exact: true }).click();
      await p.waitForURL(url => !url.pathname.includes('/login'));
      await p.goto(`${base}/desenvolvedor/empresas`);
      await p.getByRole('cell', { name: /Teste grátis · Somente leitura/ }).first().waitFor();
      await p.goto(`${base}/desenvolvedor/empresas/${empresas.L.id}`);
      await p.getByRole('heading', { name: 'Situação comercial', exact: true }).waitFor();
      await p.getByRole('button', { name: 'Conceder acesso excepcional', exact: true }).click();
      const form = p.getByRole('form', { name: 'Intervenção comercial' });
      await form.getByLabel('Prazo em dias').fill('10');
      await form.getByLabel('Motivo (fica na auditoria)').fill('Cortesia de lançamento (E2E)');
      await form.getByRole('button', { name: 'Confirmar', exact: true }).click();
      const dialogo = p.getByRole('dialog', { name: 'Confirme sua senha' });
      if (await dialogo.isVisible().catch(() => false)) {
        await dialogo.getByLabel('Senha').fill(password);
        await dialogo.getByRole('button', { name: 'Confirmar e continuar' }).click();
      }
      await p.getByText('Exceção concedida: Cortesia por 10 dia(s).', { exact: false }).waitFor();
      await p.getByRole('list', { name: 'Histórico comercial' }).getByText('Acesso comercial excepcional concedido').waitFor();
      await p.screenshot({ path: path.join(relatorios, 'painel-comercial.png'), fullPage: true });
      const auditada = (await client.query("SELECT justificativa, usuario_id FROM auditoria WHERE acao='COMERCIAL_EXCECAO_CONCEDIDA' AND entidade_id=$1", [empresas.L.id])).rows;
      assert.deepEqual([auditada.length, auditada[0].justificativa, auditada[0].usuario_id], [1, 'Cortesia de lançamento (E2E)', dev]);
      s = await selecionar('L');
      assert.deepEqual([s.data.comercial.nivel, s.data.comercial.motivo], ['COMPLETO', 'EXCECAO_COMERCIAL'], 'a Gestão de L volta a escrever');
      assert.notEqual((await api('POST', '/api/admin/clientes', s)).status, 402);
      assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM memberships WHERE usuario_id=$1', [dev])).rows[0].n), 0, 'intervenção comercial não dá vínculo ao desenvolvedor');
      await ctxDev.close();
      resultados.push('Painel comercial: lista mostra a situação comercial; o desenvolvedor concede cortesia com prazo e motivo pela ficha (auditada, sem vínculo novo) e a empresa volta a escrever');
      console.log('E2E_PAINEL_COMERCIAL_OK');
    }

    fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, emailReal: 'desativado', provedorCobranca: 'ausente', resultados }, null, 2));
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
principal().catch(e => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n').slice(0, 6).join(' | ')); process.exitCode = 1; });
