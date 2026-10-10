/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Endereço público por empresa: CPF já usado (nesta ou em outra empresa) não bloqueia nem muda a resposta,
 * não revela o dono e nunca é gravado por cima do índice global. Endereço atual (Kidmais) inalterado.
 */
const EMPRESA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const dados = { nomeCompleto: 'Cliente Sintético', cpf: '529.982.247-25', whatsapp: '11999999999', email: 'c@example.invalid',
    cep: '01001000', logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' };

function ambiente(estado: { cpfEmUso?: boolean; mesmaEmpresa?: boolean; violacao?: boolean } = {}) {
    const chamadas: Array<{ fn: string; args: any[] }> = [];
    const reg = (fn: string, r: (...a: any[]) => unknown) => async (...args: any[]) => { chamadas.push({ fn, args }); return r(...args); };
    const repos = {
        cpfCanonicoEmUso: reg('cpfCanonicoEmUso', () => estado.cpfEmUso === true),
        buscarClienteCanonicoPorCpf: reg('buscarClienteCanonicoPorCpf', () => estado.mesmaEmpresa ? { id: 'existente', empresaId: EMPRESA } : null),
        criarCliente: reg('criarCliente', (i: any) => {
            if (estado.violacao) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'clientes_cpf_canonico_uk' });
            return { id: 'novo', empresaId: i.empresaId, cpf: i.cpf ? '52998224725' : null, status: 'ATIVO' };
        }),
        registrarEventoHistorico: reg('registrarEventoHistorico', () => undefined),
        registrarAuditoria: reg('registrarAuditoria', () => undefined),
        registrarPossivelDuplicidade: reg('registrarPossivelDuplicidade', () => undefined),
    };
    const mod = carregarModulo('lib/fechamentos/services/fechamento-publico.service.ts', {
        'db/postgres': { withTransaction: async (fn: any) => fn({}) },
        'clientes/repositories': repos,
        'clientes/services': {
            analisarCadastroCliente: reg('analisarCadastroCliente', () => ({ possiveisDuplicidades: estado.mesmaEmpresa ? [{ clienteId: 'existente', motivos: ['CPF'] }] : [] })),
            camposFaltantesParaContrato: () => [], validarCadastroBasicoCliente: () => undefined,
        },
        'identidade/services': { criarIdentityServiceComAmbiente: () => ({}) },
        'comercial/repositories': { buscarPacoteAtivoPorId: async () => null },
        'fechamentos/services/fechamento.service': { criarFechamentoComercial: async () => null },
        'fechamentos/services/escolhas-buffet.service': { resolverEscolhasBuffet: async () => null, gravarEscolhasBuffet: async () => undefined },
    }) as { criarNovoCliente(d: object, input: object, empresaId: string, tx: object): Promise<any> };
    const criar = (cpfSemRevelarCadastro?: boolean) => mod.criarNovoCliente(dados, { cpfSemRevelarCadastro }, EMPRESA, {});
    return { criar, chamadas };
}

test('endereço por empresa: CPF usado em OUTRA empresa → cadastro novo sem CPF, sem erro e sem revelar o dono', async () => {
    const a = ambiente({ cpfEmUso: true });
    const cliente = await a.criar(true);
    assert.equal(cliente.id, 'novo');
    const criado = a.chamadas.find((c) => c.fn === 'criarCliente')!.args[0];
    assert.equal(criado.cpf, null);
    assert.equal(criado.empresaId, EMPRESA);
    assert.ok(!a.chamadas.some((c) => c.fn === 'buscarClienteCanonicoPorCpf'), 'não consulta cadastro de nenhuma empresa por CPF');
    const historico = a.chamadas.find((c) => c.fn === 'registrarEventoHistorico')!.args[0];
    assert.match(historico.detalhe, /CPF informado não foi gravado automaticamente; confirme com o cliente/);
    assert.doesNotMatch(JSON.stringify(historico), /outra empresa|empresa_id|bbbbbbbb/i);
    assert.deepEqual(historico.metadata, { fluxo: 'FECHAMENTO_PUBLICO', cpfPendenteConfirmacao: true });
});

test('endereço por empresa: CPF já cliente DESTA empresa → mesmo resultado público; duplicidade vai para revisão do CRM', async () => {
    const a = ambiente({ cpfEmUso: true, mesmaEmpresa: true });
    const cliente = await a.criar(true);
    assert.equal(cliente.id, 'novo');
    assert.equal(a.chamadas.find((c) => c.fn === 'criarCliente')!.args[0].cpf, null);
    assert.deepEqual(a.chamadas.find((c) => c.fn === 'registrarPossivelDuplicidade')!.args[0], { clienteUmId: 'novo', clienteDoisId: 'existente', motivos: ['CPF'] });
    assert.equal(a.chamadas.find((c) => c.fn === 'analisarCadastroCliente')!.args[1], EMPRESA, 'deduplicação só na própria empresa');
});

test('endereço por empresa: CPF livre é gravado normalmente', async () => {
    const a = ambiente({ cpfEmUso: false });
    await a.criar(true);
    assert.equal(a.chamadas.find((c) => c.fn === 'criarCliente')!.args[0].cpf, dados.cpf);
    assert.equal(a.chamadas.find((c) => c.fn === 'registrarEventoHistorico')!.args[0].detalhe, 'Cadastro criado durante Fechamento público.');
});

test('endereço por empresa: concorrência no índice global → resposta neutra, sem citar cadastro', async () => {
    const a = ambiente({ cpfEmUso: false, violacao: true });
    await assert.rejects(a.criar(true), (e: any) => e.code === 'PEDIDO_NAO_CONCLUIDO' && !/CPF|cadastro/i.test(e.message));
});

test('endereço atual (Kidmais): comportamento inalterado — CPF da própria empresa pede identidade; sem consulta global', async () => {
    const a = ambiente({ mesmaEmpresa: true, cpfEmUso: true });
    await assert.rejects(a.criar(undefined), (e: any) => e.code === 'CPF_EXISTENTE_REQUER_VALIDACAO');
    assert.ok(!a.chamadas.some((c) => c.fn === 'cpfCanonicoEmUso'));
    const b = ambiente({ violacao: true });
    await assert.rejects(b.criar(undefined), (e: any) => e.code === 'CPF_EXISTENTE_REQUER_VALIDACAO');
});

test('rota: endereço por empresa liga a proteção e não devolve dados do cadastro na resposta', () => {
    const rota = readFileSync('app/api/fechamentos/route.ts', 'utf8');
    assert.match(rota, /cpfSemRevelarCadastro: escopo\.porCodigo,/);
    assert.match(rota, /crm: escopo\.porCodigo \? undefined : \{/);
});
