import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../admin/teste-componente.ts';

/**
 * Página pública real com APIs simuladas. Ao perder a prova (qualquer das cinco rotas), somem a marca, os PDFs e os tokens,
 * os blobs são revogados e a tela volta à identificação; respostas que chegam depois disso são descartadas.
 */
const CONTRATO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRO_CONTRATO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOME = 'Buffet Estrela Encantada';
const PROVA = 'PROVA-SECRETA-0123456789-0123456789';
const ACESSO = 'ACESSO-SECRETO-0123456789-0123456789';
const contexto = {
  contrato: { id: CONTRATO, status: 'AGUARDANDO_ASSINATURA', assinadoEm: null },
  comprovantes: [{ id: 'd1', parte: 'KIDMAIS', nome: 'Ana', assinado_em: '2026-11-01T12:00:00Z' }],
  versao: { id: 'v1', numero: 1, status: 'ATIVA', snapshotHash: 'h', resumo: { templateVersao: 1, pdfHash: 'r' },
    contratoOficial: { disponivel: true, modeloCodigo: 'M', templateVersao: 1, pdfHash: 'c', homologadoParaProducao: true },
    documentoTemplateVersao: 1, documentoPdfHash: 'c', documentoHomologadoParaProducao: true, assinadoEm: null },
  evento: { data: '2026-12-12', horarioInicio: '10:30:00', horarioFim: '14:30:00', pacote: 'P', pacoteCodigo: 'P', aniversariante: 'Helena', valorFinalContrato: 100, salao: null },
  assinatura: { tipo: 'ELETRONICA', texto: null },
  marca: { kidmais: false, nome: NOME },
  aceitePermitido: true,
};
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const pdf = () => new Response(new Blob(['%PDF'], { type: 'application/pdf' }), { status: 200 });
const recusa = (codigo: string) => () => json({ ok: false, erro: 'Recusado pelo servidor.', codigo }, codigo === 'CONTRATO_ACESSO_NAO_AUTORIZADO' ? 404 : 401);
const evento = (value: string) => ({ target: { value, checked: true } });
async function esperar() { for (let i = 0; i < 12; i++) await tique(); }

type Rota = 'contexto' | 'resumo' | 'pdf' | 'aceite' | 'comprovante' | 'confirmar';
/** Cada rota responde pela fila (uma resposta por chamada; a última se repete) ou pelo padrão. */
type Respostas = Partial<Record<Rota, Array<() => Response | Promise<Response>>>>;

async function abrir(respostas: Respostas = {}, ate4 = true) {
  const criadas: string[] = [];
  const revogadas: string[] = [];
  const sinais: Array<{ rota: Rota; signal?: AbortSignal }> = [];
  const original = { criar: URL.createObjectURL, revogar: URL.revokeObjectURL, fetch: globalThis.fetch, document: (globalThis as { document?: unknown }).document };
  let n = 0;
  URL.createObjectURL = () => { const u = `blob:${++n}`; criadas.push(u); return u; };
  URL.revokeObjectURL = (u: string) => { revogadas.push(u); };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ click: () => undefined }) };
  const padrao: Record<Rota, () => Response> = {
    contexto: () => json({ ok: true, data: contexto }), resumo: pdf, pdf,
    aceite: () => json({ ok: true, data: {} }), comprovante: pdf, confirmar: () => json({ ok: true, provaToken: PROVA }),
  };
  const chamadas: Record<string, number> = {};
  const responder = (rota: Rota) => {
    const fila = respostas[rota];
    const i = chamadas[rota] = (chamadas[rota] ?? 0) + 1;
    return fila?.length ? fila[Math.min(i, fila.length) - 1]() : padrao[rota]();
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/acesso')) return json({ ok: true, data: { canais: [{ canal: 'WHATSAPP', destinoMascarado: '(11) *****-0000' }] } });
    if (url.endsWith('/identidade/iniciar')) return json({ ok: true, data: { validacaoId: 'val', acessoToken: ACESSO } });
    const rota = (url === '/api/identidade/confirmar-codigo' ? 'confirmar' : url.split('/').pop()) as Rota;
    if (!(rota in padrao)) throw new Error('chamada não prevista: ' + url);
    sinais.push({ rota, signal: init?.signal ?? undefined });
    return responder(rota);
  }) as typeof fetch;
  const tela = carregarComponente('components/contrato/ContratoPublico.tsx', { 'next/image': { default: 'img' }, './ContratoPublico.module.css': cssFalso });
  let id = CONTRATO;
  const ver = () => { const a = tela.render('default', { contratoId: id }); tela.efeitos(); return a; };
  const clicar = async (rotulo: string | RegExp) => { (achar(ver(), 'button', rotulo).props.onClick as () => void)(); await esperar(); };
  const restaurar = () => {
    URL.createObjectURL = original.criar; URL.revokeObjectURL = original.revogar; globalThis.fetch = original.fetch;
    (globalThis as { document?: unknown }).document = original.document;
  };
  assert.doesNotMatch(texto(ver()), new RegExp(NOME), 'antes da prova: neutro');
  (achar(ver(), 'input').props.onChange as (e: unknown) => void)(evento('123.456.789-00'));
  await clicar('Continuar');
  await clicar('Enviar código');
  (achar(ver(), 'input').props.onChange as (e: unknown) => void)(evento('123456'));
  if (ate4) await clicar('Abrir documentos');
  return {
    ver, clicar, criadas, revogadas, sinais, restaurar, estado: () => tela.estado(),
    trocarContrato: () => { id = OUTRO_CONTRATO; ver(); },
    aceitar: async () => {
      await clicar(/Contrato Oficial/);
      const caixa = elementos(ver()).find((e: Elemento) => e.type === 'input' && e.props.type === 'checkbox');
      assert(caixa, 'caixa do aceite');
      (caixa.props.onChange as (e: unknown) => void)(evento(''));
      await clicar('Aceitar e assinar eletronicamente');
    },
  };
}

