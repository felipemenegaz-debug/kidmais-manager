/* eslint-disable @typescript-eslint/no-require-imports */
// Geração sem resultado (084): somente servidor local e APIs simuladas; nenhuma geração real é enviada.
// Cobre conexão perdida durante o envio, recarga com pedido em andamento, "verificando" para buffet e cliente,
// geração não iniciada e a fila do operador (vitrine /preview-ux/geracoes-convites, com KIDMAIS_PREVIEW_UX=1).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa/geracao-pendente'); fs.mkdirSync(out, { recursive: true });
const dataUrl = (b, tipo) => `data:${tipo};base64,${b.toString('base64')}`;
const VERIFICANDO = 'Estamos verificando sua geração. Você não precisa tentar novamente.';
const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };

(async () => {
  const miniatura = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#8fb3a6' } }).webp().toBuffer();
  const completa = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#3b2f6b' } }).webp({ quality: 92 }).toBuffer();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const resumo = [];
  // Servidor simulado por cenário: a situação da geração avança a cada consulta leve (?geracao=).
  async function abrir({ admin, modo, incerta = false, viewport = { width: 1440, height: 1100 } }) {
    const dados = { id: id(1), conteudo: { tema: 'celebrar', nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília', arteId: null, confirmarPresenca: true },
      revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: false, convidadosContratados: 40, familias: [],
      disponiveis: 3, iaDisponivel: true, completoDisponivel: true, geracaoIncerta: incerta, geracaoEmAndamento: null,
      cotas: admin ? { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0, empresa: 60, empresaUsado: 0 } : { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 },
      artes: [{ id: id(100), origem: 'UPLOAD', completo: false, url: dataUrl(miniatura, 'image/webp') }], respostas: [], historico: [] };
    const estado = { posts: [], consultas: [], geracoes: new Map(), erros: [], naoIniciadaUsada: false };
    const context = await browser.newContext({ viewport });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (data, status = 200, ok = true) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(ok ? { ok, data } : { ok, erro: data }) });
      if (url.pathname === '/api/admin/autenticacao') return json({ usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-teste', nome: 'Teste', contexto, comercial: null });
      if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return json({ logoDataUrl: null });
      if (!['/api/admin/convites', '/api/convites/cliente'].includes(url.pathname)) { estado.erros.push(`API inesperada: ${url.pathname}`); return route.abort(); }
      if (request.method() === 'GET') {
        const chave = url.searchParams.get('geracao');
        if (!chave) return json({ ...dados, geracaoEmAndamento: [...estado.geracoes].find(([, g]) => g.estado === 'EM_ANDAMENTO')?.[0] ?? null });
        estado.consultas.push(chave);
        const g = estado.geracoes.get(chave);
        if (!g) return json('Geração não encontrada neste convite.', 404, false);
        if (g.estado === 'EM_ANDAMENTO' && ++g.consultas >= 2) {
          g.estado = 'CONCLUIDA'; dados.disponiveis--;
          dados.artes = [{ id: id(50), origem: 'IA', completo: true, url: dataUrl(completa, 'image/webp') }, ...dados.artes];
        }
        return json({ chave, estado: g.estado, arteId: g.estado === 'CONCLUIDA' ? id(50) : null, completo: true });
      }
      const b = request.postDataJSON(); assert(['salvar', 'gerar'].includes(b.acao), `Ação inesperada: ${b.acao}`);
      if (b.acao === 'salvar') { dados.conteudo = b.conteudo; dados.revisao++; return json({ salvo: true }); }
      estado.posts.push(b);
      if (modo === 'chaveUsada' && !estado.naoIniciadaUsada) { estado.naoIniciadaUsada = true; return json('Chave de geração já utilizada.', 409, false); }
      if (modo === 'naoIniciada' && !estado.naoIniciadaUsada) { estado.naoIniciadaUsada = true; return json('Não foi possível iniciar a geração. Nenhum crédito foi usado; tente novamente em instantes.', 503, false); }
      if (modo === 'verificando') { dados.geracaoIncerta = true; return json({ chave: b.chave, estado: 'VERIFICANDO', mensagem: VERIFICANDO }); }
      if (modo === 'queda') {
        // O servidor recebeu e segue gerando; a conexão do navegador cai antes da resposta.
        if (!estado.geracoes.has(b.chave)) estado.geracoes.set(b.chave, { estado: 'EM_ANDAMENTO', consultas: 0 });
        return route.abort('connectionreset');
      }
      dados.disponiveis--; dados.artes = [{ id: id(51), origem: 'IA', completo: true, url: dataUrl(completa, 'image/webp') }, ...dados.artes];
      return json({ chave: b.chave, estado: 'CONCLUIDA', arteId: id(51), completo: true });
    });
    const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
    await page.goto(admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
    await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    return { page, context, estado, dados };
  }
  const gerarBotao = page => page.getByRole('button', { name: /^(Gerar convite completo · 1 crédito|Processando…)$/ });
  const pedirArte = async page => { await page.getByRole('textbox', { name: 'Descreva a arte do convite' }).fill('Festa na fazenda, verde e amarelo, com um cavalo'); };
  try {
    // 1. Conexão perdida durante o envio (buffet): acompanha o MESMO pedido e recebe a arte, sem segundo envio.
    {
      const { page, context, estado } = await abrir({ admin: true, modo: 'queda' });
      await pedirArte(page);
      await gerarBotao(page).dblclick();
      await page.getByText('Gerando sua arte. Você pode aguardar nesta tela; não é preciso clicar de novo.').first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Gerar convite completo · 1 crédito' }).isDisabled(), true, 'botão bloqueado enquanto acompanha');
      await page.screenshot({ path: path.join(out, '01-buffet-gerando-apos-conexao-perdida.png'), fullPage: false });
      await page.getByRole('status').filter({ hasText: 'Arte pronta' }).waitFor({ timeout: 20000 });
      await page.getByRole('article', { name: 'Prévia do convite' }).getByRole('img', { name: 'Arte escolhida para o convite' }).waitFor();
      await page.screenshot({ path: path.join(out, '02-buffet-arte-entregue-sem-reenvio.png'), fullPage: false });
      assert.equal(estado.posts.length, 1, 'clique duplo + conexão perdida = um único pedido');
      assert.ok(estado.consultas.length >= 2 && estado.consultas.every(c => c === estado.posts[0].chave), 'acompanha a mesma chave');
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'conexao-perdida', posts: estado.posts.length, consultas: estado.consultas.length });
      await context.close();
    }
    // 2. Recarga com pedido em andamento (cliente): a aba retoma a mesma chave e entrega a arte.
    {
      const { page, context, estado } = await abrir({ admin: false, modo: 'queda' });
      await pedirArte(page);
      await gerarBotao(page).click();
      await page.getByText('Gerando sua arte').first().waitFor();
      const chave = estado.posts[0].chave;
      await page.reload();
      await page.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
      await page.getByText('Gerando sua arte').first().waitFor();
      await page.screenshot({ path: path.join(out, '03-cliente-retomada-apos-recarga.png'), fullPage: false });
      await page.getByRole('status').filter({ hasText: 'Arte pronta' }).waitFor({ timeout: 20000 });
      assert.equal(estado.posts.length, 1, 'recarga não reenvia');
      assert.ok(estado.consultas.every(c => c === chave));
      assert.deepEqual(estado.erros, []);
      resumo.push({ cenario: 'recarga', posts: estado.posts.length, consultas: estado.consultas.length });
      await context.close();
    }
    // 3. Geração em verificação: mensagem simples, sem revisão técnica, botão bloqueado — buffet e cliente (celular).
    for (const [admin, viewport, arquivo] of [[true, { width: 1440, height: 1100 }, '04-buffet-verificando.png'], [false, { width: 390, height: 844 }, '05-cliente-verificando-celular.png']]) {
      const { page, context, estado } = await abrir({ admin, modo: 'normal', incerta: true, viewport });
      await page.getByText(VERIFICANDO).first().waitFor();
      for (const proibido of ['Revisar geração sem resultado', 'Cobrança confirmada', 'Sem cobrança', 'Fonte e evidência', 'provedor'])
        assert.equal(await page.getByText(proibido).count(), 0, proibido);
      assert.equal(await page.getByRole('button', { name: 'Gerar convite completo · 1 crédito' }).isDisabled(), true);
      await page.getByText(VERIFICANDO).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, arquivo), fullPage: false });
      if (!admin) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sem rolagem horizontal a 390 px');
      assert.equal(estado.posts.length, 0); assert.deepEqual(estado.erros, []);
      await context.close();
    }
    // 4. Resposta "verificando" ao gerar: mesma mensagem, nada de erro técnico.
    {
      const { page, context, estado } = await abrir({ admin: true, modo: 'verificando' });
      await pedirArte(page); await gerarBotao(page).click();
      await page.getByRole('status').filter({ hasText: VERIFICANDO }).waitFor();
      await page.screenshot({ path: path.join(out, '06-buffet-resposta-verificando.png'), fullPage: false });
      assert.equal(estado.posts.length, 1); assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0, 'nenhum erro na tela'); // o anunciador de rotas do Next é um alert vazio
      await context.close();
    }
    // 5. Geração não iniciada (falha antes do envio): avisa que nenhum crédito foi usado; nova tentativa usa nova chave.
    {
      const { page, context, estado } = await abrir({ admin: true, modo: 'naoIniciada' });
      await pedirArte(page); await gerarBotao(page).click();
      await page.getByRole('alert').filter({ hasText: 'Nenhum crédito foi usado' }).waitFor();
      await page.screenshot({ path: path.join(out, '07-buffet-nao-iniciada.png'), fullPage: false });
      await gerarBotao(page).click();
      await page.getByRole('status').filter({ hasText: 'Convite pronto' }).waitFor();
      assert.equal(estado.posts.length, 2); assert.notEqual(estado.posts[0].chave, estado.posts[1].chave);
      await context.close();
    }
    // 5b. Chave recusada pelo servidor (409): a próxima tentativa usa outra chave em vez de repetir a recusada.
    {
      const { page, context, estado } = await abrir({ admin: false, modo: 'chaveUsada' });
      await pedirArte(page); await gerarBotao(page).click();
      await page.getByRole('alert').filter({ hasText: 'Chave de geração já utilizada' }).waitFor();
      await gerarBotao(page).click();
      await page.getByRole('status').filter({ hasText: 'Convite pronto' }).waitFor();
      assert.equal(estado.posts.length, 2); assert.notEqual(estado.posts[0].chave, estado.posts[1].chave);
      await context.close();
    }
    // 6. Fila do operador (vitrine): evidência, classe, decisão com evidência; buffet não vê nada disso.
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const posts = [];
      let fila = {
        pendentes: [
          { id: id(201), criadoEm: '2026-10-17T13:57:19Z', enviadoEm: null, recebidoEm: null, origem: 'BUFFET', classe: 'SEM_CLASSE', diagnostico: null,
            evidencia: { diagnostico: 'http_400_moderation_blocked', requestId: 'req_sintetico_antigo', etapa: 'input', categorias: ['sexual'] }, modelo: 'gpt-image-2.5-sunburst', reservaMicrousd: '300000', imagemRetida: false,
            festaId: id(301), empresaId: id(2), empresaNome: 'Buffet Teste' },
          { id: id(202), criadoEm: '2026-10-18T14:00:00Z', enviadoEm: '2026-10-18T14:00:01Z', recebidoEm: null, origem: 'CLIENTE', classe: 'DESCONHECIDA', diagnostico: 'rede_ou_timeout',
            evidencia: {}, modelo: 'gpt-image-2.5-sunburst', reservaMicrousd: '300000', imagemRetida: false, festaId: id(302), empresaId: id(2), empresaNome: 'Buffet Teste' },
          { id: id(206), criadoEm: '2026-10-18T14:10:00Z', enviadoEm: '2026-10-18T14:10:01Z', recebidoEm: '2026-10-18T14:10:40Z', origem: 'BUFFET', classe: 'ARMAZENAMENTO', diagnostico: 'resposta_imagem_invalida',
            evidencia: {}, modelo: 'gpt-image-2.5-sunburst', reservaMicrousd: '300000', imagemRetida: true, festaId: id(303), empresaId: id(2), empresaNome: 'Buffet Teste' },
        ],
        automaticas: [{ id: id(203), estado: 'NAO_ENVIADA', criadoEm: '2026-10-18T13:00:00Z', classe: 'PRE_ENVIO', diagnostico: 'interrompida_antes_do_envio', empresaNome: 'Buffet Teste' },
          { id: id(204), estado: 'CONCLUIDA', criadoEm: '2026-10-18T12:00:00Z', classe: null, diagnostico: null, empresaNome: 'Buffet Teste' }],
        decisoes: [{ id: id(205), resultado: 'COBRANCA_CONFIRMADA', em: '2026-10-16T18:00:00Z', evidencia: 'Uso no painel da OpenAI no minuto da geração (sintético).', resolvedor: 'Operador sintético', empresaNome: 'Buffet Teste', criadoEm: '2026-10-16T17:00:00Z', classe: 'DESCONHECIDA' }],
        limites: ['A Images API não aceita chave de idempotência, não tem consulta de status e não permite recuperar uma imagem depois.',
          'O x-request-id e o X-Client-Request-Id (enviamos a chave da geração) servem só para o suporte da OpenAI localizar o pedido.',
          'Uso e custos da organização são agregados (uso por minuto, custo por dia); não há cobrança por requisição.',
          'moderation_blocked, timeout ou ausência de dados no painel não comprovam, sozinhos, que não houve cobrança.'],
      };
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
        if (url.pathname === '/api/admin/autenticacao') return json({ usuarioId: id(9), sessaoId: id(10), csrf: 'csrf-teste', nome: 'Operador', contexto: { ...contexto, empresas: [], empresaAtual: null, desenvolvedor: true }, comercial: null });
        if (url.pathname === '/api/desenvolvedor/convites/geracoes') {
          if (request.method() === 'GET') return json(fila);
          const b = request.postDataJSON(); posts.push(b);
          if (b.acao === 'concluir_com_imagem') { fila = { ...fila, pendentes: fila.pendentes.filter(p => p.id !== b.geracaoId) }; return json({ estado: 'CONCLUIDA', liberouReserva: false }); }
          fila = { ...fila, pendentes: fila.pendentes.filter(p => p.id !== b.geracaoId), decisoes: [{ id: b.geracaoId, resultado: b.resultado, em: new Date().toISOString(), evidencia: b.evidencia, resolvedor: 'Operador sintético', empresaNome: 'Buffet Teste', criadoEm: '2026-10-18T14:00:00Z', classe: 'DESCONHECIDA' }, ...fila.decisoes] };
          return json({ estado: 'RESOLVIDA_SEM_COBRANCA', liberouReserva: true });
        }
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${base}/preview-ux/geracoes-convites`);
      await page.getByRole('heading', { name: 'Em verificação (3)' }).waitFor();
      await page.screenshot({ path: path.join(out, '08-operador-fila.png'), fullPage: true });
      const item = page.getByRole('article', { name: `Geração ${id(202)}` });
      await item.getByRole('button', { name: 'Registrar decisão' }).click();
      const confirmar = item.getByRole('button', { name: 'Confirmar decisão' });
      assert.equal(await confirmar.isDisabled(), true, 'exige resultado e evidência');
      await item.getByLabel(/Sem cobrança comprovada/).check();
      await item.getByLabel(/Fonte e evidência/).fill('Painel de uso da OpenAI sem requisição no minuto da geração; suporte confirmou pelo X-Client-Request-Id (sintético).');
      await item.screenshot({ path: path.join(out, '09-operador-decisao.png') });
      await confirmar.click();
      await page.getByRole('status').filter({ hasText: 'reservas originais foram devolvidas' }).waitFor();
      await page.getByRole('heading', { name: 'Em verificação (2)' }).waitFor();
      await page.screenshot({ path: path.join(out, '10-operador-apos-decisao.png'), fullPage: true });
      assert.equal(posts.length, 1); assert.deepEqual(posts[0], { acao: 'decidir', geracaoId: id(202), resultado: 'SEM_COBRANCA', evidencia: posts[0].evidencia });
      // Imagem recebida e retida: o operador entrega a arte sem nova chamada.
      const retida = page.getByRole('article', { name: `Geração ${id(206)}` });
      assert.equal(await page.getByRole('article', { name: `Geração ${id(201)}` }).getByRole('button', { name: 'Concluir com a imagem recebida' }).count(), 0);
      await retida.screenshot({ path: path.join(out, '11-operador-imagem-retida.png') });
      await retida.getByRole('button', { name: 'Concluir com a imagem recebida' }).click();
      await page.getByRole('status').filter({ hasText: 'sem nova chamada' }).waitFor();
      await page.getByRole('heading', { name: 'Em verificação (1)' }).waitFor();
      assert.deepEqual(posts[1], { acao: 'concluir_com_imagem', geracaoId: id(206) });
      resumo.push({ cenario: 'operador', operacoes: posts.length });
      await context.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'resumo.json'), JSON.stringify(resumo, null, 2));
  console.log(JSON.stringify({ ok: true, resumo, capturas: fs.readdirSync(out).filter(f => f.endsWith('.png')) }));
})().catch(e => { console.error(e); process.exitCode = 1; });
