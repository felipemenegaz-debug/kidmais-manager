/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import type { DbExecutor } from '../db/contracts';

/**
 * CPF por empresa. CPF da própria empresa: fluxo normal (validar a identidade, que agora é por empresa).
 * CPF de OUTRA empresa no endereço por código: nunca revelado nem bloqueia; antes da 076 (índice global) o cadastro
 * novo nasce sem CPF; depois da 076 grava normalmente. Endereço atual (Kidmais) inalterado.
 */
const EMPRESA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OUTRA = 'bbbbbbbb-0000-4000-8000-00000000000b';
const dados = { nomeCompleto: 'Cliente Sintético', cpf: '529.982.247-25', whatsapp: '11999999999', email: 'c@example.invalid',
    cep: '01001000', logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' };

function ambiente(estado: { bloqueadoOutraEmpresa?: boolean; mesmaEmpresa?: boolean; violacao?: string } = {}) {
    const chamadas: Array<{ fn: string; args: any[] }> = [];
    const reg = (fn: string, r: (...a: any[]) => unknown) => async (...args: any[]) => { chamadas.push({ fn, args }); return r(...args); };
    const repos = {
        INDICES_CPF_CANONICO: ['clientes_cpf_canonico_uk', 'clientes_cpf_empresa_canonico_uk'],
        cpfBloqueadoPorOutraEmpresa: reg('cpfBloqueadoPorOutraEmpresa', () => estado.bloqueadoOutraEmpresa === true),
        buscarClienteCanonicoPorCpf: reg('buscarClienteCanonicoPorCpf', () => estado.mesmaEmpresa ? { id: 'existente', empresaId: EMPRESA } : null),
        criarCliente: reg('criarCliente', (i: any) => {
            if (estado.violacao) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: estado.violacao });
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
            analisarCadastroCliente: reg('analisarCadastroCliente', () => ({ possiveisDuplicidades: [] })),
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

test('endereço por empresa, antes da 076: CPF de OUTRA empresa → cadastro novo sem CPF, sem erro e sem revelar o dono', async () => {
    const a = ambiente({ bloqueadoOutraEmpresa: true });
    const cliente = await a.criar(true);
    assert.equal(cliente.id, 'novo');
    const criado = a.chamadas.find((c) => c.fn === 'criarCliente')!.args[0];
    assert.equal(criado.cpf, null); assert.equal(criado.empresaId, EMPRESA);
    assert.deepEqual(a.chamadas.find((c) => c.fn === 'cpfBloqueadoPorOutraEmpresa')!.args.slice(1, 2), [EMPRESA]);
    const historico = a.chamadas.find((c) => c.fn === 'registrarEventoHistorico')!.args[0];
    assert.match(historico.detalhe, /CPF informado não foi gravado automaticamente; confirme com o cliente/);
    assert.doesNotMatch(JSON.stringify(historico), /outra empresa|bbbbbbbb/i);
    assert.deepEqual(historico.metadata, { fluxo: 'FECHAMENTO_PUBLICO', cpfPendenteConfirmacao: true });
});

test('endereço por empresa, depois da 076: CPF de outra empresa não conflita e é gravado', async () => {
    const a = ambiente({ bloqueadoOutraEmpresa: false });
    await a.criar(true);
    assert.equal(a.chamadas.find((c) => c.fn === 'criarCliente')!.args[0].cpf, dados.cpf);
    assert.equal(a.chamadas.find((c) => c.fn === 'registrarEventoHistorico')!.args[0].detalhe, 'Cadastro criado durante Fechamento público.');
});

test('endereço por empresa: CPF já cliente DESTA empresa → validar identidade (por empresa), como no endereço atual', async () => {
    const a = ambiente({ mesmaEmpresa: true, bloqueadoOutraEmpresa: true });
    await assert.rejects(a.criar(true), (e: any) => e.code === 'CPF_EXISTENTE_REQUER_VALIDACAO');
    assert.deepEqual(a.chamadas.find((c) => c.fn === 'buscarClienteCanonicoPorCpf')!.args.slice(1, 2), [EMPRESA]);
    assert.ok(!a.chamadas.some((c) => c.fn === 'criarCliente'));
});

test('concorrência no índice (global ou por empresa) no endereço por empresa → resposta neutra', async () => {
    for (const indice of ['clientes_cpf_canonico_uk', 'clientes_cpf_empresa_canonico_uk']) {
        const a = ambiente({ violacao: indice });
        await assert.rejects(a.criar(true), (e: any) => e.code === 'PEDIDO_NAO_CONCLUIDO' && !/CPF|cadastro/i.test(e.message));
    }
});

test('endereço atual (Kidmais): inalterado — CPF da empresa pede identidade; sem a checagem entre empresas', async () => {
    const a = ambiente({ mesmaEmpresa: true });
    await assert.rejects(a.criar(undefined), (e: any) => e.code === 'CPF_EXISTENTE_REQUER_VALIDACAO');
    const b = ambiente({ violacao: 'clientes_cpf_canonico_uk', bloqueadoOutraEmpresa: true });
    await assert.rejects(b.criar(undefined), (e: any) => e.code === 'CPF_EXISTENTE_REQUER_VALIDACAO');
    assert.ok(!b.chamadas.some((c) => c.fn === 'cpfBloqueadoPorOutraEmpresa'));
});

test('repositório: identidade só na empresa do escopo (ou no cliente do contrato); nunca global', async () => {
    const { buscarClienteCanonicoPorCpfParaIdentidade, cpfBloqueadoPorOutraEmpresa } = carregarModulo('lib/clientes/repositories/cliente.repository.ts', {
        'db/postgres': { db: () => { throw new Error('sem banco'); } },
    }) as any;
    const tx = executorFalso([]) as unknown as DbExecutor & { executados: Array<{ sql: string; params: unknown[] }> };
    await buscarClienteCanonicoPorCpfParaIdentidade('52998224725', { empresaId: EMPRESA, incluirLegadoSemEmpresa: false }, tx);
    await buscarClienteCanonicoPorCpfParaIdentidade('52998224725', { clienteId: OUTRA }, tx);
    assert.equal(await buscarClienteCanonicoPorCpfParaIdentidade('52998224725', { empresaId: '', incluirLegadoSemEmpresa: true }, tx), null);
    assert.equal(await buscarClienteCanonicoPorCpfParaIdentidade('52998224725', undefined, tx), null);
    const [porEmpresa, porCliente] = tx.executados;
    assert.match(porEmpresa.sql, /empresa_id = \$2::uuid OR \(\$3::boolean AND empresa_id IS NULL\)/);
    assert.deepEqual(porEmpresa.params, ['52998224725', EMPRESA, false]);
    assert.match(porCliente.sql, /AND id = \$2::uuid/);
    assert.equal(tx.executados.length, 2, 'sem escopo não consulta');
    await cpfBloqueadoPorOutraEmpresa('52998224725', EMPRESA, tx);
    assert.match(tx.executados[2].sql, /to_regclass\('public\.clientes_cpf_canonico_uk'\) IS NOT NULL[\s\S]*empresa_id IS DISTINCT FROM \$2::uuid/);
});

test('rotas: identidade pública resolvida pelo endereço; cotação aceita cliente existente; contrato usa o próprio cliente', () => {
    const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    for (const r of ['consultar-cpf', 'iniciar-desafio', 'solicitar-recuperacao']) {
        const fonte = ler(`app/api/identidade/${r}/route.ts`);
        assert.match(fonte, /limitarPublico\(request, "IDENTIDADE"\)/, r);
        assert.match(fonte, /escopo = await escopoIdentidadePublica\(db, request\.nextUrl\)/, r);
    }
    const post = ler('app/api/fechamentos/route.ts');
    assert.doesNotMatch(post, /IDENTIDADE_NAO_DISPONIVEL/);
    assert.match(post, /cpfSemRevelarCadastro: escopo\.porCodigo,/);
    assert.match(post, /crm: escopo\.porCodigo \? undefined : \{/);
    const contrato = ler('lib/contratos/services/contrato-publico.service.ts');
    assert.match(contrato, /consultarCpfPublico\(cpfInformado, \{ clienteId: clienteContrato\.id \}\)/);
    assert.match(contrato, /escopo: \{ clienteId: \(await clienteCanonicoDaVersao\(versao\)\)\.id \}/);
    assert.match(ler('lib/comercial/cotacao-publica.ts'), /incluirLegadoSemEmpresa: !escopo\.porCodigo/);
});
