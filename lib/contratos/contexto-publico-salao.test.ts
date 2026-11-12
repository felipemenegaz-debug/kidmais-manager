import assert from 'node:assert/strict';
import test from 'node:test';
import { carregar } from '../../scripts/integracao-importados-test-support.ts';
import type { ContratoSnapshot, ContratoVersaoRecord } from './repositories/models';
import { hashSnapshotContrato } from './services/snapshot-core.ts';
import { SNAP_V1, SNAP_V2, SNAP_V3_COM_SALAO, SNAP_V3_SEM_SALAO } from './documento/salao-snapshots.test-apoio.ts';

/**
 * S-E (plano S-E/S-D rev. 4.1): página pública do contrato (serviço real, sem banco). O evento leva só o NOME do
 * salão fixado; id do salão e configuração da agenda nunca vão à página. Sem salão: `salao` nulo.
 */
type Publico = typeof import('./services/contrato-publico.service.ts');
const publico = carregar<Publico>('lib/contratos/services/contrato-publico.service.ts');

const versao = (snapshot: ContratoSnapshot): ContratoVersaoRecord => ({
  id: 'v1', contratoId: 'k1', numeroVersao: 1, status: 'ATIVA', snapshotSchemaVersao: snapshot.schemaVersao, snapshot,
  snapshotHash: hashSnapshotContrato(snapshot), motivoNovaVersao: null, geradoPorUsuarioId: null, documentoTemplateVersao: null,
  documentoPdfHash: null, aceiteMetodo: null, criadoEm: '2026-10-27T12:00:00Z', substituidoEm: null, assinadoEm: null,
});
const contexto = (snapshot: ContratoSnapshot) =>
  publico.montarContextoContratoPublico({ id: 'k1', status: 'AGUARDANDO_ASSINATURA', assinadoEm: null }, versao(snapshot) as never, [], async () => null as never);

test('contexto público: salão fixado só pelo nome; sem salão, nulo', async () => {
  const com = await contexto(SNAP_V3_COM_SALAO);
  assert.equal(com.evento.salao, 'Jardim');
  const json = JSON.stringify(com);
  assert.equal(json.includes(SNAP_V3_COM_SALAO.evento.salao!.id), false, 'sem id do salão');
  assert.equal(json.includes(SNAP_V3_COM_SALAO.evento.configuracaoAgendaId), false, 'sem configuração da agenda');
  assert.equal(json.includes('configuracaoAgendaId'), false);
  for (const s of [SNAP_V1, SNAP_V2, SNAP_V3_SEM_SALAO]) assert.equal((await contexto(s)).evento.salao, null);
});
