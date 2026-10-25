import test from 'node:test';
import assert from 'node:assert/strict';
import { referenciaVigente, versaoDeReferencia } from './versao-referencia.ts';

const V = (n: number, status: string) => ({ id: `v${n}`, numero_versao: n, status });
const STATUS = ['ATIVA', 'SUBSTITUIDA', 'ASSINADA', 'CANCELADA'];

/** Regra escrita de outro jeito, para conferir a implementação em todas as combinações (rev. 4, R3-1). */
function esperado(versoes: ReturnType<typeof V>[], fluxo: { versao_vigente_id: string | null; versao_em_preparacao_id: string | null } | null) {
  const maior = (f: (v: ReturnType<typeof V>) => boolean) => versoes.filter(f).reduce<ReturnType<typeof V> | null>((m, v) => !m || v.numero_versao > m.numero_versao ? v : m, null);
  const vig = versoes.find(v => v.id === fluxo?.versao_vigente_id);
  if (vig) return [vig.id, 'VIGENTE_FLUXO'];
  const ass = maior(v => v.status === 'ASSINADA'); if (ass) return [ass.id, 'VIGENTE_LEGADA'];
  const prep = versoes.find(v => v.id === fluxo?.versao_em_preparacao_id); if (prep) return [prep.id, 'PREPARACAO_INICIAL'];
  const atv = maior(v => v.status === 'ATIVA'); if (atv) return [atv.id, 'ATIVA_SEM_FLUXO'];
  return [maior(() => true)!.id, 'SEM_VERSAO_VALIDA'];
}

test('todas as combinações de 1 a 3 versões × fluxo: mesma escolha, origem e diagnóstico, em qualquer ordem', () => {
  let casos = 0;
  for (let n = 1; n <= 3; n++) {
    const combinar = (k: number): string[][] => k === 0 ? [[]] : combinar(k - 1).flatMap(c => STATUS.map(s => [...c, s]));
    for (const estados of combinar(n)) {
      const versoes = estados.map((s, i) => V(i + 1, s));
      const ids = [null, 'inexistente', ...versoes.map(v => v.id)];
      const fluxos = [null, ...ids.flatMap(vig => ids.map(prep => ({ versao_vigente_id: vig, versao_em_preparacao_id: prep })))];
      for (const fluxo of fluxos) {
        const [id, origem] = esperado(versoes, fluxo);
        for (const ordem of [versoes, [...versoes].reverse()]) {
          const r = versaoDeReferencia(ordem, fluxo)!;
          assert.equal(r.versao.id, id); assert.equal(r.origem, origem);
          assert.equal(r.diagnostico, origem === 'SEM_VERSAO_VALIDA' ? 'SEM_VERSAO_VALIDA' : null);
          casos++;
        }
      }
    }
  }
  assert.ok(casos > 1000);
});

test('casos nomeados no parecer: legado V2 CANCELADA + V1 SUBSTITUIDA; vigente vazio com preparação; assinada antiga antes da preparação', () => {
  assert.deepEqual(versaoDeReferencia([V(2, 'CANCELADA'), V(1, 'SUBSTITUIDA')], null), { versao: V(2, 'CANCELADA'), origem: 'SEM_VERSAO_VALIDA', diagnostico: 'SEM_VERSAO_VALIDA' });
  assert.equal(versaoDeReferencia([V(1, 'ATIVA')], { versao_vigente_id: null, versao_em_preparacao_id: 'v1' })!.origem, 'PREPARACAO_INICIAL');
  assert.equal(versaoDeReferencia([V(1, 'ASSINADA'), V(2, 'ATIVA')], { versao_vigente_id: null, versao_em_preparacao_id: 'v2' })!.versao.id, 'v1');
  assert.equal(versaoDeReferencia([], null), null);
  assert.equal(referenciaVigente('VIGENTE_LEGADA'), true); assert.equal(referenciaVigente('PREPARACAO_INICIAL'), false);
});
