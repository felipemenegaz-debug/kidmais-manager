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
 *   6. Perfil existente sem administrador elegível (achado Astra, PR #104): o 403 traz só a elegibilidade (nada do
 *      cadastro); a segunda Gestão assume a administração com confirmação e senha (senha errada: nada concedido);
 *      com administradora elegível, a outra Gestão vê a explicação, sem botão, e o servidor recusa com 409.
 *   7. Gestão com só PERFIL_CONSULTAR e nenhum administrador elegível (segunda revisão): o GET 200 traz a elegibilidade,
 *      a tela mostra o formulário (consulta) E a ação de assumir; confirmação + senha (errada: nada); sucesso concede só
 *      as três que faltam e a tela passa a editar; com administradora, quem só consulta não vê a ação e o POST recebe
 *      409; Equipe continua em "Acesso negado" sem ação e com POST recusado.
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
    await receita.restaurar(admin, receita.TRABALHO[0], receita.modeloE2E(process.env));
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    const withTransaction = async (fn) => {
      await client.query('BEGIN');
      try { const r = await fn(client); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK'); throw e; }
    };
    const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, new Map());
    const senhaMod = carregar('lib/autenticacao/senha.ts');
    const password = `sintetica-${randomBytes(12).toString('hex')}`;
    const emailDev = 'dev-implantacao-ui@exemplo.test', emailResp = 'resp-implantacao-ui@exemplo.test', emailResp2 = 'resp2-implantacao-ui@exemplo.test', emailEquipe = 'equipe-implantacao-ui@exemplo.test';
    const usuario = async (e, nome) => (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [e, nome, await senhaMod.criarHashSenha(password)])).rows[0].id;
    const dev = await usuario(emailDev, 'Dev Implantação UI');
    const resp = await usuario(emailResp, 'Responsável Implantação UI');
    const resp2 = await usuario(emailResp2, 'Segunda Gestão Implantação UI');
    const equipe = await usuario(emailEquipe, 'Equipe Implantação UI');
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[dev, resp, resp2, equipe]]);
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
    const membership2 = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
      VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresa, resp2])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [membership2]);
    const membershipEquipe = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel)
      VALUES($1,$2,'PENDENTE',clock_timestamp(),'ADMINISTRATIVO') RETURNING id`, [empresa, equipe])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [membershipEquipe]);
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
    // Resumo: a implantação incompleta aparece como alerta acionável que leva à seção da ficha.
    await page.goto(`${base}/desenvolvedor`);
    const alertas = page.getByRole('list', { name: 'Alertas acionáveis', exact: true });
    await alertas.waitFor();
    const incompleta = alertas.locator('li[data-alerta="IMPLANTACAO_INCOMPLETA"]').filter({ hasText: 'Nova Contratante UI' });
    await incompleta.getByText('cadastro do perfil aplicado', { exact: false }).waitFor();
    assert.equal(await incompleta.getByRole('link', { name: 'Abrir implantação', exact: true }).getAttribute('href'), `/desenvolvedor/empresas/${empresa}#t-cadastro`);
    await page.screenshot({ path: path.join(relatorios, 'resumo-alertas.png'), fullPage: true });
    await page.goto(`${base}/desenvolvedor/empresas/${empresa}`);
    await pendencias.waitFor();
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
    await page.goto(`${base}/desenvolvedor`);
    await page.getByRole('heading', { name: /O que precisa de ação/ }).waitFor();
    assert.equal(await page.locator('li[data-alerta="IMPLANTACAO_INCOMPLETA"]').filter({ hasText: 'Nova Contratante UI' }).count(), 0, 'alerta some depois da conclusão');
    resultados.push('Ficha com pendências reais; CONCLUÍDA bloqueada na tela e recusada pelo servidor (409 IMPLANTACAO_PENDENTE, auditada); liberada após o perfil aplicado; Atividade filtrada pela empresa; alerta "Implantação incompleta" no resumo com link para a ficha, que some depois da conclusão');
    console.log('E2E_IMPLANTACAO_OK');

    // 5. Celular: menu, Escape e sair a partir da ficha.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/desenvolvedor`);
    await page.getByRole('heading', { name: /O que precisa de ação/ }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'resumo sem rolagem horizontal no celular');
    await page.screenshot({ path: path.join(relatorios, 'celular-resumo-alertas.png'), fullPage: true });
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

    // 6. Perfil existente sem administrador elegível (achado Astra): a Gestão assume a administração pela tela.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const ativasDoPerfil = (usuarioId) => contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id=$1 AND revogado_em IS NULL AND ($2::uuid IS NULL OR usuario_id=$2::uuid)', [perfil[0].id, usuarioId || null]);
    await client.query("UPDATE perfil_empresa_concessoes SET revogado_em = clock_timestamp(), revogado_por = $2, motivo_revogacao = 'Fixture E2E: perfil sem administrador' WHERE empresa_id = $1 AND revogado_em IS NULL", [perfil[0].id, resp]);
    assert.equal(await ativasDoPerfil(), 0, 'ninguém administra o perfil');
    await login(emailResp2);
    await client.query("UPDATE sessoes_administrativas SET criado_em = criado_em - interval '6 minutes', autenticado_em = autenticado_em - interval '6 minutes' WHERE usuario_id=$1 AND revogado_em IS NULL", [resp2]);
    const negado = await contexto.request.get(`${base}/api/admin/configuracoes/perfil-empresa`);
    assert.equal(negado.status(), 403);
    const corpoNegado = await negado.json();
    assert.equal(corpoNegado.codigo, 'PERFIL_SEM_CONCESSAO');
    assert.deepEqual([corpoNegado.detalhes.concessaoInicial.elegivel, corpoNegado.detalhes.concessaoInicial.capacidadesFaltantes.length, corpoNegado.detalhes.empresa.codigo], [true, 4, codigo]);
    assert.doesNotMatch(JSON.stringify(corpoNegado), /nome_comercial|razao_social|cnpj|historico|contexto|versao|Nova Contratante Festas|11222333000181|sede/i, 'o 403 não traz nada do cadastro nem do histórico');
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Acesso negado', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Assumir a administração do perfil', exact: true }).waitFor();
    assert.equal(await page.getByText('Nova Contratante Festas Ltda', { exact: false }).count(), 0, 'nenhum dado do cadastro antes da autorização');
    assert.equal(await page.getByText('11.222.333/0001-81', { exact: false }).count() + await page.getByText('11222333000181', { exact: false }).count(), 0);
    await page.screenshot({ path: path.join(relatorios, 'perfil-acesso-negado-elegivel.png'), fullPage: true });
    const assumir = page.getByRole('button', { name: 'Assumir a administração do perfil', exact: true });
    assert.equal(await assumir.isDisabled(), true, 'sem a confirmação o botão fica desabilitado');
    await page.getByLabel('Confirmo que quero assumir a administração do perfil desta empresa').check();
    await assumir.click();
    await page.getByText('Confirme sua senha para assumir a administração do perfil.', { exact: false }).waitFor();
    assert.equal(await ativasDoPerfil(), 0, 'sessão antiga: nada concedido antes da senha');
    await page.getByLabel('Senha da sua conta', { exact: true }).fill('senha-errada-ui');
    await page.getByRole('button', { name: 'Confirmar senha e assumir a administração', exact: true }).click();
    await page.getByText('Senha incorreta.', { exact: false }).waitFor();
    assert.equal(await ativasDoPerfil(), 0, 'senha errada: nada concedido');
    await page.getByLabel('Senha da sua conta', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Confirmar senha e assumir a administração', exact: true }).click();
    await page.getByText('Administração do perfil assumida: 4 capacidade(s)', { exact: false }).first().waitFor();
    await page.getByRole('heading', { name: 'Perfil da Empresa', exact: true }).waitFor();
    assert.equal(await ativasDoPerfil(resp2), 4);
    assert.equal(await ativasDoPerfil(), 4, 'nenhuma concessão para outra conta');
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao='PERFIL_CONCESSAO_INICIAL' AND entidade_id=$1", [perfil[0].id]), 1);
    await page.screenshot({ path: path.join(relatorios, 'perfil-concessao-inicial.png'), fullPage: true });
    resultados.push('Perfil sem administrador: 403 só com a elegibilidade (nada do cadastro); a Gestão assumiu pela tela com confirmação + senha (senha errada recusada, nada concedido); 4 capacidades e auditoria PERFIL_CONCESSAO_INICIAL');
    console.log('E2E_CONCESSAO_INICIAL_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());
    // Com administradora elegível, a Gestão sem concessões não assume: a tela explica (sem botão) e o servidor recusa.
    await login(emailResp);
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Acesso negado', exact: true }).waitFor();
    await page.getByText('Outra conta administra as concessões deste perfil', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Assumir a administração/ }).count(), 0, 'sem botão quando há administradora');
    const sessaoResp = await sessaoAtual();
    const recusaConcessao = await contexto.request.post(`${base}/api/admin/configuracoes/perfil-empresa`, { headers: { origin: base, 'x-csrf-token': sessaoResp.data.csrf, 'x-kidmais-sessao': sessaoResp.data.sessaoId },
      data: { acao: 'concessao-inicial', confirmar: true } });
    assert.equal(recusaConcessao.status(), 409);
    assert.equal((await recusaConcessao.json()).codigo, 'PERFIL_SEM_CONCESSAO');
    assert.equal(await ativasDoPerfil(resp), 0, 'nada concedido à conta bloqueada');
    assert.equal(await ativasDoPerfil(), 4);
    resultados.push('Com administradora elegível: a outra Gestão vê a explicação sem botão e o POST direto recebe 409 PERFIL_SEM_CONCESSAO, nada concedido');
    console.log('E2E_CONCESSAO_BLOQUEADA_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());

    // 7. Gestão com só PERFIL_CONSULTAR e nenhum administrador elegível: o 200 traz a elegibilidade e a tela oferece a ação.
    await client.query("UPDATE perfil_empresa_concessoes SET revogado_em = clock_timestamp(), revogado_por = $2, motivo_revogacao = 'Fixture E2E: só consultar' WHERE empresa_id = $1 AND usuario_id = $2 AND capacidade <> 'PERFIL_CONSULTAR' AND revogado_em IS NULL", [perfil[0].id, resp2]);
    assert.equal(await ativasDoPerfil(), 1, 'só a consulta de resp2 continua ativa: ninguém administra');
    await login(emailResp2);
    await client.query("UPDATE sessoes_administrativas SET criado_em = criado_em - interval '6 minutes', autenticado_em = autenticado_em - interval '6 minutes' WHERE usuario_id=$1 AND revogado_em IS NULL", [resp2]);
    const parcial = await contexto.request.get(`${base}/api/admin/configuracoes/perfil-empresa`);
    assert.equal(parcial.status(), 200, 'quem consulta recebe 200');
    const corpoParcial = await parcial.json();
    assert.deepEqual(corpoParcial.data.capacidades, { PERFIL_CONSULTAR: true, PERFIL_EDITAR_RASCUNHO: false, PERFIL_APLICAR: false, PERFIL_ADMINISTRAR_CONCESSOES: false });
    assert.deepEqual([corpoParcial.data.concessaoInicial.elegivel, corpoParcial.data.concessaoInicial.motivo, corpoParcial.data.concessaoInicial.capacidadesFaltantes],
      [true, null, ['PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES']], 'o 200 informa a elegibilidade');
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Perfil da Empresa', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Acesso negado', exact: true }).count(), 0, 'quem consulta vê o formulário, não "Acesso negado"');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some((e) => e.value === 'Nova Contratante Festas Ltda'), null, { timeout: 30000 });
    assert.equal(await page.locator('input').evaluateAll((els) => els.filter((e) => e.value === 'Nova Contratante Festas Ltda').length), 1, 'o formulário de consulta continua visível');
    assert.equal(await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).count(), 0, 'sem capacidade de edição, sem botão de salvar');
    const assumirParcial = page.getByRole('button', { name: 'Assumir a administração do perfil', exact: true });
    await assumirParcial.waitFor();
    await page.getByText('editar o rascunho, aplicar o cadastro, administrar as concessões', { exact: false }).waitFor();
    assert.equal(await assumirParcial.isDisabled(), true, 'sem a confirmação o botão fica desabilitado');
    await page.screenshot({ path: path.join(relatorios, 'perfil-consulta-elegivel.png'), fullPage: true });
    await page.getByLabel('Confirmo que quero assumir a administração do perfil desta empresa').check();
    await assumirParcial.click();
    await page.getByText('Confirme sua senha para assumir a administração do perfil.', { exact: false }).waitFor();
    assert.equal(await ativasDoPerfil(), 1, 'sessão antiga: nada concedido antes da senha');
    await page.getByLabel('Senha da sua conta', { exact: true }).fill('senha-errada-ui');
    await page.getByRole('button', { name: 'Confirmar senha e assumir a administração', exact: true }).click();
    await page.getByText('Senha incorreta.', { exact: false }).waitFor();
    assert.equal(await ativasDoPerfil(), 1, 'senha errada: nada concedido');
    await page.getByLabel('Senha da sua conta', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Confirmar senha e assumir a administração', exact: true }).click();
    await page.getByText('Administração do perfil assumida: 3 capacidade(s)', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Assumir a administração/ }).count(), 0, 'a ação some depois de assumir');
    assert.equal(await ativasDoPerfil(resp2), 4);
    assert.equal(await ativasDoPerfil(), 4, 'nenhuma concessão para outra conta');
    assert.equal(await contar("SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id=$1 AND usuario_id=$2 AND capacidade='PERFIL_CONSULTAR'", [perfil[0].id, resp2]), 1, 'a consulta que já existia não foi duplicada');
    const ultimaAuditoria = (await client.query("SELECT dados_depois FROM auditoria WHERE acao='PERFIL_CONCESSAO_INICIAL' AND entidade_id=$1 ORDER BY criado_em DESC LIMIT 1", [perfil[0].id])).rows[0].dados_depois;
    assert.deepEqual([ultimaAuditoria.capacidades, ultimaAuditoria.jaPossuia], [['PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES'], ['PERFIL_CONSULTAR']]);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao='PERFIL_CONCESSAO_INICIAL' AND entidade_id=$1", [perfil[0].id]), 2);
    await page.screenshot({ path: path.join(relatorios, 'perfil-consulta-assumido.png'), fullPage: true });
    resultados.push('Gestão com só PERFIL_CONSULTAR e sem administrador: GET 200 com elegibilidade; formulário de consulta + ação de assumir; confirmação e senha (errada: nada); sucesso concedeu só as 3 que faltavam (auditoria com jaPossuia) e a tela passou a editar');
    console.log('E2E_CONCESSAO_PARCIAL_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());
    // Com administradora elegível (resp2), quem só consulta (resp) não vê a ação; o POST direto é recusado sem elevar.
    await client.query("INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, 'PERFIL_CONSULTAR', $3, 'Fixture E2E: consulta concedida pela administradora', 'TESTE')", [perfil[0].id, resp, resp2]);
    await login(emailResp);
    const consultaComAdmin = await contexto.request.get(`${base}/api/admin/configuracoes/perfil-empresa`);
    assert.equal(consultaComAdmin.status(), 200);
    assert.deepEqual([(await consultaComAdmin.json()).data.concessaoInicial.elegivel, (await consultaComAdmin.json()).data.concessaoInicial.motivo], [false, 'ADMINISTRADOR_EXISTENTE']);
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Perfil da Empresa', exact: true }).waitFor();
    await page.getByText('Outra conta administra as concessões deste perfil', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Assumir a administração/ }).count(), 0, 'com administradora, sem ação');
    const sessaoRespConsulta = await sessaoAtual();
    const recusaParcial = await contexto.request.post(`${base}/api/admin/configuracoes/perfil-empresa`, { headers: { origin: base, 'x-csrf-token': sessaoRespConsulta.data.csrf, 'x-kidmais-sessao': sessaoRespConsulta.data.sessaoId },
      data: { acao: 'concessao-inicial', confirmar: true } });
    assert.equal(recusaParcial.status(), 409);
    assert.equal((await recusaParcial.json()).codigo, 'PERFIL_SEM_CONCESSAO');
    assert.equal(await ativasDoPerfil(resp), 1, 'nada elevado: continua só com a consulta');
    resultados.push('Com administradora elegível, quem só consulta recebe 200 sem elegibilidade, vê a explicação sem botão e o POST direto recebe 409 sem elevar');
    console.log('E2E_CONCESSAO_PARCIAL_BLOQUEADA_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());
    // Equipe: continua em "Acesso negado", sem ação, e o POST é recusado.
    await login(emailEquipe);
    const equipeGet = await contexto.request.get(`${base}/api/admin/configuracoes/perfil-empresa`);
    assert.equal(equipeGet.status(), 403);
    assert.equal((await equipeGet.json()).detalhes.concessaoInicial.motivo, 'SEM_GESTAO');
    await page.goto(`${base}/admin/configuracoes/perfil-empresa`);
    await page.getByRole('heading', { name: 'Acesso negado', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Assumir a administração/ }).count(), 0, 'Equipe não vê a ação');
    const sessaoEquipe = await sessaoAtual();
    const recusaEquipe = await contexto.request.post(`${base}/api/admin/configuracoes/perfil-empresa`, { headers: { origin: base, 'x-csrf-token': sessaoEquipe.data.csrf, 'x-kidmais-sessao': sessaoEquipe.data.sessaoId },
      data: { acao: 'concessao-inicial', confirmar: true } });
    assert.equal(recusaEquipe.status(), 403);
    assert.equal((await recusaEquipe.json()).codigo, 'PAPEL_NAO_AUTORIZADO');
    assert.equal(await ativasDoPerfil(equipe), 0);
    resultados.push('Equipe: 403 com motivo SEM_GESTAO, "Acesso negado" sem ação, POST recusado (PAPEL_NAO_AUTORIZADO), nada concedido');
    console.log('E2E_CONCESSAO_EQUIPE_OK');
    await sairPelo(page.getByRole('button', { name: /^Sair$/ }).first());

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
