/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do CPF do contratante (091) e da campanha Fundador em duas fases (090), com PostgreSQL DESCARTÁVEL (modelo
 * 089 + 090 + 091 aplicadas aqui), e-mail em ARQUIVO local e checkout INTERCEPTADO (sem provedor). Sem .env, banco real
 * ou serviço Render. Campanha SINTÉTICA (horário exato, janela começando no passado): nenhuma data real foi decidida.
 * Execute com os três KIDMAIS_* do descartável, Playwright e Chrome.
 *
 *   1. Site: barra, cartão e FAQ com o prazo vindo do banco ("até DD/MM/AAAA, 23h59/HHhMM (horário de Brasília)"), sem teto
 *      na janela; frase do teste cita CPF só com a chave ligada.
 *   2. Cadastro PF: "Quem contrata" → CPF + nome civil + nome do buffet; CPF com DV errado recusado pelo servidor com
 *      mensagem acessível; depois cria a empresa (CPF no teste, TITULAR_PF, sem sócios).
 *   3. Assinatura: prazo da janela na tela; checkout interceptado recebe o valor Fundador; nada muda no banco.
 *   4. Mesmo CPF por outra pessoa: mensagem neutra, pedido de acesso registrado.
 *   5. Celular (375 px): planos e formulário PF sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3157;
