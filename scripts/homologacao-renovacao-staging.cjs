/* eslint-disable @typescript-eslint/no-require-imports */
// Etapa 5 — aviso de 30 dias e renovação Fundador pelo preço regular (docs/HOMOLOGACAO_RENOVACAO_STAGING_20261010.md).
// PREPARADO, NÃO EXECUTADO. Executar SOMENTE no Web Shell do srv-daif418ae00c73e8k2gg, depois da aprovação explícita,
// com a flag única --renovacao-rodada-1-autorizada. Recuperação: --encerrar-renovacao-rodada-1-autorizada.
// Tempo acelerado só dentro deste processo: o processador recebe `agora` deslocado em dias inteiros e só é chamado para
// as três fixtures da rodada (nunca a seleção geral de empresas do produto). Relógio do sistema/banco e contratos existentes intocados.
// EFEITO PERMANENTE: três vagas Fundador de staging ficam CONFIRMADAS (a 074 nunca devolve vaga confirmada).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {alvo: alvoEnsaio, documento, cookies} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');
const {sqlPreservacao, processoVivo, erroFinal, projecaoAgenda} = require('./homologacao-planos-cotacao-staging.cjs');
const {cancelamentoComprovado, pagamentoConhecido} = require('./homologacao-fundador-staging.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const ROTA_WEBHOOK = '/api/integracoes/asaas/webhook';
const ASAAS = 'https://api-sandbox.asaas.com/v3';
const DIR = '/opt/render/project/src/data/homologacao-renovacao-20261010';
const ARQUIVO = DIR + '/renovacao-rodada-1.json';
const MARCA = 'homologacao-renovacao-20261010-r1';
const FLAG = '--renovacao-rodada-1-autorizada';
const FLAG_ENCERRAR = '--encerrar-renovacao-rodada-1-autorizada';
const KIDMAIS_CNPJ = '20119900000160';
const VAGAS_CAMPANHA = 20;
const DIA_MS = 86400000;
/** E-mail do aviso. SINK: nenhum envio externo (id sintético). RESEND: só RM, só para o destinatário autorizado. Trocar exige nova candidata. */
const MODO_EMAIL = 'SINK';
const DESTINO_AUTORIZADO = 'felipemenegaz@gmail.com';
const REMETENTE_TESTE = 'Kidmais Manager — Teste <onboarding@resend.dev>';
/** Centavos fixados aqui (independentes do código): regular e com 40% Fundador. Anual = 10 × mensal. */
const PRECOS = Object.freeze({
    'essencial/MENSAL': {regular:19700, fundador:11820}, 'essencial/ANUAL': {regular:197000, fundador:118200},
    'profissional/MENSAL': {regular:39700, fundador:23820},
});
const emailDe = (chave, usuario, modo = MODO_EMAIL) => modo === 'RESEND' && chave === 'RM' ? DESTINO_AUTORIZADO : `hml-renovacao-${usuario.slice(0, 8)}@example.invalid`;
const emailEncerrado = usuario => `hml-renovacao-${usuario.slice(0, 8)}-encerrado@example.invalid`;
const FIXTURES = Object.freeze([
    {chave:'RM', empresa:'69faef84-c063-4fb5-8f33-21e49ae673c5', usuario:'0547c356-9f39-4168-9baa-249c65c963e2', codigo:'hml-renovacao-mensal', plano:'essencial', ciclo:'MENSAL'},
    {chave:'RA', empresa:'ff87dacc-0447-448e-a38e-152a9d9e98ff', usuario:'f9934bf9-1f44-4222-9075-defb77c598af', codigo:'hml-renovacao-anual', plano:'essencial', ciclo:'ANUAL'},
    {chave:'RF', empresa:'5fd21aee-fbd6-45d3-8dc9-c169f93728cf', usuario:'eaaf6c32-0eff-4c45-a145-52540632387a', codigo:'hml-renovacao-falha', plano:'profissional', ciclo:'MENSAL'},
].map(f => Object.freeze({...f, ...PRECOS[f.plano + '/' + f.ciclo], email:emailDe(f.chave, f.usuario),
    nome:`TESTE Kidmais — Renovação staging 20261010 r1 ${f.chave}`})));
const IDS_EMPRESAS = FIXTURES.map(f => f.empresa);
const MOTIVO = 'Homologação renovação staging 20261010 r1: assinatura sandbox removida e conferida no Asaas';

/**
 * Matriz por rodada do processador (instante → resultado esperado). REAL = relógio verdadeiro; VESPERA/LIMITE/PERDIDO =
 * véspera, dia e dia seguinte ao limite do aviso (primeira data regular − 30 dias), deslocados só no processo.
 * RM: caminho mensal completo (concorrência no envio, salto do vencimento no sandbox, preço regular).
 * RA: anual com resposta perdida no PUT de preço. RF: falha de entrega → revisão → geração suspensa sem aumento.
 */
const RODADAS = Object.freeze([
    {id:'R0', quando:{RM:'REAL', RA:'REAL', RF:'REAL'}, esperado:{RM:'AGUARDANDO_AVISO', RA:'AGUARDANDO_AVISO', RF:'AGUARDANDO_AVISO'}},
    {id:'R0B', quando:{RM:'REAL', RA:'REAL', RF:'REAL'}, esperado:{RM:'AGUARDANDO_AVISO', RA:'AGUARDANDO_AVISO', RF:'AGUARDANDO_AVISO'}},
    {id:'R1', quando:{RM:'VESPERA', RA:'VESPERA', RF:'VESPERA'}, esperado:{RM:'AGUARDANDO_AVISO', RA:'AGUARDANDO_AVISO', RF:'AGUARDANDO_AVISO'}},
    {id:'R2', quando:{RM:'LIMITE', RA:'LIMITE', RF:'LIMITE'}, esperado:{RM:'AGUARDANDO_ULTIMA_PARCELA', RA:'ERRO_REPROCESSAVEL', RF:'ENVIO_INCERTO'}},
    {id:'R3', quando:{RM:'LIMITE', RA:'LIMITE', RF:'PERDIDO'}, esperado:{RM:'AGUARDANDO_ULTIMA_PARCELA', RA:'REGULAR', RF:'JANELA_AVISO_PERDIDA'}},
    {id:'R4', quando:{RM:'LIMITE', RA:'LIMITE', RF:'LIMITE'}, esperado:{RM:'REGULAR', RA:'REGULAR', RF:'JANELA_AVISO_PERDIDA'}},
    // R5/RF: o cron de reconciliação pode ter sincronizado a suspensão entre R4 e R5; os dois retornos mantêm a revisão.
    {id:'R5', quando:{RM:'LIMITE', RA:'LIMITE', RF:'LIMITE'}, esperado:{RM:'REGULAR', RA:'REGULAR', RF:['JANELA_AVISO_PERDIDA','REVISAO_NECESSARIA']}},
    // R6: depois do cancelamento pela tela de RM e RA. RF (suspensa, em revisão) não é cancelada pela tela; sai no encerramento.
    {id:'R6', quando:{RM:'REAL', RA:'REAL'}, esperado:{RM:'CANCELADA', RA:'CANCELADA'}},
]);
/** Registro persistido (assinatura_renovacoes) depois de cada rodada: [estado, avisoEnviado, precoAplicado, ultimoErro]. */
const REGISTROS = Object.freeze({
    R0:{RM:['PENDENTE',false,false,null], RA:['PENDENTE',false,false,null], RF:['PENDENTE',false,false,null]},
    R2:{RM:['AVISADA',true,false,null], RA:['APLICANDO',true,false,null], RF:['AVISANDO',false,false,'ENVIO_INCERTO']},
    R3:{RM:['AVISADA',true,false,null], RA:['REGULAR',true,true,null], RF:['REVISAO',false,false,'JANELA_AVISO_PERDIDA']},
    R5:{RM:['REGULAR',true,true,null], RA:['REGULAR',true,true,null], RF:['REVISAO',false,false,'JANELA_AVISO_PERDIDA']},
    R6:{RM:['CANCELADA',true,true,null], RA:['CANCELADA',true,true,null], RF:['REVISAO',false,false,'JANELA_AVISO_PERDIDA']},
});
/** DTO da tela (consultarRenovacao) esperado: [estado, avisoEnviado]. */
const TELAS = Object.freeze({
    R0:{RM:['PENDENTE',false], RA:['PENDENTE',false], RF:['PENDENTE',false]},
    R3:{RM:['AVISADA',true], RA:['REGULAR',true], RF:['REVISAO',false]},
    R5:{RM:['REGULAR',true], RA:['REGULAR',true], RF:['REVISAO',false]},
    R6:{RM:['CANCELADA',true], RA:['CANCELADA',true], RF:['REVISAO',false]},
});
/** Envios por fixture ao fim da rodada (tentativas que chegaram ao transporte). RF nunca chega à rede. */
const ENVIOS = Object.freeze({RM:1, RA:1, RF:1});

const PRESERVADAS = Object.freeze([
    ['empresas', 'id', []], ['memberships', 'empresa_id', []],
    ['empresa_assinaturas', 'empresa_id', ['sincronizado_em','atualizado_em','versao']],
    ['assinatura_contratacoes', 'empresa_id', []], ['assinatura_fundadores', 'empresa_id', []], ['assinatura_isencoes', 'empresa_id', []],
    ['assinatura_renovacoes', 'empresa_id', []], ['clientes', 'empresa_id', []], ['fechamentos', 'empresa_id', []], ['pacotes', 'empresa_id', []],
]);

function alvo(env) { return alvoEnsaio(env); }
function alvoEncerramento(env) { return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'}); }
function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1 || argv.length !== 1) return null;
    return flags[0] === FLAG ? 'RODADA' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}
