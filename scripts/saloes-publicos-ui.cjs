/* eslint-disable @typescript-eslint/no-require-imports */
/** E2E opt-in da S-D ("Conheça os salões" e salão de preferência) no fluxo público /b/<código>, com PostgreSQL DESCARTÁVEL
 * e dados sintéticos (modelo 106: o staging com a 106). Restaura SOMENTE o banco sintético do runner. Nenhum .env, banco
 * real, e-mail, provedor ou serviço Render. Execute com os três KIDMAIS_* do descartável, KIDMAIS_PLAYWRIGHT_MODULE e Chrome.
 *
 * Buffet A: três salões PRONTOS pelos serviços reais da 102 (Pequeno 50, Médio 100, Grande 150; 6 fotos WebP cada,
 * declaração), um horário (15h–19h), pacote "Compacta" só do Médio e "Grande" sem vínculo (serve a todos). Dia A: Grande
 * ocupado. Dia B: tudo livre. Buffet B: um salão pronto só (a etapa não existe). Desktop e celular:
 *   - 80 convidados no dia B → /saloes: Médio recomendado ("indicado para 80 · cabe até 100"), Pequeno recolhido com o
 *     motivo, comparação, fotos servidas; escolhe o Grande → /fechamento com salao=; chip; Compacta "não serve no
 *     Grande" (ver mesmo assim) e não conclui; Grande conclui;
 *   - dia A: uma só opção (Médio) já selecionada;
 *   - link com salao= do Grande no dia A (ocupado) → volta à escolha com aviso;
 *   - buffet B: segue direto ao /fechamento (sem a etapa).
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const receita = require('./regressao-v1-postgres-receita.cjs');

const PORTA_WEB = 3163;
const MODELO = '106';

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
  for (const nome of ['.env', '.env.local', '.env.development', '.env.development.local']) if (fs.existsSync(nome)) throw Error('E2E_RECUSA_ARQUIVO_ENV');
  await new Promise((resolve, reject) => {
    const prova = require('node:net').createServer();
    prova.once('error', () => reject(Error('E2E_PORTA_WEB_OCUPADA')));
    prova.listen(PORTA_WEB, '127.0.0.1', () => prova.close(resolve));
  });
  const playwright = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || 'playwright');
  const sharp = require('sharp');
  const { carregarModulo } = await import('../lib/acessos/teste-carregador.ts');
  const { porta, admin } = await receita.conectarAdmin(process.env);
  let client, servidor, browser;
  const relatorios = path.resolve(process.env.KIDMAIS_SALOES_UI_RELATORIOS || '.local-saloes-ui');
  fs.mkdirSync(relatorios, { recursive: true });
  const logfile = fs.openSync(path.join(relatorios, 'next.log'), 'a');
  const resultados = [];
  try {
    const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [receita.MODELOS[MODELO].banco])).rows.length > 0;
    if (!existe) await receita.construirModelo(admin, porta, MODELO);
    await receita.restaurar(admin, receita.TRABALHO[0], MODELO);
    client = await receita.conectar(porta, receita.TRABALHO[0]);
    const um = async (sql, v = []) => (await client.query(sql, v)).rows[0];
    const servicos = carregarModulo('lib/agenda/salao-apresentacao.ts', { 'db/postgres': { db: () => client, withTransaction: async (w) => w(client) } }, new Map());
    const { normalizarWebp } = carregarModulo('lib/imagens/normalizar-webp.ts', {}, new Map());
    const transacao = async (fn) => { await client.query('BEGIN'); try { const r = await fn(); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK'); throw e; } };

    async function buffet(nome) {
      const empresa = await um(`INSERT INTO empresas(codigo,nome,status) VALUES($1,$2,'PROVISIONAMENTO') RETURNING id, codigo`, [`sd-${randomBytes(3).toString('hex')}`, nome]);
      await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [empresa.id]);
      const usuario = (await um(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,'Gestão SD UI',$2,'ADMINISTRATIVO') RETURNING id`,
        [`gestao-sd-${randomBytes(3).toString('hex')}@exemplo.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).id;
      const m = (await um(`INSERT INTO memberships(empresa_id,usuario_id,status,vigente_desde,papel) VALUES($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresa.id, usuario])).id;
      await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
      await client.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [empresa.id]);
      await client.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'E2E sintético S-D',$3)", [empresa.id, cnpjSintetico(), usuario]);
      await client.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                          VALUES ($1, 'FIXO', 'POR_SALAO', NULL, 0, $2)`, [empresa.id, usuario]);
      const tarde = (await um(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
          ordem_exibicao, empresa_id, capacidade) VALUES ('TARDE_SD_UI', 'Tarde', '15:00', '19:00', 0, 30, 1, $1, 1) RETURNING id::text AS id`, [empresa.id])).id;
      for (let d = 1; d <= 7; d++) {
        await client.query(`INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio) VALUES ($1, $2, 'PADRAO', '2020-01-01')`, [d, tarde]);
      }
      const ctx = { empresaId: empresa.id, usuarioId: usuario, requestId: require('node:crypto').randomUUID() };
      return { empresa, usuario, tarde, ctx };
    }
    async function salaoPronto(b, nome, capacidade, ordem) {
      const s = (await um(`INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1, $2, $3, $4) RETURNING id`, [b.empresa.id, nome, capacidade, ordem])).id;
      const v0 = (await um(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [s])).v;
      const campos = { convidadosMinimo: null, convidadosSentados: Math.round(capacidade * 0.6), areaM2: capacidade, idadeMin: 2, idadeMax: 10,
        frase: `${nome}: espaço amplo e iluminado`, outraFestaSimultanea: true, exclusivos: ['ENTRADA', 'BRINQUEDOS'], fotosReferencia: '2026-09' };
      let r = await transacao(() => servicos.salvarApresentacao(client, b.ctx, s, v0, campos, [
        { grupo: 'BRINCADEIRAS', proprio: 'Pula-pula gigante', destaque: true },
        { grupo: 'CONFORTO', proprio: `Climatização ${nome}`, destaque: true },
      ]));
      for (let i = 0; i < 6; i++) {
        const cor = { r: (i * 40 + capacidade) % 255, g: (i * 70) % 255, b: (capacidade * 3) % 255 };
        const img = await normalizarWebp(await sharp({ create: { width: 640, height: 480, channels: 3, background: cor } }).png().toBuffer());
        r = await transacao(() => servicos.adicionarFoto(client, b.ctx, s, r.conteudoVersao, img, `${nome} — ambiente ${i + 1}`));
      }
      await transacao(() => servicos.confirmarDeclaracao(client, b.ctx, s, r.conteudoVersao));
      return s;
    }
    async function pacote(b, codigo, nome, min, max, saloes) {
      const p = (await um(`INSERT INTO pacotes(empresa_id,codigo,nome,descricao,duracao_minutos,convidados_minimos,convidados_maximos,ordem_exibicao,ativo,vigente)
          VALUES($1,$2,$3,'Pacote sintético da S-D',240,$4,$5,(SELECT COALESCE(MAX(ordem_exibicao),0)+1 FROM pacotes),true,true) RETURNING id`, [b.empresa.id, codigo, nome, min, max])).id;
      for (const s of saloes) await client.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1, $2)`, [p, s]);
      return p;
    }
    async function precos(b, pacotes) {
      const tabela = (await um(`INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela SD UI', '2020-01-01', false, $2) RETURNING id`,
        [`tsd-${randomBytes(3).toString('hex')}`, b.empresa.id])).id;
      for (const [p, valor, min, max] of pacotes) {
        await client.query(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario) VALUES ($1, $2, $3, $4, 'FIXO', $5, 'PADRAO')`, [tabela, p, min, max, valor]);
        const escopo = (await um(`INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua) VALUES ($1, $2, 'PADRAO', true) RETURNING id`, [tabela, p])).id;
        await client.query(`INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1, $2, $3)`, [escopo, min, max]);
        for (let d = 1; d <= 7; d++) await client.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio) VALUES ($1, $2, $3, 'DISPONIVEL', '2020-01-01')`, [p, d, b.tarde]);
      }
      await client.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1`, [tabela]);
    }

    const A = await buffet('Buffet Três Salões UI');
    const pequeno = await salaoPronto(A, 'Pequeno', 50, 1);
    const medio = await salaoPronto(A, 'Médio', 100, 2);
    const grande = await salaoPronto(A, 'Grande', 150, 3);
    const compacta = await pacote(A, 'SD_COMPACTA', 'Festa Compacta UI', 20, 100, [medio]);
    const ampla = await pacote(A, 'SD_GRANDE', 'Festa Grande UI', 30, 150, []);
    await precos(A, [[compacta, 1500, 20, 100], [ampla, 3000, 30, 150]]);
    const B = await buffet('Buffet Um Salão UI');
    await salaoPronto(B, 'Único', 120, 1);
    const unico = await pacote(B, 'SD_UNICO', 'Festa Única UI', 20, 120, []);
    await precos(B, [[unico, 2000, 20, 120]]);

    const hoje = new Date();
    const diaA = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 12);
    const diaB = new Date(diaA.getFullYear(), diaA.getMonth(), diaA.getDate() + 1);
    const [DA, DB] = [isoLocal(diaA), isoLocal(diaB)];
    await client.query('BEGIN');
    const ocupacao = (await um(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 100, 100, 3000, 3000, 3000,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id`,
      [DA, A.tarde, A.empresa.id, ampla, grande])).id;
    await client.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1`, [ocupacao]);
    await client.query('COMMIT');

    const env = { ...process.env, DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${receita.TRABALHO[0]}`,
      DATABASE_SSL: 'false', ADMIN_AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_AUTH_ORIGIN: base,
      COTACAO_PUBLICA_POR_EMPRESA: 'true', SALOES_PUBLICOS: 'true', EMAIL_PROVIDER: 'desativado', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
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
    const mesesAte = (d) => (d.getFullYear() - hoje.getFullYear()) * 12 + d.getMonth() - hoje.getMonth();
    const pagina = async (viewport) => {
      const contexto = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      contexto.setDefaultTimeout(90000);
      const page = await contexto.newPage();
      // Diagnóstico: falhas e respostas das fotos públicas vão para o relatório.
      page.on('requestfailed', (r) => { if (r.url().includes('/fotos/')) fs.appendFileSync(path.join(relatorios, 'fotos.log'), `FALHOU ${r.failure()?.errorText} ${r.url()}
`); });
      page.on('response', (r) => { if (r.url().includes('/fotos/')) fs.appendFileSync(path.join(relatorios, 'fotos.log'), `${r.status()} ${r.url()}
`); });
      page.on('console', (m) => { if (m.type() === 'error') fs.appendFileSync(path.join(relatorios, 'fotos.log'), `CONSOLE ${m.text()}
`); });
      return { contexto, page };
    };
    const semRolagemLateral = async (page, onde) => {
      const [sw, iw] = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
      assert.ok(sw <= iw + 1, `${onde}: rolagem lateral (${sw} > ${iw})`);
    };
    const botaoDia = (page, d) => page.locator('button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${d.getDate()}$`) }) }).first();

    /** Disponibilidade com 80 convidados até o "Continuar" no dia indicado. */
    async function ateContinuar(page, codigo, d) {
      await page.goto(`${base}/b/${codigo}/disponibilidade`);
      await page.getByRole('button', { name: '80', exact: true }).click();
      await page.getByText('80 convidados pagantes', { exact: true }).waitFor();
      for (let i = 0; i < mesesAte(d); i++) await page.getByRole('button', { name: 'Próximo mês' }).click();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      await botaoDia(page, d).click();
      await page.getByRole('button', { name: /Tarde/ }).click();
      await page.getByRole('button', { name: /15:00–19:00.*Escolher/ }).click();
      await page.getByRole('button', { name: /Continuar para escolher o pacote/ }).click();
    }

    for (const [nome, viewport] of [['desktop', { width: 1440, height: 1000 }], ['celular', { width: 375, height: 812 }]]) {
      const { contexto, page } = await pagina(viewport);
      // Dia B: Médio recomendado, Grande escolhível, Pequeno recolhido.
      await ateContinuar(page, A.empresa.codigo, diaB);
      await page.waitForURL(/\/saloes\?/);
      await page.getByRole('heading', { name: 'Conheça os salões' }).waitFor();
      await page.getByText('Recomendado · indicado para 80 · cabe até 100', { exact: true }).waitFor();
      await page.getByText('1 salão não serve para a sua festa').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Continuar com', exact: false }).count(), 0, 'duas opções: nada pré-selecionado');
      // A rota da foto compila no primeiro uso (dev): espera a imagem carregar de fato.
      await page.waitForFunction(() => { const i = document.querySelector('article img'); return Boolean(i && i.complete && i.naturalWidth > 0); }, null, { timeout: 60000 });
      await page.screenshot({ path: path.join(relatorios, `${nome}-1-saloes.png`), fullPage: true });
      await semRolagemLateral(page, `${nome} salões`);
      await page.getByRole('article', { name: 'Grande' }).getByRole('button', { name: 'Escolher este salão' }).click();
      await page.getByRole('button', { name: 'Continuar com Grande →' }).click();
      await page.waitForURL(/\/fechamento\?/);
      assert.equal(new URL(page.url()).searchParams.get('salao'), grande);
      await page.getByText('Grande', { exact: true }).first().waitFor();
      await page.getByText(/Salão de preferência:/).first().waitFor();
      await page.getByText('1 pacote não serve no Grande para 80 convidados.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Ver mesmo assim', exact: true }).click();
      await page.getByText('Não é oferecido no Grande.', { exact: true }).waitFor();
      await page.getByText('Festa Compacta UI', { exact: true }).click();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText(/Não é oferecido no Grande\. Escolha um pacote deste salão ou troque o salão\./).waitFor();
      await page.getByText('Festa Grande UI', { exact: true }).click();
      await page.getByRole('button', { name: /^Continuar/ }).click();
      await page.getByText('Preferências do buffet', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(relatorios, `${nome}-2-assistente.png`), fullPage: true });
      await semRolagemLateral(page, `${nome} assistente`);
      resultados.push(`${nome}: dia B → /saloes com Médio recomendado (motivo), Pequeno recolhido, foto servida; Grande escolhido → salao= na URL, chip, "não serve no Grande" + ver mesmo assim, Compacta não conclui, Grande conclui`);

      // Dia A: só o Médio serve → já selecionado.
      await ateContinuar(page, A.empresa.codigo, diaA);
      await page.waitForURL(/\/saloes\?/);
      await page.getByRole('button', { name: 'Continuar com Médio →' }).waitFor();
      await page.getByText('Já reservado neste horário.', { exact: false }).waitFor({ state: 'attached' });
      await page.screenshot({ path: path.join(relatorios, `${nome}-3-uma-opcao.png`), fullPage: true });
      resultados.push(`${nome}: dia A → uma só opção (Médio) já selecionada; Grande "Já reservado neste horário."`);

      // Link antigo com salao= do Grande no dia A (ocupado) → volta à escolha com aviso.
      const p = new URLSearchParams({ origem: 'DISPONIBILIDADE', data: DA, codigoPeriodo: 'TARDE_SD_UI', configuracaoId: A.tarde, inicio: '15:00', fim: '19:00', ajuste: '0', convidados: '80', salao: grande });
      await page.goto(`${base}/b/${A.empresa.codigo}/fechamento?${p}`);
      await page.waitForURL(/\/saloes\?/);
      await page.getByText('O salão escolhido não está mais disponível para a sua festa. Escolha outro salão.', { exact: true }).waitFor();
      resultados.push(`${nome}: salão de preferência que deixou de servir → volta à escolha com aviso`);

      // Buffet B (um salão pronto): sem a etapa, direto ao fechamento.
      await ateContinuar(page, B.empresa.codigo, diaB);
      await page.waitForURL(/\/fechamento\?/);
      assert.equal(new URL(page.url()).searchParams.get('salao'), null);
      resultados.push(`${nome}: buffet com um salão pronto → direto ao /fechamento (sem a etapa)`);

      // Revisão P2-1: a etapa some (404) com um salão já escolhido → nada segue sozinho; o cliente decide.
      const q = new URLSearchParams({ data: DB, codigoPeriodo: 'TARDE_SD_UI', configuracaoId: B.tarde, inicio: '15:00', fim: '19:00', ajuste: '0', convidados: '80', salao: grande });
      await page.goto(`${base}/b/${B.empresa.codigo}/saloes?${q}`);
      await page.getByText('A escolha de salão não está mais disponível para esta data. O salão que você escolheu não será enviado.', { exact: true }).waitFor();
      assert.match(page.url(), /\/saloes\?/, 'continua na tela, sem redirecionar sozinho');
      await page.getByRole('link', { name: 'Voltar e escolher outra data' }).waitFor();
      await page.screenshot({ path: path.join(relatorios, `${nome}-4-sem-etapa-com-salao.png`), fullPage: true });
      await page.getByRole('button', { name: 'Continuar sem salão de preferência' }).click();
      await page.waitForURL(/\/fechamento\?/);
      assert.equal(new URL(page.url()).searchParams.get('salao'), null, 'segue sem a preferência por decisão do cliente');
      resultados.push(`${nome}: etapa fora do ar com salão escolhido → aviso + "Voltar e escolher outra data" / "Continuar sem salão de preferência" (sem redirecionar sozinho)`);
      await contexto.close();
    }
    fs.writeFileSync(path.join(relatorios, 'resultados.json'), JSON.stringify({ diaA: DA, diaB: DB, saloes: { pequeno, medio, grande }, resultados }, null, 2));
    for (const r of resultados) console.log(`OK ${r}`);
    console.log('E2E_SALOES_PUBLICOS_OK');
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
