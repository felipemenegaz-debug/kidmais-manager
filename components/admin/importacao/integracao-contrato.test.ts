import assert from 'node:assert/strict';
import test from 'node:test';
import * as form from './integracao-form.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

const IMP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const opcoes = {
  disponivel: true, hoje: '2026-10-02', integracao: null,
  cliente: { id: 'c1', nome: 'Ana Souza', ativo: true },
  documento: { pacote: 'Festa Completa 2019', aniversariante: 'Lia', tema: 'Fundo do mar' },
  sugestao: { evento: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, valorContratadoCentavos: 850000, condicaoDocumento: 'Entrada de 30% e saldo à vista', parcelasPrevistas: [{ valorCentavos: 255000, vencimento: '2026-08-01' }, { valorCentavos: 595000, vencimento: '2026-11-14' }] },
  estabelecimentos: [{ id: 'u1', nome: 'Unidade Centro' }],
  pacotes: [{ id: 'p1', codigo: 'COMPLETA', nome: 'Festa Completa', duracaoMinutos: 240, ativo: true }],
  formas: ['PIX'], declaracao: 'Conferi o documento original assinado em papel.',
};
const resumo = {
  contrato: { cliente: 'Ana Souza', pacoteDocumento: 'Festa Completa 2019', pacoteReferencia: 'Festa Completa (COMPLETA)', unidade: 'Unidade Centro', valorContratadoCentavos: 850000, conferencia: 'Contrato assinado em papel.' },
  festa: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80, aniversariante: 'Lia', tema: 'Fundo do mar', aniversarianteCadastro: 'NOVO' },
  agenda: { ocupa: true, descricao: 'Ocupa a agenda em 14/11/2026, das 14:00 às 18:00 (Unidade Centro).' },
  financeiro: { situacao: 'PARCIALMENTE_PAGO', contratadoCentavos: 850000, recebidoCentavos: 255000, saldoCentavos: 595000, parcelas: [], recebimentos: [{ numero: 1, valorCentavos: 255000, data: '2026-08-03', forma: 'PIX' }], aReceber: [{ numero: 2, valorCentavos: 595000, vencimento: '2026-11-14', situacao: 'A_RECEBER', recebidaEm: null, forma: null }] },
  campos: [],
};

type Vinculo = { fechamentoId: string; contratoId: string | null; status: string; data?: string; alcance?: string; horario: string; comPagamento: boolean; importado: boolean; sinais: string[] };
function montar(confirmarResposta: () => Promise<unknown>, opcoesTeste: { reautenticacao?: unknown; vinculos?: Vinculo[]; integracao?: unknown } = {}) {
  const chamadas: Array<{ fn: string; args: unknown[] }> = [];
  const Link = 'a';
  const tela = carregarComponente('components/admin/importacao/IntegracaoContrato.tsx', {
    'next/link': { default: Link },
    '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    './integracao-form': form,
    './importacao.module.css': cssFalso, './integracao.module.css': cssFalso,
    './cliente-integracao': {
      lerOpcoes: async () => ({ ok: true, dados: { ...structuredClone(opcoes), ...(opcoesTeste.integracao ? { integracao: opcoesTeste.integracao } : {}) } }),
      novaChave: () => '88888888-8888-4888-8888-888888888888',
      simular: async (...args: unknown[]) => { chamadas.push({ fn: 'simular', args }); const d = args[2] as { conferenciaDeclarada: boolean; outroContratoConfirmado: boolean; motivoOutroContrato: string };
        const vinculos = opcoesTeste.vinculos ?? [];
        const decidido = !vinculos.length || (d.outroContratoConfirmado && d.motivoOutroContrato.length >= 5);
        return { ok: true, dados: { integrada: false, pronto: decidido, bloqueios: decidido ? [] : ['Há uma contratação parecida nesta empresa neste dia.'], avisos: d.conferenciaDeclarada ? [] : ['Para confirmar, declare a conferência do documento original.'], resumo, resumoHash: d.conferenciaDeclarada ? 'b'.repeat(64) : 'a'.repeat(64), possiveisVinculos: vinculos } }; },
      confirmar: async (...args: unknown[]) => { chamadas.push({ fn: 'confirmar', args }); return confirmarResposta(); },
      reautenticar: async (...args: unknown[]) => { chamadas.push({ fn: 'reautenticar', args }); return opcoesTeste.reautenticacao ?? { ok: true, dados: { csrf: 'x' } }; },
      simularFinanceiro: async () => { throw Error('não usado'); },
      conferirFinanceiro: async () => { throw Error('não usado'); },
    },
  });
  return { tela, chamadas };
}