type Tela = Awaited<ReturnType<typeof abrir>>;

function assertIdentificacao(t: Tela, aviso: RegExp) {
  const a = t.ver();
  const pagina = texto(a);
  assert.doesNotMatch(pagina, new RegExp(NOME), 'sem a marca');
  assert.match(pagina, /Documentos do buffet/);
  assert.match(pagina, aviso);
  assert.match(pagina, /Confirme seu CPF ou CNPJ/);
  assert.ok(!elementos(a).some((e) => e.type === 'iframe'), 'nenhum PDF na tela');
  assert.equal(achar(a, 'input').props.value, '', 'CPF vazio');
  for (const u of t.criadas) assert.ok(t.revogadas.includes(u), `blob ${u} revogado`);
  const retido = JSON.stringify(t.estado(), (_k, v) => (v instanceof AbortController ? 'controle' : v));
  assert.ok(!retido.includes(PROVA) && !retido.includes(ACESSO), 'tokens fora do estado');
  assert.ok(!retido.includes(NOME), 'marca fora do estado');
}

const EXPIRADA = /Sua validação expirou/;

for (const codigo of ['CONTRATO_ACESSO_NAO_AUTORIZADO', 'PROVA_INVALIDA_OU_EXPIRADA']) {
  for (const rota of ['contexto', 'resumo', 'pdf'] as const) {
    test(`carregamento inicial, ${rota} recusa com ${codigo}: volta à identificação sem blobs nem tokens`, async () => {
      const t = await abrir({ [rota]: [recusa(codigo)] });
      try { assertIdentificacao(t, EXPIRADA); } finally { t.restaurar(); }
    });
  }

  test(`aceite recusado com ${codigo}: limpa os dois PDFs e volta à identificação`, async () => {
    const t = await abrir({ aceite: [recusa(codigo)] });
    try {
      assert.equal(t.criadas.length, 2, 'resumo e contrato abertos');
      await t.aceitar();
      assertIdentificacao(t, EXPIRADA);
      assert.deepEqual([...new Set(t.revogadas)].sort(), ['blob:1', 'blob:2']);
    } finally { t.restaurar(); }
  });

  test(`comprovante recusado com ${codigo}: limpa os dois PDFs e volta à identificação`, async () => {
    const t = await abrir({ comprovante: [recusa(codigo)] });
    try {
      await t.clicar('Baixar comprovante — Buffet');
      assertIdentificacao(t, EXPIRADA);
    } finally { t.restaurar(); }
  });
}

