import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { classificarRetrato, compararRetrato, postcheck109, FAMILIAS, type Retrato } from './renovacao-schema.ts';
import { RETRATO_075, RETRATO_109 } from './renovacao-schema-retratos.ts';

/** Contrato de integridade (plano rev. 5 §2.6): classificação por igualdade de conjunto, diferença 075 → 109 e postcheck gerado. */
const copia = (r: Retrato): Retrato => structuredClone(r);

test('retratos aprovados classificam como a própria versão; nada lido → INCOMPATIVEL', () => {
    assert.deepEqual(classificarRetrato(copia(RETRATO_075)), { capacidade: '075' });
    assert.deepEqual(classificarRetrato(copia(RETRATO_109)), { capacidade: '109' });
    assert.equal(classificarRetrato(null).capacidade, 'INCOMPATIVEL');
});

test('falta, sobra e divergência em cada família → INCOMPATIVEL com nomes, sem definições', () => {
    for (const base of [RETRATO_075, RETRATO_109]) for (const f of FAMILIAS) {
        const falta = copia(base); const [tirado] = falta[f].splice(0, 1);
        const r = classificarRetrato(falta);
        assert.equal(r.capacidade, 'INCOMPATIVEL', `${f} sem ${tirado.nome}`);
        const diverge = copia(base); diverge[f][0] = { ...diverge[f][0], extra: true };
        assert.equal(classificarRetrato(diverge).capacidade, 'INCOMPATIVEL', `${f} divergente`);
        const sobra = copia(base); sobra[f].push({ nome: 'objeto_a_mais' });
        const s = classificarRetrato(sobra);
        assert.ok(s.capacidade === 'INCOMPATIVEL' && s.divergencias.includes(`${f}:objeto_a_mais:SOBRA`));
        for (const d of (r as { divergencias: string[] }).divergencias) assert.match(d, /^[a-z]+:[a-z0-9_.]+:(FALTA|SOBRA|DIVERGE)$/);
    }
});

test('diferença 075 → 109 é exatamente a do plano (com os índices de suporte); o conjunto comum é idêntico', () => {
    const d = compararRetrato(RETRATO_109, RETRATO_075);
    assert.deepEqual(d, [
        'colunas:substitui_id:SOBRA',
        'constraints:assinatura_renovacoes_109_cadeia_alvo_uq:SOBRA',
        'constraints:assinatura_renovacoes_109_cadeia_fk:SOBRA',
        'constraints:assinatura_renovacoes_109_estado_check:SOBRA',
        'constraints:assinatura_renovacoes_109_substitui_uq:SOBRA',
        'constraints:assinatura_renovacoes_109_substituida_sem_evidencia:SOBRA',
        'constraints:assinatura_renovacoes_contratacao_id_key:FALTA',
        'constraints:assinatura_renovacoes_estado_check:FALTA',
        'funcoes:public.kidmais_075_renovacao_guarda:FALTA',
        'funcoes:public.kidmais_109_renovacao_guarda:SOBRA',
        'funcoes:public.kidmais_109_renovacao_sucessor:SOBRA',
        'gatilhos:assinatura_renovacoes_075_guarda:DIVERGE',
        'gatilhos:assinatura_renovacoes_075_truncate:DIVERGE',
        'gatilhos:assinatura_renovacoes_109_sucessor:SOBRA',
        'indices:assinatura_renovacoes_109_cadeia_alvo_uq:SOBRA',
        'indices:assinatura_renovacoes_109_substitui_uq:SOBRA',
        'indices:assinatura_renovacoes_109_vigente_uq:SOBRA',
        'indices:assinatura_renovacoes_contratacao_id_key:FALTA',
    ]);
    // Os dois gatilhos de guarda divergem SÓ pela função ligada (nome, momento, eventos e demais campos iguais).
    for (const nome of ['assinatura_renovacoes_075_guarda', 'assinatura_renovacoes_075_truncate']) {
        const a = RETRATO_075.gatilhos.find((g) => g.nome === nome)!, b = RETRATO_109.gatilhos.find((g) => g.nome === nome)!;
        assert.deepEqual({ ...a, funcao: null, def: String(a.def).replace('kidmais_075', 'X') }, { ...b, funcao: null, def: String(b.def).replace('kidmais_109', 'X') });
    }
    // Os cinco CHECKs de evidência e prazo, aviso_dias, mensagem e ultimo_erro estão no conjunto comum (R3-F1).
    const checks075 = RETRATO_075.constraints.filter((c) => c.tipo === 'c').map((c) => c.nome);
    assert.ok(checks075.length >= 9, `CHECKs da 075 no retrato: ${checks075.length}`);
    for (const g of RETRATO_109.gatilhos.filter((x) => x.nome !== 'assinatura_renovacoes_109_sucessor'))
        assert.deepEqual([g.habilitado, g.semWhen, g.semUpdateOf, g.constraint], ['O', true, true, null], g.nome);
    const suc = RETRATO_109.gatilhos.find((g) => g.nome === 'assinatura_renovacoes_109_sucessor')!;
    assert.deepEqual([suc.deferivel, suc.diferido, suc.constraint], [true, true, 'assinatura_renovacoes_109_sucessor']);
    assert.ok(!JSON.stringify([RETRATO_075, RETRATO_109]).match(/"oid"|tgfoid|conrelid/), 'nenhum OID no retrato');
});

test('postcheck da 109 é exatamente o gerado do contrato', () => {
    assert.equal(readFileSync(new URL('../../database/checks/20261029_109_postcheck.sql', import.meta.url), 'utf8'), postcheck109());
});
