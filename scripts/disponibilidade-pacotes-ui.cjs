/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in do seletor de pacote em /admin/disponibilidade, com PostgreSQL DESCARTÁVEL e dados sintéticos (modelo 089).
 * Restaura SOMENTE o banco sintético do runner a partir do modelo 089 (a receita prova cluster/porta/usuário antes de
 * escrever). Nenhum .env, banco real, e-mail, provedor ou serviço Render. Execute com os três KIDMAIS_* de autorização
 * do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 *   - Buffet novo, sem pacote: o seletor não traz o catálogo Kidmais ("Nenhum pacote criado", desabilitado) e a tela
 *     aponta para Configurações → Pacotes; o calendário continua com a ocupação física.
 *   - Buffet com um pacote (código POCKET, nome próprio): o seletor lista só ele, com o nome do buffet.
 *   - Dona da agenda pública (AGENDA_PUBLICA_EMPRESA_ID): continua com os sete pacotes do catálogo legado.
 *   - Pacote criado do zero pela tela (Configurações → Pacotes → "Novo pacote", código P_…): entra no seletor da
 *     Disponibilidade com as regras dele; aparece na cotação pública /b/<código> (cartão, sem nada da Kidmais); a cotação e
 *     o envio do fechamento por HTTP gravam com esse pacote (COTACAO_PUBLICA_POR_EMPRESA=true só neste servidor local).
 *   - Fase 1c: o fechamento administrativo (wizard do painel) do buffet comum lista os pacotes dele, mostra o calendário
 *     pelas regras dele e cria o fechamento com o pacote novo.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

/** CNPJ sintético com dígitos válidos (nunca o da Kidmais), só para a isenção da empresa de teste. */
function cnpjSintetico() {
  let d = Array.from(randomBytes(8), (n) => n % 10).join('') + '0001';
  for (const pesos of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const resto = [...d].reduce((soma, n, i) => soma + Number(n) * pesos[i], 0) % 11;
    d += resto < 2 ? '0' : String(11 - resto);
  }
  assert.notEqual(d, '20119900000160');
  return d;
}

