/* eslint-disable @typescript-eslint/no-require-imports */
// Serviço real com executor em memória. Não conecta banco nem provedor.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function carregar(file, deps) {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Buffer })(name => deps[name] ?? require(name.startsWith('.') ? path.resolve(__dirname, name) : name), m, m.exports);
  return m.exports;
}
const domain = carregar('domain.ts', {}), sessao = { usuario_id: id(3) };
function fixture(op = {}) {
  let convite = op.semConvite ? null : { id: id(1), empresa_id: id(2), festa_id: op.vinculado ?? null, revisao: 3,
    rascunho: { ...domain.inicioConteudo(null), nome: 'Nome editado', local: 'Meu buffet', arteId: id(9) }, publicado: {}, usado_festa: 2 };
  const log = [], eventos = []; let revogacoes = 0, comprovacoes = 0, tail = Promise.resolve();
  const tx = { async query(sql, v = []) {
    log.push({ sql, v }); let rows = [];
    if (sql.includes('FROM festa_membership_capacidades')) rows = op.semPermissao ? [] : [{ id: id(4) }];
    else if (sql.includes('SELECT count(*) n')) rows = [{ n: op.limite ? '1000' : '0' }];
    else if (sql.startsWith('SELECT id FROM convites WHERE id')) rows = convite && convite.id === v[0] && convite.empresa_id === v[1] ? [{ id: convite.id }] : [];
    else if (sql.includes('SELECT f.contrato_id,fe.cliente_id')) rows = op.outraFesta ? [] : [{ contrato_id: id(7), cliente_id: id(8), estabelecimento_id: op.unidade ? id(19) : null }];
    else if (sql.startsWith('SELECT invalidada_em')) rows = [{ invalidada_em: op.invalidada ? new Date() : null }];
    else if (sql.startsWith('SELECT id,empresa_id,festa_id')) rows = convite && !op.outroTenant ? [convite] : [];
    else if (sql.startsWith('SELECT id FROM convites WHERE festa_id')) rows = op.ocupada ? [{ id: id(22) }] : [];
    else if (sql.includes('FROM convite_geracoes')) rows = op.pendente ? [{ id: id(23) }] : [];
    else if (sql.startsWith('INSERT INTO convites')) convite = { id: v[0], empresa_id: v[1], publico_token: v[2], rascunho: v[3] };
    else if (sql.startsWith('UPDATE convites SET festa_id')) {
      Object.assign(convite, { festa_id: v[2], cliente_id: v[3], estabelecimento_id: v[4], versao_contrato_id: v[5], rascunho: v[6], publicado: null, revisao: convite.revisao + 1 });
    } else if (sql.startsWith('INSERT INTO convite_eventos')) { if (op.falhaEvento) throw new Error('falha sintética'); eventos.push(v); }
    else if (sql.includes('SELECT c.id,c.festa_id')) rows = Array.from({ length: 13 }, (_, n) => ({ id: id(n + 30) }));
    else if (sql.startsWith('SELECT a.imagem')) rows = op.imagemAusente ? [] : [{ imagem: Buffer.from('imagem') }];
    return { rows: rows.map(x => ({ ...x })) };
  } };
  const service = carregar('biblioteca.ts', {
    '../db/postgres': { withTransaction: fn => { const p = tail.then(async () => { const antes = structuredClone(convite), ev = eventos.length, rev = revogacoes; try { return await fn(tx); } catch (e) { convite = antes; eventos.length = ev; revogacoes = rev; throw e; } }); tail = p.catch(() => {}); return p; } },
    '../saas/provar-tenant': { provarTenant: async () => ({ empresaComprovada: id(2), membershipId: id(4) }), revalidarTenant: async () => {} },
    '../saas/provar-estabelecimento': { provarEstabelecimento: async () => { comprovacoes++; if (op.unidadeProibida) throw new Error('Unidade não encontrada'); } },
    '../assinatura/estado': { lerEstadoComercial: async () => ({ acesso: { nivel: op.leitura ? 'SOMENTE_LEITURA' : 'COMPLETO' } }) },
    '../festas/repository': { contrato: async () => ({ status: op.cancelada ? 'CANCELADO' : 'ASSINADO', versao_id: id(20), snapshot: { aniversariante: { nome: 'Nome da festa', idadeNoEvento: 6 }, evento: { data: '2027-02-20', horarioInicio: '15:00' } } }) },
    './domain': domain, './service': { habilitado() {} }, './consentimento': { revogarAutorizacao: async () => { revogacoes++; } },
  });
  return { service, log, eventos, c: () => convite, revogacoes: () => revogacoes, comprovacoes: () => comprovacoes };
}
const vincular = { acao: 'vincular', conviteId: id(1), festaId: id(6), revisao: 3, usarDadosFesta: true };
test('criar: UUID da intenção resiste a clique duplo sem reserva de crédito', async () => {
  const f = fixture({ semConvite: true }), cmd = { acao: 'criar', id: id(1) };
  const [a, b] = await Promise.all([f.service.operarBiblioteca(sessao, cmd), f.service.operarBiblioteca(sessao, cmd)]);
  assert.equal(a.id, b.id); assert.equal(f.eventos.length, 1); assert.equal(f.c().rascunho.nome, '');
  assert(!f.log.some(q => /convite_consumos|convite_carteiras|convite_geracoes/.test(q.sql)));
});
test('criar: capacidade, acesso comercial e limite barram antes da escrita', async () => {
  for (const op of [{ semPermissao: true }, { leitura: true }, { limite: true }]) {
    const f = fixture({ ...op, semConvite: true });
    await assert.rejects(f.service.operarBiblioteca(sessao, { acao: 'criar', id: id(1) }));
    assert.equal(f.c(), null); assert.equal(f.eventos.length, 0);
  }
});
test('vincular preserva id, imagem e uso; preenche dados, revoga autorização e exige republicação', async () => {
  const f = fixture({ unidade: true });
  await f.service.operarBiblioteca(sessao, vincular);
  assert.equal(f.c().id, id(1)); assert.equal(f.c().rascunho.nome, 'Nome da festa'); assert.equal(f.c().rascunho.idade, '6 anos');
  assert.equal(f.c().rascunho.arteId, id(9)); assert.equal(f.c().rascunho.local, 'Meu buffet'); assert.equal(f.c().usado_festa, 2);
  assert.equal(f.c().publicado, null); assert.equal(f.c().revisao, 4); assert.equal(f.revogacoes(), 1); assert.equal(f.comprovacoes(), 1);
  await f.service.operarBiblioteca(sessao, vincular); assert.equal(f.eventos.length, 1); assert.equal(f.revogacoes(), 1);
});
test('vincular pode manter dados editados; nunca recria nem cobra', async () => {
  const f = fixture(); await f.service.operarBiblioteca(sessao, { ...vincular, usarDadosFesta: false });
  assert.equal(f.c().rascunho.nome, 'Nome editado');
  assert(!f.log.some(q => /INSERT INTO convites|convite_consumos|convite_carteiras/.test(q.sql)));
});
test('vincular recusa outro tenant, unidade, festa ocupada, cancelada, revisão antiga e geração pendente', async () => {
  for (const op of [{ outroTenant: true }, { outraFesta: true }, { ocupada: true }, { invalidada: true }, { cancelada: true }, { pendente: true }, { unidade: true, unidadeProibida: true }, { vinculado: id(25) }]) {
    const f = fixture(op), antes = JSON.stringify(f.c());
    await assert.rejects(f.service.operarBiblioteca(sessao, vincular));
    assert.equal(JSON.stringify(f.c()), antes); assert.equal(f.revogacoes(), 0);
  }
  const f = fixture(); await assert.rejects(f.service.operarBiblioteca(sessao, { ...vincular, revisao: 1 }), /alterado/);
});
test('auditoria falhando reverte vínculo, publicação e revogação', async () => {
  const f = fixture({ falhaEvento: true }), antes = JSON.stringify(f.c());
  await assert.rejects(f.service.operarBiblioteca(sessao, vincular), /sintética/);
  assert.equal(JSON.stringify(f.c()), antes); assert.equal(f.revogacoes(), 0);
});
test('listagem paginada usa tenant, unidade e filtro; não carrega imagens nem reconcilia gerações', async () => {
  const f = fixture({ leitura: true }); const r = await f.service.listarConvites(sessao, { filtro: 'avulsos', pagina: 2 });
  assert.equal(r.itens.length, 12); assert.equal(r.proxima, true);
  const q = f.log.find(q => q.sql.includes('SELECT c.id,c.festa_id'));
  assert.deepEqual(Array.from(q.v), [id(2), id(4), 'avulsos', 12]);
  assert.match(q.sql, /membership_estabelecimentos/); assert.match(q.sql, /me\.vigente_ate/); assert.match(q.sql, /c\.empresa_id=\$1/);
  assert(!f.log.some(q => /FOR UPDATE|UPDATE convite|SELECT.*imagem/.test(q.sql)));
});
test('miniatura recusa imagem inexistente e filtra convite, empresa e unidade', async () => {
  const f = fixture({ imagemAusente: true }); await assert.rejects(f.service.miniaturaConvite(sessao, id(1)), /Imagem não encontrada/);
  const q = f.log.find(q => q.sql.startsWith('SELECT a.imagem'));
  assert.deepEqual(Array.from(q.v), [id(2), id(4), id(1)]); assert.match(q.sql, /a\.empresa_id=c\.empresa_id/); assert.match(q.sql, /membership_estabelecimentos/);
});
test('campos extras e paginação inválida não entram no executor', () => {
  const f = fixture();
  assert.throws(() => f.service.operarBiblioteca(sessao, { acao: 'criar', id: id(1), empresaId: id(99) }));
  assert.throws(() => f.service.listarConvites(sessao, { pagina: -1 }));
  assert.equal(f.log.length, 0);
});
