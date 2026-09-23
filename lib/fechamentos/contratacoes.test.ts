import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classificarContratacao, listarContratacoes, contratacoesSql, estadosEmContratacao, type ContratacaoRow } from './contratacoes.ts';
import type { DbExecutor } from '../db/contracts';

export const fechamento: ContratacaoRow = {
    id: '11111111-1111-4111-8111-111111111111', clienteId: '22222222-2222-4222-8222-222222222222', cliente: 'Cliente sintético', clienteStatus: 'ATIVO',
    data: '2026-09-19', inicio: '11:00:00', fim: '15:00:00', pacote: 'Pacote sintético', convidados: 40,
    criadoEm: '2026-09-16T10:00:00Z', status: 'AGUARDANDO_CONTRATO', formaPagamento: 'PIX_AVISTA',
    contratoId: null, contratoStatus: null, versaoId: null, edicaoEstado: null, documentoRevisado: false, valorContratual: null, temFesta: false,
};
const comContrato = { ...fechamento, contratoId: 'contrato-sintetico', contratoStatus: 'AGUARDANDO_ASSINATURA', versaoId: 'versao-sintetica', valorContratual: '5000.00' };

for (const [edicaoEstado, documentoRevisado, situacao, acao] of [
    ['EM_ELABORACAO', false, 'Revisão em elaboração', 'Abrir contrato'],
    ['EM_ELABORACAO', true, 'Aguardando assinatura da Kidmais', 'Assinar pela Kidmais'],
    ['ASSINADA_KIDMAIS', true, 'Assinado pela Kidmais', 'Abrir contrato'],
    ['AGUARDANDO_CLIENTE', true, 'Aguardando assinatura do cliente', 'Abrir contrato'],
] as const) test(`V2 ${edicaoEstado}/${documentoRevisado} prevalece sobre contrato ASSINADO`, () => {
    const row = { ...comContrato, contratoStatus: 'ASSINADO', versaoId: 'v2', edicaoEstado, documentoRevisado };
    const item = classificarContratacao(row)!;
    assert.equal(item.situacao, situacao);
    assert.equal(item.acao.titulo, acao);
    assert.match(item.acao.href, /versaoId=v2$/);
    assert.equal(item.acessoPublico, edicaoEstado === 'AGUARDANDO_CLIENTE' ? '/contrato/contrato-sintetico' : null);
    assert.doesNotMatch(item.proximoPasso, /verificação operacional da Festa/);
    assert.equal(classificarContratacao({ ...row, temFesta: true }), null);
});

for (const edicaoEstado of ['CONCLUIDA', 'CANCELADA', null]) test(`sem revisão ativa (${edicaoEstado}) mantém alerta de Festa pendente`, () => {
    assert.equal(classificarContratacao({ ...comContrato, contratoStatus: 'ASSINADO', edicaoEstado })?.situacao, 'Formalizado — Festa pendente');
});

