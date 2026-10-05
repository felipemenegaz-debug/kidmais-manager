import assert from 'node:assert/strict';
import test from 'node:test';
import { carregar } from '../../scripts/integracao-importados-test-support.ts';
import { decisoesBase, referenciasBase, snapshotBase } from './integracao-importados/fixtures.ts';
import { avaliarIntegracao, montarSnapshotVersao } from './integracao-importados/modelo.ts';
import type { SnapshotHistorico } from '../importacao-contrato/plano.ts';
import type { ContratoVersaoRecord } from './repositories/models';
import { hashSnapshotContrato } from './services/snapshot-core.ts';

/**
 * Lado do SERVIDOR da página pública e do resumo em PDF para o contrato histórico, com o snapshot exatamente como a
 * importação o produz (`avaliarIntegracao` + `montarSnapshotVersao`, sem acrescentar endereço, RG ou outro dado):
 * o serviço real monta o contexto e o PDF real é gerado. Nenhuma conexão com banco.
 */
type Publico = typeof import('./services/contrato-publico.service.ts');
type Documento = typeof import('./services/documento.service.ts');
const publico = carregar<Publico>('lib/contratos/services/contrato-publico.service.ts');
const documento = carregar<Documento>('lib/contratos/services/documento.service.ts');

function versaoHistorica(snapshotDocumento: SnapshotHistorico, cliente: { email: string | null; cpf: string | null }): ContratoVersaoRecord {
  const decisoes = decisoesBase();
  const { resumo } = avaliarIntegracao({ snapshot: snapshotDocumento, decisoes, referencias: referenciasBase(), hoje: '2026-10-02' });
  const snapshot = montarSnapshotVersao({
    importacaoId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', documento: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256: 'f'.repeat(64) },
    fechamentoId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', snapshot: snapshotDocumento, decisoes, resumo,
    cliente: { id: '11111111-1111-4111-8111-111111111111', nomeCompleto: 'Ana Souza', telefone: '11999990000', whatsapp: null, ...cliente },
    aniversarianteId: null, pacote: referenciasBase().pacote!, unidade: { id: '22222222-2222-4222-8222-222222222222', nome: 'Unidade Centro' },
    conferente: { usuarioId: '99999999-9999-4999-8999-999999999999', papel: 'ADMINISTRATIVO' },
  });
  // Simula uma V1 anterior à unificação: os snapshots assinados antigos não serão reescritos.
  delete (snapshot.contratante as Record<string, unknown>).endereco;
  delete (snapshot.contratante as Record<string, unknown>).rg;
  assert.equal((snapshot.contratante as Record<string, unknown>).endereco, undefined);
  return {
    id: 'v1', contratoId: 'k1', numeroVersao: 1, status: 'ASSINADA', snapshotSchemaVersao: 1, snapshot: snapshot as never,
    snapshotHash: hashSnapshotContrato(snapshot), motivoNovaVersao: null, geradoPorUsuarioId: null, documentoTemplateVersao: null,
    documentoPdfHash: 'f'.repeat(64), aceiteMetodo: 'CONFERENCIA_PAPEL', criadoEm: '2026-10-02T12:00:00Z', substituidoEm: null, assinadoEm: '2026-10-02T12:00:00Z',
  };
}

const textoDoResumo = (v: ContratoVersaoRecord) => documento.gerarResumoContratacaoPdfDaVersao(v).documento.linhas.map((l) => l.texto).join('\n');

test('resumo em PDF do contrato histórico: gerado do snapshot real; ausências como "Não informado", nada inventado', () => {
  const v = versaoHistorica(snapshotBase(), { email: null, cpf: null });
  const gerado = documento.gerarResumoContratacaoPdfDaVersao(v);
  assert.equal(Buffer.from(gerado.pdf).subarray(0, 5).toString(), '%PDF-');
  const texto = textoDoResumo(v);
  assert.match(texto, /Endereço: Não informado/);
  assert.match(texto, /RG: Não informado/);
  assert.match(texto, /E-mail: Não informado/);
  assert.match(texto, /CPF: Não informado/);
  assert.match(texto, /Itens do buffet \(conforme o documento original\): Salgados e bolo/);
  assert.match(texto, /Contrato assinado em papel, conferido pela Kidmais/);
  assert.doesNotMatch(texto, /undefined|null|aceite eletrônico/);
  // Sem aniversariante no documento: "Não informado", nunca "null".
  const semAniversariante = snapshotBase();
  semAniversariante.evento = { ...semAniversariante.evento!, aniversariante: null };
  assert.match(textoDoResumo(versaoHistorica(semAniversariante, { email: 'ana@example.invalid', cpf: null })), /Aniversariante: Não informado/);
});

test('página pública do contrato histórico (serviço real): contexto "assinado em papel", sem documento eletrônico, aceite ou comprovante', async () => {
  const v = versaoHistorica(snapshotBase(), { email: null, cpf: null });
  let leuDocumento = false;
  const contexto = await publico.montarContextoContratoPublico({ id: 'k1', status: 'ASSINADO', assinadoEm: '2026-10-02T12:00:00Z' }, v as never,
    [{ id: 'nao-deveria', parte: 'CLIENTE', nome: 'x', assinado_em: '2026-10-02' }], async () => { leuDocumento = true; throw new Error('documento eletrônico não deveria ser lido'); });
  assert.equal(leuDocumento, false, 'pacote com modelo oficial (COMPLETA) não leva a procurar documento eletrônico');
  assert.deepEqual(contexto.assinatura, { tipo: 'PAPEL', texto: 'Contrato assinado em papel, conferido pela Kidmais na importação. Não há assinatura eletrônica nem comprovante digital: a prova é o documento original.' });
  assert.equal(contexto.aceitePermitido, false);
  assert.equal(contexto.versao.contratoOficial.disponivel, false);
  assert.deepEqual(contexto.comprovantes, []);
  assert.equal(contexto.evento.valorFinalContrato, 8500);
});

test('contrato nativo: o resumo continua com as mesmas linhas (e-mail e endereço como antes)', () => {
  const v = versaoHistorica(snapshotBase(), { email: 'ana@example.invalid', cpf: '12345678909' });
  const nativo = structuredClone(v.snapshot) as unknown as Record<string, unknown> & { contratante: Record<string, unknown> };
  delete nativo.origem; delete nativo.historico;
  nativo.contratante = { ...nativo.contratante, rg: '1234', endereco: { cep: '01001000', logradouro: 'Praça da Sé', numero: '1', complemento: null, bairro: 'Sé', cidade: 'São Paulo', uf: 'SP' } };
  const texto = textoDoResumo({ ...v, snapshot: nativo as never, aceiteMetodo: 'OTP' });
  assert.match(texto, /E-mail: ana@example\.invalid/);
  assert.match(texto, /Endereço: Praça da Sé, 1 - Sé, São Paulo\/SP - CEP 01001-000/);
  assert.match(texto, /O aceite eletrônico é realizado sobre o Contrato Oficial/);
  assert.doesNotMatch(texto, /conforme o documento original/);
});
