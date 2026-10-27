/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da S-C (convidados primeiro) no fluxo público /b/<código>, com PostgreSQL DESCARTÁVEL e dados sintéticos
 * (modelo 103, o estado do staging). Restaura SOMENTE o banco sintético do runner. Nenhum .env, banco real, e-mail,
 * provedor ou serviço Render. Execute com os três KIDMAIS_* de autorização do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 * Buffet com dois salões (Pequeno 50, Grande 120), um horário (15h–19h) e dois pacotes (Compacta 20–100, Grande 30–150).
 * Dia A: Grande ocupado. Dia B: os dois livres. Desktop e celular:
 *   - convidados antes do calendário; dia "sem salão para 80"; datas próximas; "Só 1 opção de salão"; convidados=80 na URL;
 *   - assistente sem a etapa Convidados (7 etapas), chip, "não comporta" + "Ver mesmo assim";
 *   - Valor: troca para 130 recusada (bloqueia), recuperação com 90; cotação lenta (espera) e com erro (bloqueia);
 *   - corridas (respostas invertidas nos dois sentidos) e Continuar pendente + troca incompatível;
 *   - link antigo (sem convidados): etapa Convidados presente (8 etapas).
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3161;
const MODELO = '103';

function cnpjSintetico() {
  let d = Array.from(randomBytes(8), (n) => n % 10).join('') + '0001';
  for (const pesos of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const resto = [...d].reduce((soma, n, i) => soma + Number(n) * pesos[i], 0) % 11;
    d += resto < 2 ? '0' : String(11 - resto);
  }
  assert.notEqual(d, '20119900000160');
  return d;
}

