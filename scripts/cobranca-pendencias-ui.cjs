/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in das pendências de cobrança no painel do desenvolvedor (E8), com PostgreSQL DESCARTÁVEL e dados sintéticos.
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 063 e aplica 067 + 068 nele (a receita prova
 * cluster/porta/usuário antes de escrever). Nenhum .env, banco real, e-mail (EMAIL_PROVIDER=desativado), provedor de
 * cobrança (ASAAS_* removidos: nenhuma chamada ao Asaas) ou serviço Render.
 *
 * Uma empresa com duas pendências abertas: uma intenção de criação sem id (liberável) e um id confirmado aguardando
 * vínculo (não liberável). Na ficha:
 *   - a lista mostra as duas; só a intenção sem id oferece "Liberar (não foi criada)";
 *   - o formulário só habilita com motivo (≥ 10) e a declaração de conferência marcada;
 *   - sem provedor configurado neste ambiente a liberação é recusada com a mensagem do servidor: nada muda no banco e
 *     nada é auditado (a liberação completa, com o provedor consultado, é coberta em contratacao-e8.postgres.test.ts);
 *   - celular (390 px) sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3147;
const TIPO = 'KIDMAIS_RECONCILIAR_CONTRATACAO';

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
  const relatorios = path.resolve('.local-cobranca-pendencias-ui');
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
    const { alterarDesenvolvedor } = require('./admin-provision.cjs');
    const emailDev = 'dev-pendencias-ui@exemplo.test';
    const dev = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Dev Pendências UI',$2,'ADMINISTRATIVO') RETURNING id`,
      [emailDev, await senhaMod.criarHashSenha(password)])).rows[0].id;
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [dev]);
    await alterarDesenvolvedor(client, { operacao: 'conceder', email: emailDev, operador: 'E2E sintético', motivo: 'Teste das pendências de cobrança' });
    const empresa = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,'Buffet Pendências UI','PROVISIONAMENTO') RETURNING id`, [`pd-${randomBytes(3).toString('hex')}`])).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresa]);
    await client.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
      SELECT $1,'TESTE',agora.t - interval '2 days',agora.t + interval '13 days','11222333000181' FROM (SELECT clock_timestamp() AS t) agora`, [empresa]);
    const intencao = (await client.query(`INSERT INTO cobranca_eventos(provedor,evento_id,tipo,assinatura_provedor_id,referencia_externa,empresa_id,situacao,ultimo_erro)
      VALUES('ASAAS',$1,$2,NULL,$3,$4::uuid,'PENDENTE','CRIACAO_SEM_RESPOSTA') RETURNING id`, [`kidmais:criacao:${empresa}:${randomUUID()}`, TIPO, empresa, empresa])).rows[0].id;
    await client.query(`INSERT INTO cobranca_eventos(provedor,evento_id,tipo,assinatura_provedor_id,referencia_externa,empresa_id,situacao,ultimo_erro)
      VALUES('ASAAS',$1,$2,'sub_sintetica_ui',$3,$4::uuid,'PENDENTE','CRIACAO_CONFIRMADA_SEM_VINCULO')`, [`kidmais:vinculo:${empresa}:${randomUUID()}`, TIPO, empresa, empresa]);

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_AMBIENTE', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'ASSINATURA_PRECO_MENSAL_CENTAVOS', 'ASSINATURA_PRECO_ANUAL_CENTAVOS']) delete env[k];
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
    const p = await contexto.newPage();
    await p.goto(`${base}/admin/login`);
    await p.getByLabel('Email', { exact: true }).fill(emailDev);
    await p.getByLabel('Senha', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Entrar', exact: true }).click();
    await p.waitForURL(url => !url.pathname.includes('/login'));
    const abertas = async () => (await client.query("SELECT id FROM cobranca_eventos WHERE empresa_id=$1 AND tipo=$2 AND situacao IN ('PENDENTE','FALHOU') ORDER BY recebido_em", [empresa, TIPO])).rows.map(r => r.id);

    // Lista: duas pendências; só a intenção sem id é liberável; nenhum id do provedor aparece na tela.
    await p.goto(`${base}/desenvolvedor/empresas/${empresa}`);
    const secao = p.locator('section', { has: p.getByRole('heading', { name: 'Pendências de cobrança', exact: true }) });
    await secao.getByText('Criação de assinatura não confirmada', { exact: false }).waitFor();
    await secao.getByText('Reconciliação da contratação', { exact: false }).waitFor();
    assert.equal(await secao.getByRole('button', { name: 'Liberar (não foi criada)', exact: true }).count(), 1, 'só a intenção sem id é liberável');
    assert.ok(!(await secao.innerText()).includes('sub_sintetica_ui'), 'id do provedor não aparece');
    await p.screenshot({ path: path.join(relatorios, 'pendencias.png'), fullPage: true });
    resultados.push('Ficha: duas pendências abertas listadas; só a intenção sem id oferece "Liberar"; nenhum id do provedor na tela');
    console.log('E2E_PENDENCIAS_LISTA_OK');

    // Formulário: só habilita com motivo e declaração; sem provedor configurado, a liberação é recusada e nada muda.
    await secao.getByRole('button', { name: 'Liberar (não foi criada)', exact: true }).click();
    const confirmar = secao.getByRole('button', { name: 'Confirmar liberação', exact: true });
    assert.equal(await confirmar.isDisabled(), true, 'sem motivo e sem declaração');
    await secao.getByLabel('Motivo (10 a 500 caracteres)').fill('Conferido no painel do provedor (E2E)');
    assert.equal(await confirmar.isDisabled(), true, 'sem a declaração de conferência');
    await secao.getByLabel('Conferi no provedor que a assinatura não foi criada').check();
    assert.equal(await confirmar.isDisabled(), false);
    await confirmar.click();
    const dialogo = p.getByRole('dialog', { name: 'Confirme sua senha' });
    if (await dialogo.isVisible().catch(() => false)) {
      await dialogo.getByLabel('Senha').fill(password);
      await dialogo.getByRole('button', { name: 'Confirmar e continuar' }).click();
    }
    await secao.getByText('A cobrança não está configurada neste ambiente.', { exact: false }).waitFor();
    assert.deepEqual((await abertas()).length, 2, 'nada liberado');
    assert.ok((await abertas()).includes(intencao));
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM auditoria WHERE acao='COBRANCA_INTENCAO_LIBERADA'")).rows[0].n), 0, 'nada auditado como liberado');
    await p.screenshot({ path: path.join(relatorios, 'liberacao-sem-provedor.png'), fullPage: true });
    resultados.push('Formulário: "Confirmar liberação" só habilita com motivo e declaração; sem provedor configurado o servidor recusa (503), as pendências continuam abertas e nada é auditado como liberado');
    console.log('E2E_PENDENCIAS_FORMULARIO_OK');

    // Celular: sem rolagem horizontal.
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(`${base}/desenvolvedor/empresas/${empresa}`);
    await secao.getByText('Criação de assinatura não confirmada', { exact: false }).waitFor();
    await secao.getByRole('button', { name: 'Liberar (não foi criada)', exact: true }).click();
    await secao.getByLabel('Motivo (10 a 500 caracteres)').waitFor();
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem horizontal no celular');
    await secao.screenshot({ path: path.join(relatorios, 'celular-pendencias.png') });
    resultados.push('Celular (390 px): lista e formulário de liberação sem rolagem horizontal');
    console.log('E2E_PENDENCIAS_CELULAR_OK');

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
