/* eslint-disable @typescript-eslint/no-require-imports */
// Importação de contrato antigo — navegação real (next dev + Edge/Chrome headless via DevTools Protocol), APIs /api/*
// simuladas, banco inacessível, nenhum segredo ou .env. Sem dependências extras (WebSocket nativo do Node 22).
// Cenários: sem demonstração automática (importação desabilitada e falha de verificação), demonstração só por escolha
// explícita; modo real: corrigir campo, "Não consta no documento", cancelar com confirmação (continuar e confirmar);
// modo demonstração: editar, "Não consta no documento", cancelar com confirmação (recusar e aceitar).
// Uso: node scripts/importacao-revisao.ui.cjs   (BROWSER_PATH aponta para msedge/chrome se não for o padrão)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORTA_APP = 3043, PORTA_CDP = 9235, origin = `http://127.0.0.1:${PORTA_APP}`;
const IMPORTACAO = '00000000-0000-4000-8000-0000000000a1', DOCUMENTO = '00000000-0000-4000-8000-0000000000d1';

function extracaoInicial() {
  return {
    fonte: 'DOCUMENTO', arquivo: { nome: 'contrato-exemplo.pdf', tipo: 'application/pdf', tamanhoBytes: 1234 },
    secoes: [
      { id: 'contratante', titulo: 'Contratante', campos: [
        { id: 'contratante.nomeCompleto', rotulo: 'Nome do contratante', valor: 'Pessoa Exemplo', estado: 'ENCONTRADO', evidencia: { pagina: 1, trecho: 'Pessoa Exemplo', conferida: true } },
        { id: 'contratante.email', rotulo: 'E-mail', valor: 'contato@example.invalid', estado: 'ENCONTRADO', evidencia: { pagina: 1, trecho: 'contato@example.invalid', conferida: true } },
        { id: 'contratante.whatsapp', rotulo: 'WhatsApp', valor: null, estado: 'NAO_ENCONTRADO', motivo: 'WhatsApp não localizado.' },
      ] },
      { id: 'evento', titulo: 'Evento', campos: [
        { id: 'evento.data', rotulo: 'Data do evento', valor: '10/10/2099', estado: 'PRECISA_REVISAO', motivo: 'Confira a data.', evidencia: { pagina: 1, trecho: 'Evento em 10/10/2099', conferida: true } },
      ] },
    ],
  };
}
const plano = { pronto: false, bloqueios: ['Confirme a data do evento.'], avisos: [], match: { estado: 'NOVO_CLIENTE', clienteId: null, candidatos: [], motivo: 'Nenhum cliente com este nome.' } };
const festaImportada = { id: IMPORTACAO, origem: 'IMPORTACAO', clienteId: DOCUMENTO, snapshot: { contratante: { nomeCompleto: 'Pessoa Exemplo' }, aniversariante: { nome: 'Aniversariante Exemplo', idadeNoEvento: 4 }, evento: { data: '2099-10-10', horarioInicio: '10:00', horarioFim: '14:00', convidados: 50, tema: 'Carros', pacote: { nome: 'Pacote original' } } }, itens: 'Itens do contrato', buffet: { itens: 'Salgados' }, observacoes: null };

// Etapa 1: o contrato importado é consultado em Contratos (lista e detalhe por `importacaoId`), somente leitura.
const contratoResumo = { id: IMPORTACAO, origem: 'IMPORTACAO', status: 'IMPORTADO', nome: 'Pessoa Exemplo', data_evento: '2099-10-10', pacote: 'Original 2025', convidados: 50, clienteId: DOCUMENTO, situacaoEvento: 'FUTURO', importadoEm: '2026-10-02T12:00:00Z' };
const contratoImportado = {
  id: IMPORTACAO, origem: 'IMPORTACAO', status: 'IMPORTADO', situacaoEvento: 'FUTURO', importadoEm: '2026-10-02T12:00:00Z', importadoPor: 'Revisão visual',
  cliente: { id: DOCUMENTO, nome: 'Pessoa Exemplo' }, documento: { id: DOCUMENTO, nome: 'contrato-exemplo.pdf', contentType: 'application/pdf', tamanhoBytes: 1234 }, podeVerOriginal: true, pendencias: [],
  contrato: {
    evento: { data: '2099-10-10', horario: { inicio: '10:00', fim: '14:00' }, duracaoMinutos: 240, aniversariante: 'Aniversariante Exemplo', idade: 4, convidados: 50, tema: 'Carros' },
    pacote: { nome: 'Original 2025', duracaoMinutos: 240, quantidade: 50, itens: 'Itens originais' }, buffet: { itens: 'Salgados', observacoes: null, restricoes: null },
    valores: { preco: 500000, adicionais: null, total: 500000 },
    pagamentosPrevistos: { condicao: 'Entrada e 2 parcelas', entrada: { valor: 100000, vencimento: '2099-01-10' }, parcelas: [{ numero: 1, valor: 200000, vencimento: '2099-05-10' }, { numero: 2, valor: 200000, vencimento: '2099-09-10' }], natureza: 'PREVISTO' },
    observacoes: null,
  },
};