function conferir(nome, obtido, esperado) {
    if (obtido !== esperado) throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado});
}
/** Resultado do processador: um valor esperado ou a lista dos aceitos (corrida declarada com o cron). */
function conferirResultado(nome, obtido, esperado) {
    if (Array.isArray(esperado) ? !esperado.includes(obtido) : obtido !== esperado)
        throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado:[].concat(esperado).join('|')});
}
function cabeNaCampanha(c) { return Number.isInteger(c?.ocupadas) && c.ocupadas + FIXTURES.length <= VAGAS_CAMPANHA; }

// ---- Calendário (datas YYYY-MM-DD em UTC, como o processador; dia civil em America/Sao_Paulo).
const DATA = /^\d{4}-\d{2}-\d{2}$/;
function diaBrasil(d) { return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'}).format(d); }
function horaBrasil(d) { return Number(new Intl.DateTimeFormat('en-GB', {timeZone:'America/Sao_Paulo', hour:'2-digit', hourCycle:'h23'}).format(d)); }
function somarDias(data, dias) { assert.match(data, DATA); return new Date(Date.parse(data + 'T00:00:00Z') + dias * DIA_MS).toISOString().slice(0, 10); }
function diasEntre(de, ate) { assert.match(de, DATA); assert.match(ate, DATA); return Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS); }
/** Dia âncora preservado (31/jan → 28/fev). Implementação própria, independente de lib/assinatura. */
function somarMeses(data, meses) {
    assert.match(data, DATA);
    const [a, m, d] = data.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a, m - 1 + meses + 1, 0)).getUTCDate();
    return new Date(Date.UTC(a, m - 1 + meses, Math.min(d, ultimo))).toISOString().slice(0, 10);
}
/** Primeira data com preço regular: anual = 1º vencimento + 12 meses; mensal = 1º vencimento mensal ≥ fim do benefício. */
function primeiraEsperada(primeiroVencimento, beneficioFim, ciclo) {
    assert.match(primeiroVencimento, DATA); assert.ok(typeof beneficioFim === 'string' && DATA.test(beneficioFim.slice(0, 10)), 'BENEFICIO_FIM');
    if (ciclo === 'ANUAL') return somarMeses(primeiroVencimento, 12);
    assert.equal(ciclo, 'MENSAL');
    for (let k = 1; k <= 13; k++) { const c = somarMeses(primeiroVencimento, k); if (c >= beneficioFim.slice(0, 10)) return c; }
    throw Object.assign(Error('VIGENCIA_FORA_DO_ESPERADO'), {parada:'S2'});
}
/** Instantes do ensaio acelerado. Exige limite no futuro: o CHECK da 075 compara aviso_enviado_em (relógio real) ao limite. */
function planoTempo(hojeReal, primeira) {
    const limite = somarDias(primeira, -30), offset = diasEntre(hojeReal, limite);
    if (!(offset >= 1 && offset <= 400)) throw Object.assign(Error('JANELA_ACELERADA_INVALIDA'), {parada:'S2', item:'offset', obtido:offset});
    return {primeira, limite, offsets:{REAL:0, VESPERA:offset - 1, LIMITE:offset, PERDIDO:offset + 1},
        dias:{REAL:hojeReal, VESPERA:somarDias(limite, -1), LIMITE:limite, PERDIDO:somarDias(limite, 1)}};
}
/** `agora` do processador: relógio real + dias inteiros. Nada fora deste processo muda. */
function relogio(offsetDias, base = Date.now) {
    assert.ok(Number.isSafeInteger(offsetDias) && offsetDias >= 0 && offsetDias <= 401, 'OFFSET_INVALIDO');
    return () => new Date(base() + offsetDias * DIA_MS);
}

