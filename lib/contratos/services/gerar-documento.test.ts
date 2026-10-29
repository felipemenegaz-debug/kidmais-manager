import assert from 'node:assert/strict';
import test from 'node:test';
import { carregar } from '../../../scripts/integracao-importados-test-support.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { SNAP_V1 } from '../documento/salao-snapshots.test-apoio.ts';
import { MENSAGEM_SEM_MODELO_EMPRESA, MENSAGEM_SEM_TEMPLATE_OFICIAL } from '../documento/fonte.ts';

/**
 * Plano UX achados Frente C (revisão do código R1): o gerar_pdf EXECUTADO com executor falso, registrando consultas e
 * escritas. Confere o renderizador usado (modelo da empresa × oficial), a logo e que nas recusas nada é gravado (nem
 * documento, nem auditoria, nem histórico).
 */
type Adm = typeof import('./administrativo.service.ts');
const adm = carregar<Adm>('lib/contratos/services/administrativo.service.ts');
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const CONTEUDO_MODELO = {
  titulo: 'Contrato da Empresa', contratada: { nome: 'Buffet da Empresa Ltda', documento: '', endereco: '', representante: '' }, preambulo: [], observacoes: [],
  cidadeAssinatura: 'Goiânia/GO', clausulas: [{ titulo: 'Objeto', texto: 'Festa {{festa.pacote}} em {{festa.data}}.' }],
};

function cenario(opcoes: { aplicada072: boolean; modelo: boolean; codigo: string }) {
  const consultas: string[] = [];
  const escritas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push(sql);
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        escritas.push({ sql, values });
        return r([{ id: sql.includes('contrato_documentos') ? 'doc-1' : 'reg-1' }]);
      }
      if (sql.includes("to_regclass('public.modelos_contrato_empresa')")) return r([{ ok: opcoes.aplicada072 }]);
      if (sql.includes('FROM modelos_contrato_empresa')) return r(opcoes.modelo ? [{ id: '22222222-2222-4222-8222-222222222222', versao: 3, conteudo: CONTEUDO_MODELO, aprovado_em: new Date(0) }] : []);
      if (sql.includes('SELECT codigo FROM empresas')) return r([{ codigo: opcoes.codigo }]);
      throw new Error('consulta inesperada: ' + sql.slice(0, 80));
    },
  };
  return { tx, consultas, escritas };
}
const versao = (codigoPacote: string) => ({
  id: '33333333-3333-4333-8333-333333333333', contratoId: '44444444-4444-4444-8444-444444444444', numeroVersao: 1, snapshotHash: 'a'.repeat(64),
  snapshot: { ...structuredClone(SNAP_V1), evento: { ...structuredClone(SNAP_V1.evento), pacote: { ...SNAP_V1.evento.pacote, codigo: codigoPacote } } },
});
const edicao = { revisao: 2, dados_fonte: { observacoesDocumentais: 'Observação de teste' } };
const sessao = { usuario_id: '55555555-5555-4555-8555-555555555555' };
const gerar = (t: ReturnType<typeof cenario>, codigoPacote: string) =>
  adm.gerarDocumentoDaVersao(t.tx, versao(codigoPacote) as never, edicao, sessao as never, EMPRESA);
const documento = (t: ReturnType<typeof cenario>) => t.escritas.find((e) => e.sql.includes('INSERT INTO contrato_documentos'));
/** Parâmetros do INSERT de contrato_documentos (guardarDocumento): $5 template_codigo, $8 conteudo_pdf, $10 template_versao. */
const templateDe = (t: ReturnType<typeof cenario>) => String(documento(t)!.values[4]);
const pdfDe = (t: ReturnType<typeof cenario>) => documento(t)!.values[7] as Buffer;
const temLogo = (pdf: Buffer) => pdf.includes(Buffer.from('/Subtype /Image'));

test('gerar_pdf: com modelo próprio → renderizador da empresa, sem logo, documento + auditoria + histórico gravados', async () => {
  const t = cenario({ aplicada072: true, modelo: true, codigo: 'teste-s3' });
  const r = await gerar(t, 'P_76722EEA1485416F8F96F57BBD4C707E');
  assert.deepEqual(r, { documentoId: 'doc-1' });
  assert.match(templateDe(t), /^EMPRESA_222222222222_V3$/);
  assert.equal(temLogo(pdfDe(t)), false, 'modelo da empresa: sem a logo da Kidmais');
  assert.equal(t.escritas.length, 3, 'documento, auditoria e histórico');
  assert.ok(t.escritas.some((e) => /auditoria/i.test(e.sql)) && t.escritas.some((e) => /historico|eventos?/i.test(e.sql)));
});

test('gerar_pdf: sem a 072 → modelo oficial da Kidmais (pacote fixo), com logo', async () => {
  const t = cenario({ aplicada072: false, modelo: false, codigo: 'outra' });
  await gerar(t, 'COMPLETA');
  assert.match(templateDe(t), /^FESTA_COMPLETA_V\d$/);
  assert.equal(temLogo(pdfDe(t)), true, 'oficial: com a logo');
  assert.equal(t.consultas.some((c) => c.includes('FROM modelos_contrato_empresa')), false, 'sem 072 não lê a tabela de modelos');
});

test('gerar_pdf: Kidmais sem modelo próprio → oficial no pacote fixo; sem template → recusa sem gravar nada', async () => {
  const ok = cenario({ aplicada072: true, modelo: false, codigo: 'kidmais' });
  await gerar(ok, 'COMPLETA');
  assert.match(templateDe(ok), /^FESTA_COMPLETA_V\d$/);
  assert.equal(temLogo(pdfDe(ok)), true);
  const recusa = cenario({ aplicada072: true, modelo: false, codigo: 'kidmais' });
  await assert.rejects(gerar(recusa, 'P_76722EEA1485416F8F96F57BBD4C707E'), (e: unknown) => (e as Error).message === MENSAGEM_SEM_TEMPLATE_OFICIAL);
  assert.deepEqual(recusa.escritas, [], 'nem documento, nem auditoria, nem histórico');
});

test('gerar_pdf: empresa nova sem modelo próprio (mesmo com pacote fixo) → recusa com o texto da tela, sem gravar nada', async () => {
  const t = cenario({ aplicada072: true, modelo: false, codigo: 'buffet-novo' });
  await assert.rejects(gerar(t, 'COMPLETA'), (e: unknown) => (e as Error).message === MENSAGEM_SEM_MODELO_EMPRESA);
  assert.deepEqual(t.escritas, [], 'nem documento, nem auditoria, nem histórico');
});