const evento = (value: unknown, checked?: boolean) => ({ target: { value, checked } });
/** Expande os subcomponentes puros do módulo (sem hooks), que o harness deixa como elementos. */
const SUBCOMPONENTES = new Set(['Erros', 'ResumoPagamentos', 'Concluida']);
function expandir(no: unknown): unknown {
  if (Array.isArray(no)) return no.map(expandir);
  if (!no || typeof no !== 'object') return no;
  const e = no as Elemento;
  if (typeof e.type === 'function' && SUBCOMPONENTES.has((e.type as { name: string }).name)) return expandir((e.type as (p: unknown) => unknown)(e.props));
  return { ...e, props: { ...e.props, children: expandir(e.props?.children) } };
}
const radio = (arvore: unknown, rotulo: RegExp) => {
  const label = elementos(arvore).find((e) => e.type === 'label' && rotulo.test(texto(e)))!;
  return elementos(label.props.children).find((e) => e.type === 'input') as Elemento;
};
async function carregar(tela: ReturnType<typeof montar>['tela']) {
  tela.render('default', { importacaoId: IMP }); tela.efeitos(); await tique();
  return tela.render('default', { importacaoId: IMP });
}
const ver = (tela: ReturnType<typeof montar>['tela']) => expandir(tela.render('default', { importacaoId: IMP }));

