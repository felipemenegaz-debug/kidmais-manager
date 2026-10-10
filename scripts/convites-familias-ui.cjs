/* eslint-disable @typescript-eslint/no-require-imports */
// Navegador real, APIs simuladas. Sem banco, mensagens, dados reais ou IA paga.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3058';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = path.resolve('.local-convites-qa'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const admin of [true, false]) {
      const familias = [], tokens = new Map(), respostas = new Map(), erros = [], requisicoes = [];
      const conteudo = { tema: 'jardim', nome: 'Alice', idade: '5 anos', mensagem: 'Vamos comemorar!', data: '2099-12-20', horario: '16:00', local: 'Jardim das Festas', endereco: 'Rua das Flores, 120', arteId: null, confirmarPresenca: true };
      const dados = { conteudo, revisao: 1, publicado: true, desatualizado: false, linkPublico: `/convite/${'p'.repeat(43)}`, clienteHabilitado: true, disponiveis: 0, iaDisponivel: false, cotas: { festa: 3, festaUsado: 0, cliente: 3, clienteUsado: 0 }, artes: [], respostas: [], familias, convidadosContratados: 50, historico: [] };
      const contexto = { empresas: [{ id: id(2), nome: 'Buffet Demonstração', papel: 'REPRESENTANTE_AUTORIZADO' }], empresaAtual: { id: id(2), nome: 'Buffet Demonstração' }, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false };
      const novoLink = f => { const token = crypto.randomBytes(32).toString('base64url'); tokens.set(f.id, token); f.linkAtivo = true; return `${dados.linkPublico}#familia=${token}`; };
      function atualizar() {
        dados.respostas = [...respostas.entries()].filter(([id]) => familias.find(f => f.id === id)?.ativa).map(([, r]) => r);
        for (const f of familias) { const r = respostas.get(f.id); f.presenca = r?.presenca ?? null; f.adultosConfirmados = r?.adultos ?? null; f.criancasConfirmadas = r?.criancas ?? null; }
      }
      async function criarContexto() {
        const ctx = await browser.newContext({ viewport: { width: 1365, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
        await ctx.route('**/api/**', async route => {
          const r = route.request(), u = new URL(r.url()); requisicoes.push(u.href); let data, status = 200;
          if (u.pathname === '/api/admin/autenticacao') data = { usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-sintetico', nome: 'Equipe de teste', contexto, comercial: null };
          else if (u.pathname === '/api/admin/configuracoes/perfil-empresa/logo') data = { logoDataUrl: null };
          else if (['/api/admin/convites', '/api/convites/cliente'].includes(u.pathname)) {
            if (r.method() === 'POST') {
              const b = r.postDataJSON(); assert(b.acao.startsWith('familia_'), 'Não deve salvar o convite ao cadastrar família');
              let f = familias.find(f => f.id === b.id);
              if (b.acao === 'familia_adicionar') { assert(!f); f = { id: b.id, nome: b.nome, adultos: b.adultos, criancas: b.criancas, revisao: 1, ativa: true }; familias.push(f); data = { id: f.id, revisao: 1, linkFamilia: novoLink(f) }; }
              else {
                assert.equal(b.revisao, f.revisao); f.revisao++;
                if (b.acao === 'familia_editar') { f.nome = b.nome; f.adultos = b.adultos; f.criancas = b.criancas; }
                if (b.acao === 'familia_status') { f.ativa = b.ativa; f.linkAtivo = false; tokens.delete(f.id); }
                if (b.acao === 'familia_link') { f.linkAtivo = b.habilitado; if (!b.habilitado) tokens.delete(f.id); }
                data = { id: f.id, revisao: f.revisao, ...(b.acao === 'familia_link' && b.habilitado ? { linkFamilia: novoLink(f) } : {}) };
              }
              atualizar();
            } else { atualizar(); data = dados; }
          } else if (u.pathname === `/api/convites/publico/${'p'.repeat(43)}`) {
            const auth = r.headers().authorization;
            const f = auth == null ? null : familias.find(f => f.ativa && f.linkAtivo && `Bearer ${tokens.get(f.id)}` === auth);
            if (auth != null && !f) status = 404;
            else if (r.method() === 'POST') {
              assert(f); const b = r.postDataJSON(); respostas.set(f.id, { nome: f.nome, presenca: b.presenca, adultos: b.presenca ? b.adultos : 0, criancas: b.presenca ? b.criancas : 0 }); atualizar(); data = { confirmado: true };
            } else { const resp = f && respostas.get(f.id); data = { conteudo, familia: f ? { nome: f.nome, presenca: resp?.presenca ?? null, adultos: resp?.adultos ?? f.adultos, criancas: resp?.criancas ?? f.criancas } : null }; }
          } else { erros.push(`API inesperada: ${u.pathname}`); return route.abort(); }
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, erro: 'Link da família indisponível. Solicite um novo ao organizador.' }) });
        });
        ctx.on('page', p => p.on('pageerror', e => erros.push(e.message))); return ctx;
      }
      const editorCtx = await criarContexto(), page = await editorCtx.newPage();
      await page.goto(admin ? `${base}/admin/festas/${id(1)}/convite` : `${base}/convites/criar#${'a'.repeat(43)}`);
      const painel = page.getByRole('region', { name: 'Famílias e links individuais', exact: true });
      await painel.waitFor();
      await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Edição não salva');
      await painel.getByLabel('Nome da família', { exact: true }).fill('Família Souza');
      await painel.getByLabel('Crianças previstas', { exact: true }).fill('1');
      await painel.getByRole('button', { name: 'Adicionar família', exact: true }).click();
      const card = painel.getByRole('listitem', { name: 'Família: Família Souza', exact: true });
      await card.getByLabel('Link individual').waitFor();
      const link = await card.getByLabel('Link individual').inputValue(); assert(link.includes('#familia='));
      assert.equal(await page.getByLabel('Nome do aniversariante', { exact: true }).inputValue(), 'Edição não salva');
      await card.getByRole('button', { name: 'Copiar link da família', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
      const convidadoCtx = await criarContexto(), convidado = await convidadoCtx.newPage();
      await convidado.goto(link); await convidado.getByLabel('Seu nome', { exact: true }).waitFor();
      assert.equal(await convidado.getByLabel('Seu nome', { exact: true }).inputValue(), 'Família Souza');
      assert.equal(await convidado.getByLabel('Seu nome', { exact: true }).getAttribute('readonly'), '');
      await convidado.getByRole('link', { name: 'Confirmar presença ↓', exact: true }).click(); assert.equal(convidado.url(), link, 'Âncora preserva o token ao recarregar');
      await convidado.reload(); await convidado.getByLabel('Seu nome', { exact: true }).waitFor();
      assert.deepEqual(await convidado.evaluate(() => Object.keys(localStorage)), [], 'Link individual não persiste credencial em storage');
      await convidado.getByLabel('Adultos', { exact: true }).fill('3');
      await convidado.getByRole('button', { name: 'Enviar resposta', exact: true }).click(); await convidado.getByRole('status').filter({ hasText: 'Resposta salva!' }).waitFor();
      await page.getByRole('button', { name: 'Atualizar confirmações', exact: true }).click(); await card.getByText('Presença confirmada', { exact: false }).waitFor();
      assert.equal(await page.getByLabel('Nome do aniversariante', { exact: true }).inputValue(), 'Edição não salva');
      const outroCtx = await criarContexto(), outro = await outroCtx.newPage();
      await outro.goto(link); await outro.getByLabel('Seu nome', { exact: true }).waitFor();
      assert.equal(await outro.getByLabel('Adultos', { exact: true }).inputValue(), '3');
      await outro.getByLabel(/^Sua resposta/).selectOption('nao');
      await outro.getByRole('button', { name: 'Enviar resposta', exact: true }).click(); await outro.getByRole('status').filter({ hasText: 'Resposta salva!' }).waitFor(); assert.equal(respostas.size, 1);
      await page.getByRole('button', { name: 'Atualizar confirmações', exact: true }).click(); await card.getByText('Não vai ·', { exact: false }).waitFor();
      await painel.getByLabel('Buscar família cadastrada', { exact: true }).fill('souza'); assert.equal(await painel.getByRole('listitem').count(), 1);
      await painel.getByLabel('Buscar família cadastrada', { exact: true }).fill('');
      await painel.getByRole('button', { name: 'Pendentes', exact: true }).click(); assert.equal(await painel.getByRole('listitem').count(), 0);
      await painel.getByRole('button', { name: 'Ativas', exact: true }).click();
      await card.getByRole('button', { name: 'Renovar link', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' }); const renovado = await card.getByLabel('Link individual').inputValue(); assert.notEqual(renovado, link);
      await outro.reload(); await outro.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
      await convidado.goto(renovado); await convidado.getByLabel(/^Sua resposta/).waitFor(); assert.equal(await convidado.getByLabel(/^Sua resposta/).inputValue(), 'nao');
      await card.getByRole('button', { name: 'Revogar link', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await convidado.reload(); await convidado.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
      await card.getByRole('button', { name: 'Arquivar família', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(dados.respostas.length, 0);
      await painel.getByRole('button', { name: 'Arquivadas', exact: true }).click(); await card.getByRole('button', { name: 'Restaurar família', exact: true }).click();
      await painel.getByRole('status').filter({ hasText: 'restaurada' }).waitFor(); await painel.getByRole('button', { name: 'Ativas', exact: true }).click(); assert.equal(dados.respostas.length, 1);
      await card.getByRole('button', { name: 'Editar família', exact: true }).click(); await painel.getByLabel('Nome da família', { exact: true }).fill('Família Souza Silva'); await painel.getByRole('button', { name: 'Salvar família', exact: true }).click();
      await painel.getByRole('listitem', { name: 'Família: Família Souza Silva', exact: true }).waitFor(); assert.equal(respostas.size, 1); assert.equal(dados.revisao, 1);
      for (const width of [320, 390, 1365]) { await page.setViewportSize({ width, height: 1000 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await painel.screenshot({ path: path.join(out, `familias-${admin ? 'buffet' : 'cliente'}-${width}.png`) }); }
      await outro.goto(`${base}${dados.linkPublico}#familia=`); await outro.getByRole('alert').filter({ hasText: 'indisponível' }).waitFor();
      await outro.goto(`${base}${dados.linkPublico}`); await outro.getByLabel('Seu nome', { exact: true }).waitFor(); assert.equal(await outro.getByLabel('Seu nome', { exact: true }).inputValue(), '');
      assert(!requisicoes.some(r => r.includes('#familia=') || r.includes('familia=')), 'Token não vai na URL da API'); assert.deepEqual(erros, []);
      await Promise.all([editorCtx.close(), convidadoCtx.close(), outroCtx.close()]);
    }
    console.log(JSON.stringify({ ok: true, cenarios: ['buffet e cliente', 'cadastro sem salvar edição local', 'copiar link', 'resposta única entre dispositivos', 'prefill', 'âncora preserva acesso', 'tokens fora de URL de API e storage', 'filtros', 'renovação e revogação', 'arquivo e restauração', 'revisão do convite preservada', '320/390/1365px', 'link vazio falha fechado', 'link geral preservado'], escopo: 'APIs simuladas; não valida PostgreSQL nem concorrência real' }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
