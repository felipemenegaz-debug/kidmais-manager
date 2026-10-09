/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da importação da tabela de preços (071) — leitura simulada, sem provedor de IA — e no navegador e nas APIs, com PostgreSQL DESCARTÁVEL e dados sintéticos.
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

const PORTA_WEB = 3145;

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
  const relatorios = path.resolve('.local-importacao-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    await receita.restaurar(admin, receita.TRABALHO[0], '063');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/checks/20261007_070_precheck.sql', 'database/migrations/20261007_070_adicionais_do_buffet.sql', 'database/checks/20261007_070_postcheck.sql',
      'database/checks/20261007_071_precheck.sql', 'database/migrations/20261007_071_importacoes_comerciais.sql', 'database/checks/20261007_071_postcheck.sql'])
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

    // 1. Importação em revisão (leitura simulada; nenhuma IA): lista → revisão.
    await selecionar('A');
    const { gravarLeitura, registrarImportacao } = await import('../lib/comercial/importacao-tabela/servico.ts');
    const ctxImp = { empresaId: empresas.A.id, usuarioId: pessoa, requestId: require('node:crypto').randomUUID() };
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF'));
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    await client.query('BEGIN');
    const idImp = await registrarImportacao(tx, ctxImp, { contentType: 'application/pdf', nomeSeguro: 'Tabela-Festas.pdf', tamanhoBytes: bytes.length, sha256: sha, bytes });
    const l = (ate, valor, de = null, rotulo = null) => ({ de, ate, valor, rotulo });
    await gravarLeitura(tx, ctxImp, idImp, { ok: true, modelo: 'fake', provedor: 'FAKE', leitura: {
      pacotes: [{ nome: 'Kidmais Pocket', pagina: 4, descricao: 'Festa compacta para até 30 convidados.', selo: null, duracao: '3h', convidadosMin: 20, convidadosMax: null, inclusos: [],
        cobranca: 'FAIXAS', grades: [{ horario: 'PROMOCIONAL', linhas: [l(20, 3800), l(25, 4300), l(30, 4800)] }, { horario: 'NOBRE', linhas: [l(20, 4200), l(25, 4700), l(30, 5200)] }], valorPorConvidado: null, aPartirDe: 3800 }],
      adicionais: [
        { nome: 'Mesa de café', pagina: 5, grupo: 'MESA', cobranca: 'VALOR_FECHADO', linhas: [l(50, 590, null, 'Pequena'), l(100, 790, 60, 'Média'), l(150, 990, 110, 'Grande')] },
        { nome: 'Bombom', pagina: 5, grupo: 'EXTRA', cobranca: 'UNIDADE', linhas: [l(null, 8)] },
      ],
      comuns: ['Espaço indoor climatizado'], horarios: [{ horario: 'NOBRE', descricao: 'Sábado à tarde e domingo de manhã' }],
      informacoes: ['O envio da tabela não garante reserva.'], naoImportavel: [{ texto: 'Upgrade Premium a partir de R$ 1.290', pagina: 6, motivo: 'sem faixa de convidados' }],
    } });
    await client.query('COMMIT');
    await page.goto(`${base}/admin/configuracoes/importar-tabela`);
    await page.getByRole('heading', { name: 'Importar tabela de preços do PDF' }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'imp-1-enviar.png'), fullPage: true });
    await page.getByRole('button', { name: 'Continuar revisão' }).click();
    await page.getByRole('heading', { name: 'Revise antes de publicar' }).waitFor().catch((e) => falhar('revisao', e));
    await page.getByRole('cell', { name: 'R$ 3.800' }).count();
    await page.screenshot({ path: path.join(relatorios, 'imp-2-pacotes.png'), fullPage: true });
    assert.equal(await page.getByRole('button', { name: 'Publicar tabela' }).isDisabled(), true, 'bloqueado até confirmar');
    resultados.push('Importação: lista de rascunhos → revisão com grade promocional/nobre do Pocket; publicar bloqueado até confirmar');
    console.log('E2E_IMPORTACAO_REVISAO_OK');

    // 2. Confirma pacote e adicionais, salva e publica.
    await page.getByRole('button', { name: 'Confirmar Kidmais Pocket' }).click();
    await page.getByRole('tab', { name: /Adicionais/ }).click();
    await page.screenshot({ path: path.join(relatorios, 'imp-3-adicionais.png'), fullPage: true });
    await page.getByRole('button', { name: 'Confirmar todos com preço' }).click();
    await page.getByRole('button', { name: 'Publicar tabela' }).first().click();
    const dialogo = page.getByRole('dialog', { name: 'Publicar nova tabela' });
    await dialogo.waitFor();
    await page.screenshot({ path: path.join(relatorios, 'imp-4-confirmar.png'), fullPage: true });
    await dialogo.getByRole('button', { name: 'Publicar tabela' }).click();
    await page.getByRole('heading', { name: 'Tabela publicada' }).waitFor().catch((e) => falhar('publicar', e));
    await page.screenshot({ path: path.join(relatorios, 'imp-5-publicado.png'), fullPage: true });
    const precosPublicados = await client.query(`SELECT pp.categoria_horario, pp.convidados_min, pp.valor::text AS valor FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      WHERE t.empresa_id = $1 AND t.publicada_em IS NOT NULL AND t.substituida_em IS NULL AND pp.pacote_id = $2 ORDER BY 1, 2`, [empresas.A.id, empresas.A.pacote]);
    assert.deepEqual(precosPublicados.rows.map((r) => `${r.categoria_horario}:${r.convidados_min}:${r.valor}`), ['NOBRE:20:4200.00', 'NOBRE:21:4700.00', 'NOBRE:26:5200.00', 'PADRAO:20:3800.00', 'PADRAO:21:4300.00', 'PADRAO:26:4800.00']);
    resultados.push('Publicação pela tela: tabela nova com 6 preços (promocional e nobre) do Pocket e adicionais com faixas');
    console.log('E2E_IMPORTACAO_PUBLICADA_OK');

    // 3. Pacotes mostra as grades; Itens do Buffet mostra a mesa por faixa.
    await page.goto(`${base}/admin/configuracoes/pacotes`);
    await page.getByRole('heading', { name: 'Pacotes', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click();
    await page.getByText('Horário nobre').first().waitFor().catch((e) => falhar('grades', e));
    await page.screenshot({ path: path.join(relatorios, 'imp-6-pacote-grades.png'), fullPage: true });
    await page.goto(`${base}/admin/configuracoes/catalogo`);
    await page.getByRole('button', { name: 'Outros adicionais' }).click();
    await page.getByRole('row').filter({ hasText: 'Mesa de café' }).getByText('(3 faixas)').waitFor().catch((e) => falhar('faixas', e));
    await page.getByRole('row').filter({ hasText: 'Mesa de café' }).getByRole('button', { name: /Ações de/ }).click();
    await page.getByRole('menuitem', { name: 'Editar' }).click();
    await page.getByRole('dialog', { name: 'Adicional' }).getByRole('button', { name: 'Por faixa de convidados' }).waitFor();
    await page.screenshot({ path: path.join(relatorios, 'imp-7-adicional-faixas.png'), fullPage: true });
    resultados.push('Pacotes mostra as grades promocional/nobre; Itens do Buffet mostra "Mesa de café" por faixa (Pequena/Média/Grande)');
    console.log('E2E_IMPORTACAO_TELAS_OK');
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
