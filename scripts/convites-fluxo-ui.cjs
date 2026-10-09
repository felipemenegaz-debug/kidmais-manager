/* eslint-disable @typescript-eslint/no-require-imports */
// Integração das telas com um contrato HTTP simulado e schemas reais.
// Sem banco/credenciais/IA/mensagens. Não comprova integração com PostgreSQL.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), sharp = require('sharp');
const { comandoSchema, respostaSchema, inicioConteudo } = require('../lib/convites/domain.ts');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
(async () => {
  const foto = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#97b8cb' } }).png().toBuffer();
  const contexto = { empresas: [{ id: id(2), nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Teste' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
  const dados = { conteudo: { ...inicioConteudo({}), nome: 'Alice', idade: '5 anos', data: '2099-12-20', horario: '15:00', local: 'Buffet Teste', endereco: 'Rua fictícia, 10' }, revisao: 1, publicado: false, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: false, disponiveis: 0, iaDisponivel: false, cotas: { festa: 3, festaUsado: 0, cliente: 3, clienteUsado: 0 }, artes: [], familias: [], respostas: [], historico: [] };
  let acesso = null, publicado = null;
  const respostas = new Map(), comandos = [], erros = [], urls = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  async function sessao(admin = false) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    ctx.on('page', p => p.on('pageerror', e => erros.push(e.message)));
    await ctx.route('**/*', async route => {
      const r = route.request(), u = new URL(r.url()); urls.push(u.href);
      if (u.origin !== new URL(base).origin && !['data:', 'blob:'].includes(u.protocol)) return route.abort();
      if (!u.pathname.startsWith('/api/')) return route.continue();
      const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, erro: data }) });
      try {
        if (u.pathname === '/api/admin/autenticacao') return json(admin ? 200 : 401, admin ? { usuarioId: id(3), sessaoId: id(4), csrf: 'teste', nome: 'Teste', contexto, comercial: null } : 'Sem sessão.');
        if (u.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return json(200, { logoDataUrl: null });
        if (['/api/admin/convites', '/api/convites/cliente'].includes(u.pathname)) {
          const buffet = u.pathname === '/api/admin/convites';
          if (buffet ? !admin : !acesso || r.headers().authorization !== `Bearer ${acesso}`) return json(404, 'Acesso ao convite indisponível.');
          if (r.method() === 'GET') return json(200, dados);
          const parsed = comandoSchema.safeParse(r.postDataJSON());
          if (!parsed.success) return json(400, 'Confira os campos do convite.');
          const b = parsed.data; comandos.push(b.acao);
          assert.notEqual(b.acao, 'gerar', 'Fluxo gratuito não pode chamar IA');
          if (b.acao === 'acesso') {
            assert(buffet); acesso = b.habilitado ? crypto.randomBytes(32).toString('base64url') : null; dados.clienteHabilitado = !!acesso;
            return json(200, { linkCliente: acesso ? `/convites/criar#${acesso}` : null });
          }
          if (b.acao === 'upload') {
            dados.artes.push({ id: id(10), origem: 'UPLOAD', url: `data:image/png;base64,${foto.toString('base64')}` });
            return json(200, { arteId: id(10) });
          }
          assert(['salvar', 'publicar', 'despublicar'].includes(b.acao));
          if (b.revisao !== dados.revisao) return json(409, 'O convite foi alterado por outra pessoa. Recarregue antes de salvar.');
          dados.revisao++;
          if (b.acao === 'despublicar') publicado = null;
          else { dados.conteudo = structuredClone(b.conteudo); if (b.acao === 'publicar') publicado = structuredClone(b.conteudo); }
          dados.publicado = !!publicado; return json(200, { salvo: true });
        }
        if (u.pathname === `/api/convites/publico/${'p'.repeat(43)}`) {
          if (!publicado) return json(404, 'Convite indisponível. Solicite o link atualizado ao organizador.');
          if (u.searchParams.has('arte')) return route.fulfill({ contentType: 'image/png', body: foto });
          if (r.method() === 'POST') {
            const b = respostaSchema.parse(r.postDataJSON());
            respostas.set(b.chave, { nome: b.nome, presenca: b.presenca, adultos: b.presenca ? b.adultos : 0, criancas: b.presenca ? b.criancas : 0 });
            dados.respostas = [...respostas.values()]; return json(200, { confirmado: true });
          }
          return json(200, { conteudo: publicado, familia: null });
        }
        throw Error(`API inesperada: ${u.pathname}`);
      } catch (e) { erros.push(e.message); return json(500, 'Falha no simulador de teste.'); }
    });
    return ctx;
  }
  try {
    const buffetCtx = await sessao(true), clienteCtx = await sessao(), convidadoCtx = await sessao();
    const buffet = await buffetCtx.newPage(), cliente = await clienteCtx.newPage(), convidado = await convidadoCtx.newPage();
    await buffet.goto(`${base}/admin/festas/${id(1)}/convite`);
    await buffet.getByText('Acesso do cliente e limites', { exact: false }).click();
    await buffet.getByRole('button', { name: 'Gerar novo link do cliente', exact: true }).click();
    const campoLink = buffet.getByRole('textbox', { name: 'Link exclusivo de edição', exact: false }); await campoLink.waitFor();
    const link = await campoLink.inputValue(); assert(link.startsWith(`${base}/convites/criar#`));
    await cliente.goto(link); await cliente.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    await cliente.getByRole('button', { name: 'Com foto', exact: true }).click();
    await cliente.getByRole('button', { name: /^Foto com aquarela/ }).click();
    await cliente.locator('input[type="file"]').setInputFiles({ name: 'foto-sintetica.png', mimeType: 'image/png', buffer: foto });
    await cliente.getByRole('button', { name: 'Remover imagem do convite', exact: true }).waitFor();
    await cliente.getByLabel('Nome do aniversariante', { exact: true }).fill('Alice Sofia');
    await cliente.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    await cliente.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
    await convidado.goto(`${base}${dados.linkPublico}`); await convidado.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
    await cliente.getByRole('button', { name: 'Publicar convite', exact: true }).click();
    await cliente.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
    await convidado.reload(); await convidado.getByRole('heading', { name: 'Confirme sua presença' }).waitFor();
    assert((await convidado.getByRole('article').textContent()).includes('Alice Sofia'));
    assert.equal(await convidado.getByRole('article').locator('svg image').count(), 1);
    await convidado.getByLabel('Seu nome', { exact: true }).fill('Família Teste');
    await convidado.getByLabel('Adultos', { exact: true }).fill('2');
    await convidado.getByLabel('Crianças', { exact: true }).fill('1');
    await convidado.getByRole('button', { name: 'Enviar resposta', exact: true }).click();
    await convidado.getByRole('status').filter({ hasText: 'Resposta salva' }).waitFor();
    await buffet.getByRole('button', { name: 'Atualizar confirmações', exact: true }).click();
    await buffet.getByRole('region', { name: 'Confirmações de presença' }).getByText('Família Teste', { exact: true }).waitFor();
    // Uma revisão carregada antes da edição do cliente não pode sobrescrever sua publicação.
    await buffet.getByLabel('Nome do aniversariante', { exact: true }).fill('Edição antiga do buffet');
    await buffet.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    await buffet.getByRole('alert').filter({ hasText: 'alterado por outra pessoa' }).waitFor();
    assert.equal(dados.conteudo.nome, 'Alice Sofia');
    await buffet.reload(); await buffet.getByLabel('Nome do aniversariante', { exact: true }).waitFor();
    await buffet.getByLabel('Nome do aniversariante', { exact: true }).fill('Alice atualizada');
    await buffet.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    await buffet.getByRole('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
    await convidado.reload(); await convidado.getByRole('article').waitFor();
    assert((await convidado.getByRole('article').textContent()).includes('Alice Sofia'), 'Rascunho não muda publicação');
    await convidado.getByLabel('Seu nome', { exact: true }).fill('Família Teste');
    await convidado.getByLabel(/^Sua resposta/).selectOption('nao');
    await convidado.getByRole('button', { name: 'Enviar resposta', exact: true }).click();
    await convidado.getByRole('status').filter({ hasText: 'Resposta salva' }).waitFor();
    assert.equal(respostas.size, 1); assert.equal(dados.respostas[0].adultos, 0);
    await buffet.getByRole('button', { name: 'Publicar convite', exact: true }).click();
    await buffet.getByRole('status').filter({ hasText: 'Convite publicado' }).waitFor();
    await buffet.getByText('Acesso do cliente e limites', { exact: false }).click();
    await buffet.getByRole('button', { name: 'Revogar acesso', exact: true }).click();
    await buffet.getByRole('status').filter({ hasText: 'Acesso revogado' }).waitFor();
    await cliente.reload(); await cliente.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
    await convidado.reload(); await convidado.getByRole('article').waitFor();
    assert((await convidado.getByRole('article').textContent()).includes('Alice atualizada'), 'Revogar editor não revoga convidados');
    await buffet.getByRole('button', { name: 'Despublicar', exact: true }).click();
    await buffet.getByRole('status').filter({ hasText: 'Convite despublicado' }).waitFor();
    await convidado.reload(); await convidado.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
    assert.equal(dados.cotas.festaUsado, 0); assert(!comandos.includes('gerar'));
    assert(!urls.some(url => url.includes(new URL(link).hash.slice(1))), 'Credencial de edição não vai na URL HTTP');
    assert.deepEqual(erros, []);
    console.log('PASS fluxo: buffet → link do cliente → foto → rascunho → publicação → RSVP → painel → conflito de edição → atualização → revogação → despublicação. APIs simuladas, sem PostgreSQL ou IA paga.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
