/* eslint-disable @typescript-eslint/no-require-imports */
// Fila do operador para gerações de convites: módulo real transpilado; banco, serviço de convites e auditoria simulados.
// Nunca abre rede ou PostgreSQL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();
function carregar(file, mocks) {
  const absoluto = path.resolve(file);
  if (cache.has(absoluto)) return cache.get(absoluto);
  const js = ts.transpileModule(fs.readFileSync(absoluto, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} }; cache.set(absoluto, m.exports);
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process, Buffer, Date, console })(nome => {
    if (Object.hasOwn(mocks, nome)) return mocks[nome];
    if (!nome.startsWith('.')) return require(nome);
    const alvo = path.resolve(path.dirname(absoluto), nome);
    return carregar(alvo.endsWith('.ts') ? alvo : `${alvo}.ts`, mocks);
  }, m, m.exports);
  cache.set(absoluto, m.exports); return m.exports;
}
const domain = carregar(path.join(root, 'lib/convites/domain.ts'), {});
const chamadas = { reconciliar: 0, resolver: [], concluir: [] };
let respostaResolver = async () => ({ resolvida: true, estado: 'RESOLVIDA_SEM_COBRANCA', liberouReserva: true, geracaoId: 'g-1', conviteId: 'c-1', empresaId: 'e-1' });
const evidenciaSanitizada = d => { const v = d && typeof d === 'object' ? d : {}; const r = {}; if (typeof v.requestId === 'string' && /^req_/.test(v.requestId)) r.requestId = v.requestId; if (Array.isArray(v.categorias)) r.categorias = v.categorias.filter(c => c === 'sexual'); return r; };
const modulo = carregar(path.join(root, 'lib/desenvolvedor/convites-geracoes.ts'), {
  '../convites/domain': domain,
  '../convites/service': { evidenciaSanitizada, reconciliarGeracoesParadas: async () => { chamadas.reconciliar++; }, resolverGeracaoIncerta: async () => { throw new Error('use deps'); }, concluirGeracaoComImagem: async () => { throw new Error('use deps'); } },
  './interessadas.ts': { painelDepsPadrao: {} },
  '../clientes/repositories/auditoria.repository': {},
});
const operador = '00000000-0000-4000-8000-000000000077';
const agora = new Date('2026-10-18T15:00:00.000Z');
const sessao = (minutos = 1) => ({ usuario_id: operador, autenticado_em: new Date(agora.getTime() - minutos * 60_000).toISOString(), consultado_em: agora.toISOString() });
function deps({ concedido = true } = {}) {
  const auditoria = [], consultas = [];
  const tx = { async query(sql, v = []) {
    consultas.push(sql);
    if (sql.includes('plataforma_desenvolvedores')) return { rows: concedido && v[0] === operador ? [{ id: 'd-1' }] : [] };
    if (sql.includes("WHERE g.estado='INCERTA'")) return { rows: [
      { id: 'g-legada', criado_em: '2026-10-17T13:57:19Z', enviado_em: null, recebido_em: null, falha_classe: null, falha_diagnostico: null, falha_detalhes: null,
        evento: { diagnostico: 'http_400_moderation_blocked', requestId: 'req_legado', categorias: ['sexual', 'PRIVADO'], mensagem: 'PRIVADO' }, modelo: 'gpt-image-2.5-sunburst',
        reserva_microusd: '300000', origem: 'USUARIO', imagem_retida: false, festa_id: 'f-1', empresa_id: 'e-1', empresa_nome: 'Buffet sintético' },
      { id: 'g-nova', criado_em: '2026-10-18T14:00:00Z', enviado_em: '2026-10-18T14:00:01Z', recebido_em: null, falha_classe: 'DESCONHECIDA', falha_diagnostico: 'rede_ou_timeout',
        falha_detalhes: null, evento: null, modelo: 'gpt-image-2.5-flare', reserva_microusd: '300000', origem: 'CLIENTE', imagem_retida: false, festa_id: 'f-2', empresa_id: 'e-2', empresa_nome: 'Outro buffet' },
    ] };
    return { rows: [] };
  } };
  return { auditoria, consultas,
    deps: { withTransaction: fn => fn(tx), registrarAuditoria: async (input) => { auditoria.push(input); }, reconciliar: async () => { chamadas.reconciliar++; },
      resolver: async (t, operadorId, raw) => { chamadas.resolver.push({ operadorId, raw }); return respostaResolver(t, operadorId, raw); },
      concluir: async (_t, operadorId, raw) => { chamadas.concluir.push({ operadorId, raw }); return { concluida: true, estado: 'CONCLUIDA', liberouReserva: false, geracaoId: 'g-2', conviteId: 'c-2', empresaId: 'e-2' }; } } };
}
const ctx = { requestId: 'req-painel', ip: null, userAgent: null };
const decisao = { geracaoId: '00000000-0000-4000-8000-000000000010', resultado: 'SEM_COBRANCA', evidencia: 'Painel de uso da OpenAI sem a requisição no minuto da geração.' };
const corpo = { acao: 'decidir', ...decisao };