// ---- Escopo: só as fixtures e as assinaturas sandbox delas. Qualquer outra empresa/assinatura → S3.
function escopo(fixtures = FIXTURES) {
    const empresas = new Set(fixtures.map(f => f.empresa)), assinaturas = new Map(), uso = {};
    const fora = (tipo, v) => { throw Object.assign(Error('FORA_DAS_FIXTURES'), {parada:'S3', item:tipo, obtido:String(v).slice(0, 12)}); };
    return {
        uso,
        empresa(id) { if (!empresas.has(id)) fora('empresa', id); uso[id] = (uso[id] ?? 0) + 1; return id; },
        vincular(empresa, assinatura) {
            if (!empresas.has(empresa)) fora('empresa', empresa);
            if (typeof assinatura !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(assinatura)) fora('assinatura', assinatura);
            if (assinaturas.has(empresa) && assinaturas.get(empresa) !== assinatura) fora('assinatura', assinatura);
            assinaturas.set(empresa, assinatura);
        },
        assinatura(id) { if (![...assinaturas.values()].includes(id)) fora('assinatura', id); return id; },
    };
}
function repositorioRestrito(repo, esc) {
    return {
        ler: async id => repo.ler(esc.empresa(id)),
        criar: async r => { esc.empresa(r.empresaId); return repo.criar(r); },
        marcar: async (id, registro, a) => repo.marcar(esc.empresa(id), registro, a),
    };
}
/** Provedor do processador limitado às assinaturas das fixtures; conta PUTs; pode perder a resposta de um PUT de preço. */
function provedorRestrito(p, esc, {perderRespostaPreco = new Set(), contagem = {}} = {}) {
    const somar = (k, id) => { contagem[k] = {...(contagem[k] ?? {}), [id]:(contagem[k]?.[id] ?? 0) + 1}; };
    const daFixture = c => { if (c && c.assinaturaId) esc.assinatura(c.assinaturaId); else if (c) esc.assinatura(null); return c; };
    return {
        contagem,
        obterAssinatura: async id => p.obterAssinatura(esc.assinatura(id)),
        listarCobrancasDaAssinatura: async id => p.listarCobrancasDaAssinatura(esc.assinatura(id)),
        obterCobranca: async id => daFixture(await p.obterCobranca(id)),
        async atualizarValorAssinatura(id, valor) {
            esc.assinatura(id); somar('precoAssinatura', id);
            const r = await p.atualizarValorAssinatura(id, valor);
            if (perderRespostaPreco.delete(id)) throw Error('RESPOSTA_PERDIDA_SIMULADA');
            return r;
        },
        async atualizarValorCobranca(c, valor) { daFixture(c); somar('precoCobranca', c.id); return p.atualizarValorCobranca(c, valor); },
        async suspenderGeracao(id) { esc.assinatura(id); somar('suspensao', id); return p.suspenderGeracao(id); },
    };
}

// ---- Transporte do aviso. Payload e chave vêm do registro persistido; nenhum destino fora das fixtures.
function idSink(idempotencia) { return 'sink-' + createHash('sha256').update(String(idempotencia)).digest('hex').slice(0, 40); }
function envioSink(log) { return async m => { log.push(m.idempotencia); return {provedor:'sink', idExterno:idSink(m.idempotencia)}; }; }
function envioFalho(log) { return async m => { log.push(m.idempotencia); throw Error('FALHA_DE_ENTREGA_SIMULADA'); }; }
/** Fetch do Resend: só POST /emails, um destinatário autorizado, remetente de teste, chave do registro e no máximo `limite` requisições. */
function fetchResendRestrito(fetcher, {destino = DESTINO_AUTORIZADO, remetente = REMETENTE_TESTE, limite = 1} = {}) {
    let requisicoes = 0;
    const f = async (url, init) => {
        const body = JSON.parse(init?.body ?? '{}');
        if (url !== 'https://api.resend.com/emails' || init?.method !== 'POST' || !Array.isArray(body.to) || body.to.length !== 1
            || body.to[0] !== destino || body.from !== remetente || !/^kidmais-renovacao\/[0-9a-f-]{36}$/.test(init.headers?.['Idempotency-Key'] ?? '')
            || ++requisicoes > limite) throw Error('DESTINO_RECUSADO');
        return fetcher(url, {...init, redirect:'error'});
    };
    f.requisicoes = () => requisicoes;
    return f;
}
/** Cada fixture só envia ao próprio e-mail e com a chave imutável do próprio registro. */
function envioDaFixture(f, transporte) {
    return async m => {
        if (m?.para !== f.email || !/^kidmais-renovacao\/[0-9a-f-]{36}$/.test(m?.idempotencia ?? '')) throw Error('MENSAGEM_FORA_DA_FIXTURE');
        return transporte(m);
    };
}

/** Prova de autoria a partir do estado gravado ANTES de cada criação (mesma regra da rodada Fundador). */
function recursosComprovados(r) {
    const livre = r?.precheck?.fixturesLivres === true;
    return {
        fixtures: livre && r.intencaoFixture === true,
        assinaturas: Object.fromEntries(FIXTURES.map(f => [f.chave, livre && r?.precheck?.asaasLivre?.[f.chave] === true && r[f.chave]?.intencaoCheckout === true])),
        // Depois da intenção de pagamento a vaga pode estar CONFIRMADA: nunca liberar.
        pagamento: Object.fromEntries(FIXTURES.map(f => [f.chave, r?.[f.chave]?.intencaoPagamento === true])),
    };
}

/** Linha de assinatura_renovacoes da fixture contra a matriz. */
function conferirRegistro(chave, linha, esperado, f, tempo) {
    conferir(chave + '.registro.existe', !!linha, true);
    const [estado, enviado, aplicado, erro] = esperado;
    conferir(chave + '.registro.estado', linha.estado, estado); conferir(chave + '.registro.enviado', linha.enviado, enviado);
    conferir(chave + '.registro.aplicado', linha.aplicado, aplicado); conferir(chave + '.registro.erro', linha.ultimo_erro ?? null, erro);
    conferir(chave + '.registro.primeira', linha.primeira, tempo.primeira); conferir(chave + '.registro.para', linha.para, f.email);
    conferir(chave + '.registro.chave', linha.chave_ok, true); conferir(chave + '.registro.unico', Number(linha.total), 1);
}
function conferirTela(chave, dto, esperado, f, tempo) {
    conferir(chave + '.tela.estado', dto?.estado, esperado[0]); conferir(chave + '.tela.avisoEnviado', dto?.avisoEnviado, esperado[1]);
    conferir(chave + '.tela.dataRegular', dto?.dataRegular, tempo.primeira); conferir(chave + '.tela.valorRegular', dto?.valorRegular, f.regular);
    conferir(chave + '.tela.ciclo', dto?.ciclo, f.ciclo);
}
/**
 * Asaas depois do preço regular: assinatura com valor regular e próximo vencimento ≥ primeira data regular; 1ª cobrança paga
 * com o valor Fundador (período pago preservado); antes da data regular só valor Fundador; da data em diante só regular.
 */
function divergenciasPrecoRegular(sub, cobrancas, f, tempo, primeiroPagamentoId) {
    const d = [];
    if (!sub || sub.deleted || sub.status !== 'ACTIVE') d.push('assinatura.ativa');
    if (sub?.valorCentavos !== f.regular) d.push('assinatura.valorRegular');
    if (!(typeof sub?.nextDueDate === 'string' && sub.nextDueDate >= tempo.primeira)) d.push('assinatura.proximoVencimento');
    const primeira = cobrancas.find(c => c.id === primeiroPagamentoId);
    if (!primeira || primeira.deleted || !['RECEIVED','CONFIRMED'].includes(primeira.status) || primeira.valorCentavos !== f.fundador) d.push('periodoPago');
    for (const c of cobrancas.filter(x => !x.deleted)) {
        if (c.dueDate < tempo.primeira && c.valorCentavos !== f.fundador) d.push('antes.' + c.dueDate);
        if (c.dueDate >= tempo.primeira && c.valorCentavos !== f.regular) d.push('regular.' + c.dueDate);
    }
    return d;
}
function eventoConfirmacao(f, pagamentoId, assinaturaId, id = randomUUID()) {
    return {id:`hml-renovacao-${f.chave}-${id}`, event:'PAYMENT_CONFIRMED', payment:{id:pagamentoId, subscription:assinaturaId, externalReference:f.empresa}};
}

