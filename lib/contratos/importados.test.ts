import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts.ts';
import {
  PAPEIS_ORIGINAL_IMPORTADO, contarEventosImportadosAIntegrar, detalheContratoImportado, listarContratosImportados,
  originalDoContratoImportado, podeVerOriginal, situacaoEvento,
} from './importados.ts';

const HOJE = '2026-10-03';
const contrato = {
  evento: { data: '2026-10-18', horario: { inicio: '10:00', fim: '14:00' }, duracaoMinutos: 240, aniversariante: 'Luca exemplo', idade: 4, convidados: 50, tema: 'Carros' },
  pacote: { nome: 'Original 2025', duracaoMinutos: 240, quantidade: 50, itens: 'Itens originais' },
  buffet: { itens: 'Salgados', observacoes: null, restricoes: null },
  valores: { preco: 500000, adicionais: null, total: 500000 },
  pagamentosPrevistos: { condicao: 'Entrada e 2 parcelas', entrada: { valor: 100000, vencimento: '2026-10-01' }, parcelas: [{ numero: 1, valor: 200000, vencimento: '2026-10-10' }], natureza: 'PREVISTO' },
  observacoes: null,
};
type Linha = { id: string; empresa: string; status: string; cliente_id: string; nome: string; contrato: typeof contrato | null; importado_em: string | null };
const base: Linha = { id: 'i1', empresa: 'a', status: 'IMPORTADA', cliente_id: 'c1', nome: 'Cliente exemplo', contrato, importado_em: '2026-10-02T21:34:29Z' };
const linhas: Linha[] = [
  base,
  { ...base, id: 'i2', empresa: 'b' },
  { ...base, id: 'i3', status: 'EM_REVISAO' },
  { ...base, id: 'i4', status: 'DESCARTADA' },
  { ...base, id: 'i5', cliente_id: 'c2', contrato: { ...contrato, evento: { ...contrato.evento, data: '2026-09-20' } } },
  { ...base, id: 'i6', cliente_id: 'c2', contrato: { ...contrato, evento: { ...contrato.evento, data: null as unknown as string } } },
];

function banco(opcoes: { disponivel?: boolean } = {}) {
  const consultas: Array<{ sql: string; values: unknown[] }> = [];
  const tx = { async query(sql: string, values: unknown[] = []) {
    consultas.push({ sql, values });
    if (sql.includes('to_regclass')) return { rows: [{ ok: opcoes.disponivel ?? true }] };
    assert.match(sql, /i\.empresa_id = \$\d::uuid/, 'toda consulta filtra a empresa comprovada');
    assert.match(sql, /i\.status = 'IMPORTADA'/, 'só importações confirmadas');
    assert.doesNotMatch(sql, /SELECT \*|i\.dados|cpf|telefone|whatsapp|email/i, 'nunca expõe extração, CPF ou contatos');
    // Consultas por id recebem (id, empresa); as demais, (empresa, ...).
    const empresa = /i\.id = \$1::uuid AND i\.empresa_id = \$2::uuid/.test(sql) ? values[1] : values[0];
    const daEmpresa = (l: Linha) => l.empresa === empresa && l.status === 'IMPORTADA';
    if (sql.includes('count(*)::int AS n')) {
      return { rows: [{ n: linhas.filter((l) => daEmpresa(l) && /^\d{4}-\d{2}-\d{2}$/.test(l.contrato?.evento.data ?? '') && (l.contrato!.evento.data >= String(values[1]))).length }] };
    }
    if (sql.includes('o.conteudo')) {
      const l = linhas.find((x) => x.id === values[0] && daEmpresa(x));
      return { rows: l ? [{ conteudo: Buffer.from('%PDF-1.4'), content_type: 'application/pdf', nome_original: 'contrato.pdf' }] : [] };
    }
    if (sql.includes("i.resultado->'contratoHistorico' AS contrato")) {
      const l = linhas.find((x) => x.id === values[0] && daEmpresa(x));
      return { rows: l ? [{ id: l.id, cliente_id: l.cliente_id, nome: l.nome, contrato: l.contrato, pendencias: ['Festa pendente'], importado_em: l.importado_em, importado_por: 'Operadora', documento_id: 'd1', documento_nome: 'contrato.pdf', documento_tipo: 'application/pdf', documento_tamanho: '1234' }] : [] };
    }
    return { rows: linhas.filter((l) => daEmpresa(l) && (!values[1] || l.cliente_id === values[1])).map((l) => ({
      id: l.id, cliente_id: l.cliente_id, nome: l.nome, data_evento: l.contrato?.evento.data ?? null, pacote: l.contrato?.pacote.nome ?? null, convidados: l.contrato ? String(l.contrato.evento.convidados) : null, importado_em: l.importado_em,
    })) };
  } } as unknown as DbExecutor;
  return { tx, consultas };
}

test('situação do evento: passado, futuro (hoje conta como futuro) e sem data', () => {
  assert.equal(situacaoEvento('2026-10-02', HOJE), 'PASSADO');
  assert.equal(situacaoEvento('2026-10-03', HOJE), 'FUTURO');
  assert.equal(situacaoEvento('2026-10-18', HOJE), 'FUTURO');
  assert.equal(situacaoEvento(null, HOJE), 'SEM_DATA');
  assert.equal(situacaoEvento('18/10/2026', HOJE), 'SEM_DATA');
});

