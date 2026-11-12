import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../../db/contracts.ts';
import { lerBaseDocumentoContrato } from './base-documento.ts';
import { fonteDoDocumentoContrato, MENSAGEM_SEM_MODELO_EMPRESA, MENSAGEM_SEM_TEMPLATE_OFICIAL, type BaseDocumentoContrato } from './fonte.ts';
import { MODELOS_OFICIAIS } from './oficial/configuracao.ts';

/** Plano UX achados Frente C (rev. 3): uma regra só para o gerar_pdf e para o aviso da tela. */
const PACOTE_P = 'P_76722EEA1485416F8F96F57BBD4C707E';

test('fonte: matriz completa da regra do gerar_pdf', () => {
  for (const migration072 of [true, false]) for (const modeloEmpresaAtivo of [true, false]) for (const empresaKidmais of [true, false])
    for (const pacoteCodigo of ['COMPLETA', PACOTE_P, 'INEXISTENTE']) {
      const fonte = fonteDoDocumentoContrato({ migration072, modeloEmpresaAtivo, empresaKidmais, pacoteCodigo });
      const fixo = pacoteCodigo === 'COMPLETA';
      const esperado = modeloEmpresaAtivo ? 'EMPRESA'
        : migration072 && !empresaKidmais ? 'SEM_MODELO_EMPRESA'
        : fixo ? 'OFICIAL_KIDMAIS' : 'SEM_TEMPLATE_OFICIAL';
      assert.equal(fonte, esperado, JSON.stringify({ migration072, modeloEmpresaAtivo, empresaKidmais, pacoteCodigo }));
    }
  for (const codigo of Object.keys(MODELOS_OFICIAIS))
    assert.equal(fonteDoDocumentoContrato({ migration072: true, modeloEmpresaAtivo: false, empresaKidmais: true, pacoteCodigo: codigo }), 'OFICIAL_KIDMAIS', codigo);
});

test('fonte: contrato API → função com as três chaves exatas da projeção do painel', () => {
  // O objeto da API vai para a função COMO VEIO (sem conversão), só somado ao pacote do alvo.
  const projecaoKidmais: BaseDocumentoContrato = JSON.parse('{"migration072":true,"modeloEmpresaAtivo":false,"empresaKidmais":true}');
  assert.deepEqual(Object.keys(projecaoKidmais).sort(), ['empresaKidmais', 'migration072', 'modeloEmpresaAtivo']);
  assert.equal(fonteDoDocumentoContrato({ ...projecaoKidmais, pacoteCodigo: 'COMPLETA' }), 'OFICIAL_KIDMAIS', 'Kidmais sem modelo e pacote fixo: igual ao servidor');
  assert.equal(fonteDoDocumentoContrato({ ...projecaoKidmais, pacoteCodigo: PACOTE_P }), 'SEM_TEMPLATE_OFICIAL');
  assert.equal(fonteDoDocumentoContrato({ ...projecaoKidmais, empresaKidmais: false, pacoteCodigo: 'COMPLETA' }), 'SEM_MODELO_EMPRESA', 'empresa nova sem modelo');
  assert.equal(MENSAGEM_SEM_MODELO_EMPRESA, 'Esta empresa ainda não tem modelo de contrato. Cadastre em Configurações › Importar documentos › Modelo de contrato.');
  assert.equal(MENSAGEM_SEM_TEMPLATE_OFICIAL, 'Pacote sem template oficial disponível.');
});

function txFalso(opcoes: { aplicada072: boolean; modelo: boolean; codigo: string | null }) {
  const consultas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes("to_regclass('public.modelos_contrato_empresa')")) return r([{ ok: opcoes.aplicada072 }]);
      if (sql.includes('FROM modelos_contrato_empresa')) return r(opcoes.modelo ? [{ id: 'm1', versao: 1, aprovado_em: new Date(0), conteudo: {
        titulo: 'Contrato', contratada: { nome: 'Buffet', documento: '', endereco: '', representante: '' }, preambulo: [], observacoes: [], cidadeAssinatura: 'Goiânia/GO',
        clausulas: [{ titulo: null, texto: '{{festa.data}}' }] } }] : []);
      if (sql.includes('SELECT codigo FROM empresas')) return r(opcoes.codigo === null ? [] : [{ codigo: opcoes.codigo }]);
      throw new Error('consulta inesperada: ' + sql.slice(0, 60));
    },
  };
  return { tx, consultas };
}

