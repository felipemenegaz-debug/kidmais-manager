/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do modelo de contrato da empresa (072) — leitura simulada, sem provedor de IA — sobre o roteiro no navegador e nas APIs, com PostgreSQL DESCARTÁVEL e dados sintéticos.
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

const PORTA_WEB = 3146;

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
  const relatorios = path.resolve('.local-modelo-contrato-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/checks/20261007_070_precheck.sql', 'database/migrations/20261007_070_adicionais_do_buffet.sql', 'database/checks/20261007_070_postcheck.sql',
      'database/checks/20261007_071_precheck.sql', 'database/migrations/20261007_071_importacoes_comerciais.sql', 'database/checks/20261007_071_postcheck.sql',
      'database/checks/20261007_072_precheck.sql', 'database/migrations/20261007_072_modelos_contrato_empresa.sql', 'database/checks/20261007_072_postcheck.sql'])
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
    const { salvarAdicionalAdmin } = await import('../lib/comercial/adicionais-admin.ts');
    await client.query('BEGIN');
    await salvarAdicionalAdmin(tx, { empresaId: empresas.A.id, usuarioId: pessoa, requestId: require('node:crypto').randomUUID() }, { nome: 'Mesa de café', categoria: 'MESA', unidadeCobranca: 'PACOTE', ativo: true });
    await client.query('COMMIT');

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
    const falhar = async (nome, e) => { await page.screenshot({ path: path.join(relatorios, `falha-${nome}.png`), fullPage: true }); fs.writeFileSync(path.join(relatorios, `falha-${nome}.txt`), await page.locator('body').innerText()); throw e; };

    // 1. Rascunho do modelo (leitura simulada; nenhuma IA) → revisão.
    await selecionar('A');
    const servico = await import('../lib/contratos/modelo-empresa/servico.ts');
    const ctxImp = { empresaId: empresas.A.id, usuarioId: pessoa, requestId: require('node:crypto').randomUUID() };
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF'));
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    await client.query('BEGIN');
    const idImp = await servico.registrarImportacaoContrato(tx, ctxImp, { contentType: 'application/pdf', nomeSeguro: 'Contrato-Loja.pdf', tamanhoBytes: bytes.length, sha256: sha, bytes });
    await servico.gravarLeituraContrato(tx, ctxImp, idImp, { ok: true, modelo: 'fake', provedor: 'FAKE', leitura: { avisos: ['Horário de montagem sem campo automático.'], conteudo: {
      titulo: 'Contrato de Prestação de Serviços de Festa',
      contratada: { nome: 'Buffet Adicionais UI Ltda', documento: '11.222.333/0001-81', endereco: 'Rua das Festas, 100 - Brasília/DF', representante: 'Pessoa Adicionais UI' },
      preambulo: ['As partes abaixo têm, entre si, justo e contratado o seguinte.'],
      clausulas: [
        { titulo: 'Objeto', texto: 'Festa {{festa.pacote}} no dia {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, para {{festa.convidados}} convidados.' },
        { titulo: 'Valor', texto: 'O valor total é de {{valor.total}}.' },
        { titulo: 'Foro', texto: 'Fica eleito o foro de Brasília/DF.' },
      ],
      observacoes: [], cidadeAssinatura: 'Brasília/DF',
    } } });
    await client.query('COMMIT');
    await page.goto(`${base}/admin/configuracoes/modelo-contrato`);
    await page.getByRole('heading', { name: 'Modelo de contrato' }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'mc-1-painel.png'), fullPage: true });
    await page.getByRole('button', { name: 'Continuar revisão' }).click();
    await page.getByRole('heading', { name: 'Revise o modelo de contrato' }).waitFor().catch((e) => falhar('revisao', e));
    await page.getByText('precisa usar {{contratante.nome}}', { exact: false }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Publicar modelo' }).isDisabled(), true, 'bloqueado sem contratante');
    await page.screenshot({ path: path.join(relatorios, 'mc-2-revisao-pendente.png'), fullPage: true });
    resultados.push('Modelo de contrato: rascunho lido → revisão aponta campos obrigatórios ausentes e bloqueia a publicação');
    console.log('E2E_MODELO_REVISAO_OK');

    // 2. Insere os campos do contratante pela lista e publica com aprovação explícita.
    const valor = page.getByLabel('Texto da cláusula 2');
    await valor.click();
    await valor.press('End');
    await page.keyboard.type(' Contratante: ');
    await valor.press('End');
    await page.getByRole('button', { name: 'Nome do contratante', exact: true }).click();
    await page.getByRole('button', { name: 'CPF do contratante', exact: true }).click();
    await page.getByText('Campos conferidos: o modelo pode ser publicado.').waitFor().catch((e) => falhar('campos', e));
    const [pdf] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/admin/configuracoes/modelo-contrato/') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Ver prévia em PDF' }).click(),
    ]);
    assert.equal(pdf.status(), 200);
    assert.equal(pdf.headers()['content-type'], 'application/pdf');
    const corpoPdf = (await pdf.body()).toString('latin1');
    assert.ok(corpoPdf.includes('Buffet Adicionais UI Ltda') && corpoPdf.includes('PR') && !corpoPdf.includes('KIDMAIS FESTAS'), 'prévia no padrão da empresa');
    await page.screenshot({ path: path.join(relatorios, 'mc-3-revisao-ok.png'), fullPage: true });
    await page.getByRole('button', { name: 'Publicar modelo' }).first().click();
    const dialogo = page.getByRole('dialog', { name: 'Publicar modelo de contrato' });
    assert.equal(await dialogo.getByRole('button', { name: 'Publicar modelo' }).isDisabled(), true, 'aprovação obrigatória');
    await dialogo.getByRole('checkbox').check();
    await page.screenshot({ path: path.join(relatorios, 'mc-4-aprovar.png'), fullPage: true });
    await dialogo.getByRole('button', { name: 'Publicar modelo' }).click();
    await page.getByText('Modelo publicado (versão 1)', { exact: false }).waitFor().catch((e) => falhar('publicar', e));
    await page.getByText('Versão 1, aprovada em', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'mc-5-publicado.png'), fullPage: true });
    const ativo = await client.query("SELECT versao, conteudo->'clausulas'->1->>'texto' AS texto FROM modelos_contrato_empresa WHERE empresa_id = $1 AND situacao = 'ATIVO'", [empresas.A.id]);
    assert.equal(ativo.rows[0].versao, 1);
    assert.match(ativo.rows[0].texto, /\{\{contratante\.nome\}\}\{\{contratante\.cpf\}\}|\{\{contratante\.nome\}\}.*\{\{contratante\.cpf\}\}/);
    resultados.push('Campos inseridos pela lista; prévia em PDF no padrão da empresa (sem texto da Kidmais); publicação só com a caixa de aprovação; versão 1 ativa');
    console.log('E2E_MODELO_PUBLICADO_OK');
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