test('festa e agenda: situação começa em branco; cancelado não vira festa e não avança', async () => {
  const { tela } = montar(async () => ({ ok: true, dados: {} }));
  let a = await carregar(tela);
  assert.equal((achar(a, 'button', 'Continuar para pagamentos').props.disabled), true);
  assert.equal(radio(a, /Vigente/).props.checked, false);
  (radio(a, /Cancelado/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  assert.match(texto(a), /Contrato cancelado ou não confirmado não vira festa e não ocupa agenda/);
  assert.equal(achar(a, 'button', 'Continuar para pagamentos').props.disabled, true);
});

test('fluxo completo: pagamentos conferidos, revisão do servidor, declaração obrigatória e sucesso só após a resposta', async () => {
  let liberar!: (v: unknown) => void;
  const { tela, chamadas } = montar(() => new Promise((r) => { liberar = r; }));
  let a = await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  const pacote = elementos(a).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!;
  (pacote.props.onChange as (e: unknown) => void)(evento('p1'));
  a = ver(tela);
  (achar(a, 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  a = ver(tela);
  assert.match(texto(a), /não comprova que algo foi pago/);
  (r(/Parte foi paga/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  (achar(a, 'input', 'Parcela 1 foi recebida').props.onChange as (e: unknown) => void)(evento('on', true));
  a = ver(tela);
  (achar(a, 'input', 'Data em que a parcela 1 foi recebida').props.onChange as (e: unknown) => void)(evento('2026-08-03'));
  a = ver(tela);
  (achar(a, 'select', 'Forma da parcela 1').props.onChange as (e: unknown) => void)(evento('PIX'));
  a = ver(tela);
  (achar(a, 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  assert.match(texto(a), /Revisão final/);
  assert.match(texto(a), /Ocupa a agenda em 14\/11\/2026/);
  assert.match(texto(a), /Parcela 1: R\$ 2\.550,00 em 03\/08\/2026 · Pix/);
  assert.match(texto(a), /Parcela 2: R\$ 5\.950,00, vence 14\/11\/2026/);
  const decisoes = chamadas.find((c) => c.fn === 'simular')!.args[2] as Record<string, unknown>;
  assert.deepEqual(Object.keys(decisoes).sort(), ['conferenciaDeclarada', 'estabelecimentoId', 'evento', 'financeiro', 'motivoOutroContrato', 'motivos', 'outroContratoConfirmado', 'pacoteReferenciaId', 'situacaoContrato', 'valorContratadoCentavos']);
  assert.equal(achar(a, 'button', 'Confirmar integração').props.disabled, true, 'sem declaração não confirma');
  const declaracao = elementos(a).find((e) => e.type === 'label' && /Conferi o documento original/.test(texto(e)))!;
  (elementos(declaracao.props.children).find((e) => e.type === 'input')!.props.onChange as (e: unknown) => void)(evento('on', true));
  await tique();
  a = ver(tela);
  assert.equal(achar(a, 'button', 'Confirmar integração').props.disabled, true, 'sem senha não confirma (autenticação recente)');
  (achar(a, 'input', 'Senha para confirmar').props.onChange as (e: unknown) => void)(evento('senha-do-operador'));
  a = ver(tela);
  (achar(a, 'button', 'Confirmar integração').props.onClick as () => void)();
  await tique(); await tique();
  a = ver(tela);
  assert.doesNotMatch(texto(a), /Contrato integrado ao sistema/, 'nada de sucesso antes da resposta');
  // A senha vai só para a reautenticação nativa, antes da confirmação, e não fica na tela.
  const ordem = chamadas.map((c) => c.fn).filter((fn) => fn !== 'simular');
  assert.deepEqual(ordem, ['reautenticar', 'confirmar']);
  assert.equal(chamadas.find((c) => c.fn === 'reautenticar')!.args[1], 'senha-do-operador');
  assert.ok(!JSON.stringify(chamadas.find((c) => c.fn === 'confirmar')!.args).includes('senha-do-operador'));
  assert.equal(achar(a, 'input', 'Senha para confirmar').props.value, '');
  const conf = chamadas.find((c) => c.fn === 'confirmar')!;
  assert.deepEqual([conf.args[3], conf.args[4]], ['b'.repeat(64), '88888888-8888-4888-8888-888888888888']);
  liberar({ ok: true, dados: { reutilizado: false, contratoId: 'k1', festaId: 'f1', agendaOcupada: true, financeiro: { situacao: 'PARCIALMENTE_PAGO', pendente: false, recebidoCentavos: 255000, saldoCentavos: 595000 } } });
  await tique(); await tique();
  a = ver(tela);
  assert.match(texto(a), /Contrato integrado ao sistema/);
  assert.match(texto(a), /Festa criada e agenda ocupada/);
  assert.match(texto(a), /R\$ 2\.550,00 recebidos e R\$ 5\.950,00 a receber/);
  assert(elementos(a).some((e) => e.type === 'a' && e.props.href === '/admin/contratos?contratoId=k1'));
});

test('resumo desatualizado ou conflito: mostra o motivo, recalcula e não anuncia sucesso', async () => {
  const { tela, chamadas } = montar(async () => ({ ok: false, mensagem: 'O horário ficou indisponível na agenda durante a confirmação. Nada foi gravado.', codigo: 'CONFLITO_AGENDA', detalhes: null }));
  let a = await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  (elementos(a).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!.props.onChange as (e: unknown) => void)(evento('p1'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  (r(/Ainda não conferi/).props.onChange as (e: unknown) => void)(evento('on'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  const declaracao = elementos(a).find((e) => e.type === 'label' && /Conferi o documento original/.test(texto(e)))!;
  (elementos(declaracao.props.children).find((e) => e.type === 'input')!.props.onChange as (e: unknown) => void)(evento('on', true));
  await tique();
  (achar(tela.render('default', { importacaoId: IMP }), 'input', 'Senha para confirmar').props.onChange as (e: unknown) => void)(evento('senha'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Confirmar integração').props.onClick as () => void)();
  await tique(); await tique(); await tique();
  a = ver(tela);
  assert.match(texto(a), /O horário ficou indisponível na agenda/);
  assert.doesNotMatch(texto(a), /Contrato integrado ao sistema/);
  assert.ok(chamadas.filter((c) => c.fn === 'simular').length >= 3, 'recalcula o resumo depois da recusa');
  const ultimo = chamadas.filter((c) => c.fn === 'simular').at(-1)!.args[2] as { financeiro: unknown };
  assert.deepEqual(ultimo.financeiro, { situacao: 'NAO_CONFERIDO' });
});

/** Leva a tela até a revisão final (pagamentos não conferidos) e devolve a árvore. */
async function ateRevisao(tela: ReturnType<typeof montar>['tela']) {
  await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  (elementos(ver(tela)).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!.props.onChange as (e: unknown) => void)(evento('p1'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  (r(/Ainda não conferi/).props.onChange as (e: unknown) => void)(evento('on'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  const a = ver(tela);
  const declaracao = elementos(a).find((e) => e.type === 'label' && /Conferi o documento original/.test(texto(e)))!;
  (elementos(declaracao.props.children).find((e) => e.type === 'input')!.props.onChange as (e: unknown) => void)(evento('on', true));
  await tique();
  return ver(tela);
}

test('autenticação recente: senha recusada não confirma nada e mostra o motivo', async () => {
  const { tela, chamadas } = montar(async () => ({ ok: true, dados: {} }), { reautenticacao: { ok: false, mensagem: 'Senha inválida.', codigo: null, detalhes: null } });
  let a = await ateRevisao(tela);
  (achar(a, 'input', 'Senha para confirmar').props.onChange as (e: unknown) => void)(evento('errada'));
  (achar(ver(tela), 'button', 'Confirmar integração').props.onClick as () => void)();
  await tique(); await tique();
  a = ver(tela);
  assert.match(texto(a), /Senha inválida\./);
  assert.ok(!chamadas.some((c) => c.fn === 'confirmar'), 'sem reautenticação não há confirmação');
  assert.doesNotMatch(texto(a), /Contrato integrado ao sistema/);
});

test('possível duplicidade: mostra os sinais; "é outro contrato" exige motivo e vai ao servidor na decisão', async () => {
  const vinculos = [{ fechamentoId: 'f9', contratoId: 'k9', status: 'ASSINADO', horario: '14:00–18:00', comPagamento: true, importado: true, sinais: ['MESMO_ANIVERSARIANTE', 'MESMO_VALOR'] }];
  const { tela, chamadas } = montar(async () => ({ ok: true, dados: {} }), { vinculos });
  let a = await ateRevisao(tela);
  assert.match(texto(a), /Possível duplicidade/);
  assert.match(texto(a), /contrato importado · com pagamentos — mesmo aniversariante, mesmo valor/);
  (achar(a, 'input', 'Senha para confirmar').props.onChange as (e: unknown) => void)(evento('senha'));
  a = ver(tela);
  assert.equal(achar(a, 'button', 'Confirmar integração').props.disabled, true, 'sem decisão o servidor não libera');
  (achar(a, 'input', 'É outro contrato').props.onChange as (e: unknown) => void)(evento('on', true));
  a = ver(tela);
  assert.equal(achar(a, 'button', 'Registrar decisão').props.disabled, true, 'motivo obrigatório');
  (achar(a, 'input', 'Motivo: é outro contrato').props.onChange as (e: unknown) => void)(evento('Festa da irmã gêmea'));
  a = ver(tela);
  (achar(a, 'button', 'Registrar decisão').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  const ultima = chamadas.filter((c) => c.fn === 'simular').at(-1)!.args[2] as { outroContratoConfirmado: boolean; motivoOutroContrato: string };
  assert.deepEqual([ultima.outroContratoConfirmado, ultima.motivoOutroContrato], [true, 'Festa da irmã gêmea']);
  assert.equal(achar(a, 'button', 'Confirmar integração').props.disabled, false);
});

test('possível duplicidade em OUTRA data: mostra a data do candidato e os sinais de data; a decisão continua explícita', async () => {
  const vinculos = [{ fechamentoId: 'f8', contratoId: 'k8', status: 'ASSINADO', data: '2026-11-21', alcance: 'OUTRA_DATA', horario: '14:00–18:00', comPagamento: false, importado: true, sinais: ['MESMO_CONTATO', 'MESMO_ANIVERSARIANTE', 'DATA_PROXIMA'] }];
  const { tela } = montar(async () => ({ ok: true, dados: {} }), { vinculos });
  const a = await ateRevisao(tela);
  assert.match(texto(a), /nesta empresa neste dia ou em outra data/);
  assert.match(texto(a), /21\/11\/2026, 14:00–18:00 · assinado · contrato importado — mesmo CPF ou telefone em outro cadastro, mesmo aniversariante, data próxima/);
  (achar(a, 'input', 'Senha para confirmar').props.onChange as (e: unknown) => void)(evento('senha'));
  assert.equal(achar(ver(tela), 'button', 'Confirmar integração').props.disabled, true, 'sem decisão o servidor não libera');
});

test('exceção histórica: parcela que vence depois da festa só segue com a confirmação explícita, por parcela', async () => {
  const { tela, chamadas } = montar(async () => ({ ok: true, dados: {} }));
  await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  (elementos(ver(tela)).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!.props.onChange as (e: unknown) => void)(evento('p1'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  (r(/Nada foi pago/).props.onChange as (e: unknown) => void)(evento('on'));
  let a = ver(tela);
  assert.ok(!elementos(a).some((e) => e.type === 'input' && /vence depois da festa/.test(String(e.props['aria-label']))), 'sem parcela pós-festa, sem exceção');
  (achar(a, 'input', 'Vencimento da parcela 2').props.onChange as (e: unknown) => void)(evento('2026-12-15'));
  a = ver(tela);
  const excecao = achar(a, 'input', 'Parcela 2 vence depois da festa conforme o contrato original');
  assert.equal(excecao.props.checked, false);
  (achar(a, 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  const semConfirmar = chamadas.filter((c) => c.fn === 'simular').at(-1)!.args[2] as { financeiro: { parcelas: Array<Record<string, unknown>> } };
  assert.equal('aposFestaConfirmada' in semConfirmar.financeiro.parcelas[1], false, 'não confirma por padrão');
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Voltar e corrigir').props.onClick as () => void)();
  (achar(ver(tela), 'input', 'Parcela 2 vence depois da festa conforme o contrato original').props.onChange as (e: unknown) => void)(evento('on', true));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  const confirmada = chamadas.filter((c) => c.fn === 'simular').at(-1)!.args[2] as { financeiro: { parcelas: Array<Record<string, unknown>> } };
  assert.deepEqual([confirmada.financeiro.parcelas[0].aposFestaConfirmada, confirmada.financeiro.parcelas[1].aposFestaConfirmada, confirmada.financeiro.parcelas[1].vencimento],
    [undefined, true, '2026-12-15'], 'só a parcela pós-festa, com o vencimento informado (nada ajustado)');
});

test('contrato já integrado: o caminho financeiro correto aparece; "Conferir pagamentos" só na versão conferida', async () => {
  const integracao = (caminhoFinanceiro: string, financeiroPendente: boolean) => ({ contratoId: 'k1', financeiroPendente, caminhoFinanceiro, valorContratadoCentavos: 850000 });
  const casos: Array<[string, boolean, RegExp, boolean]> = [
    ['CONFERIR_HISTORICO', true, /ainda não foram conferidos/, true],
    ['CONCLUIDO', false, /Os pagamentos estão no Financeiro do contrato/, false],
    ['PLANO_NA_VERSAO_VIGENTE', true, /revisado depois da integração/, false],
    ['AGUARDAR_REVISAO', true, /revisão do contrato em andamento/, false],
  ];
  for (const [caminho, pendente, esperado, conferir] of casos) {
    const { tela } = montar(async () => ({ ok: true, dados: {} }), { integracao: integracao(caminho, pendente) });
    const a = expandir(await carregar(tela));
    assert.match(texto(a), esperado, caminho);
    assert.equal(elementos(a).some((e) => e.type === 'button' && /Conferir pagamentos/.test(texto(e))), conferir, caminho);
    const financeiro = elementos(a).some((e) => e.type === 'a' && e.props.href === '/admin/contratos?contratoId=k1#financeiro');
    assert.equal(financeiro, caminho === 'CONCLUIDO' || caminho === 'PLANO_NA_VERSAO_VIGENTE', caminho);
  }
});
