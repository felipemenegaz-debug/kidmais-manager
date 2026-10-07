import assert from 'node:assert/strict';
import test from 'node:test';
import { classificarPendencias, type DadosImplantacao } from './implantacao.ts';

/** Regras das pendências de implantação (D5), sem banco. A leitura real fica na suíte PostgreSQL da 063. */
const base: DadosImplantacao = {
    gestoesAtivas: 1,
    convites: { pendentes: 0, expirados: 0, naoEnviados: 0 },
    perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 1 },
};
const codigos = (r: ReturnType<typeof classificarPendencias>) => r.itens.map((i) => [i.codigo, i.atendida, i.obrigatoria]);

test('tudo atendido: pode concluir; convites dentro do prazo são informativos', () => {
    const r = classificarPendencias(base);
    assert.equal(r.podeConcluir, true);
    assert.deepEqual(r.pendentesObrigatorias, []);
    assert.deepEqual(codigos(r), [['GESTAO_ATIVA', true, true], ['CONVITE_RESPONSAVEL', true, false], ['PERFIL_CRIADO', true, true], ['PERFIL_APLICADO', true, true]]);
    const comPendentes = classificarPendencias({ ...base, convites: { pendentes: 2, expirados: 0, naoEnviados: 0 } });
    assert.equal(comPendentes.podeConcluir, true);
    assert.match(comPendentes.itens[1].detalhe, /2 convite\(s\) pendente\(s\) dentro do prazo/);
});

test('sem Gestão ativa: obrigatória pendente com ação nos convites; convite expirado ou nunca enviado é aviso que não bloqueia', () => {
    const r = classificarPendencias({ ...base, gestoesAtivas: 0, convites: { pendentes: 0, expirados: 1, naoEnviados: 1 } });
    assert.equal(r.podeConcluir, false);
    assert.deepEqual(r.pendentesObrigatorias, ['GESTAO_ATIVA']);
    assert.equal(r.itens[0].acao, 'CONVITES');
    assert.deepEqual([r.itens[1].atendida, r.itens[1].obrigatoria, r.itens[1].acao], [false, false, 'CONVITES']);
    assert.match(r.itens[1].detalhe, /1 expirado\(s\) e 1 nunca enviado\(s\)/);
});

test('perfil: ausente, não aplicado ou ambíguo bloqueiam; estrutura não instalada deixa os itens de perfil fora das obrigatórias', () => {
    const ausente = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: false, ambiguo: false, versao: 0 } });
    assert.deepEqual(ausente.pendentesObrigatorias, ['PERFIL_CRIADO', 'PERFIL_APLICADO']);
    assert.equal(ausente.itens[2].acao, 'PERFIL');
    assert.match(ausente.itens[2].detalhe, /Configurações → Perfil da empresa/);
    const naoAplicado = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 0 } });
    assert.deepEqual(naoAplicado.pendentesObrigatorias, ['PERFIL_APLICADO']);
    assert.equal(naoAplicado.itens[3].acao, 'PERFIL');
    const ambiguo = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: true, ambiguo: true, versao: 3 } });
    assert.deepEqual(ambiguo.pendentesObrigatorias, ['PERFIL_CRIADO', 'PERFIL_APLICADO']);
    assert.equal(ambiguo.itens[2].acao, 'PLATAFORMA');
    const semEstrutura = classificarPendencias({ ...base, perfil: { estruturaInstalada: false, existe: false, ambiguo: false, versao: 0 } });
    assert.equal(semEstrutura.podeConcluir, true);
    assert.deepEqual(codigos(semEstrutura), [['GESTAO_ATIVA', true, true], ['CONVITE_RESPONSAVEL', true, false], ['PERFIL_CRIADO', false, false]]);
    assert.equal(semEstrutura.itens[2].acao, 'PLATAFORMA');
});
