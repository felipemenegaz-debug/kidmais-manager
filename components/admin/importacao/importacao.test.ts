import test from 'node:test';
import assert from 'node:assert/strict';
import { demoContractExtraction } from '../../../lib/importacao-contrato/demo-extracao.ts';
import * as revisao from '../../../lib/importacao-contrato/revisao.ts';
import { achar, carregarComponente, cssFalso, elementos, talvez, texto } from '../teste-componente.ts';

const pdf = { nome: 'contrato-2025.pdf', tipo: 'application/pdf', tamanhoBytes: 820_000 };
const fluxo = revisao.criarFluxoImportacao(demoContractExtraction);

function ateRevisao() {
  let estado = fluxo(revisao.FLUXO_INICIAL, { tipo: 'selecionar', arquivo: pdf });
  for (let i = 0; i < revisao.ETAPAS_ANALISE.length; i++) estado = fluxo(estado, { tipo: 'avancar' });
  assert.equal(estado.etapa, 'revisao');
  return estado;
}

test('upload: aceita PDF/JPG/PNG e recusa outros formatos, vazio e acima do limite', () => {
  for (const arquivo of [pdf, { nome: 'foto.JPG', tipo: 'image/jpeg', tamanhoBytes: 1 }, { nome: 'scan.png', tipo: 'image/png', tamanhoBytes: 10 }, { nome: 'sem-tipo.pdf', tipo: '', tamanhoBytes: 10 }]) {
    assert.deepEqual(revisao.validarArquivo(arquivo), { ok: true }, arquivo.nome);
  }
  assert.deepEqual(revisao.validarArquivo({ nome: 'contrato.docx', tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', tamanhoBytes: 10 }), { ok: false, mensagem: 'Envie o contrato em PDF, JPG ou PNG.' });
  assert.deepEqual(revisao.validarArquivo({ nome: 'x.exe', tipo: '', tamanhoBytes: 10 }), { ok: false, mensagem: 'Envie o contrato em PDF, JPG ou PNG.' });
  assert.equal(revisao.validarArquivo({ ...pdf, tamanhoBytes: 0 }).ok, false);
  assert.equal(revisao.validarArquivo({ ...pdf, tamanhoBytes: revisao.TAMANHO_MAXIMO_BYTES + 1 }).ok, false);
  const recusado = fluxo(revisao.FLUXO_INICIAL, { tipo: 'selecionar', arquivo: { nome: 'a.txt', tipo: 'text/plain', tamanhoBytes: 3 } });
  assert.deepEqual(recusado, { etapa: 'upload', erro: 'Envie o contrato em PDF, JPG ou PNG.' });
});

test('estados: análise em quatro etapas, cancelamento e revisão', () => {
  let estado = fluxo(revisao.FLUXO_INICIAL, { tipo: 'selecionar', arquivo: pdf });
  assert.deepEqual(estado, { etapa: 'analisando', arquivo: pdf, passo: 0 });
  assert.deepEqual(revisao.ETAPAS_ANALISE, ['Simulando leitura do contrato', 'Simulando identificação do cliente', 'Simulando análise das condições', 'Preparando demonstração da revisão']);
  for (const etapa of revisao.ETAPAS_ANALISE) assert.match(etapa, /^(Simulando|Preparando demonstração)/, 'nenhuma etapa afirma processamento real');
  estado = fluxo(estado, { tipo: 'avancar' });
  assert.equal(estado.etapa === 'analisando' && estado.passo, 1);
  assert.deepEqual(fluxo(estado, { tipo: 'cancelar' }), revisao.FLUXO_INICIAL);
  const emRevisao = ateRevisao();
  assert.equal(emRevisao.etapa === 'revisao' && emRevisao.extracao.fonte, 'DEMONSTRACAO');
});

test('revisão: seções, três estados sem percentual e contrato histórico preservado', () => {
  const extracao = demoContractExtraction(pdf);
  assert.equal(extracao.fonte, 'DEMONSTRACAO');
  assert.deepEqual(extracao.secoes.map((s) => s.titulo), ['Contratante', 'Evento', 'Pacote', 'Buffet', 'Valores', 'Pagamentos previstos', 'Observações']);
  const contagem = revisao.contagemEstados(extracao);
  assert.ok(contagem.ENCONTRADO > 0 && contagem.PRECISA_REVISAO > 0 && contagem.NAO_ENCONTRADO > 0);
  const serializado = JSON.stringify(extracao);
  assert.doesNotMatch(serializado, /%|confian|score|probabil/i);
  const pagamentos = extracao.secoes.find((s) => s.id === 'pagamentos')!;
  assert.match(pagamentos.nota ?? '', /previsto não é pagamento recebido/);
  assert.equal(pagamentos.campos.find((c) => c.id === 'pagamentos.realizados')?.estado, 'NAO_ENCONTRADO');
  assert.match(extracao.secoes.find((s) => s.id === 'valores')!.nota ?? '', /Não são recalculados/);
  assert.match(extracao.secoes.find((s) => s.id === 'pacote')!.nota ?? '', /Não é substituído pelo pacote atual/);
  assert.deepEqual(revisao.resumoConfirmacao(extracao), [
    { rotulo: 'Cliente', valor: 'Mariana Souza Lima' },
    { rotulo: 'Data', valor: '21/11/2026' },
    { rotulo: 'Pacote', valor: 'Festa Completa — tabela 2025' },
    { rotulo: 'Convidados', valor: '80' },
    { rotulo: 'Valor contratado', valor: 'R$ 8.900,00' },
    { rotulo: 'Condição de pagamento', valor: 'Entrada + 3 parcelas via PIX' },
  ]);
});

test('Human Gate: bloqueado até revisar cada campo e termina só em estado visual', () => {
  let estado: revisao.FluxoImportacao = ateRevisao();
  assert.equal(fluxo(estado, { tipo: 'abrirConfirmacao' }), estado, 'não abre com pendências');
  assert.equal(fluxo(estado, { tipo: 'marcarPronto' }), estado, 'não pula a confirmação');
  assert.equal(fluxo(estado, { tipo: 'alternarRevisado', campoId: 'contratante.nome' }), estado, 'campo encontrado não é “revisável”');
  if (estado.etapa !== 'revisao') throw Error('etapa');
  const revisaveis = revisao.pendencias(estado.extracao, []).revisar.map((c) => c.id);
  assert.deepEqual(revisaveis, ['evento.idade', 'pacote.nome', 'buffet.restricoes']);
  for (const campoId of revisaveis) estado = fluxo(estado, { tipo: 'alternarRevisado', campoId });
  estado = fluxo(estado, { tipo: 'abrirConfirmacao' });
  assert.equal(estado.etapa === 'revisao' && estado.confirmando, true);
  assert.equal(fluxo(estado, { tipo: 'alternarRevisado', campoId: 'evento.idade' }), estado, 'modal aberto congela a revisão');
  estado = fluxo(estado, { tipo: 'marcarPronto' });
  assert.equal(estado.etapa, 'pronto');
  assert.deepEqual(fluxo(estado, { tipo: 'recomecar' }), revisao.FLUXO_INICIAL);
});

test('tela: upload → análise → revisão → Human Gate → pronto, sem nenhuma chamada de rede', () => {
  const anteriores = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
  const chamadas: string[] = [];
  const timers: Array<() => void> = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => { chamadas.push(String(url)); throw Error('nenhuma chamada de rede é esperada'); }) as typeof fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, addEventListener() {}, removeEventListener() {} } });
  try {
    const tela = carregarComponente('components/admin/importacao/ImportarContratoAntigo.tsx', {
      'next/link': { default: 'a' },
      '@/lib/importacao-contrato/demo-extracao': { demoContractExtraction },
      '@/lib/importacao-contrato/revisao': revisao,
      './importacao.module.css': cssFalso,
    });
    const render = () => { const arvore = tela.render(); tela.efeitos(); return arvore; };
    const clicar = (rotulo: string) => {
      const botao = achar(render(), 'button', rotulo);
      assert.notEqual(botao.props.disabled, true, rotulo);
      (botao.props.onClick as () => void)();
    };

    const upload = render();
    assert.match(texto(upload), /Importar contrato antigo/);
    assert.match(texto(upload), /Modo demonstração/);
    assert.match(texto(upload), /Demonstração da importação inteligente\./);
    assert.match(texto(upload), /Selecione um PDF, JPG ou PNG para visualizar como será o fluxo de análise e revisão de contratos históricos\./);
    assert.match(texto(upload), /Nesta versão de demonstração, o arquivo não é enviado nem analisado\. A revisão usa dados fictícios para apresentar a experiência\./);
    assert.doesNotMatch(texto(upload), /O Kidmais analisa|Lendo contrato/);
    assert.match(texto(upload), /PDF, JPG ou PNG/);
    assert.match(texto(upload), /Selecionar arquivo/);
    assert.doesNotMatch(texto(upload), /importação automática/i);
    const campoArquivo = achar(upload, 'input');
    assert.equal(campoArquivo.props.type, 'file');
    assert.match(String(campoArquivo.props.accept), /\.pdf.*\.jpg.*\.png/);

    // Arquivo com leitores espionados: a demo só pode usar nome, tipo e tamanho.
    const leituras: string[] = [];
    const arquivo = { name: pdf.nome, type: pdf.tipo, size: pdf.tamanhoBytes };
    for (const metodo of ['text', 'arrayBuffer', 'bytes', 'stream', 'slice']) {
      Object.defineProperty(arquivo, metodo, { value: () => { leituras.push(metodo); throw Error('o arquivo não pode ser lido'); } });
    }
    (campoArquivo.props.onChange as (e: object) => void)({ target: { files: [arquivo], value: 'C:\\fakepath\\contrato-2025.pdf' } });
    const analise = render();
    assert.match(texto(analise), /Simulando a análise/);
    assert.match(texto(analise), /não enviado/);
    assert.match(texto(analise), /Modo demonstração/);
    assert.equal(achar(analise, 'li', 'Simulando leitura do contrato').props['data-estado'], 'atual');
    assert.doesNotMatch(texto(analise), /Lendo contrato|Analisando contrato|Identificando cliente/);
    for (const etapa of ['Simulando identificação do cliente', 'Simulando análise das condições', 'Preparando demonstração da revisão']) {
      timers.shift()!();
      const arvore = render();
      assert.equal(achar(arvore, 'li', etapa).props['data-estado'], 'atual');
    }
    timers.shift()!();

    const emRevisao = render();
    const conteudo = texto(emRevisao);
    assert.match(conteudo, /Revisão inteligente/);
    for (const secao of ['Contratante', 'Evento', 'Pacote', 'Buffet', 'Valores', 'Pagamentos previstos', 'Observações']) assert(achar(emRevisao, 'h3', secao));
    const selos = elementos(emRevisao).filter((e) => e.type === 'span' && e.props.className === 'selo').map(texto);
    assert.ok(selos.includes('Encontrado') && selos.includes('Precisa revisão') && selos.includes('Não encontrado'));
    assert.match(conteudo, /Dados de exemplo/);
    assert.match(conteudo, /não foi lido nem enviado/);
    assert.match(conteudo, /Resumo dos dados de exemplo\. O arquivo não foi processado\./);
    assert.match(conteudo, /campos de exemplo/);
    assert.doesNotMatch(conteudo, /campos lidos/);
    assert.match(conteudo, /Evidências/);
    assert.match(conteudo, /Dados do sistema utilizados/);
    assert.match(conteudo, /Pagamento previsto não é pagamento recebido/);
    assert.match(conteudo, /Confirmação humana/);
    const resumoGate = elementos(emRevisao).find((e) => typeof e.type === 'function' && (e.type as { name: string }).name === 'Resumo');
    assert(resumoGate);
    assert.deepEqual((resumoGate.props.linhas as Array<{ rotulo: string }>).map((l) => l.rotulo), ['Cliente', 'Data', 'Pacote', 'Convidados', 'Valor contratado', 'Condição de pagamento']);
    assert.match(conteudo, /Pendências/);
    assert.match(conteudo, /Confirmar idade/);
    assert.equal(achar(emRevisao, 'button', 'Confirmar importação').props.disabled, true);

    for (const rotulo of ['Idade', 'Pacote original', 'Restrições alimentares']) clicar(`Confirmar leitura de ${rotulo}`);
    const revisada = render();
    assert.match(texto(revisada), /Todos os campos marcados foram revisados/);
    clicar('Confirmar importação');

    const modal = render();
    const dialogo = elementos(modal).find((e) => e.props.role === 'dialog');
    assert(dialogo);
    assert.equal(dialogo.props['aria-modal'], 'true');
    assert.match(texto(dialogo), /A persistência definitiva será habilitada após validação do Import Engine\./);
    assert.match(texto(dialogo), /Nada é gravado/);
    assert.match(texto(dialogo), /o arquivo não foi processado e o resumo usa dados de exemplo/);
    clicar('Voltar à revisão');
    assert.equal(elementos(render()).some((e) => e.props.role === 'dialog'), false);
    clicar('Confirmar importação');
    clicar('Marcar como pronto');

    const pronto = render();
    assert.match(texto(pronto), /Pronto para importar após validação/);
    assert.match(texto(pronto), /o arquivo não foi processado e nenhum cliente, contrato, festa ou pagamento foi criado/);
    assert.doesNotMatch(texto(pronto), /ficam prontos para a importação definitiva/);
    assert(talvez(pronto, 'button', 'Importar outro contrato'));
    assert.deepEqual(chamadas, [], 'nenhum botão da demo chama a rede');
    assert.deepEqual(leituras, [], 'o conteúdo do arquivo nunca é lido');
  } finally {
    globalThis.fetch = anteriores.fetch;
    for (const nome of ['window', 'document'] as const) {
      const descritor = anteriores[nome];
      if (descritor) Object.defineProperty(globalThis, nome, descritor); else Reflect.deleteProperty(globalThis, nome);
    }
  }
});
