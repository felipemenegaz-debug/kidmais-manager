/* eslint-disable @typescript-eslint/no-require-imports */
// Editor real no Next local, respostas sintéticas interceptadas no navegador.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { textosAutorizacaoIA } = require('../lib/convites/consentimento-textos.ts');

const base = new URL(process.env.CONVITES_TEST_URL || 'http://127.0.0.1:3059');
assert(['127.0.0.1', 'localhost'].includes(base.hostname) && base.protocol === 'http:');
const saida = process.env.SAIDA || path.resolve('.local-convites-qa', 'tela-simples');
fs.mkdirSync(saida, { recursive: true });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linkPublico = '/convite/' + 'p'.repeat(43);
const linkCliente = '/convites/criar#' + 'a'.repeat(43);
const outroLinkCliente = '/convites/criar#' + 'b'.repeat(43);
const dataExpiracao = '2099-12-31T15:00:00.000Z';
const empresa = { id: id(2), nome: 'Buffet de demonstração', papel: 'REPRESENTANTE_AUTORIZADO' };
const conteudo = {
  tema: 'celebrar', nome: 'Lia', idade: '6 anos', data: '2099-12-20', horario: '16:00',
  local: 'Buffet de demonstração', endereco: 'Rua das Estrelas, 10',
  mensagem: 'Vamos celebrar juntos.', confirmarPresenca: true, arteId: null,
};

