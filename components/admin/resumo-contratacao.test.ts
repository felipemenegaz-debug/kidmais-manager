import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { montarResumo, selecionarVersaoResumo, type PainelResumo, type FinanceiroResumo } from './resumo-contratacao.ts';
import type { ContratoSnapshotV1 } from '../../lib/contratos/repositories/models';

const snapshot: ContratoSnapshotV1 = {
  schemaVersao: 1, fechamento: { id: 'fechamento', status: 'CONTRATO_ASSINADO', origem: 'ATENDIMENTO_KIDMAIS' },
  contratante: { clienteId: 'cliente', nomeCompleto: 'Cliente fictício', cpf: 'nao-exibir-cpf', rg: null, telefone: null, whatsapp: null, email: 'teste@example.invalid', endereco: { cep: '', logradouro: '', numero: '', complemento: null, bairro: '', cidade: '', uf: '' } },
  responsavelAdicional: null, aniversariante: { id: 'aniversariante', nome: 'Aniversariante fictício', dataNascimento: null, idadeNoEvento: 7, temaFesta: 'Espaço' },
  evento: { data: '2027-06-26', horarioInicio: '11:00:00', horarioFim: '15:00:00', pacote: { id: 'pacote', codigo: 'COMPLETA', nome: 'Festa Completa', duracaoMinutos: 240 }, convidados: 55, convidadosFaturados: 60 },
  contratacao: { adicionais: [{ adicionalId: 'adicional', nome: 'Adicional fictício', unidadeCobranca: 'unidade', quantidade: 2, valorUnitario: 50, valorTotal: 100, observacoes: 'Persistida' }], alteracoesPacote: 'Alteração congelada', observacoesCliente: 'Sem amendoim', observacoesEquipe: 'Recepção às 11h', buffet: { status: 'PENDENTE', salgados: null, bebidas: null, doces: null, bolo: null, outros: null } },
  comercial: { tabelaPreco: { id: 't', codigo: 't', nome: 'Tabela antiga' }, categoriaHorario: 'PADRAO', categoriaPrecoAplicada: 'PADRAO', valorPacoteBase: 10000, descontoPercentual: 0, valorDescontoPacote: 0, valorPacoteAplicado: 10000, valorAdicionais: 100, valorTabela: 10100, valorNegociado: null, valorAprovado: null, valorFinalContrato: 8811, formaPagamentoPretendida: 'PIX_AVISTA' },
};
function painel(): PainelResumo {
  return { contrato: { id: 'contrato', fechamento_id: 'fechamento', status: 'ASSINADO' }, fluxo: { versao_vigente_id: 'v2', versao_em_preparacao_id: 'v3' },
    versoes: [1, 2, 3].map(n => ({ id: `v${n}`, numero_versao: n, status: n === 3 ? 'ATIVA' : 'ASSINADA', estado_edicao: n === 3 ? 'EM_ELABORACAO' : 'CONCLUIDA', snapshot: { ...structuredClone(snapshot), contratante: { ...snapshot.contratante, nomeCompleto: `Cliente V${n}` } } })),
    assinaturas: [{ contrato_versao_id: 'v1', parte: 'CLIENTE', assinado_em: '2026-09-15T15:00:00Z', identidade_snapshot: { nome: 'Nome histórico' } }, ...['KIDMAIS', 'CLIENTE'].map(parte => ({ contrato_versao_id: 'v2', parte, assinado_em: '2026-09-21T15:00:00Z', identidade_snapshot: { nome: `Signatário ${parte}` } }))], financeiro: [],
  };
}
function financeiro(): FinanceiroResumo {
  return { contrato: { id: 'contrato' }, vigente: { id: 'v2' }, reconhecida: { id: 'v2' }, posicao: { obrigacao: '881100', liquido: '400000', saldo: '481100' }, cobranca: { encerrada: false }, planos: [{ id: 'p', status: 'ATIVO', numero_versao: 2 }, { id: 'antigo', status: 'SUBSTITUIDO', numero_versao: 1 }], parcelas: [{ id: 'parcela', plano_id: 'p', numero: 1, valor_previsto: '8811.00', vencimento: '2027-06-26', status: 'PARCIAL' }, { id: 'antiga', plano_id: 'antigo', numero: 1, valor_previsto: '999.00', vencimento: '2027-01-01', status: 'CANCELADA' }], cronograma: null, itens: [] };
}
const conteudo = (resumo: ReturnType<typeof montarResumo>) => JSON.stringify(resumo);
test('vigente usa V2 persistida, nunca a preparação V3 nem recálculo comercial', () => {
  const p = painel(), antes = JSON.stringify(p), r = montarResumo(p);
  assert.equal(r.classificacao, 'Versão vigente');
  assert.match(conteudo(r), /Cliente V2/);
  assert.doesNotMatch(conteudo(r), /Cliente V3|nao-exibir-cpf|example.invalid/);
  assert.match(conteudo(r), /8\.811,00/);
  assert.match(conteudo(r), /Convidados faturados","60/);
  assert.equal(JSON.stringify(p), antes);
});
test('histórica preserva seu snapshot e suas assinaturas sem importar financeiro atual', () => {
  const r = montarResumo(painel(), 'v1', financeiro());
  assert.equal(r.classificacao, 'Versão histórica');
  assert.match(conteudo(r), /Cliente V1|Nome histórico/);
  assert.doesNotMatch(conteudo(r), /Signatário|Recebido líquido/);
  assert.equal(r.parcelas.length, 0);
  assert.match(r.avisoFinanceiro, /histórica não congelada/);
});
test('preparação não é rotulada como vigente ou histórica; seletor inválido falha', () => {
  assert.match(montarResumo(painel(), 'v3').classificacao, /em preparação/);
  assert.throws(() => selecionarVersaoResumo(painel(), 'outra'), /não encontrada/);
  const p = painel(); p.versoes[1].snapshot.fechamento.id = 'outro';
  assert.throws(() => montarResumo(p), /inconsistente/);
});
test('buffet pendente e definido usam escolhas congeladas', () => {
  const p = painel();
  assert.match(conteudo(montarResumo(p)), /Pendente/);
  p.versoes[1].snapshot.contratacao.buffet = { status: 'DEFINIDO', salgados: 'Assados', bebidas: 'Sucos', doces: 'Brigadeiro', bolo: 'Chocolate', outros: 'Opção sem lactose', lembrancinha: 'Kit', empratado: 'Massa', bombom: 'Coco' };
  for (const texto of ['Definido', 'Assados', 'Sucos', 'Brigadeiro', 'Chocolate', 'Kit', 'Massa', 'Coco']) assert.ok(conteudo(montarResumo(p)).includes(texto));
});
test('sem plano não inventa saldo zero ou recebimento', () => {
  const r = montarResumo(painel());
  assert.match(r.avisoFinanceiro, /ainda não criado/);
  assert.equal(r.parcelas.length, 0);
  assert.doesNotMatch(conteudo(r), /Recebido líquido|Saldo a receber/);
});
for (const quitado of [false, true]) test(`plano existente ${quitado ? 'quitado' : 'parcial'} mantém valores do servidor`, () => {
  const p = painel(); p.financeiro = [{ id: 'pagamento' }];
  const f = financeiro(); if (quitado) { f.posicao.liquido = '881100'; f.posicao.saldo = '0'; f.parcelas[0].status = 'PAGA'; }
  const antes = JSON.stringify(f), r = montarResumo(p, 'v2', f);
  assert.equal(r.parcelas.length, 1);
  assert.equal(r.parcelas[0].vencimento, '26/06/2027');
  assert.equal(r.parcelas[0].estado, quitado ? 'PAGA' : 'PARCIAL');
  assert.match(conteudo(r), quitado ? /0,00/ : /4\.811,00/);
  assert.equal(JSON.stringify(f), antes);
});
test('financeiro de outra versão/contrato não é atribuído à versão selecionada', () => {
  const p = painel(); p.financeiro = [{ id: 'pagamento' }];
  for (const campo of ['contrato', 'vigente', 'reconhecida'] as const) {
    const f = financeiro(); f[campo].id = 'outra';
    const r = montarResumo(p, 'v2', f);
    assert.equal(r.parcelas.length, 0);
    assert.doesNotMatch(conteudo(r), /Recebido líquido/);
  }
});
test('cronograma reprogramado utiliza vencimentos e saldos iniciais persistidos', () => {
  const p = painel(); p.financeiro = [{ id: 'pagamento' }];
  const f = financeiro(); f.cronograma = { versao_referencia_id: 'v2', estado: 'ATIVO' }; f.itens = [{ parcela_id: 'parcela', saldo_inicial_centavos: '481100', vencimento_referencia: '2027-05-31' }];
  const r = montarResumo(p, 'v2', f);
  assert.equal(r.parcelas[0].vencimento, '31/05/2027');
  assert.match(r.parcelas[0].valor, /4\.811,00/);
});
test('assinaturas mostram somente nomes, parte e data da versão selecionada', () => {
  const r = montarResumo(painel()), secao = r.secoes.find(x => x.titulo === 'Assinaturas desta versão')!;
  assert.equal(secao.linhas.length, 2);
  assert.ok(secao.linhas.every(([, value]) => value.includes('21/09/2026') && value.includes('12:00')));
  assert.doesNotMatch(conteudo(r), /pdf_hash|snapshot_hash|token|comprovante_documento_id/);
});
test('impressão renderiza resumo separado, escapa observações e possui regras A4 sem menu', () => {
  const source = readFileSync(new URL('./ResumoContratacao.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} as { DocumentoResumo: (props: { resumo: ReturnType<typeof montarResumo> }) => React.ReactNode } };
  new Function('require', 'module', 'exports', output)((name: string) => name === 'react/jsx-runtime' ? jsx : name.includes('KidmaisBrand') ? { default: () => jsx.jsx('div', { children: 'Kidmais' }) } : name.endsWith('.css') ? { default: {} } : {}, mod, mod.exports);
  const p = painel(); p.versoes[1].snapshot.contratacao.observacoesEquipe = '<script>naoExecutar()</script>';
  const html = renderToStaticMarkup(jsx.jsx(mod.exports.DocumentoResumo, { resumo: montarResumo(p) }));
  assert.match(html, /Não substitui o contrato jurídico/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<form|<input|<iframe/);
  const css = readFileSync(new URL('./resumo-contratacao.module.css', import.meta.url), 'utf8');
  assert.match(css, /size: A4/); assert.match(css, /@media print/); assert.match(css, /Menu administrativo/); assert.match(css, /display: none !important/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)|gerarPdf|guardarDocumento/);
  const admin = readFileSync(new URL('./ContratoAdmin.tsx', import.meta.url), 'utf8');
  assert.match(admin, /Visualizar resumo/); assert.match(admin, /Imprimir resumo/); assert.match(admin, /Imprimir contrato completo/);
});