/**
 * Encerramento idempotente (finally e recuperação). Nunca lança. Por fixture com prova de autoria: remove a assinatura
 * sandbox da referência (ids conferidos). Sem intenção de pagamento → regra Fundador (prova de cobrança removida e não paga)
 * e libera vaga/contratação abertas. Com intenção de pagamento → vaga nunca é tocada (pode estar CONFIRMADA).
 * Banco: desativa usuários (e-mail trocado por marcador), vínculos e empresas das fixtures. Registros de renovação ficam.
 */
async function encerrar({db, conectado, r, p, obterCobranca, salvar}) {
    let erro = null;
    const gravar = () => { try { salvar(); } catch { /* disco indisponível não impede o encerramento */ } };
    const falhar = (etapa, e) => { erro ??= Object.assign(Error('LIMPEZA_' + etapa), {etapa});
        r.falhasEncerramento = [...(r.falhasEncerramento ?? []), {etapa, mensagem:String(e?.message ?? e).slice(0, 120)}]; gravar(); };
    try {
        if (conectado) await db.query('ROLLBACK').catch(() => {});
        const prova = recursosComprovados(r);
        r.encerramento = {inicio:new Date().toISOString(), prova, vagas:{}}; gravar();
        const liberaveis = [];
        for (const f of FIXTURES) {
            if (!prova.assinaturas[f.chave]) { r.encerramento[f.chave] = {acao:'NADA_CRIADO_PELA_RODADA'}; gravar(); continue; }
            try {
                const doBanco = conectado ? (await db.query('SELECT provedor_cliente_id, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0] : null;
                const clienteId = r[f.chave]?.clienteId ?? doBanco?.provedor_cliente_id ?? null;
                const assinaturaId = r[f.chave]?.assinaturaId ?? doBanco?.provedor_assinatura_id ?? null;
                if (r[f.chave]?.assinaturaId && doBanco?.provedor_assinatura_id) assert.equal(doBanco.provedor_assinatura_id, r[f.chave].assinaturaId, 'SUB_DIVERGENTE_DO_BANCO');
                const subs = await p.listarAssinaturasPorReferencia(f.empresa); assert.ok(subs.length <= 1, 'SUB_DUPLICADA');
                for (const sub of subs) {
                    assert.equal(sub.externalReference, f.empresa, 'SUB_DE_OUTRA_REFERENCIA');
                    if (clienteId) assert.equal(sub.customer, clienteId, 'SUB_DE_OUTRO_CLIENTE');
                    if (assinaturaId) assert.equal(sub.id, assinaturaId, 'SUB_DIFERENTE_DA_REGISTRADA');
                }
                const idsSubs = [...new Set([...subs.map(s => s.id), ...(assinaturaId ? [assinaturaId] : [])])];
                const ids = new Set(r[f.chave]?.cobrancas ?? []);
                const pagamentoIntencionado = prova.pagamento[f.chave];
                for (const id of idsSubs) for (const c of await p.listarCobrancasDaAssinatura(id)) {
                    if (!pagamentoIntencionado && pagamentoConhecido(c)) throw Error('COBRANCA_PAGA_OU_DESCONHECIDA');
                    ids.add(c.id);
                }
                r[f.chave] = {...r[f.chave], cobrancas:[...ids]}; gravar();
                for (const sub of subs.filter(s => !s.deleted)) assert.equal((await p.removerAssinatura(sub.id)).removida, true, 'SUB_NAO_REMOVIDA');
                const assinaturas = await Promise.all(idsSubs.map(id => p.obterAssinatura(id)));
                if (pagamentoIntencionado) {
                    // Cobrança paga permanece no Asaas por definição; prova = toda assinatura conhecida removida.
                    const removida = assinaturas.every(a => a === null || a?.deleted === true);
                    r.encerramento[f.chave] = {acao:removida ? 'ASSINATURA_REMOVIDA_VAGA_PRESERVADA' : 'REMOCAO_NAO_COMPROVADA', assinaturas:idsSubs.length}; gravar();
                    if (!removida) throw Error('REMOCAO_NAO_COMPROVADA');
                    continue;
                }
                const comprovado = cancelamentoComprovado({completo:true, assinaturas, cobrancas:await Promise.all([...ids].map(id => obterCobranca(id)))});
                r.encerramento[f.chave] = {acao:comprovado ? 'ASSINATURA_REMOVIDA_COMPROVADA' : 'REMOCAO_NAO_COMPROVADA', assinaturas:idsSubs.length, cobrancas:ids.size}; gravar();
                if (comprovado) liberaveis.push(f); else throw Error('CANCELAMENTO_NAO_COMPROVADO');
            } catch (e) { r.limpezaAssinaturaPendente = true; falhar('ASSINATURA_' + f.chave, e); }
        }
        try {
            if (!prova.fixtures) r.encerramento.fixtures = 'NADA_CRIADO_PELA_RODADA';
            else if (!conectado) throw Error('BANCO_INDISPONIVEL');
            else {
                await db.query('BEGIN');
                for (const f of liberaveis) {
                    const c = await db.query(`UPDATE assinatura_contratacoes SET estado='CANCELADA', cancelada_em=clock_timestamp(), motivo_cancelamento=$2
                        WHERE empresa_id=$1 AND estado='EM_ABERTO'`, [f.empresa, MOTIVO]);
                    const v = await db.query(`UPDATE assinatura_fundadores SET estado='LIBERADA', liberada_em=clock_timestamp(), evidencia_liberacao=$2
                        WHERE empresa_id=$1 AND estado='RESERVADA'`, [f.empresa, MOTIVO]);
                    r.encerramento.vagas[f.chave] = {contratacoesCanceladas:c.rowCount, vagasLiberadas:v.rowCount};
                }
                for (const f of FIXTURES) await db.query('UPDATE usuarios_administrativos SET ativo=false, email=$3 WHERE id=$1 AND email=$2', [f.usuario, f.email, emailEncerrado(f.usuario)]);
                await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.usuario)]);
                await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status<>'DESATIVADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.nome)]);
                await db.query('COMMIT'); r.fixturesDesativadas = true; r.encerramento.fixtures = 'DESATIVADAS';
                r.encerramento.vagasFinais = Object.fromEntries((await db.query('SELECT empresa_id, estado FROM assinatura_fundadores WHERE empresa_id=ANY($1::uuid[])', [IDS_EMPRESAS])).rows
                    .map(x => [FIXTURES.find(f => f.empresa === x.empresa_id)?.chave, x.estado]));
            }
            gravar();
        } catch (e) { if (conectado) await db.query('ROLLBACK').catch(() => {}); r.limpezaBancoPendente = true; falhar('BANCO', e); }
    } catch (e) { falhar('ENCERRAMENTO', e); }
    try { r.encerramento = {...(r.encerramento ?? {}), fim:new Date().toISOString()}; } catch { /* nada */ }
    gravar();
    return erro;
}