async function abrir(browser, largura, { cliente = false, publicado = false, suspenso = false, avulso = false, registradoPor } = {}) {
  const operador = cliente ? 'CLIENTE' : 'BUFFET';
  const autor = registradoPor ?? operador;
  const dados = {
    id: id(1), festaId: avulso ? null : id(5), conteudo: { ...conteudo }, publicado, desatualizado: suspenso,
    revisao: 1, linkPublico, clienteHabilitado: false, editor_expira_em: null,
    disponiveis: 2, iaDisponivel: true, completoDisponivel: true,
    cotas: { festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0, empresa: 10, empresaUsado: 0 },
    artes: [], familias: [], respostas: [], historico: [], logoBuffet: { mostrar: false, logoDataUrl: null },
    autorizacaoIA: {
      ...textosAutorizacaoIA('openai', operador), hashes: { autorizacao: 'a'.repeat(64), imagens: 'b'.repeat(64) },
      precisaRenovar: false, vigente: { id: id(7), operador: autor, vinculo: 'MAE', meio: autor === 'BUFFET' ? 'WHATSAPP' : 'PROPRIO_RESPONSAVEL', registradaEm: '2026-11-18T13:00:00Z' },
    },
  };
  const comandos = [], inesperadas = [], erros = [];
  let publicadoConteudo = { ...conteudo };
  const ctx = await browser.newContext({ viewport: { width: largura, height: largura === 375 ? 812 : 1024 } });
  // A mensagem de WhatsApp é capturada sem navegação externa. Clipboard também fica no contexto sintético.
  await ctx.addInitScript(() => {
    window.open = url => {
      if (url) window.ultimosDestinos = [...(window.ultimosDestinos || []), url];
      return { location: { replace: destino => { window.ultimosDestinos = [...(window.ultimosDestinos || []), destino]; } }, close() {} };
    };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async texto => { window.textoCopiado = texto; } } });
  });
  await ctx.route('**/*', async route => {
    const r = route.request(), u = new URL(r.url());
    if (u.origin !== base.origin) { inesperadas.push(u.origin); return route.abort(); }
    if (!u.pathname.startsWith('/api/')) return route.continue();
    const json = data => route.fulfill({ json: { ok: true, data } });
    if (u.pathname === '/api/endereco-atual') return route.fulfill({ json: { modoEfetivo: 'DESLIGADO' } });
    if (u.pathname === '/api/admin/configuracoes/agenda') return json({ instalada: true, pendentes: [] });
    if (u.pathname === '/api/admin/autenticacao') return json({
      usuarioId: id(3), sessaoId: id(4), csrf: 'csrf-sintetico', nome: 'Equipe de demonstração',
      contexto: { empresas: [empresa], empresaAtual: empresa, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false },
      comercial: null,
    });
    if (u.pathname === '/api/admin/convites/biblioteca' && u.searchParams.has('festas')) return json([]);
    if (u.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return json({ logoDataUrl: null });
    if (u.pathname === '/api/convites/publico/' + 'p'.repeat(43)) return json({ conteudo: publicadoConteudo });
    if (u.pathname === (cliente ? '/api/convites/cliente' : '/api/admin/convites')) {
      if (r.method() === 'GET') return json(dados);
      const cmd = r.postDataJSON();
      comandos.push(cmd);
      if (cmd.acao === 'acesso') {
        const anterior = dados.clienteHabilitado;
        dados.clienteHabilitado = cmd.habilitado;
        dados.editor_expira_em = cmd.habilitado ? dataExpiracao : null;
        return json({ linkCliente: cmd.habilitado ? (anterior ? outroLinkCliente : linkCliente) : null });
      }
      if (cmd.acao === 'despublicar') { dados.publicado = false; return json({ salvo: true }); }
      // Resposta com atraso curto para o progresso da geração ficar visível e conferível.
      if (cmd.acao === 'gerar') { await new Promise(ok => setTimeout(ok, 1200)); return json({ chave: cmd.chave, estado: 'ENCERRADA' }); }
    }
    inesperadas.push(u.pathname);
    return route.fulfill({ status: 501, json: { erro: 'Rota sem simulação' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => erros.push(e.message));
  const url = cliente ? linkCliente : avulso ? `/admin/convites/${id(1)}` : `/admin/festas/${id(5)}/convite`;
  await page.goto(new URL(url, base).href);
  await page.getByRole('button', { name: 'Publicar convite', exact: true }).waitFor();
  const fechar = async () => {
    assert.deepEqual(inesperadas, []);
    assert.deepEqual(erros, []);
    await ctx.close();
  };
  return { page, fechar, comandos, setPublicado: c => { publicadoConteudo = c; } };
}

async function capturar(page, cenario, largura, alvo) {
  if (alvo) await alvo.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  else await page.evaluate(() => window.scrollTo(0, 0));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Sem rolagem horizontal em ' + cenario);
  await page.screenshot({ path: path.join(saida, `${cenario}-${largura}.png`) });
}

async function mensagemWhatsApp(page, botao) {
  const antes = await page.evaluate(() => window.ultimosDestinos?.length || 0);
  await botao.click();
  await page.waitForFunction(n => window.ultimosDestinos?.length === n + 1, antes);
  const url = new URL(await page.evaluate(() => window.ultimosDestinos.at(-1)));
  assert.equal(url.origin, 'https://wa.me');
  return url.searchParams.get('text');
}

const avisoRascunho = 'Publique o convite para liberar o link dos convidados.';
const acoesPublicacao = page => page.getByRole('group', { name: 'Publicação do convite' });

async function conferirDeclaracao(page, operador, registradoPor = operador) {
  const autorizacao = page.getByRole('region', { name: 'Autorização para gerar com IA' });
  await autorizacao.getByText('Detalhes', { exact: true }).click();
  const textos = textosAutorizacaoIA('openai', operador);
  await autorizacao.getByText(textos.aviso, { exact: false }).waitFor();
  const declaracao = autorizacao.getByText(textos.consentimento, { exact: true });
  if (operador === registradoPor) await declaracao.waitFor();
  else {
    const ator = registradoPor === 'BUFFET' ? 'buffet' : 'próprio responsável';
    await autorizacao.getByText('Declaração registrada por ' + ator + '.', { exact: true }).waitFor();
    assert.equal(await declaracao.count(), 0);
  }
}

async function executar(browser, largura) {
  for (const [estado, flags] of [
    ['buffet-rascunho', { registradoPor: 'CLIENTE' }], ['buffet-publicado', { publicado: true }],
    ['buffet-suspenso', { publicado: true, suspenso: true }], ['buffet-avulso', { avulso: true }],
  ]) {
    const { page, fechar, comandos, setPublicado } = await abrir(browser, largura, flags);
    if (estado === 'buffet-rascunho') {
      const resumoLogo = page.locator('[data-logo-buffet] summary');
      const caixaLogo = page.getByRole('checkbox', { name: 'Mostrar a logo do buffet neste convite' });
      // Bloco discreto e recolhido em qualquer largura, no fim da coluna da prévia (depois das ações de publicação).
      await resumoLogo.waitFor();
      assert.match(await resumoLogo.innerText(), /Logo do buffet no convite · oculta/);
      assert.equal(await caixaLogo.isVisible(), false);
      assert.ok(await page.evaluate(() => {
        const bloco = document.querySelector('[data-logo-buffet]'), acoes = document.querySelector('[aria-label="Publicação do convite"]');
        return !!bloco && !!acoes && !!(acoes.compareDocumentPosition(bloco) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), 'o bloco da logo vem depois das ações de publicação');
      await resumoLogo.click();
      await caixaLogo.waitFor();
      assert.equal(await caixaLogo.isDisabled(), true, 'o buffet sintético ainda não tem logo');
      await resumoLogo.click();
      await caixaLogo.waitFor({ state: 'hidden' });
      assert.deepEqual(comandos, [], 'abrir e fechar o bloco não envia um comando');
    }
    const convidados = page.getByRole('region', { name: 'Convite para os convidados' });
    const enviar = convidados.getByRole('button', { name: 'Enviar pelo WhatsApp' });
    const copiar = convidados.getByRole('button', { name: 'Copiar link' });
    const link = convidados.getByRole('link', { name: 'Abrir convite' });
    if (flags.avulso) {
      await page.getByText('Convite avulso · Vincular a uma festa', { exact: true }).click();
      await page.getByText('Com a festa vinculada, o cliente também pode editar.').waitFor();
      await page.getByText('Nenhuma festa encontrada.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Edição pelo cliente', { exact: true }).count(), 0);
    }
    if (flags.publicado && !flags.suspenso) {
      await enviar.waitFor();
      assert.equal(await link.getAttribute('href'), linkPublico);
    } else {
      assert.equal(await enviar.count() + await copiar.count() + await link.count(), 0);
      if (flags.suspenso) await convidados.getByText('O link dos convidados está suspenso.', { exact: false }).waitFor();
      else {
        assert.equal(await convidados.count(), 0);
        await acoesPublicacao(page).getByText(avisoRascunho, { exact: true }).waitFor();
      }
    }
    await capturar(page, estado, largura, estado === 'buffet-rascunho' ? acoesPublicacao(page) : undefined);
    if (flags.publicado && !flags.suspenso) {
      await page.getByLabel('Nome do aniversariante', { exact: true }).fill('Nome ainda no rascunho');
      assert.equal(await mensagemWhatsApp(page, enviar), `Você está convidado para a festa de Lia, dia 20 de dezembro às 16:00. Abra o convite e confirme presença: ${base.origin}${linkPublico}`);
      setPublicado({ ...conteudo, nome: '', data: '', horario: '' });
      assert.equal(await mensagemWhatsApp(page, enviar), `Você está convidado para a festa. Abra o convite e confirme presença: ${base.origin}${linkPublico}`);
      await copiar.click();
      assert.equal(await page.evaluate(() => window.textoCopiado), base.origin + linkPublico);
      // O retorno da ação aparece num aviso fixo, visível sem rolar até o topo, e só some pelo botão Fechar.
      const avisoFixo = page.locator('[data-mensagens-acao]').getByRole('status');
      await avisoFixo.filter({ hasText: 'Link copiado.' }).waitFor();
      assert.ok(await avisoFixo.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'aviso fixo dentro da tela');
      await capturar(page, 'aviso-fixo', largura, copiar);
      await page.locator('[data-mensagens-acao]').getByRole('button', { name: 'Fechar aviso' }).click();
      await page.getByText('Link copiado.', { exact: true }).waitFor({ state: 'hidden' });
      const despublicar = page.getByRole('button', { name: 'Despublicar', exact: true });
      assert.equal(await convidados.getByRole('button', { name: 'Despublicar' }).count(), 0);
      await despublicar.click();
      const dialogo = page.getByRole('dialog', { name: 'Despublicar convite?' });
      await dialogo.getByRole('button', { name: 'Cancelar' }).click();
      await dialogo.waitFor({ state: 'hidden' });
      assert.equal(comandos.length, 0);
      await despublicar.click();
      await dialogo.getByRole('button', { name: 'Despublicar' }).click();
      await acoesPublicacao(page).getByText(avisoRascunho, { exact: true }).waitFor();
      assert.equal(await convidados.count(), 0);
      assert.deepEqual(comandos.map(c => c.acao), ['despublicar']);
    }
    if (estado === 'buffet-rascunho') {
      await page.getByRole('button', { name: 'Criar com IA' }).click();
      await conferirDeclaracao(page, 'BUFFET', 'CLIENTE');
      const edicao = page.getByText('Edição pelo cliente', { exact: true });
      const liberar = page.getByRole('button', { name: 'Liberar edição' });
      assert.equal(await liberar.isVisible(), false);
      await edicao.click();
      await liberar.click();
      await page.getByText('Ativo até 31/12/2099. Só para quem contratou a festa.').waitFor();
      const campo = page.getByRole('textbox', { name: 'Link de edição · só para quem contratou a festa' });
      assert.equal(await campo.inputValue(), base.origin + linkCliente);
      assert.equal(await mensagemWhatsApp(page, page.getByRole('button', { name: 'Enviar ao cliente pelo WhatsApp' })),
        `Este é o link para você montar o convite da festa de Lia. Ele é só seu: não envie aos convidados. ${base.origin}${linkCliente}`);
      await page.getByRole('button', { name: 'Copiar', exact: true }).click();
      assert.equal(await page.evaluate(() => window.textoCopiado), base.origin + linkCliente);
      const criar = page.getByRole('button', { name: 'Criar outro link', exact: true });
      await criar.click();
      const dialogo = page.getByRole('dialog', { name: 'Criar outro link de edição?' });
      await dialogo.getByText(/O link atual para de funcionar/).waitFor();
      await page.keyboard.press('Escape');
      await dialogo.waitFor({ state: 'hidden' });
      assert.equal(comandos.length, 1);
      await criar.click();
      await dialogo.getByRole('button', { name: 'Criar outro link' }).click();
      await page.waitForFunction(link => document.querySelector('input[readonly]')?.value === link, base.origin + outroLinkCliente);
      await page.reload();
      await edicao.click();
      assert.equal(await campo.count(), 0, 'O link desaparece na recarga');
      await page.getByText('Gerenciar acesso', { exact: true }).click();
      await page.getByRole('button', { name: 'Revogar acesso', exact: true }).click();
      await page.getByRole('dialog', { name: 'Revogar acesso do cliente?' }).getByRole('button', { name: 'Revogar acesso' }).click();
      await liberar.waitFor();
      assert.deepEqual(comandos.map(c => [c.acao, c.habilitado]), [['acesso', true], ['acesso', true], ['acesso', false]]);
    }
    await fechar();
  }

  const { page, fechar, comandos } = await abrir(browser, largura, { cliente: true });
  const tutorial = page.getByRole('region', { name: 'Como fazer, em 3 passos' });
  await tutorial.waitFor();
  await capturar(page, 'cliente-tutorial', largura);
  await acoesPublicacao(page).getByText(avisoRascunho, { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Convite para os convidados' }).count(), 0);
  await capturar(page, 'cliente-rascunho', largura, acoesPublicacao(page));
  await tutorial.getByRole('button', { name: 'Fechar' }).click();
  await page.reload();
  const reabrir = page.getByRole('button', { name: 'Como fazer?' });
  await reabrir.waitFor();
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [['convites:tutorial-fechado', '1']]);
  await reabrir.click();
  await tutorial.waitFor();
  await page.getByRole('button', { name: 'Criar com IA' }).click();
  await conferirDeclaracao(page, 'CLIENTE');
  const prompt = page.getByRole('textbox', { name: 'Descreva a arte do convite' });
  const gerar = page.getByRole('button', { name: 'Gerar convite completo · 1 crédito' });
  await page.getByRole('button', { name: 'Espaço', exact: true }).click();
  assert.match(await prompt.inputValue(), /^Aventura no espaço/);
  await page.getByRole('button', { name: 'Safári', exact: true }).click();
  const substituir = page.getByRole('dialog', { name: 'Substituir seu pedido pelo exemplo?' });
  await substituir.getByRole('button', { name: 'Cancelar' }).click();
  await substituir.waitFor({ state: 'hidden' });
  assert.match(await prompt.inputValue(), /^Aventura no espaço/);
  await page.getByRole('button', { name: 'Safári', exact: true }).click();
  await substituir.getByRole('button', { name: 'Usar exemplo' }).click();
  assert.match(await prompt.inputValue(), /^Safári com leãozinho/);

  const pedidoMario = 'Tema do Mario com cogumelos.';
  await prompt.fill(pedidoMario);
  await gerar.click();
  const personagem = page.getByRole('alert').filter({ hasText: 'Mario é um personagem protegido' });
  await personagem.getByRole('button', { name: 'Meu pedido não é sobre Mario' }).waitFor();
  await capturar(page, 'aviso-personagem', largura, personagem);
  await personagem.getByRole('button', { name: 'Editar meu pedido' }).click();
  assert(await prompt.evaluate(el => el === document.activeElement));
  assert.equal(await prompt.inputValue(), pedidoMario);
  // Sugestão de pedido original: um clique preenche o campo, sem gerar e sem custo.
  await gerar.click();
  const sugestao = personagem.locator('[data-sugestao-original]');
  await sugestao.getByText(/^Aventura de videogame retrô em pixel art/).waitFor();
  await personagem.getByRole('button', { name: 'Usar esta sugestão' }).click();
  assert.match(await prompt.inputValue(), /^Aventura de videogame retrô em pixel art/);
  assert.equal(await personagem.count(), 0, 'usar a sugestão fecha o aviso');
  // A sugestão em pixel art já leva o estilo junto: nenhum segundo aviso de estilo.
  await page.locator('[data-estilo-ajustado]').getByText('Estilo ajustado para pixel', { exact: false }).waitFor();
  await capturar(page, 'sugestao-usada', largura, page.locator('[data-estilo-ajustado]'));
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  assert.deepEqual(comandos, [], 'usar a sugestão não gera nem grava');
  await prompt.fill(pedidoMario);
  await gerar.click();
  await personagem.getByRole('button', { name: 'Meu pedido não é sobre Mario' }).waitFor();
  await personagem.getByRole('button', { name: 'Enviar uma imagem minha' }).click();
  await page.getByLabel('Usar uma arte própria').waitFor();
  assert.equal(await page.getByText('Detalhes', { exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Criar com IA' }).click();
  // Estilo do pedido prevalece sobre o padrão: aplicado sem perguntar, com uma linha discreta e "Desfazer".
  const estilo = page.getByRole('button', { name: 'Estilo da arte' });
  const ajustado = page.locator('[data-estilo-ajustado]');
  await prompt.fill('Floresta em aquarela, com animais e balões.');
  await ajustado.getByText('Estilo ajustado para aquarela, como no seu pedido.', { exact: false }).waitFor();
  assert.match(await estilo.innerText(), /O que eu escrevi/);
  await capturar(page, 'estilo-ajustado', largura, ajustado);
  assert.equal(await page.getByText('Sem estilo no pedido, usamos cartoon 3D.').count(), 0, 'sem texto de ajuda contraditório');
  await ajustado.getByRole('button', { name: 'Desfazer' }).click();
  await ajustado.waitFor({ state: 'hidden' });
  assert.match(await estilo.innerText(), /Cartoon 3D/);
  await prompt.fill('Desenho 2D de uma floresta com balões.');
  await ajustado.getByText('Estilo ajustado para desenho 2D', { exact: false }).waitFor();
  assert.match(await estilo.innerText(), /Desenho 2D/, 'estilo citado com opção no seletor usa essa opção');
  // Escolha ativa no seletor + texto que contradiz: aí sim pergunta.
  await estilo.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('listbox', { name: 'Estilo da arte' }).waitFor();
  await page.getByRole('option', { name: 'Cartoon 3D' }).click();
  assert.match(await estilo.innerText(), /Cartoon 3D/);
  await prompt.fill('Floresta em aquarela, com animais e balões.');
  assert.equal(await ajustado.count(), 0, 'com escolha ativa, não ajusta sozinho');
  await gerar.click();
  const conflito = page.getByRole('alert').filter({ hasText: 'Seu pedido fala em aquarela, mas o estilo escolhido é Cartoon 3D.' });
  await conflito.waitFor();
  await capturar(page, 'aviso-estilo', largura, conflito);
  await conflito.getByRole('button', { name: 'Manter Cartoon 3D' }).click();
  assert.equal(await conflito.count(), 0);
  assert.match(await estilo.innerText(), /Cartoon 3D/);
  await prompt.fill('Floresta em aquarela e lápis, com animais e balões.');
  await gerar.click();
  await conflito.getByRole('button', { name: 'Usar o estilo do meu pedido' }).click();
  assert.match(await estilo.innerText(), /O que eu escrevi/);
  assert.equal(await conflito.count(), 0);
  assert.deepEqual(comandos, [], 'Avisos, exemplos e escolhas sem POST de geração ou gravação');

  const pedidoLego = 'Festa com LEGO e blocos coloridos.';
  await prompt.fill(pedidoLego);
  await gerar.click();
  const marca = page.getByRole('alert').filter({
    hasText: 'LEGO é uma marca protegida. Não podemos reproduzir seus personagens nem o logotipo. Podemos criar uma arte original com o mesmo clima.',
  });
  const continuar = marca.getByRole('button', { name: 'Meu pedido não é sobre LEGO' });
  await continuar.waitFor();
  assert.equal(comandos.length, 0);
  await capturar(page, 'aviso-marca', largura, marca);

  async function gerarNoMock(botao, conferirProgresso = false) {
    const resposta = page.waitForResponse(r => new URL(r.url()).pathname === '/api/convites/cliente' && r.request().method() === 'POST');
    await botao.click();
    if (conferirProgresso) {
      // Progresso honesto: etapas, prazo real do provedor, sem porcentagem, botão travado com "Gerando…".
      const progresso = page.locator('[data-progresso-geracao]');
      await progresso.waitFor();
      assert.equal(await progresso.getAttribute('data-fase'), 'criando');
      assert.match(await progresso.getByRole('status').innerText(), /até 2 minutos/);
      assert.doesNotMatch(await progresso.innerText(), /%/);
      assert.equal(await progresso.locator('[aria-current="step"]').innerText(), 'Criando a arte');
      const travado = page.getByRole('button', { name: 'Gerando…' });
      assert.equal(await travado.isDisabled(), true, 'sem clique duplo durante a geração');
      assert.equal(await page.getByRole('button', { name: 'Fechar aviso' }).count(), 0, 'aviso da geração não se fecha enquanto o progresso depende dele');
      await capturar(page, 'progresso-geracao', largura, progresso);
    }
    await resposta;
    await gerar.waitFor();
    assert.equal(await page.locator('[data-progresso-geracao]').count(), 0);
  }
  await gerarNoMock(continuar, true);
  assert.equal(await marca.count(), 0);
  await gerarNoMock(gerar); // A decisão vale para o mesmo texto.
  assert.deepEqual(comandos.map(c => [c.acao, c.prompt]), [['gerar', pedidoLego], ['gerar', pedidoLego]]);

  await prompt.fill('Festa com LEGO, blocos coloridos e balões.');
  await gerar.click();
  await continuar.waitFor();
  assert.equal(comandos.length, 2, 'Editar o texto reativa o aviso');

  // Foto + estilo do pedido sem referência aprovada: avisa antes de gerar, sem POST.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type=file][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await prompt.fill('Floresta em aquarela, com animais e balões.');
  assert.match(await estilo.innerText(), /O que eu escrevi/);
  await page.getByRole('checkbox', { name: textosAutorizacaoIA('openai', 'CLIENTE').foto }).check(); // confirmação da foto desta geração
  await gerar.click();
  const avisoFoto = page.locator('[data-aviso-foto-estilo]');
  await avisoFoto.getByText('não tem referência aprovada para a foto', { exact: false }).waitFor();
  await capturar(page, 'aviso-foto-estilo', largura, avisoFoto);
  await avisoFoto.getByRole('button', { name: 'Usar Cartoon 3D com a foto' }).click();
  await avisoFoto.waitFor({ state: 'hidden' });
  assert.match(await estilo.innerText(), /Cartoon 3D/);
  assert.equal(comandos.length, 2, 'aviso de foto sem POST');
  await fechar();

  const clienteComDeclaracaoDoBuffet = await abrir(browser, largura, { cliente: true, registradoPor: 'BUFFET' });
  assert.equal(await clienteComDeclaracaoDoBuffet.page.locator('[data-logo-buffet]').count(), 0);
  await clienteComDeclaracaoDoBuffet.page.getByRole('button', { name: 'Criar com IA' }).click();
  await conferirDeclaracao(clienteComDeclaracaoDoBuffet.page, 'CLIENTE', 'BUFFET');
  await clienteComDeclaracaoDoBuffet.fechar();
  console.log(`PASS ${largura}px · 9 capturas · publicação, autorização e avisos · 2 gerações interceptadas, zero chamadas reais`);
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const largura of [375, 1440]) await executar(browser, largura);
  } finally {
    await browser.close();
  }
})().catch(erro => { console.error(erro); process.exitCode = 1; });
