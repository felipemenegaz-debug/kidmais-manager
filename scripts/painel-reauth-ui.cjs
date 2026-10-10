/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da reautenticação e das trocas de contexto durante operações (PR #95).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 (receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail (EMAIL_PROVIDER=desativado) ou serviço Render.
 * Execute com os três KIDMAIS_* de autorização do descartável, Playwright (KIDMAIS_PLAYWRIGHT_MODULE) e Chrome.
 *
 * Cenários:
 *   1. Painel: senha incorreta mantém sessão, contexto e diálogo; senha correta conclui a operação UMA vez, na tela.
 *   2. Perfil da empresa: reautenticar e aplicar; senha incorreta preserva rascunho e formulário.
 *   3. Troca de empresa antes do processamento: nada alterado, dados antigos descartados, aviso.
 *   4. Troca de empresa depois da escrita e antes da resposta: aviso "concluída", dados descartados, sem repetição.
 *   5. Suspensão durante a escrita com resposta perdida: "resultado incerto", sem repetição; sessão encerrada.
 *   6. Leitura + troca de empresa + falha na confirmação da sessão: dados nunca entregues ao componente, descarte.
 *   7. Escrita confirmada + troca + falha na confirmação: continua "concluída" (não vira incerta), sem repetição.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3138;

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
  const relatorios = path.resolve('.local-painel-reauth-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  const rastro = [];
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
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const email = 'reauth-ui@exemplo.test', emailEquipe = 'equipe-reauth-ui@exemplo.test';
    const usuario = async (e, nome) => (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [e, nome, await senhaMod.criarHashSenha(password)])).rows[0].id;
    const user = await usuario(email, 'Pessoa Reauth UI');
    const equipe = await usuario(emailEquipe, 'Equipe Reauth UI');
    // O teste envelhece sessões para passar da janela de 5 min; a troca de senha precisa ser anterior a isso.
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[user, equipe]]);
    const empresas = {};
    for (const [chave, nome] of [['alfa', 'Alfa Reauth'], ['beta', 'Beta Reauth']]) {
      const codigo = `reauth-${chave}-${randomBytes(3).toString('hex')}`;
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [codigo, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      empresas[chave] = { id, codigo, nome };
    }
    const vincular = async (empresa, u, papel) => {
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
        VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [empresa, u, papel])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
      return m;
    };
    await vincular(empresas.alfa.id, user, 'REPRESENTANTE_AUTORIZADO');
    const membershipEquipe = await vincular(empresas.alfa.id, equipe, 'ADMINISTRATIVO');
    await vincular(empresas.beta.id, user, 'ADMINISTRATIVO');
    // Perfil da Alfa (sintético): mesmo código da empresa + unidade + concessões de Perfil para a pessoa.
    const perfil = (await client.query('INSERT INTO perfil_empresas(codigo) VALUES($1) RETURNING id', [empresas.alfa.codigo])).rows[0].id;
    await client.query('INSERT INTO perfil_unidades(empresa_id,codigo) VALUES($1,$2)', [perfil, `${empresas.alfa.codigo}-u1`]);
    for (const cap of ['PERFIL_CONSULTAR', 'PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES']) {
      await client.query(`INSERT INTO perfil_empresa_concessoes(empresa_id,usuario_id,capacidade,concedido_por,motivo,referencia_autorizacao)
        VALUES($1,$2,$3,$2,'Fixture sintética do E2E','E2E-REAUTH')`, [perfil, user, cap]);
    }
    await alterarDesenvolvedor(client, { operacao: 'conceder', email, operador: 'E2E sintético', motivo: 'Teste de reautenticação' });
    const contar = async (acao, entidade) => Number((await client.query(
      `SELECT count(*)::int n FROM auditoria WHERE acao=$1 ${entidade ? 'AND entidade_id=$2' : ''}`, entidade ? [acao, entidade] : [acao])).rows[0].n);
    const envelhecerSessao = () => client.query(`UPDATE sessoes_administrativas SET criado_em = criado_em - interval '6 minutes', autenticado_em = autenticado_em - interval '6 minutes'
      WHERE usuario_id=$1 AND revogado_em IS NULL`, [user]);

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME']) delete env[k];
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
    // Rastro de rede (G16): ordem de pedidos, respostas e falhas das rotas de sessão e do Perfil, só método e caminho
    // (sem consulta, corpo ou cabeçalho). Gravado em rastro-rede.json mesmo quando o roteiro falha.
    const t0 = Date.now();
    const rastrear = (evento) => (req) => {
      const caminho = new URL(req.url()).pathname;
      if (caminho.startsWith('/api/admin/autenticacao') || caminho.startsWith('/api/admin/configuracoes/perfil-empresa'))
        rastro.push({ ms: Date.now() - t0, evento, metodo: req.method(), caminho, ...(evento === 'falhou' ? { erro: req.failure()?.errorText ?? null } : {}) });
    };
    page.on('request', rastrear('pedido')); page.on('requestfinished', rastrear('respondido')); page.on('requestfailed', rastrear('falhou'));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) rastro.push({ ms: Date.now() - t0, evento: 'navegou', caminho: new URL(f.url()).pathname }); });
    // Nenhuma consulta de CEP sai da máquina durante o teste.
    await page.route('**/api/endereco/consultar-cep', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'CEP indisponível no teste.' }) }));
    const sessaoAtual = () => contexto.request.get(`${base}/api/admin/autenticacao`).then(r => r.json());
    const marcar = () => page.evaluate(() => { window.__kidmaisMarca = 'sem-recarga'; });
    const marcaIntacta = async () => (await page.evaluate(() => window.__kidmaisMarca ?? null)) === 'sem-recarga';
    async function login() {
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
    }
    async function trocar(id) {
      await Promise.all([page.waitForEvent('load'), page.getByLabel('Empresa ativa', { exact: true }).first().selectOption(id)]);
      await page.waitForURL(`${base}/admin/dashboard`);
    }
    async function trocarPorFora(id) {
      const s = await sessaoAtual();
      const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: id } });
      assert.equal(r.status(), 200, 'troca de empresa por fora');
    }
    const aviso = () => page.locator('[data-aviso-contexto]').first();

    await login();
    await trocar(empresas.alfa.id);
    console.log('E2E_LOGIN_ALFA_OK');

    // ---------------------------------------------------------------- 1. Painel
    await page.goto(`${base}/desenvolvedor/empresas/${empresas.alfa.id}`);
    await page.getByRole('heading', { name: /Usuários e vínculos/ }).waitFor();
    await envelhecerSessao();
    const sessaoAntes = (await sessaoAtual()).data;
    await marcar();
    const respostasPapel = [];
    page.on('response', r => { if (r.request().method() === 'POST' && r.url().includes(`/usuarios/${equipe}`)) respostasPapel.push(r.status()); });
    const linha = page.locator('section[aria-labelledby="t-usuarios"] tr', { hasText: emailEquipe });
    await linha.getByRole('button', { name: 'Tornar Gestão', exact: true }).click();
    await page.getByRole('region', { name: 'Confirmar ação no vínculo' }).getByRole('button', { name: 'Confirmar', exact: true }).click();
    const dialogo = page.getByRole('dialog', { name: 'Confirme sua senha' });
    await dialogo.waitFor();
    await dialogo.getByLabel('Senha', { exact: true }).fill('senha-incorreta-123');
    await dialogo.getByRole('button', { name: 'Confirmar e continuar' }).click();
    await dialogo.getByText('Senha incorreta.', { exact: true }).waitFor();
    assert.equal(await dialogo.isVisible(), true, 'o diálogo continua aberto');
    assert.equal(await marcaIntacta(), true, 'senha incorreta não recarrega a página');
    const sessaoDepoisErro = (await sessaoAtual()).data;
    assert.equal(sessaoDepoisErro.sessaoId, sessaoAntes.sessaoId, 'senha incorreta mantém a sessão');
    assert.equal(sessaoDepoisErro.contexto.empresaAtual.id, empresas.alfa.id, 'senha incorreta mantém a empresa');
    assert.equal(await contar('MEMBERSHIP_PAPEL_ALTERADO', membershipEquipe), 0);
    resultados.push('Painel: senha incorreta manteve sessão, empresa, diálogo e tela; nada executado');
    await dialogo.getByLabel('Senha', { exact: true }).fill(password);
    await dialogo.getByRole('button', { name: 'Confirmar e continuar' }).click();
    await page.getByText('Papel de Equipe Reauth UI alterado.', { exact: true }).waitFor();
    assert.equal(await marcaIntacta(), true, 'permanece na tela, sem recarregar');
    assert.equal(new URL(page.url()).pathname, `/desenvolvedor/empresas/${empresas.alfa.id}`);
    assert.equal(await contar('MEMBERSHIP_PAPEL_ALTERADO', membershipEquipe), 1, 'operação concluída uma única vez');
    assert.deepEqual(respostasPapel, [403, 200], 'só a recusa por reautenticação (sem efeito) e uma execução');
    const renovada = (await sessaoAtual()).data;
    assert.notEqual(renovada.sessaoId, sessaoAntes.sessaoId, 'a reautenticação renovou a sessão');
    assert.equal(renovada.contexto.empresaAtual.id, empresas.alfa.id, 'mesma empresa após a renovação');
    resultados.push('Painel: senha correta renovou a sessão, concluiu a operação uma vez e permaneceu na tela');
    console.log('E2E_PAINEL_REAUTH_OK');

    // ---------------------------------------------------------------- 2. Perfil da empresa
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    const campo = (rotulo) => page.getByRole('textbox', { name: new RegExp(`^${rotulo}`) }).first();
    await campo('Nome comercial').waitFor();
    const nomeComercial = `Alfa Reauth ${randomBytes(2).toString('hex')}`;
    await campo('Nome comercial').fill(nomeComercial);
    await campo('Razão social').fill('Alfa Reauth Festas Ltda');
    await campo('CNPJ').fill('11.222.333/0001-81');
    await campo('CEP').fill('01001000');
    await campo('Logradouro').fill('Praça da Sé');
    await campo('Nº').fill('100');
    await campo('Bairro').fill('Sé');
    await campo('Cidade').fill('São Paulo');
    await campo('UF').fill('SP');
    const mesmo = page.getByRole('checkbox', { name: 'Mesmo endereço da sede' });
    if (!(await mesmo.isChecked())) await mesmo.check();
    const detalhes = page.locator('details', { has: page.getByText('Detalhes da unidade e referência de chegada') });
    if (!(await detalhes.evaluate((el) => el.open))) await detalhes.locator('summary').click();
    await campo('Nome da unidade').fill('Unidade Sé');
    await page.getByRole('textbox', { name: 'Telefone', exact: true }).fill('(11) 3333-4444');
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    await page.getByText('Rascunho salvo.', { exact: true }).first().waitFor();
    await envelhecerSessao();
    await marcar();
    await page.getByRole('button', { name: 'Revisar e aplicar', exact: true }).click();
    const revisao = page.getByRole('dialog', { name: 'Revisar e aplicar' });
    await revisao.getByLabel('Motivo da aplicação').fill('Teste E2E de reautenticação');
    await revisao.getByLabel('Senha, se a sessão tiver mais de 5 minutos').fill('senha-incorreta-123');
    await revisao.getByRole('checkbox').check();
    await revisao.getByRole('button', { name: 'Confirmar e aplicar' }).click();
    await revisao.getByText('Senha incorreta. O rascunho foi preservado.', { exact: true }).waitFor();
    assert.equal(await marcaIntacta(), true, 'senha incorreta não recarrega o Perfil');
    assert.equal(await campo('Nome comercial').inputValue(), nomeComercial, 'formulário preservado');
    assert.equal(await revisao.getByLabel('Motivo da aplicação').inputValue(), 'Teste E2E de reautenticação', 'motivo preservado');
    assert.equal(await contar('PERFIL_CADASTRO_APLICADO'), 0);
    assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.alfa.id);
    resultados.push('Perfil: senha incorreta preservou rascunho, formulário, motivo, sessão e empresa');
    await revisao.getByLabel('Senha, se a sessão tiver mais de 5 minutos').fill(password);
    if (!(await revisao.getByRole('checkbox').isChecked())) await revisao.getByRole('checkbox').check();
    await revisao.getByRole('button', { name: 'Confirmar e aplicar' }).click();
    try {
        await page.getByText('Cadastro aplicado. Contratos e PDFs existentes não foram alterados.', { exact: true }).first().waitFor({ timeout: 30000 });
    }
    catch {
        const alertas = await page.locator('[role=alert],[role=status]').allInnerTexts();
        throw Error(`PERFIL_NAO_APLICOU: ${JSON.stringify(alertas).slice(0, 600)}`);
    }
    assert.equal(await marcaIntacta(), true, 'aplicou na mesma tela');
    assert.equal(await contar('PERFIL_CADASTRO_APLICADO'), 1, 'aplicado uma única vez');
    resultados.push('Perfil: reautenticou e aplicou uma vez, sem recarregar a página');
    console.log('E2E_PERFIL_REAUTH_OK');
    await page.keyboard.press('Escape');

    // ---------------------------------------------------------------- 3–5. Troca de contexto durante a escrita
    const URL_PERFIL = '**/api/admin/configuracoes/perfil-empresa';
    const salvarComInterceptacao = async (manipular) => {
      const envios = [];
      const ouvinte = (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/admin/configuracoes/perfil-empresa')) envios.push(req.url()); };
      page.on('request', ouvinte);
      await page.route(URL_PERFIL, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await manipular(route);
      });
      await campo('Nome comercial').fill(`Alfa Reauth ${randomBytes(2).toString('hex')}`);
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      return { envios, encerrar: async () => { await page.unroute(URL_PERFIL); page.off('request', ouvinte); } };
    };
    const abrirPerfilNaAlfa = async () => {
      if ((await sessaoAtual()).data.contexto.empresaAtual?.id !== empresas.alfa.id) await trocar(empresas.alfa.id);
      await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
      await campo('Nome comercial').waitFor();
    };

    // 3. Troca ANTES do processamento: o pedido segue com o contexto antigo e é recusado.
    let salvos = await contar('PERFIL_RASCUNHO_SALVO');
    let teste = await salvarComInterceptacao(async (route) => { await trocarPorFora(empresas.beta.id); await route.continue(); });
    await aviso().waitFor();
    const avisoAntes = (await aviso().innerText()).replace(/\s*×$/, '');
    assert.match(avisoAntes, /Nada foi alterado|Nada foi enviado|não foi concluída/);
    assert.equal(new URL(page.url()).pathname, '/admin/dashboard', 'dados da tela antiga descartados');
    assert.equal(await page.getByText('Alfa Reauth Festas Ltda').count(), 0);
    assert.equal(teste.envios.length, 1, 'nenhuma repetição automática');
    assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos, 'nada salvo com o contexto antigo');
    await teste.encerrar();
    resultados.push(`Troca antes do processamento: nada alterado, tela descartada, sem repetição. Aviso: "${avisoAntes}"`);
    console.log('E2E_TROCA_ANTES_OK');

    // 4. Escrita concluída e troca ANTES da resposta: aviso "concluída", tela descartada, sem repetição.
    await abrirPerfilNaAlfa();
    salvos = await contar('PERFIL_RASCUNHO_SALVO');
    teste = await salvarComInterceptacao(async (route) => {
      const resposta = await route.fetch();
      await trocarPorFora(empresas.beta.id);
      await route.fulfill({ response: resposta });
    });
    await aviso().waitFor();
    const avisoDepois = (await aviso().innerText()).replace(/\s*×$/, '');
    assert.match(avisoDepois, /concluída antes da mudança/);
    assert.equal(new URL(page.url()).pathname, '/admin/dashboard');
    assert.equal(teste.envios.length, 1, 'nenhuma repetição automática');
    assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos + 1, 'executada exatamente uma vez');
    assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id);
    await teste.encerrar();
    resultados.push(`Troca depois da escrita: executada uma vez, tela descartada. Aviso: "${avisoDepois}"`);
    console.log('E2E_TROCA_DEPOIS_OK');

    // 4b. G16 com a corrida FORÇADA, em ordem determinística (a da falha original):
    //   (1) leitura concorrente real (logo da empresa) com a RESPOSTA presa; (2) escrita concluída, empresa trocada antes da
    //   resposta → a página guarda "concluída" e inicia o descarte; (3) a navegação de descarte fica presa, a página antiga
    //   continua viva; (4) a resposta do logo é liberada e a confirmação de sessão DESSA leitura falha (abortada);
    //   (5) a navegação segue. O aviso que fica tem de ser o da escrita, executada uma única vez.
    await abrirPerfilNaAlfa();
    salvos = await contar('PERFIL_RASCUNHO_SALVO');
    const URL_LOGO = '**/api/admin/configuracoes/perfil-empresa/logo';
    let liberarLogo; const logoLiberado = new Promise((r) => { liberarLogo = r; });
    let logoPedido; const logoPreso = new Promise((r) => { logoPedido = r; });
    await page.route(URL_LOGO, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      logoPedido(); await logoLiberado; await route.continue();
    });
    let abortarConfirmacao = false; let abortou; const confirmacaoAbortada = new Promise((r) => { abortou = r; });
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (abortarConfirmacao && route.request().method() === 'GET') { abortarConfirmacao = false; await route.abort('failed'); abortou(); return; }
      await route.continue();
    });
    let liberarNavegacao; const navegacaoLiberada = new Promise((r) => { liberarNavegacao = r; });
    let navegou; const navegacaoPresa = new Promise((r) => { navegou = r; });
    await page.route('**/admin/dashboard', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      navegou(); await navegacaoLiberada; await route.continue();
    });
    // (1) leitura concorrente: o LogoEmpresa recarrega neste evento (adminFetch GET .../logo); a resposta fica presa.
    await page.evaluate(() => window.dispatchEvent(new Event('kidmais-logo-aplicada')));
    await logoPreso;
    // (2) escrita: o servidor executa; a empresa é trocada antes de a resposta chegar à página.
    teste = await salvarComInterceptacao(async (route) => {
      const resposta = await route.fetch();
      await trocarPorFora(empresas.beta.id);
      await route.fulfill({ response: resposta });
    });
    // (3) a escrita guardou o aviso e pediu a navegação de descarte, que fica presa.
    await navegacaoPresa;
    rastro.push({ ms: Date.now() - t0, evento: 'g16-escrita-descartou-navegacao-presa', caminho: '/admin/dashboard' });
    // (4) a leitura recebe a resposta e a confirmação dela falha, ainda na página antiga.
    abortarConfirmacao = true;
    liberarLogo();
    await confirmacaoAbortada;
    rastro.push({ ms: Date.now() - t0, evento: 'g16-confirmacao-da-leitura-abortada', caminho: '/api/admin/autenticacao' });
    await page.waitForTimeout(300);
    // (5) a navegação segue; a próxima tela mostra o aviso guardado.
    liberarNavegacao();
    await page.waitForURL(`${base}/admin/dashboard`);
    await page.unroute('**/admin/dashboard'); await page.unroute('**/api/admin/autenticacao'); await page.unroute(URL_LOGO);
    await aviso().waitFor();
    const avisoCorrida = (await aviso().innerText()).replace(/\s*×$/, '');
    assert.match(avisoCorrida, /concluída antes da mudança/, 'o descarte da leitura não apaga o resultado da escrita');
    assert.equal(teste.envios.length, 1, 'nenhuma repetição automática');
    assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos + 1, 'executada exatamente uma vez');
    assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id);
    await teste.encerrar();
    resultados.push(`G16, corrida forçada (leitura com a confirmação falhando depois da escrita, navegação presa): executada uma vez; aviso "${avisoCorrida}"`);
    console.log('E2E_G16_CORRIDA_OK');

    // 4c. Troca de empresa PELA PÁGINA (descarte sem aviso próprio) com uma leitura em andamento cuja confirmação de sessão
    //     falha DEPOIS de a troca iniciar a navegação (pedido abortado pela própria navegação). Nenhum aviso de leitura
    //     pode sobrar para as telas seguintes (falha do G16-02 de 10/10: aviso antigo exibido no Perfil).
    await abrirPerfilNaAlfa();
    let liberarLogoC; const logoLiberadoC = new Promise((r) => { liberarLogoC = r; });
    let logoPedidoC; const logoPresoC = new Promise((r) => { logoPedidoC = r; });
    await page.route(URL_LOGO, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      logoPedidoC(); await logoLiberadoC; await route.continue();
    });
    let abortarC = false; let abortouC; const abortadaC = new Promise((r) => { abortouC = r; });
    await page.route('**/api/admin/autenticacao', async (route) => {
      if (abortarC && route.request().method() === 'GET') { abortarC = false; await route.abort('failed'); abortouC(); return; }
      await route.continue();
    });
    let liberarNavC; const navLiberadaC = new Promise((r) => { liberarNavC = r; });
    let navegouC; const navPresaC = new Promise((r) => { navegouC = r; });
    await page.route('**/admin/dashboard', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      navegouC(); await navLiberadaC; await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('kidmais-logo-aplicada')));
    await logoPresoC;
    await page.getByLabel('Empresa ativa', { exact: true }).first().selectOption(empresas.beta.id);
    await navPresaC;                        // a troca concluiu e pediu o painel (descarte sem aviso)
    abortarC = true; liberarLogoC();        // a leitura recebe a resposta; a confirmação dela falha agora
    await abortadaC;
    await page.waitForTimeout(300);
    liberarNavC();
    await page.waitForURL(`${base}/admin/dashboard`);
    await page.unroute('**/admin/dashboard'); await page.unroute('**/api/admin/autenticacao'); await page.unroute(URL_LOGO);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-aviso-contexto]').count(), 0, 'nenhum aviso de leitura no painel depois da troca');
    // Tela seguinte (a empresa ativa agora é a Beta, sem Perfil na fixture): basta a tela carregar com o shell.
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByLabel('Empresa ativa', { exact: true }).first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-aviso-contexto]').count(), 0, 'nem nas telas seguintes');
    resultados.push('Troca de empresa pela página com leitura abortada depois: nenhum aviso de leitura sobra para as telas seguintes');
    console.log('E2E_G16_TROCA_SEM_AVISO_OK');

    // 6–7. Troca de empresa seguida de FALHA na consulta de confirmação da sessão (contexto desconhecido).
    // Enquanto armada, toda leitura de /api/admin/autenticacao feita pela página falha (rede); desarma quando a página
    // é descartada para o dashboard. A troca é feita pela API do contexto (fora da página), sem passar pelas rotas.
    let falharConfirmacao = false;
    await page.route('**/api/admin/autenticacao', (route) => (falharConfirmacao && route.request().method() === 'GET' ? route.abort('failed') : route.continue()));
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && frame.url().includes('/admin/dashboard')) falharConfirmacao = false; });
    // Detector no navegador: registra se o formulário do Perfil chegou a receber os dados da Alfa.
    const vistos = [];
    await page.exposeBinding('kidmaisViuDadosAlfa', (_fonte, valor) => { vistos.push(valor); });
    await page.addInitScript(() => {
      const timer = setInterval(() => {
        const campoRazao = document.querySelector('input[aria-label^="Razão social"]');
        if (campoRazao && campoRazao.value.includes('Alfa Reauth')) { window.kidmaisViuDadosAlfa(campoRazao.value); clearInterval(timer); }
      }, 5);
    });

    // 6. LEITURA: o GET do Perfil responde com dados da Alfa, a empresa é trocada e a confirmação falha.
    if ((await sessaoAtual()).data.contexto.empresaAtual?.id !== empresas.alfa.id) await trocar(empresas.alfa.id);
    vistos.length = 0;
    await page.route(URL_PERFIL, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const resposta = await route.fetch();
      await trocarPorFora(empresas.beta.id);
      falharConfirmacao = true;
      await route.fulfill({ response: resposta });
    });
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.waitForURL(`${base}/admin/dashboard`);
    await aviso().waitFor();
    const avisoLeitura = (await aviso().innerText()).replace(/\s*×$/, '');
    assert.match(avisoLeitura, /Não foi possível confirmar a empresa ativa depois da leitura\. Os dados recebidos foram descartados/);
    assert.deepEqual(vistos, [], 'os dados da Alfa nunca chegaram ao formulário');
    assert.equal(await page.getByText('Alfa Reauth Festas Ltda').count(), 0);
    assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id, 'sessão segue na empresa trocada');
    await page.unroute(URL_PERFIL);
    resultados.push(`Leitura + troca + falha da confirmação: dados da Alfa nunca entregues ao formulário, tela descartada. Aviso: "${avisoLeitura}"`);
    console.log('E2E_LEITURA_FALHA_CONFIRMACAO_OK');

    // 7. ESCRITA confirmada pelo servidor, troca de empresa e falha na confirmação: continua "concluída".
    vistos.length = 0;
    await abrirPerfilNaAlfa();
    // Controle do detector: num carregamento normal (contexto confirmado) ele registra os dados da Alfa.
    for (let n = 0; n < 100 && vistos.length === 0; n++) await page.waitForTimeout(50);
    assert.ok(vistos.length > 0, 'controle: o detector vê os dados quando a leitura é confirmada');
    salvos = await contar('PERFIL_RASCUNHO_SALVO');
    teste = await salvarComInterceptacao(async (route) => {
      const resposta = await route.fetch();
      await trocarPorFora(empresas.beta.id);
      falharConfirmacao = true;
      await route.fulfill({ response: resposta });
    });
    await page.waitForURL(`${base}/admin/dashboard`);
    await aviso().waitFor();
    const avisoEscrita = (await aviso().innerText()).replace(/\s*×$/, '');
    assert.match(avisoEscrita, /A operação foi concluída, mas não foi possível confirmar a empresa ativa em seguida/);
    assert.doesNotMatch(avisoEscrita, /incerto/i, 'resposta confirmada não vira resultado incerto');
    assert.equal(teste.envios.length, 1, 'nenhuma repetição automática');
    assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos + 1, 'executada exatamente uma vez');
    await teste.encerrar();
    resultados.push(`Escrita confirmada + troca + falha da confirmação: executada uma vez, tela descartada, sem "incerto". Aviso: "${avisoEscrita}"`);
    console.log('E2E_ESCRITA_FALHA_CONFIRMACAO_OK');
    await page.unroute('**/api/admin/autenticacao');

    // 5. Suspensão da empresa durante a escrita, com a resposta perdida: resultado incerto, sem repetição.
    await abrirPerfilNaAlfa();
    salvos = await contar('PERFIL_RASCUNHO_SALVO');
    teste = await salvarComInterceptacao(async (route) => {
      await route.fetch();
      await client.query("UPDATE empresas SET status='SUSPENSA' WHERE id=$1", [empresas.alfa.id]);
      await route.abort('connectionreset');
    });
    const incerto = page.getByText(/Resultado incerto/).first();
    await incerto.waitFor();
    const avisoIncerto = await incerto.innerText();
    assert.equal(teste.envios.length, 1, 'nenhuma repetição automática');
    assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos + 1, 'a escrita chegou ao servidor uma vez');
    await teste.encerrar();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForURL(url => url.pathname === '/admin/login');
    resultados.push(`Suspensão durante a escrita (resposta perdida): sem repetição; sessão da empresa suspensa encerrada (novo login). Mensagem: "${avisoIncerto}"`);
    console.log('E2E_SUSPENSAO_OK');
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresas.alfa.id]);

    fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, emailReal: 'desativado', resultados }, null, 2));
    console.log(JSON.stringify({ ok: true, resultados }));
  } finally {
    fs.writeFileSync(path.join(relatorios, 'rastro-rede.json'), JSON.stringify(rastro, null, 1));
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
