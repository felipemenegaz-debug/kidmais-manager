/* eslint-disable @typescript-eslint/no-require-imports */
// Serviço real transpilado, dependências de banco/provedor substituídas. Nunca abre rede ou PostgreSQL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), crypto = require('node:crypto');
function carregar(file, deps) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env: { CONVITES_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '3000000' }, cwd: () => path.resolve(__dirname, '../..') }, Buffer, Date, Intl })(
    name => deps[name] ?? require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name), m, m.exports);
  return m.exports;
}
const domain = carregar(path.join(__dirname, 'domain.ts'), {});
const familiasService = carregar(path.join(__dirname, 'familias.ts'), { './domain': domain });
// Prompts e referências reais por estilo (arquivos privados em lib/convites/referencias).
const estilos = carregar(path.join(__dirname, 'estilos.ts'), { './domain.ts': domain, './conferencia-prompt.ts': carregar(path.join(__dirname, 'conferencia-prompt.ts'), {}) });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const editorToken = 'a'.repeat(43);
const TEST_NOW = new Date('2026-10-11T15:00:00.000Z');
function diaSaoPaulo(value) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const p = Object.fromEntries(partes.map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`;
}
function fixture(options = {}) {
  const hojeLocal = diaSaoPaulo(TEST_NOW), mesAtual = `${hojeLocal.slice(0, 7)}-01`;
  let used = options.used ?? 0, globalReserved = options.globalReserved ?? 0, calls = 0, tail = Promise.resolve(), inviteExists = !options.noInvite;
  const monthlyUsage = new Map(options.monthlyUsage ?? [[mesAtual, used]]);
  const dailyBudget = new Map(options.dailyBudget ?? [[hojeLocal, globalReserved]]);
  const log = [], jobs = new Map(), artes = new Set([id(88), id(89)]), familias = new Map(), respostas = new Map(), completas = [];
  const c = { id: id(1), empresa_id: id(2), festa_id: id(3), cliente_id: id(4), estabelecimento_id: null,
    editor_hash: crypto.createHash('sha256').update(editorToken).digest('hex'), editor_expira_em: new Date('2099-01-01'),
    limite_festa: 3, limite_cliente: 2, usado_festa: options.partyUsed ?? 0, usado_cliente: options.clientUsed ?? 0,
    revisao: 1, versao_contrato_id: id(5), rascunho: domain.inicioConteudo({}), publicado: null, publico_token: 'p'.repeat(43) };
  const tx = { async query(sql, v = []) {
    log.push({ sql, v }); let rows = [];
    if (sql.includes('FROM convite_familias f LEFT JOIN')) rows = [...familias.values()].filter(f => f.convite_id === v[0] && f.empresa_id === v[1]).map(f => ({ id: f.id, nome: f.nome, adultos: f.adultos_previstos, criancas: f.criancas_previstas, ativa: f.ativa, revisao: f.revisao, linkAtivo: !!f.token_hash, presenca: respostas.get(f.id)?.presenca ?? null }));
    else if (sql.includes('SELECT * FROM convite_familias WHERE convite_id')) rows = [...familias.values()].filter(f => f.convite_id === v[0] && f.empresa_id === v[1] && f.token_hash === v[2] && f.ativa);
    else if (sql.includes('SELECT * FROM convite_familias WHERE id')) { const f = familias.get(v[0]); rows = f && (v.length === 1 || (f.convite_id === v[1] && f.empresa_id === v[2])) ? [f] : []; }
    else if (sql.includes('SELECT id FROM convite_familias WHERE convite_id')) { const f = familias.get(v[1]); rows = f?.convite_id === v[0] ? [f] : []; }
    else if (sql.includes('SELECT count(*) n FROM convite_familias')) rows = [{ n: String(familias.size) }];
    else if (sql.includes('INSERT INTO convite_familias')) familias.set(v[0], { id: v[0], convite_id: v[1], empresa_id: v[2], nome: v[3], adultos_previstos: v[4], criancas_previstas: v[5], token_hash: v[6], ativa: true, revisao: 1 });
    else if (sql.includes('UPDATE convite_familias')) {
      const f = familias.get(v[0]); f.revisao++;
      if (sql.includes('SET nome=')) { f.nome = v[1]; f.adultos_previstos = v[2]; f.criancas_previstas = v[3]; }
      else if (sql.includes('SET ativa=')) { f.ativa = v[1]; f.token_hash = null; }
      else f.token_hash = v[1];
    }
    else if (sql.includes('SELECT ci.* FROM convites')) rows = c.publicado && v[0] === c.publico_token ? [c] : [];
    else if (sql.includes('SELECT * FROM convites WHERE id')) rows = [c];
    else if (sql.includes('SELECT presenca,adultos,criancas FROM convite_respostas')) rows = respostas.has(v[1]) ? [respostas.get(v[1])] : [];
    else if (sql.includes('SELECT chave FROM convite_respostas')) rows = respostas.has(v[1]) ? [respostas.get(v[1])] : [];
    else if (sql.includes('SELECT count(*) n FROM convite_respostas')) rows = [{ n: String(respostas.size) }];
    else if (sql.includes('SELECT r.nome,r.presenca')) rows = [...respostas.values()].filter(r => !r.familia_id || familias.get(r.familia_id)?.ativa);
    else if (sql.includes('INSERT INTO convite_respostas')) {
      assert(sql.includes('WHERE convite_respostas.familia_id IS NOT DISTINCT FROM excluded.familia_id'));
      const antigo = respostas.get(v[1]);
      if (!antigo || antigo.familia_id === v[6]) { const r = { chave: v[1], nome: v[2], presenca: v[3], adultos: v[4], criancas: v[5], familia_id: v[6] }; respostas.set(v[1], r); rows = [r]; }
    }
    else if (sql.includes('FROM festa_membership_capacidades')) rows = options.noOperate && (v[2] === 'FESTA_OPERAR' || sql.includes("capacidade='FESTA_OPERAR'")) ? [] : [{ id: id(90) }];
    else if (sql.includes('FROM empresas WHERE')) rows = [{ id: c.empresa_id }];
    else if (sql.includes('FROM festas f JOIN contratos')) rows = options.otherTenant ? [] : [{ empresa_id: c.empresa_id, cliente_id: c.cliente_id, estabelecimento_id: null, contrato_id: id(6), invalidada_em: null }];
    else if (sql.includes('SELECT invalidada_em FROM festas')) rows = [{ invalidada_em: null }];
    else if (sql.includes('SELECT * FROM convites WHERE editor_hash')) rows = options.revoked ? [] : [c];
    else if (sql.includes('SELECT * FROM convites WHERE festa_id')) rows = inviteExists ? [c] : [];
    else if (sql.includes('INSERT INTO convites')) { inviteExists = true; rows = [c]; }
    else if (sql.includes('CASE WHEN w.ativo')) rows = [{ limite: 60, usado: monthlyUsage.get(mesAtual) ?? 0 }];
    else if (sql.includes('SELECT id,empresa_id,convite_id,estado,ator,criado_em,reserva_microusd FROM convite_geracoes')) { const j = jobs.get(v[0]); rows = j?.convite_id === v[1] && j?.empresa_id === v[2] ? [j] : []; }
    else if (sql.includes('SELECT * FROM convite_geracoes')) rows = jobs.has(v[0]) ? [jobs.get(v[0])] : [];
    else if (sql.includes('SELECT id,resolucao_resultado,resolucao_por,resolucao_em,resolucao_evidencia FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.convite_id === v[0] && j.empresa_id === v[1] && j.resolucao_resultado).map(j => ({ id: j.id, resolucao_resultado: j.resolucao_resultado, resolucao_por: j.resolucao_por, resolucao_em: j.resolucao_em, resolucao_evidencia: j.resolucao_evidencia }));
    else if (sql.includes('SELECT id,criado_em,ator FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.convite_id === v[0] && j.empresa_id === v[1] && j.estado === 'INCERTA');
    else if (sql.includes("SELECT id FROM convite_geracoes") && sql.includes("estado='INCERTA'")) rows = [...jobs.values()].filter(j => j.estado === 'INCERTA');
    else if (sql.includes('SELECT id FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.estado === 'RESERVADA');
    else if (sql.includes('count(*) n FROM convite_artes')) rows = [{ n: '0' }];
    else if (options.listarArtes && sql.includes('FROM convite_artes a WHERE')) rows = [...artes].map(arte => ({ id: arte, imagem: Buffer.from('arte'), origem: 'IA', completo: [...jobs.values()].some(j => j.arte_id === arte && j.modelo === v[2]) }));
    else if (sql.includes('SELECT imagem FROM convite_artes')) rows = []; // Nenhuma arte de outra festa é autorizada.
    else if (sql.includes('SELECT id FROM convite_artes')) rows = artes.has(v[0]) && v[1] === c.id && v[2] === c.empresa_id ? [{ id: v[0] }] : [];
    else if (sql.includes('UPDATE convite_geracoes SET arte_id=NULL')) { for (const j of jobs.values()) if (j.arte_id === v[0]) j.arte_id = null; }
    else if (sql.includes('DELETE FROM convite_artes')) artes.delete(v[0]);
    else if (sql.includes('UPDATE convites SET rascunho=$2,revisao')) { c.rascunho = v[1]; c.revisao++; }
    else if (sql.includes('UPDATE convites SET limite_festa=')) { c.limite_festa = v[1]; c.limite_cliente = v[2]; }
    else if (sql.includes('INSERT INTO convite_orcamento_global')) { if (!options.globalExhausted) { globalReserved += 300000; dailyBudget.set(hojeLocal, (dailyBudget.get(hojeLocal) ?? 0) + 300000); rows = [{ dia: hojeLocal }]; } }
    else if (sql.includes('INSERT INTO convite_consumos')) { used++; monthlyUsage.set(mesAtual, (monthlyUsage.get(mesAtual) ?? 0) + 1); }
    else if (sql.includes('UPDATE convites SET usado_festa=usado_festa-1')) {
      if (c.usado_festa > 0 && (!v[1] || c.usado_cliente > 0) && v[2] === c.empresa_id) { c.usado_festa--; if (v[1]) c.usado_cliente--; rows = [{ id: c.id }]; }
    }
    else if (sql.includes('UPDATE convites SET usado_festa')) { c.usado_festa++; c.usado_cliente += v[1]; }
    else if (sql.includes('INSERT INTO convite_geracoes')) jobs.set(v[0], { id: v[0], estado: 'RESERVADA', convite_id: v[1], empresa_id: v[2], ator: v[3], payload_hash: v[4], modelo: v[5], arte_id: null, criado_em: new Date(TEST_NOW), reserva_microusd: 300000 });
    else if (sql.includes('INSERT INTO convite_artes')) rows = [{ id: id(88) }];
    else if (sql.includes("SET estado='CONCLUIDA'")) { const j = jobs.get(v[0]); j.estado = 'CONCLUIDA'; j.arte_id = v[1]; }
    else if (sql.startsWith('UPDATE convite_geracoes SET estado=$4')) {
      const j = jobs.get(v[0]); if (j?.estado === 'INCERTA' && j.convite_id === v[1] && j.empresa_id === v[2]) { Object.assign(j, { estado: v[3], resolucao_resultado: v[4], resolucao_por: v[5], resolucao_em: new Date(TEST_NOW), resolucao_evidencia: v[6] }); rows = [{ id: j.id }]; }
    }
    else if (sql.includes('UPDATE convite_consumos SET usado=usado-1')) {
      const geracao = jobs.get(v[0]), diaOrigem = diaSaoPaulo(geracao.criado_em), mesOrigem = `${diaOrigem.slice(0, 7)}-01`, saldo = monthlyUsage.get(mesOrigem) ?? 0;
      if (!options.failMonthlyRelease && saldo > 0) { monthlyUsage.set(mesOrigem, saldo - 1); if (mesOrigem === mesAtual) used--; rows = [{ empresa_id: c.empresa_id }]; }
    }
    else if (sql.includes('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2')) {
      const geracao = jobs.get(v[0]), diaOrigem = diaSaoPaulo(geracao.criado_em), saldo = dailyBudget.get(diaOrigem) ?? 0;
      if (!options.failGlobalRelease && saldo >= v[1]) { dailyBudget.set(diaOrigem, saldo - v[1]); if (diaOrigem === hojeLocal) globalReserved -= v[1]; rows = [{ dia: diaOrigem }]; }
    }
    else if (sql.includes("SET estado='INCERTA'")) jobs.get(v[0]).estado = 'INCERTA';
    return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
  } };
  const service = carregar(path.join(__dirname, 'service.ts'), {
    '../db/postgres': { db: () => tx, withTransaction: fn => {
      const next = tail.then(async () => {
        const before = { used, globalReserved, monthlyUsage: structuredClone([...monthlyUsage]), dailyBudget: structuredClone([...dailyBudget]), c: structuredClone(c), jobs: structuredClone([...jobs]), artes: [...artes], familias: structuredClone([...familias]), respostas: structuredClone([...respostas]) };
        try { return await fn(tx); } catch (error) {
          used = before.used; globalReserved = before.globalReserved; Object.assign(c, before.c);
          for (const [target, values] of [[jobs, before.jobs], [familias, before.familias], [respostas, before.respostas], [monthlyUsage, before.monthlyUsage], [dailyBudget, before.dailyBudget]]) { target.clear(); for (const [key, value] of values) target.set(key, value); }
          artes.clear(); for (const value of before.artes) artes.add(value);
          throw error;
        }
      }); tail = next.catch(() => {}); return next;
    } },
    '../saas/provar-tenant': { provarTenant: async () => ({ empresaComprovada: c.empresa_id, membershipId: id(7), usuarioId: id(8), papelAtual: 'REPRESENTANTE_AUTORIZADO' }), revalidarTenant: async () => {} },
    '../saas/provar-estabelecimento': { provarEstabelecimento: async () => {} },
    '../festas/repository': { contrato: async () => ({ status: options.cancelled ? 'CANCELADO' : 'ASSINADO', versao_id: id(5), snapshot: { evento: { convidados: options.convidados ?? 50 }, privado: 'NAO_EXPOR' } }) },
    '../assinatura/estado': { lerEstadoComercial: async () => ({ acesso: { nivel: options.paywall ? 'SOMENTE_LEITURA' : 'COMPLETO' } }) },
    './domain': domain, './familias': familiasService, './estilos': estilos,
    './imagem': { modeloImagem: () => options.modelo ?? 'modelo-sintetico', iaConfigurada: () => true, normalizarImagem: async () => Buffer.from('synthetic'), gerarImagem: async () => { calls++; if (options.providerFailure) throw Error('timeout'); return { imagem: Buffer.from('synthetic'), uso: {} }; },
      completoDisponivel: () => options.completo ?? false, MODELO_COMPLETO: 'gpt-image-2.5-sunburst', QUALIDADE_COMPLETO: 'xhigh',
      gerarConviteCompletoOpenAI: async (prompt, _enviar, _env, qualidade, refs) => { calls++; completas.push({ prompt, qualidade, refs }); if (options.providerFailure) throw Error('timeout'); return { imagem: Buffer.from('png'), uso: { output_tokens: 9 } }; },
      armazenarConviteCompleto: async () => Buffer.from('webp-completo') },
  });
  return { service, c, log, jobs, artes, familias, respostas, completas, usage: () => used, monthlyUsage, dailyBudget, globalReserved: () => globalReserved, calls: () => calls };
}
const admin = { tipo: 'admin', sessao: { usuario_id: id(8) }, festaId: id(3) };
const cliente = { tipo: 'cliente', token: editorToken };
const pedido = n => ({ acao: 'gerar', chave: id(n), prompt: 'Arte para festa no jardim', referencias: [] });
const cadastro = n => ({ acao: 'familia_adicionar', id: id(n), nome: `Família ${n}`, adultos: 2, criancas: 1 });
const resposta = n => ({ chave: id(n), nome: 'Nome enviado pelo visitante', presenca: true, adultos: 2, criancas: 1 });
function publicar(f) { f.c.publicado = { ...f.c.rascunho, nome: 'Alice', data: '2099-12-20', horario: '16:00', local: 'Local fictício', endereco: 'Endereço fictício', confirmarPresenca: true }; }
const tokenDoLink = r => r.linkFamilia.split('#familia=')[1];

test('famílias: buffet e cliente criam sem créditos; repetição não duplica nem renova; listas e auditoria não expõem tokens', async () => {
  for (const acesso of [admin, cliente]) {
    const f = fixture(), p = cadastro(100), r = await f.service.comandar(acesso, p), token = tokenDoLink(r);
    assert.match(token, /^[\w-]{43}$/); assert.equal(r.revisao, 1);
    assert.equal(f.familias.get(p.id).token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    const repetida = await f.service.comandar(acesso, p);
    assert.equal(repetida.repetida, true); assert.equal(repetida.linkFamilia, null); assert.equal(f.familias.size, 1);
    assert.equal(f.usage(), 0); assert.equal(f.calls(), 0); assert.equal(f.c.revisao, 1);
    const d = await f.service.consultar(acesso); assert.equal(d.familias.length, 1); assert.equal(d.familias[0].presenca, null);
    assert(!JSON.stringify(d).includes(token)); assert(!JSON.stringify(d).includes('token_hash'));
    const eventos = f.log.filter(l => l.sql.startsWith('INSERT INTO convite_eventos'));
    assert.equal(eventos.length, 1); assert(!JSON.stringify(eventos).includes(token));
    await assert.rejects(f.service.comandar(acesso, { ...p, nome: 'Outro nome' }), /já utilizado/);
  }
});
test('famílias: autenticação, tenant, contrato e acesso comercial valem para todas as mutações', async () => {
  const comandos = [cadastro(100), { acao: 'familia_editar', id: id(100), revisao: 1, nome: 'Outro nome', adultos: 1, criancas: 0 }, { acao: 'familia_link', id: id(100), revisao: 1, habilitado: true }, { acao: 'familia_status', id: id(100), revisao: 1, ativa: false }];
  for (const options of [{ otherTenant: true }, { revoked: true }, { cancelled: true }, { paywall: true }]) for (const cmd of comandos) {
    const f = fixture(options); await assert.rejects(f.service.comandar(cliente, cmd));
    assert.equal(f.log.filter(l => /^(INSERT|UPDATE|DELETE)/.test(l.sql)).length, 0);
  }
});
test('convite novo reserva três gerações para a festa e limita o cliente a duas', async () => {
  const f = fixture({ noInvite: true });
  const d = await f.service.consultar(admin, true);
  const insert = f.log.find(l => l.sql.includes('INSERT INTO convites'));
  assert.match(insert.sql, /limite_festa,limite_cliente\)/);
  assert.match(insert.sql, /VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,3,2\)/);
  assert.equal(d.cotas.festa, 3);
  assert.equal(d.cotas.cliente, 2);
});
test('buffet ajusta limite do cliente sem saldo mensal para cotas ainda não usadas', async () => {
  const f = fixture({ used: 1, partyUsed: 1, clientUsed: 1 });
  await f.service.comandar(admin, { acao: 'cotas', festa: 3, cliente: 2 });
  assert.equal(f.c.limite_festa, 3);
  assert.equal(f.c.limite_cliente, 2);
  assert.equal(f.usage(), 1);
  await assert.rejects(f.service.comandar(admin, { acao: 'cotas', festa: 3, cliente: 0 }), /não pode ser menor que o uso/);
});
test('famílias: revisão concorrente e família de outro convite não são alteradas', async () => {
  const f = fixture(); await f.service.comandar(admin, cadastro(100));
  await f.service.comandar(admin, { acao: 'familia_editar', id: id(100), revisao: 1, nome: 'Nome novo', adultos: 1, criancas: 2 });
  await assert.rejects(f.service.comandar(cliente, { acao: 'familia_link', id: id(100), revisao: 1, habilitado: true }), /alterada por outra pessoa/);
  f.familias.get(id(100)).convite_id = id(55);
  await assert.rejects(f.service.comandar(admin, { acao: 'familia_status', id: id(100), revisao: 2, ativa: false }), /não encontrada/);
  await assert.rejects(f.service.comandar(admin, cadastro(100)), /já utilizado/);
});
test('famílias: limite de cadastro inclui arquivadas e não pode ser contornado', async () => {
  const f = fixture(); for (let n = 100; n < 600; n++) f.familias.set(id(n), { id: id(n), ativa: false });
  await assert.rejects(f.service.comandar(cliente, cadastro(600)), /500 famílias/); assert.equal(f.familias.size, 500);
});
test('RSVP individual: dispositivos diferentes atualizam uma única resposta e não escolhem outra família', async () => {
  const f = fixture(); publicar(f);
  const r = await f.service.comandar(cliente, cadastro(100)), token = tokenDoLink(r);
  const antes = await f.service.consultarPublico(f.c.publico_token, token);
  assert.equal(antes.familia.nome, 'Família 100'); assert.equal(antes.familia.presenca, null); assert.equal(antes.familia.adultos, 2);
  assert.deepEqual(Object.keys(antes.familia).sort(), ['adultos', 'criancas', 'nome', 'presenca']);
  await f.service.confirmar(f.c.publico_token, resposta(900), token);
  await f.service.confirmar(f.c.publico_token, { ...resposta(901), adultos: 3 }, token);
  assert.equal(f.respostas.size, 1); assert.equal(f.respostas.get(id(100)).adultos, 3);
  assert.equal(f.respostas.get(id(100)).nome, 'Família 100');
  const depois = await f.service.consultarPublico(f.c.publico_token, token); assert.equal(depois.familia.adultos, 3);
  const outro = tokenDoLink(await f.service.comandar(cliente, cadastro(101)));
  await f.service.confirmar(f.c.publico_token, { ...resposta(100), adultos: 1 }, outro);
  assert.equal(f.respostas.get(id(100)).adultos, 3); assert.equal(f.respostas.get(id(101)).adultos, 1);
  await assert.rejects(f.service.confirmar(f.c.publico_token, resposta(100)), /link individual/);
  await f.service.confirmar(f.c.publico_token, resposta(900)); assert.equal(f.respostas.size, 3);
  assert.equal((await f.service.consultarPublico(f.c.publico_token, null)).familia, null);
});
test('RSVP individual: renovar, revogar, arquivar e restaurar preservam resposta e invalidam tokens antigos', async () => {
  const f = fixture(); publicar(f);
  const antigo = tokenDoLink(await f.service.comandar(admin, cadastro(100)));
  await f.service.confirmar(f.c.publico_token, resposta(900), antigo);
  const novo = tokenDoLink(await f.service.comandar(admin, { acao: 'familia_link', id: id(100), revisao: 1, habilitado: true }));
  assert.notEqual(novo, antigo);
  for (const t of [antigo, '', 'x'.repeat(43)]) {
    await assert.rejects(f.service.consultarPublico(f.c.publico_token, t), /indisponível/);
    await assert.rejects(f.service.confirmar(f.c.publico_token, resposta(901), t), /indisponível/);
  }
  assert.equal((await f.service.consultarPublico(f.c.publico_token, novo)).familia.presenca, true);
  await f.service.comandar(admin, { acao: 'familia_link', id: id(100), revisao: 2, habilitado: false });
  await assert.rejects(f.service.confirmar(f.c.publico_token, resposta(901), novo), /indisponível/);
  assert.equal((await f.service.consultar(admin)).respostas.length, 1);
  await f.service.comandar(admin, { acao: 'familia_status', id: id(100), revisao: 3, ativa: false });
  assert.equal((await f.service.consultar(admin)).respostas.length, 0); assert.equal(f.respostas.size, 1);
  await assert.rejects(f.service.comandar(admin, { acao: 'familia_link', id: id(100), revisao: 4, habilitado: true }), /Restaure/);
  await f.service.comandar(admin, { acao: 'familia_status', id: id(100), revisao: 4, ativa: true });
  assert.equal((await f.service.consultar(admin)).respostas.length, 1); assert.equal(f.familias.get(id(100)).token_hash, null);
  const restaurado = tokenDoLink(await f.service.comandar(admin, { acao: 'familia_link', id: id(100), revisao: 5, habilitado: true }));
  await f.service.confirmar(f.c.publico_token, { ...resposta(902), presenca: false }, restaurado);
  assert.equal(f.respostas.get(id(100)).adultos, 0); assert.equal(f.respostas.get(id(100)).criancas, 0);
  assert.equal(f.respostas.size, 1);
});
test('RSVP individual: família de outra empresa é recusada, mesmo com token correto', async () => {
  const f = fixture(); publicar(f); const token = tokenDoLink(await f.service.comandar(admin, cadastro(100)));
  f.familias.get(id(100)).empresa_id = id(999);
  await assert.rejects(f.service.consultarPublico(f.c.publico_token, token), /indisponível/);
  await assert.rejects(f.service.confirmar(f.c.publico_token, resposta(900), token), /indisponível/);
  assert.equal(f.respostas.size, 0);
});

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
test('serviço: auditoria registra o modelo escolhido no servidor para OpenAI e Gemini', async () => {
  for (const modelo of ['gpt-image-2.5-flare', 'gemini-nano-banana-2.1']) {
    const f = fixture({ modelo });
    await f.service.comandar(admin, pedido(10));
    const insert = f.log.find(q => q.sql.includes('INSERT INTO convite_geracoes'));
    assert.equal(insert.v[5], modelo);
  }
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
test('serviço: uma falha incerta bloqueia novas chaves até conferência e aparece na consulta', async () => {
  const f = fixture();
  f.jobs.set(id(9), { id: id(9), estado: 'INCERTA', convite_id: f.c.id, empresa_id: f.c.empresa_id, ator: 'CLIENTE:' + f.c.cliente_id, payload_hash: 'hash-anterior', arte_id: null, criado_em: new Date(TEST_NOW), reserva_microusd: 300000 });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), /conferir o uso do provedor/);
  const consulta = await f.service.consultar(admin);
  assert.equal(consulta.geracaoIncerta, true);
  assert.equal(f.calls(), 0); assert.equal(f.usage(), 0);
  assert.equal(f.log.some(x => x.sql.includes('INSERT INTO convite_geracoes')), false);
});
function pendente(f, chave = id(20), ator = `CLIENTE:${f.c.cliente_id}`, criadoEm = TEST_NOW) {
  f.c.usado_festa = 1; f.c.usado_cliente = ator.startsWith('CLIENTE:') ? 1 : 0;
  f.jobs.set(chave, { id: chave, estado: 'INCERTA', convite_id: f.c.id, empresa_id: f.c.empresa_id, ator,
    payload_hash: 'hash-opaco', arte_id: null, criado_em: new Date(criadoEm), reserva_microusd: 300000 });
  return chave;
}
const evidencia = 'Console Gemini conferido em 11/10/2026; solicitação localizada pelo horário.';
test('recuperação manual: cobrança confirmada registra evidência e mantém todas as cotas consumidas', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultado = await f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'COBRANCA_CONFIRMADA', evidencia });
  assert.equal(resultado.resolvida, true); assert.equal(resultado.estado, 'RESOLVIDA_COBRADA'); assert.equal(resultado.liberouReserva, false);
  assert.equal(f.jobs.get(chave).resolucao_resultado, 'COBRANCA_CONFIRMADA');
  assert.equal(f.jobs.get(chave).resolucao_por, admin.sessao.usuario_id);
  assert.equal(f.jobs.get(chave).resolucao_evidencia, evidencia);
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.c.usado_cliente, 1); assert.equal(f.globalReserved(), 300000);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
  const consultado = await f.service.consultar(admin); assert.equal(consultado.decisoesRecuperacao[0].resolucao_evidencia, evidencia);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'COBRANCA_CONFIRMADA', evidencia }), /já foi resolvida/);
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
});
test('recuperação manual: sem cobrança devolve uma vez o mês, festa, cliente e orçamento do dia original', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultado = await f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia });
  assert.equal(resultado.resolvida, true); assert.equal(resultado.estado, 'RESOLVIDA_SEM_COBRANCA'); assert.equal(resultado.liberouReserva, true);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.c.usado_cliente, 0); assert.equal(f.globalReserved(), 0);
  assert.equal(f.jobs.get(chave).resolucao_resultado, 'SEM_COBRANCA');
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
  assert.equal((await f.service.consultar(admin)).decisoesRecuperacao[0].resolucao_resultado, 'SEM_COBRANCA');
  assert.equal(f.calls(), 0);
  await assert.rejects(f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }), /já foi resolvida/);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.globalReserved(), 0);
});
test('recuperação manual: buffet não reduz a cota individual do cliente', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f, id(21), `USUARIO:${admin.sessao.usuario_id}`);
  f.c.usado_cliente = 0;
  await f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia });
  assert.equal(f.c.usado_festa, 0); assert.equal(f.c.usado_cliente, 0); assert.equal(f.usage(), 0); assert.equal(f.globalReserved(), 0);
});
test('recuperação manual: decisão repetida em concorrência só transiciona e libera uma vez', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultados = await Promise.allSettled([
    f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }),
    f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }),
  ]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.globalReserved(), 0);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
});
test('recuperação manual: decisões concorrentes divergentes deixam prevalecer uma só sem devolução dupla', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultados = await Promise.allSettled([
    f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'COBRANCA_CONFIRMADA', evidencia }),
    f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }),
  ]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.jobs.get(chave).estado, 'RESOLVIDA_COBRADA');
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
});
test('recuperação manual: falha na liberação mensal ou diária reverte a decisão e todos os saldos', async () => {
  for (const options of [{ failMonthlyRelease: true }, { failGlobalRelease: true }]) {
    const f = fixture({ used: 1, globalReserved: 300000, ...options }), chave = pendente(f);
    await assert.rejects(f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }));
    assert.equal(f.jobs.get(chave).estado, 'INCERTA'); assert.equal(f.jobs.get(chave).resolucao_resultado, undefined);
    assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.c.usado_cliente, 1); assert.equal(f.globalReserved(), 300000);
    assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 0);
  }
});
test('recuperação manual: virada UTC usa o dia e mês civil original de São Paulo para liberar', async () => {
  const timestamp = '2026-10-01T02:30:00.000Z', diaOrigem = diaSaoPaulo(new Date(timestamp)), mesOrigem = `${diaOrigem.slice(0, 7)}-01`;
  const diaAtual = diaSaoPaulo(TEST_NOW), mesAtual = `${diaAtual.slice(0, 7)}-01`;
  const f = fixture({ used: 5, globalReserved: 300000, monthlyUsage: [[mesOrigem, 1], [mesAtual, 5]], dailyBudget: [[diaOrigem, 300000], [diaAtual, 300000]] });
  assert.notEqual(mesOrigem, mesAtual); assert.notEqual(diaOrigem, diaAtual);
  const chave = pendente(f, id(22), `CLIENTE:${f.c.cliente_id}`, timestamp);
  await f.service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia });
  const mensal = f.log.find(x => x.sql.includes('UPDATE convite_consumos SET usado=usado-1'));
  const diaria = f.log.find(x => x.sql.includes('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2'));
  assert.match(mensal.sql, /date_trunc\('month',criado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
  assert.match(diaria.sql, /\(criado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
  assert.equal(mensal.v[0], chave); assert.equal(diaria.v[0], chave);
  assert.equal(f.monthlyUsage.get(mesOrigem), 0); assert.equal(f.monthlyUsage.get(mesAtual), 5); assert.equal(f.usage(), 5);
  assert.equal(f.dailyBudget.get(diaOrigem), 0); assert.equal(f.dailyBudget.get(diaAtual), 300000); assert.equal(f.globalReserved(), 300000);
});
test('recuperação manual: recusa evidência curta, resultado inválido, cliente, falta de capacidade e outra empresa', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  for (const cmd of [
    { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: 'curto' },
    { acao: 'recuperar', chave, resultado: 'CONFIRMADA', evidencia },
    { acao: 'recuperar', chave: id(99), resultado: 'SEM_COBRANCA', evidencia },
  ]) await assert.rejects(f.service.comandar(admin, cmd));
  await assert.rejects(f.service.comandar(cliente, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }), /buffet/);
  await assert.rejects(fixture({ noOperate: true }).service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }), /permissão/);
  await assert.rejects(fixture({ otherTenant: true }).service.comandar(admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }));
  assert.equal(f.jobs.get(chave).estado, 'INCERTA'); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
  assert.equal(f.calls(), 0);
});
test('consulta de recuperação: só quem tem FESTA_OPERAR recebe os ids pendentes para decidir', async () => {
  const f = fixture(), chave = pendente(f);
  const permitido = await f.service.consultar(admin);
  assert.equal(permitido.geracoesPendentes[0].id, chave); assert.equal(permitido.podeRecuperarGeracao, true);
  const semPermissao = fixture({ noOperate: true }); pendente(semPermissao);
  const leitura = await semPermissao.service.consultar(admin);
  assert.equal(leitura.geracaoIncerta, true); assert.equal(leitura.geracoesPendentes.length, 0); assert.equal(leitura.podeRecuperarGeracao, false);
  const clienteLeitura = await f.service.consultar(cliente);
  assert.equal(clienteLeitura.geracaoIncerta, true); assert.equal(clienteLeitura.geracoesPendentes.length, 0);
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
    './domain': domain, './imagem': {}, './familias': familiasService, './estilos': estilos,
  });
  await assert.rejects(service.confirmar('p'.repeat(43), { chave: id(10), nome: 'Família fictícia', presenca: true, adultos: 1, criancas: 0 }), /encerradas/);
  assert.equal(gravacoes, 0);
});

// Convite completo (V1): dados do rascunho do servidor, estilo + foto opcional, referência do estilo, uma chamada.
const FOTO = 'data:image/png;base64,iVBORw0KGgo=';
const completo = (n, extra = {}) => ({ acao: 'gerar', chave: id(n), prompt: 'Tema fazenda, verde e amarelo, com um cavalo', referencias: [], completo: true, estilo: 'cartoon3d', ...extra });
function comDados(f, dados = {}) { f.c.rascunho = { ...f.c.rascunho, nome: 'Miguel', idade: '6 anos', data: '2026-10-10', horario: '17:00', local: 'KidMais', endereco: 'Asa Norte', ...dados }; }
const referenciaReal = arquivo => fs.readFileSync(path.join(__dirname, 'referencias', arquivo));

test('convite completo: foto → referência do estilo numa única chamada, modelo e qualidade do servidor, créditos reais', async () => {
  for (const [estilo, arquivo] of [['cartoon3d', 'cartoon3d-aprovado-v2.webp'], ['cartoon2d', 'cartoon2d-aprovado-v1.webp'], ['realista', 'realista-aprovado-v1.webp']]) {
    const f = fixture({ completo: true }); comDados(f);
    const r = await f.service.comandar(admin, completo(10, { estilo, foto: FOTO, autorizacaoFoto: true }));
    assert.equal(r.estado, 'CONCLUIDA'); assert.equal(r.completo, true); assert.equal(f.calls(), 1);
    const [chamada] = f.completas;
    assert.equal(chamada.qualidade, 'xhigh'); assert.equal(chamada.refs.length, 2);
    assert.deepEqual(chamada.refs[0], Buffer.from('synthetic')); // foto validada e reencodada no servidor
    assert.deepEqual(chamada.refs[1], referenciaReal(arquivo));
    for (const outro of ['cartoon3d-aprovado-v2.webp', 'cartoon2d-aprovado-v1.webp', 'realista-aprovado-v1.webp'].filter(a => a !== arquivo)) assert.notDeepEqual(chamada.refs[1], referenciaReal(outro));
    assert.match(chamada.prompt, /"nome":"Miguel","idade":"6 anos","data":"10\/10\/2026","horario":"17:00","local":"KidMais","endereco":"Asa Norte"/);
    assert.equal(f.log.find(q => q.sql.includes('INSERT INTO convite_geracoes')).v[5], 'gpt-image-2.5-sunburst');
    assert.deepEqual(f.log.find(q => q.sql.includes('INSERT INTO convite_artes')).v[2], Buffer.from('webp-completo'));
    assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1);
    // A foto nunca vai para o banco nem para a auditoria.
    for (const q of f.log) assert(!JSON.stringify(q.v).includes('iVBORw0KGgo'), q.sql);
  }
});

test('convite completo: proporção infantil vem da idade cadastrada, sem instrução de 50%', async () => {
  const f = fixture({ completo: true }); comDados(f, { idade: '6 anos' });
  await f.service.comandar(admin, completo(10, { foto: FOTO, autorizacaoFoto: true }));
  assert.match(f.completas[0].prompt, /20–30% maior/); assert.doesNotMatch(f.completas[0].prompt, /50% maior/);
  const adulto = fixture({ completo: true }); comDados(adulto, { idade: '41 anos' });
  await adulto.service.comandar(admin, completo(11));
  assert.match(adulto.completas[0].prompt, /50% maior/); assert.doesNotMatch(adulto.completas[0].prompt, /20–30% maior/);
  assert.equal(adulto.completas[0].refs.length, 0); // sem foto: nenhuma referência de estilo
});

test('convite completo: conflito com os dados, foto sem autorização e combinações inválidas falham antes de reservar', async () => {
  const f = fixture({ completo: true }); comDados(f, { nome: 'Mariana', idade: '10 anos' });
  await assert.rejects(f.service.comandar(admin, completo(10, { prompt: 'aniversário da Maria 9 anos' })), /divergem/);
  await assert.rejects(f.service.comandar(admin, completo(11, { foto: FOTO })), /autorização/);
  await assert.rejects(f.service.comandar(admin, completo(12, { referencias: [id(88)] })), /galeria/);
  await assert.rejects(f.service.comandar(admin, { ...pedido(13), estilo: 'realista' }), /somente para o convite completo/);
  await assert.rejects(f.service.comandar(admin, { ...pedido(14), foto: FOTO, autorizacaoFoto: true }), /somente para o convite completo/);
  await assert.rejects(f.service.comandar(admin, completo(15, { estilo: 'aquarela' })), e => e.name === 'ZodError'); // HTTP 400
  assert.equal(f.calls(), 0); assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0);
  assert(!f.log.some(q => q.sql.includes('INSERT INTO convite_geracoes')));
  const indisponivel = fixture({ completo: false }); comDados(indisponivel);
  await assert.rejects(indisponivel.service.comandar(admin, completo(16)), /não está disponível/);
  assert.equal(indisponivel.calls(), 0);
});

test('convite completo: idempotência por chave inclui estilo e foto; falha fica incerta e nunca reenvia', async () => {
  const f = fixture({ completo: true }); comDados(f);
  const p = completo(10, { foto: FOTO, autorizacaoFoto: true });
  await f.service.comandar(cliente, p);
  assert.equal((await f.service.comandar(cliente, p)).repetida, true);
  await assert.rejects(f.service.comandar(cliente, { ...p, estilo: 'realista' }), /Chave/);
  await assert.rejects(f.service.comandar(cliente, { ...p, foto: 'data:image/png;base64,AAAA' }), /Chave/);
  // Mesma chave depois de alterar os dados salvos da festa: recusa em vez de devolver arte com textos antigos.
  comDados(f, { nome: 'Miguel Augusto' });
  await assert.rejects(f.service.comandar(cliente, p), /Chave/);
  comDados(f);
  assert.equal((await f.service.comandar(cliente, p)).repetida, true);
  assert.equal(f.calls(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_cliente, 1);
  const falha = fixture({ completo: true, providerFailure: true }); comDados(falha);
  await assert.rejects(falha.service.comandar(admin, completo(20)), /crédito ficou reservado/);
  assert.equal(falha.jobs.get(id(20)).estado, 'INCERTA');
  await falha.service.comandar(admin, completo(20));
  await assert.rejects(falha.service.comandar(admin, completo(21)), /sem resultado confirmado/);
  assert.equal(falha.calls(), 1);
});

test('convite completo: limites do cliente, tenant e acesso comercial valem antes do provedor', async () => {
  const esgotado = fixture({ completo: true, partyUsed: 2, clientUsed: 2 }); comDados(esgotado);
  await assert.rejects(esgotado.service.comandar(cliente, completo(10)), /Seu limite/);
  for (const opcoes of [{ otherTenant: true }, { revoked: true }, { cancelled: true }, { paywall: true }]) {
    const f = fixture({ completo: true, ...opcoes }); comDados(f);
    await assert.rejects(f.service.comandar(opcoes.revoked ? cliente : admin, completo(11, { foto: FOTO, autorizacaoFoto: true })));
    assert.equal(f.calls(), 0, JSON.stringify(opcoes));
  }
  assert.equal(esgotado.calls(), 0);
});

test('consulta: informa convite completo disponível e marca a arte gerada como completa', async () => {
  const f = fixture({ completo: true, listarArtes: true }); comDados(f);
  await f.service.comandar(admin, completo(10));
  const d = await f.service.consultar(admin);
  assert.equal(d.completoDisponivel, true);
  assert.equal(d.artes.find(a => a.id === id(88)).completo, true);
  assert.equal(d.artes.find(a => a.id === id(89)).completo, false);
  assert.match(d.artes[0].url, /^data:image\/webp;base64,/);
  assert.equal((await fixture({ completo: false }).service.consultar(admin)).completoDisponivel, false);
});
