import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { capturarCampanha } from './utm.ts';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '22222222-2222-4222-8222-222222222222';
const CAMPANHA_A = '33333333-3333-4333-8333-333333333333';
const CLIENTE_EXISTENTE = '44444444-4444-4444-8444-444444444444';

type Mod = {
  capturarContatoPublico(tx: unknown, site: { siteId: string; empresaId: string; estabelecimentoId: string | null }, entrada: Record<string, unknown>, captura: unknown): Promise<{ contatoId: string; repetido: boolean }>;
  esquemaFormularioPublico: { safeParse(v: unknown): { success: boolean } };
};
const mod = carregarModulo('lib/marketing/contatos.ts', { 'db/postgres': { db: () => { throw new Error('sem banco'); } } }) as unknown as Mod;

function linhaCliente(id: string, empresa: string, status = 'ATIVO') {
  return { id, empresa_id: empresa, nome_completo: 'Fulana', cpf: null, rg: null, telefone: '11999990000', whatsapp: '11999990000', email: 'f@x.com', cep: null, logradouro: null, numero: null,
    complemento: null, bairro: null, cidade: null, uf: null, observacoes: null, status, cliente_principal_id: null, mesclado_em: null, criado_por_usuario_id: null,
    atualizado_por_usuario_id: null, criado_em: '2026-01-01', atualizado_em: '2026-01-01' };
}

