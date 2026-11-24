import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, cssFalso, elementos, texto } from '../teste-componente.ts';

// 24/11/2026: contato registrado sem origem nasce "desconhecida (sem evidência)". No painel do CONTATO, informar a primeira
// origem de verdade é "Informar origem", sem pedir motivo à equipe (o histórico recebe um motivo fixo, exigido pelo domínio).
// Cliente e negociação seguem como antes: com origem vigente, qualquer troca é "Corrigir origem" com motivo.
const VIGENTE_ID = '77777777-7777-4777-8777-777777777777';
const ALVO = '44444444-4444-4444-8444-444444444444';

function painel(alvoTipo: string, metodo: string) {
  const enviados: Array<Record<string, unknown>> = [];
  const dados = {
    vigente: { id: VIGENTE_ID, origemCodigo: metodo === 'DESCONHECIDO' ? 'DESCONHECIDA' : 'GOOGLE', metodo, canalAtendimento: 'TELEFONE', campanhaId: null, campanhaNome: null, detalhe: null,
      registradoEm: '2026-11-24T10:00:00Z', registradoPorNome: null, vigente: true },
    historico: [], origens: [{ codigo: 'INDICACAO', rotulo: 'Indicação', ativa: true, ordem: 1, personalizada: false }], campanhas: [],
  };
  const h = carregarComponente('components/admin/marketing/OrigemPainel.tsx', {
    '@/lib/marketing/apresentacao': { dataHoraBr: (v: string) => v },
    './comum': { useMarketing: () => ({ dados, falha: null, carregando: false, recarregar: () => undefined }), enviarMarketing: async (_u: string, corpo: Record<string, unknown>) => { enviados.push(corpo); return {}; } },
    './marketing.module.css': cssFalso,
  });
  const props = { alvoTipo, alvoId: ALVO };
  const render = () => h.render('default', props);
  const botao = (rotulo: string) => elementos(render()).find((e) => e.type === 'button' && texto(e) === rotulo);
  return { render, botao, enviados };
}

test('CONTATO sem evidência: "Informar origem", sem campo de motivo; envia correção com motivo fixo', async () => {
  const p = painel('CONTATO', 'DESCONHECIDO');
  assert.equal(p.botao('Corrigir origem'), undefined);
  (p.botao('Informar origem')!.props.onClick as () => void)();
  assert.doesNotMatch(texto(p.render()), /Motivo da correção/);
  const origem = elementos(p.render()).find((e) => e.type === 'select' && e.props.required)!;
  (origem.props.onChange as (e: unknown) => void)({ target: { value: 'INDICACAO' } });
  const form = elementos(p.render()).find((e) => e.type === 'form')!;
  await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  assert.equal(p.enviados.length, 1);
  assert.equal(p.enviados[0].alvoTipo, 'CONTATO');
  assert.equal(p.enviados[0].origemCodigo, 'INDICACAO');
  assert.equal(p.enviados[0].corrigeId, VIGENTE_ID);
  assert.ok(String(p.enviados[0].motivo).trim().length >= 3, 'o domínio exige motivo na troca');
});

for (const [alvoTipo, metodo] of [['CONTATO', 'INFORMADO'], ['CLIENTE', 'DESCONHECIDO'], ['FECHAMENTO', 'DESCONHECIDO']] as const) {
  test(`${alvoTipo} com origem ${metodo}: continua "Corrigir origem" com motivo obrigatório`, () => {
    const p = painel(alvoTipo, metodo);
    assert.equal(p.botao('Informar origem'), undefined);
    (p.botao('Corrigir origem')!.props.onClick as () => void)();
    const motivo = elementos(p.render()).find((e) => e.type === 'label' && /Motivo da correção/.test(texto(e)));
    assert.ok(motivo);
    assert.equal(elementos(motivo).find((e) => e.type === 'input')!.props.required, true);
  });
}
