import assert from 'node:assert/strict';
import test from 'node:test';
import { classificarPendencias, type DadosImplantacao } from './implantacao.ts';

/** Regras das pendências de implantação (D5), sem banco. A leitura real fica na suíte PostgreSQL da 063. */
const base: DadosImplantacao = {
    gestoesAtivas: 1,
    gestoesSemAcesso: 0,
    responsavel: 'GESTAO_ATIVA',
    convites: { pendentes: 0, expirados: 0, naoEnviados: 0 },
    perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 1 },
};
const codigos = (r: ReturnType<typeof classificarPendencias>) => r.itens.map((i) => [i.codigo, i.atendida, i.obrigatoria]);
const item = (r: ReturnType<typeof classificarPendencias>, codigo: string) => {
    const achado = r.itens.find((i) => i.codigo === codigo);
    assert.ok(achado, `item ${codigo} ausente`);
    return achado;
};
const INFORMATIVOS_OK = [['RESPONSAVEL_COM_ACESSO', true, false], ['GESTAO_SEM_ACESSO', true, false], ['CONVITE_RESPONSAVEL', true, false]];

test('tudo atendido: pode concluir; convites dentro do prazo são informativos', () => {
    const r = classificarPendencias(base);
    assert.equal(r.podeConcluir, true);
    assert.deepEqual(r.pendentesObrigatorias, []);
    assert.deepEqual(codigos(r), [['GESTAO_ATIVA', true, true], ...INFORMATIVOS_OK, ['PERFIL_CRIADO', true, true], ['PERFIL_APLICADO', true, true]]);
    const comPendentes = classificarPendencias({ ...base, convites: { pendentes: 2, expirados: 0, naoEnviados: 0 } });
    assert.equal(comPendentes.podeConcluir, true);
    assert.match(item(comPendentes, 'CONVITE_RESPONSAVEL').detalhe, /2 convite\(s\) pendente\(s\) dentro do prazo/);
});

test('sem Gestão ativa: obrigatória pendente com ação nos convites; convite expirado ou nunca enviado é aviso que não bloqueia', () => {
    const r = classificarPendencias({ ...base, gestoesAtivas: 0, convites: { pendentes: 0, expirados: 1, naoEnviados: 1 } });
    assert.equal(r.podeConcluir, false);
    assert.deepEqual(r.pendentesObrigatorias, ['GESTAO_ATIVA']);
    assert.equal(item(r, 'GESTAO_ATIVA').acao, 'CONVITES');
    const convite = item(r, 'CONVITE_RESPONSAVEL');
    assert.deepEqual([convite.atendida, convite.obrigatoria, convite.acao], [false, false, 'CONVITES']);
    assert.match(convite.detalhe, /1 expirado\(s\) e 1 nunca enviado\(s\)/);
});

test('perfil: ausente, não aplicado ou ambíguo bloqueiam; estrutura não instalada deixa os itens de perfil fora das obrigatórias', () => {
    const ausente = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: false, ambiguo: false, versao: 0 } });
    assert.deepEqual(ausente.pendentesObrigatorias, ['PERFIL_CRIADO', 'PERFIL_APLICADO']);
    assert.equal(item(ausente, 'PERFIL_CRIADO').acao, 'PERFIL');
    assert.match(item(ausente, 'PERFIL_CRIADO').detalhe, /Configurações → Perfil da empresa/);
    const naoAplicado = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 0 } });
    assert.deepEqual(naoAplicado.pendentesObrigatorias, ['PERFIL_APLICADO']);
    assert.equal(item(naoAplicado, 'PERFIL_APLICADO').acao, 'PERFIL');
    const ambiguo = classificarPendencias({ ...base, perfil: { estruturaInstalada: true, existe: true, ambiguo: true, versao: 3 } });
    assert.deepEqual(ambiguo.pendentesObrigatorias, ['PERFIL_CRIADO', 'PERFIL_APLICADO']);
    assert.equal(item(ambiguo, 'PERFIL_CRIADO').acao, 'PLATAFORMA');
    const semEstrutura = classificarPendencias({ ...base, perfil: { estruturaInstalada: false, existe: false, ambiguo: false, versao: 0 } });
    assert.equal(semEstrutura.podeConcluir, true);
    assert.deepEqual(codigos(semEstrutura), [['GESTAO_ATIVA', true, true], ...INFORMATIVOS_OK, ['PERFIL_CRIADO', false, false]]);
    assert.equal(item(semEstrutura, 'PERFIL_CRIADO').acao, 'PLATAFORMA');
});

test('responsável do cadastro: só Gestão ativa atende; convite enviado espera sem ação; sem acesso ou não enviado apontam para convites; nada disso bloqueia', () => {
    const esperado = { GESTAO_ATIVA: [true, null], CONVITE_ENVIADO: [false, null], CONVITE_NAO_ENVIADO: [false, 'CONVITES'], SEM_ACESSO: [false, 'CONVITES'] } as const;
    for (const [situacao, [atendida, acao]] of Object.entries(esperado)) {
        const r = classificarPendencias({ ...base, responsavel: situacao as DadosImplantacao['responsavel'] });
        const i = item(r, 'RESPONSAVEL_COM_ACESSO');
        assert.deepEqual([i.atendida, i.acao, i.obrigatoria], [atendida, acao, false], situacao);
        assert.equal(r.podeConcluir, true, situacao);
    }
    const semCadastro = classificarPendencias({ ...base, responsavel: null });
    assert.equal(semCadastro.itens.some((i) => i.codigo === 'RESPONSAVEL_COM_ACESSO'), false);
});

test('Gestão com vínculo desativado ou conta inativa é aviso com ação em pessoas, sem bloquear quem já tem outra Gestão ativa', () => {
    const r = classificarPendencias({ ...base, gestoesSemAcesso: 2 });
    const i = item(r, 'GESTAO_SEM_ACESSO');
    assert.deepEqual([i.atendida, i.obrigatoria, i.acao], [false, false, 'VINCULOS']);
    assert.match(i.detalhe, /2 pessoa\(s\) com Gestão/);
    assert.equal(r.podeConcluir, true);
});