/** Banco falso com estado mínimo: contatos por chave, campanha da empresa A, clientes existentes e atribuições. */
function banco(opcoes: { clientesPorTelefone?: unknown[] } = {}) {
  const chaves = new Map<string, string>();
  const atribuicoes: Array<{ empresa: string; alvoTipo: string; alvoId: string; origem: string; metodo: string; campanha: string | null }> = [];
  const sqls: string[] = [];
  let seq = 0;
  const tx = {
    async query(sql: string, p: unknown[] = []) {
      sqls.push(sql);
      if (/INSERT INTO marketing_contatos/.test(sql)) {
        const chave = `${p[0]}:${p[9]}`;
        if (chaves.has(chave)) return { rows: [], rowCount: 0 };
        const id = `c0000000-0000-4000-8000-00000000000${++seq}`; chaves.set(chave, id); return { rows: [{ id }], rowCount: 1 };
      }
      if (/SELECT id::text FROM marketing_contatos WHERE empresa_id/.test(sql)) return { rows: [{ id: chaves.get(`${p[0]}:${p[1]}`) }], rowCount: 1 };
      if (/FROM marketing_campanhas WHERE empresa_id = \$1::uuid AND codigo = \$2/.test(sql)) {
        return p[0] === EMPRESA_A && p[1] === 'nov-centro'
          ? { rows: [{ id: CAMPANHA_A, codigo: 'nov-centro', nome: 'Nov', canal: 'INSTAGRAM', origem_codigo: 'INSTAGRAM', objetivo: null, inicio: '2026-10-01', fim: null, orcamento_centavos: null,
            utm_source: 'instagram', utm_medium: 'social', status: 'ATIVA', estabelecimento_id: null, site_id: null, versao: 1, criada_em: '', atualizada_em: '' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO marketing_atribuicoes/.test(sql)) {
        const existe = atribuicoes.some((a) => a.empresa === p[0] && a.alvoTipo === p[1] && a.alvoId === p[2]);
        if (existe) return { rows: [], rowCount: 0 };
        atribuicoes.push({ empresa: String(p[0]), alvoTipo: String(p[1]), alvoId: String(p[2]), origem: String(p[3]), metodo: String(p[6]), campanha: (p[5] as string) ?? null });
        return { rows: [{ id: `a-${atribuicoes.length}` }], rowCount: 1 };
      }
      if (/FROM marketing_atribuicoes a/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM clientes\s+WHERE empresa_id = \$2::uuid\s+AND status <> 'MESCLADO'\s+AND \(telefone = \$1 OR whatsapp = \$1\)/.test(sql)) return { rows: p[1] === EMPRESA_A ? (opcoes.clientesPorTelefone ?? []) : [], rowCount: 0 };
      if (/lower\(email\)=\$1/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO clientes/.test(sql)) return { rows: [linhaCliente(`novo-cliente-${++seq}`, String(p[0]))], rowCount: 1 };
      if (/count\(\*\) = 2 AND count\(DISTINCT empresa_id\)/.test(sql)) return { rows: [{ ok: true }], rowCount: 1 };
      if (/INSERT INTO (auditoria|eventos_historico_cliente|possiveis_duplicidades_cliente)/.test(sql)) return { rows: [{ id: 'x', metadata: {}, motivos: [], dados_antes: null, dados_depois: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, atribuicoes, sqls };
}

const site = { siteId: '55555555-5555-4555-8555-555555555555', empresaId: EMPRESA_A, estabelecimentoId: null };
const entrada = (chave: string) => ({ nome: 'Fulana', telefone: '11999990000', email: null, dataDesejada: null, convidados: 40, mensagem: null, chave });

test('pedido com kc da campanha da empresa: contato CAPTURADO; cliente novo recebe a mesma como primeira origem', async () => {
  const b = banco();
  const r = await mod.capturarContatoPublico(b.tx, site, entrada('chave-aaaaaaaaaaaaaaaa'), capturarCampanha({ kc: 'nov-centro', utm_source: 'instagram' }));
  assert.equal(r.repetido, false);
  const contato = b.atribuicoes.find((a) => a.alvoTipo === 'CONTATO')!;
  assert.deepEqual([contato.origem, contato.metodo, contato.campanha], ['INSTAGRAM', 'CAPTURADO', CAMPANHA_A]);
  const cliente = b.atribuicoes.find((a) => a.alvoTipo === 'CLIENTE')!;
  assert.deepEqual([cliente.origem, cliente.metodo], ['INSTAGRAM', 'CAPTURADO']);
  assert.ok(b.sqls.some((s) => /INSERT INTO clientes/.test(s)));
});

test('sem UTM/kc: origem DESCONHECIDA (nada inventado); kc de outra empresa também não atribui', async () => {
  const b = banco();
  await mod.capturarContatoPublico(b.tx, site, entrada('chave-bbbbbbbbbbbbbbbb'), capturarCampanha({}));
  assert.deepEqual(b.atribuicoes.map((a) => [a.alvoTipo, a.origem, a.metodo]), [['CONTATO', 'DESCONHECIDA', 'DESCONHECIDO'], ['CLIENTE', 'DESCONHECIDA', 'DESCONHECIDO']]);
  const b2 = banco();
  await mod.capturarContatoPublico(b2.tx, { ...site, empresaId: EMPRESA_B }, entrada('chave-cccccccccccccccc'), capturarCampanha({ kc: 'nov-centro' }));
  assert.equal(b2.atribuicoes[0].origem, 'DESCONHECIDA', 'campanha da empresa A não serve ao site da empresa B');
});

test('cliente recorrente (mesmo telefone): reaproveitado sem nova primeira origem; contato registra a origem atual', async () => {
  const b = banco({ clientesPorTelefone: [linhaCliente(CLIENTE_EXISTENTE, EMPRESA_A)] });
  await mod.capturarContatoPublico(b.tx, site, entrada('chave-dddddddddddddddd'), capturarCampanha({ kc: 'nov-centro' }));
  assert.equal(b.sqls.some((s) => /INSERT INTO clientes/.test(s)), false, 'não cria cliente duplicado');
  assert.equal(b.atribuicoes.some((a) => a.alvoTipo === 'CLIENTE'), false, 'origem histórica do cliente preservada');
  assert.equal(b.atribuicoes.find((a) => a.alvoTipo === 'CONTATO')?.campanha, CAMPANHA_A);
});

test('ambíguo (dois clientes com o telefone): cria cliente e registra possível duplicidade, sem escolher por conta própria', async () => {
  const b = banco({ clientesPorTelefone: [linhaCliente(CLIENTE_EXISTENTE, EMPRESA_A), linhaCliente('66666666-6666-4666-8666-666666666666', EMPRESA_A)] });
  await mod.capturarContatoPublico(b.tx, site, entrada('chave-eeeeeeeeeeeeeeee'), capturarCampanha({}));
  assert.ok(b.sqls.some((s) => /INSERT INTO clientes/.test(s)));
  assert.equal(b.sqls.filter((s) => /INSERT INTO possiveis_duplicidades_cliente/.test(s)).length, 2);
});

test('repetição da mesma chave: devolve o mesmo contato e não grava mais nada (sem conversão duplicada)', async () => {
  const b = banco();
  const primeira = await mod.capturarContatoPublico(b.tx, site, entrada('chave-ffffffffffffffff'), capturarCampanha({ kc: 'nov-centro' }));
  const escritas = b.sqls.length;
  const segunda = await mod.capturarContatoPublico(b.tx, site, entrada('chave-ffffffffffffffff'), capturarCampanha({ kc: 'nov-centro' }));
  assert.equal(segunda.repetido, true);
  assert.equal(segunda.contatoId, primeira.contatoId);
  assert.equal(b.sqls.slice(escritas).filter((s) => /^\s*(INSERT|UPDATE)/.test(s) && !/ON CONFLICT \(empresa_id, chave_idempotencia\)/.test(s)).length, 0);
  assert.equal(b.atribuicoes.length, 2);
});

test('formulário público: exige nome e telefone ou e-mail; chave de idempotência; campos extras recusados', () => {
  const ok = { nome: 'Ana', telefone: '(11) 99999-0000', chave: 'a'.repeat(20) };
  assert.equal(mod.esquemaFormularioPublico.safeParse(ok).success, true);
  assert.equal(mod.esquemaFormularioPublico.safeParse({ ...ok, telefone: '' }).success, false, 'sem meio de retorno');
  assert.equal(mod.esquemaFormularioPublico.safeParse({ ...ok, email: 'ana@exemplo.com', telefone: '' }).success, true);
  assert.equal(mod.esquemaFormularioPublico.safeParse({ ...ok, empresaId: EMPRESA_B }).success, false, 'navegador não escolhe empresa');
  assert.equal(mod.esquemaFormularioPublico.safeParse({ ...ok, chave: 'curta' }).success, false);
  assert.equal(mod.esquemaFormularioPublico.safeParse({ ...ok, telefone: '123' }).success, false);
});
