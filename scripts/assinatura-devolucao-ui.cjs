/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do cancelamento e devolução (089, L1 de 21/10/2026) no navegador, com PostgreSQL DESCARTÁVEL (modelo 086
 * + 089 aplicada aqui) e dados sintéticos. O Asaas é um DUBLÊ dentro do `next dev` (scripts/teste-asaas-duble.cjs: o
 * fetch para o sandbox é atendido em memória; qualquer outro endereço do Asaas é recusado). E-mail em ARQUIVO local.
 * Nenhum .env, banco real, provedor real ou serviço Render. Execute com os três KIDMAIS_* de autorização do descartável,
 * KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 * Uma Gestão com três empresas:
 *   A anual paga hoje (Pix)        → "Ver opções" mostra o arrependimento integral; confirmar com senha dá protocolo na
 *                                     hora, encerra o período (somente leitura), remove a renovação no dublê, NÃO chama
 *                                     estorno (flag desligada) e grava o e-mail; o histórico lista o protocolo;
 *   B anual paga há 100 dias       → garantia encerrada; proporcional com o cálculo (dias e valor) na tela;
 *   C mensal paga há 10 dias       → sem devolução; "Cancelar ao fim do período" devolve o protocolo na tela.
 *   Arrependimento pela ferramenta (097, grupo C de 23/10/2026): sem a 097 a seção indica o canal oficial; com a 097
 *   aplicada aqui, a empresa C (mensal, fora da garantia de 7 dias) registra o arrependimento com senha e recebe o
 *   protocolo KA-… na hora, sem nenhuma chamada ao dublê, com e-mail à Gestão e aviso interno.
 *   Celular (390 px): sem rolagem horizontal.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3147;
const UP = 'database/migrations/20261021_089_assinatura_encerramentos.sql';
const UP_097 = 'database/migrations/20261023_097_assinatura_arrependimentos.sql';

const dataBr = (deslocamentoDias) => new Date(Date.now() - 3 * 3600_000 + deslocamentoDias * 86400_000).toISOString().slice(0, 10);
function somarCiclo(data, ciclo) {
    const [a, m, d] = data.split('-').map(Number);
    const ano = ciclo === 'ANUAL' ? a + 1 : a + Math.floor(m / 12), mes = ciclo === 'ANUAL' ? m - 1 : m % 12;
    const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ano, mes, Math.min(d, ultimo), 3)).toISOString();
}

