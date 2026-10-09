/* eslint-disable @typescript-eslint/no-require-imports */
// Serviço real transpilado, dependências de banco/provedor substituídas. Nunca abre rede ou PostgreSQL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), crypto = require('node:crypto');
function carregar(file, deps) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env: { CONVITES_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '3000000' } }, Buffer, Date, Intl })(
    name => deps[name] ?? require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name), m, m.exports);
  return m.exports;
}
const domain = carregar(path.join(__dirname, 'domain.ts'), {});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const editorToken = 'a'.repeat(43);
function fixture(options = {}) {
  let used = options.used ?? 0, calls = 0, tail = Promise.resolve();
  const log = [], jobs = new Map(), artes = new Set([id(88), id(89)]);
  const c = { id: id(1), empresa_id: id(2), festa_id: id(3), cliente_id: id(4), estabelecimento_id: null,
    editor_hash: crypto.createHash('sha256').update(editorToken).digest('hex'), editor_expira_em: new Date('2099-01-01'),
    limite_festa: 3, limite_cliente: 2, usado_festa: options.partyUsed ?? 0, usado_cliente: options.clientUsed ?? 0,
    revisao: 1, versao_contrato_id: id(5), rascunho: domain.inicioConteudo({}), publicado: null, publico_token: 'p'.repeat(43) };
  const tx = { async query(sql, v = []) {
    log.push({ sql, v }); let rows = [];
    if (sql.includes('FROM festa_membership_capacidades')) rows = [{ id: id(90) }];
    else if (sql.includes('FROM empresas WHERE')) rows = [{ id: c.empresa_id }];
    else if (sql.includes('FROM festas f JOIN contratos')) rows = options.otherTenant ? [] : [{ empresa_id: c.empresa_id, cliente_id: c.cliente_id, estabelecimento_id: null, contrato_id: id(6), invalidada_em: null }];
    else if (sql.includes('SELECT invalidada_em FROM festas')) rows = [{ invalidada_em: null }];
    else if (sql.includes('SELECT * FROM convites WHERE editor_hash')) rows = options.revoked ? [] : [c];
    else if (sql.includes('SELECT * FROM convites WHERE festa_id')) rows = [c];
    else if (sql.includes('CASE WHEN w.ativo')) rows = [{ limite: 60, usado: used }];
    else if (sql.includes('SELECT * FROM convite_geracoes')) rows = jobs.has(v[0]) ? [jobs.get(v[0])] : [];
    else if (sql.includes('SELECT id FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.estado === 'RESERVADA');
    else if (sql.includes('count(*) n FROM convite_artes')) rows = [{ n: '0' }];
    else if (sql.includes('SELECT imagem FROM convite_artes')) rows = []; // Nenhuma arte de outra festa é autorizada.
    else if (sql.includes('SELECT id FROM convite_artes')) rows = artes.has(v[0]) && v[1] === c.id && v[2] === c.empresa_id ? [{ id: v[0] }] : [];
    else if (sql.includes('UPDATE convite_geracoes SET arte_id=NULL')) { for (const j of jobs.values()) if (j.arte_id === v[0]) j.arte_id = null; }
    else if (sql.includes('DELETE FROM convite_artes')) artes.delete(v[0]);
    else if (sql.includes('UPDATE convites SET rascunho=$2,revisao')) { c.rascunho = v[1]; c.revisao++; }
    else if (sql.includes('INSERT INTO convite_orcamento_global')) rows = options.globalExhausted ? [] : [{ dia: '2026-10-08' }];
    else if (sql.includes('INSERT INTO convite_consumos')) used++;
    else if (sql.includes('UPDATE convites SET usado_festa')) { c.usado_festa++; c.usado_cliente += v[1]; }
    else if (sql.includes('INSERT INTO convite_geracoes')) jobs.set(v[0], { estado: 'RESERVADA', convite_id: v[1], ator: v[3], payload_hash: v[4], arte_id: null });
    else if (sql.includes('INSERT INTO convite_artes')) rows = [{ id: id(88) }];
    else if (sql.includes("SET estado='CONCLUIDA'")) { const j = jobs.get(v[0]); j.estado = 'CONCLUIDA'; j.arte_id = v[1]; }
    else if (sql.includes("SET estado='INCERTA'")) jobs.get(v[0]).estado = 'INCERTA';
    return { rows, rowCount: rows.length };
  } };
  const service = carregar(path.join(__dirname, 'service.ts'), {
    '../db/postgres': { db: () => tx, withTransaction: fn => { const next = tail.then(() => fn(tx)); tail = next.catch(() => {}); return next; } },
    '../saas/provar-tenant': { provarTenant: async () => ({ empresaComprovada: c.empresa_id, membershipId: id(7), usuarioId: id(8), papelAtual: 'REPRESENTANTE_AUTORIZADO' }), revalidarTenant: async () => {} },
    '../saas/provar-estabelecimento': { provarEstabelecimento: async () => {} },
    '../festas/repository': { contrato: async () => ({ status: options.cancelled ? 'CANCELADO' : 'ASSINADO', versao_id: id(5), snapshot: { evento: { convidados: options.convidados ?? 50 }, privado: 'NAO_EXPOR' } }) },
    '../assinatura/estado': { lerEstadoComercial: async () => ({ acesso: { nivel: options.paywall ? 'SOMENTE_LEITURA' : 'COMPLETO' } }) },
    './domain': domain,
    './imagem': { MODELO: 'modelo-sintetico', iaConfigurada: () => true, normalizarImagem: async () => Buffer.from('synthetic'), gerarImagem: async () => { calls++; if (options.providerFailure) throw Error('timeout'); return { imagem: Buffer.from('synthetic'), uso: {} }; } },
  });
  return { service, c, log, jobs, artes, usage: () => used, calls: () => calls };
}
const admin = { tipo: 'admin', sessao: { usuario_id: id(8) }, festaId: id(3) };
const cliente = { tipo: 'cliente', token: editorToken };
const pedido = n => ({ acao: 'gerar', chave: id(n), prompt: 'Arte para festa no jardim', referencias: [] });

test('consulta traz somente quantidade do contrato vigente, respeita tenant e não expõe snapshot', async () => {
  for (const acesso of [admin, cliente]) {
    const f = fixture({ convidados: 80 }), d = await f.service.consultar(acesso);
    assert.equal(d.convidadosContratados, 80); assert(!JSON.stringify(d).includes('NAO_EXPOR'));
    assert.equal((await fixture({ convidados: -1 }).service.consultar(acesso)).convidadosContratados, null);
    await assert.rejects(fixture({ otherTenant: true }).service.consultar(acesso));
  }
});

test('exclusão de imagem: remove arquivo e seleção do rascunho sem alterar publicação nem devolver créditos', async () => {
  for (const acesso of [admin, cliente]) {
    const f = fixture({ used: 3, partyUsed: 2, clientUsed: 1 });
    f.c.rascunho = { ...f.c.rascunho, arteId: id(88), nome: 'Texto preservado' };
    f.c.publicado = { ...f.c.rascunho, arteId: id(89) };
    f.jobs.set(id(10), { estado: 'CONCLUIDA', arte_id: id(88) });
    await f.service.comandar(acesso, { acao: 'excluir_arte', arteId: id(88), revisao: 1 });
    assert.equal(f.artes.has(id(88)), false); assert.equal(f.artes.has(id(89)), true);
    assert.equal(f.c.rascunho.arteId, null); assert.equal(f.c.rascunho.nome, 'Texto preservado');
    assert.equal(f.c.publicado.arteId, id(89)); assert.equal(f.c.revisao, 2);
    assert.equal(f.jobs.get(id(10)).arte_id, null); assert.equal(f.jobs.get(id(10)).estado, 'CONCLUIDA');
    assert.equal(f.usage(), 3); assert.equal(f.c.usado_festa, 2); assert.equal(f.c.usado_cliente, 1);
    const q = f.log.find(l => l.sql.includes('DELETE FROM convite_artes'));
    assert.deepEqual(Array.from(q.v), [id(88), f.c.id, f.c.empresa_id]);
    assert(f.log.some(l => l.sql.includes('INSERT INTO convite_eventos') && l.v[2] === 'ARTE_EXCLUIDA'));
    await assert.rejects(f.service.comandar(acesso, { acao: 'excluir_arte', arteId: id(89), revisao: 1 }), /alterado por outra pessoa/);
  }
});

test('exclusão recusa imagem publicada, de outra festa e revisão desatualizada antes de escrever', async () => {
  for (const caso of ['publicada', 'outra-festa', 'revisao']) {
    const f = fixture(); f.c.publicado = caso === 'publicada' ? { ...f.c.rascunho, arteId: id(88) } : null;
    await assert.rejects(f.service.comandar(admin, { acao: 'excluir_arte', arteId: caso === 'outra-festa' ? id(55) : id(88), revisao: caso === 'revisao' ? 2 : 1 }));
    assert.equal(f.log.filter(l => /^(DELETE|UPDATE|INSERT)/.test(l.sql)).length, 0);
    assert.equal(f.artes.size, 2);
  }
});

test('exclusão respeita empresa, acesso revogado, contrato cancelado e acesso somente leitura', async () => {
  for (const options of [{ otherTenant: true }, { revoked: true }, { cancelled: true }, { paywall: true }]) {
    const f = fixture(options);
    await assert.rejects(f.service.comandar(cliente, { acao: 'excluir_arte', arteId: id(88), revisao: 1 }));
    assert.equal(f.artes.size, 2); assert.equal(f.log.filter(l => /^(DELETE|UPDATE|INSERT)/.test(l.sql)).length, 0);
  }
});
test('serviço: cliente esgotado não gasta mais; buffet pode usar saldo da festa', async () => {
  const f = fixture({ partyUsed: 2, clientUsed: 2 });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), /Seu limite/); assert.equal(f.calls(), 0);
  await f.service.comandar(admin, pedido(11)); assert.equal(f.calls(), 1); assert.equal(f.c.usado_festa, 3);
  await assert.rejects(f.service.comandar(admin, pedido(12)), /cota desta festa/); assert.equal(f.calls(), 1);
});
test('serviço: repetição idempotente não gera nem cobra outra vez', async () => {
  const f = fixture(); const p = pedido(10);
  await f.service.comandar(cliente, p); const repetida = await f.service.comandar(cliente, p);
  assert.equal(repetida.repetida, true); assert.equal(f.calls(), 1); assert.equal(f.usage(), 1);
  await assert.rejects(f.service.comandar(cliente, { ...p, prompt: 'Outro desenho' }), /Chave/);
  await assert.rejects(f.service.comandar(admin, p), /Chave/);
});
test('serviço: duas solicitações concorrentes disputando último crédito só chamam provedor uma vez', async () => {
  const f = fixture({ used: 59 });
  const resultados = await Promise.allSettled([f.service.comandar(cliente, pedido(10)), f.service.comandar(cliente, pedido(11))]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls(), 1); assert.equal(f.usage(), 60);
});
test('serviço: falha incerta mantém reserva e mesma chave nunca reenvia', async () => {
  const f = fixture({ providerFailure: true });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), /crédito ficou reservado/);
  assert.equal(f.jobs.get(id(10)).estado, 'INCERTA');
  await f.service.comandar(cliente, pedido(10)); assert.equal(f.calls(), 1); assert.equal(f.usage(), 1);
});
test('serviço: empresa errada, acesso revogado, cancelamento e paywall barram antes do provedor', async () => {
  for (const opts of [{ otherTenant: true }, { revoked: true }, { cancelled: true }, { paywall: true }, { globalExhausted: true }]) {
    const f = fixture(opts); await assert.rejects(f.service.comandar(cliente, pedido(10))); assert.equal(f.calls(), 0); assert.equal(f.usage(), 0);
  }
});
test('serviço: arte de outro convite nunca segue para a IA', async () => {
  const f = fixture(); await assert.rejects(f.service.comandar(cliente, { ...pedido(10), referencias: [id(55)] }), /Referência não pertence/);
  assert.equal(f.calls(), 0); assert.equal(f.usage(), 0);
  const q = f.log.find(l => l.sql.includes('SELECT imagem FROM convite_artes')); assert.deepEqual(Array.from(q.v), [id(55), f.c.id, f.c.empresa_id]);
});
test('serviço: cliente não altera cotas nem renova seu acesso', async () => {
  const f = fixture();
  await assert.rejects(f.service.comandar(cliente, { acao: 'cotas', festa: 99, cliente: 99 }), /Somente o buffet/);
  await assert.rejects(f.service.comandar(cliente, { acao: 'acesso', habilitado: true }), /Somente o buffet/);
});
test('serviço: RSVP rejeita data vencida publicada enquanto aguardava transação', async () => {
  const conteudo = { ...domain.inicioConteudo({}), nome: 'Teste', data: '2099-12-20', horario: '16:00', local: 'Local fictício', endereco: 'Endereço fictício' };
  const c = { id: id(1), empresa_id: id(2), festa_id: id(3), publicado: conteudo };
  let gravacoes = 0;
  const tx = { async query(sql) {
    if (sql.includes('SELECT ci.*')) return { rows: [c] };
    if (sql.includes('FROM festas f JOIN contratos')) return { rows: [{ contrato_id: id(6) }] };
    if (sql.includes('SELECT * FROM convites WHERE id')) return { rows: [c] };
    if (sql.includes('INSERT INTO convite_respostas')) gravacoes++;
    return { rows: [] };
  } };
  const service = carregar(path.join(__dirname, 'service.ts'), {
    '../db/postgres': { db: () => tx, withTransaction: async fn => { c.publicado = { ...conteudo, data: '2000-01-01' }; return fn(tx); } },
    '../saas/provar-tenant': {}, '../saas/provar-estabelecimento': {},
    '../festas/repository': { contrato: async () => ({}) }, '../assinatura/estado': {},
    './domain': domain, './imagem': {},
  });
  await assert.rejects(service.confirmar('p'.repeat(43), { chave: id(10), nome: 'Família fictícia', presenca: true, adultos: 1, criancas: 0 }), /encerradas/);
  assert.equal(gravacoes, 0);
});
