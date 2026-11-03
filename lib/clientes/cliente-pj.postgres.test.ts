import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import type { DbExecutor } from '../db/contracts';
import { carregar } from '../../scripts/integracao-importados-test-support.ts';

// O serviço usa imports sem extensão: carregado pelo mesmo require com transpile dos testes de integração.
const { atualizarClienteInterno, buscarClientesCrm, cadastrarClienteInterno } =
  carregar<typeof import('./services/cliente.service.ts')>('lib/clientes/services/cliente.service.ts');

/**
 * Entrega B — serviço do cliente PF/PJ no PostgreSQL DESCARTÁVEL. A mesma suíte roda no modelo 112 (PJ disponível) e
 * no 109 (código novo sem a 112: PJ recusada com PJ_INDISPONIVEL/MIGRACAO_PENDENTE, PF intacta). Cada teste roda numa
 * transação desfeita no fim.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
let client: Client;
let com112 = false;
const tx = () => client as unknown as DbExecutor;
const ctx = { usuarioId: null, origem: 'CRM_INTERNO' as const, ip: null, userAgent: 'sintetico' };
const CNPJ = '11222333000181';
const CNPJ_FORMATADO = '11.222.333/0001-81';
const CPF = '52998224725';
const CPF_REP = '11144477735';

async function empresa() {
  return (await client.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet PJ', 'PROVISIONAMENTO') RETURNING id::text AS id",
    [`pj${randomBytes(4).toString('hex')}`])).rows[0].id as string;
}
async function emTx(f: () => Promise<void>) {
  await client.query('BEGIN');
  try { await f(); } finally { await client.query('ROLLBACK'); }
}
const codigo = (c: string, extra: (e: { details?: Record<string, unknown>; httpStatus?: number }) => boolean = () => true) =>
  (e: unknown) => (e as { code?: string }).code === c && extra(e as { details?: Record<string, unknown>; httpStatus?: number });
const empresaPj = (empresaId: string, extra: Record<string, unknown> = {}) => ({
  empresaId, tipoPessoa: 'PJ' as const, nomeCompleto: 'Escola Pequeno Saber Ltda', cnpj: CNPJ_FORMATADO, nomeFantasia: 'Pequeno Saber',
  representanteNome: 'Ana Diretora', representanteCpf: CPF_REP, telefone: '62998765432', ...extra,
});
const linha = async (id: string) => (await client.query('SELECT to_jsonb(c) AS j FROM clientes c WHERE id = $1', [id])).rows[0].j as Record<string, unknown>;

test.before(async () => {
  if (!opt()) return;
  client = await conectarDescartavel();
  com112 = (await client.query("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'tipo_pessoa' AND NOT attisdropped) AS ok")).rows[0].ok;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('sem a 112: PJ recusada com PJ_INDISPONIVEL/MIGRACAO_PENDENTE (409, nada gravado); PF, busca por CNPJ e edição seguem', { skip: !opt() }, async (t) => {
  if (com112) return t.skip('modelo com a 112');
  await emTx(async () => {
    const e = await empresa();
    await assert.rejects(cadastrarClienteInterno(empresaPj(e), ctx, tx()),
      codigo('PJ_INDISPONIVEL', (x) => x.httpStatus === 409 && x.details?.motivo === 'MIGRACAO_PENDENTE'));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1', [e])).rows[0].n, 0);
    const pf = (await cadastrarClienteInterno({ empresaId: e, nomeCompleto: 'Maria Silva Souza', cpf: CPF, telefone: '62998765431' }, ctx, tx())).cliente;
    assert.equal(pf.tipoPessoa, 'PF'); assert.equal(pf.cnpj, null); assert.equal(pf.razaoSocial, null);
    assert.deepEqual(await buscarClientesCrm(CNPJ_FORMATADO, e, 20, false, tx()), []);
    assert.equal((await buscarClientesCrm('Maria Silva', e, 20, false, tx()))[0]?.cliente.id, pf.id);
    const editado = await atualizarClienteInterno(pf.id, e, { nomeCompleto: 'Maria Silva Souza Lima' }, ctx, tx());
    assert.equal(editado.cliente.nomeCompleto, 'Maria Silva Souza Lima');
    // A tela repete o tipo (PF) em toda edição: sem a 112 isso não toca colunas de PJ.
    const repetido = await atualizarClienteInterno(pf.id, e, { tipoPessoa: 'PF', nomeCompleto: 'Maria Silva' }, ctx, tx());
    assert.equal(repetido.cliente.tipoPessoa, 'PF');
    await assert.rejects(atualizarClienteInterno(pf.id, e, { tipoPessoa: 'PJ', cpf: null, cnpj: CNPJ }, ctx, tx()), codigo('PJ_INDISPONIVEL'));
    assert.equal((await linha(pf.id)).cpf, CPF);
  });
});

test('112: cadastro PJ grava CNPJ canônico, razão social = nome, CPF nulo e representante; PF segue PF', { skip: !opt() }, async (t) => {
  if (!com112) return t.skip('modelo sem a 112');
  await emTx(async () => {
    const e = await empresa();
    const pj = (await cadastrarClienteInterno(empresaPj(e), ctx, tx())).cliente;
    assert.equal(pj.tipoPessoa, 'PJ'); assert.equal(pj.cnpj, CNPJ); assert.equal(pj.cpf, null);
    assert.equal(pj.razaoSocial, 'Escola Pequeno Saber Ltda'); assert.equal(pj.nomeFantasia, 'Pequeno Saber');
    assert.equal(pj.representanteCpf, CPF_REP); assert.equal(pj.representanteNome, 'Ana Diretora');
    const pf = (await cadastrarClienteInterno({ empresaId: e, nomeCompleto: 'Maria Silva Souza', cpf: CPF, telefone: '62998765401' }, ctx, tx())).cliente;
    assert.equal(pf.tipoPessoa, 'PF'); assert.equal((await linha(pf.id)).tipo_pessoa, 'PF');
  });
});

test('112: PJ inválida é recusada antes do banco (CPF na PJ, CNPJ inválido ou de raiz repetida, campos PJ em PF, representante sem nome)', { skip: !opt() }, async (t) => {
  if (!com112) return t.skip('modelo sem a 112');
  await emTx(async () => {
    const e = await empresa();
    const casos: [Record<string, unknown>, string][] = [
      [empresaPj(e, { cpf: CPF }), 'cpf'],
      [empresaPj(e, { cnpj: '11222333000182' }), 'cnpj'],
      [empresaPj(e, { cnpj: '11111111111180' }), 'cnpj'],
      [empresaPj(e, { cnpj: null }), 'cnpj'],
      [empresaPj(e, { representanteNome: null }), 'representanteNome'],
      [empresaPj(e, { representanteCpf: '52998224726' }), 'representanteCpf'],
      [{ empresaId: e, nomeCompleto: 'Maria Silva Souza', cnpj: CNPJ }, 'cnpj'],
    ];
    for (const [entrada, campo] of casos) {
      await assert.rejects(cadastrarClienteInterno(entrada as never, ctx, tx()), codigo('DADOS_INVALIDOS', (x) => x.details?.campo === campo), campo);
    }
    assert.equal((await client.query('SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1', [e])).rows[0].n, 0);
  });
});

test('112: CNPJ duplicado na empresa → CNPJ_EXISTENTE (inativo oferece restaurar); outra empresa pode; busca por CNPJ e nome fantasia', { skip: !opt() }, async (t) => {
  if (!com112) return t.skip('modelo sem a 112');
  await emTx(async () => {
    const [a, b] = [await empresa(), await empresa()];
    const pj = (await cadastrarClienteInterno(empresaPj(a), ctx, tx())).cliente;
    await assert.rejects(cadastrarClienteInterno(empresaPj(a, { nomeCompleto: 'Outra Razão Ltda', cnpj: CNPJ }), ctx, tx()),
      codigo('CNPJ_EXISTENTE', (x) => x.httpStatus === 409 && x.details?.clienteId === pj.id));
    // O CPF do representante não é chave: outra PJ com o mesmo representante é aceita.
    await cadastrarClienteInterno(empresaPj(a, { nomeCompleto: 'Filial Saber Ltda', cnpj: '12ABC34501DE35' }), ctx, tx());
    assert.equal((await cadastrarClienteInterno(empresaPj(b), ctx, tx())).cliente.cnpj, CNPJ);
    await client.query("UPDATE clientes SET status = 'INATIVO' WHERE id = $1", [pj.id]);
    await assert.rejects(cadastrarClienteInterno(empresaPj(a), ctx, tx()), (x: Error) => codigo('CNPJ_EXISTENTE')(x) && /restaurar/.test(x.message));
    await client.query("UPDATE clientes SET status = 'ATIVO' WHERE id = $1", [pj.id]);
    for (const q of [CNPJ_FORMATADO, CNPJ, 'pequeno saber']) {
      assert(((await buscarClientesCrm(q, a, 20, false, tx())).map((r) => r.cliente.id)).includes(pj.id), q);
    }
    assert(!(await buscarClientesCrm(CNPJ, b, 20, false, tx())).some((r) => r.cliente.id === pj.id), 'outra empresa não vê');
  });
});

test('112: edição da PJ — razão social acompanha o nome; trocar CNPJ exige permissão; PJ→PF limpa campos; PF→PJ exige CPF removido', { skip: !opt() }, async (t) => {
  if (!com112) return t.skip('modelo sem a 112');
  await emTx(async () => {
    const e = await empresa();
    const pj = (await cadastrarClienteInterno(empresaPj(e), ctx, tx())).cliente;
    const renomeada = (await atualizarClienteInterno(pj.id, e, { nomeCompleto: 'Escola Saber Novo Ltda' }, ctx, tx())).cliente;
    assert.equal(renomeada.razaoSocial, 'Escola Saber Novo Ltda');
    await assert.rejects(atualizarClienteInterno(pj.id, e, { cnpj: '12ABC34501DE35' }, ctx, tx()), codigo('ALTERACAO_DOCUMENTO_REQUER_PERMISSAO'));
    const pf = (await atualizarClienteInterno(pj.id, e, { tipoPessoa: 'PF', nomeCompleto: 'Ana Diretora Silva' }, ctx, tx())).cliente;
    const l = await linha(pj.id);
    assert.equal(pf.tipoPessoa, 'PF');
    for (const k of ['cnpj', 'razao_social', 'nome_fantasia', 'representante_nome', 'representante_cpf']) assert.equal(l[k], null, k);
    const outro = (await cadastrarClienteInterno({ empresaId: e, nomeCompleto: 'Carlos Pereira', cpf: CPF, telefone: '62998765402' }, ctx, tx())).cliente;
    await assert.rejects(atualizarClienteInterno(outro.id, e, { tipoPessoa: 'PJ', cnpj: '12ABC34501DE35' }, ctx, tx()), codigo('DADOS_INVALIDOS', (x) => x.details?.campo === 'cpf'));
    const virou = (await atualizarClienteInterno(outro.id, e, { tipoPessoa: 'PJ', cpf: null, cnpj: '12ABC34501DE35', nomeCompleto: 'Carlos Eventos Ltda' }, ctx, tx())).cliente;
    assert.equal(virou.tipoPessoa, 'PJ'); assert.equal(virou.cpf, null); assert.equal(virou.razaoSocial, 'Carlos Eventos Ltda');
    // Troca para um CNPJ já usado na empresa: conflito, sem gravar.
    const terceiro = (await cadastrarClienteInterno({ empresaId: e, nomeCompleto: 'Bruno Lima', telefone: '62998765403' }, ctx, tx())).cliente;
    await assert.rejects(atualizarClienteInterno(terceiro.id, e, { tipoPessoa: 'PJ', cnpj: '12ABC34501DE35', nomeCompleto: 'Bruno Ltda' }, ctx, tx()), codigo('CNPJ_EXISTENTE'));
    assert.equal((await linha(terceiro.id)).tipo_pessoa, 'PF');
  });
});

test('112: troca PF↔PJ bloqueada com fechamento ou importação vinculados (TROCA_TIPO_PESSOA_BLOQUEADA, 409)', { skip: !opt() }, async (t) => {
  if (!com112) return t.skip('modelo sem a 112');
  await emTx(async () => {
    const e = await empresa();
    const pf = (await cadastrarClienteInterno({ empresaId: e, nomeCompleto: 'Carlos Pereira', telefone: '62998765404' }, ctx, tx())).cliente;
    // Só a regra de vínculo está em teste: tabelas temporárias com o mesmo nome (pg_temp vem antes de public na busca)
    // fazem o papel de fechamento/importação sem montar pacote, preço e agenda.
    for (const tabela of ['fechamentos', 'contrato_importacoes']) {
      await client.query('SAVEPOINT vinculo');
      await client.query(`CREATE TEMP TABLE ${tabela} (cliente_id uuid) ON COMMIT DROP`);
      await client.query(`INSERT INTO pg_temp.${tabela} VALUES ($1)`, [pf.id]);
      await assert.rejects(atualizarClienteInterno(pf.id, e, { tipoPessoa: 'PJ', cnpj: CNPJ, nomeCompleto: 'Carlos Ltda' }, ctx, tx()),
        codigo('TROCA_TIPO_PESSOA_BLOQUEADA', (x) => x.httpStatus === 409), tabela);
      await client.query('ROLLBACK TO SAVEPOINT vinculo');
    }
    assert.equal((await atualizarClienteInterno(pf.id, e, { tipoPessoa: 'PJ', cnpj: CNPJ, nomeCompleto: 'Carlos Ltda' }, ctx, tx())).cliente.tipoPessoa, 'PJ');
  });
});