function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0] + 1) % 10;
  const dv = (n) => { const soma = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return soma < 2 ? 0 : 11 - soma; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

const PORTA_WEB = 3159;

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
  const relatorios = path.resolve(process.env.KIDMAIS_DISPONIBILIDADE_UI_RELATORIOS || '.local-disponibilidade-ui');
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
    const pessoa = async (email, nome) => {
      const id = (await client.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,$2,$3,'ADMINISTRATIVO') RETURNING id`, [email, nome, hash])).rows[0].id;
      await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [id]);
      return id;
    };
    const empresa = async (nome) => {
      const id = (await client.query(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id`, [`dp-${randomBytes(3).toString('hex')}`, nome])).rows[0].id;
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id]);
      return id;
    };
    const vinculo = async (empresaId, usuarioId, papel) => {
      const m = (await client.query(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),$3) RETURNING id`, [empresaId, usuarioId, papel])).rows[0].id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
    };
    const DONA = await empresa('Buffet Dona da Agenda UI');
    const NOVA = await empresa('Buffet Novo UI');
    const COM = await empresa('Buffet Com Pacote UI');
    await vinculo(DONA, await pessoa('gestao-dona-ui@exemplo.test', 'Gestão Dona UI'), 'REPRESENTANTE_AUTORIZADO');
    await vinculo(NOVA, await pessoa('gestao-nova-ui@exemplo.test', 'Gestão Nova UI'), 'REPRESENTANTE_AUTORIZADO');
    await vinculo(COM, await pessoa('gestao-com-ui@exemplo.test', 'Gestão Com Pacote UI'), 'REPRESENTANTE_AUTORIZADO');
    await client.query(
      `INSERT INTO pacotes(empresa_id,codigo,nome,descricao,duracao_minutos,convidados_minimos,convidados_maximos,ordem_exibicao,ativo,vigente)
       VALUES($1,'POCKET','Festinha do Buffet UI',null,240,20,40,(SELECT COALESCE(MAX(ordem_exibicao),0)+1 FROM pacotes),true,true)`, [COM]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pacotes WHERE empresa_id=$1', [NOVA])).rows[0].n, 0, 'buffet novo nasce sem pacote');
    // Cotação pública por empresa (/b/<código>): acesso COMPLETO pela isenção sintética, como as fixtures de homologação.
    const gestaoCom = (await client.query("SELECT id FROM usuarios_administrativos WHERE email='gestao-com-ui@exemplo.test'")).rows[0].id;
    await client.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [COM]);
    await client.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'E2E sintético pacotes livres',$3)", [COM, cnpjSintetico(), gestaoCom]);
    const codigoCom = (await client.query('SELECT codigo FROM empresas WHERE id=$1', [COM])).rows[0].codigo;
    const turno1 = (await client.query("SELECT id::text AS id, horario_inicio_padrao::text AS inicio, horario_fim_padrao::text AS fim FROM configuracao_agenda WHERE codigo='TURNO_1' AND ativo")).rows[0];

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      AGENDA_PUBLICA_EMPRESA_ID: DONA, COTACAO_PUBLICA_POR_EMPRESA: 'true', EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 180; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.status < 500).catch(() => false)) break;
      if (n === 179) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });

    async function entrar(email) {
      const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexto.setDefaultTimeout(90000);
      const page = await contexto.newPage();
      await page.goto(`${base}/admin/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
      return { contexto, page };
    }
    async function seletorDePacote(page) {
      await page.goto(`${base}/admin/disponibilidade`);
      const seletor = page.locator('label').filter({ has: page.locator('span', { hasText: /^Pacote$/ }) }).locator('select');
      await seletor.waitFor();
      // Espera a carga do mês (os dias deixam de mostrar "…").
      await page.waitForFunction(() => !document.querySelector('button[disabled] small')?.textContent?.includes('…'));
      await page.waitForTimeout(500);
      return { seletor, opcoes: (await seletor.locator('option').allInnerTexts()).map((t) => t.trim()) };
    }

    {
      const { contexto, page } = await entrar('gestao-nova-ui@exemplo.test');
      const { seletor, opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Nenhum pacote criado']);
      assert.equal(await seletor.isDisabled(), true);
      await page.getByText('Nenhum pacote criado ainda.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Configurações → Pacotes', exact: true }).getAttribute('href'), '/admin/configuracoes/pacotes');
      const texto = await page.locator('main').innerText();
      for (const nome of ['Kidmais Pocket', 'Mini Festa Kidmais', 'Pizza Party Scienza', '-15% Dia útil']) assert.ok(!texto.includes(nome), nome);
      await page.screenshot({ path: path.join(relatorios, 'buffet-novo.png'), fullPage: true });
      await contexto.close();
      resultados.push('Buffet novo: seletor "Nenhum pacote criado" (desabilitado), aviso com link para Configurações → Pacotes, nenhum nome do catálogo Kidmais na tela');
      console.log('E2E_DISPONIBILIDADE_NOVA_OK');
    }
    {
      const { contexto, page } = await entrar('gestao-com-ui@exemplo.test');
      const { seletor, opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Festinha do Buffet UI']);
      assert.equal(await seletor.isDisabled(), false);
      assert.equal(await page.getByText('Nenhum pacote criado ainda.', { exact: false }).count(), 0);
      await page.screenshot({ path: path.join(relatorios, 'buffet-com-pacote.png'), fullPage: true });
      await contexto.close();
      resultados.push('Buffet com pacote: seletor lista só "Festinha do Buffet UI"');
      console.log('E2E_DISPONIBILIDADE_COM_PACOTE_OK');
    }
    {
      // Novo pacote pela tela real de Pacotes: sábado nos dois períodos, uma faixa de preço.
      const { contexto, page } = await entrar('gestao-com-ui@exemplo.test');
      await page.goto(`${base}/admin/configuracoes/pacotes`);
      await page.getByRole('button', { name: 'Novo pacote', exact: true }).click();
      await page.locator('#pacote-nome').fill('Festa Jardim UI');
      await page.locator('#pacote-descricao').fill('Pacote criado do zero no E2E');
      await page.locator('#pacote-min').fill('30');
      await page.locator('#pacote-max').fill('80');
      await page.getByLabel('Horas', { exact: true }).fill('4');
      await page.getByRole('group', { name: 'Dias permitidos' }).getByRole('button', { name: 'Sáb', exact: true }).click();
      const horariosSabado = page.getByRole('group', { name: 'Horários de Sáb' }).getByRole('button');
      await horariosSabado.first().waitFor();
      const totalHorarios = await horariosSabado.count();
      assert.ok(totalHorarios > 0, 'sábado com horários para escolher');
      for (let i = 0; i < totalHorarios; i++) {
        const botao = horariosSabado.nth(i);
        if (await botao.getAttribute('aria-pressed') !== 'true') await botao.click();
        await page.waitForFunction((el) => el.getAttribute('aria-pressed') === 'true', await botao.elementHandle());
      }
      await page.getByRole('button', { name: '+ Adicionar faixa', exact: true }).click();
      const faixa = page.locator('section').filter({ has: page.getByRole('heading', { name: '3. Preços' }) });
      await faixa.getByLabel('De', { exact: true }).last().fill('30');
      await faixa.getByLabel('Até', { exact: true }).last().fill('80');
      await faixa.getByLabel('Preço', { exact: true }).last().fill('4500,00');
      const salvo = page.waitForResponse((r) => r.url().includes('/api/admin/configuracoes/pacotes') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Salvar pacote', exact: true }).click();
      const resposta = await Promise.race([salvo, new Promise((_, rej) => setTimeout(() => rej(Error('NOVO_PACOTE_SEM_POST')), 15000))]).catch(async (erro) => {
        await page.screenshot({ path: path.join(relatorios, 'novo-pacote-falha.png'), fullPage: true });
        const avisos = await page.locator('[role=alert], [role=status], p').allInnerTexts();
        throw Error(`${erro.message}: horários de sábado=${await horariosSabado.count()}; ${avisos.filter((t) => /escolha|informe|erro|falha|obrigat/i.test(t)).join(' | ').slice(0, 300)}`);
      });
      assert.equal(resposta.status(), 201, await resposta.text());
      const criado = (await resposta.json()).data;
      const codigoLivre = criado.pacote?.codigo ?? criado.codigo;
      assert.match(codigoLivre, /^P_[0-9A-F]{32}$/, 'código técnico do Novo pacote');
      // Espera a recarga da lista terminar: sair da página com a leitura em voo descarta a resposta (guarda do adminFetch).
      await page.getByText('Pacote salvo.', { exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: path.join(relatorios, 'novo-pacote.png'), fullPage: true });

      // Disponibilidade: o seletor traz os dois pacotes do buffet; as regras do novo vêm pelo código dele.
      const carga = page.waitForResponse((r) => r.url().includes('/api/admin/disponibilidade') && r.request().method() === 'GET');
      const { seletor, opcoes } = await seletorDePacote(page);
      const corpo = await (await carga).json();
      assert.deepEqual(opcoes, ['Festinha do Buffet UI', 'Festa Jardim UI']);
      assert.equal(await page.getByText('Não foi possível confirmar a empresa ativa', { exact: false }).count(), 0, 'sem aviso de leitura descartada');
      const dados = corpo.data ?? corpo;
      assert.deepEqual((dados.pacotes ?? []).map((p) => p.id), ['POCKET', codigoLivre]);
      assert.deepEqual([...new Set(dados.regrasPacotes[codigoLivre].map((r) => r.dia))], [6], 'só sábado');
      await seletor.selectOption(codigoLivre);
      assert.equal(await seletor.inputValue(), codigoLivre);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(relatorios, 'disponibilidade-pacote-livre.png'), fullPage: true });
      await contexto.close();
      resultados.push(`Novo pacote pela tela: código ${codigoLivre.slice(0, 6)}…; Disponibilidade lista "Festinha do Buffet UI" e "Festa Jardim UI", regras só de sábado`);
      console.log('E2E_DISPONIBILIDADE_PACOTE_LIVRE_OK');

      // Cotação pública /b/<código>: o cartão do pacote novo aparece, sem nada do catálogo Kidmais. Entrada como a do botão
      // "Continuar para escolher o pacote" da Disponibilidade (sábado, primeiro período), que leva ao wizard com a data.
      const hoje = new Date();
      const sabado = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() + 45));
      while (sabado.getUTCDay() !== 6) sabado.setUTCDate(sabado.getUTCDate() + 1);
      const dataFesta = sabado.toISOString().slice(0, 10);
      const horario = { horarioBase: 'almoco', ajusteHorario: '0', horarioInicio: turno1.inicio.slice(0, 5), horarioFim: turno1.fim.slice(0, 5) };
      const publico = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      publico.setDefaultTimeout(90000);
      const pagina = await publico.newPage();
      const daDisponibilidade = new URLSearchParams({ origem: 'DISPONIBILIDADE', data: dataFesta, periodo: 'almoco', codigoPeriodo: 'TURNO_1',
        configuracaoId: turno1.id, inicio: horario.horarioInicio, fim: horario.horarioFim, ajuste: '0' });
      await pagina.goto(`${base}/b/${codigoCom}/fechamento?${daDisponibilidade}`);
      await pagina.getByText('Festa Jardim UI', { exact: true }).first().waitFor({ timeout: 30000 }).catch(async (erro) => {
        await pagina.screenshot({ path: path.join(relatorios, 'cotacao-publica-falha.png'), fullPage: true });
        const api = await pagina.request.get(`${base}/api/fechamentos/pacotes?empresa=${codigoCom}`);
        const corpo = (await pagina.locator('body').innerText()).slice(0, 300).replace(/\s+/g, ' ');
        throw Error(`${erro.message.split('\n')[0]} | página: ${corpo} | API ${api.status()}: ${(await api.text()).slice(0, 300)}`);
      });
      const textoPublico = await pagina.locator('body').innerText();
      assert.ok(textoPublico.includes('Festinha do Buffet UI'));
      for (const nome of ['Kidmais Pocket', 'Mini Festa Kidmais', 'Pizza Party Scienza', 'Festa Compacta']) assert.ok(!textoPublico.includes(nome), nome);
      await pagina.getByText('Festa Jardim UI', { exact: true }).first().click();
      await pagina.waitForTimeout(500);
      await pagina.screenshot({ path: path.join(relatorios, 'cotacao-publica-pacote-livre.png'), fullPage: true });

      // Cotação e envio do fechamento pelo HTTP real do servidor local, com o código do pacote novo (antes: recusados).
      const cotacao = await pagina.request.post(`${base}/api/fechamentos/cotacao?empresa=${codigoCom}`, { data: { pacote: codigoLivre, dataFesta, ...horario, convidados: 40 } });
      assert.equal(cotacao.status(), 200, await cotacao.text());
      assert.equal(Number((await cotacao.json()).data.valor), 4500);
      const naDona = await pagina.request.post(`${base}/api/fechamentos/cotacao`, { data: { pacote: codigoLivre, dataFesta, ...horario, convidados: 40 } });
      assert.equal(naDona.status(), 400, 'endereço atual (dona): só os sete');
      const cpf = cpfValido();
      const envio = await pagina.request.post(`${base}/api/fechamentos?empresa=${codigoCom}`, { data: {
        identidadeTipo: 'NOVO_CLIENTE', dataFesta, ...horario, statusDisponibilidade: 'disponivel', pacote: codigoLivre, convidadosPagantes: 40,
        buffetDefinicao: 'depois', adicionaisSelecionados: [], valorCombinado: '4500,00', formaPagamento: 'pix_avista',
        nomeCliente: 'Cliente Sintético E2E', cpf, email: `e2e.livre.${cpf}@example.invalid`, whatsapp: '61999990000', cep: '70000000',
        logradouro: 'Rua Sintética', numero: '1', bairro: 'Centro', cidade: 'Brasília', uf: 'DF', nomeAniversariante: 'Aniversariante E2E', idadeAniversariante: 6,
      } });
      assert.equal(envio.status(), 201, await envio.text());
      const fechamentoId = (await envio.json()).fechamentoId;
      const gravado = (await client.query('SELECT p.codigo, p.empresa_id FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id WHERE f.id = $1', [fechamentoId])).rows[0];
      assert.equal(gravado.codigo, codigoLivre);
      assert.equal(gravado.empresa_id, COM);
      await publico.close();
      resultados.push(`Cotação pública /b/${codigoCom}: cartão "Festa Jardim UI" sem nomes Kidmais; cotação 200 (R$ 4.500), envio 201 gravado com o pacote novo; endereço atual recusa (400)`);
      console.log('E2E_COTACAO_PUBLICA_PACOTE_LIVRE_OK');

      // Fase 1c — fechamento ADMINISTRATIVO do buffet comum com o pacote novo: a lista e as regras de disponibilidade vêm
      // da empresa (antes: catálogo da Kidmais e regra fixa do Pocket no calendário); envio pelo wizard real.
      const clienteId = (await client.query('SELECT f.cliente_id FROM fechamentos f WHERE f.id = $1', [fechamentoId])).rows[0].cliente_id;
      const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
      // Sábado (uma semana depois do público) cuja segunda seguinte ainda está no mesmo mês, para conferir os dois no calendário.
      const sabadoAdmin = new Date(sabado); sabadoAdmin.setUTCDate(sabadoAdmin.getUTCDate() + 7);
      while (sabadoAdmin.getUTCDate() > 26) sabadoAdmin.setUTCDate(sabadoAdmin.getUTCDate() + 7);
      const segundaAdmin = new Date(sabadoAdmin); segundaAdmin.setUTCDate(segundaAdmin.getUTCDate() + 2);
      {
        const { contexto, page } = await entrar('gestao-com-ui@exemplo.test');
        await page.goto(`${base}/admin/clientes/${clienteId}/fechamento`);
        const seletor = page.getByLabel('Pacote', { exact: true });
        await page.waitForFunction(() => {
          const s = document.querySelector('select[aria-label="Pacote"]');
          return s && ![...s.options].some((o) => o.textContent.includes('Carregando'));
        });
        assert.deepEqual((await seletor.locator('option').allInnerTexts()).map((t) => t.trim()), ['Festinha do Buffet UI', 'Festa Jardim UI'], 'wizard do painel: pacotes da empresa');
        await seletor.selectOption(codigoLivre);
        const alvo = `${MESES[sabadoAdmin.getUTCMonth()]} de ${sabadoAdmin.getUTCFullYear()}`;
        for (let i = 0; i < 6 && !(await page.getByText(alvo, { exact: true }).count()); i++) await page.getByRole('button', { name: 'Próximo mês' }).click();
        const rotulo = (d) => `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
        const diaSabado = page.locator(`button[aria-label^="${rotulo(sabadoAdmin)}:"]`);
        await page.waitForFunction((r) => { const b = document.querySelector(`button[aria-label^="${r}:"]`); return b && !b.getAttribute('aria-label').includes('não carregada'); }, rotulo(sabadoAdmin));
        assert.match(await diaSabado.getAttribute('aria-label'), /Disponível$/, 'sábado liberado pela regra da empresa');
        assert.equal(segundaAdmin.getUTCMonth(), sabadoAdmin.getUTCMonth());
        assert.match(await page.locator(`button[aria-label^="${rotulo(segundaAdmin)}:"]`).getAttribute('aria-label'), /Indisponível$/, 'segunda fechada (sem regra fixa do Pocket)');
        await diaSabado.click();
        const horarioAdmin = page.getByLabel('Horário disponível', { exact: true });
        await page.waitForFunction(() => (document.querySelector('select[aria-label="Horário disponível"]')?.options.length ?? 0) > 1);
        await horarioAdmin.selectOption({ index: 1 });
        await page.getByLabel('Convidados pagantes', { exact: true }).fill('40');
        await page.getByLabel('Aniversariante', { exact: true }).selectOption({ index: 1 });
        await page.getByLabel('Valor comercial proposto (R$)', { exact: true }).fill('4500,00');
        await page.waitForFunction(() => !document.body.innerText.includes('Selecione data, pacote e co'));
        await page.waitForLoadState('networkidle');
        await page.getByRole('button', { name: 'Revisar contratação', exact: true }).click();
        const criado = page.waitForResponse((r) => r.url().includes(`/api/admin/clientes/${clienteId}/fechamentos`) && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Confirmar e criar fechamento', exact: true }).click();
        const respostaAdmin = await criado;
        assert.equal(respostaAdmin.status(), 201, await respostaAdmin.text());
        await page.getByRole('heading', { name: 'Fechamento criado' }).waitFor();
        await page.screenshot({ path: path.join(relatorios, 'fechamento-admin-pacote-livre.png'), fullPage: true });
        const doAdmin = (await client.query(`SELECT p.codigo, f.empresa_id, f.origem_fechamento FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id
          WHERE f.cliente_id = $1 AND f.id <> $2 ORDER BY f.criado_em DESC LIMIT 1`, [clienteId, fechamentoId])).rows[0];
        assert.equal(doAdmin.codigo, codigoLivre);
        assert.equal(doAdmin.empresa_id, COM);
        await contexto.close();
        resultados.push('Fechamento administrativo (wizard do painel): pacotes da empresa no seletor, calendário pelas regras dela (sábado livre, segunda fechada), criado com o pacote novo');
        console.log('E2E_FECHAMENTO_ADMIN_PACOTE_LIVRE_OK');
      }
    }
    {
      const { contexto, page } = await entrar('gestao-dona-ui@exemplo.test');
      const { opcoes } = await seletorDePacote(page);
      assert.deepEqual(opcoes, ['Kidmais Pocket', 'Mini Festa Kidmais', 'Festa Compacta', 'Festa Essencial', 'Festa Completa', 'Festa Premium', 'Pizza Party Scienza']);
      await page.screenshot({ path: path.join(relatorios, 'dona-da-agenda.png'), fullPage: true });
      await contexto.close();
      resultados.push('Dona da agenda pública: os sete pacotes do catálogo legado, como antes');
      console.log('E2E_DISPONIBILIDADE_DONA_OK');
    }
    fs.writeFileSync(path.join(relatorios, 'resultados.txt'), `${resultados.join('\n')}\n`);
    console.log(`E2E_DISPONIBILIDADE_PACOTES_OK (${resultados.length} roteiros)`);
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
