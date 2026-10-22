/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in dos créditos de IA (090) no navegador, com PostgreSQL DESCARTÁVEL (modelo 089 + 090 aplicada aqui) e dados
 * sintéticos. O Asaas é o DUBLÊ dentro do `next dev` (scripts/teste-asaas-duble.cjs: o fetch para o sandbox é atendido em
 * memória; qualquer outro endereço do Asaas é recusado). E-mail em ARQUIVO local. Nenhum .env, banco real, provedor real ou
 * serviço Render. Execute com os três KIDMAIS_* de autorização do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 * Gestão da empresa C (carteira de Convites cortada do legado, assinatura paga) e uma pessoa da Equipe:
 *   1. saldo zero, catálogo de DEMONSTRAÇÃO (proposta), nenhum campo de cartão na página;
 *   2. Pix: senha errada não cobra; clique duplo = um pedido e um POST; protocolo, pagamento pendente e link da fatura;
 *      recarregar mantém "pagamento em confirmação" e saldo zero (voltar da fatura não libera nada);
 *   3. webhook com token errado → 401; webhook certo → crédito liberado UMA vez (após a reconsulta do dublê);
 *   4. cartão e boleto: cobranças avulsas com billingType CREDIT_CARD e BOLETO;
 *   5. devolução na garantia de 7 dias: protocolo, saldo do pacote cancelado, fila manual (sem estorno: flag desligada);
 *   6. preço alterado → 409; pedido de outra empresa → 404; Equipe vê só o saldo e recebe 403 ao comprar;
 *   7. celular (390 px): sem rolagem horizontal, resumo legível;
 *   8. flags desligadas (novo `next dev`): sem catálogo, compra 503, histórico e saldo continuam visíveis.
 */
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3157;
const UP = 'database/migrations/20261022_090_ia_creditos.sql';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const relatorios = path.resolve('.local-creditos-ui');
    fs.rmSync(relatorios, { recursive: true, force: true });
    fs.mkdirSync(path.join(relatorios, 'emails'), { recursive: true });
    const duble = path.join(relatorios, 'asaas-duble.json');
    const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
    const resultados = [];
    const token = `token-sintetico-${randomBytes(16).toString('hex')}`;
    const subirServidor = async (flags) => {
        const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
            DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: segredo, ADMIN_AUTH_ORIGIN: base,
            EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.join(relatorios, 'emails'), NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
            ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_do_duble_sem_valor', ASAAS_WEBHOOK_TOKEN: token,
            SITE_ATENDIMENTO_EMAIL: 'plataforma@exemplo.test', KIDMAIS_TESTE_ASAAS_DUBLE: duble, NODE_OPTIONS: `--require "${path.resolve('scripts/teste-asaas-duble.cjs').split(path.sep).join('/')}"`,
            ...flags };
        for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'OPENAI_API_KEY', 'CONVITES_OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
            'ASSINATURA_ESTORNO_ATIVO', 'CREDITOS_ESTORNO_ATIVO', 'CREDITOS_WALLE_CONSUMO_ATIVO', 'CREDITOS_CATALOGO_APROVADO']) delete env[k];
        for (const [k, v] of Object.entries(flags)) if (v === undefined) delete env[k];
        servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
            { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
        for (let n = 0; n < 240; n++) {
            if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
            if (await fetch(`${base}/api/admin/autenticacao`).then((r) => r.ok).catch(() => false)) return;
            await espera(500);
        }
        throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
    };
    const pararServidor = async () => {
        if (servidor && servidor.exitCode === null) { servidor.kill(); await new Promise((r) => servidor.once('exit', r)); }
        servidor = null;
    };
    const segredo = randomBytes(32).toString('hex');
    try {
        await receita.restaurar(admin, receita.TRABALHO[0], '089');
        client = await receita.conectar(porta, receita.TRABALHO[0]);
        await client.query(fs.readFileSync(UP, 'utf8'));
        const carregar = (f) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
        const senhaMod = carregar('lib/autenticacao/senha.ts');
        const corte = carregar('lib/creditos/corte.ts');
        const password = `sintetica-${randomBytes(12).toString('hex')}`;
        const pessoa = async (email, papel) => {
            const id = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,$2,$3,$4) RETURNING id`,
                [email, papel === 'ADMINISTRATIVO' ? 'Equipe Créditos UI' : 'Gestão Créditos UI', await senhaMod.criarHashSenha(password), 'ADMINISTRATIVO'])).rows[0].id;
            await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [id]);
            return id;
        };
        const emailGestao = 'gestao-creditos-ui@exemplo.test', emailEquipe = 'equipe-creditos-ui@exemplo.test';
        const gestao = await pessoa(emailGestao, 'REPRESENTANTE_AUTORIZADO'), equipe = await pessoa(emailEquipe, 'ADMINISTRATIVO');
        const empresas = {};
        for (const [chave, nome, cnpj] of [['C', 'Buffet Créditos UI', '11222333000181'], ['B', 'Buffet Vizinho UI', '45723174000110']]) {
            const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`cr-${chave.toLowerCase()}-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
            await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
            for (const [u, papel] of [[gestao, 'REPRESENTANTE_AUTORIZADO'], ...(chave === 'C' ? [[equipe, 'ADMINISTRATIVO']] : [])]) {
                const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [id, u, papel])).rows[0].id;
                await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
            }
            await client.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
                VALUES($1,'TESTE',clock_timestamp() - interval '40 days',clock_timestamp() - interval '25 days',$2)`, [id, cnpj]);
            await client.query(`UPDATE empresa_assinaturas SET situacao='ATIVA', ciclo='MENSAL', periodo_atual_fim=clock_timestamp() + interval '20 days', provedor='ASAAS',
                provedor_cliente_id=$2, provedor_assinatura_id=$3, provedor_situacao='ACTIVE' WHERE empresa_id=$1`, [id, `cus_ui_${chave}`, `sub_ui_${chave}`]);
            await client.query('INSERT INTO convite_carteiras(empresa_id,limite_mensal,ativo) VALUES($1,0,true)', [id]);
            await client.query('BEGIN'); await corte.aplicarCorte(client, id, 'E2E LOCAL 22/10'); await client.query('COMMIT');
            empresas[chave] = { id };
        }
        // Pedido sintético da empresa B (para o teste de isolamento por protocolo).
        await client.query(`INSERT INTO ia_credito_pedidos (empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256, quantidade, preco_centavos,
            validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
            VALUES ($1, 'KM-20261022-BBBBBBBB', 'CONVITES', 'PROPOSTA-20261022-DEMO', 'CONVITES_10', '{}'::jsonb, 'creditos-ia-20261022.demo', $2, 10, 5900, 365, 'PIX', 'sandbox', $3, $2,
            'CRIACAO_EM_CURSO', $4, current_date + 3)`, [empresas.B.id, 'a'.repeat(64), randomUUID(), gestao]);
        fs.writeFileSync(duble, JSON.stringify({ assinaturas: {}, cobrancas: {}, chamadas: [], estornos: [], avulsas: {} }, null, 2));
        const lerDuble = () => JSON.parse(fs.readFileSync(duble, 'utf8'));

        await subirServidor({ CREDITOS_CATALOGO_ATIVO: 'true', CREDITOS_COMPRA_ATIVA: 'true', CREDITOS_CONVITES_CONSUMO_ATIVO: 'true' });
        browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
        const entrar = async (email, viewport = { width: 1440, height: 1000 }) => {
            const contexto = await browser.newContext({ viewport });
            contexto.setDefaultTimeout(60000);
            const page = await contexto.newPage();
            await page.goto(`${base}/admin/login`);
            await page.getByLabel('Email', { exact: true }).fill(email);
            await page.getByLabel('Senha', { exact: true }).fill(password);
            await page.getByRole('button', { name: 'Entrar', exact: true }).click();
            await page.waitForURL((url) => !url.pathname.includes('/login'));
            const sessao = () => contexto.request.get(`${base}/api/admin/autenticacao`).then((r) => r.json());
            const s = await sessao();
            const r = await contexto.request.post(`${base}/api/admin/autenticacao`, { headers: { origin: base, 'x-csrf-token': s.data.csrf }, data: { acao: 'selecionar-empresa', empresaId: empresas.C.id } });
            assert.equal(r.status(), 200, 'selecionar C');
            await page.goto(`${base}/admin/assinatura`);
            await page.locator('[data-creditos]').waitFor();
            const api = async (metodo, url, data) => {
                const s2 = await sessao();
                return contexto.request.fetch(`${base}${url}`, { method: metodo, headers: { origin: base, 'x-csrf-token': s2.data.csrf }, ...(data ? { data } : {}) });
            };
            return { contexto, page, api };
        };
        const { page, api } = await entrar(emailGestao);
        const secao = page.locator('[data-creditos]');
        const semRolagem = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        const disponivel = async () => (await secao.locator('[data-saldo="CONVITES"] [data-disponivel]').textContent()).trim();

        // 1. Saldo zero, catálogo de demonstração, nenhum campo de cartão.
        assert.equal(await disponivel(), '0');
        await secao.locator('[data-catalogo-proposta]').getByText('ainda não aprovados como oferta vigente', { exact: false }).waitFor();
        assert.equal(await page.locator('input[autocomplete^="cc-"], input[name*="cartao" i], input[name*="cvv" i], input[name*="card" i]').count(), 0, 'nenhum campo de cartão');
        await page.screenshot({ path: path.join(relatorios, '1-saldo-catalogo.png'), fullPage: true });
        resultados.push('1: saldo 0 (motor novo), catálogo de demonstração identificado como proposta, nenhum campo de cartão');

        // 2. Pix: senha errada não cobra; clique duplo = um pedido e um POST.
        const comprar = async (oferta, forma, senha) => {
            await secao.locator(`[data-oferta="${oferta}"]`).click();
            const form = secao.locator('[data-resumo-compra]');
            await form.getByText('Compra avulsa, sem renovação automática', { exact: false }).waitFor();
            await form.locator(`input[name="forma"][value="${forma}"]`).check();
            await form.locator('[data-aceite]').check();
            await form.getByLabel('Sua senha').fill(senha);
            return form;
        };
        const form1 = await comprar('CONVITES_10', 'PIX', 'senha-errada-sintetica');
        await form1.locator('[data-confirmar-compra]').click();
        await secao.locator('[role="alert"]').getByText('Senha incorreta. Nada foi cobrado.').waitFor();
        assert.equal(lerDuble().postsAvulsa ?? 0, 0, 'senha errada: nenhuma cobrança');
        await form1.getByLabel('Sua senha').fill(password);
        await form1.locator('[data-confirmar-compra]').dblclick();
        const resultado = secao.locator('[data-pedido-resultado]');
        await resultado.waitFor();
        const protocolo = await resultado.getAttribute('data-protocolo');
        assert.match(protocolo, /^KM-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
        assert.equal(await resultado.getAttribute('data-pedido-resultado'), 'AGUARDANDO_PAGAMENTO');
        assert.match(await resultado.locator('[data-link-pagamento]').getAttribute('href'), /^https:\/\/sandbox\.asaas\.com\/i\//);
        assert.equal(lerDuble().postsAvulsa, 1, 'clique duplo: um POST');
        assert.equal((await client.query('SELECT count(*)::int AS n FROM ia_credito_pedidos WHERE empresa_id=$1', [empresas.C.id])).rows[0].n, 1, 'clique duplo: um pedido');
        const pix = Object.values(lerDuble().avulsas)[0];
        assert.deepEqual([pix.billingType, pix.value, pix.customer, pix.externalReference.startsWith('km:sandbox:creditos:')], ['PIX', 59, 'cus_ui_C', true]);
        assert.equal(JSON.stringify(pix).includes('@'), false, 'nenhum e-mail no provedor');
        await page.screenshot({ path: path.join(relatorios, '2-pix-pendente.png'), fullPage: true });
        await page.reload();
        await secao.locator(`[data-pedido="${protocolo}"][data-estado="AGUARDANDO_PAGAMENTO"]`).waitFor();
        assert.equal(await disponivel(), '0', 'sem confirmação, sem crédito');
        resultados.push(`2: Pix ${protocolo}; senha errada sem cobrança; clique duplo = 1 pedido/1 POST; pendente e saldo 0 após recarregar`);

        // 3. Webhook: token errado → 401; certo → crédito uma vez.
        const evento = (n) => ({ id: `evt_ui_${n}_${randomBytes(3).toString('hex')}`, event: 'PAYMENT_RECEIVED', dateCreated: '2026-10-22 12:00:00',
            payment: { id: pix.id, customer: 'cus_ui_C', value: 59, externalReference: pix.externalReference, billingType: 'PIX' } });
        const webhook = (corpo, tk) => fetch(`${base}/api/integracoes/asaas/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': tk }, body: JSON.stringify(corpo) });
        assert.equal((await webhook(evento(0), 'token-errado-'.padEnd(40, 'x'))).status, 401);
        const d0 = lerDuble(); d0.avulsas[pix.id].status = 'RECEIVED'; fs.writeFileSync(duble, JSON.stringify(d0, null, 2));
        assert.equal((await webhook(evento(1), token)).status, 200);
        assert.equal((await webhook(evento(2), token)).status, 200, 'outro evento do mesmo pagamento');
        for (let i = 0; i < 80; i++) {
            if ((await client.query('SELECT estado FROM ia_credito_pedidos WHERE protocolo=$1', [protocolo])).rows[0].estado === 'CREDITADO') break;
            await espera(250);
        }
        await espera(1500);
        assert.equal((await client.query('SELECT estado FROM ia_credito_pedidos WHERE protocolo=$1', [protocolo])).rows[0].estado, 'CREDITADO');
        assert.equal((await client.query("SELECT count(*)::int AS n FROM ia_credito_lotes WHERE empresa_id=$1 AND origem='COMPRA'", [empresas.C.id])).rows[0].n, 1, 'um lote');
        await page.reload();
        await secao.locator(`[data-pedido="${protocolo}"][data-estado="CREDITADO"]`).waitFor();
        assert.equal(await disponivel(), '10');
        await page.screenshot({ path: path.join(relatorios, '3-creditado.png'), fullPage: true });
        // Outbox: confirmação por e-mail (arquivo local) à Gestão, uma vez, sem link de fatura nem dado do pagador.
        let emails = [];
        for (let i = 0; i < 40 && !emails.length; i++) {
            emails = fs.readdirSync(path.join(relatorios, 'emails')).map((f) => JSON.parse(fs.readFileSync(path.join(relatorios, 'emails', f), 'utf8')))
                .filter((m) => m.assunto === 'Créditos de IA liberados');
            if (!emails.length) await espera(250);
        }
        assert.equal(emails.length, 1, 'um e-mail de confirmação');
        assert.equal(emails[0].para, emailGestao);
        assert.match(emails[0].texto, new RegExp(protocolo));
        assert.doesNotMatch(emails[0].texto, /asaas\.com|cus_ui|pay_av/);
        resultados.push('3: webhook com token errado 401; dois eventos do mesmo pagamento → CREDITADO, um lote, saldo 10; um e-mail de confirmação (arquivo)');

        // 4. Cartão e boleto (página hospedada; sem dados de cartão aqui).
        for (const forma of ['CARTAO', 'BOLETO']) {
            const f = await comprar('CONVITES_10', forma, password);
            await f.locator('[data-confirmar-compra]').click();
            await secao.locator('[data-pedido-resultado="AGUARDANDO_PAGAMENTO"]').waitFor();
            await page.reload();
            await secao.locator('[data-catalogo]').waitFor();
        }
        const tipos = Object.values(lerDuble().avulsas).map((c) => c.billingType);
        assert.deepEqual(tipos, ['PIX', 'CREDIT_CARD', 'BOLETO']);
        resultados.push('4: cartão e boleto → cobranças avulsas CREDIT_CARD e BOLETO (fatura hospedada), sem campo de cartão na página');

        // 5. Devolução na garantia de 7 dias (fila manual: CREDITOS_ESTORNO_ATIVO desligada).
        await secao.locator(`[data-pedir-devolucao="${protocolo}"]`).click();
        const fd = secao.locator('[data-confirmar-devolucao-creditos]');
        await fd.getByLabel('Sua senha').fill(password);
        await fd.getByRole('button', { name: 'Confirmar devolução' }).click();
        const dev = secao.locator('[data-devolucao-resultado]');
        await dev.waitFor();
        const protDev = await dev.getAttribute('data-protocolo');
        await dev.getByText(/R\$\s?59,00/).waitFor();
        const linhaDev = (await client.query('SELECT estado, valor_centavos, quantidade_cancelada FROM ia_credito_devolucoes WHERE protocolo=$1', [protDev])).rows[0];
        assert.deepEqual([linhaDev.estado, Number(linhaDev.valor_centavos), Number(linhaDev.quantidade_cancelada)], ['AGUARDANDO_MANUAL', 5900, 10]);
        assert.equal(lerDuble().estornos.length, 0, 'flag desligada: nenhum estorno pela API');
        await page.reload();
        assert.equal(await disponivel(), '0', 'saldo devolvido cancelado');
        await page.screenshot({ path: path.join(relatorios, '5-devolucao.png'), fullPage: true });
        resultados.push(`5: devolução ${protDev} integral (R$ 59,00) na garantia; saldo cancelado; fila manual sem estorno pela API`);

        // 6. Preço alterado, isolamento por empresa, papel indevido.
        const alterado = await api('POST', '/api/admin/creditos', { oferta: 'CONVITES_10', forma: 'PIX', chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 100, termosVersao: 'creditos-ia-20261022.demo' });
        assert.equal(alterado.status(), 409);
        assert.equal((await api('GET', '/api/admin/creditos/pedido?protocolo=KM-20261022-BBBBBBBB')).status(), 404, 'pedido de outra empresa');
        const eq = await entrar(emailEquipe);
        const secaoEq = eq.page.locator('[data-creditos]');
        await secaoEq.getByText('Somente a Gestão compra créditos', { exact: false }).waitFor();
        assert.equal(await secaoEq.locator('[data-catalogo], [data-pedidos-creditos], [data-extrato]').count(), 0);
        const compraEq = await eq.api('POST', '/api/admin/creditos', { oferta: 'CONVITES_10', forma: 'PIX', chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 5900, termosVersao: 'creditos-ia-20261022.demo' });
        assert.equal(compraEq.status(), 403);
        await eq.contexto.close();
        resultados.push('6: preço alterado 409; pedido de outra empresa 404; Equipe vê só o saldo e recebe 403 ao comprar');

        // 7. Celular.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await secao.locator('[data-oferta="CONVITES_30"]').click();
        await secao.locator('[data-resumo-compra]').waitFor();
        assert.ok(await semRolagem(), 'sem rolagem horizontal no celular');
        await page.screenshot({ path: path.join(relatorios, '7-celular.png'), fullPage: true });
        resultados.push('7: celular 390 px sem rolagem horizontal, resumo da compra visível');

        // 8. Flags desligadas: sem catálogo, compra 503; saldo e histórico continuam.
        await pararServidor();
        await subirServidor({ CREDITOS_CATALOGO_ATIVO: undefined, CREDITOS_COMPRA_ATIVA: undefined, CREDITOS_CONVITES_CONSUMO_ATIVO: undefined });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${base}/admin/assinatura`);
        await secao.locator(`[data-pedido="${protocolo}"]`).waitFor();
        assert.equal(await secao.locator('[data-catalogo]').count(), 0);
        await secao.getByText('A geração com créditos está em manutenção', { exact: false }).waitFor();
        const fechada = await api('POST', '/api/admin/creditos', { oferta: 'CONVITES_10', forma: 'PIX', chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 5900, termosVersao: 'creditos-ia-20261022.demo' });
        assert.equal(fechada.status(), 503);
        await page.screenshot({ path: path.join(relatorios, '8-flags-off.png'), fullPage: true });
        resultados.push('8: flags desligadas: sem catálogo, compra 503, histórico e saldo visíveis, aviso de manutenção');
        const chamadas = lerDuble().chamadas;
        assert.ok(chamadas.every((c) => /^(POST \/payments|GET \/payments\/pay_av_\d+|GET \/payments)$/.test(c)), `só cobrança avulsa no dublê: ${chamadas.join(', ')}`);
        fs.writeFileSync(path.join(relatorios, 'resultado.json'), JSON.stringify({ ok: true, asaas: 'dublê local', email: 'arquivo local', resultados }, null, 2));
        console.log(JSON.stringify({ ok: true, resultados }));
    } finally {
        await browser?.close();
        await pararServidor();
        fs.closeSync(logfile);
        await client?.end(); await admin.end();
    }
}
principal().catch((e) => { console.error('E2E_FALHOU', e.code || e.name, String(e.message).split('\n').slice(0, 8).join(' | ')); process.exitCode = 1; });