async function principal() {
    const base = `http://localhost:${PORTA_WEB}`;
    for (const nome of ['.env', '.env.local', '.env.development', '.env.development.local'])
        if (fs.existsSync(nome)) throw Error('E2E_RECUSA_ARQUIVO_ENV');
    await new Promise((resolve, reject) => {
        const prova = require('node:net').createServer();
        prova.once('error', () => reject(Error('E2E_PORTA_WEB_OCUPADA')));
        prova.listen(PORTA_WEB, '127.0.0.1', () => prova.close(resolve));
    });
    const playwright = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
    const { carregarModulo } = await import('../lib/acessos/teste-carregador.ts');
    const { porta, admin } = await receita.conectarAdmin(process.env);
    let client, servidor, browser;
    const relatorios = path.resolve('.local-assinatura-devolucao-ui');
    fs.rmSync(relatorios, { recursive: true, force: true });
    fs.mkdirSync(path.join(relatorios, 'emails'), { recursive: true });
    const duble = path.join(relatorios, 'asaas-duble.json');
    const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
    const resultados = [];
    try {
        await receita.restaurar(admin, receita.TRABALHO[0], '086');
        client = await receita.conectar(porta, receita.TRABALHO[0]);
        await client.query(fs.readFileSync(UP, 'utf8'));
        const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
        const senhaMod = carregar('lib/autenticacao/senha.ts');
        const password = `sintetica-${randomBytes(12).toString('hex')}`;
        const email = 'gestao-devolucao-ui@exemplo.test';
        const pessoa = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Gestão Devolução UI',$2,'ADMINISTRATIVO') RETURNING id`,
            [email, await senhaMod.criarHashSenha(password)])).rows[0].id;
        await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [pessoa]);

        const estado = { assinaturas: {}, cobrancas: {}, chamadas: [], estornos: [] };
        const empresas = {};
        for (const [chave, nome, cnpj, ciclo, valor, pagoHaDias] of [['A', 'Buffet Arrependimento UI', '11222333000181', 'ANUAL', 397000, 0],
            ['B', 'Buffet Anual UI', '45723174000110', 'ANUAL', 238200, 100], ['C', 'Buffet Mensal UI', '04252011000110', 'MENSAL', 39700, 10]]) {
            const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`dv-${chave.toLowerCase()}-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
            await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
            const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [id, pessoa])).rows[0].id;
            await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
            await client.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
                VALUES($1,'TESTE',clock_timestamp() - interval '120 days',clock_timestamp() - interval '105 days',$2)`, [id, cnpj]);
            const sub = `sub_ui_${chave}`, pago = dataBr(-pagoHaDias);
            estado.assinaturas[sub] = { id: sub, status: 'ACTIVE', deleted: false, cycle: ciclo === 'ANUAL' ? 'YEARLY' : 'MONTHLY', customer: `cus_ui_${chave}`, externalReference: id, value: valor / 100 };
            estado.cobrancas[sub] = [{ id: `pay_ui_${chave}`, status: 'RECEIVED', dueDate: pago, paymentDate: pago, value: valor / 100, billingType: 'PIX', subscription: sub, customer: `cus_ui_${chave}` }];
            await client.query(`UPDATE empresa_assinaturas SET situacao='ATIVA', ciclo=$2, periodo_atual_fim=$3::timestamptz, provedor='ASAAS', provedor_cliente_id=$4,
                provedor_assinatura_id=$5, provedor_situacao='ACTIVE' WHERE empresa_id=$1`, [id, ciclo, somarCiclo(pago, ciclo), `cus_ui_${chave}`, sub]);
            empresas[chave] = { id, nome, sub };
        }
        fs.writeFileSync(duble, JSON.stringify(estado, null, 2));

        const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
            DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
            EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.join(relatorios, 'emails'), NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
            ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_do_duble_sem_valor', ASAAS_WEBHOOK_TOKEN: `token-sintetico-${randomBytes(16).toString('hex')}`,
            SITE_ATENDIMENTO_EMAIL: 'plataforma@exemplo.test', KIDMAIS_TESTE_ASAAS_DUBLE: duble, NODE_OPTIONS: `--require "${path.resolve('scripts/teste-asaas-duble.cjs').split(path.sep).join('/')}"` };
        for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
            'RECUPERACAO_SENHA_ATIVA', 'ASSINATURA_PRECO_MENSAL_CENTAVOS', 'ASSINATURA_PRECO_ANUAL_CENTAVOS', 'ASSINATURA_PLANOS_ATIVOS', 'ASSINATURA_ESTORNO_ATIVO']) delete env[k];
        servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
            { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
        for (let n = 0; n < 180; n++) {
            if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
            if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.ok).catch(() => false)) break;
            if (n === 179) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
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
            await page.goto('about:blank');
            const s = await sessaoAtual();
            const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: empresas[chave].id } });
            assert.equal(r.status(), 200, `selecionar ${chave}`);
            await page.goto(`${base}/admin/assinatura`);
            await page.locator('[data-encerramento]').waitFor();
        }
        const lerDuble = () => JSON.parse(fs.readFileSync(duble, 'utf8'));
        const secao = page.locator('[data-encerramento]');
        const semRolagem = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

        // A: arrependimento em 7 dias.
        await selecionar('A');
        // Sem a 097: a seção do arrependimento indica o canal oficial (o pedido vale a partir do envio).
        await page.locator('[data-arrependimento]').getByText('O pedido vale a partir do envio', { exact: false }).waitFor();
        assert.equal(await page.locator('[data-arrependimento] a[href^="mailto:contato@demerzellabs.com.br"]').count(), 1);
        await secao.getByText('Nos primeiros 7 dias da primeira ativação paga', { exact: false }).waitFor();
        // P3-9: durante a garantia, o formulário de "cancelar ao fim do período" indica o arrependimento integral.
        await page.getByRole('button', { name: 'Cancelar ao fim do período…' }).click();
        await page.locator('[data-cancelamento] [data-aviso-garantia]').getByText(/devolução integral de R\$\s?3\.970,00/).waitFor();
        await page.screenshot({ path: path.join(relatorios, 'a-cancelar-com-garantia.png'), fullPage: true });
        await page.locator('[data-cancelamento]').getByRole('button', { name: 'Voltar' }).click();
        await secao.getByRole('button', { name: 'Ver opções de encerramento com devolução' }).click();
        const opcaoA = secao.locator('[data-opcao="ARREPENDIMENTO_7_DIAS"]');
        await opcaoA.getByText(/R\$\s?3\.970,00/).first().waitFor();
        await secao.locator('[data-opcao-indisponivel="ENCERRAMENTO_ANUAL_PROPORCIONAL"]').getByText('Enquanto vale a garantia', { exact: false }).waitFor();
        await page.screenshot({ path: path.join(relatorios, 'a-opcoes.png'), fullPage: true });
        await opcaoA.getByRole('button', { name: /Encerrar e pedir/ }).click();
        const formA = secao.locator('[data-confirmar-devolucao]');
        await formA.getByLabel('Motivo (opcional)').fill('Teste E2E: desisti');
        await formA.getByLabel('Sua senha').fill(password);
        await formA.getByRole('button', { name: 'Confirmar encerramento e devolução' }).click();
        const confirmacao = secao.locator('[data-protocolo]');
        await confirmacao.waitFor();
        const protocoloA = await confirmacao.getAttribute('data-protocolo');
        assert.match(protocoloA, /^KM-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
        await confirmacao.getByText(`Protocolo: ${protocoloA}`, { exact: false }).waitFor();
        await confirmacao.getByText('Enviamos a confirmação para o seu e-mail.').waitFor();
        await page.screenshot({ path: path.join(relatorios, 'a-protocolo.png'), fullPage: true });
        const linhaA = (await client.query("SELECT situacao, provedor_situacao FROM empresa_assinaturas WHERE empresa_id=$1", [empresas.A.id])).rows[0];
        assert.deepEqual([linhaA.situacao, linhaA.provedor_situacao], ['ENCERRADA', 'DELETED']);
        const pedidoA = (await client.query("SELECT tipo, valor_devolucao_centavos, estorno_situacao, email_situacao FROM assinatura_encerramentos WHERE protocolo=$1", [protocoloA])).rows[0];
        assert.deepEqual([pedidoA.tipo, pedidoA.valor_devolucao_centavos, pedidoA.estorno_situacao, pedidoA.email_situacao], ['ARREPENDIMENTO_7_DIAS', 397000, 'AGUARDANDO_MANUAL', 'ENVIADO']);
        const d1 = lerDuble();
        assert.ok(d1.chamadas.includes(`DELETE /subscriptions/${empresas.A.sub}`), 'renovação removida no dublê');
        assert.equal(d1.estornos.length, 0, 'flag desligada: nenhum estorno pela API');
        const emails = fs.readdirSync(path.join(relatorios, 'emails')).map((f) => JSON.parse(fs.readFileSync(path.join(relatorios, 'emails', f), 'utf8')));
        const daGestao = emails.filter((m) => m.para === email), internos = emails.filter((m) => m.para === 'plataforma@exemplo.test');
        assert.equal(daGestao.length, 1);
        assert.match(daGestao[0].texto, new RegExp(protocoloA));
        // P2-3: aviso interno imediato ao canal da plataforma, sem nome da empresa nem e-mail da pessoa.
        assert.equal(internos.length, 1);
        assert.match(internos[0].assunto, new RegExp(protocoloA));
        assert.doesNotMatch(internos[0].texto, /Buffet|@exemplo/);
        // Depois de recarregar: Encerrada, somente leitura e o protocolo no histórico.
        await page.reload();
        await secao.locator('[data-pedidos]').getByText(protocoloA, { exact: false }).waitFor();
        await page.getByText('Somente leitura', { exact: false }).first().waitFor();
        assert.equal(await secao.getByRole('button', { name: 'Ver opções de encerramento com devolução' }).count(), 0, 'encerrada: sem novas opções');
        await page.screenshot({ path: path.join(relatorios, 'a-historico.png'), fullPage: true });
        resultados.push(`A (anual, 1º dia): arrependimento integral R$ 3.970,00; protocolo ${protocoloA} na hora; ENCERRADA/somente leitura; renovação removida no dublê; sem estorno pela API (flag desligada); e-mail em arquivo; histórico`);
        console.log('E2E_DEVOLUCAO_ARREPENDIMENTO_OK');

        // B: anual proporcional.
        await selecionar('B');
        await secao.getByRole('button', { name: 'Ver opções de encerramento com devolução' }).click();
        await secao.locator('[data-opcao-indisponivel="ARREPENDIMENTO_7_DIAS"]').getByText('O prazo de 7 dias', { exact: false }).waitFor();
        const opcaoB = secao.locator('[data-opcao="ENCERRAMENTO_ANUAL_PROPORCIONAL"]');
        await opcaoB.getByText('100 dias utilizados', { exact: false }).waitFor();
        await opcaoB.getByText(/R\$\s?2\.382,00 pagos/).waitFor();
        await page.screenshot({ path: path.join(relatorios, 'b-proporcional.png'), fullPage: true });
        await opcaoB.getByRole('button', { name: /Encerrar e pedir/ }).click();
        await secao.locator('[data-confirmar-devolucao]').getByLabel('Sua senha').fill(password);
        await secao.getByRole('button', { name: 'Confirmar encerramento e devolução' }).click();
        await secao.locator('[data-protocolo]').waitFor();
        await secao.locator('[data-protocolo]').getByText('O processamento começa até', { exact: false }).waitFor();
        const pedidoB = (await client.query("SELECT dias_utilizados, valor_pago_centavos, valor_devolucao_centavos FROM assinatura_encerramentos WHERE empresa_id=$1", [empresas.B.id])).rows[0];
        assert.equal(pedidoB.dias_utilizados, 100);
        assert.equal(pedidoB.valor_pago_centavos, 238200);
        assert.ok(pedidoB.valor_devolucao_centavos > 0 && pedidoB.valor_devolucao_centavos < 238200);
        resultados.push(`B (anual Fundador, 100 dias): garantia encerrada; proporcional ${pedidoB.valor_devolucao_centavos} centavos sobre 238200 pagos com o cálculo na tela; protocolo e prazo de 5 dias úteis`);
        console.log('E2E_DEVOLUCAO_PROPORCIONAL_OK');

        // C: mensal fora da garantia; cancelamento ao fim do período com protocolo.
        await selecionar('C');
        await secao.getByRole('button', { name: 'Ver opções de encerramento com devolução' }).click();
        await secao.locator('[data-opcao-indisponivel="ENCERRAMENTO_ANUAL_PROPORCIONAL"]').getByText('No plano mensal', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Cancelar ao fim do período…' }).click();
        const formC = page.locator('[data-cancelamento]');
        await formC.getByLabel('Sua senha').fill(password);
        // P2-2: 1ª tentativa sem confirmação do provedor (503) → a tela mostra o erro e troca a chave; a 2ª é efetiva.
        const d0 = lerDuble(); d0.perderRemocao = true; fs.writeFileSync(duble, JSON.stringify(d0, null, 2));
        await formC.getByRole('button', { name: 'Confirmar cancelamento' }).click();
        await page.locator('[data-assinatura-acoes] [role="alert"]').getByText('não confirmou', { exact: false }).waitFor();
        const d1c = lerDuble(); d1c.perderRemocao = false; fs.writeFileSync(duble, JSON.stringify(d1c, null, 2));
        assert.equal((await client.query("SELECT count(*)::int AS n FROM assinatura_encerramentos WHERE empresa_id=$1 AND cancelamento_provedor='SEM_CONFIRMACAO'", [empresas.C.id])).rows[0].n, 1);
        await formC.getByLabel('Sua senha').fill(password);
        await formC.getByRole('button', { name: 'Confirmar cancelamento' }).click();
        await page.locator('[data-assinatura-acoes] [role="status"]').getByText('Protocolo: KM-', { exact: false }).first().waitFor();
        const pedidoC = (await client.query("SELECT tipo, estorno_situacao FROM assinatura_encerramentos WHERE empresa_id=$1", [empresas.C.id])).rows[0];
        assert.deepEqual([pedidoC.tipo, pedidoC.estorno_situacao], ['CANCELAMENTO_FIM_PERIODO', 'NAO_SE_APLICA']);
        assert.equal((await client.query("SELECT situacao FROM empresa_assinaturas WHERE empresa_id=$1", [empresas.C.id])).rows[0].situacao, 'CANCELADA_FIM_PERIODO');
        const cancelamentosC = (await client.query("SELECT cancelamento_provedor FROM assinatura_encerramentos WHERE empresa_id=$1 ORDER BY solicitado_em", [empresas.C.id])).rows.map((x) => x.cancelamento_provedor);
        assert.deepEqual(cancelamentosC, ['AUSENTE', 'CONFIRMADO'], 'a 2ª tentativa (chave nova) confirmou; a sincronização fechou o pedido incerto');
        await page.screenshot({ path: path.join(relatorios, 'c-cancelamento.png'), fullPage: true });
        resultados.push('C (mensal, 10 dias): sem devolução (textos corretos); "Cancelar ao fim do período" com protocolo na tela; CANCELADA_FIM_PERIODO');
        console.log('E2E_DEVOLUCAO_CANCELAMENTO_OK');

        // D (097): arrependimento pela ferramenta na empresa C — mensal, fora da garantia, já cancelada ao fim do período.
        await client.query(fs.readFileSync(UP_097, 'utf8'));
        const chamadasAntes = lerDuble().chamadas.length;
        const emailsAntes = fs.readdirSync(path.join(relatorios, 'emails')).length;
        await selecionar('C');
        const arr = page.locator('[data-arrependimento]');
        await arr.getByText('mesmo que a devolução automática não esteja disponível', { exact: false }).waitFor();
        await arr.getByRole('button', { name: 'Registrar arrependimento…' }).click();
        const formD = arr.locator('[data-form-arrependimento]');
        assert.equal(await formD.getByRole('button', { name: 'Confirmar arrependimento' }).isDisabled(), true, 'sem confirmação marcada, botão desabilitado');
        await formD.getByLabel('Motivo (opcional)').fill('Teste E2E: arrependimento fora da garantia');
        await formD.getByLabel('Quero desistir da contratação do Kidmais Manager.').check();
        await formD.getByLabel('Sua senha').fill(password);
        await formD.getByRole('button', { name: 'Confirmar arrependimento' }).click();
        const protD = arr.locator('[data-protocolo-arrependimento]');
        await protD.waitFor();
        const protocoloD = await protD.getAttribute('data-protocolo-arrependimento');
        assert.match(protocoloD, /^KA-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
        await protD.getByText(`Protocolo: ${protocoloD}`, { exact: false }).waitFor();
        await protD.getByText('Enviamos a confirmação para o seu e-mail.').waitFor();
        await page.screenshot({ path: path.join(relatorios, 'd-arrependimento.png'), fullPage: true });
        const linhaD = (await client.query("SELECT canal, situacao, situacao_assinatura, email_confirmacao, aviso_interno, provedor_disponivel FROM assinatura_arrependimentos WHERE protocolo=$1", [protocoloD])).rows[0];
        assert.deepEqual([linhaD.canal, linhaD.situacao, linhaD.situacao_assinatura, linhaD.email_confirmacao, linhaD.aviso_interno, linhaD.provedor_disponivel],
            ['FERRAMENTA', 'RECEBIDO', 'CANCELADA_FIM_PERIODO', 'ENVIADO', 'ENVIADO', true]);
        assert.equal(lerDuble().chamadas.length, chamadasAntes, 'o registro do arrependimento não chama o provedor');
        const novos = fs.readdirSync(path.join(relatorios, 'emails')).map((f) => JSON.parse(fs.readFileSync(path.join(relatorios, 'emails', f), 'utf8')))
            .filter((m) => new RegExp(protocoloD).test(m.assunto));
        assert.equal(fs.readdirSync(path.join(relatorios, 'emails')).length, emailsAntes + 2);
        assert.deepEqual(novos.map((m) => m.para).sort(), [email, 'plataforma@exemplo.test'].sort());
        assert.doesNotMatch(novos.find((m) => m.para !== email).texto, /Buffet|@exemplo/);
        await page.reload();
        await arr.locator('ul[aria-label="Pedidos de arrependimento"]').getByText(protocoloD, { exact: false }).waitFor();
        resultados.push(`D (097, mensal fora da garantia, cancelada ao fim do período): arrependimento pela ferramenta com protocolo ${protocoloD} na hora; sem chamada ao dublê; e-mail à Gestão e aviso interno; lista após recarregar`);
        console.log('E2E_ARREPENDIMENTO_097_OK');

        await page.setViewportSize({ width: 390, height: 844 });
        await selecionar('A');
        assert.ok(await semRolagem(), 'sem rolagem horizontal no celular');
        await page.screenshot({ path: path.join(relatorios, 'celular.png'), fullPage: true });
        resultados.push('Celular (390 px): sem rolagem horizontal');
        assert.equal(lerDuble().chamadas.filter((c) => !/^(GET|DELETE) \/subscriptions\//.test(c)).length, 0, 'só leituras e remoções no dublê');
        fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, asaas: 'dublê local', email: 'arquivo local', resultados }, null, 2));
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
principal().catch(e => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n').slice(0, 8).join(' | ')); process.exitCode = 1; });