/** CPF sintético com DV oficial. */
function cpf(n) {
  const b = String(100000000 + n).slice(-9);
  const dv = (s, p) => { let t = 0; for (let i = 0; i < s.length; i++) t += Number(s[i]) * (p - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(b, 10); return b + d1 + dv(b + d1, 11);
}
const mascara = (c) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;

async function principal() {
  const base = `http://localhost:${PORTA_WEB}`;
  for (const nome of ['.env', '.env.local', '.env.development', '.env.development.local']) if (fs.existsSync(nome)) throw Error('E2E_RECUSA_ARQUIVO_ENV');
  await new Promise((resolve, reject) => {
    const prova = require('node:net').createServer();
    prova.once('error', () => reject(Error('E2E_PORTA_WEB_OCUPADA')));
    prova.listen(PORTA_WEB, '127.0.0.1', () => prova.close(resolve));
  });
  const playwright = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = fs.mkdtempSync(path.resolve('.local-cpf-fundador-ui-'));
  const caixa = path.join(relatorios, 'emails');
  fs.mkdirSync(caixa, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  const ultimoEmail = async (para) => {
    for (let n = 0; n < 60; n++) {
      const msgs = fs.readdirSync(caixa).sort().map((f) => JSON.parse(fs.readFileSync(path.join(caixa, f), 'utf8'))).filter((m) => m.para === para);
      if (msgs.length) return msgs.at(-1);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error(`E2E_SEM_EMAIL ${para}`);
  };
  try {
    await receita.construirModelo(admin, porta, '089');
    await receita.restaurar(admin, receita.TRABALHO[0], '089');
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    for (const f of ['database/migrations/20261022_090_campanha_fundador.sql', 'database/checks/20261022_090_postcheck.sql',
      'database/migrations/20261022_091_documento_fiscal_contratante.sql', 'database/checks/20261022_091_postcheck.sql'])
      await client.query(fs.readFileSync(f, 'utf8'));
    const autor = (await client.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ('campanha-ui@exemplo.test', 'Autorização sintética', $1, 'ADMINISTRATIVO', true) RETURNING id",
      [`scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    await client.query("INSERT INTO assinatura_campanhas (codigo, versao_regra) VALUES ('fundador-ui', 'fundador-sintetica-ui')");
    await client.query(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'HORARIO_EXATO', elegibilidade = 'OFERTA_PERSISTIDA', validade_oferta = '7 days',
      inicio = clock_timestamp() - interval '2 days', autorizacao = 'Teste sintético de interface sem autorização real', ativada_por = $1 WHERE codigo = 'fundador-ui'`, [autor]);
    const prazo = (await client.query(`SELECT to_char((janela_fim - interval '1 minute') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS dia,
      to_char((janela_fim - interval '1 minute') AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI') AS hora FROM assinatura_campanhas WHERE codigo = 'fundador-ui'`)).rows[0];
    const sistema = {};
    for (const [k, v] of Object.entries(process.env)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'].includes(k.toUpperCase())) sistema[k] = v;
    const env = { ...sistema, NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.resolve('scripts/navegador-local-fontes-mock.cjs'), SITE_URL: base,
      CONSULTA_CEP_EXTERNA: 'desligada', DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: caixa, CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada',
      ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_fixture_sem_valor', ASAAS_WEBHOOK_TOKEN: 'fixture-sintetica-sem-valor-32-caracteres',
      ASSINATURA_CPF_ATIVO: 'true', ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: 'true' };
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 160; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/cadastro`).then(r => r.ok).catch(() => false)) break;
      if (n === 159) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const novoContexto = async (largura = 1440, altura = 1000) => { const c = await browser.newContext({ viewport: { width: largura, height: altura } }); c.setDefaultTimeout(90000); await c.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort()); return c; };
    const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const senha = `sintetica-${randomBytes(8).toString('hex')}`;
    async function contaConfirmada(page, nome, email) {
      await page.goto(`${base}/cadastro`);
      await page.getByLabel('Seu nome').fill(nome);
      await page.getByLabel('E-mail').fill(email);
      await page.getByLabel('Crie uma senha').fill(senha);
      await page.getByLabel('Confirme a senha').fill(senha);
      await page.getByRole('checkbox').nth(0).check();
      await page.getByRole('checkbox').nth(1).check();
      await page.getByRole('button', { name: 'Continuar', exact: true }).click();
      await page.getByText('Se for possível criar a conta com este e-mail', { exact: false }).waitFor();
      const link = (await ultimoEmail(email)).texto.match(/https?:\/\/\S+#t=[A-Za-z0-9_-]{43}/)[0];
      await page.goto(link);
      await page.waitForURL(`${base}/cadastro/empresa`);
    }
    async function preencherPf(page, documento, buffet) {
      await page.getByRole('radio', { name: 'Pessoa física (CPF), em nome próprio' }).check();
      await page.getByLabel('CPF', { exact: true }).fill(documento);
      await page.getByLabel('Nome civil completo').fill('Joana Sintética Pereira');
      await page.getByLabel('Nome do buffet (como aparece para seus clientes)').fill(buffet);
      assert.equal(await page.getByText('Sua relação com a empresa').count(), 0, 'PF não pede qualificação nem sócios');
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Cadastrar empresa e começar o teste', exact: true }).click();
    }

    // 1. Site.
    const ctx1 = await novoContexto();
    const page = await ctx1.newPage();
    await page.goto(`${base}/planos`);
    await page.getByRole('heading', { name: 'Essencial', exact: true }).waitFor();
    const site = await page.locator('main').innerText();
    const barra = await page.locator('body').innerText();
    const esperado = `até ${prazo.dia}, ${prazo.hora} (horário de Brasília)`;
    assert.ok(site.includes(`Plano Fundador para quem assinar ${esperado}.`), 'cartão com o prazo do banco');
    assert.ok(barra.includes(`para quem assinar ${esperado}`), 'barra com o prazo do banco');
    assert.match(site, /sem limite de vagas até o prazo/); assert.doesNotMatch(site, /20 vagas para os primeiros/);
    assert.match(site, /CNPJ ou pelo CPF de quem contrata/);
    await page.screenshot({ path: path.join(relatorios, 'planos-janela.png'), fullPage: true });
    resultados.push(`Site: prazo da janela lido do banco (${esperado}), sem teto na janela; frase do teste cita CPF com a chave ligada`);
    console.log('E2E_SITE_JANELA_OK');

    // 2. Cadastro PF.
    const emailJo = 'joana-cpf-ui@exemplo.test';
    await contaConfirmada(page, 'Joana CPF UI', emailJo);
    await page.getByRole('group', { name: 'Quem contrata' }).waitFor();
    const doc = cpf(77);
    const ruim = doc.slice(0, 10) + ((Number(doc[10]) + 1) % 10);
    await preencherPf(page, mascara(ruim), 'Buffet da Joana UI');
    await page.getByRole('alert').getByText('CPF inválido. Confira os números.').waitFor();
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM empresas WHERE nome = 'Buffet da Joana UI'")).rows[0].n), 0);
    await page.getByLabel('CPF', { exact: true }).fill(mascara(doc));
    await page.getByRole('button', { name: 'Cadastrar empresa e começar o teste', exact: true }).click();
    await page.waitForURL(`${base}/admin/inicio`);
    const e = (await client.query(`SELECT e.id, a.documento_teste, c.nome_empresarial, r.qualificacao FROM empresas e JOIN empresa_assinaturas a ON a.empresa_id = e.id
      JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id JOIN empresa_representacoes r ON r.empresa_id = e.id WHERE e.nome = 'Buffet da Joana UI'`)).rows;
    assert.deepEqual(e.map(x => [x.documento_teste, x.nome_empresarial, x.qualificacao]), [[doc, 'Joana Sintética Pereira', 'TITULAR_PF']]);
    await page.screenshot({ path: path.join(relatorios, 'pf-inicio.png'), fullPage: true });
    resultados.push('Cadastro PF: CPF com DV errado recusado pelo servidor (alerta acessível, nada gravado); CPF válido cria empresa em teste com CPF, nome civil e TITULAR_PF, sem sócios');
    console.log('E2E_CADASTRO_PF_OK');

    // 3. Assinatura.
    const antes = JSON.stringify((await client.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows);
    await page.goto(`${base}/admin/assinatura`);
    await page.getByText(`Condição válida para quem assinar ${esperado}.`, { exact: false }).waitFor();
    let checkouts = 0;
    await page.route('**/api/admin/assinatura/checkout', async route => {
      const body = route.request().postDataJSON();
      assert.equal(body.plano, 'essencial'); assert.equal(body.ciclo, 'MENSAL'); assert.equal(body.valorEsperadoCentavos, 11820);
      checkouts++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { urlPagamento: 'https://pagamento.example.invalid/fixture', vencimento: null, ciclo: 'MENSAL', reaproveitada: false } }) });
    });
    await page.getByRole('button', { name: /Assinar Essencial/ }).click();
    await page.getByText('Processando: o acesso é liberado quando o pagamento for confirmado.', { exact: true }).waitFor();
    assert.equal(checkouts, 1);
    assert.equal(JSON.stringify((await client.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows), antes);
    await page.screenshot({ path: path.join(relatorios, 'pf-assinatura.png'), fullPage: true });
    resultados.push('Assinatura PF: prazo da janela na tela; checkout interceptado com Essencial mensal Fundador R$ 118,20; nenhuma assinatura alterada');
    console.log('E2E_ASSINATURA_PF_OK');
    await ctx1.close();

    // 4. Mesmo CPF por outra pessoa.
    const ctx2 = await novoContexto();
    const p2 = await ctx2.newPage();
    const emailLu = 'lu-cpf-ui@exemplo.test';
    await contaConfirmada(p2, 'Lu CPF UI', emailLu);
    await preencherPf(p2, doc, 'Outro Buffet');
    await p2.locator('[data-cnpj-existente]').waitFor();
    assert.doesNotMatch(await p2.locator('main').innerText(), /Joana|Buffet da Joana/);
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa s JOIN usuarios_administrativos u ON u.id = s.usuario_id WHERE u.email = $1 AND s.documento = $2", [emailLu, doc])).rows[0].n), 1);
    resultados.push('CPF já cadastrado: mensagem neutra, nada da empresa existente, pedido de acesso registrado');
    console.log('E2E_CPF_EXISTENTE_OK');

    // 5. Celular.
    await p2.setViewportSize({ width: 375, height: 812 });
    await p2.goto(`${base}/planos`);
    await p2.getByRole('heading', { name: 'Essencial', exact: true }).waitFor();
    assert.ok(await semRolagem(p2), '/planos sem rolagem horizontal');
    const emailMi = 'mi-cpf-ui@exemplo.test';
    await contaConfirmada(p2, 'Mi CPF UI', emailMi);
    await p2.getByRole('radio', { name: 'Pessoa física (CPF), em nome próprio' }).check();
    assert.ok(await semRolagem(p2), 'formulário PF sem rolagem horizontal');
    await p2.screenshot({ path: path.join(relatorios, 'celular-pf.png'), fullPage: true });
    await ctx2.close();
    resultados.push('Celular (375 px): planos e formulário PF sem rolagem horizontal');
    console.log('E2E_CELULAR_OK');

    fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, emailReal: 'arquivo local', checkout: 'interceptado', resultados }, null, 2));
    console.log(JSON.stringify({ ok: true, relatorios: path.basename(relatorios), resultados }));
  } finally {
    await browser?.close();
    if (servidor && servidor.exitCode === null) {
      if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/PID', String(servidor.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else servidor.kill();
    }
    fs.closeSync(logfile);
    await client?.end(); await admin.end();
  }
}
principal().catch(e => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n').slice(0, 6).join(' | ').replace(/#t=[A-Za-z0-9_-]+/g, '#t=[REMOVIDO]')); process.exitCode = 1; });