test('lista: só importações confirmadas da empresa, com status IMPORTADO e origem IMPORTACAO; filtro por cliente', async () => {
  const { tx, consultas } = banco();
  const lista = await listarContratosImportados(tx, 'a', HOJE);
  assert.deepEqual(lista.map((c) => c.id), ['i1', 'i5', 'i6']);
  assert.deepEqual(lista[0], { id: 'i1', origem: 'IMPORTACAO', status: 'IMPORTADO', nome: 'Cliente exemplo', data_evento: '2026-10-18', pacote: 'Original 2025', convidados: 50, clienteId: 'c1', situacaoEvento: 'FUTURO', importadoEm: '2026-10-02T21:34:29Z' });
  assert.equal(lista[1].situacaoEvento, 'PASSADO');
  assert.equal(lista[2].situacaoEvento, 'SEM_DATA');
  assert.deepEqual((await listarContratosImportados(tx, 'a', HOJE, 'c2')).map((c) => c.id), ['i5', 'i6']);
  assert.deepEqual(await listarContratosImportados(tx, 'z', HOJE), []);
  assert.ok(consultas.every((c) => c.sql.trimStart().startsWith('SELECT')), 'somente leitura');
});

test('contagem de eventos a integrar: data de hoje em diante, só da empresa; nunca os sem data', async () => {
  const { tx } = banco();
  assert.equal(await contarEventosImportadosAIntegrar(tx, 'a', HOJE), 1);
  assert.equal(await contarEventosImportadosAIntegrar(tx, 'a', '2026-11-01'), 0);
  assert.equal(await contarEventosImportadosAIntegrar(tx, 'b', HOJE), 1);
});

test('detalhe: snapshot do documento, cliente, documento e pagamentos previstos; outra empresa ou inexistente ⇒ null', async () => {
  const { tx } = banco();
  const d = await detalheContratoImportado(tx, 'a', HOJE, 'i1', 'ADMINISTRATIVO');
  assert.ok(d);
  assert.equal(d.status, 'IMPORTADO');
  assert.equal(d.situacaoEvento, 'FUTURO');
  assert.deepEqual(d.cliente, { id: 'c1', nome: 'Cliente exemplo' });
  assert.deepEqual(d.documento, { id: 'd1', nome: 'contrato.pdf', contentType: 'application/pdf', tamanhoBytes: 1234 });
  assert.equal(d.contrato.valores.total, 500000);
  assert.equal(d.contrato.pagamentosPrevistos.natureza, 'PREVISTO');
  assert.deepEqual(d.pendencias, ['Festa pendente']);
  assert.equal(d.importadoPor, 'Operadora');
  assert.equal(d.podeVerOriginal, true);
  assert.equal((await detalheContratoImportado(tx, 'a', HOJE, 'i1', 'OPERACIONAL'))?.podeVerOriginal, false);
  assert.equal(await detalheContratoImportado(tx, 'a', HOJE, 'i2', 'ADMINISTRATIVO'), null, 'importação de outra empresa');
  assert.equal(await detalheContratoImportado(tx, 'a', HOJE, 'i3', 'ADMINISTRATIVO'), null, 'rascunho em revisão não é contrato');
  assert.equal(await detalheContratoImportado(tx, 'a', HOJE, 'inexistente', 'ADMINISTRATIVO'), null);
});

test('original: bytes só da importação confirmada da empresa; papéis autorizados são os que podem importar', async () => {
  const { tx } = banco();
  const o = await originalDoContratoImportado(tx, 'a', 'i1');
  assert.ok(o);
  assert.equal(o.contentType, 'application/pdf');
  assert.equal(o.nome, 'contrato.pdf');
  assert.equal(await originalDoContratoImportado(tx, 'a', 'i2'), null, 'outra empresa');
  assert.equal(await originalDoContratoImportado(tx, 'a', 'i4'), null, 'descartada');
  assert.deepEqual([...PAPEIS_ORIGINAL_IMPORTADO], ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO']);
  assert.equal(podeVerOriginal('REPRESENTANTE_AUTORIZADO'), true);
  assert.equal(podeVerOriginal('OPERACIONAL'), false);
  assert.equal(podeVerOriginal(null), false);
});

test('ambiente sem as tabelas da importação: lista vazia, contagem zero e detalhe ausente, sem outra consulta', async () => {
  const { tx, consultas } = banco({ disponivel: false });
  assert.deepEqual(await listarContratosImportados(tx, 'a', HOJE), []);
  assert.equal(await contarEventosImportadosAIntegrar(tx, 'a', HOJE), 0);
  assert.equal(await detalheContratoImportado(tx, 'a', HOJE, 'i1', 'ADMINISTRATIVO'), null);
  assert.equal(await originalDoContratoImportado(tx, 'a', 'i1'), null);
  assert.ok(consultas.every((c) => c.sql.includes('to_regclass')));
});