for (const status of estadosEmContratacao) test(`${status} sem Festa permanece visível`, () => {
    assert(classificarContratacao({ ...fechamento, status }));
});
test('aprovação e fechamento sem contrato abrem revisão sem UUID manual', () => {
    for (const status of ['AGUARDANDO_APROVACAO', 'AGUARDANDO_CONTRATO']) {
        const item = classificarContratacao({ ...fechamento, status })!;
        assert.equal(item.acao.href, `/admin/fechamentos/${fechamento.id}/revisao`);
        assert.equal(item.acao.titulo, status === 'AGUARDANDO_APROVACAO' ? 'Revisar proposta' : 'Gerar contrato');
    }
});
for (const [edicaoEstado, documentoRevisado, situacao] of [
    ['EM_ELABORACAO', false, 'Contrato em elaboração'],
    ['EM_ELABORACAO', true, 'Aguardando assinatura da Kidmais'],
    ['ASSINADA_KIDMAIS', true, 'Assinado pela Kidmais'],
    ['AGUARDANDO_CLIENTE', true, 'Aguardando assinatura do cliente'],
] as const) test(`edição ${situacao} abre contrato existente`, () => {
    const item = classificarContratacao({ ...comContrato, edicaoEstado, documentoRevisado })!;
    assert.equal(item.situacao, situacao);
    assert.equal(item.acao.href, '/admin/contratos?contratoId=contrato-sintetico&versaoId=versao-sintetica');
    assert.notEqual(item.acao.titulo, 'Gerar contrato');
    assert.equal(item.acessoPublico, edicaoEstado === 'AGUARDANDO_CLIENTE' ? '/contrato/contrato-sintetico' : null);
});
test('Festa criada, inclusive invalidada, sai da fila e contrato cancelado nunca é ativo', () => {
    assert.equal(classificarContratacao({ ...comContrato, temFesta: true }), null);
    assert.equal(classificarContratacao({ ...comContrato, contratoStatus: 'CANCELADO' }), null);
    assert.equal(classificarContratacao({ ...comContrato, edicaoEstado: 'CANCELADA' }), null);
    assert.equal(classificarContratacao({ ...comContrato, contratoStatus: 'ASSINADO', edicaoEstado: 'CANCELADA' })?.situacao, 'Formalizado — Festa pendente');
    for (const status of ['CANCELADO', 'RECUSADO', 'EXPIRADO', 'DESCONHECIDO']) assert.equal(classificarContratacao({ ...fechamento, status }), null);
    assert.doesNotMatch(contratacoesSql, /invalidada_em IS NULL/);
});
test('formalização sem Festa é exceção visível, sem criar outro contrato', () => {
    const item = classificarContratacao({ ...comContrato, contratoStatus: 'ASSINADO', edicaoEstado: 'CONCLUIDA' })!;
    assert.equal(item.situacao, 'Formalizado — Festa pendente');
    assert.equal(item.acao.titulo, 'Abrir contrato');
});
test('consulta única parametrizada compartilha filtro do CRM e aceita contratos ausentes', async () => {
    const chamadas: { sql: string; values?: readonly unknown[] }[] = [];
    const tx = { query: async (sql: string, values?: readonly unknown[]) => {
        chamadas.push({ sql, values }); return { rows: [fechamento, comContrato], rowCount: 2 };
    } } as DbExecutor;
    const itens = await listarContratacoes(tx, fechamento.clienteId!);
    assert.equal(itens.length, 2); assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0].values, [estadosEmContratacao, fechamento.clienteId]);
    assert.match(chamadas[0].sql, /LEFT JOIN public.contratos/);
    assert.match(chamadas[0].sql, /f.cliente_id=\$2::uuid/);
    assert.doesNotMatch(chamadas[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
    await listarContratacoes(tx);
    assert.equal(chamadas[1].values?.[1], null);
});
test('DTO não vaza documentos ou credenciais extras do executor', () => {
    const item = classificarContratacao({ ...fechamento, senha: 'sentinela-nao-real', snapshot: { cpf: 'sentinela-cpf' } } as ContratacaoRow);
    assert.doesNotMatch(JSON.stringify(item), /sentinela|snapshot|senha/);
});
test('CRM e Central usam mesma fila; quatro abas continuam isoladas', () => {
    const crm = readFileSync('components/clientes/ClienteProfile.tsx', 'utf8');
    const central = readFileSync('components/festas/FestaConsole.tsx', 'utf8');
    assert.match(crm, /<Contratacoes key=\{cliente.id\} clienteId=\{cliente.id\}/);
    assert.match(central, /\['Em contratação','Hoje','Próximas','Pendências','Histórico'\]/);
    assert.match(central, /central!=='Em contratação'&&<>/);
    assert.match(central, /onTotal=\{setTotalContratacoes\}/);
    assert.match(central, /pertenceVisao\(estadoDerivado/);
});
