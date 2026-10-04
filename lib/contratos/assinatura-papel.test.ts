import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { versaoAssinadaEmPapel } from './assinatura-papel.ts';
import { renderizarContratoTemplateV1 } from './documento/template-v1.ts';

/** Contrato histórico assinado em papel (061): nenhuma tela ou documento o apresenta como assinatura eletrônica. */
test('regra única: CONFERENCIA_PAPEL ou snapshot de origem histórica; versão nativa nunca', () => {
  assert.equal(versaoAssinadaEmPapel({ aceiteMetodo: 'CONFERENCIA_PAPEL' }), true);
  assert.equal(versaoAssinadaEmPapel({ aceite_metodo: 'CONFERENCIA_PAPEL' }), true);
  assert.equal(versaoAssinadaEmPapel({ snapshot: { origem: { tipo: 'IMPORTACAO_HISTORICA' } } }), true);
  assert.equal(versaoAssinadaEmPapel({ aceiteMetodo: 'OTP', snapshot: { fechamento: { origem: 'CLIENTE' } } }), false);
  assert.equal(versaoAssinadaEmPapel(null), false);
});

test('página pública: contexto de papel sem fluxo de assinatura, sem documento e sem comprovante fictício', () => {
  const svc = readFileSync('lib/contratos/services/contrato-publico.service.ts', 'utf8');
  const contexto = svc.slice(svc.indexOf('export async function montarContextoContratoPublico('), svc.indexOf('export async function gerarPdfContratoPublico('));
  // Papel é decidido antes de qualquer leitura de documento; aceite nunca permitido.
  assert.ok(contexto.indexOf('versaoAssinadaEmPapel(versao)') >= 0 && contexto.indexOf('versaoAssinadaEmPapel(versao)') < contexto.indexOf('lerDocumento(versao)'));
  assert.match(contexto, /aceitePermitido:\s+!papel &&/);
  assert.match(contexto, /assinatura: papel \? \{ tipo: 'PAPEL' as const/);
  const pdf = svc.slice(svc.indexOf('export async function gerarPdfContratoPublico('));
  assert.ok(pdf.indexOf('contratoEmPapel()') < pdf.indexOf('documentoParaLeitura(versao)'), 'PDF: recusa antes de procurar documento');
  const assinar = svc.slice(svc.indexOf('export async function assinarContratoPublico('));
  assert.ok(assinar.indexOf('contratoEmPapel()') < assinar.indexOf('documentoParaLeitura(versao,tx)'), 'assinatura: recusa antes de qualquer etapa');
  assert.doesNotMatch(svc.slice(svc.indexOf('function contratoEmPapel')), /^\s*INSERT/m);
  const tela = readFileSync('components/contrato/ContratoPublico.tsx', 'utf8');
  const ramo = tela.indexOf('contexto.assinatura?.tipo === "PAPEL" ? (');
  assert.ok(ramo >= 0 && ramo < tela.indexOf('Aceitar e assinar eletronicamente'), 'ramo de papel substitui o bloco de aceite');
  assert.match(tela, /"Assinado em papel" : contexto\.contrato\.status === "ASSINADO"/);
});

const snapshotBase = {
  schemaVersao: 1, fechamento: { id: 'f', status: 'CONFIRMADO', origem: 'IMPORTACAO_HISTORICA' },
  contratante: { clienteId: 'c', nomeCompleto: 'Cliente', cpf: null, rg: null, telefone: null, whatsapp: null, email: null, endereco: { cep: '', logradouro: '', numero: '', complemento: null, bairro: '', cidade: '', uf: '' } },
  responsavelAdicional: null, aniversariante: { id: null, nome: 'Lia', dataNascimento: null, idadeNoEvento: null, temaFesta: null },
  evento: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', pacote: { id: 'p', codigo: 'X', nome: 'Pacote', duracaoMinutos: 240 }, convidados: 50, convidadosFaturados: 50 },
  contratacao: { adicionais: [], alteracoesPacote: null, observacoesCliente: null, observacoesEquipe: null, buffet: { status: 'PENDENTE' } },
  comercial: { valorFinalContrato: 5000, valorTabela: 5000, valorPacoteAplicado: 5000, valorAdicionais: 0, formaPagamentoPretendida: null },
};

test('resumo em PDF: versão histórica diz "assinado em papel"; o texto nativo (aceite eletrônico) fica idêntico', () => {
  const texto = (snapshot: unknown) => JSON.stringify(renderizarContratoTemplateV1({ snapshot: snapshot as never, numeroVersao: 1, snapshotHash: 'h' }));
  const historico = texto({ ...snapshotBase, origem: { tipo: 'IMPORTACAO_HISTORICA' } });
  assert.match(historico, /Contrato assinado em papel, conferido pela Kidmais/);
  assert.doesNotMatch(historico, /O aceite eletrônico é realizado/);
  const nativo = texto({ ...snapshotBase, fechamento: { ...snapshotBase.fechamento, origem: 'CLIENTE' } });
  assert.match(nativo, /Este Resumo não substitui o Contrato Oficial\. O aceite eletrônico é realizado sobre o Contrato Oficial correspondente ao pacote contratado\./);
  assert.doesNotMatch(nativo, /assinado em papel/);
});
