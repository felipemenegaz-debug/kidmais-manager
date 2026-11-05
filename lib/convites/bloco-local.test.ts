import assert from 'node:assert/strict';
import test from 'node:test';
import { blocoLocalDaFesta, enderecoUtilizavel } from './bloco-local.ts';
import { comBlocoLocal, conteudoSchema, enderecoDoConvite, inicioConteudo, localDoConvite, type BlocoLocal } from './domain.ts';

// Liberar agenda com mais de um salão (D-LIB-3/5): bloco "Local" do convite vinculado.
const EMPRESA = '00000000-0000-4000-8000-000000000001';
const ESTAB = '00000000-0000-4000-8000-000000000002';
const v3 = (salao: { id: string; nome: string } | null) => ({ schemaVersao: 3, evento: { data: '2099-12-20', salao } });
const RUA = { logradouro: 'Rua A', numero: '10', sem_numero: false, complemento: 'sala 2', bairro: 'Centro', cidade: 'Brasília', uf: 'DF' };
const SEDE = { sede_logradouro: 'Av. Sede', sede_numero: null, sede_sem_numero: true, sede_complemento: null, sede_bairro: 'Asa Sul', sede_cidade: 'Brasília', sede_uf: 'DF' };

function banco(o: { porSalao?: boolean; estabelecimento?: { nome: string; total: number } | null; perfil?: boolean;
  unidades?: Record<string, unknown>[]; nomeComercial?: string | null } = {}) {
  const consultas: string[] = [];
  const tx = { async query(sql: string) {
    consultas.push(sql);
    const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('agenda_escopo_config')) return r([{ ok: o.porSalao ?? true }]);
    if (sql.includes('FROM estabelecimentos e')) return r(o.estabelecimento === null ? [] : [o.estabelecimento ?? { nome: 'Unidade Asa Norte', total: 1 }]);
    if (sql.includes("to_regclass('public.perfil_empresas')")) return r([{ empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' }]);
    if (sql.includes('JOIN LATERAL')) return r(o.perfil === false ? [] : [{ id: 'perfil-1' }]);
    if (sql.includes('FROM perfil_unidades u')) return r(o.unidades ?? [{ nome: null, mesmo_endereco_sede: false, ...RUA, ...SEDE }]);
    if (sql.includes('SELECT nome_comercial AS nome')) return r([{ nome: o.nomeComercial ?? 'Buffet Alegria' }]);
    if (sql.includes('SELECT nome FROM public.empresas')) return r([{ nome: 'Empresa SaaS' }]);
    throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
  } };
  return { tx: tx as never, consultas };
}

test('fora de "por salão" não há bloco e só a regra do escopo é lida', async () => {
  const b = banco({ porSalao: false });
  assert.equal(await blocoLocalDaFesta(b.tx, { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3({ id: 's', nome: 'Jardim' }) }), null);
  assert.equal(b.consultas.length, 1);
});

test('versão V3 com salão: rótulo inteiro do snapshot, sem corte e sem ler cadastro', async () => {
  const nome = 'Jardim das Borboletas e Castelo Encantado combinado com o Salão Principal e o Espaço Kids '.repeat(2).trim();
  const b = banco();
  const bloco = await blocoLocalDaFesta(b.tx, { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3({ id: 's', nome }) });
  assert.deepEqual(bloco, { origem: 'SALAO', nome: `Salão ${nome}`, endereco: '' });
  assert.ok(bloco!.nome.length > 120);
  assert.equal(b.consultas.length, 1);
});

test('V1/V2 ou V3 sem salão: unidade com nome e endereço do cadastro no momento da publicação', async () => {
  for (const snapshot of [{ schemaVersao: 2, evento: {} }, v3(null), null]) {
    const bloco = await blocoLocalDaFesta(banco().tx, { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot });
    assert.deepEqual(bloco, { origem: 'UNIDADE', nome: 'Unidade Asa Norte', endereco: 'Rua A, 10 - sala 2 - Centro, Brasília/DF' });
  }
  const sede = await blocoLocalDaFesta(banco({ unidades: [{ nome: 'Casa de Festas', mesmo_endereco_sede: true, ...RUA, ...SEDE }] }).tx,
    { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3(null) });
  assert.deepEqual(sede, { origem: 'UNIDADE', nome: 'Casa de Festas', endereco: 'Av. Sede, s/n - Asa Sul, Brasília/DF' });
});

test('sem endereço utilizável fica só o nome; sem vínculo seguro com o cadastro, o nome do estabelecimento', async () => {
  const semRua = await blocoLocalDaFesta(banco({ unidades: [{ nome: null, mesmo_endereco_sede: false, ...RUA, logradouro: ' ', ...SEDE }] }).tx,
    { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3(null) });
  assert.deepEqual(semRua, { origem: 'UNIDADE', nome: 'Unidade Asa Norte', endereco: '' });
  const duas = banco({ estabelecimento: { nome: 'Unidade Sul', total: 2 } });
  assert.deepEqual(await blocoLocalDaFesta(duas.tx, { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3(null) }),
    { origem: 'UNIDADE', nome: 'Unidade Sul', endereco: '' });
  assert.equal(duas.consultas.some(q => q.includes('perfil_unidades')), false, 'com mais de um estabelecimento o cadastro único não é usado');
  for (const o of [{ perfil: false }, { unidades: [{ nome: 'A', ...RUA, ...SEDE }, { nome: 'B', ...RUA, ...SEDE }] }])
    assert.deepEqual(await blocoLocalDaFesta(banco(o).tx, { empresaId: EMPRESA, estabelecimentoId: ESTAB, snapshot: v3(null) }),
      { origem: 'UNIDADE', nome: 'Unidade Asa Norte', endereco: '' });
});

test('sem estabelecimento: nome comercial do perfil da empresa', async () => {
  for (const estabelecimentoId of [null, ESTAB]) {
    const bloco = await blocoLocalDaFesta(banco({ estabelecimento: null }).tx, { empresaId: EMPRESA, estabelecimentoId, snapshot: v3(null) });
    assert.deepEqual(bloco, { origem: 'UNIDADE', nome: 'Buffet Alegria', endereco: '' });
  }
});

test('endereço utilizável exige logradouro e cidade', () => {
  assert.equal(enderecoUtilizavel({ ...RUA, cidade: null }), '');
  assert.equal(enderecoUtilizavel({ ...RUA, complemento: null, bairro: null, uf: null }), 'Rua A, 10 - Brasília');
});

const SALAO: BlocoLocal = { origem: 'SALAO', nome: 'Salão Jardim', endereco: '' };
test('exibição: bloco inteiro + complemento; complemento igual ao bloco não repete; sem bloco, como hoje', () => {
  assert.equal(localDoConvite({ local: 'Portão 2', blocoLocal: SALAO }), 'Salão Jardim · Portão 2');
  assert.equal(localDoConvite({ local: 'salão jardim', blocoLocal: SALAO }), 'Salão Jardim');
  assert.equal(localDoConvite({ local: '', blocoLocal: SALAO }), 'Salão Jardim');
  assert.equal(localDoConvite({ local: ' Buffet Central ' }), 'Buffet Central');
  assert.equal(enderecoDoConvite({ endereco: 'Livre', blocoLocal: SALAO }), 'Livre');
  assert.equal(enderecoDoConvite({ endereco: 'Livre', blocoLocal: { ...SALAO, origem: 'UNIDADE', endereco: 'Rua A' } }), 'Rua A');
});

test('o bloco recebido é sempre substituído; inicioConteudo com bloco deixa o complemento vazio', () => {
  const forjado: BlocoLocal = { origem: 'SALAO', nome: 'Outro', endereco: '' };
  assert.deepEqual(comBlocoLocal({ local: 'x', blocoLocal: forjado }, SALAO), { local: 'x', blocoLocal: SALAO });
  assert.deepEqual(comBlocoLocal({ local: 'x', blocoLocal: forjado }, null), { local: 'x' });
  const inicio = inicioConteudo(v3({ id: 's', nome: 'Jardim' }), SALAO);
  assert.equal(inicio.local, ''); assert.deepEqual(inicio.blocoLocal, SALAO);
  assert.equal(inicioConteudo(v3({ id: 's', nome: 'Jardim' })).local, 'Salão Jardim', 'sem bloco, a sugestão inicial continua');
  assert.equal(conteudoSchema.safeParse({ ...inicio, nome: 'A', data: '2099-12-20', horario: '10:00', endereco: 'Rua' }).success, true);
  assert.equal(conteudoSchema.safeParse({ ...inicio, nome: 'A', data: '2099-12-20', horario: '10:00', endereco: 'Rua', blocoLocal: { ...SALAO, extra: 1 } }).success, false);
});
