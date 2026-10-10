/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da troca de empresa com respostas de sessão fora de ordem (corrida da sessão revogada na troca).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail (EMAIL_PROVIDER=desativado) ou serviço Render. A ordem das respostas é
 * controlada por rotas do Playwright; o rastro guarda só método, caminho e se havia cookie (nunca o valor).
 * Execute com os três KIDMAIS_* de autorização do descartável, Playwright (KIDMAIS_PLAYWRIGHT_MODULE) e Chrome.
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
  const relatorios = path.resolve('.local-painel-troca-sessao-ui');
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
    await vincular(empresas.alfa.id, equipe, 'ADMINISTRATIVO');
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
    async function login() {
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
    }
    async function trocarPorFora(id) {
      const s = await sessaoAtual();
      const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: id } });
      assert.equal(r.status(), 200, 'troca de empresa por fora');
    }
    const aviso = () => page.locator('[data-aviso-contexto]').first();

    await login();
    await trocarPorFora(empresas.alfa.id);
    console.log('E2E_LOGIN_OK');
    // ------------------------------------------------------------------ cenários da troca de empresa (ordem controlada)
    // Nada é deixado ao acaso: cada resposta só sai quando o roteiro libera. Rotas: só método e caminho são observados.
    const resultadosTroca = [];
    const preparar = async (empresa = empresas.alfa.id, destino = '/admin/dashboard') => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.route('**/api/endereco/consultar-cep', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'CEP indisponível no teste.' }) }));
      await page.waitForLoadState('networkidle').catch(() => undefined);
      // Um cenário anterior que falhou pode ter deixado a sessão do navegador inutilizável: entra de novo.
      if (!(await sessaoAtual()).data?.usuarioId) { await login(); await page.waitForLoadState('networkidle').catch(() => undefined); }
      if ((await sessaoAtual()).data?.contexto?.empresaAtual?.id !== empresa) await trocarPorFora(empresa);
      await page.goto(`${base}${destino}`).catch(async () => { await page.waitForTimeout(500); await page.goto(`${base}${destino}`); });
      await page.getByLabel('Empresa ativa', { exact: true }).first().waitFor();
      await page.waitForLoadState('networkidle').catch(() => undefined);
    };
    /**
     * Segura a PRÓXIMA leitura GET /api/admin/autenticacao da página e, ao liberar, envia-a ao servidor com os MESMOS
     * cabeçalhos do momento do pedido (cookies da sessão de então, nunca registrados): é uma leitura da sessão anterior
     * processada depois da troca. Sem isso, o navegador reenviaria com os cookies novos e a corrida não existiria.
     */
    const segurarLeitura = async () => {
      let pedida; const foiPedida = new Promise((r) => { pedida = r; });
      let liberar; const liberada = new Promise((r) => { liberar = r; });
      let respondida; const foiRespondida = new Promise((r) => { respondida = r; });
      let armada = true;
      await page.route('**/api/admin/autenticacao', async (route) => {
        if (!armada || route.request().method() !== 'GET') return route.continue();
        armada = false;
        const cabecalhos = await route.request().allHeaders();
        rastro.push({ ms: Date.now() - t0, evento: 'leitura-presa', caminho: '/api/admin/autenticacao', comCookieDoEnvio: 'cookie' in cabecalhos });
        pedida();
        await liberada;
        try { const resposta = await route.fetch({ headers: cabecalhos }); await route.fulfill({ response: resposta }); }
        catch { await route.abort('failed').catch(() => undefined); }
        respondida();
      });
      return { foiPedida, liberar: () => liberar(), foiRespondida };
    };
    /** Segura a navegação de documento para `caminho` até liberar (a página antiga continua viva). */
    const segurarNavegacao = async (caminho) => {
      let chegou; const pedida = new Promise((r) => { chegou = r; });
      let liberar; const liberada = new Promise((r) => { liberar = r; });
      await page.route(`**${caminho}`, async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        chegou(); await liberada; await route.continue().catch(() => undefined);
      });
      return { pedida, liberar: () => liberar() };
    };
    const selecionar = (id) => page.getByLabel('Empresa ativa', { exact: true }).first().selectOption(id);
    const disparaLeituraDoShell = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const destinoFinal = async () => { await page.waitForLoadState('load'); await page.waitForTimeout(1500); return new URL(page.url()).pathname; };
    const cenario = async (nome, fn) => {
      try { await fn(); resultadosTroca.push({ nome, ok: true }); console.log(`TROCA_OK ${nome}`); }
      catch (e) { resultadosTroca.push({ nome, ok: false, erro: String(e.message).split('\n')[0].slice(0, 200) }); console.log(`TROCA_FALHOU ${nome}: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
      rastro.push({ ms: Date.now() - t0, evento: 'cenario-fim', caminho: nome });
    };

    // T1. Leitura do AdminShell enviada ANTES da troca e respondida (sessão antiga já revogada) DEPOIS de a troca pedir
    //     a navegação ao painel. Correto: a resposta obsoleta não manda ao login; termina no painel com a Beta.
    await cenario('T1-leitura-antiga-depois-da-troca', async () => {
      await preparar();
      const leitura = await segurarLeitura();
      await disparaLeituraDoShell();
      await leitura.foiPedida;
      const nav = await segurarNavegacao('/admin/dashboard');
      await selecionar(empresas.beta.id);
      await nav.pedida;                       // a troca concluiu (sessão nova) e pediu o painel
      leitura.liberar(); await leitura.foiRespondida;  // a resposta antiga (sessão revogada) chega agora
      await page.waitForTimeout(400);
      nav.liberar();
      assert.equal(await destinoFinal(), '/admin/dashboard', 'resposta da sessão anterior não pode mandar ao login');
      assert.ok((await sessaoAtual()).data?.usuarioId, 'a sessão nova continua válida (CSRF não sobrescrito pela resposta antiga)');
      assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id, 'a sessão nova (Beta) segue válida');
    });

    // T2. Mesma leitura antiga, mas respondida ANTES de a página processar a resposta da troca (ordem que já funcionava).
    await cenario('T2-leitura-antiga-antes-do-fim-da-troca', async () => {
      await preparar();
      const leitura = await segurarLeitura();
      await disparaLeituraDoShell();
      await leitura.foiPedida;
      let liberarTroca; const trocaLiberada = new Promise((r) => { liberarTroca = r; });
      let trocaNoServidor; const trocou = new Promise((r) => { trocaNoServidor = r; });
      await page.route('**/api/admin/autenticacao', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const resposta = await route.fetch(); trocaNoServidor(); await trocaLiberada; await route.fulfill({ response: resposta });
      });
      await selecionar(empresas.beta.id);
      await trocou;                            // o servidor já revogou a sessão antiga
      leitura.liberar(); await leitura.foiRespondida;
      await page.waitForTimeout(400);
      liberarTroca();
      assert.equal(await destinoFinal(), '/admin/dashboard');
      assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id);
    });

    // T3. Sessão REALMENTE inválida (revogada por fora, sem troca nesta página): a próxima leitura manda ao login.
    await cenario('T3-sessao-realmente-revogada', async () => {
      await preparar();
      await client.query('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id = $1 AND revogado_em IS NULL', [user]);
      await disparaLeituraDoShell();
      await page.waitForURL(`${base}/admin/login`);
      await login();
    });

    // T4. Trocas rápidas consecutivas: Alfa → Beta com leitura antiga presa, e logo Beta → Alfa com outra leitura antiga
    //     presa; as duas respostas antigas chegam depois de cada troca. Termina no painel com a Alfa.
    await cenario('T4-trocas-rapidas-consecutivas', async () => {
      await preparar();
      for (const alvo of [empresas.beta.id, empresas.alfa.id]) {
        const leitura = await segurarLeitura();
        await disparaLeituraDoShell();
        await leitura.foiPedida;
        const nav = await segurarNavegacao('/admin/dashboard');
        await selecionar(alvo);
        await nav.pedida;
        leitura.liberar(); await leitura.foiRespondida;
        await page.waitForTimeout(300);
        nav.liberar();
        assert.equal(await destinoFinal(), '/admin/dashboard', `troca para ${alvo === empresas.beta.id ? 'Beta' : 'Alfa'}`);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.getByLabel('Empresa ativa', { exact: true }).first().waitFor();
        await page.waitForLoadState('networkidle').catch(() => undefined);
      }
      assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.alfa.id);
    });

    // T5. Escrita concorrente: o Perfil (Alfa) salva o rascunho; o servidor executa; a troca para a Beta acontece antes de
    //     a resposta da escrita chegar; uma leitura antiga do AdminShell é respondida depois da troca. Correto: uma única
    //     execução, nenhuma repetição, aviso "concluída", painel com a Beta (não o login).
    await cenario('T5-escrita-concorrente-e-leitura-antiga', async () => {
      await preparar(empresas.alfa.id, '/admin/configuracoes/perfil-empresa');
      const nomeComercial = page.getByRole('textbox', { name: /^Nome comercial/ }).first();
      await nomeComercial.waitFor();
      const salvos = await contar('PERFIL_RASCUNHO_SALVO');
      const envios = [];
      page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/admin/configuracoes/perfil-empresa')) envios.push(1); });
      let liberarEscrita; const escritaLiberada = new Promise((r) => { liberarEscrita = r; });
      let escritaExecutada; const executou = new Promise((r) => { escritaExecutada = r; });
      await page.route('**/api/admin/configuracoes/perfil-empresa', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const resposta = await route.fetch(); escritaExecutada(); await escritaLiberada; await route.fulfill({ response: resposta });
      });
      const leitura = await segurarLeitura();
      await disparaLeituraDoShell();
      await leitura.foiPedida;
      await nomeComercial.fill(`Alfa Troca ${randomBytes(2).toString('hex')}`);
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
      await executou;                         // a escrita foi executada no servidor (sessão Alfa)
      const nav = await segurarNavegacao('/admin/dashboard');
      await selecionar(empresas.beta.id);
      await nav.pedida;
      liberarEscrita();                        // a resposta da escrita chega depois da troca
      leitura.liberar(); await leitura.foiRespondida;
      await page.waitForTimeout(500);
      nav.liberar();
      assert.equal(await destinoFinal(), '/admin/dashboard', 'resposta antiga não manda ao login');
      await aviso().waitFor();
      assert.match((await aviso().innerText()), /concluída antes da mudança/, 'a confirmação da escrita é preservada');
      assert.equal(envios.length, 1, 'nenhuma repetição automática');
      assert.equal(await contar('PERFIL_RASCUNHO_SALVO'), salvos + 1, 'executada exatamente uma vez');
      assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id);
    });

    // T6. Controle: troca normal, sem nada preso.
    await cenario('T6-troca-normal', async () => {
      await preparar();
      await Promise.all([page.waitForEvent('load'), selecionar(empresas.beta.id)]);
      assert.equal(await destinoFinal(), '/admin/dashboard');
      assert.equal((await sessaoAtual()).data.contexto.empresaAtual.id, empresas.beta.id);
    });

    resultados.push(...resultadosTroca.map((r) => `${r.nome}: ${r.ok ? 'ok' : `FALHOU (${r.erro})`}`));
    if (resultadosTroca.some((r) => !r.ok)) {
      fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: false, resultados }, null, 2));
      throw Error(`TROCA_CENARIOS_FALHARAM: ${resultadosTroca.filter((r) => !r.ok).map((r) => r.nome).join(', ')}`);
    }
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