test('versão encerrada no aceite: documentos saem e a mensagem do servidor fica', async () => {
  const t = await abrir({ aceite: [() => json({ ok: false, erro: 'A versão exibida não é mais a versão corrente do Contrato.', codigo: 'VERSAO_CONTRATO_DIVERGENTE' }, 409)] });
  try {
    await t.aceitar();
    assertIdentificacao(t, /não é mais a versão corrente/);
  } finally { t.restaurar(); }
});

test('versão encerrada ao carregar: nada da versão antiga aparece', async () => {
  const t = await abrir({ contexto: [() => json({ ok: false, erro: 'Esta versão foi encerrada.', codigo: 'VERSAO_CONTRATO_DIVERGENTE' }, 409)] });
  try { assertIdentificacao(t, /Esta versão foi encerrada/); } finally { t.restaurar(); }
});

test('aceite gravado e nova leitura recusada: avisa que o aceite foi registrado e pede nova prova', async () => {
  const t = await abrir({ contexto: [() => json({ ok: true, data: contexto }), recusa('PROVA_INVALIDA_OU_EXPIRADA')] });
  try {
    await t.aceitar();
    assertIdentificacao(t, /Seu aceite foi registrado\. Para ver os documentos de novo, confirme seus dados\./);
  } finally { t.restaurar(); }
});

test('comprovante indisponível (COMPROVANTE_NAO_ENCONTRADO): a leitura continua', async () => {
  const t = await abrir({ comprovante: [() => json({ ok: false, erro: 'Este comprovante não está disponível para esta versão do Contrato.', codigo: 'COMPROVANTE_NAO_ENCONTRADO' }, 404)] });
  try {
    await t.clicar('Baixar comprovante — Buffet');
    const pagina = texto(t.ver());
    assert.match(pagina, new RegExp(NOME));
    assert.match(pagina, /Este comprovante não está disponível/);
    assert.deepEqual(t.revogadas, []);
  } finally { t.restaurar(); }
});

test('outra falha ao baixar o comprovante: mantém a tela e mostra o erro', async () => {
  const t = await abrir({ comprovante: [() => json({ ok: false, erro: 'Comprovante indisponível.', codigo: 'OUTRO' }, 500)] });
  try {
    await t.clicar('Baixar comprovante — Buffet');
    const pagina = texto(t.ver());
    assert.match(pagina, new RegExp(NOME));
    assert.match(pagina, /Comprovante indisponível\./);
    assert.deepEqual(t.revogadas, []);
  } finally { t.restaurar(); }
});

function adiado() {
  let soltar: (r: Response) => void = () => undefined;
  const promessa = new Promise<Response>((ok) => { soltar = ok; });
  return { promessa, soltar };
}

const ACEITE_REGISTRADO = /Seu aceite foi registrado\. Para ver os documentos de novo, confirme seus dados\./;

for (const codigo of ['CONTRATO_ACESSO_NAO_AUTORIZADO', 'PROVA_INVALIDA_OU_EXPIRADA']) test(`resposta tardia do PDF depois de recusa ${codigo} no comprovante: descartada, e o aviso do aceite confirmado prevalece`, async () => {
  const tardio = adiado();
  const t = await abrir({ pdf: [pdf, () => tardio.promessa], comprovante: [recusa(codigo)] });
  try {
    await t.aceitar(); // aceite gravado; a nova leitura fica parada no PDF
    await t.clicar('Baixar comprovante — Buffet'); // a prova cai enquanto o PDF não chegou
    assertIdentificacao(t, ACEITE_REGISTRADO);
    assert.doesNotMatch(texto(t.ver()), EXPIRADA);
    const criadasAntes = t.criadas.length;
    const pedidoPdf = t.sinais.filter((s) => s.rota === 'pdf').at(-1);
    assert.equal(pedidoPdf?.signal?.aborted, true, 'requisição em voo cancelada');
    tardio.soltar(pdf());
    await esperar();
    assertIdentificacao(t, ACEITE_REGISTRADO);
    assert.equal(t.criadas.length, criadasAntes, 'nenhum blob criado pela resposta tardia');
  } finally { t.restaurar(); }
});