// Etapa 2: integração ao Core. Opções do assistente, resumo calculado pelo "servidor" e o contrato integrado.
const CONTRATO = '00000000-0000-4000-8000-0000000000c1', VERSAO = '00000000-0000-4000-8000-0000000000e1';
const opcoesIntegracao = (integrado) => ({
  disponivel: true, hoje: new Date().toISOString().slice(0, 10), integracao: integrado ? { contratoId: CONTRATO, financeiroPendente: false, valorContratadoCentavos: 500000 } : null,
  cliente: { id: DOCUMENTO, nome: 'Pessoa Exemplo', ativo: true }, documento: { pacote: 'Original 2025', aniversariante: 'Aniversariante Exemplo', tema: 'Carros' },
  sugestao: { evento: { data: '2099-10-10', horarioInicio: '10:00', horarioFim: '14:00', convidados: 50 }, valorContratadoCentavos: 500000, condicaoDocumento: 'Entrada e 2 parcelas',
    parcelasPrevistas: [{ valorCentavos: 100000, vencimento: '2099-01-10' }, { valorCentavos: 200000, vencimento: '2099-05-10' }, { valorCentavos: 200000, vencimento: '2099-09-10' }] },
  estabelecimentos: [{ id: '00000000-0000-4000-8000-0000000000f1', nome: 'Unidade Exemplo' }],
  pacotes: [{ id: '00000000-0000-4000-8000-0000000000b1', codigo: 'COMPLETA', nome: 'Festa Completa', duracaoMinutos: 240, ativo: true }],
  formas: ['PIX'], declaracao: 'Conferi o documento original assinado em papel. Os dados confirmados correspondem a ele, exceto as correções e complementos indicados. Nenhuma assinatura digital é registrada.',
});
function resumoDoServidor(d) {
  const hoje = new Date().toISOString().slice(0, 10);
  const parcelas = (d.financeiro.parcelas ?? []).map((p, i) => ({ ...p, numero: i + 1 }));
  const recebido = parcelas.filter((p) => p.recebimento).reduce((s, p) => s + p.valorCentavos, 0);
  return {
    contrato: { cliente: 'Pessoa Exemplo', pacoteDocumento: 'Original 2025', pacoteReferencia: 'Festa Completa (COMPLETA)', unidade: 'Unidade Exemplo', valorContratadoCentavos: d.valorContratadoCentavos, conferencia: 'Contrato assinado em papel, conferido por operador autorizado. Sem assinatura digital.' },
    festa: { data: d.evento.data, horarioInicio: d.evento.horarioInicio, horarioFim: d.evento.horarioFim, convidados: d.evento.convidados, aniversariante: 'Aniversariante Exemplo', tema: 'Carros', aniversarianteCadastro: 'NOVO' },
    agenda: { ocupa: d.evento.data >= hoje, descricao: 'Ocupa a agenda em ' + d.evento.data.split('-').reverse().join('/') + ', das ' + d.evento.horarioInicio + ' às ' + d.evento.horarioFim + ' (Unidade Exemplo).' },
    financeiro: d.financeiro.situacao === 'NAO_CONFERIDO' ? { situacao: 'NAO_CONFERIDO', contratadoCentavos: d.valorContratadoCentavos, pendencia: 'Conferir pagamentos do contrato importado.' } : {
      situacao: d.financeiro.situacao, contratadoCentavos: d.valorContratadoCentavos, recebidoCentavos: recebido, saldoCentavos: d.valorContratadoCentavos - recebido, parcelas: [],
      recebimentos: parcelas.filter((p) => p.recebimento).map((p) => ({ numero: p.numero, valorCentavos: p.valorCentavos, data: p.recebimento.data, forma: p.recebimento.forma })),
      aReceber: parcelas.filter((p) => !p.recebimento).map((p) => ({ numero: p.numero, valorCentavos: p.valorCentavos, vencimento: p.vencimento, situacao: p.vencimento < hoje ? 'VENCIDA' : 'A_RECEBER', recebidaEm: null, forma: null })) },
    campos: [],
  };
}
const snapshotIntegrado = {
  schemaVersao: 1, origem: { tipo: 'IMPORTACAO_HISTORICA', importacaoId: IMPORTACAO }, fechamento: { id: 'f', status: 'CONFIRMADO', origem: 'IMPORTACAO_HISTORICA' },
  contratante: { clienteId: DOCUMENTO, nomeCompleto: 'Pessoa Exemplo', email: null }, aniversariante: { id: null, nome: 'Aniversariante Exemplo', idadeNoEvento: 4, temaFesta: 'Carros' },
  evento: { data: '2099-10-10', horarioInicio: '10:00', horarioFim: '14:00', pacote: { id: 'p', codigo: 'COMPLETA', nome: 'Original 2025' }, convidados: 50, convidadosFaturados: 50 },
  contratacao: { adicionais: [], buffet: {} }, comercial: { valorFinalContrato: 5000, formaPagamentoPretendida: null },
};
const painelIntegrado = {
  contrato: { id: CONTRATO, fechamento_id: 'f', versao_atual: 1, status: 'ASSINADO' }, fluxo: { versao_vigente_id: VERSAO, versao_em_preparacao_id: null },
  versoes: [{ id: VERSAO, numero_versao: 1, motivo_nova_versao: null, criado_em: '2026-10-02T12:00:00Z', gerado_por_usuario_id: null, status: 'ASSINADA', estado_edicao: 'CONCLUIDA', revisao: 1, origem_versao_id: null, alteracoes: { correcoes: [] }, documento_revisado_id: null, snapshot: snapshotIntegrado, dados_fonte: { schemaVersao: 1 } }],
  documentos: [], assinaturas: [], financeiro: [], pendencias: [], revisoesOperacionais: [],
  origemHistorica: { importacaoId: IMPORTACAO, conferidoEm: '2026-10-02T12:00:00Z', conferidoPor: 'Revisão visual', conferidoPapel: 'REPRESENTANTE_AUTORIZADO', declaracao: 'Conferi.', unidade: 'Unidade Exemplo',
    documento: { id: DOCUMENTO, nome: 'contrato-exemplo.pdf', contentType: 'application/pdf', tamanhoBytes: 1234 }, podeVerOriginal: true, financeiroPendente: false,
    financeiro: { situacao: 'PARCIALMENTE_PAGO', recebidoCentavos: 100000, saldoCentavos: 400000 }, campos: [], contratoHistorico: null },
};

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pendentes = new Map(), ouvintes = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendentes.has(msg.id)) { const { ok, fail } = pendentes.get(msg.id); pendentes.delete(msg.id); return msg.error ? fail(new Error(msg.error.message)) : ok(msg.result); }
    for (const f of ouvintes.get(msg.method) ?? []) f(msg.params);
  };
  return {
    aberto: new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; }),
    enviar: (method, params = {}) => new Promise((ok, fail) => { const n = ++seq; pendentes.set(n, { ok, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
    on: (method, f) => ouvintes.set(method, [...(ouvintes.get(method) ?? []), f]),
    fechar: () => ws.close(),
  };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assert(!fs.readdirSync('.').some((n) => n === '.env' || (n.startsWith('.env.') && n !== '.env.example')), 'Execute em worktree sem arquivos .env.');
  const navegador = process.env.BROWSER_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
  assert(navegador, 'Navegador Chromium não encontrado (defina BROWSER_PATH).');
  const out = '.local-ux/importacao-revisao'; fs.mkdirSync(out, { recursive: true });
  const gerados = ['next-env.d.ts', 'tsconfig.json'].map((p) => [p, fs.readFileSync(p)]);
  const arquivoPdf = path.resolve(out, 'contrato-exemplo.pdf');
  fs.writeFileSync(arquivoPdf, '%PDF-1.4\n% arquivo sintético de teste\n');
  const log = fs.openSync(`${out}/server.log`, 'w');
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', String(PORTA_APP)], { windowsHide: true, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: 'postgres://indisponivel.invalid:1/nenhum' }, stdio: ['ignore', log, log] });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-cdp-'));
  let browser, cliente;
  const erros = [], inesperados = [], posts = [], resultados = [];
  let modoEstado = 'habilitado';                                                   // habilitado | desabilitado | falha
  let importacao = null;
  let statusAbertura = 'EM_REVISAO';
  let integrado = false;
  let fluxoUnico = false;
  const gateUnico = { operacaoId: '00000000-0000-4000-8000-0000000000ab', versao: 1, payloadHash: 'e'.repeat(64), campos: [], avisos: [] };
  const dialogos = [];                                                             // mensagens de window.confirm
  let respostaConfirm = false;
  const continuar = process.env.UI_CONTINUAR_APOS_FALHA === '1';                  // só para controle negativo
  const falhas = [];
  const caso = async (nome, fn) => {
    try { await fn(); resultados.push(nome); console.log(`ok - ${nome}`); }
    catch (e) { if (!continuar) throw e; falhas.push(nome); console.log(`not ok - ${nome}: ${String(e.message).split(/\r?\n/)[0]}`); }
  };
  try {
    let pronto = false;
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${origin}/admin/login`)).ok) { pronto = true; break; } } catch { /* iniciando */ } await esperar(500); }
    assert(pronto, 'Servidor indisponível.');
    browser = spawn(navegador, ['--headless=new', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let alvo;
    for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* subindo */ } if (!alvo) await esperar(250); }
    assert(alvo, 'DevTools do navegador indisponível.');
    cliente = cdp(alvo.webSocketDebuggerUrl); await cliente.aberto;
    cliente.on('Runtime.exceptionThrown', (p) => erros.push(p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text));
    cliente.on('Page.javascriptDialogOpening', (p) => { dialogos.push(p.message); void cliente.enviar('Page.handleJavaScriptDialog', { accept: respostaConfirm }); });
    cliente.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      const json = (status, corpo) => cliente.enviar('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(corpo)).toString('base64') });
      const ok = (data) => json(200, { ok: true, data });
      try {
        // Reautenticação (senha antes de confirmar): registrada sem a senha; a sessão sintética responde ok.
        if (url.pathname === '/api/admin/autenticacao' && p.request.method === 'POST') {
          const corpo = JSON.parse(p.request.postData ?? '{}'); posts.push({ url: url.pathname, corpo: { acao: corpo.acao, senhaInformada: typeof corpo.senha === 'string' && corpo.senha.length > 0 } });
          return ok({ csrf: 'csrf-sintetico' });
        }
        if (url.pathname === '/api/admin/autenticacao') return ok({ usuarioId: '00000000-0000-4000-8000-000000000009', nome: 'Revisão visual', papel: 'REPRESENTANTE_AUTORIZADO', csrf: 'csrf-sintetico' });
        if (url.pathname === '/api/admin/festas' && p.request.method === 'GET') return ok(url.searchParams.has('importacaoId') ? { importada: festaImportada } : { festas: [], importadas: [festaImportada], elegiveis: [], capacidades: ['FESTA_CONSULTAR'], areas: [], usuarios: [] });
        if (url.pathname === '/api/admin/contratos/painel' && p.request.method === 'GET') {
          if (url.searchParams.has('importacaoId')) return ok(integrado ? { integrado: true, contratoId: CONTRATO } : contratoImportado);
          if (url.searchParams.get('contratoId') === CONTRATO) return ok(painelIntegrado);
          return ok(integrado ? [{ id: CONTRATO, fechamento_id: 'f', status: 'ASSINADO', nome: 'Pessoa Exemplo', data_evento: '2099-10-10', pacote: 'Original 2025', convidados: '50', origem_fechamento: 'IMPORTACAO_HISTORICA' }] : [contratoResumo]);
        }
        if (url.pathname === '/api/admin/contratos/importados/' + IMPORTACAO + '/integracao') {
          if (p.request.method === 'GET') return ok(opcoesIntegracao(integrado));
          const corpo = JSON.parse(p.request.postData ?? '{}'); posts.push({ url: url.pathname, corpo });
          if (corpo.acao === 'simular') return ok({ integrada: false, pronto: true, bloqueios: [], avisos: corpo.decisoes.conferenciaDeclarada ? [] : ['Para confirmar, declare a conferência do documento original.'], resumo: resumoDoServidor(corpo.decisoes), resumoHash: (corpo.decisoes.conferenciaDeclarada ? 'b' : 'a').repeat(64), possiveisVinculos: [] });
          if (corpo.acao === 'confirmar') {
            if (corpo.resumoHash !== 'b'.repeat(64)) return json(409, { ok: false, codigo: 'RESUMO_DESATUALIZADO', erro: 'Os dados mudaram desde a revisão.' });
            integrado = true;
            return ok({ reutilizado: false, contratoId: CONTRATO, festaId: '00000000-0000-4000-8000-0000000000aa', agendaOcupada: true, financeiro: { situacao: corpo.decisoes.financeiro.situacao, pendente: false, recebidoCentavos: 100000, saldoCentavos: 400000 }, destino: '/admin/contratos?contratoId=' + CONTRATO });
          }
          return json(400, { ok: false, erro: 'Ação não simulada.' });
        }
        if (url.pathname === '/api/admin/inteligencia/operacoes' && fluxoUnico) {
          const corpo = JSON.parse(p.request.postData ?? '{}'); posts.push({ url: url.pathname, corpo });
          assert.equal(corpo.decisao, 'confirmar'); integrado = true;
          return ok({ tipo: 'resultado_acao', rascunho: { ...gateUnico, versao: 2 }, mensagem: 'Concluído', destino: '/admin/contratos?contratoId=' + CONTRATO });
        }
        if (url.pathname === '/api/admin/inteligencia/documentos' && p.request.method === 'POST') { posts.push({ url: url.pathname, corpo: 'multipart' }); return ok({ documentoId: DOCUMENTO, avisos: [] }); }
        if (url.pathname === '/api/admin/inteligencia/importacoes' && p.request.method === 'POST') {
          const corpo = JSON.parse(p.request.postData ?? '{}'); posts.push({ url: url.pathname, corpo });
          if (corpo.acao === 'estado') {
            if (modoEstado === 'falha') return cliente.enviar('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
            if (modoEstado === 'desabilitado') return ok({ habilitado: false, envioExterno: false });
            return ok({ habilitado: true, envioExterno: false });
          }
          if (corpo.acao === 'abrir') { importacao = { id: IMPORTACAO, documentoId: DOCUMENTO, versao: 1, status: statusAbertura, resultado: statusAbertura === 'IMPORTADA' ? { clienteId: DOCUMENTO, destino: `/clientes/${DOCUMENTO}`, importadoEm: '2026-10-02T12:00:00Z', pendencias: [] } : null, extracao: extracaoInicial(), revisados: [], decisaoCliente: null }; return ok({ importacao, plano: statusAbertura === 'EM_REVISAO' ? plano : null, avisos: [] }); }
          if (corpo.acao === 'ler' && corpo.importacaoId === IMPORTACAO) return ok({ importacao, plano: null });
          if (importacao?.status !== 'EM_REVISAO') return json(409, { ok: false, codigo: 'IMPORTACAO_ENCERRADA', erro: 'Esta importação já foi encerrada.' });
          if (corpo.importacaoId !== IMPORTACAO || corpo.versao !== importacao?.versao) return json(409, { ok: false, codigo: 'IMPORTACAO_DESATUALIZADA', erro: 'A revisão mudou em outra aba. Atualize a página.' });
          if (fluxoUnico && corpo.acao === 'opcoes-completas') {
            const o = opcoesIntegracao(false); o.cliente.id = null; o.sugestao.parcelasPrevistas = [];
            o.sugestao.recebimentosDocumento = { pendencias: [], recebimentos: [
              { valorCentavos:250000,data:'2026-08-10',forma:'PIX',pagina:1,trecho:'Recebido R$ 2.500,00 em 10/08/2026 via PIX' },
              { valorCentavos:250000,data:'2026-09-10',forma:'PIX',pagina:1,trecho:'Recebido R$ 2.500,00 em 10/09/2026 via PIX' },
            ] }; return ok({ opcoes:o });
          }
          if (fluxoUnico && corpo.acao === 'simular-completa') return ok({ simulacao: { integrada:false,pronto:true,bloqueios:[],avisos:[],resumo:resumoDoServidor(corpo.integracao),resumoHash:'b'.repeat(64),planoHash:'d'.repeat(64),possiveisVinculos:[] } });
          if (fluxoUnico && corpo.acao === 'preparar') {
            assert.equal(corpo.integracaoHash,'b'.repeat(64)); assert.equal(corpo.planoHash,'d'.repeat(64));
            assert.equal(corpo.integracao.financeiro.situacao,'PAGO');
            return ok({gate:{tipo:'preview',rascunho:gateUnico}});
          }
          if (corpo.acao === 'revisar') {
            const campos = importacao.extracao.secoes.flatMap((s) => s.campos);
            const campo = campos.find((c) => c.id === corpo.campoId);
            if (!campo) return json(422, { ok: false, codigo: 'DADOS_INVALIDOS', erro: 'Campo não pode ser revisado.' });
            if (corpo.valor !== undefined) {
              const texto = String(corpo.valor).trim();
              Object.assign(campo, texto ? { valor: texto, estado: 'ENCONTRADO', motivo: undefined, evidencia: undefined, origem: 'Informado na revisão' } : { valor: null, estado: 'NAO_ENCONTRADO', motivo: 'Removido na revisão.', evidencia: undefined });
            }
            importacao = { ...importacao, versao: importacao.versao + 1 };
            return ok({ importacao, plano });
          }
          if (corpo.acao === 'descartar') { importacao = { ...importacao, versao: importacao.versao + 1, status: 'DESCARTADA' }; return ok({ importacao, plano: null }); }
          return json(400, { ok: false, erro: 'Ação não simulada.' });
        }
        inesperados.push(`${p.request.method} ${url.pathname}`);
        return json(404, { ok: false, erro: 'Não simulado.' });
      } catch { /* página fechada */ }
    });
    await cliente.enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    await cliente.enviar('Runtime.enable'); await cliente.enviar('Page.enable'); await cliente.enviar('DOM.enable');
    const avaliar = async (expr) => { const r = await cliente.enviar('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
    const aguardar = async (expr, descricao, ms = 120000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (await avaliar(expr).catch(() => false)) return; await esperar(100); }
      // Diagnóstico do tempo esgotado: texto da página (só dados sintéticos das APIs simuladas) em arquivo local.
      fs.writeFileSync(`${out}/ultimo-timeout.txt`, `${descricao}\n${await avaliar('document.body.innerText').catch(() => '')}`);
      throw new Error(`Tempo esgotado: ${descricao}`); };
    const ir = (u) => cliente.enviar('Page.navigate', { url: `${origin}${u}` });
    const texto = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
    const botao = (rotulo, extra = '') => `[...document.querySelectorAll('button')].find(b => (b.textContent.trim() === ${JSON.stringify(rotulo)} || b.getAttribute('aria-label') === ${JSON.stringify(rotulo)}) && b.offsetParent !== null ${extra})`;
    const clicar = async (rotulo) => { assert.equal(await avaliar(`(() => { const b = ${botao(rotulo)}; if (!b || b.disabled) return false; b.click(); return true; })()`), true, `botão "${rotulo}"`); };
    const existeBotao = (rotulo) => avaliar(`!!(${botao(rotulo)})`);
    const digitar = (seletor, valor) => avaliar(`(() => { const i = document.querySelector(${JSON.stringify(seletor)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(valor)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const enviarArquivo = async () => {
      const { root } = await cliente.enviar('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await cliente.enviar('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
      assert(nodeId, 'campo de arquivo');
      await cliente.enviar('DOM.setFileInputFiles', { nodeId, files: [arquivoPdf] });
    };
    const posteriores = (n) => posts.slice(n).filter((x) => x.url === '/api/admin/inteligencia/importacoes' && x.corpo.acao !== 'estado').map((x) => x.corpo);
    const fotografar = async (nome) => {
      const { data } = await cliente.enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${out}/${nome}.png`, Buffer.from(data, 'base64'));
    };

    await caso('Importação desabilitada para a empresa: erro explícito, sem abrir demonstração automaticamente', async () => {
      modoEstado = 'desabilitado';
      await ir('/admin/contratos/importar');
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('não está habilitada neste ambiente'))`, 'alerta de desabilitada');
      await esperar(800);
      assert.equal(await avaliar(texto('Arraste o contrato para cá')), false, 'não abre envio (demonstração) sozinho');
      assert.equal(await existeBotao('Abrir demonstração com dados fictícios'), true);
    });

    await caso('Falha ao verificar a importação: erro explícito, sem demonstração automática', async () => {
      modoEstado = 'falha';
      await ir('/admin/contratos/importar');
      await aguardar(`[...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('Não foi possível concluir agora'))`, 'alerta de falha');
      await esperar(800);
      assert.equal(await avaliar(texto('Arraste o contrato para cá')), false);
    });

    await caso('Demonstração só por escolha explícita: editar, "Não consta no documento" e cancelar com confirmação', async () => {
      await clicar('Abrir demonstração com dados fictícios');
      await aguardar(texto('Arraste o contrato para cá'), 'envio da demonstração');
      await enviarArquivo();
      await aguardar(`!!(${botao('Cancelar importação')})`, 'revisão da demonstração', 60000);
      // Editar o primeiro campo editável
      const rotulo = await avaliar(`(() => { const b = ${botao('Editar')}; const dl = b?.closest('div'); return dl?.querySelector('dt')?.textContent ?? null; })()`);
      assert(rotulo, 'campo editável na demonstração');
      await clicar('Editar');
      await aguardar(`!!document.querySelector('input[aria-label="Correção de ${rotulo}"]')`, 'editor do campo');
      await digitar(`input[aria-label="Correção de ${rotulo}"]`, 'Valor corrigido na revisão');
      await clicar('Salvar correção');
      await aguardar(texto('Valor corrigido na revisão'), 'valor corrigido exibido');
      // Não consta no documento — em outro campo, para não apagar a correção acima
      const outro = await avaliar(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Não consta no documento' && x.offsetParent !== null && x.closest('div')?.querySelector('dt')?.textContent !== ${JSON.stringify(rotulo)}); if (!b) return null; const nome = b.closest('div').querySelector('dt').textContent; b.click(); return nome; })()`);
      assert(outro, 'outro campo com valor');
      await aguardar(`(() => { const d = [...document.querySelectorAll('div')].find(x => x.querySelector(':scope > dt')?.textContent === ${JSON.stringify(outro)}); return !!d && d.textContent.includes('Não localizado no contrato'); })()`, 'campo marcado como não consta');
      // Cancelar: recusar mantém a revisão; aceitar volta ao envio
      respostaConfirm = false; const d0 = dialogos.length;
      await clicar('Cancelar importação');
      await aguardar(`true`, 'confirm'); await esperar(300);
      assert.equal(dialogos.length, d0 + 1, 'confirmação exibida');
      assert.match(dialogos.at(-1), /Descartar esta revisão\? Nenhum dado será gravado\./);
      assert.equal(await existeBotao('Cancelar importação'), true, 'recusar mantém a revisão');
      assert.equal(await avaliar(texto('Valor corrigido na revisão')), true, 'a correção continua');
      respostaConfirm = true;
      await clicar('Cancelar importação');
      await aguardar(texto('Arraste o contrato para cá'), 'volta ao envio');
      respostaConfirm = false;
    });

    await caso('Modo real: corrigir campo envia a revisão e mostra o valor corrigido', async () => {
      modoEstado = 'habilitado';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio real');
      const n = posts.length;
      await enviarArquivo();
      await aguardar(texto('Pessoa Exemplo'), 'revisão real');
      assert(posts.slice(n).some((x) => x.url === '/api/admin/inteligencia/documentos'), 'documento enviado');
      assert.equal(await existeBotao('Não consta no documento'), false, 'remoção não compete com a leitura');
      assert.equal(await avaliar(`document.querySelector('details')?.open`), false, 'trecho encontrado começa recolhido');
      await avaliar(`document.querySelector('details summary').click()`);
      assert.equal(await avaliar(`document.querySelector('details')?.open`), true, 'trecho continua acessível');
      await avaliar(`document.querySelector('details summary').click()`);
      assert.equal(await avaliar(`[...document.querySelectorAll('details')].at(-1)?.open`), true, 'evidência pendente permanece visível');
      await fotografar('revisao-desktop');
      await clicar('Corrigir Nome do contratante');
      await aguardar(`!!document.querySelector('#editar-contratante\\\\.nomeCompleto')`, 'editor real');
      await digitar('#editar-contratante\\.nomeCompleto', 'Pessoa Exemplo Corrigida');
      const m = posts.length;
      await clicar('Salvar');
      await aguardar(texto('Pessoa Exemplo Corrigida'), 'valor corrigido');
      assert.deepEqual(posteriores(m), [{ acao: 'revisar', campoId: 'contratante.nomeCompleto', valor: 'Pessoa Exemplo Corrigida', importacaoId: IMPORTACAO, versao: 1 }]);
    });

    await caso('Modo real: "Não consta no documento" remove o valor (revisar com valor vazio)', async () => {
      const m = posts.length;
      const botaoDoEmail = `[...document.querySelectorAll('div')].find(d => d.querySelector(':scope > dt')?.textContent === 'E-mail')`;
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Não consta no documento')})`, 'remoção dentro da edição');
      await clicar('Cancelar');
      await aguardar(`!(${botao('Não consta no documento')})`, 'cancelar fecha edição');
      assert.deepEqual(posteriores(m), [], 'abrir e cancelar edição não salva nem remove');
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Não consta no documento')})`, 'editor reaberto');
      for (const width of [390, 320]) {
        await cliente.enviar('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
        await esperar(150);
        assert.equal(await avaliar('document.documentElement.scrollWidth <= window.innerWidth'), true, `sem rolagem horizontal a ${width}px`);
        const tamanho = await avaliar(`(${botao('Não consta no documento')}).getBoundingClientRect().height`);
        assert(tamanho <= 40 && tamanho >= 24, 'ação secundária compacta e clicável');
        await avaliar(`(${botao('Não consta no documento')}).scrollIntoView({block:'center'})`);
        await fotografar(`edicao-mobile-${width}`);
      }
      await cliente.enviar('Emulation.clearDeviceMetricsOverride');
      assert.equal(await avaliar(`(() => { const b = [...(${botaoDoEmail})?.querySelectorAll('button') ?? []].find(x => x.textContent.trim() === 'Não consta no documento'); if (!b) return false; b.click(); return true; })()`), true);
      await aguardar(`(() => { const d = ${botaoDoEmail}; return !!d && d.textContent.includes('Não localizado no contrato') && d.textContent.includes('Removido na revisão.'); })()`, 'e-mail removido');
      assert.equal(await avaliar(texto('contato@example.invalid')), false);
      assert.deepEqual(posteriores(m), [{ acao: 'revisar', campoId: 'contratante.email', valor: '', importacaoId: IMPORTACAO, versao: 2 }]);
      assert.equal(await avaliar(`[...(${botaoDoEmail})?.querySelectorAll('button') ?? []].some(x => x.textContent.trim() === 'Não consta no documento')`), false, 'sem valor, o botão some');
    });

    await caso('Modo real: cancelar pede confirmação; "Continuar revisão" preserva; "Sim, cancelar" descarta', async () => {
      const m = posts.length;
      await clicar('Cancelar importação');
      await aguardar(`document.querySelector('dialog')?.open === true`, 'diálogo aberto');
      assert.equal(await avaliar(`document.querySelector('dialog h2')?.textContent`), 'Descartar esta revisão?');
      assert.deepEqual(posteriores(m), [], 'abrir o diálogo não descarta');
      await clicar('Continuar revisão');
      await aguardar(`document.querySelector('dialog')?.open === false`, 'diálogo fechado');
      assert.equal(await avaliar(texto('Pessoa Exemplo Corrigida')), true, 'a revisão continua');
      assert.deepEqual(posteriores(m), [], 'continuar não descarta');
      await clicar('Cancelar importação');
      await aguardar(`document.querySelector('dialog')?.open === true`, 'diálogo aberto de novo');
      await clicar('Sim, cancelar importação');
      await aguardar(texto('Arraste o contrato para cá'), 'volta ao envio');
      assert.deepEqual(posteriores(m), [{ acao: 'descartar', importacaoId: IMPORTACAO, versao: 3 }]);
    });

    await caso('Reenvio de contrato importado abre resultado, sem edição nem confirmação duplicada; "Abrir contrato" mostra o contrato importado; evento futuro fica no bloco a integrar, fora da grade de festas', async () => {
      statusAbertura = 'IMPORTADA';
      for (let vez = 0; vez < 2; vez++) {
        await ir('/admin/contratos/importar');
        await aguardar(texto('Arraste o contrato para cá'), 'envio para recuperar resultado');
        const m = posts.length;
        await enviarArquivo();
        await aguardar(texto('Os dados deste contrato já estão registrados.'), 'importação anterior reaberta na integração');
        await aguardar(texto('Falta integrar ao sistema'), 'sem anúncio de sucesso antes da integração');
        assert.equal(await existeBotao('Revisar importação'), false);
        assert.equal(await existeBotao('Corrigir Nome do contratante'), false);
        assert.equal(await existeBotao('Cancelar importação'), false);
        assert.deepEqual(posteriores(m), [{ acao: 'abrir', documentoId: DOCUMENTO }]);
      }
      await fotografar('contrato-ja-importado');
      assert.equal(await existeBotao('Abrir festa importada'), false, 'a importação não anuncia festa');
      await avaliar(`document.querySelector('a[href="/admin/contratos?importacaoId=${IMPORTACAO}"]').click()`);
      await aguardar(texto('Evento importado — ainda não integrado à agenda'), 'detalhe do contrato importado em Contratos');
      // O selo é exibido em maiúsculas por CSS (innerText acompanha); conferir pelo textContent das três parcelas previstas.
      await aguardar(`[...document.querySelectorAll('td span')].filter(s => s.textContent.trim() === 'Previsto, não cobrado').length === 3`, 'pagamentos identificados como previstos');
      assert.equal(await existeBotao('Registrar recebimento'), false, 'nenhuma baixa financeira no contrato importado');
      assert.equal(await avaliar(texto('Carros')), true);
      assert.equal(await avaliar(texto('Itens originais')), true, 'snapshot do documento');
      assert.equal(await avaliar(`!!document.querySelector('a[href="/api/admin/contratos/importados/${IMPORTACAO}/original"]')`), true, 'original visível ao papel autorizado');
      assert.equal(await avaliar(`document.querySelector('select[aria-label="Contrato"]')?.value`), `importacao:${IMPORTACAO}`, 'seletor aponta o contrato importado');
      assert.equal(await existeBotao('Editar dados desta revisão'), false, 'nenhuma ação de contrato do Core');
      await fotografar('contrato-importado');
      await ir('/admin/festas?visao=proximas');
      await aguardar(texto('Eventos importados a integrar'), 'bloco de eventos importados');
      assert.equal(await avaliar(`(${botao('Próximas')}).getAttribute('aria-pressed')`), 'true');
      assert.equal(await avaliar(texto('Aniversariante Exemplo — 4 anos')), true);
      assert.equal(await avaliar(texto('Nenhuma festa nesta visão.')), true, 'evento importado não entra na grade de festas');
      await fotografar('proximas-importados-a-integrar');
      await avaliar(`document.querySelector('#importados-a-integrar a[href="/admin/contratos?importacaoId=${IMPORTACAO}"]').click()`);
      await aguardar(texto('Dados do contrato'), 'volta ao contrato importado');
    });

    await caso('Revisão encerrada em outra aba é atualizada para resultado após tentativa de correção', async () => {
      statusAbertura = 'EM_REVISAO';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio real');
      await enviarArquivo();
      await aguardar(texto('Pessoa Exemplo'), 'revisão aberta');
      await clicar('Corrigir E-mail');
      await aguardar(`!!(${botao('Salvar')})`, 'editor aberto');
      importacao.status = 'IMPORTADA';
      const m = posts.length;
      await clicar('Salvar');
      await aguardar(texto('Os dados deste contrato já estão registrados.'), 'atualiza estado encerrado');
      assert.deepEqual(posteriores(m).map(p => p.acao), ['revisar', 'ler']);
      assert.equal(await existeBotao('Salvar'), false);
    });

    await caso('Revisão cancelada não abre editor; reenviar permite começar de novo', async () => {
      statusAbertura = 'DESCARTADA';
      await ir('/admin/contratos/importar');
      await aguardar(texto('Arraste o contrato para cá'), 'envio');
      await enviarArquivo();
      await aguardar(texto('Esta revisão foi cancelada.'), 'cancelamento legível');
      assert.equal(await existeBotao('Revisar importação'), false);
      await clicar('Enviar contrato novamente');
      statusAbertura = 'EM_REVISAO';
      await enviarArquivo();
      await aguardar(`!!(${botao('Corrigir E-mail')})`, 'nova revisão editável');
    });

    await caso('Integrar ao sistema (importação existente): festa e agenda, pagamentos conferidos, revisão do servidor e declaração; sucesso só após confirmar; link antigo leva ao contrato integrado', async () => {
      integrado = false;
      contratoImportado.podeIntegrar = true;
      await ir('/admin/contratos?importacaoId=' + IMPORTACAO);
      await aguardar(texto('Ainda não integrado ao sistema.'), 'contrato importado sem integração');
      await clicar('Integrar ao sistema');
      await aguardar(texto('Festa e agenda'), 'assistente aberto sem reenviar arquivo');
      assert.equal(await avaliar(`(${botao("Continuar para pagamentos")})?.disabled`), true, 'situação do contrato começa em branco');
      const marcar = (rotulo) => avaliar(`(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes(${JSON.stringify(rotulo)})); l.querySelector('input').click(); return true; })()`);
      const escolher = (seletor, valor) => avaliar(`(() => { const s = document.querySelector(${JSON.stringify(seletor)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(valor)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await marcar('Cancelado');
      await aguardar(texto('não vira festa e não ocupa agenda'), 'cancelado não integra');
      await marcar('Vigente');
      const pacote = await avaliar(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.text === 'Festa Completa')); s.id = 'pacote-ref'; return true; })()`);
      assert.equal(pacote, true);
      await escolher('#pacote-ref', '00000000-0000-4000-8000-0000000000b1');
      await clicar('Continuar para pagamentos');
      await aguardar(texto('não comprova que algo foi pago'), 'condição do documento não vira pagamento');
      await fotografar('integracao-festa-agenda');
      await marcar('Parte foi paga');
      await avaliar(`document.querySelector('input[aria-label="Parcela 1 foi recebida"]').click()`);
      await aguardar(`!!document.querySelector('input[aria-label="Data em que a parcela 1 foi recebida"]')`, 'campos do recebimento');
      await digitar('input[aria-label="Data em que a parcela 1 foi recebida"]', '2026-09-01');
      await escolher('select[aria-label="Forma da parcela 1"]', 'PIX');
      await aguardar(texto('Saldo a receber R$ 4.000,00'), 'conferência em centavos na tela');
      await fotografar('integracao-pagamentos');
      const m = posts.length;
      await clicar('Revisar e confirmar');
      await aguardar(texto('Revisão final'), 'revisão final');
      await aguardar(texto('Ocupa a agenda em 10/10/2099'), 'agenda no resumo');
      await aguardar(texto('Parcela 1: R$ 1.000,00 em 01/09/2026 · Pix'), 'recebimento na data real');
      await aguardar(texto('Parcela 3: R$ 2.000,00, vence 10/09/2099'), 'parcela a receber');
      assert.equal(await avaliar(`(${botao("Confirmar integração")})?.disabled`), true, 'sem declaração não confirma');
      assert.equal(await avaliar(texto('Contrato integrado ao sistema')), false);
      await marcar('Conferi o documento original');
      await esperar(300);
      assert.equal(await avaliar(`(${botao("Confirmar integração")})?.disabled`), true, 'sem senha não confirma (autenticação recente)');
      await digitar('input[aria-label="Senha para confirmar"]', 'senha-sintetica');
      await aguardar(`!(${botao("Confirmar integração")})?.disabled`, 'declaração e senha liberam a confirmação');
      await fotografar('integracao-revisao-final');
      await clicar('Confirmar integração');
      await aguardar(texto('Contrato histórico — assinado em papel'), 'contrato do Core só depois da resposta');
      const ordem = posts.slice(m).filter((x) => x.url === '/api/admin/autenticacao' || (x.url.endsWith('/integracao') && x.corpo.acao === 'confirmar'));
      assert.deepEqual(ordem.map((x) => x.corpo.acao), ['reautenticar', 'confirmar'], 'reautentica antes de confirmar');
      assert.equal(ordem[0].corpo.senhaInformada, true);
      const enviados = posts.slice(m).filter((x) => x.url.endsWith('/integracao')).map((x) => x.corpo);
      assert.equal(JSON.stringify(enviados).includes('senha-sintetica'), false, 'a senha nunca vai para a integração');
      const confirmacao = enviados.find((x) => x.acao === 'confirmar');
      assert.equal(confirmacao.resumoHash, 'b'.repeat(64));
      assert.match(confirmacao.chave, /^[0-9a-f-]{36}$/);
      assert.equal(/empresa|usuario|tenant/i.test(JSON.stringify(Object.keys(confirmacao.decisoes))), false, 'payload sem empresa/usuário');
      assert.deepEqual(confirmacao.decisoes.financeiro.parcelas.map((p) => p.recebimento?.data ?? null), ['2026-09-01', null, null]);
      await fotografar('integracao-concluida');
      await ir('/admin/contratos?importacaoId=' + IMPORTACAO);
      await aguardar(`location.search.includes('contratoId=' + ${JSON.stringify(CONTRATO)})`, 'link antigo redireciona ao contrato integrado');
      await aguardar(texto('Contrato histórico — assinado em papel'), 'origem histórica no contrato do Core');
      assert.equal(await avaliar(texto('Não há assinatura digital, OTP nem comprovante eletrônico')), true);
      assert.equal(await avaliar(texto('Ainda não integrado ao sistema.')), false, 'projeção da importação não aparece duplicada');
      await fotografar('contrato-integrado');
      integrado = false;
      delete contratoImportado.podeIntegrar;
    });

    await caso('Importação nova: pagamentos completos, uma confirmação final e navegação ao contrato Core', async () => {
      fluxoUnico=true; integrado=false; statusAbertura='EM_REVISAO'; plano.pronto=true; plano.bloqueios=[];
      await ir('/admin/contratos/importar'); await aguardar(texto('Arraste o contrato para cá'),'envio único');
      await enviarArquivo(); await aguardar(texto('Pessoa Exemplo'),'revisão do cliente');
      const inicio=posts.length; await clicar('Continuar para festa e pagamentos');
      await aguardar("[...document.querySelectorAll('label')].some(l=>l.textContent.includes('Vigente'))",'festa carregada antes do cadastro');
      assert(!posts.slice(inicio).some(p=>p.corpo.acao==='preparar'||p.corpo.decisao==='confirmar'),'nenhuma confirmação antecipada');
      await avaliar(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Vigente')).querySelector('input').click()`);
      await aguardar("[...document.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.text==='Festa Completa'))",'referência operacional visível');
      await avaliar(`(() => { const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.text==='Festa Completa')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'00000000-0000-4000-8000-0000000000b1'); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await clicar('Revisar e concluir'); await aguardar(texto('Revisão final'),'resumo completo');
      await aguardar(texto('Parcela 1: R$ 2.500,00 em 10/08/2026 · Pix'),'primeiro PIX');
      await aguardar(texto('Parcela 2: R$ 2.500,00 em 10/09/2026 · Pix'),'segundo PIX');
      await avaliar(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Conferi o documento original')).querySelector('input').click()`);
      await aguardar("!!document.querySelector('input[aria-label=\"Senha para confirmar\"]')","revisão recalculada após declaração");
      await digitar('input[aria-label="Senha para confirmar"]','senha-sintetica');
      await aguardar(`!(${botao('Confirmar integração')})?.disabled`,'declaração e senha');
      await fotografar('importacao-confirmacao-unica');
      await clicar('Confirmar integração');
      await aguardar(`location.search.includes('contratoId=' + ${JSON.stringify(CONTRATO)})`,'destino do Core');
      assert.deepEqual(posts.slice(inicio).filter(p=>p.url==='/api/admin/autenticacao'||p.corpo.acao==='preparar'||p.corpo.decisao).map(p=>p.corpo.acao??p.corpo.decisao),['reautenticar','preparar','confirmar']);
      fluxoUnico=false; plano.pronto=false; plano.bloqueios=['Confirme a data do evento.'];
    });

    assert.deepEqual(falhas, [], `cenários com falha: ${falhas.join(' | ')}`);
    assert.deepEqual(erros, [], `erros de página: ${erros.join(' | ')}`);
    console.log(`PASS ${resultados.length} cenários; chamadas não simuladas: ${JSON.stringify([...new Set(inesperados)])}`);
  } finally {
    try { cliente?.fechar(); } catch { /* fechado */ }
    browser?.kill(); server.kill();
    for (const [p, conteudo] of gerados) fs.writeFileSync(p, conteudo);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch { /* em uso */ }
  }
}
main().catch((e) => { console.error(`FAIL ${e.stack ?? e.message}`); process.exit(1); });
