import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import { consultarCapacidadesPerfil, exigirCapacidadePerfil } from './autorizacao.ts';

const perfilId = '00000000-0000-4000-8000-000000000001';
const saasId = '00000000-0000-4000-8000-000000000002';
const usuarioId = '00000000-0000-4000-8000-000000000003';

// Double sem SQL real. Confere o contrato da associação e as recusas da autorização.
function banco({ membership = true, papel = 'REPRESENTANTE_AUTORIZADO', ativo = true, concessao = true } = {}) {
  const tx = { async query(sql: string, params: readonly unknown[] = []) {
    if (sql.includes('to_regclass')) return { rows:[{empresas:'perfil_empresas',concessoes:'perfil_empresa_concessoes'}] };
    if (sql.includes('SELECT u.id, m.papel')) {
      assert.deepEqual(params,[usuarioId,perfilId]);
      assert.notEqual(perfilId,saasId);
      assert.match(sql,/p\.id = \$2::uuid/);
      assert.match(sql,/codigo = lower\(p\.codigo\)/);
      assert.match(sql,/e\.candidatos = 1 AND e\.status = 'ATIVA'/);
      assert.match(sql,/\(SELECT count\(\*\) FROM empresas\) = 1 AND/);
      assert.match(sql,/\(SELECT count\(\*\) FROM public\.perfil_empresas\) = 1/);
      assert.match(sql,/m\.empresa_id = e\.id/);
      assert.doesNotMatch(sql,/m\.empresa_id = \$2/);
      return {rows:membership ? [{id:usuarioId,papel,ativo}] : []};
    }
    assert.match(sql,/SELECT capacidade FROM public\.perfil_empresa_concessoes/);
    assert.deepEqual(params,[perfilId,usuarioId]);
    return {rows:concessao ? [{capacidade:'PERFIL_CONSULTAR'}] : []};
  }} as unknown as DbExecutor;
  return tx;
}

test('perfil usa código para associar UUIDs independentes e preserva concessão explícita',async()=>{
  assert.equal((await consultarCapacidadesPerfil(banco(),perfilId,usuarioId)).capacidades.PERFIL_CONSULTAR,true);
});
test('perfil recusa membership ausente, inativa, sem Gestão ou sem concessão',async()=>{
  for(const opcoes of [{membership:false},{ativo:false},{papel:'ATENDIMENTO'},{concessao:false}])
    await assert.rejects(exigirCapacidadePerfil(banco(opcoes),perfilId,usuarioId,'PERFIL_CONSULTAR'),{code:'PERFIL_SEM_CONCESSAO'});
});