test('base: só leituras, na empresa pedida; projeção com exatamente três booleanos, sem conteúdo nem versão', async () => {
  const E = '11111111-1111-4111-8111-111111111111';
  const casos: Array<[Parameters<typeof txFalso>[0], BaseDocumentoContrato]> = [
    [{ aplicada072: true, modelo: true, codigo: 'teste-s3' }, { migration072: true, modeloEmpresaAtivo: true, empresaKidmais: false }],
    [{ aplicada072: true, modelo: true, codigo: 'kidmais' }, { migration072: true, modeloEmpresaAtivo: true, empresaKidmais: true }],
    [{ aplicada072: true, modelo: false, codigo: 'kidmais' }, { migration072: true, modeloEmpresaAtivo: false, empresaKidmais: true }],
    [{ aplicada072: true, modelo: false, codigo: null }, { migration072: true, modeloEmpresaAtivo: false, empresaKidmais: false }],
    [{ aplicada072: false, modelo: false, codigo: 'outra' }, { migration072: false, modeloEmpresaAtivo: false, empresaKidmais: false }],
  ];
  for (const [opcoes, esperado] of casos) {
    const { tx, consultas } = txFalso(opcoes);
    const { base, modeloEmpresa } = await lerBaseDocumentoContrato(tx, E);
    assert.deepEqual(base, esperado, JSON.stringify(opcoes));
    assert.deepEqual(Object.keys(base).sort(), ['empresaKidmais', 'migration072', 'modeloEmpresaAtivo']);
    assert.equal(Boolean(modeloEmpresa), opcoes.modelo && opcoes.aplicada072);
    for (const c of consultas) {
      assert.doesNotMatch(c.sql, /\b(INSERT|UPDATE|DELETE)\b/i, 'só leitura');
      if (c.values.length) assert.deepEqual(c.values, [E], 'sempre a empresa pedida');
    }
  }
});

test('gerar_pdf e painel: decidem pela mesma função e pela mesma leitura', () => {
  const servico = readFileSync('lib/contratos/services/administrativo.service.ts', 'utf8');
  const gerar = servico.slice(servico.indexOf('export async function gerarDocumentoDaVersao'), servico.indexOf('export async function operarContrato'));
  assert.match(servico, /if \(input\.acao === 'gerar_pdf'\)\n\s+return gerarDocumentoDaVersao\(tx, v, e, s, empresaAutorizada\);/, 'operarContrato delega à função testada');
  const ordem = ['lerBaseDocumentoContrato(tx, empresaAutorizada)', "fonteDoDocumentoContrato({ ...base, pacoteCodigo: v.snapshot.evento.pacote.codigo }) === 'SEM_MODELO_EMPRESA'",
    'conflito(MENSAGEM_SEM_MODELO_EMPRESA)', 'renderizarModeloEmpresa(modeloEmpresa', 'renderizarContratoOficial(', 'conflito(MENSAGEM_SEM_TEMPLATE_OFICIAL)'];
  let pos = -1;
  for (const marca of ordem) { const i = gerar.indexOf(marca); assert.ok(i > pos, marca); pos = i; }
  assert.match(servico, /gerarPdfContratoOficial\(rendered, \{ logo: !modeloEmpresa \}\)/, 'logo só sem modelo da empresa');
  const painel = readFileSync('app/api/admin/contratos/painel/route.ts', 'utf8');
  assert.match(painel, /executarComPosseNoTenant\(sessao, empresaSolicitada, id, contratoNoTenant, \{ withTenantTransaction \}, async \(tx, tenant\) => \(\{[\s\S]*baseDocumento: \(await lerBaseDocumentoContrato\(tx, tenant\.empresaComprovada\)\)\.base \}/);
});
