/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da conclusão do painel do desenvolvedor: navegação e saída, Perfil da empresa nova e pendências de implantação.
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail (EMAIL_PROVIDER=desativado) ou serviço Render.
 * Execute com os três KIDMAIS_* de autorização do descartável, Playwright (KIDMAIS_PLAYWRIGHT_MODULE) e Chrome.
 *
 * Cenários:
 *   1. Conta só com concessão de desenvolvedor (sem empresa): o Admin mostra "Sem empresa ativa" com perfil, painel e
 *      sair; nenhum item de negócio no menu; o painel não oferece "Ir para o Admin"; Atividade abre; sair leva ao login
 *      e encerra a sessão no servidor.
 *   2. Gestão de empresa nova sem concessão: /desenvolvedor → 404 neutro com saídas; /rota-inexistente → 404.
 *   3. Perfil da empresa nova: a tela oferece "Criar perfil"; sessão com mais de 5 min pede a senha (reautenticação no
 *      servidor); criação grava perfil, unidade e capacidades; o formulário aparece com o código da empresa.
 *   4. Painel: a ficha lista as pendências; "Implantação concluída" fica bloqueada até o perfil aplicado; depois conclui;
 *      Atividade filtrada pela empresa mostra o registro.
 *   5. Sair a partir da ficha (painel), do perfil (Admin) e no celular (menu, Escape).
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3139;

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
  const relatorios = path.resolve('.local-painel-implantacao-ui');
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
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const emailDev = 'dev-implantacao-ui@exemplo.test', emailResp = 'resp-implantacao-ui@exemplo.test';
    const usuario = async (e, nome) => (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [e, nome, await senhaMod.criarHashSenha(password)])).rows[0].id;
    const dev = await usuario(emailDev, 'Dev Implantação UI');
    const resp = await usuario(emailResp, 'Responsável Implantação UI');
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[dev, resp]]);
    await alterarDesenvolvedor(client, { operacao: 'conceder', email: emailDev, operador: 'E2E sintético', motivo: 'Teste da conclusão do painel' });
    // Contratante nova, já provisionada e com o responsável que aceitou o convite (estado "Em configuração").
    const codigo = `impl-ui-${randomBytes(3).toString('hex')}`;
    const empresa = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,'Nova Contratante UI','PROVISIONAMENTO') RETURNING id`, [codigo])).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresa]);
    await client.query(`INSERT INTO plataforma_empresas_cadastro(empresa_id,nome_empresarial,documento_fiscal,responsavel_nome,email,implantacao,criado_por,atualizado_por)
      VALUES($1,'Nova Contratante Festas Ltda','11222333000181','Responsável Implantação UI',$2,'EM_CONFIGURACAO',$3,$3)`, [empresa, emailResp, dev]);
    const membership = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
      VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresa, resp])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [membership]);
    const contar = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);

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
    async function sairPelo(botao) {
      await botao.click();
      await page.waitForURL(`${base}/admin/login`);
      const depois = await sessaoAtual();
      assert.equal(depois.data.usuarioId, null, 'sessão encerrada no servidor');
    }

    // 1. Desenvolvedor sem empresa.
    await login(emailDev);
    await page.goto(`${base}/admin/dashboard`);
    await page.getByRole('heading', { name: 'Sem empresa ativa', exact: true }).waitFor();
    const menuAdmin = page.getByRole('navigation', { name: 'Menu administrativo', exact: true });
    assert.equal(await menuAdmin.getByRole('link', { name: 'Clientes', exact: true }).count(), 0, 'nenhum item de negócio no menu');
    assert.equal(await menuAdmin.getByRole('link', { name: 'Dashboard', exact: true }).count(), 0, 'nem o Dashboard (a marca continua levando ao início, que mostra este mesmo estado)');
    assert.equal(await menuAdmin.getByRole('link', { name: 'Perfil da empresa', exact: true }).count(), 0);
    assert.ok(await page.getByRole('link', { name: 'Meu perfil e senha' }).count() >= 1);
    assert.ok(await page.getByRole('link', { name: 'Painel do desenvolvedor' }).count() >= 1);
    await page.screenshot({ path: path.join(relatorios, 'admin-sem-empresa.png'), fullPage: true });
    await page.getByRole('link', { name: 'Painel do desenvolvedor' }).first().click();
    await page.waitForURL(`${base}/desenvolvedor`);
    await page.getByRole('heading', { name: 'Resumo da plataforma', exact: true }).waitFor();
    await page.getByText('Sem empresa com acesso ativo no Admin', { exact: false }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Ir para o Admin', exact: true }).count(), 0, '"Ir para o Admin" só com empresa ativa');
    await page.getByRole('link', { name: 'Atividade', exact: true }).click();
    await page.waitForURL(`${base}/desenvolvedor/atividade`);
    await page.getByRole('heading', { name: 'Atividade administrativa', exact: true }).waitFor();
    await page.getByRole('cell', { name: /Concessão|concedido/i }).first().waitFor().catch(() => undefined);
    resultados.push('Dev sem empresa: Admin em "Sem empresa ativa" com saídas; painel sem "Ir para o Admin"; Atividade abre');
    await page.goto(`${base}/admin/perfil`);
    await page.getByRole('heading', { name: 'Meu perfil', exact: true }).waitFor();
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());
    resultados.push('Sair a partir do perfil (Admin, sem empresa) encerra a sessão e leva ao login');
    console.log('E2E_DEV_SEM_EMPRESA_OK');

    // 2. Gestão sem concessão: 404 neutro.
    await login(emailResp);
    const r404 = await page.goto(`${base}/desenvolvedor`);
    assert.equal(r404.status(), 404);
    await page.getByRole('heading', { name: 'Página não encontrada', exact: true }).waitFor();
    assert.equal(await page.getByText('desenvolvedor', { exact: false }).count(), 0, 'o 404 não revela a área');
    await page.getByRole('link', { name: 'Ir para o início', exact: true }).click();
    await page.waitForURL(`${base}/admin/dashboard`);
    const r404b = await page.goto(`${base}/rota-que-nao-existe`);
    assert.equal(r404b.status(), 404);
    await page.getByRole('link', { name: 'Meu perfil e senha', exact: true }).waitFor();
    resultados.push('Sem concessão: /desenvolvedor e rota inexistente respondem 404 neutro com saídas seguras');
    console.log('E2E_404_OK');

    // 3. Perfil da empresa nova (com reautenticação exigida pelo servidor).
    await client.query("UPDATE sessoes_administrativas SET criado_em = criado_em - interval '6 minutes', autenticado_em = autenticado_em - interval '6 minutes' WHERE usuario_id=$1 AND revogado_em IS NULL", [resp]);
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Perfil ainda não criado', exact: true }).waitFor();
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresas'), 0);
    await page.getByRole('button', { name: 'Criar perfil da empresa', exact: true }).click();
    await page.getByText('Confirme sua senha para criar o perfil da empresa', { exact: false }).waitFor();
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresas'), 0, 'sessão antiga: nada criado antes da senha');
    await page.getByLabel('Senha da sua conta', { exact: true }).fill('senha-errada-ui');
    await page.getByRole('button', { name: 'Confirmar senha e criar perfil', exact: true }).click();
    await page.getByText('Senha incorreta. Nada foi criado.', { exact: false }).waitFor();
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresas'), 0);
    await page.getByLabel('Senha da sua conta', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Confirmar senha e criar perfil', exact: true }).click();
    // A mensagem de sucesso aparece na página e dentro do diálogo (fechado) de revisão: basta a primeira.
    await page.getByText('Perfil criado.', { exact: false }).first().waitFor();
    await page.getByRole('heading', { name: 'Perfil da Empresa', exact: true }).waitFor();
    const codigoNaTela = await page.getByLabel('Código da empresa', { exact: false }).inputValue().catch(async () => (await page.locator('input[readonly]').first().inputValue()));
    assert.equal(codigoNaTela, codigo, 'o perfil nasce com o código da empresa');
    const perfil = (await client.query('SELECT id, codigo, nome_comercial, razao_social, cnpj FROM perfil_empresas')).rows;
    assert.equal(perfil.length, 1);
    assert.deepEqual([perfil[0].codigo, perfil[0].nome_comercial, perfil[0].razao_social, perfil[0].cnpj], [codigo, 'Nova Contratante UI', 'Nova Contratante Festas Ltda', '11222333000181']);
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_unidades WHERE empresa_id=$1', [perfil[0].id]), 1);
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id=$1 AND usuario_id=$2 AND revogado_em IS NULL', [perfil[0].id, resp]), 4);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao='PERFIL_ESTRUTURA_CRIADA' AND entidade_id=$1", [perfil[0].id]), 1);
    await page.screenshot({ path: path.join(relatorios, 'perfil-criado.png'), fullPage: true });
    resultados.push('Gestão da empresa nova criou o perfil pela tela: reautenticação exigida (senha errada recusada, nada criado), depois perfil + unidade + 4 capacidades, formulário com o código da empresa');
    console.log('E2E_PERFIL_CRIADO_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());

    // 4. Painel: pendências e conclusão da implantação.
    await login(emailDev);
    await page.goto(`${base}/desenvolvedor/empresas/${empresa}`);
    await page.getByRole('heading', { level: 1, name: /Nova Contratante UI/ }).waitFor();
    const pendencias = page.getByRole('list', { name: 'Pendências de implantação', exact: true });
    await pendencias.waitFor();
    await pendencias.getByText('Cadastro do perfil aplicado (obrigatória)', { exact: false }).waitFor();
    await pendencias.getByText('Perfil criado e associado a esta empresa', { exact: false }).waitFor();
    const concluir = page.getByRole('button', { name: 'Implantação concluída', exact: true });
    assert.equal(await concluir.isDisabled(), true, 'conclusão bloqueada com pendência obrigatória');
    await page.screenshot({ path: path.join(relatorios, 'ficha-pendencias.png'), fullPage: true });
    // O servidor também recusa, independentemente da tela.
    const sessaoDev = await sessaoAtual();
    const revisao = Number((await client.query('SELECT revisao FROM plataforma_empresas_cadastro WHERE empresa_id=$1', [empresa])).rows[0].revisao);
    const recusa = await contexto.request.post(`${base}/api/desenvolvedor/empresas/${empresa}`, { headers: { origin: base, 'x-csrf-token': sessaoDev.data.csrf, 'x-kidmais-sessao': sessaoDev.data.sessaoId },
      data: { acao: 'implantacao', dados: { implantacao: 'CONCLUIDA', revisao } } });
    assert.equal(recusa.status(), 409);
    assert.equal((await recusa.json()).codigo, 'IMPLANTACAO_PENDENTE');
    // A Gestão aplica o cadastro do perfil (fixture direta: a tela do Perfil já é coberta pelos testes do módulo).
    await client.query('UPDATE perfil_empresas SET versao = 1, atualizado_em = clock_timestamp() WHERE id=$1', [perfil[0].id]);
    await page.reload();
    await pendencias.waitFor();
    await pendencias.getByText('Cadastro aplicado (versão 1)', { exact: false }).waitFor();
    await concluir.waitFor();
    assert.equal(await concluir.isDisabled(), false);
    await concluir.click();
    await page.getByText('Implantação: Implantação concluída.', { exact: true }).waitFor();
    assert.equal((await client.query('SELECT implantacao FROM plataforma_empresas_cadastro WHERE empresa_id=$1', [empresa])).rows[0].implantacao, 'CONCLUIDA');
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao='EMPRESA_IMPLANTACAO_RECUSADA' AND entidade_id=$1", [empresa]), 1);
    await page.getByRole('link', { name: 'Ver toda a atividade desta empresa', exact: true }).click();
    await page.waitForURL(`${base}/desenvolvedor/atividade?empresaId=${empresa}`);
    await page.getByRole('cell', { name: /Implantação atualizada/ }).first().waitFor();
    await page.getByRole('cell', { name: /Implantação recusada|implantação/i }).first().waitFor().catch(() => undefined);
    await page.screenshot({ path: path.join(relatorios, 'atividade-empresa.png'), fullPage: true });
    resultados.push('Ficha com pendências reais; CONCLUÍDA bloqueada na tela e recusada pelo servidor (409 IMPLANTACAO_PENDENTE, auditada); liberada após o perfil aplicado; Atividade filtrada pela empresa');
    console.log('E2E_IMPLANTACAO_OK');

    // 5. Celular: menu, Escape e sair a partir da ficha.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/desenvolvedor/empresas/${empresa}`);
    const abrir = page.getByRole('button', { name: 'Abrir menu', exact: true });
    await abrir.click();
    assert.equal(await page.getByRole('button', { name: 'Fechar menu', exact: true }).first().getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Abrir menu', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
    await page.screenshot({ path: path.join(relatorios, 'celular-menu.png') });
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());
    resultados.push('Celular: menu abre, Escape fecha, sair a partir da ficha encerra a sessão');
    console.log('E2E_CELULAR_SAIDA_OK');

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