test('recusa entre a criação dos blobs da recarga e a renderização: os quatro blobs são revogados', async () => {
  const tardio = adiado();
  const t = await abrir({ pdf: [pdf, () => tardio.promessa], comprovante: [recusa('PROVA_INVALIDA_OU_EXPIRADA')] });
  try {
    await t.aceitar();
    // Botão da última tela renderizada; daqui até a recusa não há nova renderização nem efeitos (como antes do commit do React).
    const baixar = achar(t.ver(), 'button', 'Baixar comprovante — Buffet').props.onClick as () => void;
    tardio.soltar(pdf());
    await esperar(); // a recarga cria blob:3 e blob:4 e só agenda o estado
    assert.equal(t.criadas.length, 4, 'recarga terminou');
    baixar();
    await esperar();
    assertIdentificacao(t, ACEITE_REGISTRADO);
    assert.deepEqual([...new Set(t.revogadas)].sort(), ['blob:1', 'blob:2', 'blob:3', 'blob:4']);
  } finally { t.restaurar(); }
});

test('confirmação do código em voo e troca de contrato: nada é lido nem criado para o contrato anterior', async () => {
  const tardio = adiado();
  const t = await abrir({ confirmar: [() => tardio.promessa] }, false);
  try {
    (achar(t.ver(), 'button', 'Abrir documentos').props.onClick as () => void)();
    await esperar();
    t.trocarContrato();
    const pedido = t.sinais.filter((s) => s.rota === 'confirmar').at(-1);
    assert.equal(pedido?.signal?.aborted, true, 'confirmação em voo cancelada');
    tardio.soltar(json({ ok: true, provaToken: PROVA }));
    await esperar();
    assert.deepEqual(t.sinais.map((s) => s.rota), ['confirmar'], 'nenhuma leitura de documentos');
    assert.equal(t.criadas.length, 0, 'nenhum blob criado');
    const retido = JSON.stringify(t.estado(), (_k, v) => (v instanceof AbortController ? 'controle' : v));
    assert.ok(!retido.includes(PROVA), 'prova tardia fora do estado');
  } finally { t.restaurar(); }
});

test('troca de contrato com a leitura em voo: sessão encerrada e resposta tardia descartada', async () => {
  const tardio = adiado();
  const t = await abrir({ pdf: [() => tardio.promessa] }, false);
  try {
    (achar(t.ver(), 'button', 'Abrir documentos').props.onClick as () => void)();
    await esperar();
    t.trocarContrato();
    const pedidoPdf = t.sinais.filter((s) => s.rota === 'pdf').at(-1);
    assert.equal(pedidoPdf?.signal?.aborted, true, 'requisição em voo cancelada');
    tardio.soltar(pdf());
    await esperar();
    const pagina = texto(t.ver());
    assert.doesNotMatch(pagina, new RegExp(NOME));
    assert.equal(t.criadas.length, 0, 'nenhum blob criado');
  } finally { t.restaurar(); }
});

test('código errado: continua na etapa do código, sem limpar a tentativa', async () => {
  const t = await abrir({ confirmar: [() => json({ ok: false, erro: 'Código inválido.', codigo: 'PROVA_INVALIDA_OU_EXPIRADA' }, 400)] });
  try {
    const pagina = texto(t.ver());
    assert.match(pagina, /Código inválido\./);
    assert.doesNotMatch(pagina, EXPIRADA);
    achar(t.ver(), 'button', 'Abrir documentos');
    assert.ok(JSON.stringify(t.estado(), (_k, v) => (v instanceof AbortController ? 'controle' : v)).includes(ACESSO), 'acesso preservado para nova tentativa');
  } finally { t.restaurar(); }
});

test('troca de contrato entre a criação dos blobs da recarga e a renderização: os quatro blobs são revogados', async () => {
  const tardio = adiado();
  const t = await abrir({ pdf: [pdf, () => tardio.promessa] });
  try {
    await t.aceitar();
    tardio.soltar(pdf());
    await esperar(); // a recarga cria blob:3 e blob:4 e só agenda o estado; nenhuma renderização até a troca
    assert.equal(t.criadas.length, 4, 'recarga terminou');
    t.trocarContrato(); // como a desmontagem por key: só os efeitos da última tela renderizada rodam
    assert.deepEqual([...new Set(t.revogadas)].sort(), ['blob:1', 'blob:2', 'blob:3', 'blob:4']);
    // A tela nova vem da remontagem por key (pagina-contrato-sem-banco.test.ts); o harness reusa a instância.
  } finally { t.restaurar(); }
});