test('fila: exige a concessão de desenvolvedor na transação; sem ela, 404 genérico e nada é listado', async () => {
  const { deps: d, consultas } = deps({ concedido: false });
  await assert.rejects(modulo.filaGeracoesConvites(sessao(), d), e => e.httpStatus === 404 && e.code === 'NAO_ENCONTRADO');
  assert.ok(!consultas.some(sql => sql.includes('convite_geracoes')));
});
test('fila: reconcilia sem provedor, lista pendências com evidência sanitizada, classe e limites documentados', async () => {
  const antes = chamadas.reconciliar;
  const { deps: d } = deps();
  const fila = await modulo.filaGeracoesConvites(sessao(30), d); // leitura não exige senha recente
  assert.equal(chamadas.reconciliar, antes + 1);
  const [legada, nova] = fila.pendentes;
  assert.equal(legada.classe, 'SEM_CLASSE'); assert.equal(legada.origem, 'BUFFET');
  assert.deepEqual(JSON.parse(JSON.stringify(legada.evidencia)), { requestId: 'req_legado', categorias: ['sexual'] });
  assert.ok(!JSON.stringify(fila).includes('PRIVADO'));
  assert.equal(nova.classe, 'DESCONHECIDA'); assert.equal(nova.origem, 'CLIENTE'); assert.equal(nova.diagnostico, 'rede_ou_timeout');
  assert.ok(fila.limites.some(l => /idempotência/.test(l)) && fila.limites.some(l => /moderation_blocked/.test(l)));
});
test('decisão: exige senha recente antes de abrir transação; sem concessão, 404; nenhum dos dois chama a decisão', async () => {
  const antes = chamadas.resolver.length;
  await assert.rejects(modulo.resolverGeracaoConvite(sessao(6), corpo, ctx, deps().deps), e => e.httpStatus === 403 && e.code === 'REAUTENTICACAO');
  await assert.rejects(modulo.resolverGeracaoConvite(sessao(1), corpo, ctx, deps({ concedido: false }).deps), e => e.httpStatus === 404);
  assert.equal(chamadas.resolver.length, antes);
});
test('decisão: usa o operador da sessão, audita no painel e devolve só estado e devolução', async () => {
  const { deps: d, auditoria } = deps();
  const r = await modulo.resolverGeracaoConvite(sessao(1), corpo, ctx, d);
  assert.deepEqual({ ...r }, { estado: 'RESOLVIDA_SEM_COBRANCA', liberouReserva: true });
  const ultima = chamadas.resolver.at(-1);
  assert.equal(ultima.operadorId, operador); assert.deepEqual({ ...ultima.raw }, decisao);
  assert.equal(auditoria.length, 1);
  assert.equal(auditoria[0].acao, 'CONVITE_GERACAO_RESOLVIDA'); assert.equal(auditoria[0].entidadeTipo, 'CONVITE_GERACAO'); assert.equal(auditoria[0].entidadeId, 'g-1');
  assert.equal(auditoria[0].usuarioId, operador); assert.equal(auditoria[0].origem, 'PAINEL_DESENVOLVEDOR');
  assert.equal(auditoria[0].dadosDepois.empresaId, 'e-1'); assert.equal(auditoria[0].dadosDepois.liberouReserva, true);
});
test('decisão: conflito (já resolvida) e geração inexistente viram erros do painel com o status certo', async () => {
  for (const [status, codigo] of [[409, 'CONFLITO'], [404, 'NAO_ENCONTRADO']]) {
    respostaResolver = async () => { throw new domain.ConviteError('Esta geração já foi resolvida ou não está pendente.', status); };
    const { deps: d, auditoria } = deps();
    await assert.rejects(modulo.resolverGeracaoConvite(sessao(1), corpo, ctx, d), e => e.httpStatus === status && e.code === codigo);
    assert.equal(auditoria.length, 0);
  }
});
test('concluir com a imagem retida: ação própria, auditada à parte; corpo sem ação ou com ação desconhecida é recusado', async () => {
  const { deps: d, auditoria } = deps();
  const antes = chamadas.resolver.length;
  const r = await modulo.resolverGeracaoConvite(sessao(1), { acao: 'concluir_com_imagem', geracaoId: decisao.geracaoId }, ctx, d);
  assert.deepEqual({ ...r }, { estado: 'CONCLUIDA', liberouReserva: false });
  assert.deepEqual({ ...chamadas.concluir.at(-1).raw }, { geracaoId: decisao.geracaoId });
  assert.equal(auditoria[0].acao, 'CONVITE_GERACAO_CONCLUIDA_COM_IMAGEM'); assert.equal(auditoria[0].entidadeId, 'g-2');
  for (const invalido of [decisao, { acao: 'devolver', ...decisao }, { acao: 'concluir_com_imagem', geracaoId: decisao.geracaoId, resultado: 'SEM_COBRANCA' }])
    await assert.rejects(modulo.resolverGeracaoConvite(sessao(1), invalido, ctx, deps().deps), e => e.name === 'ZodError');
  assert.equal(chamadas.resolver.length, antes);
});
