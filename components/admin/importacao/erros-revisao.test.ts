import assert from 'node:assert/strict';
import test from 'node:test';
import { ARQUIVO } from '../../../lib/importacao-contrato/apoio.test.ts';
import { extrairPorRegras } from '../../../lib/importacao-contrato/extracao.ts';
import { montarPlano } from '../../../lib/importacao-contrato/plano.ts';
import { montarRevisao } from '../../../lib/importacao-contrato/rascunho.ts';
import { errosDaRevisao, ID_CLIENTE_REVISAO, ID_SECAO_ENDERECO, idCampoRevisao, type PlanoPublico } from './cliente-importacao.ts';
import { focarPrimeiroErro, idMensagemErro, mapaErros, propsCampo, resumoErros } from '../../../lib/ui/erros-formulario.ts';

/** N1/N2: cada pendência da revisão aponta para o controle exato; o mecanismo comum marca, resume e foca. */
const NOVO = { estado: 'NOVO_CLIENTE' as const, clienteId: null, candidatos: [], motivo: '' };
const publico = (p: ReturnType<typeof montarPlano>) => p as unknown as PlanoPublico;

test('errosDaRevisao: campo a confirmar, data ausente e tipo de pessoa apontam para o controle; plano pronto não tem erro', () => {
  const paginas = ['CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.'];
  const extracao = montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO);
  const plano = montarPlano(extracao, [], NOVO, null);
  const erros = errosDaRevisao({ extracao, revisados: [] }, publico(plano));
  const ids = erros.map((e) => e.campo);
  assert.ok(ids.includes(idCampoRevisao('evento.data')), JSON.stringify(erros));
  assert.equal(erros.find((e) => e.campo === idCampoRevisao('evento.data'))?.mensagem, 'Informe a data da festa.');
  for (const e of erros) assert.ok(e.campo.startsWith('revisao-'), e.campo);
  assert.equal(new Set(erros.map((e) => e.mensagem)).size, erros.length, 'bloqueio já coberto por um campo não se repete');
  assert.deepEqual(errosDaRevisao({ extracao, revisados: [] }, { ...publico(plano), pronto: true }), []);
  assert.deepEqual(errosDaRevisao({ extracao, revisados: [] }, null), []);
});

test('errosDaRevisao: recusa PJ no tipo de pessoa; endereço incompleto na seção; outro bloqueio no bloco do cliente', () => {
  const paginas = ['CONTRATANTE: Paula Ramos, CPF 529.982.247-25.\nData do evento: 10/12/2026'];
  const extracao = montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO);
  const base = { ...publico(montarPlano(extracao, [], NOVO, null)), pronto: false, tipoPessoa: 'PJ' as const };
  const recusa = { codigo: 'PJ_INDISPONIVEL' as const, motivo: 'ENTREGA_A' as const, mensagem: 'Contratante pessoa jurídica ainda não pode ser importado.' };
  const erros = errosDaRevisao({ extracao, revisados: [] }, { ...base, recusa, bloqueios: [recusa.mensagem, 'Endereço incompleto: falta número.', 'Cliente parecido já cadastrado.'] } as PlanoPublico);
  assert.deepEqual(erros.find((e) => e.campo === idCampoRevisao('contratante.tipoPessoa')), { campo: idCampoRevisao('contratante.tipoPessoa'), mensagem: recusa.mensagem });
  assert.equal(erros.filter((e) => e.mensagem === recusa.mensagem).length, 1);
  assert.ok(erros.some((e) => e.campo === ID_SECAO_ENDERECO && /número/.test(e.mensagem)));
  assert.ok(erros.some((e) => e.campo === ID_CLIENTE_REVISAO && /parecido/.test(e.mensagem)));
});

test('mecanismo comum: mapa pela primeira mensagem, atributos ARIA e resumo sem repetição', () => {
  const erros = [{ campo: 'a', mensagem: 'Informe A.' }, { campo: 'a', mensagem: 'Outra.' }, { campo: 'b', mensagem: 'Informe A.' }];
  assert.deepEqual(mapaErros(erros), { a: 'Informe A.', b: 'Informe A.' });
  assert.deepEqual(resumoErros(erros), [{ campo: 'a', mensagem: 'Informe A.' }, { campo: 'a', mensagem: 'Outra.' }]);
  assert.deepEqual(propsCampo('cliente-cpf', 'CPF inválido.', 'cliente-cpf-dica'), { id: 'cliente-cpf', 'aria-invalid': true, 'aria-describedby': `${idMensagemErro('cliente-cpf')} cliente-cpf-dica` });
  assert.deepEqual(propsCampo('cliente-cpf', null), { id: 'cliente-cpf', 'aria-invalid': undefined, 'aria-describedby': undefined });
});

function documentoFalso(presentes: string[]) {
  const eventos: string[] = [];
  const quadros: Array<() => void> = [];
  const doc = {
    getElementById: (id: string) => presentes.includes(id)
      ? { scrollIntoView: (o: { block: string }) => eventos.push(`rolar:${id}:${o.block}`), focus: () => eventos.push(`foco:${id}`) }
      : null,
    defaultView: { matchMedia: () => ({ matches: true }), requestAnimationFrame: (f: () => void) => { quadros.push(f); return quadros.length; } },
  };
  const rodarQuadros = () => { while (quadros.length) quadros.shift()!(); };
  return { doc: doc as never, eventos, rodarQuadros };
}

test('focarPrimeiroErro: abre a etapa, espera dois quadros, rola e foca o primeiro; sem o campo, foca o resumo', () => {
  const abertos: string[] = [];
  const f = documentoFalso(['campo-1', 'resumo']);
  focarPrimeiroErro([{ campo: 'campo-1', mensagem: 'x' }, { campo: 'campo-2', mensagem: 'y' }], { abrir: (c) => abertos.push(c), resumoId: 'resumo', doc: f.doc });
  assert.deepEqual(abertos, ['campo-1']);
  assert.deepEqual(f.eventos, [], 'nada antes de a etapa ser pintada');
  f.rodarQuadros();
  assert.deepEqual(f.eventos, ['rolar:campo-1:center', 'foco:campo-1']);

  const g = documentoFalso(['resumo']);
  focarPrimeiroErro([{ campo: '', mensagem: 'Adicional pendente.' }], { resumoId: 'resumo', doc: g.doc });
  g.rodarQuadros();
  assert.deepEqual(g.eventos, ['rolar:resumo:center', 'foco:resumo']);

  assert.doesNotThrow(() => focarPrimeiroErro([], { doc: g.doc }));
  assert.doesNotThrow(() => focarPrimeiroErro([{ campo: 'x', mensagem: 'y' }]), 'sem DOM (teste/servidor) não quebra');
});