/** Cliente Asaas sandbox + leitura de cobrança, confirmação de pagamento e ajuste do próximo vencimento (só fixtures). */
async function provedorSandbox() {
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO');
    const bruto = async (caminho, method = 'GET', body) => {
        assert.match(caminho, /^\/(payments|subscriptions|sandbox\/payment)\/[A-Za-z0-9_-]{1,100}(\/confirm)?$/);
        const res = await fetch(ASAAS + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao', 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status});
        return res.json().catch(() => null);
    };
    const obterCobranca = async id => {
        const j = await bruto('/payments/' + encodeURIComponent(id));
        if (j === null) return null;
        if (!j || j.id !== id || typeof j.status !== 'string') return {id, deleted:false, status:'DESCONHECIDO', paymentDate:null};
        return {id:j.id, deleted:j.deleted === true, status:j.status, paymentDate:typeof j.paymentDate === 'string' ? j.paymentDate : null};
    };
    return {p:criarClienteAsaas(cfg.config), obterCobranca, cfg:cfg.config,
        confirmarPagamento: id => bruto('/sandbox/payment/' + encodeURIComponent(id) + '/confirm', 'POST'),
        ajustarVencimento: (id, data) => { assert.match(data, DATA); return bruto('/subscriptions/' + encodeURIComponent(id), 'PUT', {nextDueDate:data, updatePendingPayments:false}); }};
}

async function campanha(db) {
    return (await db.query(`SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
        count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`)).rows[0];
}
const pausa = ms => new Promise(ok => setTimeout(ok, ms));
/** Trava por empresa ocupada (outra execução/webhook): tenta de novo; qualquer outro erro sobe. */
async function comRetentativa(trabalho, {tentativas = 5, esperar = () => pausa(3000)} = {}) {
    for (let i = 0; ; i++) {
        try { return await trabalho(); }
        catch (e) { if (e?.code === 'CONTRATACAO_EM_ANDAMENTO' && i < tentativas) { await esperar(); continue; } throw e; }
    }
}
const SQL_REGISTROS = `SELECT r.empresa_id, r.estado, r.aviso_enviado_em IS NOT NULL AS enviado, r.preco_aplicado_em IS NOT NULL AS aplicado,
    r.aviso_tentado_em IS NOT NULL AS tentado, r.ultimo_erro, r.primeira_data_regular::text AS primeira, r.primeiro_vencimento::text AS primeiro,
    r.mensagem->>'para' AS para, (r.mensagem->>'idempotencia' = 'kidmais-renovacao/' || r.id::text) AS chave_ok,
    count(*) OVER (PARTITION BY r.empresa_id) AS total FROM assinatura_renovacoes r WHERE r.empresa_id = ANY($1::uuid[])`;

async function recuperar() {
    const opts = alvoEncerramento(process.env);
    exigirDisco();
    assert.ok(fs.existsSync(ARQUIVO), 'SEM_RODADA_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    assert.equal(r.marca, MARCA, 'ESTADO_DE_OUTRA_RODADA');
    assert.ok(!(r.concluido === undefined && processoVivo(r.pid)), 'RODADA_EM_EXECUCAO');
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    r.recuperacoes = [...(r.recuperacoes ?? []), new Date().toISOString()]; salvar();
    const {Client} = require('pg');
    const {p, obterCobranca} = await provedorSandbox();
    const db = new Client(opts); let conectado = false, erro = null;
    try {
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1');
    } catch (e) { conectado = false; erro = e; }
    erro = erroFinal(erro, await encerrar({db, conectado, r, p, obterCobranca, salvar}));
    if (conectado) r.campanhaDepois = await campanha(db).catch(() => null);
    await db.end().catch(() => {});
    r.recuperado = !erro; salvar();
    console.log(JSON.stringify({resultado:erro ? 'ENCERRAMENTO_INCOMPLETO' : 'ENCERRADO', erro:erro ? String(erro.message).slice(0, 80) : null,
        encerramento:r.encerramento ?? null, campanhaAntes:r.campanhaAntes ?? null, campanhaDepois:r.campanhaDepois ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

async function main() {
    const opts = alvo(process.env);
    if (MODO_EMAIL === 'RESEND') assert.ok(process.env.EMAIL_PROVIDER === 'resend' && process.env.RESEND_API_KEY && process.env.EMAIL_REMETENTE === REMETENTE_TESTE, 'EMAIL_RESEND_NAO_CONFIGURADO_S1');
    assert.ok(horaBrasil(new Date()) < 22, 'HORARIO_S1'); // sem virada de dia durante a rodada (~20 min)
    const {Pool} = require('pg');
    const {criarHashSenha} = await import('../lib/autenticacao/senha.ts');
    const {processarRenovacao} = await import('../lib/assinatura/renovacao-fundador.ts');
    const {repositorioRenovacao} = await import('../lib/assinatura/renovacao-repositorio.ts');
    const {travaPorEmpresa} = await import('../lib/assinatura/cobranca.ts');
    const {criarEnviarEmail} = await import('../lib/acessos/email.ts');
    const {p, obterCobranca, cfg, confirmarPagamento, ajustarVencimento} = await provedorSandbox();
    exigirDisco();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    assert.ok(!fs.existsSync(ARQUIVO), 'RODADA_EXISTENTE_S1');
    const r = {marca:MARCA, inicio:new Date().toISOString(), pid:process.pid, modoEmail:MODO_EMAIL, etapas:[], resultados:{}, tempo:{}};
    fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    const pool = new Pool({...opts, max:5}); pool.on('error', () => undefined);
    let db = null, conectado = false, erro, etapa = 'PRECHECK';
    const marcar = e => { etapa = e; r.etapas.push(e); salvar(); };
    const senhas = new Map(FIXTURES.map(f => [f.chave, 'Sintetica-' + randomBytes(24).toString('hex')])); // só em memória
    const transacao = async trabalho => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='30s'"); await c.query("SET LOCAL lock_timeout='5s'");
            const x = await trabalho(c); await c.query('COMMIT'); return x; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    };
    const esc = escopo();
    const contagem = {}, perder = new Set(), envios = Object.fromEntries(FIXTURES.map(f => [f.chave, []]));
    const resend = MODO_EMAIL === 'RESEND' ? fetchResendRestrito(fetch) : null;
    const transporte = f => f.chave === 'RF' ? envioFalho(envios.RF)
        : resend && f.chave === 'RM' ? async m => { envios.RM.push(m.idempotencia); return criarEnviarEmail(process.env, resend)(m); }
        : envioSink(envios[f.chave]);
    const deps = {repositorio:repositorioRestrito(repositorioRenovacao(transacao), esc), provedor:provedorRestrito(p, esc, {perderRespostaPreco:perder, contagem}),
        origem:BASE, simular:false, travar:travaPorEmpresa(transacao)};
    const rodar = async (f, quando) => {
        const t = r.tempo[f.chave], agora = relogio(t ? t.offsets[quando] : 0);
        conferir(f.chave + '.dia.' + quando, diaBrasil(agora()), t ? t.dias[quando] : diaBrasil(new Date()));
        try { return await comRetentativa(() => processarRenovacao(esc.empresa(f.empresa), {...deps, enviar:envioDaFixture(f, transporte(f)), agora})); }
        catch (e) {
            if (e?.parada) throw e;
            r.errosReprocessaveis = [...(r.errosReprocessaveis ?? []), {chave:f.chave, quando, mensagem:String(e?.message ?? e).slice(0, 60)}];
            return 'ERRO_REPROCESSAVEL';
        }
    };
    const registros = async () => Object.fromEntries((await db.query(SQL_REGISTROS, [IDS_EMPRESAS])).rows.map(x => [FIXTURES.find(f => f.empresa === x.empresa_id).chave, x]));
    const sessao = f => {
        const jar = new Map();
        const pedir = async (caminho, method = 'GET', body, extras = {}) => {
            assert.ok(caminho.startsWith('/api/admin/'));
            const res = await fetch(BASE + caminho, {method, redirect:'error', signal:AbortSignal.timeout(60000),
                headers:{Cookie:[...jar].map(([k, v]) => k + '=' + v).join(';'), 'Content-Type':'application/json', ...extras}, ...(body ? {body:JSON.stringify(body)} : {})});
            cookies(res.headers, jar); const j = await res.json().catch(() => ({})); return {status:res.status, j};
        };
        const post = async (caminho, body) => { const s = (await pedir('/api/admin/autenticacao')).j.data ?? {};
            return pedir(caminho, 'POST', body, {Origin:BASE, 'x-csrf-token':s.csrf ?? '', ...(s.sessaoId ? {'x-kidmais-sessao':s.sessaoId} : {})}); };
        return {pedir, post, entrar: async () => {
            assert.equal((await post('/api/admin/autenticacao', {acao:'login', email:f.email, senha:senhas.get(f.chave)})).status, 200, 'LOGIN_' + f.chave);
            assert.equal((await post('/api/admin/autenticacao', {acao:'selecionar-empresa', empresaId:f.empresa})).status, 200, 'EMPRESA_' + f.chave);
        }};
    };
    const preservacao = async () => {
        const hashes = {};
        for (const [tabela, coluna, volateis] of PRESERVADAS) {
            const linhas = (await db.query(sqlPreservacao(tabela, coluna, volateis), [IDS_EMPRESAS])).rows.map(x => x.linha);
            hashes[tabela] = createHash('sha256').update(JSON.stringify(linhas)).digest('hex');
        }
        return hashes;
    };
    const kidmaisPublico = async () => {
        const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const i = d.toISOString().slice(0, 10); d.setUTCMonth(d.getUTCMonth() + 1, 0);
        const [pac, ag] = await Promise.all(['/api/fechamentos/pacotes', `/api/disponibilidade?inicio=${i}&fim=${d.toISOString().slice(0, 10)}`]
            .map(c => fetch(BASE + c, {redirect:'manual', signal:AbortSignal.timeout(60000)}).then(async x => ({status:x.status, j:await x.json().catch(() => null)}))));
        assert.equal(pac.status, 200, 'KIDMAIS_PACOTES'); assert.equal(ag.status, 200, 'KIDMAIS_AGENDA');
        const h = v => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
        return {pacotes:h(pac.j), agenda:h(projecaoAgenda(ag.j))};
    };
    const s = Object.fromEntries(FIXTURES.map(f => [f.chave, sessao(f)]));
    const tela = async f => { const x = await s[f.chave].pedir('/api/admin/assinatura'); conferir(f.chave + '.tela.status', x.status, 200); return x.j.data; };
    const etapaRodada = async rodada => {
        marcar(rodada.id); const obtidos = {};
        for (const f of FIXTURES.filter(x => rodada.quando[x.chave])) {
            // R2/RM: duas execuções simultâneas; a trava por empresa e o registro garantem um único envio.
            obtidos[f.chave] = rodada.id === 'R2' && f.chave === 'RM'
                ? (await Promise.all([rodar(f, 'LIMITE'), rodar(f, 'LIMITE')])).reduce((a, b) => { conferir('RM.R2.concorrente', b, a); return a; })
                : await rodar(f, rodada.quando[f.chave]);
            r.resultados[rodada.id] = {...(r.resultados[rodada.id] ?? {}), [f.chave]:obtidos[f.chave]}; salvar();
            conferirResultado(f.chave + '.' + rodada.id, obtidos[f.chave], rodada.esperado[f.chave]);
        }
        if (REGISTROS[rodada.id]) { const linhas = await registros();
            for (const f of FIXTURES) conferirRegistro(f.chave, linhas[f.chave], REGISTROS[rodada.id][f.chave], f, r.tempo[f.chave]); }
        if (TELAS[rodada.id]) for (const f of FIXTURES) conferirTela(f.chave, (await tela(f)).renovacao, TELAS[rodada.id][f.chave], f, r.tempo[f.chave]);
    };
    try {
        // ---- S1: alvo, conexão, schema 074/075, fixtures e referências livres, vagas livres sem tocar no teto.
        db = await pool.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        r.conexao = conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1'); salvar();
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_fundadores') IS NOT NULL AND to_regclass('public.assinatura_renovacoes') IS NOT NULL
            AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.assinatura_renovacoes') AND NOT tgisinternal AND tgenabled = 'O') = 2 AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR lower(btrim(email))=ANY($4::text[]) OR lower(btrim(email))=ANY($5::text[])) AS ocupado`,
            [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email), FIXTURES.map(f => emailEncerrado(f.usuario))])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        r.campanhaAntes = await campanha(db); salvar();
        if (!cabeNaCampanha(r.campanhaAntes)) throw Object.assign(Error('FUNDADOR_SEM_VAGAS_S4'), {parada:'S4'});
        r.precheck = {fixturesLivres:true, asaasLivre:{}}; salvar();
        for (const f of FIXTURES) {
            assert.equal(await p.buscarClientePorReferencia(f.empresa), null, 'CLIENTE_ASAAS_PREEXISTENTE_S1');
            assert.equal((await p.listarAssinaturasPorReferencia(f.empresa)).length, 0, 'ASSINATURA_ASAAS_PREEXISTENTE_S1');
            r.precheck.asaasLivre[f.chave] = true; salvar();
        }
        r.antes = await preservacao(); r.kidmaisAntes = await kidmaisPublico(); salvar();

        // ---- Fixtures (uma transação): empresas com teste encerrado, prontas para assinar.
        marcar('FIXTURES'); r.intencaoFixture = true; salvar(); await db.query('BEGIN');
        for (const f of FIXTURES) {
            let doc; do { doc = documento(); } while (doc === KIDMAIS_CNPJ
                || (await db.query('SELECT 1 FROM assinatura_fundadores WHERE documento_beneficiario=$1 UNION ALL SELECT 1 FROM empresa_assinaturas WHERE documento_teste=$1', [doc])).rowCount);
            await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
            await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Renovação',$3,'REPRESENTANTE_AUTORIZADO',true)",
                [f.usuario, f.email, await criarHashSenha(senhas.get(f.chave))]);
            await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.usuario]);
            await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)", [f.empresa, doc]);
        }
        await db.query('COMMIT'); r.fixture = true; salvar();

        // ---- Checkout Fundador pela API, pagamento confirmado no sandbox e evento entregue à rota do webhook.
        for (const f of FIXTURES) await s[f.chave].entrar();
        for (const f of FIXTURES) {
            marcar('CHECKOUT_' + f.chave);
            const o = (await tela(f)).ofertas;
            conferir(f.chave + '.fundador', o?.fundador, true); conferir(f.chave + '.aguardandoVaga', o?.aguardandoVaga, false);
            const oferta = o.planos.find(x => x.id === f.plano), anual = f.ciclo === 'ANUAL';
            conferir(f.chave + '.precoRegular', anual ? oferta?.anualRegular : oferta?.mensalRegular, f.regular);
            conferir(f.chave + '.precoFundador', anual ? oferta?.anual : oferta?.mensal, f.fundador);
            r[f.chave] = {intencaoCheckout:true}; salvar(); // prova de autoria ANTES do checkout
            conferir(f.chave + '.checkout', (await s[f.chave].post('/api/admin/assinatura/checkout', {plano:f.plano, ciclo:f.ciclo, valorEsperadoCentavos:f.fundador, versao:o.versao})).status, 200);
            const linha = (await db.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0];
            Object.assign(r[f.chave], {clienteId:linha.provedor_cliente_id, assinaturaId:linha.provedor_assinatura_id}); salvar();
            esc.vincular(f.empresa, linha.provedor_assinatura_id);
            const sub = await p.obterAssinatura(linha.provedor_assinatura_id);
            conferir(f.chave + '.asaas.referencia', sub?.externalReference, f.empresa); conferir(f.chave + '.asaas.valor', sub?.valorCentavos, f.fundador);
            const cobrancas = (await p.listarCobrancasDaAssinatura(sub.id)).filter(c => !c.deleted);
            r[f.chave].cobrancas = cobrancas.map(c => c.id); salvar();
            conferir(f.chave + '.asaas.cobrancas', cobrancas.length, 1); conferir(f.chave + '.asaas.pendente', cobrancas[0].status, 'PENDING');
            conferir(f.chave + '.asaas.vencimentoHoje', cobrancas[0].dueDate, diaBrasil(new Date()));
            r[f.chave].pagamentoId = cobrancas[0].id; r[f.chave].intencaoPagamento = true; salvar(); // daqui em diante a vaga pode ficar CONFIRMADA
            await confirmarPagamento(r[f.chave].pagamentoId);
            let pago; for (let i = 0; i < 20; i++) { pago = await p.obterCobranca(r[f.chave].pagamentoId); if (['RECEIVED','CONFIRMED'].includes(pago?.status)) break; await pausa(1500); }
            conferir(f.chave + '.asaas.pago', ['RECEIVED','CONFIRMED'].includes(pago?.status), true);
            const ev = eventoConfirmacao(f, r[f.chave].pagamentoId, sub.id);
            const entrega = await fetch(BASE + ROTA_WEBHOOK, {method:'POST', redirect:'error', signal:AbortSignal.timeout(60000),
                headers:{'Content-Type':'application/json', 'asaas-access-token':cfg.webhookToken}, body:JSON.stringify(ev)});
            conferir(f.chave + '.webhook', entrega.status, 200);
            let c; for (let i = 0; i < 120; i++) {
                c = (await db.query(`SELECT c.estado, v.estado AS vaga, a.situacao, to_char(v.beneficio_fim AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fim
                    FROM assinatura_contratacoes c JOIN assinatura_fundadores v ON v.id=c.fundador_id AND v.empresa_id=c.empresa_id
                    JOIN empresa_assinaturas a ON a.empresa_id=c.empresa_id AND a.contratacao_atual_id=c.id WHERE c.empresa_id=$1`, [f.empresa])).rows[0];
                if (c?.estado === 'CONFIRMADA') break; await pausa(1500);
            }
            conferir(f.chave + '.contratacao', c?.estado, 'CONFIRMADA'); conferir(f.chave + '.vaga', c?.vaga, 'CONFIRMADA'); conferir(f.chave + '.situacao', c?.situacao, 'ATIVA');
            r[f.chave].vagaConfirmada = true; r[f.chave].primeiroVencimento = cobrancas[0].dueDate; r[f.chave].beneficioFim = c.fim; salvar();
            conferir(f.chave + '.beneficio12meses', c.fim.slice(0, 10) >= somarMeses(cobrancas[0].dueDate, 12), true);
            r.tempo[f.chave] = planoTempo(diaBrasil(new Date()), primeiraEsperada(cobrancas[0].dueDate, c.fim, f.ciclo)); salvar();
        }
        marcar('CAMPANHA_CONFIRMADA'); r.campanhaConfirmada = await campanha(db);
        conferir('campanha.confirmadas', r.campanhaConfirmada.confirmadas, r.campanhaAntes.confirmadas + FIXTURES.length);
        conferir('campanha.ocupadas', r.campanhaConfirmada.ocupadas, r.campanhaAntes.ocupadas + FIXTURES.length);

        // ---- Processador, só fixtures. R0–R1: registro persistido e nada enviado antes do limite.
        for (const rodada of RODADAS.slice(0, 3)) await etapaRodada(rodada);
        for (const f of FIXTURES) conferir(f.chave + '.semEnvioAntesDoLimite', envios[f.chave].length, 0);
        // Tenant: a sessão de RM não lê a renovação de RA.
        const cruzada = await s.RM.pedir('/api/admin/assinatura?empresaId=' + FIXTURES[1].empresa);
        conferir('tenant.cruzado', cruzada.status === 200 && cruzada.j?.data?.renovacao?.ciclo === 'ANUAL', false);
        // R2: aviso no limite (RM concorrente; RA perde a resposta do PUT de preço; RF falha antes da rede).
        perder.add(r.RA.assinaturaId);
        await etapaRodada(RODADAS[3]);
        conferir('R2.erros', JSON.stringify((r.errosReprocessaveis ?? []).map(e => [e.chave, e.mensagem])), JSON.stringify([['RA','RESPOSTA_PERDIDA_SIMULADA']]));
        conferir('RA.precoAplicadoNoProvedor', (await p.obterAssinatura(r.RA.assinaturaId))?.valorCentavos, FIXTURES[1].regular);
        // R3: retomadas. RM aguarda a última parcela Fundador sem aumento; RA conclui sem 2º PUT; RF perde a janela.
        await etapaRodada(RODADAS[4]);
        for (const f of [FIXTURES[0], FIXTURES[2]]) {
            const sub = await p.obterAssinatura(r[f.chave].assinaturaId);
            conferir(f.chave + '.semAumentoAntecipado', sub?.valorCentavos, f.fundador);
            conferir(f.chave + '.vencimentoAntesDaRegular', sub?.nextDueDate < r.tempo[f.chave].primeira, true);
        }
        // ---- Salto do próximo vencimento SÓ nas assinaturas sandbox mensais das fixtures (meses 2–12 não gerados).
        marcar('SALTO_VENCIMENTO');
        for (const f of [FIXTURES[0], FIXTURES[2]]) {
            const antes = await p.obterAssinatura(esc.assinatura(r[f.chave].assinaturaId));
            conferir(f.chave + '.salto.referencia', antes?.externalReference, f.empresa);
            r[f.chave].intencaoSalto = true; salvar();
            await ajustarVencimento(antes.id, r.tempo[f.chave].primeira);
            const depois = await p.obterAssinatura(antes.id);
            conferir(f.chave + '.salto.vencimento', depois?.nextDueDate >= r.tempo[f.chave].primeira, true);
            conferir(f.chave + '.salto.valor', depois?.valorCentavos, f.fundador);
        }
        // R4–R5: preço regular (RM), retomada idempotente (RA), revisão com geração suspensa e sem aumento (RF).
        await etapaRodada(RODADAS[5]); await etapaRodada(RODADAS[6]);
        for (const f of FIXTURES.slice(0, 2)) {
            const sub = await p.obterAssinatura(r[f.chave].assinaturaId), cobrancas = await p.listarCobrancasDaAssinatura(sub.id);
            const d = divergenciasPrecoRegular(sub, cobrancas, f, r.tempo[f.chave], r[f.chave].pagamentoId);
            r.resultados['ASAAS_' + f.chave] = d.length ? d : 'PRECO_REGULAR_NA_DATA'; salvar();
            conferir(f.chave + '.asaas.precoRegular', d.length, 0);
        }
        const rf = await p.obterAssinatura(r.RF.assinaturaId);
        conferir('RF.suspensa', rf?.status, 'INACTIVE'); conferir('RF.semAumento', rf?.valorCentavos, FIXTURES[2].fundador);
        conferir('RA.umPut', contagem.precoAssinatura?.[r.RA.assinaturaId], 1); conferir('RM.umPut', contagem.precoAssinatura?.[r.RM.assinaturaId], 1);
        conferir('RF.semPut', contagem.precoAssinatura?.[r.RF.assinaturaId], undefined);
        conferir('RF.umaSuspensao', contagem.suspensao?.[r.RF.assinaturaId], 1); conferir('RM.semSuspensao', contagem.suspensao?.[r.RM.assinaturaId], undefined);
        for (const f of FIXTURES) conferir(f.chave + '.envios', envios[f.chave].length, ENVIOS[f.chave]);
        if (resend) conferir('resend.requisicoes', resend.requisicoes(), 1);

        // ---- Cancelamento pela tela (Gestão, senha reconfirmada): acesso pago preservado; processador encerra a renovação.
        marcar('CANCELAMENTO');
        for (const f of FIXTURES.slice(0, 2)) {
            conferir(f.chave + '.reautenticar', (await s[f.chave].post('/api/admin/autenticacao', {acao:'reautenticar', senha:senhas.get(f.chave)})).status, 200);
            conferir(f.chave + '.cancelamento', (await s[f.chave].post('/api/admin/assinatura/cancelamento', {confirmar:true})).status, 200);
            conferir(f.chave + '.periodoPago', (await tela(f)).acesso?.nivel, 'COMPLETO');
            conferir(f.chave + '.primeiraPagaPreservada', ['RECEIVED','CONFIRMED'].includes((await p.obterCobranca(r[f.chave].pagamentoId))?.status), true);
        }
        await etapaRodada(RODADAS[7]);
        for (const f of FIXTURES) conferir(f.chave + '.enviosFinais', envios[f.chave].length, ENVIOS[f.chave]);

        // ---- Escopo, campanha (vagas confirmadas permanecem), terceiros e Kidmais intactos.
        marcar('PRESERVACAO');
        r.escopo = {empresas:Object.keys(esc.uso).map(id => FIXTURES.find(f => f.empresa === id)?.chave ?? 'FORA'), contagem};
        conferir('escopo.soFixtures', r.escopo.empresas.every(k => k !== 'FORA'), true);
        r.kidmaisDepois = await kidmaisPublico();
        conferir('kidmais.pacotes', r.kidmaisDepois.pacotes, r.kidmaisAntes.pacotes); conferir('kidmais.agenda', r.kidmaisDepois.agenda, r.kidmaisAntes.agenda);
        r.depois = await preservacao();
        for (const [tabela] of PRESERVADAS) if (r.depois[tabela] !== r.antes[tabela]) throw Object.assign(Error('PRESERVACAO_S3'), {parada:'S3', tabela});
        r.aprovado = true; salvar();
    } catch (e) {
        erro = e ?? Error('FALHA_DESCONHECIDA');
        r.falha = {etapa, parada:e?.parada ?? null, item:e?.item ?? e?.tabela ?? null, obtido:e?.obtido ?? null, esperado:e?.esperado ?? null,
            mensagem:String(e?.message ?? e).slice(0, 120)};
        try { salvar(); } catch { /* o encerramento roda mesmo sem gravar o estado */ }
        console.error(JSON.stringify(r.falha));
    } finally {
        erro = erroFinal(erro, await encerrar({db, conectado, r, p, obterCobranca, salvar}));
        if (conectado) {
            r.campanhaDepois = await campanha(db).catch(() => null);
            r.depoisEncerramento = await preservacao().catch(() => null);
            if (r.depoisEncerramento && r.antes && PRESERVADAS.some(([t]) => r.depoisEncerramento[t] !== r.antes[t]))
                erro = erroFinal(erro, Object.assign(Error('PRESERVACAO_APOS_ENCERRAMENTO'), {parada:'S3'}));
        }
        db?.release(); await pool.end().catch(() => {});
    }
    r.concluido = !erro; try { salvar(); } catch { /* idem */ }
    console.log(JSON.stringify({resultado:erro ? 'INCOMPLETO' : 'PASS', falha:r.falha ?? null, erro:erro ? String(erro.message).slice(0, 80) : null,
        modoEmail:MODO_EMAIL, tempo:r.tempo, resultados:r.resultados, campanhaAntes:r.campanhaAntes ?? null, campanhaConfirmada:r.campanhaConfirmada ?? null,
        campanhaDepois:r.campanhaDepois ?? null, encerramento:r.encerramento ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

// RASCUNHO SUBSTITUÍDO por scripts/homologacao-pagamento-renovacao-staging.cjs (docs/HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md).
// Mantido só como histórico e referência dos testes: nenhuma flag executa.
if (require.main === module && process.argv.slice(2).some(a => a.startsWith('--'))) {
    console.error('RASCUNHO_SUBSTITUIDO'); process.exitCode = 1;
} else if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'RODADA') main().catch(e => { console.error('HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES ' + String(e?.message ?? '').slice(0, 60)); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_RENOVACAO'); process.exitCode = 1; }
}
module.exports = {FIXTURES, PRECOS, PRESERVADAS, RODADAS, REGISTROS, TELAS, ENVIOS, MARCA, FLAG, FLAG_ENCERRAR, ARQUIVO, MOTIVO, MODO_EMAIL,
    DESTINO_AUTORIZADO, REMETENTE_TESTE, VAGAS_CAMPANHA, alvo, alvoEncerramento, modo, conferir, cabeNaCampanha, emailDe, emailEncerrado,
    diaBrasil, horaBrasil, somarDias, somarMeses, diasEntre, primeiraEsperada, planoTempo, relogio, escopo, repositorioRestrito, provedorRestrito,
    idSink, envioSink, envioFalho, fetchResendRestrito, envioDaFixture, recursosComprovados, conferirRegistro, conferirTela,
    divergenciasPrecoRegular, eventoConfirmacao, encerrar, conferirResultado, comRetentativa, SQL_REGISTROS};
