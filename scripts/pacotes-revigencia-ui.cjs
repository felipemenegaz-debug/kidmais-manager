/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in de re-salvar um pacote em Configurações → Pacotes, com PostgreSQL DESCARTÁVEL e dados sintéticos (modelo 089).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 089 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail, provedor ou serviço Render. Execute com os três KIDMAIS_* de autorização
 * do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 *   - Novo pacote pela tela (sábado, todos os períodos) e "Salvar alterações" sem mudar nada: salva e as regras ficam as
 *     mesmas (antes: "Vigência de regra de pacote sobreposta").
 *   - Regras envelhecidas 10 dias; acrescenta domingo mantendo sábado: sábado intacto, domingo começa hoje.
 *   - Pacote usado (fechamento sintético): remove domingo mantendo sábado; a revisão nova guarda sábado e desativa domingo.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3161;

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
  const relatorios = path.resolve(process.env.KIDMAIS_PACOTES_UI_RELATORIOS || '.local-pacotes-revigencia-ui');
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
    const usuario = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES('gestao-revig-ui@exemplo.test','Gestão Revigência UI',$1,'ADMINISTRATIVO') RETURNING id`, [hash])).rows[0].id;
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [usuario]);
    const EMPRESA = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,'Buffet Revigência UI','PROVISIONAMENTO') RETURNING id`, [`rv-${randomBytes(3).toString('hex')}`])).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [EMPRESA]);
    const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [EMPRESA, usuario])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'AGENDA_PUBLICA_EMPRESA_ID']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 180; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.status < 500).catch(() => false)) break;
      if (n === 179) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexto.setDefaultTimeout(90000);
    const page = await contexto.newPage();
    await page.goto(`${base}/admin/login`);
    await page.getByLabel('Email', { exact: true }).fill('gestao-revig-ui@exemplo.test');
    await page.getByLabel('Senha', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));

    const NOME = 'Festa Revigência UI';
    /** Regras do pacote vigente com datas relativas a hoje (0 = hoje, -1 = ontem). */
    const vigente = async () => (await client.query('SELECT id FROM pacotes WHERE empresa_id=$1 AND nome=$2 AND vigente', [EMPRESA, NOME])).rows[0].id;
    const regras = async (pacoteId) => (await client.query(
      `SELECT id::text AS id, dia_semana::int AS dia, estado, (vigencia_inicio - CURRENT_DATE)::int AS inicio,
              (vigencia_fim - CURRENT_DATE)::int AS fim, ativo
         FROM regras_disponibilidade_pacote WHERE pacote_id=$1 ORDER BY dia_semana, configuracao_agenda_id, vigencia_inicio`, [pacoteId])).rows;
    async function todosOsHorarios(rotulo) {
      const botoes = page.getByRole('group', { name: `Horários de ${rotulo}` }).getByRole('button');
      await botoes.first().waitFor();
      const total = await botoes.count();
      for (let i = 0; i < total; i++) {
        const botao = botoes.nth(i);
        if (await botao.getAttribute('aria-pressed') !== 'true') await botao.click();
        await page.waitForFunction((el) => el.getAttribute('aria-pressed') === 'true', await botao.elementHandle());
      }
      return total;
    }
    async function abrirEdicao() {
      await page.goto(`${base}/admin/configuracoes/pacotes`);
      const lateral = page.getByRole('complementary', { name: 'Pacotes já criados' });
      await lateral.getByText(NOME, { exact: false }).first().waitFor();
      await lateral.getByRole('button', { name: 'Editar', exact: true }).first().click();
      await page.waitForFunction((nome) => document.querySelector('#pacote-nome')?.value === nome, NOME);
      await page.getByRole('group', { name: 'Horários de Sáb' }).waitFor();
    }
    async function salvarAlteracoes(arquivo) {
      const resposta = page.waitForResponse((r) => r.url().includes('/api/admin/configuracoes/pacotes') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      const r = await resposta;
      const corpo = await r.text();
      assert.ok(r.ok(), `salvar respondeu ${r.status()}: ${corpo.slice(0, 300)}`);
      await page.getByText('Alterações salvas.', { exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByText('sobreposta', { exact: false }).count(), 0, 'sem erro de vigência na tela');
      await page.screenshot({ path: path.join(relatorios, arquivo), fullPage: true });
    }

    // Novo pacote pela tela: sábado em todos os períodos, uma faixa de preço.
    await page.goto(`${base}/admin/configuracoes/pacotes`);
    await page.getByRole('button', { name: 'Novo pacote', exact: true }).click();
    await page.locator('#pacote-nome').fill(NOME);
    await page.locator('#pacote-min').fill('30');
    await page.locator('#pacote-max').fill('80');
    await page.getByLabel('Horas', { exact: true }).fill('4');
    await page.getByRole('group', { name: 'Dias permitidos' }).getByRole('button', { name: 'Sáb', exact: true }).click();
    const periodos = await todosOsHorarios('Sáb');
    await page.getByRole('button', { name: '+ Adicionar faixa', exact: true }).click();
    const faixa = page.locator('section').filter({ has: page.getByRole('heading', { name: '3. Preços' }) });
    await faixa.getByLabel('De', { exact: true }).last().fill('30');
    await faixa.getByLabel('Até', { exact: true }).last().fill('80');
    await faixa.getByLabel('Preço', { exact: true }).last().fill('4500,00');
    const criado = page.waitForResponse((r) => r.url().includes('/api/admin/configuracoes/pacotes') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Salvar pacote', exact: true }).click();
    assert.ok([200, 201].includes((await criado).status()), 'criar respondeu 2xx');
    await page.getByText('Pacote salvo.', { exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    const original = await vigente();
    const iniciais = await regras(original);
    assert.equal(iniciais.length, periodos, 'uma regra por período de sábado');

    // R1: re-salvar sem mudar nada, no mesmo dia.
    await abrirEdicao();
    await salvarAlteracoes('r1-resalvar-igual.png');
    assert.equal(await vigente(), original, 'R1: não usado edita a mesma linha');
    assert.deepEqual(await regras(original), iniciais, 'R1: mesmas regras');
    resultados.push(`R1 re-salvar sem mudanças: "Alterações salvas.", ${periodos} regras de sábado intactas (mesmos ids)`);
    console.log('E2E_REVIGENCIA_R1_OK');

    // R2: regras de 10 dias atrás; acrescenta domingo (todos os períodos) mantendo sábado.
    await client.query('UPDATE regras_disponibilidade_pacote SET vigencia_inicio = vigencia_inicio - 10 WHERE pacote_id=$1', [original]);
    const envelhecidas = await regras(original);
    await abrirEdicao();
    await page.getByRole('group', { name: 'Dias permitidos' }).getByRole('button', { name: 'Dom', exact: true }).click();
    await todosOsHorarios('Dom');
    await salvarAlteracoes('r2-acrescenta-domingo.png');
    const r2 = await regras(original);
    assert.deepEqual(r2.filter((r) => r.dia === 6), envelhecidas, 'R2: sábado intacto (início -10, aberto)');
    assert.deepEqual(r2.filter((r) => r.dia === 7).map(({ estado, inicio, fim, ativo }) => ({ estado, inicio, fim, ativo })),
      Array.from({ length: periodos }, () => ({ estado: 'DISPONIVEL', inicio: 0, fim: null, ativo: true })), 'R2: domingo começa hoje');
    resultados.push('R2 regras de 10 dias atrás + domingo: sábado intacto, domingo novo com início hoje');
    console.log('E2E_REVIGENCIA_R2_OK');

    // R3: pacote usado; remove domingo mantendo sábado → revisão nova.
    const preco = (await client.query('SELECT id, tabela_preco_id, valor FROM precos_pacote WHERE pacote_id=$1 AND ativo LIMIT 1', [original])).rows[0];
    const turno = (await client.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_1' AND ativo")).rows[0].id;
    await client.query(
      `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
         categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, desconto_percentual, valor_desconto_pacote,
         valor_pacote_aplicado, valor_adicionais, valor_tabela, status, origem_fechamento)
       VALUES (CURRENT_DATE + 40, TIME '10:00', TIME '14:00', $1, $2, $3, $4, $5, 'PADRAO', 'PADRAO', 40, 40, $6, 0, 0, $6, 0, $6, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS')`,
      [turno, EMPRESA, original, preco.tabela_preco_id, preco.id, preco.valor]);
    await abrirEdicao();
    await page.getByRole('group', { name: 'Dias permitidos' }).getByRole('button', { name: 'Dom', exact: true }).click();
    await salvarAlteracoes('r3-usado-remove-domingo.png');
    const revisao = await vigente();
    assert.notEqual(revisao, original, 'R3: pacote usado gera revisão');
    const r3 = await regras(revisao);
    assert.deepEqual(r3.filter((r) => r.dia === 6).map(({ estado, inicio, fim, ativo }) => ({ estado, inicio, fim, ativo })),
      envelhecidas.map(({ estado, inicio, fim, ativo }) => ({ estado, inicio, fim, ativo })), 'R3: sábado copiado e mantido');
    assert.ok(r3.filter((r) => r.dia === 7).every((r) => !r.ativo), 'R3: domingo (criado hoje) desativado na revisão');
    assert.deepEqual(await regras(original), r2, 'R3: o pacote anterior não muda');
    resultados.push('R3 pacote usado, remove domingo: revisão nova, sábado mantido (início -10), domingo desativado, anterior intacto');
    console.log('E2E_REVIGENCIA_R3_OK');
    await contexto.close();

    fs.writeFileSync(path.join(relatorios, 'resultados.txt'), `${resultados.join('\n')}\n`);
    console.log(`E2E_PACOTES_REVIGENCIA_OK (${resultados.length} roteiros)`);
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
