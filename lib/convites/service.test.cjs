/* eslint-disable @typescript-eslint/no-require-imports */
// Serviço real transpilado, dependências de banco/provedor substituídas. Nunca abre rede ou PostgreSQL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), crypto = require('node:crypto');
function carregar(file, deps, contexto = {}) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env: { CONVITES_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '3000000' }, cwd: () => path.resolve(__dirname, '../..') }, Buffer, Date, Intl, ...contexto })(
    name => deps[name] ?? require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name), m, m.exports);
  return m.exports;
}
const domain = carregar(path.join(__dirname, 'domain.ts'), {});
const familiasService = carregar(path.join(__dirname, 'familias.ts'), { './domain': domain });
// Prompts e referências reais por estilo (arquivos privados em lib/convites/referencias).
const estilos = carregar(path.join(__dirname, 'estilos.ts'), { './domain.ts': domain, './conferencia-prompt.ts': carregar(path.join(__dirname, 'conferencia-prompt.ts'), {}) });
// Autorização do responsável (088): módulos reais; só o banco é simulado.
const textosIA = carregar(path.join(__dirname, 'consentimento-textos.ts'), {});
const consentimento = carregar(path.join(__dirname, 'consentimento.ts'), { './domain.ts': domain, './consentimento-textos.ts': textosIA });
const HOSTS_IA = { openai: 'https://api.openai.com/', gemini: 'https://generativelanguage.googleapis.com/' };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Mesmo formato do erro do adaptador (diagnóstico + detalhes já extraídos da resposta do provedor).
class FalhaSintetica extends Error { constructor(diagnostico, detalhes) { super('Falha no provedor de imagem.'); this.diagnostico = diagnostico; this.detalhes = detalhes; } }
const editorToken = 'a'.repeat(43);
const TEST_NOW = new Date('2026-10-11T15:00:00.000Z');
function diaSaoPaulo(value) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const p = Object.fromEntries(partes.map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`;
}
function fixture(options = {}) {
  const hojeLocal = diaSaoPaulo(TEST_NOW), mesAtual = `${hojeLocal.slice(0, 7)}-01`;
  let used = options.used ?? 0, globalReserved = options.globalReserved ?? 0, calls = 0, tail = Promise.resolve(), inviteExists = !options.noInvite;
  // Relógio da reconciliação (tempo parado no envio), envios HTTP reais ao provedor sintético e falhas de gravação.
  let agora = new Date(TEST_NOW), envios = 0, falhasGravacao = options.failConcluir ?? 0, ultimoEnvio = null;
  const savepoints = [];
  async function fetchSintetico(url, init) {
    envios++; ultimoEnvio = { url, headers: { ...init.headers } };
    if (options.portao) await options.portao;
    if (options.providerFailure) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const corpo = options.providerError ? { error: { code: 'sintetico' } } : options.semImagem ? { data: [] } : { data: [{ b64_json: Buffer.from('recebida').toString('base64') }], usage: { output_tokens: 7 } };
    const r = { ok: !options.providerError, status: options.providerError ? 400 : 200, clone: () => r, json: async () => corpo };
    return r;
  }
  // Mesmo contrato do adaptador real: monta o pedido, envia UMA vez pelo `enviar` recebido e só então interpreta.
  async function provedorSintetico(enviar, imagem, uso) {
    if (options.failBeforeSend) throw new FalhaSintetica('pedido_nao_montado');
    let r;
    try { r = await enviar(options.urlEnvio ?? 'https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch { throw new FalhaSintetica('rede_ou_timeout'); }
    if (options.enviarDuasVezes) await enviar('https://api.openai.com/v1/images/generations', { method: 'POST', headers: {}, body: '{}' });
    if (options.providerError) throw options.providerError();
    if (!r.ok) throw new FalhaSintetica(`http_${r.status}`);
    const corpo = await r.json();
    if (!Array.isArray(corpo.data) || corpo.data.length !== 1) throw new FalhaSintetica('resposta_sem_imagem_unica');
    if (options.processFailure) throw new FalhaSintetica('resposta_imagem_invalida');
    return { imagem, uso };
  }
  const monthlyUsage = new Map(options.monthlyUsage ?? [[mesAtual, used]]);
  const dailyBudget = new Map(options.dailyBudget ?? [[hojeLocal, globalReserved]]);
  const log = [], jobs = new Map(), artes = new Set([id(88), id(89)]), familias = new Map(), respostas = new Map(), completas = [];
  // Autorizações (088). Padrão: uma vigente do buffet, com foto, para o provedor configurado (testes anteriores à 088).
  const autorizacoes = new Map(), provedor = options.provedor ?? 'openai', chamadasProvedor = [];
  if (!options.semAutorizacao) {
    autorizacoes.set(id(500), { id: id(500), empresa_id: id(2), convite_id: id(1), festa_id: id(3), provedor: options.autorizacaoProvedor ?? provedor,
      texto_versao: options.autorizacaoVersao ?? textosIA.VERSAO_TEXTOS_IA, texto_hash: consentimento.hashTextoIA(options.autorizacaoProvedor ?? provedor, 'BUFFET'),
      operador_tipo: 'BUFFET', operador_usuario_id: id(8), operador_cliente_id: null, responsavel_nome: 'Responsável Sintético', responsavel_vinculo: 'MAE',
      meio: 'PRESENCIAL', declaracao_responsavel: true, criado_em: new Date(TEST_NOW), revogada_em: null, revogada_por: null, revogacao_motivo: null });
  }
  const c = { id: id(1), empresa_id: id(2), festa_id: id(3), cliente_id: id(4), estabelecimento_id: null,
    editor_hash: crypto.createHash('sha256').update(editorToken).digest('hex'), editor_expira_em: new Date('2099-01-01'),
    limite_festa: 3, limite_cliente: 2, usado_festa: options.partyUsed ?? 0, usado_cliente: options.clientUsed ?? 0,
    revisao: 1, versao_contrato_id: id(5), rascunho: domain.inicioConteudo({}), publicado: null, publico_token: 'p'.repeat(43) };
  const tx = { async query(sql, v = []) {
    log.push({ sql, v }); let rows = [];
    if (options.failEventoIncerta && sql.includes('INSERT INTO convite_eventos') && v[2] === 'IA_INCERTA') throw new Error('falha simulada no evento');
    if (options.failCarteira && sql.includes('FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE')) throw new Error('deadlock simulado');
    if (sql.includes('convite_ia_autorizacoes') && !sql.includes('SET enviado_em')) {
      if (options.semTabela088) throw Object.assign(new Error('relation "convite_ia_autorizacoes" does not exist'), { code: '42P01' });
      if (sql.startsWith('SELECT')) rows = [...autorizacoes.values()].filter(a => a.convite_id === v[0] && a.empresa_id === v[1] && !a.revogada_em);
      else if (sql.startsWith('INSERT INTO convite_ia_autorizacoes')) {
        assert.equal([...autorizacoes.values()].filter(a => a.convite_id === v[1] && !a.revogada_em).length, 0, 'índice parcial: uma vigente por convite');
        const nova = { id: id(600 + autorizacoes.size), empresa_id: v[0], convite_id: v[1], festa_id: v[2], provedor: v[3], texto_versao: v[4], texto_hash: v[5], operador_tipo: v[6],
          operador_usuario_id: v[7], operador_cliente_id: v[8], responsavel_nome: v[9], responsavel_vinculo: v[10], meio: v[11], declaracao_responsavel: true,
          criado_em: new Date(agora), revogada_em: null, revogada_por: null, revogacao_motivo: null };
        autorizacoes.set(nova.id, nova); rows = [{ id: nova.id, criado_em: nova.criado_em }];
      } else if (sql.includes("revogacao_motivo='SUBSTITUIDA'")) { const a = autorizacoes.get(v[0]); if (a && a.empresa_id === v[1] && !a.revogada_em) Object.assign(a, { revogada_em: new Date(agora), revogada_por: v[2], revogacao_motivo: 'SUBSTITUIDA' }); }
      else if (sql.includes("revogacao_motivo='REVOGADA'")) {
        rows = [...autorizacoes.values()].filter(a => a.convite_id === v[0] && a.empresa_id === v[1] && !a.revogada_em);
        for (const a of rows) Object.assign(a, { revogada_em: new Date(agora), revogada_por: v[2], revogacao_motivo: 'REVOGADA' });
        rows = rows.map(a => ({ id: a.id }));
      } else throw new Error('SQL da 088 não simulado: ' + sql);
      return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }
    if (sql.startsWith('SAVEPOINT')) savepoints.push(fotografar());
    else if (sql.startsWith('RELEASE SAVEPOINT')) savepoints.pop();
    else if (sql.startsWith('ROLLBACK TO SAVEPOINT')) restaurar(savepoints.pop());
    else if (sql.includes('imagem_guardada')) rows = [...jobs.values()].filter(j => j.convite_id === v[0] && j.empresa_id === v[1] && j.estado === 'RESERVADA' && ((j.resultado_pendente && agora - j.recebido_em > 30000)
      || (j.etapas_registradas && !j.enviado_em && agora - j.criado_em > 120000) || (j.enviado_em && agora - j.enviado_em > 600000) || (!j.etapas_registradas && agora - j.criado_em > 600000)))
      .map(j => ({ ...j, etapas_registradas: !!j.etapas_registradas, imagem_guardada: !!j.resultado_pendente }));
    else if (sql.includes('SELECT id,estado FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.convite_id === v[0] && j.empresa_id === v[1] && ['RESERVADA', 'INCERTA'].includes(j.estado));
    else if (sql.includes('SELECT estado,arte_id,modelo FROM convite_geracoes')) { const j = jobs.get(v[0]); rows = j && j.convite_id === v[1] && j.empresa_id === v[2] ? [j] : []; }
    else if (sql.includes('SELECT estado,arte_id FROM convite_geracoes') || sql.includes('SELECT resultado_pendente FROM convite_geracoes') || sql.includes('SELECT convite_id FROM convite_geracoes WHERE id=$1')) rows = jobs.has(v[0]) ? [jobs.get(v[0])] : [];
    else if (sql.includes('SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo')) { const j = jobs.get(v[0]); rows = j && (v.length < 2 || j.convite_id === v[1]) ? [j] : []; }
    else if (sql.includes('SET enviado_em=clock_timestamp()')) {
      if (options.failMarker) throw new Error('falha simulada no banco antes do envio');
      if (options.antesDoMarcador) options.antesDoMarcador();
      // 088: a autorização da reserva precisa continuar não revogada no instante do envio.
      assert.match(sql, /convite_ia_autorizacoes a WHERE a\.id=\$2/);
      const j = jobs.get(v[0]), aut = autorizacoes.get(v[1]);
      if (j?.estado === 'RESERVADA' && j.etapas_registradas && !j.enviado_em && aut && !aut.revogada_em && aut.convite_id === j.convite_id && aut.empresa_id === j.empresa_id) { j.enviado_em = new Date(agora); rows = [{ id: j.id }]; }
    }
    else if (sql.includes('SET recebido_em=clock_timestamp()')) { if (options.failGuardarRecebida) throw new Error('falha simulada ao guardar a imagem'); const j = jobs.get(v[0]); if (j && ['RESERVADA', 'INCERTA'].includes(j.estado) && !j.arte_id) { Object.assign(j, { recebido_em: new Date(agora), resultado_pendente: v[1], uso: v[2] }); rows = [{ id: j.id }]; } }
    else if (sql.includes("SET estado='NAO_ENVIADA'")) { const j = jobs.get(v[0]); if (j?.estado === 'RESERVADA' && j.etapas_registradas && !j.enviado_em) { Object.assign(j, { estado: 'NAO_ENVIADA', falha_classe: 'PRE_ENVIO', falha_diagnostico: v[1] }); rows = [{ id: j.id }]; } }
    else if (sql.includes("SET estado='INCERTA',falha_classe")) { const j = jobs.get(v[0]); if (j?.estado === 'RESERVADA') { Object.assign(j, { estado: 'INCERTA', falha_classe: v[1], falha_diagnostico: v[2], falha_detalhes: v[3] }); rows = [{ id: j.id }]; } }
    else if (sql.includes("SET estado='CONCLUIDA'")) { const j = jobs.get(v[0]); if (j && ['RESERVADA', 'INCERTA'].includes(j.estado)) { Object.assign(j, { estado: 'CONCLUIDA', arte_id: v[1], resultado_pendente: null }); rows = [{ id: j.id }]; } }
    else if (sql.startsWith('UPDATE convite_geracoes SET estado=$2,resolucao_resultado')) { const j = jobs.get(v[0]); if (j?.estado === 'INCERTA') { Object.assign(j, { estado: v[1], resolucao_resultado: v[2], resolucao_por: v[3], resolucao_em: new Date(TEST_NOW), resolucao_evidencia: v[4], resultado_pendente: null }); rows = [{ id: j.id }]; } }
    else if (sql.includes('INSERT INTO convite_artes') && falhasGravacao > 0) { falhasGravacao--; throw new Error('falha simulada ao gravar a arte'); }
    else if (sql.includes('FROM convite_familias f LEFT JOIN')) rows = [...familias.values()].filter(f => f.convite_id === v[0] && f.empresa_id === v[1]).map(f => ({ id: f.id, nome: f.nome, adultos: f.adultos_previstos, criancas: f.criancas_previstas, ativa: f.ativa, revisao: f.revisao, linkAtivo: !!f.token_hash, presenca: respostas.get(f.id)?.presenca ?? null }));
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
    else if (sql.includes('SELECT * FROM convite_geracoes')) rows = jobs.has(v[0]) ? [jobs.get(v[0])] : [];
    else if (sql.includes("SELECT id FROM convite_geracoes") && sql.includes("estado='INCERTA'")) rows = [...jobs.values()].filter(j => j.estado === 'INCERTA');
    else if (sql.includes('SELECT id FROM convite_geracoes')) rows = [...jobs.values()].filter(j => j.estado === 'RESERVADA');
    else if (sql.includes('count(*) n FROM convite_artes')) rows = [{ n: '0' }];
    else if (options.listarArtes && sql.includes('FROM convite_artes a WHERE')) rows = [...artes].map(arte => ({ id: arte, imagem: Buffer.from('arte'), origem: 'IA', completo: [...jobs.values()].some(j => j.arte_id === arte && j.modelo === v[2]) }));
    else if (sql.includes('SELECT imagem FROM convite_artes')) rows = options.refsValidas && artes.has(v[0]) && v[1] === c.id && v[2] === c.empresa_id ? [{ imagem: Buffer.from('galeria-' + v[0]) }] : []; // Nenhuma arte de outra festa é autorizada.
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
    else if (sql.includes('INSERT INTO convite_geracoes')) jobs.set(v[0], { id: v[0], estado: 'RESERVADA', convite_id: v[1], empresa_id: v[2], ator: v[3], payload_hash: v[4], modelo: v[5], arte_id: null, criado_em: new Date(agora), reserva_microusd: 300000, etapas_registradas: sql.includes('etapas_registradas') });
    else if (sql.includes('INSERT INTO convite_artes')) rows = [{ id: id(88) }];
    else if (sql.includes('UPDATE convite_consumos SET usado=usado-1')) {
      const geracao = jobs.get(v[0]), diaOrigem = diaSaoPaulo(geracao.criado_em), mesOrigem = `${diaOrigem.slice(0, 7)}-01`, saldo = monthlyUsage.get(mesOrigem) ?? 0;
      if (!options.failMonthlyRelease && saldo > 0) { monthlyUsage.set(mesOrigem, saldo - 1); if (mesOrigem === mesAtual) used--; rows = [{ empresa_id: c.empresa_id }]; }
    }
    else if (sql.includes('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2')) {
      const geracao = jobs.get(v[0]), diaOrigem = diaSaoPaulo(geracao.criado_em), saldo = dailyBudget.get(diaOrigem) ?? 0;
      if (!options.failGlobalRelease && saldo >= v[1]) { dailyBudget.set(diaOrigem, saldo - v[1]); if (diaOrigem === hojeLocal) globalReserved -= v[1]; rows = [{ dia: diaOrigem }]; }
    }
    return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
  } };
  function fotografar() { return { used, globalReserved, monthlyUsage: structuredClone([...monthlyUsage]), dailyBudget: structuredClone([...dailyBudget]), c: structuredClone(c), jobs: structuredClone([...jobs]), artes: [...artes], familias: structuredClone([...familias]), respostas: structuredClone([...respostas]), autorizacoes: structuredClone([...autorizacoes]) }; }
  function restaurar(before) {
    used = before.used; globalReserved = before.globalReserved; Object.assign(c, before.c);
    for (const [target, values] of [[jobs, before.jobs], [familias, before.familias], [respostas, before.respostas], [monthlyUsage, before.monthlyUsage], [dailyBudget, before.dailyBudget], [autorizacoes, before.autorizacoes]]) { target.clear(); for (const [key, value] of values) target.set(key, value); }
    artes.clear(); for (const value of before.artes) artes.add(value);
  }
  const transacao = fn => {
      const next = tail.then(async () => {
        const before = fotografar();
        try { return await fn(tx); } catch (error) { restaurar(before); throw error; }
      }); tail = next.catch(() => {}); return next;
    };
  const service = carregar(path.join(__dirname, 'service.ts'), {
    '../db/postgres': { db: () => tx, withTransaction: transacao },
    '../saas/provar-tenant': { provarTenant: async () => ({ empresaComprovada: c.empresa_id, membershipId: id(7), usuarioId: id(8), papelAtual: 'REPRESENTANTE_AUTORIZADO' }), revalidarTenant: async () => {} },
    '../saas/provar-estabelecimento': { provarEstabelecimento: async () => {} },
    '../festas/repository': { contrato: async () => ({ status: options.cancelled ? 'CANCELADO' : 'ASSINADO', versao_id: id(5), snapshot: { evento: { convidados: options.convidados ?? 50 }, privado: 'NAO_EXPOR' } }) },
    '../assinatura/estado': { lerEstadoComercial: async () => ({ acesso: { nivel: options.paywall ? 'SOMENTE_LEITURA' : 'COMPLETO' } }) },
    './domain': domain, './familias': familiasService, './estilos': estilos, './consentimento': consentimento, './consentimento-textos': textosIA,
    './imagem': { FalhaProvedorImagem: FalhaSintetica, provedorImagem: () => provedor, destinoDoProvedor: (p, url) => Object.hasOwn(HOSTS_IA, p) && url.startsWith(HOSTS_IA[p]), modeloImagem: () => options.modelo ?? 'modelo-sintetico', iaConfigurada: () => true, normalizarImagem: async () => Buffer.from('synthetic'),
      imagemDaResposta: (_url, corpo) => typeof corpo?.data?.[0]?.b64_json === 'string' ? Buffer.from(corpo.data[0].b64_json, 'base64') : null,
      processarImagemRecebida: async () => { if (options.reprocessFailure) throw new Error('imagem guardada inválida'); return Buffer.from('reprocessada'); },
      gerarImagem: async (_prompt, refs, enviar, _env, provedorAutorizado) => { calls++; chamadasProvedor.push({ provedorAutorizado, refs: refs.length }); return provedorSintetico(enviar, Buffer.from('synthetic'), {}); },
      completoDisponivel: () => options.completo ?? false, MODELO_COMPLETO: 'gpt-image-2.5-sunburst', QUALIDADE_COMPLETO: 'xhigh',
      gerarConviteCompletoOpenAI: async (prompt, enviar, _env, qualidade, refs) => { calls++; chamadasProvedor.push({ provedorAutorizado: 'openai', refs: refs.length }); completas.push({ prompt, qualidade, refs }); return provedorSintetico(enviar, Buffer.from('png'), { output_tokens: 9 }); },
      armazenarConviteCompleto: async () => Buffer.from('webp-completo') },
  }, { setTimeout: fn => setImmediate(fn), fetch: fetchSintetico, ...(options.console ? { console: options.console } : {}) });
  return { service, c, log, jobs, artes, familias, respostas, completas, autorizacoes, chamadasProvedor, usage: () => used, monthlyUsage, dailyBudget, globalReserved: () => globalReserved, calls: () => calls,
    envios: () => envios, ultimoEnvio: () => ultimoEnvio, avancar: ms => { agora = new Date(agora.getTime() + ms); },
    resolver: (raw, operador = OPERADOR) => transacao(t => service.resolverGeracaoIncerta(t, operador, raw)),
    concluir: (raw, operador = OPERADOR) => transacao(t => service.concluirGeracaoComImagem(t, operador, raw)) };
}
const admin = { tipo: 'admin', sessao: { usuario_id: id(8) }, festaId: id(3) };
const OPERADOR = id(77);
const MENSAGEM_VERIFICANDO = 'Estamos verificando sua geração. Você não precisa tentar novamente.';
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
  for (const r of resultados) assert.ok(r.status === 'fulfilled' || /limite|créditos/i.test(r.reason.message), r.reason?.message);
  assert.equal(resultados.filter(r => r.status === 'fulfilled' && r.value.estado === 'CONCLUIDA').length, 1);
  assert.equal(f.calls(), 1); assert.equal(f.envios(), 1); assert.equal(f.usage(), 60);
});
test('serviço: queda depois do envio mantém reserva, mostra só "verificando" e a mesma chave nunca reenvia', async () => {
  const f = fixture({ providerFailure: true, console: { error: () => {} } });
  const r = await f.service.comandar(cliente, pedido(10));
  assert.equal(r.estado, 'VERIFICANDO'); assert.equal(r.mensagem, MENSAGEM_VERIFICANDO);
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DESCONHECIDA'); assert.equal(g.falha_diagnostico, 'rede_ou_timeout'); assert.ok(g.enviado_em);
  assert.equal((await f.service.comandar(cliente, pedido(10))).estado, 'VERIFICANDO');
  assert.equal(f.calls(), 1); assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_cliente, 1);
});
test('serviço: uma geração em verificação bloqueia novas chaves e a consulta só diz "verificando"', async () => {
  const f = fixture();
  f.jobs.set(id(9), { id: id(9), estado: 'INCERTA', convite_id: f.c.id, empresa_id: f.c.empresa_id, ator: 'CLIENTE:' + f.c.cliente_id, payload_hash: 'hash-anterior', arte_id: null, criado_em: new Date(TEST_NOW), reserva_microusd: 300000 });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), /verificando a geração anterior/);
  const consulta = await f.service.consultar(admin);
  assert.equal(consulta.geracaoIncerta, true); assert.equal(consulta.geracaoEmAndamento, null);
  assert.equal(f.calls(), 0); assert.equal(f.envios(), 0); assert.equal(f.usage(), 0);
  assert.equal(f.log.some(x => x.sql.includes('INSERT INTO convite_geracoes')), false);
});
function pendente(f, chave = id(20), ator = `CLIENTE:${f.c.cliente_id}`, criadoEm = TEST_NOW) {
  f.c.usado_festa = 1; f.c.usado_cliente = ator.startsWith('CLIENTE:') ? 1 : 0;
  f.jobs.set(chave, { id: chave, estado: 'INCERTA', convite_id: f.c.id, empresa_id: f.c.empresa_id, ator,
    payload_hash: 'hash-opaco', arte_id: null, criado_em: new Date(criadoEm), reserva_microusd: 300000 });
  return chave;
}
const evidencia = 'Painel de uso da OpenAI conferido em 18/10/2026; solicitação localizada pelo horário.';
const decisao = (geracaoId, resultado, texto = evidencia) => ({ geracaoId, resultado, evidencia: texto });
test('operador: cobrança confirmada registra evidência e mantém todas as cotas consumidas', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultado = await f.resolver(decisao(chave, 'COBRANCA_CONFIRMADA'));
  assert.equal(resultado.resolvida, true); assert.equal(resultado.estado, 'RESOLVIDA_COBRADA'); assert.equal(resultado.liberouReserva, false);
  assert.equal(f.jobs.get(chave).resolucao_resultado, 'COBRANCA_CONFIRMADA');
  assert.equal(f.jobs.get(chave).resolucao_por, OPERADOR);
  assert.equal(f.jobs.get(chave).resolucao_evidencia, evidencia);
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.c.usado_cliente, 1); assert.equal(f.globalReserved(), 300000);
  const eventos = f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL');
  assert.equal(eventos.length, 1); assert.equal(eventos[0].v[1], `OPERADOR:${OPERADOR}`);
  // O histórico do convite não leva o texto da evidência (fica só na geração, para o operador).
  assert.ok(!JSON.stringify(eventos[0].v[3]).includes('Painel de uso'));
  assert.equal(f.calls(), 0);
  await assert.rejects(f.resolver(decisao(chave, 'COBRANCA_CONFIRMADA')), /já foi resolvida/);
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
});
test('operador: sem cobrança devolve uma vez o mês, festa, cliente e orçamento do dia original', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultado = await f.resolver(decisao(chave, 'SEM_COBRANCA'));
  assert.equal(resultado.resolvida, true); assert.equal(resultado.estado, 'RESOLVIDA_SEM_COBRANCA'); assert.equal(resultado.liberouReserva, true);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.c.usado_cliente, 0); assert.equal(f.globalReserved(), 0);
  assert.equal(f.jobs.get(chave).resolucao_resultado, 'SEM_COBRANCA');
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.resolver(decisao(chave, 'SEM_COBRANCA')), /já foi resolvida/);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.globalReserved(), 0);
});
test('operador: geração iniciada pelo buffet não reduz a cota individual do cliente', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f, id(21), `USUARIO:${admin.sessao.usuario_id}`);
  f.c.usado_cliente = 0;
  await f.resolver(decisao(chave, 'SEM_COBRANCA'));
  assert.equal(f.c.usado_festa, 0); assert.equal(f.c.usado_cliente, 0); assert.equal(f.usage(), 0); assert.equal(f.globalReserved(), 0);
});
test('operador: decisão repetida em concorrência só transiciona e devolve uma vez', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultados = await Promise.allSettled([f.resolver(decisao(chave, 'SEM_COBRANCA')), f.resolver(decisao(chave, 'SEM_COBRANCA'))]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.globalReserved(), 0);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
});
test('operador: decisões concorrentes divergentes deixam prevalecer uma só, sem devolução dupla', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  const resultados = await Promise.allSettled([f.resolver(decisao(chave, 'COBRANCA_CONFIRMADA')), f.resolver(decisao(chave, 'SEM_COBRANCA'))]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.jobs.get(chave).estado, 'RESOLVIDA_COBRADA');
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 1);
});
test('operador: falha na devolução mensal ou diária reverte a decisão e todos os saldos', async () => {
  for (const options of [{ failMonthlyRelease: true }, { failGlobalRelease: true }]) {
    const f = fixture({ used: 1, globalReserved: 300000, ...options }), chave = pendente(f);
    await assert.rejects(f.resolver(decisao(chave, 'SEM_COBRANCA')));
    assert.equal(f.jobs.get(chave).estado, 'INCERTA'); assert.equal(f.jobs.get(chave).resolucao_resultado, undefined);
    assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.c.usado_cliente, 1); assert.equal(f.globalReserved(), 300000);
    assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 0);
  }
});
test('operador: virada UTC usa o dia e mês civil original de São Paulo para devolver', async () => {
  const timestamp = '2026-10-01T02:30:00.000Z', diaOrigem = diaSaoPaulo(new Date(timestamp)), mesOrigem = `${diaOrigem.slice(0, 7)}-01`;
  const diaAtual = diaSaoPaulo(TEST_NOW), mesAtual = `${diaAtual.slice(0, 7)}-01`;
  const f = fixture({ used: 5, globalReserved: 300000, monthlyUsage: [[mesOrigem, 1], [mesAtual, 5]], dailyBudget: [[diaOrigem, 300000], [diaAtual, 300000]] });
  assert.notEqual(mesOrigem, mesAtual); assert.notEqual(diaOrigem, diaAtual);
  const chave = pendente(f, id(22), `CLIENTE:${f.c.cliente_id}`, timestamp);
  await f.resolver(decisao(chave, 'SEM_COBRANCA'));
  const mensal = f.log.find(x => x.sql.includes('UPDATE convite_consumos SET usado=usado-1'));
  const diaria = f.log.find(x => x.sql.includes('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2'));
  assert.match(mensal.sql, /date_trunc\('month',criado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
  assert.match(diaria.sql, /\(criado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
  assert.equal(mensal.v[0], chave); assert.equal(diaria.v[0], chave);
  assert.equal(f.monthlyUsage.get(mesOrigem), 0); assert.equal(f.monthlyUsage.get(mesAtual), 5); assert.equal(f.usage(), 5);
  assert.equal(f.dailyBudget.get(diaOrigem), 0); assert.equal(f.dailyBudget.get(diaAtual), 300000); assert.equal(f.globalReserved(), 300000);
});
test('permissões: buffet e cliente não decidem mais; evidência curta, resultado inválido e geração inexistente são recusados', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  // A ação 'recuperar' saiu dos comandos do editor: buffet (mesmo com FESTA_OPERAR) e cliente recebem erro de validação.
  for (const acesso of [admin, cliente])
    await assert.rejects(f.service.comandar(acesso, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia }), e => e.name === 'ZodError');
  await assert.rejects(f.resolver(decisao(chave, 'SEM_COBRANCA', 'curto')), e => e.name === 'ZodError');
  await assert.rejects(f.resolver(decisao(chave, 'CONFIRMADA')), e => e.name === 'ZodError');
  await assert.rejects(f.resolver(decisao(id(99), 'SEM_COBRANCA')), e => e.status === 404);
  assert.equal(f.jobs.get(chave).estado, 'INCERTA'); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_RECUPERACAO_MANUAL').length, 0);
  assert.equal(f.calls(), 0);
});
test('consulta: buffet (com ou sem FESTA_OPERAR) e cliente recebem só "verificando", sem ids, evidências ou decisões', async () => {
  for (const opcoes of [{}, { noOperate: true }]) {
    const f = fixture(opcoes); pendente(f);
    for (const acesso of opcoes.noOperate ? [admin] : [admin, cliente]) {
      const d = await f.service.consultar(acesso);
      assert.equal(d.geracaoIncerta, true);
      for (const campo of ['geracoesPendentes', 'decisoesRecuperacao', 'podeRecuperarGeracao']) assert.equal(campo in d, false, campo);
      assert.ok(!JSON.stringify(d).includes(id(20)));
    }
  }
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
    './domain': domain, './imagem': {}, './familias': familiasService, './estilos': estilos, './consentimento': consentimento, './consentimento-textos': textosIA,
  });
  await assert.rejects(service.confirmar('p'.repeat(43), { chave: id(10), nome: 'Família fictícia', presenca: true, adultos: 1, criancas: 0 }), /encerradas/);
  assert.equal(gravacoes, 0);
});

// Convite completo (V1): dados do rascunho do servidor, estilo + foto opcional, referência do estilo, uma chamada.
const FOTO = 'data:image/png;base64,iVBORw0KGgo=';
// Confirmação da fotografia e das imagens da galeria para uma geração (088, versão .2).
const IMG = (operador = 'BUFFET', provedorIA = 'openai') => ({ versao: textosIA.VERSAO_TEXTOS_IA, textoHash: consentimento.hashImagensIA(provedorIA, operador) });
const completo = (n, extra = {}) => ({ acao: 'gerar', chave: id(n), prompt: 'Tema fazenda, verde e amarelo, com um cavalo', referencias: [], completo: true, estilo: 'cartoon3d', ...extra });
function comDados(f, dados = {}) { f.c.rascunho = { ...f.c.rascunho, nome: 'Miguel', idade: '6 anos', data: '2026-10-10', horario: '17:00', local: 'KidMais', endereco: 'Asa Norte', ...dados }; }
const referenciaReal = arquivo => fs.readFileSync(path.join(__dirname, 'referencias', arquivo));

test('qualidade: as três opções chegam ao gerador com uma chamada e um crédito, para buffet e cliente', async () => {
  for (const acesso of [admin, cliente]) for (const qualidade of ['high', 'xhigh', 'max']) {
    const f = fixture({ completo: true }); comDados(f);
    const p = completo(10, { qualidade });
    await f.service.comandar(acesso, p);
    assert.equal(f.completas[0].qualidade, qualidade);
    assert.equal((await f.service.comandar(acesso, p)).repetida, true);
    await assert.rejects(f.service.comandar(acesso, { ...p, qualidade: qualidade === 'high' ? 'max' : 'high' }), /Chave/);
    assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1);
  }
});

test('qualidade: xhigh explícita e padrão preservam o hash de pedidos históricos', async () => {
  const f = fixture({ completo: true }); comDados(f);
  const p = completo(10);
  const campos = ['nome', 'idade', 'data', 'horario', 'local', 'endereco', 'mensagem'].map(k => String(f.c.rascunho[k] ?? '').trim());
  const hashAnterior = crypto.createHash('sha256').update(JSON.stringify({ prompt: p.prompt, referencias: [], completo: true, estilo: 'cartoon3d', campos })).digest('hex');
  await f.service.comandar(admin, p);
  assert.equal(f.log.find(q => q.sql.includes('INSERT INTO convite_geracoes')).v[4], hashAnterior);
  assert.equal((await f.service.comandar(admin, { ...p, qualidade: 'xhigh' })).repetida, true);
  assert.equal(f.envios(), 1);
});

test('qualidade: valor inválido ou fora do convite completo é recusado antes de reservar e enviar', async () => {
  const f = fixture({ completo: true }); comDados(f);
  await assert.rejects(f.service.comandar(admin, completo(10, { qualidade: 'ultra' })), e => e.name === 'ZodError');
  await assert.rejects(f.service.comandar(admin, { ...pedido(11), qualidade: 'high' }), /somente para o convite completo/);
  assert.equal(f.envios(), 0); assert.equal(f.usage(), 0);
  assert(!f.log.some(q => q.sql.includes('INSERT INTO convite_geracoes')));
});

test('convite completo: foto → referência do estilo numa única chamada, modelo e qualidade do servidor, créditos reais', async () => {
  for (const [estilo, arquivo] of [['cartoon3d', 'cartoon3d-aprovado-v2.webp'], ['cartoon2d', 'cartoon2d-aprovado-v1.webp'], ['realista', 'realista-aprovado-v1.webp']]) {
    const f = fixture({ completo: true }); comDados(f);
    const r = await f.service.comandar(admin, completo(10, { estilo, foto: FOTO, autorizacaoImagens: IMG() }));
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
  await f.service.comandar(admin, completo(10, { foto: FOTO, autorizacaoImagens: IMG() }));
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
  await assert.rejects(f.service.comandar(admin, { ...pedido(14), foto: FOTO, autorizacaoImagens: IMG() }), /somente para o convite completo/);
  await assert.rejects(f.service.comandar(admin, completo(15, { estilo: 'aquarela' })), e => e.name === 'ZodError'); // HTTP 400
  assert.equal(f.calls(), 0); assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0);
  assert(!f.log.some(q => q.sql.includes('INSERT INTO convite_geracoes')));
  const indisponivel = fixture({ completo: false }); comDados(indisponivel);
  await assert.rejects(indisponivel.service.comandar(admin, completo(16)), /não está disponível/);
  assert.equal(indisponivel.calls(), 0);
});

test('convite completo: idempotência por chave inclui estilo e foto; falha fica em verificação e nunca reenvia', async () => {
  const f = fixture({ completo: true }); comDados(f);
  const p = completo(10, { foto: FOTO, autorizacaoImagens: IMG('CLIENTE') });
  await f.service.comandar(cliente, p);
  assert.equal((await f.service.comandar(cliente, p)).repetida, true);
  await assert.rejects(f.service.comandar(cliente, { ...p, estilo: 'realista' }), /Chave/);
  await assert.rejects(f.service.comandar(cliente, { ...p, foto: 'data:image/png;base64,AAAA' }), /Chave/);
  // Mesma chave depois de alterar os dados salvos da festa: recusa em vez de devolver arte com textos antigos.
  comDados(f, { nome: 'Miguel Augusto' });
  await assert.rejects(f.service.comandar(cliente, p), /Chave/);
  comDados(f);
  assert.equal((await f.service.comandar(cliente, p)).repetida, true);
  assert.equal(f.calls(), 1); assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_cliente, 1);
  const falha = fixture({ completo: true, providerFailure: true, console: { error: () => {} } }); comDados(falha);
  assert.equal((await falha.service.comandar(admin, completo(20))).estado, 'VERIFICANDO');
  assert.equal(falha.jobs.get(id(20)).estado, 'INCERTA');
  assert.equal((await falha.service.comandar(admin, completo(20))).estado, 'VERIFICANDO');
  await assert.rejects(falha.service.comandar(admin, completo(21)), /verificando a geração anterior/);
  assert.equal(falha.calls(), 1); assert.equal(falha.envios(), 1);
});

test('resposta explícita de moderação: evidência sanitizada na geração, no evento e no log; reserva mantida, sem nova chamada', async () => {
  const linhas = []; const consoleSintetico = { error: (...a) => linhas.push(a.map(String).join(' ')), log: () => {}, warn: () => {} };
  const f = fixture({ completo: true, console: consoleSintetico, providerError: () => new FalhaSintetica('http_400_moderation_blocked', {
    requestId: 'req_abc123', etapa: 'input', categorias: ['sexual', 'PRIVADO', 'sexual', 'violence'], mensagem: 'PRIVADO' }) });
  comDados(f);
  const r = await f.service.comandar(admin, completo(30));
  assert.equal(r.estado, 'VERIFICANDO'); assert.equal(r.mensagem, MENSAGEM_VERIFICANDO);
  const g = f.jobs.get(id(30));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'RESPOSTA_PROVEDOR'); assert.equal(g.falha_diagnostico, 'http_400_moderation_blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(g.falha_detalhes)), { requestId: 'req_abc123', etapa: 'input', categorias: ['sexual', 'violence'] });
  assert.equal(f.calls(), 1); assert.equal(f.envios(), 1); assert.equal(f.usage(), 1);
  const eventos = f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_INCERTA');
  assert.equal(eventos.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(eventos[0].v[3])), { geracao: id(30), diagnostico: 'http_400_moderation_blocked', classe: 'RESPOSTA_PROVEDOR', requestId: 'req_abc123', etapa: 'input', categorias: ['sexual', 'violence'] });
  const linha = linhas.find(l => l.includes('Geração sem resultado'));
  assert.ok(linha.includes('RESPOSTA_PROVEDOR') && linha.includes('http_400_moderation_blocked') && linha.includes('req_abc123') && linha.includes('"etapa":"input"'));
  assert.ok(!linhas.join(' ').includes('PRIVADO') && !JSON.stringify(eventos).includes('PRIVADO') && !JSON.stringify(g).includes('PRIVADO'));
  // moderation_blocked não prova ausência de cobrança: nada é devolvido automaticamente; nova chave segue bloqueada.
  assert.equal((await f.service.comandar(admin, completo(30))).estado, 'VERIFICANDO');
  await assert.rejects(f.service.comandar(admin, completo(31)), /verificando a geração anterior/);
  assert.equal(f.calls(), 1); assert.equal(f.envios(), 1); assert.equal(f.c.usado_festa, 1);
});
test('falha sem detalhes válidos registra só diagnóstico e classe; requestId/etapa fora do formato são descartados', async () => {
  for (const [erro, esperado] of [
    [() => Error('timeout'), { geracao: id(40), diagnostico: 'falha_interna', classe: 'DESCONHECIDA' }],
    [() => new FalhaSintetica('rede_ou_timeout'), { geracao: id(40), diagnostico: 'rede_ou_timeout', classe: 'DESCONHECIDA' }],
    [() => new FalhaSintetica('http_400_moderation_blocked', { requestId: 'req_x y', etapa: 'PRIVADO', categorias: ['PRIVADO'] }), { geracao: id(40), diagnostico: 'http_400_moderation_blocked', classe: 'RESPOSTA_PROVEDOR' }],
    [() => new FalhaSintetica('http_400_pedido_invalido_image[]'), { geracao: id(40), diagnostico: 'http_400_pedido_invalido_image[]', classe: 'RESPOSTA_PROVEDOR' }],
  ]) {
    const f = fixture({ completo: true, console: { error: () => {} }, providerError: erro }); comDados(f);
    assert.equal((await f.service.comandar(admin, completo(40))).estado, 'VERIFICANDO');
    const eventos = f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_INCERTA');
    assert.equal(eventos.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(eventos[0].v[3])), esperado);
    // A coluna aceita só [a-z0-9_]: "image[]" vira "image__".
    assert.match(f.jobs.get(id(40)).falha_diagnostico, /^[a-z0-9_]{1,120}$/);
  }
});
test('falha ao gravar o evento IA_INCERTA não muda resposta, estado, classe nem reserva', async () => {
  const linhas = [];
  const f = fixture({ completo: true, console: { error: (...a) => linhas.push(a.join(' ')) }, failEventoIncerta: true,
    providerError: () => new FalhaSintetica('http_400_moderation_blocked', { requestId: 'req_abc123', etapa: 'output' }) });
  comDados(f);
  assert.equal((await f.service.comandar(admin, completo(50))).estado, 'VERIFICANDO');
  assert.equal(f.jobs.get(id(50)).estado, 'INCERTA'); assert.equal(f.jobs.get(id(50)).falha_classe, 'RESPOSTA_PROVEDOR');
  assert.equal(f.calls(), 1); assert.equal(f.usage(), 1);
  assert.ok(linhas.some(l => l.includes('Evento IA_INCERTA não registrado')));
});

test('convite completo: limites do cliente, tenant e acesso comercial valem antes do provedor', async () => {
  const esgotado = fixture({ completo: true, partyUsed: 2, clientUsed: 2 }); comDados(esgotado);
  await assert.rejects(esgotado.service.comandar(cliente, completo(10)), /Seu limite/);
  for (const opcoes of [{ otherTenant: true }, { revoked: true }, { cancelled: true }, { paywall: true }]) {
    const f = fixture({ completo: true, ...opcoes }); comDados(f);
    await assert.rejects(f.service.comandar(opcoes.revoked ? cliente : admin, completo(11, { foto: FOTO, autorizacaoImagens: IMG() })));
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

// --- Chamada única, persistência e recuperação (084) -----------------------------------------------------------------
// Provedor sintético sem rede: `envios()` conta requisições HTTP ao provedor; `usage()`/cotas mostram o crédito.
const adiar = () => new Promise(resolve => setImmediate(resolve));
async function ate(condicao) { for (let i = 0; i < 200 && !condicao(); i++) await adiar(); assert.ok(condicao(), 'condição não atingida'); }
function abertura() { let abrir; const portao = new Promise(resolve => { abrir = resolve; }); return { portao, abrir }; }
function reservada(f, chave, extra = {}) {
  f.c.usado_festa += 1; f.c.usado_cliente += 1;
  f.jobs.set(chave, { id: chave, estado: 'RESERVADA', convite_id: f.c.id, empresa_id: f.c.empresa_id, ator: `CLIENTE:${f.c.cliente_id}`,
    payload_hash: 'hash-opaco', arte_id: null, criado_em: new Date(TEST_NOW), reserva_microusd: 300000, modelo: 'modelo-sintetico', etapas_registradas: true, ...extra });
  return chave;
}

test('chamada única: clique duplo (mesma chave em paralelo) faz um envio, uma reserva e o cabeçalho leva a chave', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.comandar(cliente, pedido(10)), f.service.comandar(cliente, pedido(10))]);
  const [nova, repetida] = a.repetida ? [b, a] : [a, b];
  assert.equal(nova.estado, 'CONCLUIDA'); assert.equal(repetida.repetida, true); assert.ok(['EM_ANDAMENTO', 'CONCLUIDA'].includes(repetida.estado));
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.c.usado_cliente, 1);
  // Identificador nosso para o suporte do provedor; não substitui a proteção local.
  assert.equal(f.ultimoEnvio().headers['X-Client-Request-Id'], id(10));
  assert.equal(f.jobs.get(id(10)).estado, 'CONCLUIDA'); assert.ok(f.jobs.get(id(10)).enviado_em);
});
test('chamada única: outra aba com outra chave acompanha a geração em andamento sem reservar nem enviar', async () => {
  const { portao, abrir } = abertura();
  const f = fixture({ portao });
  const primeira = f.service.comandar(cliente, pedido(10));
  await ate(() => f.envios() === 1);
  const outra = await f.service.comandar(cliente, pedido(11));
  assert.deepEqual({ ...outra }, { repetida: true, chave: id(10), estado: 'EM_ANDAMENTO', arteId: null, acompanhando: true });
  assert.equal(f.jobs.has(id(11)), false);
  // Recarga/reconexão: a consulta e a situação apontam a mesma geração.
  assert.equal((await f.service.consultar(cliente)).geracaoEmAndamento, id(10));
  assert.equal((await f.service.situacaoGeracao(cliente, id(10))).estado, 'EM_ANDAMENTO');
  abrir();
  const r = await primeira;
  assert.equal(r.estado, 'CONCLUIDA');
  const situacao = await f.service.situacaoGeracao(cliente, id(10));
  assert.equal(situacao.estado, 'CONCLUIDA'); assert.equal(situacao.arteId, r.arteId);
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_cliente, 1);
});
test('recarga e reconexão: resposta perdida depois da arte salva; a mesma chave devolve a arte sem nova chamada', async () => {
  const f = fixture();
  const original = await f.service.comandar(cliente, pedido(10)); // a resposta "se perde" no navegador
  const situacao = await f.service.situacaoGeracao(cliente, id(10));
  assert.equal(situacao.estado, 'CONCLUIDA'); assert.equal(situacao.arteId, original.arteId);
  const repetida = await f.service.comandar(cliente, pedido(10));
  assert.equal(repetida.repetida, true); assert.equal(repetida.estado, 'CONCLUIDA'); assert.equal(repetida.arteId, original.arteId);
  await assert.rejects(f.service.situacaoGeracao(cliente, id(99)), e => e.status === 404);
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1);
});
test('queda antes do envio: falha montando o pedido devolve as reservas automaticamente e libera nova tentativa', async () => {
  const f = fixture({ failBeforeSend: true, console: { error: () => {} } });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), e => e.status === 503 && /Nenhum crédito foi usado/.test(e.message));
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'NAO_ENVIADA'); assert.equal(g.falha_classe, 'PRE_ENVIO'); assert.equal(g.enviado_em, undefined);
  assert.equal(f.envios(), 0); assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.c.usado_cliente, 0); assert.equal(f.globalReserved(), 0);
  assert.equal(f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_NAO_ENVIADA').length, 1);
  // Mesma chave: só informa; não reserva de novo. Nova chave: segue normalmente.
  assert.equal((await f.service.comandar(cliente, pedido(10))).estado, 'NAO_INICIADA');
  assert.equal(f.usage(), 0);
});
test('queda antes do envio: banco indisponível ao marcar o envio impede a chamada e devolve as reservas', async () => {
  const f = fixture({ failMarker: true, console: { error: () => {} } });
  await assert.rejects(f.service.comandar(cliente, pedido(10)), e => e.status === 503);
  assert.equal(f.envios(), 0); assert.equal(f.jobs.get(id(10)).estado, 'NAO_ENVIADA'); assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0);
});
test('sem retentativa paga: um segundo envio na mesma geração é recusado antes de sair', async () => {
  const f = fixture({ enviarDuasVezes: true, console: { error: () => {} } });
  const r = await f.service.comandar(cliente, pedido(10));
  assert.equal(f.envios(), 1);
  // Nenhuma segunda requisição sai; a imagem do primeiro envio fica retida e a geração vai para o operador.
  assert.equal(r.estado, 'VERIFICANDO'); assert.equal(f.jobs.get(id(10)).falha_classe, 'ARMAZENAMENTO');
  assert.ok(f.jobs.get(id(10)).resultado_pendente);
});
test('imagem salva e gravação da arte falhando: a próxima leitura conclui com a imagem guardada, sem nova chamada', async () => {
  const f = fixture({ failConcluir: 3, console: { error: () => {} } });
  const r = await f.service.comandar(cliente, pedido(10));
  assert.equal(r.estado, 'EM_ANDAMENTO'); assert.equal(r.chave, id(10));
  assert.equal(f.jobs.get(id(10)).estado, 'RESERVADA'); assert.ok(f.jobs.get(id(10)).resultado_pendente);
  assert.equal((await f.service.consultar(cliente)).geracaoEmAndamento, id(10)); // a geração em curso ainda pode gravar
  f.avancar(31_000);
  const d = await f.service.consultar(cliente); // recarga do editor
  assert.equal(d.geracaoEmAndamento, null);
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'CONCLUIDA'); assert.ok(g.arte_id); assert.equal(g.resultado_pendente, null);
  const concluida = f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_CONCLUIDA');
  assert.equal(concluida.length, 1); assert.equal(concluida[0].v[3].recuperada, true); assert.equal(concluida[0].v[1], 'SISTEMA:reconciliacao');
  assert.equal((await f.service.situacaoGeracao(cliente, id(10))).estado, 'CONCLUIDA');
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_cliente, 1);
});
test('falha de persistência sem imagem guardada: fica em verificação (ARMAZENAMENTO) com o crédito mantido', async () => {
  const f = fixture({ failConcluir: 3, failGuardarRecebida: true, console: { error: () => {} } });
  const r = await f.service.comandar(cliente, pedido(10));
  assert.equal(r.estado, 'VERIFICANDO');
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'ARMAZENAMENTO'); assert.equal(g.falha_diagnostico, 'gravacao_local');
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1);
});
test('imagem recebida inválida: classe ARMAZENAMENTO, imagem retida para o operador e nenhuma devolução automática', async () => {
  const f = fixture({ processFailure: true, console: { error: () => {} } });
  assert.equal((await f.service.comandar(cliente, pedido(10))).estado, 'VERIFICANDO');
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'ARMAZENAMENTO'); assert.ok(g.resultado_pendente);
  assert.equal(f.usage(), 1);
  // A decisão do operador descarta a imagem retida.
  await f.resolver({ geracaoId: id(10), resultado: 'COBRANCA_CONFIRMADA', evidencia: 'Imagem recebida do provedor (HTTP 200) e inválida no processamento local.' });
  assert.equal(f.jobs.get(id(10)).resultado_pendente, null);
});
test('reinício com geração em andamento: sem envio registrado → devolve; enviada há 10 min → verificação; imagem guardada → arte', async () => {
  const semEnvio = fixture({ used: 1, globalReserved: 300000, console: { error: () => {} } });
  reservada(semEnvio, id(10));
  semEnvio.avancar(60_000);
  assert.equal((await semEnvio.service.consultar(cliente)).geracaoEmAndamento, id(10)); // ainda dentro do prazo: acompanha
  semEnvio.avancar(90_000);
  const d = await semEnvio.service.consultar(cliente);
  assert.equal(d.geracaoEmAndamento, null); assert.equal(d.geracaoIncerta, false);
  assert.equal(semEnvio.jobs.get(id(10)).estado, 'NAO_ENVIADA'); assert.equal(semEnvio.jobs.get(id(10)).falha_diagnostico, 'interrompida_antes_do_envio');
  assert.equal(semEnvio.usage(), 0); assert.equal(semEnvio.c.usado_festa, 0); assert.equal(semEnvio.c.usado_cliente, 0); assert.equal(semEnvio.globalReserved(), 0);

  const enviada = fixture({ used: 1, globalReserved: 300000 });
  reservada(enviada, id(11), { enviado_em: new Date(TEST_NOW) });
  enviada.avancar(5 * 60_000);
  await assert.rejects(enviada.service.comandar(cliente, pedido(12)).then(r => { assert.equal(r.acompanhando, true); throw new Error('acompanhou'); }), /acompanhou/);
  enviada.avancar(6 * 60_000);
  const lida = await enviada.service.consultar(cliente);
  assert.equal(lida.geracaoIncerta, true);
  assert.equal(enviada.jobs.get(id(11)).estado, 'INCERTA'); assert.equal(enviada.jobs.get(id(11)).falha_classe, 'DESCONHECIDA');
  assert.equal(enviada.usage(), 1); assert.equal(enviada.c.usado_festa, 1); assert.equal(enviada.globalReserved(), 300000);

  const guardada = fixture({ used: 1, globalReserved: 300000 });
  reservada(guardada, id(13), { enviado_em: new Date(TEST_NOW), recebido_em: new Date(TEST_NOW), resultado_pendente: Buffer.from('recebida') });
  guardada.avancar(31_000);
  assert.equal((await guardada.service.situacaoGeracao(cliente, id(13))).estado, 'CONCLUIDA');
  assert.equal(guardada.usage(), 1);
  // Nenhum dos três caminhos chama o provedor.
  assert.equal(semEnvio.envios() + enviada.envios() + guardada.envios(), 0);
});
test('reinício: imagem guardada que não processa vai para verificação; erro de banco na reconciliação não quebra a leitura', async () => {
  const f = fixture({ reprocessFailure: true, console: { error: () => {} } });
  reservada(f, id(10), { enviado_em: new Date(TEST_NOW), recebido_em: new Date(TEST_NOW), resultado_pendente: Buffer.from('recebida') });
  f.avancar(31_000);
  assert.equal((await f.service.consultar(cliente)).geracaoIncerta, true);
  assert.equal(f.jobs.get(id(10)).falha_classe, 'ARMAZENAMENTO'); assert.equal(f.jobs.get(id(10)).falha_diagnostico, 'processamento_local');
  const banco = fixture({ failConcluir: 1, console: { error: () => {} } });
  reservada(banco, id(11), { enviado_em: new Date(TEST_NOW), recebido_em: new Date(TEST_NOW), resultado_pendente: Buffer.from('recebida') });
  banco.avancar(31_000);
  const d = await banco.service.consultar(cliente); // falha adiada, leitura segue
  assert.equal(d.geracaoEmAndamento, id(11));
  assert.equal((await banco.service.situacaoGeracao(cliente, id(11))).estado, 'CONCLUIDA');
});
test('operador: decisão repetida depois de uma recuperação automática nunca devolve duas vezes', async () => {
  const f = fixture({ used: 1, globalReserved: 300000, console: { error: () => {} } });
  reservada(f, id(10)); f.avancar(3 * 60_000);
  await f.service.consultar(cliente); // devolvida automaticamente (NAO_ENVIADA)
  await assert.rejects(f.resolver({ geracaoId: id(10), resultado: 'SEM_COBRANCA', evidencia: 'Tentativa de devolver de novo uma geração já devolvida.' }), /não está pendente/);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.globalReserved(), 0);
});
// --- Achados da revisão independente ----------------------------------------------------------------------------------
test('reserva do código anterior (sem etapas registradas) nunca é devolvida automaticamente; depois de 10 min vai para o operador', async () => {
  const f = fixture({ used: 1, globalReserved: 300000, console: { error: () => {} } });
  reservada(f, id(10), { etapas_registradas: false });
  f.avancar(3 * 60_000);
  assert.equal((await f.service.consultar(cliente)).geracaoEmAndamento, id(10), 'enviado_em nulo não prova ausência de envio');
  assert.equal(f.jobs.get(id(10)).estado, 'RESERVADA'); assert.equal(f.usage(), 1);
  f.avancar(8 * 60_000);
  const d = await f.service.consultar(cliente);
  assert.equal(d.geracaoIncerta, true);
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DESCONHECIDA'); assert.equal(g.falha_diagnostico, 'legado_sem_registro');
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000); assert.equal(f.envios(), 0);
});
test('instância anterior ainda enviando durante o deploy: a geração dela não recebe o marcador do código novo nem é devolvida', async () => {
  const f = fixture({ used: 1, globalReserved: 300000, console: { error: () => {} } });
  reservada(f, id(10), { etapas_registradas: false });
  f.avancar(2 * 60_000 + 1);
  await f.service.consultar(cliente);
  assert.equal(f.jobs.get(id(10)).estado, 'RESERVADA');
  assert.equal(f.log.filter(x => x.sql.includes("SET estado='NAO_ENVIADA'")).length, 0);
});
test('devolução automática que não fecha (contadores divergentes) vai para o operador em vez de travar a festa', async () => {
  const f = fixture({ console: { error: () => {} } });
  reservada(f, id(10));
  f.c.usado_festa = 0; f.c.usado_cliente = 0; // contador já divergente: a devolução não pode ser feita com segurança
  f.avancar(3 * 60_000);
  const d = await f.service.consultar(cliente);
  assert.equal(d.geracaoEmAndamento, null); assert.equal(d.geracaoIncerta, true);
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DEVOLUCAO_FALHOU'); assert.equal(g.falha_diagnostico, 'devolucao_automatica_falhou');
  assert.equal(f.c.usado_festa, 0, 'nada foi devolvido parcialmente');
});
test('operador conclui com a imagem retida: arte entregue sem nova chamada, crédito mantido, uma única vez', async () => {
  const f = fixture({ processFailure: true, console: { error: () => {} } });
  assert.equal((await f.service.comandar(cliente, pedido(10))).estado, 'VERIFICANDO');
  assert.equal(f.jobs.get(id(10)).falha_classe, 'ARMAZENAMENTO');
  const r = await f.concluir({ geracaoId: id(10) });
  assert.equal(r.estado, 'CONCLUIDA'); assert.equal(r.liberouReserva, false);
  const g = f.jobs.get(id(10));
  assert.equal(g.estado, 'CONCLUIDA'); assert.ok(g.arte_id); assert.equal(g.resultado_pendente, null);
  const ev = f.log.filter(x => x.sql.includes('INSERT INTO convite_eventos') && x.v[2] === 'IA_CONCLUIDA');
  assert.equal(ev.length, 1); assert.equal(ev[0].v[1], `OPERADOR:${OPERADOR}`); assert.equal(ev[0].v[3].aposVerificacao, true);
  await assert.rejects(f.concluir({ geracaoId: id(10) }), /não está pendente/);
  assert.equal(f.envios(), 1); assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1);
  assert.equal((await f.service.situacaoGeracao(cliente, id(10))).estado, 'CONCLUIDA');
});
test('operador: sem imagem retida ou imagem que não processa, a conclusão é recusada e nada muda', async () => {
  const semImagem = fixture({ providerFailure: true, console: { error: () => {} } });
  await semImagem.service.comandar(cliente, pedido(10));
  await assert.rejects(semImagem.concluir({ geracaoId: id(10) }), /não tem imagem recebida retida/);
  assert.equal(semImagem.jobs.get(id(10)).estado, 'INCERTA');
  const invalida = fixture({ processFailure: true, reprocessFailure: true, console: { error: () => {} } });
  await invalida.service.comandar(cliente, pedido(10));
  await assert.rejects(invalida.concluir({ geracaoId: id(10) }), /não pôde ser processada/);
  assert.equal(invalida.jobs.get(id(10)).estado, 'INCERTA'); assert.ok(invalida.jobs.get(id(10)).resultado_pendente);
  await assert.rejects(invalida.concluir({ geracaoId: id(10), extra: 1 }), e => e.name === 'ZodError');
});
test('devolução trava a carteira antes de orçamento e consumo, na mesma ordem da reserva', async () => {
  const f = fixture({ used: 1, globalReserved: 300000 }), chave = pendente(f);
  await f.resolver({ geracaoId: chave, resultado: 'SEM_COBRANCA', evidencia: 'Conferência sintética da ordem das travas na devolução.' });
  const i = sql => f.log.findIndex(x => x.sql.includes(sql));
  const carteira = f.log.findLastIndex(x => x.sql.includes('FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE'));
  assert.ok(carteira >= 0 && carteira < i('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2'));
  assert.ok(i('UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2') < i('UPDATE convite_consumos SET usado=usado-1'));
  const reserva = fixture();
  await reserva.service.comandar(cliente, pedido(10));
  const r = sql => reserva.log.findIndex(x => x.sql.includes(sql));
  assert.ok(r('FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE') < r('INSERT INTO convite_orcamento_global') && r('INSERT INTO convite_orcamento_global') < r('INSERT INTO convite_consumos'));
});
test('falha passageira de banco na devolução automática não vai para o operador: a reserva fica e a reconciliação tenta de novo', async () => {
  const f = fixture({ used: 1, globalReserved: 300000, failCarteira: true, console: { error: () => {} } });
  reservada(f, id(10)); f.avancar(3 * 60_000);
  assert.equal((await f.service.consultar(cliente)).geracaoEmAndamento, id(10));
  assert.equal(f.jobs.get(id(10)).estado, 'RESERVADA'); assert.equal(f.jobs.get(id(10)).falha_classe, undefined);
  assert.equal(f.usage(), 1); assert.equal(f.c.usado_festa, 1); assert.equal(f.globalReserved(), 300000);
});

// --- 088: autorização específica do responsável legal (parecer da Astra de 21/10/2026, ponto urgente 1) -------------
// Versão .2 dos textos (revisão de 15aa937): autorização geral sem foto; fotografia e imagens da galeria confirmadas a
// cada geração (uso único), com sha-256 das imagens no evento IA_RESERVADA; sem a 088, erro 503 tratado.
const plano = x => JSON.parse(JSON.stringify(x));
const NOME_RESPONSAVEL = 'Joana Responsavel Sigilo';
function autorizar(_f, acesso, extra = {}) {
  const operador = acesso.tipo === 'admin' ? 'BUFFET' : 'CLIENTE', provedor = extra.provedor ?? 'openai';
  return { acao: 'autorizar_ia', versao: textosIA.VERSAO_TEXTOS_IA, provedor, textoHash: consentimento.hashTextoIA(provedor, operador),
    responsavelNome: NOME_RESPONSAVEL, vinculo: 'MAE', ...(acesso.tipo === 'admin' ? { meio: 'WHATSAPP' } : {}), declaracao: true, ...extra };
}
const semEscritaDeGeracao = f => !f.log.some(q => /INSERT INTO convite_(geracoes|consumos|orcamento_global)|UPDATE convites SET usado_festa/.test(q.sql));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const reservaDe = (f, chave) => f.log.find(q => q.sql.startsWith('INSERT INTO convite_eventos') && q.v[2] === 'IA_RESERVADA' && q.v[3].geracao === chave)?.v[3];

test('088: sem autorização vigente a geração é recusada no servidor antes de reservar créditos ou enviar', async () => {
  for (const acesso of [admin, cliente]) for (const p of [pedido(10), completo(11), completo(12, { foto: FOTO, autorizacaoImagens: IMG(acesso.tipo === 'admin' ? 'BUFFET' : 'CLIENTE') })]) {
    const f = fixture({ semAutorizacao: true, completo: true }); comDados(f);
    await assert.rejects(f.service.comandar(acesso, p), e => e.status === 403 && /autorização específica do responsável legal/.test(e.message));
    assert.equal(f.calls(), 0); assert.equal(f.envios(), 0); assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0); assert.equal(f.jobs.size, 0);
    assert(semEscritaDeGeracao(f));
  }
});

test('088: autorização de outro provedor, de texto antigo (inclusive a versão .1) ou adulterada não vale; a tela pede nova', async () => {
  for (const opcoes of [{ autorizacaoProvedor: 'gemini' }, { autorizacaoVersao: 'convites-ia-20261021.1' }]) {
    const f = fixture(opcoes);
    await assert.rejects(f.service.comandar(admin, pedido(10)), /autorização específica/);
    assert.equal(f.envios(), 0); assert(semEscritaDeGeracao(f));
    const d = await f.service.consultar(admin);
    assert.equal(d.autorizacaoIA.vigente, null); assert.equal(d.autorizacaoIA.precisaRenovar, true);
  }
  const f = fixture(); f.autorizacoes.get(id(500)).texto_hash = 'f'.repeat(64);
  await assert.rejects(f.service.comandar(admin, pedido(10)), /autorização específica/); assert.equal(f.envios(), 0);
});

test('088: consulta mostra aviso, textos e hashes com o provedor real, sem o nome do responsável', async () => {
  for (const [provedor, nome, artigo] of [['openai', 'OpenAI', 'à OpenAI'], ['gemini', 'Google (Gemini)', 'ao Google (Gemini)']]) {
    const f = fixture({ provedor });
    for (const acesso of [admin, cliente]) {
      const d = await f.service.consultar(acesso), ia = d.autorizacaoIA;
      assert.equal(ia.provedor, provedor); assert.equal(ia.provedorNome, nome); assert.equal(ia.versao, 'convites-ia-20261021.2');
      assert(ia.aviso.startsWith(`Para criar este convite com IA, enviaremos ${artigo} os dados selecionados da festa`));
      assert(ia.foto.includes(`desta fotografia e das imagens da galeria selecionadas ao provedor indicado (${nome}) para gerar esta arte.`));
      assert.equal(ia.operador, acesso.tipo === 'admin' ? 'BUFFET' : 'CLIENTE');
      assert.deepEqual(plano(ia.hashes), { autorizacao: consentimento.hashTextoIA(provedor, ia.operador), imagens: consentimento.hashImagensIA(provedor, ia.operador) });
      assert.equal(ia.vigente.provedor, provedor); assert.equal(ia.vigente.vinculo, 'MAE'); assert.equal('foto' in ia.vigente, false, 'a autorização geral não cobre a foto');
      assert(!JSON.stringify(d).includes('Responsável Sintético'), 'nome do responsável não sai na consulta');
    }
  }
});

test('088: registro grava quem operou, responsável, vínculo, provedor, versão e hash; substitui a anterior; auditoria sem nome', async () => {
  const f = fixture({ semAutorizacao: true });
  const r = await f.service.comandar(admin, autorizar(f, admin));
  assert.equal(r.provedor, 'openai');
  const a = f.autorizacoes.get(r.autorizacaoId);
  assert.deepEqual({ empresa: a.empresa_id, convite: a.convite_id, festa: a.festa_id, provedor: a.provedor, versao: a.texto_versao, operador: a.operador_tipo, usuario: a.operador_usuario_id,
    cliente: a.operador_cliente_id, nome: a.responsavel_nome, vinculo: a.responsavel_vinculo, meio: a.meio },
  { empresa: id(2), convite: id(1), festa: id(3), provedor: 'openai', versao: textosIA.VERSAO_TEXTOS_IA, operador: 'BUFFET', usuario: id(8), cliente: null,
    nome: NOME_RESPONSAVEL, vinculo: 'MAE', meio: 'WHATSAPP' });
  assert.equal(a.texto_hash, consentimento.hashTextoIA('openai', 'BUFFET'));
  const insert = f.log.find(q => q.sql.startsWith('INSERT INTO convite_ia_autorizacoes'));
  assert.match(insert.sql, /criado_em\)\s+VALUES\(.*clock_timestamp\(\)\)/s, 'P3-3: criação no mesmo relógio da revogação');
  const r2 = await f.service.comandar(cliente, autorizar(f, cliente));
  const b = f.autorizacoes.get(r2.autorizacaoId);
  assert.deepEqual([b.operador_tipo, b.operador_cliente_id, b.operador_usuario_id, b.meio], ['CLIENTE', id(4), null, 'PROPRIO_RESPONSAVEL']);
  assert.equal(f.autorizacoes.get(r.autorizacaoId).revogacao_motivo, 'SUBSTITUIDA');
  assert.equal([...f.autorizacoes.values()].filter(x => !x.revogada_em).length, 1);
  const eventos = f.log.filter(q => q.sql.startsWith('INSERT INTO convite_eventos') && q.v[2] === 'AUTORIZACAO_IA_REGISTRADA');
  assert.equal(eventos.length, 2);
  assert.deepEqual(plano(eventos[0].v[3]), { autorizacao: r.autorizacaoId, provedor: 'openai', versao: textosIA.VERSAO_TEXTOS_IA });
  for (const q of f.log.filter(x => !x.sql.startsWith('INSERT INTO convite_ia_autorizacoes'))) assert(!JSON.stringify(q.v).includes(NOME_RESPONSAVEL), q.sql);
});

test('088: registro recusa provedor diferente do real, outra versão, hash de outro texto, meio do cliente, foto e campos extras', async () => {
  const f = fixture({ semAutorizacao: true });
  await assert.rejects(f.service.comandar(admin, autorizar(f, admin, { provedor: 'gemini' })), /provedor de IA mudou/);
  await assert.rejects(f.service.comandar(admin, autorizar(f, admin, { versao: 'convites-ia-20261021.1' })), /texto da autorização foi atualizado/);
  await assert.rejects(f.service.comandar(admin, { ...autorizar(f, admin), textoHash: consentimento.hashTextoIA('openai', 'CLIENTE') }), /não corresponde/);
  await assert.rejects(f.service.comandar(admin, { ...autorizar(f, admin), textoHash: consentimento.hashImagensIA('openai', 'BUFFET') }), /não corresponde/);
  await assert.rejects(f.service.comandar(cliente, { ...autorizar(f, cliente), meio: 'WHATSAPP' }), /somente pelo buffet/);
  await assert.rejects(f.service.comandar(admin, { ...autorizar(f, admin), declaracao: false }), e => e.name === 'ZodError');
  await assert.rejects(f.service.comandar(admin, { ...autorizar(f, admin), foto: true }), e => e.name === 'ZodError', 'a foto não faz parte da autorização geral');
  await assert.rejects(f.service.comandar(admin, { ...autorizar(f, admin), documento: '123' }), e => e.name === 'ZodError');
  assert.equal(f.autorizacoes.size, 0);
});

test('088 P2-3: foto e imagens da galeria exigem a confirmação DESTA geração; sem ela nada sai; com ela o evento guarda os sha-256', async () => {
  // Convite completo com foto: sem confirmação (403), com hash de outro operador ou da autorização geral (409), nada enviado.
  const f = fixture({ completo: true }); comDados(f);
  await assert.rejects(f.service.comandar(cliente, completo(10, { foto: FOTO })), e => e.status === 403 && /fotografia e das imagens da galeria/.test(e.message));
  await assert.rejects(f.service.comandar(cliente, completo(11, { foto: FOTO, autorizacaoImagens: IMG('BUFFET') })), e => e.status === 409);
  await assert.rejects(f.service.comandar(cliente, completo(12, { foto: FOTO, autorizacaoImagens: { versao: textosIA.VERSAO_TEXTOS_IA, textoHash: consentimento.hashTextoIA('openai', 'CLIENTE') } })), e => e.status === 409);
  await assert.rejects(f.service.comandar(cliente, completo(13, { foto: FOTO, autorizacaoImagens: { ...IMG('CLIENTE'), versao: 'convites-ia-20261021.1' } })), e => e.status === 409);
  // Confirmação sem imagem nenhuma não é aceita (não há o que autorizar).
  await assert.rejects(f.service.comandar(cliente, completo(14, { autorizacaoImagens: IMG('CLIENTE') })), e => e.status === 400);
  assert.equal(f.calls(), 0); assert.equal(f.envios(), 0); assert(semEscritaDeGeracao(f));
  // Com a confirmação: a foto sai nesta geração e o evento registra versão, hash do texto e sha-256 da foto normalizada.
  const r = await f.service.comandar(cliente, completo(15, { foto: FOTO, autorizacaoImagens: IMG('CLIENTE') }));
  assert.equal(r.estado, 'CONCLUIDA'); assert.equal(f.completas[0].refs.length, 2, 'foto + referência fixa do estilo');
  assert.deepEqual(plano(reservaDe(f, id(15)).imagens), { versao: 'convites-ia-20261021.2', textoHash: consentimento.hashImagensIA('openai', 'CLIENTE'), sha256: [sha(Buffer.from('synthetic'))] });
  // Uso único: a geração seguinte com foto pede nova confirmação; sem imagens, segue só com a autorização geral.
  await assert.rejects(f.service.comandar(cliente, completo(16, { foto: FOTO, prompt: 'Tema fazenda, verde e azul, com um cavalo' })), e => e.status === 403);
  const sem = await f.service.comandar(cliente, completo(17, { prompt: 'Tema fazenda, azul e amarelo, sem foto' }));
  assert.equal(sem.estado, 'CONCLUIDA'); assert.equal(f.completas[1].refs.length, 0, 'nenhuma imagem sai'); assert.equal(reservaDe(f, id(17)).imagens, undefined);
  // Arte simples com imagens da galeria como referência: mesma regra, sha-256 de cada imagem enviada.
  const g = fixture({ refsValidas: true });
  await assert.rejects(g.service.comandar(admin, { ...pedido(20), referencias: [id(88)] }), e => e.status === 403);
  assert.equal(g.envios(), 0);
  await g.service.comandar(admin, { ...pedido(21), referencias: [id(88), id(89)], autorizacaoImagens: IMG() });
  assert.deepEqual(g.chamadasProvedor, [{ provedorAutorizado: 'openai', refs: 2 }]);
  assert.deepEqual(plano(reservaDe(g, id(21)).imagens.sha256), [sha(Buffer.from('galeria-' + id(88))), sha(Buffer.from('galeria-' + id(89)))]);
});

test('088: provedor exibido = provedor chamado; envio a outro destino é recusado antes do marcador, sem fallback', async () => {
  for (const provedor of ['openai', 'gemini']) {
    const f = fixture({ provedor, urlEnvio: HOSTS_IA[provedor] + 'v1/sintetico' });
    const d = await f.service.consultar(admin); assert.equal(d.autorizacaoIA.provedor, provedor);
    await f.service.comandar(admin, pedido(10));
    assert.deepEqual(f.chamadasProvedor, [{ provedorAutorizado: provedor, refs: 0 }], 'o adaptador recebe o provedor autorizado');
  }
  const f = fixture({ provedor: 'gemini', console: { error: () => {} } });
  await assert.rejects(f.service.comandar(admin, pedido(10)), /Nenhum crédito foi usado/);
  assert.equal(f.envios(), 0); assert.equal(f.jobs.get(id(10)).estado, 'NAO_ENVIADA'); assert.equal(f.jobs.get(id(10)).enviado_em, undefined);
  assert.equal(f.usage(), 0); assert.equal(f.c.usado_festa, 0);
  const falha = fixture({ providerFailure: true, console: { error: () => {} } });
  const r = await falha.service.comandar(admin, pedido(11));
  assert.equal(r.estado, 'VERIFICANDO'); assert.equal(falha.envios(), 1); assert.equal(falha.chamadasProvedor.length, 1);
  assert.match(falha.ultimoEnvio().url, /^https:\/\/api\.openai\.com\//);
});

test('088: revogação vale para usos futuros, inclusive entre a reserva e o envio; leitura comercial não impede revogar', async () => {
  const f = fixture({ completo: true }); comDados(f);
  await f.service.comandar(cliente, completo(10));
  assert.equal(f.envios(), 1);
  assert.deepEqual(plano(await f.service.comandar(cliente, { acao: 'revogar_autorizacao_ia' })), { revogada: true });
  assert.equal(f.autorizacoes.get(id(500)).revogacao_motivo, 'REVOGADA'); assert.equal(f.autorizacoes.get(id(500)).revogada_por, `CLIENTE:${id(4)}`);
  await assert.rejects(f.service.comandar(admin, completo(11)), /autorização específica/);
  assert.equal(f.envios(), 1, 'nada novo enviado'); assert.equal(f.artes.size, 2, 'arte já gerada continua na galeria');
  assert.deepEqual(plano(await f.service.comandar(admin, { acao: 'revogar_autorizacao_ia' })), { revogada: false });
  let corrida = null;
  const g = fixture({ console: { error: () => {} }, antesDoMarcador: () => { if (corrida) return; corrida = true; g.autorizacoes.get(id(500)).revogada_em = new Date(TEST_NOW); } });
  await assert.rejects(g.service.comandar(admin, pedido(12)), /Nenhum crédito foi usado/);
  assert.equal(g.envios(), 0); assert.equal(g.jobs.get(id(12)).estado, 'NAO_ENVIADA'); assert.equal(g.usage(), 0);
  const h = fixture({ paywall: true });
  await assert.rejects(h.service.comandar(admin, autorizar(h, admin)), /regularizar/);
  assert.deepEqual(plano(await h.service.comandar(admin, { acao: 'revogar_autorizacao_ia' })), { revogada: true });
});

test('088: isolamento por empresa — consultas e revogação filtram pela empresa comprovada; outra empresa não lê nem revoga', async () => {
  const f = fixture(); f.autorizacoes.get(id(500)).empresa_id = id(99);
  await assert.rejects(f.service.comandar(admin, pedido(10)), /autorização específica/);
  assert.equal((await f.service.consultar(admin)).autorizacaoIA.vigente, null);
  assert.deepEqual(plano(await f.service.comandar(admin, { acao: 'revogar_autorizacao_ia' })), { revogada: false });
  assert.equal(f.autorizacoes.get(id(500)).revogada_em, null);
  for (const q of f.log.filter(x => x.sql.includes('convite_ia_autorizacoes') && !x.sql.includes('SET enviado_em'))) {
    assert.match(q.sql, /empresa_id=\$2/, q.sql); if (!q.sql.startsWith('INSERT')) assert.equal(q.v[1], id(2));
  }
  const outra = fixture({ otherTenant: true });
  await assert.rejects(outra.service.comandar(admin, autorizar(outra, admin)), /Festa não encontrada/);
  await assert.rejects(outra.service.comandar(admin, { acao: 'revogar_autorizacao_ia' }), /Festa não encontrada/);
  assert(!outra.log.some(q => q.sql.includes('convite_ia_autorizacoes')));
});

test('088: sigilo — logs e eventos não recebem nome do responsável, prompt, foto nem texto do provedor', async () => {
  const linhas = [], consoleSintetico = { error: (...a) => linhas.push(a.map(String).join(' ')), log: (...a) => linhas.push(a.map(String).join(' ')), warn: (...a) => linhas.push(a.map(String).join(' ')) };
  const f = fixture({ semAutorizacao: true, completo: true, console: consoleSintetico, providerError: () => new FalhaSintetica('http_400_moderation_blocked', { requestId: 'req_abc123' }) }); comDados(f);
  await f.service.comandar(admin, autorizar(f, admin));
  const prompt = 'Tema fazenda SEGREDO_DO_PROMPT com cavalo';
  await f.service.comandar(admin, completo(10, { prompt, foto: FOTO, autorizacaoImagens: IMG() }));
  await f.service.comandar(admin, { acao: 'revogar_autorizacao_ia' });
  assert(linhas.length > 0, 'a falha foi registrada em log');
  const saida = linhas.join('\n') + JSON.stringify(f.log.filter(q => q.sql.startsWith('INSERT INTO convite_eventos')).map(q => q.v));
  for (const proibido of [NOME_RESPONSAVEL, 'SEGREDO_DO_PROMPT', 'iVBORw0KGgo', 'synthetic', 'Miguel', 'Asa Norte']) assert(!saida.includes(proibido), proibido);
});

test('088 ausente (código publicado antes da migration): editor abre com a IA bloqueada; gerar, autorizar e revogar respondem 503 tratado', async () => {
  const linhas = [], f = fixture({ semTabela088: true, console: { error: (...a) => linhas.push(a.join(' ')) } });
  const d = await f.service.consultar(cliente);
  assert.equal(d.autorizacaoIA.indisponivel, true); assert.equal(d.autorizacaoIA.vigente, null); assert.equal(d.conteudo.tema, 'celebrar');
  assert.match(d.autorizacaoIA.mensagemIndisponivel, /indisponível até a atualização do banco/);
  for (const cmd of [pedido(10), autorizar(f, cliente), { acao: 'revogar_autorizacao_ia' }])
    await assert.rejects(f.service.comandar(cliente, cmd), e => e.status === 503 && /indisponível até a atualização do banco/.test(e.message), cmd.acao);
  assert.equal(f.envios(), 0); assert.equal(f.calls(), 0); assert(semEscritaDeGeracao(f));
  assert(linhas.some(l => l.includes('Autorização de IA indisponível')));
});