const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve(process.env.KIDMAIS_CONVIDADOS_UI_RELATORIOS || '.local-convidados-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [receita.MODELOS[MODELO].banco])).rows.length > 0;
    if (!existe) await receita.construirModelo(admin, porta, MODELO);
    await receita.restaurar(admin, receita.TRABALHO[0], MODELO);
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    const um = async (sql, v = []) => (await client.query(sql, v)).rows[0];

    // Buffet sintético com acesso COMPLETO (isenção), dois salões, um horário, dois pacotes com preço publicado.
    const empresa = (await um(`INSERT INTO empresas(codigo,nome,status) VALUES($1,'Buffet Dois Salões UI','PROVISIONAMENTO') RETURNING id, codigo`, [`sc-${randomBytes(3).toString('hex')}`]));
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresa.id]);
    const usuario = (await um(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Gestão SC UI',$2,'ADMINISTRATIVO') RETURNING id`,
      [`gestao-sc-${randomBytes(3).toString('hex')}@exemplo.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).id;
    const m = (await um(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresa.id, usuario])).id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
    await client.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [empresa.id]);
    await client.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'E2E sintético S-C',$3)", [empresa.id, cnpjSintetico(), usuario]);
    await client.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                        VALUES ($1, 'FIXO', 'POR_SALAO', NULL, 0, $2)`, [empresa.id, usuario]);
    const pequeno = (await um(`INSERT INTO agenda_saloes (empresa_id, nome, ordem, capacidade_convidados) VALUES ($1, 'Salão Pequeno UI', 1, 50) RETURNING id`, [empresa.id])).id;
    const grande = (await um(`INSERT INTO agenda_saloes (empresa_id, nome, ordem, capacidade_convidados) VALUES ($1, 'Salão Grande UI', 2, 120) RETURNING id`, [empresa.id])).id;
    const tarde = (await um(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
        ordem_exibicao, empresa_id, capacidade) VALUES ('TARDE_SC_UI', 'Tarde', '15:00', '19:00', 0, 30, 1, $1, 1) RETURNING id::text AS id`, [empresa.id])).id;
    const pacote = async (codigo, nome, min, max) => (await um(`INSERT INTO pacotes(empresa_id,codigo,nome,descricao,duracao_minutos,convidados_minimos,convidados_maximos,ordem_exibicao,ativo,vigente)
        VALUES($1,$2,$3,'Pacote sintético da S-C',240,$4,$5,(SELECT COALESCE(MAX(ordem_exibicao),0)+1 FROM pacotes),true,true) RETURNING id`, [empresa.id, codigo, nome, min, max])).id;
    const compacta = await pacote('SC_COMPACTA', 'Festa Compacta UI', 20, 100);
    const maior = await pacote('SC_GRANDE', 'Festa Grande UI', 30, 150);
    const tabela = (await um(`INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela SC UI', '2020-01-01', false, $2) RETURNING id`,
      [`tsc-${randomBytes(3).toString('hex')}`, empresa.id])).id;
    // Faixa de preço dentro dos limites do pacote (047 recusa faixa fora do mínimo/máximo).
    for (const [p, valor, min, max] of [[compacta, 1500, 20, 100], [maior, 3000, 30, 150]]) {
      await client.query(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario) VALUES ($1, $2, $3, $4, 'FIXO', $5, 'PADRAO')`, [tabela, p, min, max, valor]);
      const escopo = (await um(`INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua) VALUES ($1, $2, 'PADRAO', true) RETURNING id`, [tabela, p])).id;
      await client.query(`INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1, $2, $3)`, [escopo, min, max]);
      for (let dia = 1; dia <= 7; dia++) {
        await client.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio) VALUES ($1, $2, $3, 'DISPONIVEL', '2020-01-01')`, [p, dia, tarde]);
      }
    }
    await client.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1`, [tabela]);
    for (let dia = 1; dia <= 7; dia++) {
      await client.query(`INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio) VALUES ($1, $2, 'PADRAO', '2020-01-01')`, [dia, tarde]);
    }
    // Dia A: o Grande ocupado por uma festa confirmada. Dia B (seguinte): os dois livres.
    const hoje = new Date();
    const diaA = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 12);
    const diaB = new Date(diaA.getFullYear(), diaA.getMonth(), diaA.getDate() + 1);
    const [A, B] = [isoLocal(diaA), isoLocal(diaB)];
    await client.query('BEGIN');
    const ocupacao = (await um(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 100, 100, 3000, 3000, 3000,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id`,
      [A, tarde, empresa.id, maior, grande])).id;
    await client.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1`, [ocupacao]);
    await client.query('COMMIT');

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      COTACAO_PUBLICA_POR_EMPRESA: 'true', EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const k of ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'EMAIL_ARQUIVO_DIR', 'OPENAI_API_KEY', 'CONVITES_OPENAI_API_KEY', 'CONVITES_GEMINI_API_KEY', 'GUPSHUP_API_KEY', 'AI_PROVIDER_PRIMARY', 'AI_PROVIDER_ECONOMY', 'KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME',
      'RECUPERACAO_SENHA_ATIVA', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'AGENDA_PUBLICA_EMPRESA_ID']) delete env[k];
    servidor = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTA_WEB)],
      { cwd: process.cwd(), env, stdio: ['ignore', logfile, logfile], windowsHide: true });
    for (let n = 0; n < 240; n++) {
      if (servidor.exitCode !== null) throw Error('SERVIDOR_LOCAL_ENCERROU');
      if (await fetch(`${base}/api/admin/autenticacao`).then(r => r.status < 500).catch(() => false)) break;
      if (n === 239) throw Error('SERVIDOR_LOCAL_NAO_INICIOU');
      await new Promise(r => setTimeout(r, 500));
    }
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.KIDMAIS_PLAYWRIGHT_CHANNEL || 'chrome' });
    const raiz = `${base}/b/${empresa.codigo}`;
    const mesesAte = (d) => (d.getFullYear() - hoje.getFullYear()) * 12 + d.getMonth() - hoje.getMonth();

    async function pagina(viewport) {
      const contexto = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      contexto.setDefaultTimeout(90000);
      return { contexto, page: await contexto.newPage() };
    }
    const semRolagemLateral = async (page, onde) => {
      const largura = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
      assert.ok(largura[0] <= largura[1] + 1, `${onde}: rolagem lateral (${largura[0]} > ${largura[1]})`);
    };
    const botaoDia = (page, d) => page.locator('button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${d.getDate()}$`) }) }).first();
    const etapa = (page) => page.locator('text=/Etapa \\d+ de \\d+/').first().innerText();
    const titulo = (page) => page.locator('h2').first().innerText();

    /** Da disponibilidade até o assistente com 80 convidados, no dia B (prova também o dia A). */
    async function ateOAssistente(page, nome, provasDoDiaA) {
      await page.goto(`${raiz}/disponibilidade`);
      await page.getByText('Quantos convidados pagantes?', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Próximo mês' }).count(), 0, 'calendário só depois dos convidados');
      await page.screenshot({ path: path.join(relatorios, `${nome}-1-convidados.png`), fullPage: true });
      await semRolagemLateral(page, `${nome} convidados`);
      await page.getByRole('button', { name: '80', exact: true }).click();
      await page.getByText('80 convidados pagantes', { exact: true }).waitFor();
      for (let i = 0; i < mesesAte(diaA); i++) await page.getByRole('button', { name: 'Próximo mês' }).click();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      if (provasDoDiaA) {
        const classe = await botaoDia(page, diaA).getAttribute('class');
        assert.match(classe, /dayNoRoom/, 'dia A marcado como sem salão para 80');
        await page.getByText('Sem salão para 80', { exact: true }).waitFor();
        await botaoDia(page, diaA).click();
        await page.getByText('Nenhum salão livre comporta 80 convidados nesta data.', { exact: true }).waitFor();
        await page.getByText('Datas próximas com espaço para 80:', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(relatorios, `${nome}-2-dia-sem-salao.png`), fullPage: true });
        await semRolagemLateral(page, `${nome} sem salão`);
      }
      if (mesesAte(diaB) !== mesesAte(diaA)) await page.getByRole('button', { name: 'Próximo mês' }).click();
      await botaoDia(page, diaB).click();
      await page.getByText('Só 1 opção de salão', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: /Tarde/ }).click();
      await page.getByRole('button', { name: /15:00–19:00.*Escolher/ }).click();
      await page.screenshot({ path: path.join(relatorios, `${nome}-3-horario.png`), fullPage: true });
      await page.getByRole('button', { name: /Continuar para escolher o pacote/ }).click();
      await page.waitForURL(/\/fechamento\?/);
      assert.equal(new URL(page.url()).searchParams.get('convidados'), '80');
      await page.getByText('80 convidados', { exact: true }).waitFor();
      assert.match(await etapa(page), /Etapa 1 de 7/, 'sem a etapa Convidados');
    }

    // ===== Desktop =====
    {
      const { contexto, page } = await pagina({ width: 1440, height: 1000 });
      await ateOAssistente(page, 'desktop', true);
      await page.getByText('Festa Compacta UI', { exact: true }).waitFor();
      assert.equal(await page.getByText(/não comporta/).count(), 0, '80 cabe nos dois pacotes');
      // Chip no Pacote: 110 → a Compacta (até 100) fica atrás do "Ver mesmo assim".
      const alterar = async (n) => {
        await page.getByRole('button', { name: 'alterar', exact: true }).click();
        await page.getByLabel('Quantos convidados pagantes? (crianças e adultos)').fill(String(n));
        await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
      };
      await alterar(110);
      await page.getByText('1 pacote não comporta 110 convidados.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Festa Compacta UI', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Ver mesmo assim', exact: true }).click();
      await page.getByText('Festa Compacta UI atende até 100 convidados neste pacote.', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(relatorios, 'desktop-4-pacotes-110.png'), fullPage: true });
      await alterar(80);
      await page.getByText('80 convidados', { exact: true }).waitFor();
      resultados.push('Desktop: convidados antes do calendário; dia A "sem salão para 80" (tracejado + legenda) com datas próximas; dia B "Só 1 opção de salão"; convidados=80 na URL; assistente com 7 etapas; 110 → "1 pacote não comporta" + "Ver mesmo assim" com o motivo');

      // Continuar pendente + troca incompatível (P2-R3, rodada 3): a Compacta (até 100), revalidação do Continuar retida.
      await page.getByText('Festa Compacta UI', { exact: true }).click();
      let soltar;
      const retida = new Promise((r) => { soltar = r; });
      await page.route('**/api/disponibilidade?*', async (rota) => {
        if (rota.request().url().includes('convidados=80')) { await retida; return rota.continue(); }
        return rota.continue();
      });
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Revalidando horário...', { exact: true }).waitFor();
      await alterar(110);
      await page.getByText(/Escolha outro pacote para 110 convidados/).waitFor();
      soltar();
      await page.waitForTimeout(1500);
      assert.equal(await titulo(page), 'Escolha o pacote', 'o sucesso antigo de 80 não avança com 110 e a Compacta');
      await page.unroute('**/api/disponibilidade?*');
      resultados.push('Corrida 1: Continuar pendente (80) + troca para 110 incompatível com a Compacta → resposta antiga descartada, fica no Pacote');

      // Grande, 80, até o Valor.
      await alterar(80);
      await page.getByText('Festa Grande UI', { exact: true }).click();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Preferências do buffet', { exact: true }).waitFor();
      assert.match(await etapa(page), /Etapa 2 de 7/);
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Quer adicionar algo à festa?', { exact: true }).waitFor();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Confirme o valor combinado', { exact: true }).waitFor();
      await page.getByText('80 convidados', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(relatorios, 'desktop-5-valor.png'), fullPage: true });

      const preencherValor = async () => {
        const usar = page.getByRole('button', { name: /Usar valor calculado/ });
        await usar.waitFor();
        await usar.click();
      };
      // Valor: 130 cabe no pacote (até 150), mas nenhum salão livre comporta 130 → recusa e bloqueio; 90 recupera.
      await alterar(130);
      await page.getByText(/Com 130 convidados, o horário escolhido não está disponível/).first().waitFor();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.waitForTimeout(800);
      assert.equal(await titulo(page), 'Confirme o valor combinado', 'recusado: não avança');
      await page.screenshot({ path: path.join(relatorios, 'desktop-6-valor-recusado.png'), fullPage: true });
      await alterar(90);
      await page.waitForFunction(() => !document.body.innerText.includes('Com 130 convidados, o horário'));
      resultados.push('Valor: 130 (pacote comporta, nenhum salão livre) → recusa e Continuar bloqueado; 90 → recupera');

      // Corrida 2: 130 lento (recusa) chega DEPOIS de 90 aprovado → descartado, sem bloqueio.
      let soltar130;
      const retida130 = new Promise((r) => { soltar130 = r; });
      await page.route('**/api/disponibilidade?*', async (rota) => {
        if (rota.request().url().includes('convidados=130')) { await retida130; return rota.continue(); }
        return rota.continue();
      });
      await alterar(130);
      await alterar(95);
      await page.getByText('95 convidados', { exact: true }).waitFor();
      await page.waitForTimeout(1500);
      soltar130();
      await page.waitForTimeout(2000);
      assert.equal(await page.getByText(/Com 130 convidados, o horário/).count(), 0, 'recusa antiga de 130 descartada');
      await page.unroute('**/api/disponibilidade?*');
      // Corrida 3: 90 lento (aprovado) chega DEPOIS de 130 recusado → a recusa vigente continua.
      let soltar90;
      const retida90 = new Promise((r) => { soltar90 = r; });
      await page.route('**/api/disponibilidade?*', async (rota) => {
        if (rota.request().url().includes('convidados=90')) { await retida90; return rota.continue(); }
        return rota.continue();
      });
      await alterar(90);
      await alterar(130);
      await page.getByText(/Com 130 convidados, o horário escolhido não está disponível/).first().waitFor();
      soltar90();
      await page.waitForTimeout(2000);
      assert.ok(await page.getByText(/Com 130 convidados, o horário/).count() > 0, 'sucesso antigo de 90 não limpa a recusa de 130');
      await page.unroute('**/api/disponibilidade?*');
      resultados.push('Corridas 2 e 3: respostas invertidas nos dois sentidos — vale sempre a troca mais recente');

      // Cotação lenta: espera e avança sozinha; cotação com erro: bloqueia; recupera com a cotação normal.
      await alterar(85);
      await page.waitForFunction(() => !document.body.innerText.includes('Com 130 convidados, o horário'));
      await page.route('**/api/fechamentos/cotacao*', async (rota) => { await new Promise((r) => setTimeout(r, 4000)); return rota.continue(); });
      await alterar(88);
      await page.getByText('Confirmando o horário e o preço para 88 convidados…', { exact: true }).waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes('Confirmando o horário e o preço'), null, { timeout: 30000 });
      await page.unroute('**/api/fechamentos/cotacao*');
      await page.route('**/api/fechamentos/cotacao*', (rota) => rota.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, erro: 'Falha simulada da cotação.', codigo: 'SIMULADO' }) }));
      await alterar(86);
      await page.getByText('Falha simulada da cotação.', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.waitForTimeout(800);
      assert.equal(await titulo(page), 'Confirme o valor combinado', 'cotação com erro: não avança');
      await page.unroute('**/api/fechamentos/cotacao*');
      await alterar(84);
      await page.waitForFunction(() => !document.body.innerText.includes('Falha simulada da cotação.'), null, { timeout: 30000 });
      await preencherValor();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Dados para o fechamento', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(relatorios, 'desktop-7-dados.png'), fullPage: true });
      resultados.push('Cotação lenta: "Confirmando…" e segue sozinha; cotação com erro: bloqueia; recuperação com nova troca e avanço para Dados');

      // Volta: Dados → Valor → Personalização → Buffet → Pacote (pula a etapa Convidados).
      for (const esperado of ['Confirme o valor combinado', 'Quer adicionar algo à festa?', 'Preferências do buffet', 'Escolha o pacote']) {
        await page.getByRole('button', { name: 'Voltar', exact: true }).click();
        await page.getByText(esperado, { exact: true }).waitFor();
      }
      resultados.push('Voltar a partir de Dados percorre Valor → Personalização → Buffet → Pacote, sem a etapa Convidados');
      await contexto.close();
    }

    // ===== Link antigo (sem convidados): a etapa Convidados continua =====
    {
      const { contexto, page } = await pagina({ width: 1440, height: 1000 });
      const p = new URLSearchParams({ origem: 'DISPONIBILIDADE', data: B, codigoPeriodo: 'TARDE_SC_UI', configuracaoId: tarde, inicio: '15:00', fim: '19:00', ajuste: '0' });
      await page.goto(`${raiz}/fechamento?${p}`);
      await page.getByText('Escolha o pacote', { exact: true }).waitFor();
      assert.match(await etapa(page), /Etapa 1 de 8/);
      assert.equal(await page.getByRole('button', { name: 'alterar', exact: true }).count(), 0, 'sem chip');
      await page.getByText('Festa Grande UI', { exact: true }).click();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Quantos convidados pagantes?', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(relatorios, 'link-antigo-convidados.png'), fullPage: true });
      resultados.push('Link antigo (sem convidados): 8 etapas, sem chip, etapa Convidados depois do Pacote');
      await contexto.close();
    }

    // ===== Celular =====
    {
      const { contexto, page } = await pagina({ width: 375, height: 812 });
      await ateOAssistente(page, 'celular', true);
      await semRolagemLateral(page, 'celular assistente');
      await page.screenshot({ path: path.join(relatorios, 'celular-4-assistente.png'), fullPage: true });
      resultados.push('Celular (375×812): mesmo fluxo até o assistente, sem rolagem lateral');
      await contexto.close();
    }
    fs.writeFileSync(path.join(relatorios, 'resultados.json'), JSON.stringify({ base: raiz, diaA: A, diaB: B, salões: { pequeno, grande }, resultados }, null, 2));
    for (const r of resultados) console.log(`OK ${r}`);
    console.log('E2E_CONVIDADOS_PRIMEIRO_OK');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (servidor && servidor.exitCode === null) servidor.kill();
    if (client) await client.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

principal().catch((erro) => {
  console.error(erro instanceof Error ? erro.stack : String(erro));
  process.exit(1);
});
