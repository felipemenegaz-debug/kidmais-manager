/* eslint-disable @typescript-eslint/no-require-imports */
// Rodada 3 consolidada de 10/10/2026 — pagamento + renovação Fundador nas MESMAS três empresas pagantes
// (docs/HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md). PREPARADO, NÃO EXECUTADO. Executar SOMENTE no Web Shell do
// srv-daif418ae00c73e8k2gg, depois da aprovação explícita de Felipe, com a flag única --pagamento-renovacao-rodada-3-autorizada.
// Recuperação: --encerrar-pagamento-renovacao-rodada-3-autorizada. Substitui os rascunhos homologacao-pagamento-staging.cjs e
// homologacao-renovacao-staging.cjs (mantidos como histórico): 3 vagas Fundador ficam CONFIRMADAS para sempre, não 6.
// Tempo acelerado só no `agora` injetado em processarRenovacao (relogioReal = relógio verdadeiro, contrato G1) e só para as
// três pagantes. E-mail só SINK. Ajuste de vencimento só no Asaas sandbox e só nas assinaturas registradas pela rodada.
// Escreve só nas fixtures; nunca apaga linha; vaga, contratação e renovação só pelas funções do produto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {alvo: alvoEnsaio, documento, cookies, prepararWebhook} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');
const {sqlPreservacao, processoVivo, erroFinal, projecaoAgenda, cpfSintetico} = require('./homologacao-planos-cotacao-staging.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const URL_WEBHOOK = BASE + '/api/integracoes/asaas/webhook';
const ASAAS = 'https://api-sandbox.asaas.com/v3';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ARQUIVO = DIR + '/pagamento-renovacao-rodada-3.json';
const MARCA = 'homologacao-pagamento-renovacao-20261010-r3';
const FLAG = '--pagamento-renovacao-rodada-3-autorizada';
const FLAG_ENCERRAR = '--encerrar-pagamento-renovacao-rodada-3-autorizada';
const KIDMAIS_CNPJ = '20119900000160';
const VAGAS_CAMPANHA = 20;
const DIA_MS = 86400000;
/** Só SINK: nenhum e-mail sai do processo (id sintético). Envio real exige outro pacote e outra aprovação. */
const MODO_EMAIL = 'SINK';
/** Início antes das 20h BRT: a rodada (~30 min) termina antes da virada do dia e da borda UTC do benefício (21h BRT). */
const HORA_LIMITE_BRT = 20;
/** Centavos fixados aqui (independentes do código): regular e com 40% Fundador. Anual = 10 × mensal. */
const PRECOS = Object.freeze({
    'essencial/MENSAL': Object.freeze({regular:19700, fundador:11820}),
    'profissional/ANUAL': Object.freeze({regular:397000, fundador:238200}),
    'premium/MENSAL': Object.freeze({regular:69700, fundador:41820}),
});
/** Faixa única do pacote das fixtures: 20–30 convidados, valor fixo. */
const FAIXA_POCKET = Object.freeze({min:20, max:30, valor:'1500.00'});
/** Valor esperado em centavos, independente do sistema: faixa fixa e desconto da forma de pagamento (meio centavo para cima). */
function precoEsperado(descontoPercentual) {
    assert.ok(Number.isInteger(descontoPercentual) && descontoPercentual >= 0 && descontoPercentual <= 100);
    return Math.floor((Number(FAIXA_POCKET.valor.replace('.', '')) * (100 - descontoPercentual) + 50) / 100);
}
/**
 * Três pagantes compartilhadas por pagamento e renovação (uma vaga cada) + isenta e teste (sem vaga):
 *  F1 Essencial MENSAL  — plano com financeiro bloqueado; renovação: falha de entrega → REVISAO → geração suspensa sem aumento.
 *  F2 Profissional ANUAL — cotação/contrato sem regra (0%); renovação anual: resposta perdida no PUT de preço → sem 2º PUT.
 *  F5 Premium MENSAL    — contrato com regra 8%; renovação mensal completa: resposta perdida do e-mail → retentativa com a
 *                         mesma chave (G1), envio concorrente → 1 e-mail, salto do vencimento no sandbox, preço regular, cancelamento.
 */
const FIXTURES = Object.freeze([
    {chave:'F1', empresa:'1d56ada8-d35e-4afd-a2e0-946b8e1bba05', usuario:'aa17eb45-58a3-486c-b711-8e5106104483', codigo:'hml-pr-essencial', tipo:'PLANO', plano:'essencial', ciclo:'MENSAL', catalogo:true},
    {chave:'F2', empresa:'d4ca9a48-9c7d-4855-9d2f-de498c413e29', usuario:'2f477463-1b40-4738-88cb-71208e0fc230', codigo:'hml-pr-profissional', tipo:'PLANO', plano:'profissional', ciclo:'ANUAL', catalogo:true},
    {chave:'F3', empresa:'5cf7409e-6f99-4350-a816-c6555285ebae', usuario:'71ce36b7-8732-4355-baaa-929975537cd2', codigo:'hml-pr-isenta', tipo:'ISENTA', plano:null, ciclo:null, catalogo:false},
    {chave:'F4', empresa:'111866d0-df82-479e-a39d-79c6927aa42e', usuario:'e90a5e92-b091-4c25-bd19-0c024feeac0a', codigo:'hml-pr-teste', tipo:'TESTE', plano:null, ciclo:null, catalogo:true},
    {chave:'F5', empresa:'43e76c7e-b628-4d1c-9953-7aa6b72f3f65', usuario:'aed63f4b-2a32-44df-90ab-c10eb2d9c5be', codigo:'hml-pr-premium', tipo:'PLANO', plano:'premium', ciclo:'MENSAL', catalogo:true},
].map(f => Object.freeze({...f, ...(f.plano ? PRECOS[f.plano + '/' + f.ciclo] : {}), email:`hml-pr-${f.usuario.slice(0, 8)}@example.invalid`,
    nome:`TESTE Kidmais — pagamento e renovação staging 20261010 r3 ${f.chave}`})));
const PAGANTES = FIXTURES.filter(f => f.tipo === 'PLANO');
const IDS_EMPRESAS = FIXTURES.map(f => f.empresa);
const porChave = Object.fromEntries(FIXTURES.map(f => [f.chave, f]));
/** Regras de desconto (077) só nas fixtures: F2 sem regra (0%), F4 PIX à vista 5%, F5 PIX à vista 8%; Kidmais 10% legado. */
const REGRAS = Object.freeze({
    F4: Object.freeze({pixAvista:5, pixParcelado:2, cartao:'Cartão homologação', diaUtil:false}),
    F5: Object.freeze({pixAvista:8, pixParcelado:4, cartao:'Cartão homologação', diaUtil:false}),
});
const LIMITE_PESSOAS = Object.freeze({essencial:3, profissional:10, premium:null});
/** Matriz do financeiro (status HTTP esperado). */
const FINANCEIRO = Object.freeze({
    F1: {contasPagar:403, criarConta:403, fluxo:403, relatorios:403, completo:false, receber:200},
    F2: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F3: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F4: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F5: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
});

/**
 * Renovação, por rodada do processador (instante → resultado). REAL = relógio verdadeiro; VESPERA/LIMITE/PERDIDO = véspera,
 * dia e dia seguinte ao limite do aviso (primeira data regular − 30), deslocados só no processo. `concorrente` = duas execuções.
 */
const RODADAS = Object.freeze([
    {id:'R0', quando:{F1:'REAL', F2:'REAL', F5:'REAL'}, esperado:{F1:'AGUARDANDO_AVISO', F2:'AGUARDANDO_AVISO', F5:'AGUARDANDO_AVISO'}},
    {id:'R0B', quando:{F1:'REAL', F2:'REAL', F5:'REAL'}, esperado:{F1:'AGUARDANDO_AVISO', F2:'AGUARDANDO_AVISO', F5:'AGUARDANDO_AVISO'}},
    {id:'R1', quando:{F1:'VESPERA', F2:'VESPERA', F5:'VESPERA'}, esperado:{F1:'AGUARDANDO_AVISO', F2:'AGUARDANDO_AVISO', F5:'AGUARDANDO_AVISO'}},
    // R2: F1 falha antes de entregar; F2 envia e perde a resposta do PUT de preço; F5 entrega e perde a resposta do envio.
    {id:'R2', quando:{F1:'LIMITE', F2:'LIMITE', F5:'LIMITE'}, esperado:{F1:'ENVIO_INCERTO', F2:'ERRO_REPROCESSAVEL', F5:'ENVIO_INCERTO'}},
    // R3: F1 perde a janela; F2 conclui sem 2º PUT; F5 em duas execuções simultâneas: retentativa com a mesma chave (G1) e nada mais.
    {id:'R3', quando:{F1:'PERDIDO', F2:'LIMITE', F5:'LIMITE'}, concorrente:'F5', esperado:{F1:'JANELA_AVISO_PERDIDA', F2:'REGULAR', F5:'AGUARDANDO_ULTIMA_PARCELA'}},
    {id:'R4', quando:{F1:'LIMITE', F2:'LIMITE', F5:'LIMITE'}, esperado:{F1:'JANELA_AVISO_PERDIDA', F2:'REGULAR', F5:'REGULAR'}},
    // R5/F1: o cron de reconciliação pode ter sincronizado a suspensão entre R4 e R5; os dois retornos mantêm a revisão.
    {id:'R5', quando:{F1:'LIMITE', F2:'LIMITE', F5:'LIMITE'}, esperado:{F1:['JANELA_AVISO_PERDIDA','REVISAO_NECESSARIA'], F2:'REGULAR', F5:'REGULAR'}},
    // R6: depois do cancelamento pela tela de F2 e F5. F1 (suspensa, em revisão) não é cancelada pela tela; sai no encerramento.
    {id:'R6', quando:{F2:'REAL', F5:'REAL'}, esperado:{F2:'CANCELADA', F5:'CANCELADA'}},
]);
/** assinatura_renovacoes depois da rodada: [estado, avisoEnviado, precoAplicado, ultimoErro, avisoTentado]. */
const REGISTROS = Object.freeze({
    R0:{F1:['PENDENTE',false,false,null,false], F2:['PENDENTE',false,false,null,false], F5:['PENDENTE',false,false,null,false]},
    R2:{F1:['AVISANDO',false,false,'ENVIO_INCERTO',true], F2:['APLICANDO',true,false,null,true], F5:['AVISANDO',false,false,'ENVIO_INCERTO',true]},
    R3:{F1:['REVISAO',false,false,'JANELA_AVISO_PERDIDA',true], F2:['REGULAR',true,true,null,true], F5:['AVISADA',true,false,null,true]},
    R5:{F1:['REVISAO',false,false,'JANELA_AVISO_PERDIDA',true], F2:['REGULAR',true,true,null,true], F5:['REGULAR',true,true,null,true]},
    R6:{F1:['REVISAO',false,false,'JANELA_AVISO_PERDIDA',true], F2:['CANCELADA',true,true,null,true], F5:['CANCELADA',true,true,null,true]},
});
/** DTO da tela (GET /api/admin/assinatura → data.renovacao): [estado, avisoEnviado]. */
const TELAS = Object.freeze({
    R0:{F1:['PENDENTE',false], F2:['PENDENTE',false], F5:['PENDENTE',false]},
    R3:{F1:['REVISAO',false], F2:['REGULAR',true], F5:['AVISADA',true]},
    R5:{F1:['REVISAO',false], F2:['REGULAR',true], F5:['REGULAR',true]},
    R6:{F1:['REVISAO',false], F2:['CANCELADA',true], F5:['CANCELADA',true]},
});
/** Transporte SINK por fixture e contagem final: tentativas que chegaram ao transporte e e-mails distintos entregues. */
const EMAIL = Object.freeze({F1:Object.freeze({falharAntes:true}), F2:Object.freeze({}), F5:Object.freeze({perderRespostas:1})});
const TENTATIVAS = Object.freeze({F1:1, F2:1, F5:2});
const ENTREGAS = Object.freeze({F1:0, F2:1, F5:1});

/** Comparadas antes/depois, sempre SEM as fixtures. Colunas voláteis do cron fora (como no ensaio de 09/10). */
const PRESERVADAS = Object.freeze([
    ['empresas', 'id', []], ['memberships', 'empresa_id', []],
    ['empresa_assinaturas', 'empresa_id', ['sincronizado_em','atualizado_em','versao']],
    ['assinatura_contratacoes', 'empresa_id', []], ['assinatura_fundadores', 'empresa_id', []], ['assinatura_isencoes', 'empresa_id', []],
    ['assinatura_renovacoes', 'empresa_id', []], ['clientes', 'empresa_id', []], ['fechamentos', 'empresa_id', []], ['pacotes', 'empresa_id', []],
    ['financeiro_categorias', 'empresa_id', []], ['financeiro_contas_pagar', 'empresa_id', []],
    ['empresa_regras_pagamento', 'empresa_id', []], // inclui a regra legada da Kidmais (077)
]);

/** Guardas do ensaio de 09/10 (inclui ASSINATURA_PLANOS_ATIVOS) + cotação pública por empresa ligada. */
function alvo(env) {
    const opcoes = alvoEnsaio(env);
    assert.equal(env.COTACAO_PUBLICA_POR_EMPRESA, 'true', 'CHAVE_COTACAO_AUSENTE');
    return opcoes;
}
/** Recuperação: mesmo alvo, sem exigir as chaves (P4 pode já tê-las removido). */
function alvoEncerramento(env) { return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'}); }
function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1 || argv.length !== 1) return null;
    return flags[0] === FLAG ? 'RODADA' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}
function conferir(nome, obtido, esperado) {
    if (obtido !== esperado) throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado});
}
function conferirResultado(nome, obtido, esperado) {
    if (Array.isArray(esperado) ? !esperado.includes(obtido) : obtido !== esperado)
        throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado:[].concat(esperado).join('|')});
}
/** As três confirmações precisam caber sem mexer no teto nem em vagas de terceiros. */
function cabeNaCampanha(c) { return Number.isInteger(c?.ocupadas) && c.ocupadas + PAGANTES.length <= VAGAS_CAMPANHA; }
/** Contrato G1: a linha da janela de 23 h do processador usa relogioReal (tempo real), não o `agora` deslocado. */
function g1Presente(fonte) {
    const linha = String(fonte ?? '').split(/\r?\n/).find(l => /23\s*\*\s*3600000/.test(l));
    return !!linha && /relogioReal/.test(linha);
}

// ---- Calendário (datas YYYY-MM-DD em UTC, como o processador; dia civil em America/Sao_Paulo). Independente de lib/.
const DATA = /^\d{4}-\d{2}-\d{2}$/;
function diaBrasil(d) { return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'}).format(d); }
function horaBrasil(d) { return Number(new Intl.DateTimeFormat('en-GB', {timeZone:'America/Sao_Paulo', hour:'2-digit', hourCycle:'h23'}).format(d)); }
function somarDias(data, dias) { assert.match(data, DATA); return new Date(Date.parse(data + 'T00:00:00Z') + dias * DIA_MS).toISOString().slice(0, 10); }
function diasEntre(de, ate) { assert.match(de, DATA); assert.match(ate, DATA); return Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS); }
/** Dia âncora preservado (31/jan → 28/fev). */
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
/** Instantes do ensaio acelerado. Limite no futuro: o CHECK da 075 compara aviso_enviado_em (relógio real) ao limite. */
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

// ---- Allow-list: processador e provedor só alcançam as três pagantes e as assinaturas registradas delas (senão S3, antes da rede).
function escopo(fixtures = PAGANTES) {
    const empresas = new Set(fixtures.map(f => f.empresa)), assinaturas = new Map(), uso = {};
    const fora = (tipo, v) => { throw Object.assign(Error('FORA_DAS_FIXTURES'), {parada:'S3', item:tipo, obtido:String(v).slice(0, 12)}); };
    return {
        uso,
        empresa(id) { if (!empresas.has(id)) fora('empresa', id); uso[id] = (uso[id] ?? 0) + 1; return id; },
        vincular(empresa, assinatura) {
            if (!empresas.has(empresa)) fora('empresa', empresa);
            if (typeof assinatura !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(assinatura)) fora('assinatura', assinatura);
            if (assinaturas.has(empresa) && assinaturas.get(empresa) !== assinatura) fora('assinatura', assinatura);
            if ([...assinaturas].some(([e, a]) => a === assinatura && e !== empresa)) fora('assinatura', assinatura);
            assinaturas.set(empresa, assinatura);
        },
        assinatura(id) { if (![...assinaturas.values()].includes(id)) fora('assinatura', id); return id; },
    };
}
function repositorioRestrito(repo, esc) {
    return {
        ler: async id => repo.ler(esc.empresa(id)),
        criar: async r => { esc.empresa(r?.empresaId); return repo.criar(r); },
        marcar: async (id, registro, a) => repo.marcar(esc.empresa(id), registro, a),
    };
}
/** Provedor do processador limitado às assinaturas da rodada; conta PUTs e suspensões; pode perder a resposta de um PUT de preço. */
function provedorRestrito(p, esc, {perderRespostaPreco = new Set(), contagem = {}} = {}) {
    const somar = (k, id) => { contagem[k] = {...(contagem[k] ?? {}), [id]:(contagem[k]?.[id] ?? 0) + 1}; };
    const daRodada = c => { if (c) esc.assinatura(c.assinaturaId ?? null); return c; };
    return {
        contagem,
        obterAssinatura: async id => p.obterAssinatura(esc.assinatura(id)),
        listarCobrancasDaAssinatura: async id => p.listarCobrancasDaAssinatura(esc.assinatura(id)),
        obterCobranca: async id => daRodada(await p.obterCobranca(id)),
        async atualizarValorAssinatura(id, valor) {
            esc.assinatura(id); somar('precoAssinatura', id);
            const r = await p.atualizarValorAssinatura(id, valor);
            if (perderRespostaPreco.delete(id)) throw Error('RESPOSTA_PERDIDA_SIMULADA');
            return r;
        },
        async atualizarValorCobranca(c, valor) { daRodada(c); somar('precoCobranca', c.id); return p.atualizarValorCobranca(c, valor); },
        async suspenderGeracao(id) { esc.assinatura(id); somar('suspensao', id); return p.suspenderGeracao(id); },
    };
}

// ---- E-mail SINK. Payload e chave vêm do registro persistido; nada sai do processo.
function idSink(idempotencia) { return 'sink-' + createHash('sha256').update(String(idempotencia)).digest('hex').slice(0, 40); }
/**
 * SINK com a semântica de idempotência do provedor: mesma chave → mesmo id, sem segunda entrega.
 * `falharAntes`: falha antes de entregar (falha de entrega). `perderRespostas`: entrega e perde a resposta N vezes.
 */
function sinkIdempotente({falharAntes = false, perderRespostas = 0} = {}) {
    assert.equal(MODO_EMAIL, 'SINK', 'SO_SINK');
    const entregues = new Map(), tentativas = [];
    let perder = perderRespostas;
    return {
        tentativas: () => tentativas.length, entregas: () => entregues.size, chaves: () => [...entregues.keys()],
        enviar: async m => {
            tentativas.push(m.idempotencia);
            if (falharAntes) throw Error('FALHA_DE_ENTREGA_SIMULADA');
            if (!entregues.has(m.idempotencia)) entregues.set(m.idempotencia, idSink(m.idempotencia));
            if (perder > 0) { perder--; throw Error('RESPOSTA_DO_ENVIO_PERDIDA_SIMULADA'); }
            return {provedor:'sink', idExterno:entregues.get(m.idempotencia)};
        },
    };
}
/** Cada fixture só "envia" ao próprio e-mail sintético e com a chave imutável do próprio registro. */
function envioDaFixture(f, transporte) {
    return async m => {
        if (m?.para !== f.email || !/@example\.invalid$/.test(f.email) || !/^kidmais-renovacao\/[0-9a-f-]{36}$/.test(m?.idempotencia ?? ''))
            throw Error('MENSAGEM_FORA_DA_FIXTURE');
        return transporte(m);
    };
}

/**
 * Salto do próximo vencimento SÓ no Asaas sandbox e SÓ na assinatura mensal registrada pela rodada: id do estado da rodada,
 * vinculado no escopo, relido com referência, cliente, ciclo, valor Fundador e vencimento ainda anterior à data regular.
 * A prova (estado de antes) é gravada ANTES do PUT. Qualquer divergência → S3 sem chamar o PUT.
 */
async function ajustarVencimentoDaRodada({f, r, esc, p, ajustar, salvar}) {
    const reg = r?.[f.chave], data = r?.tempo?.[f.chave]?.primeira;
    const recusar = motivo => { throw Object.assign(Error('SALTO_RECUSADO'), {parada:'S3', item:f?.chave + '.' + motivo}); };
    if (f?.ciclo !== 'MENSAL') recusar('ciclo');
    if (typeof reg?.assinaturaId !== 'string' || typeof reg?.clienteId !== 'string' || !DATA.test(data ?? '')) recusar('semRegistro');
    const id = esc.assinatura(reg.assinaturaId);
    const antes = await p.obterAssinatura(id);
    if (!antes || antes.id !== id || antes.deleted || antes.status !== 'ACTIVE' || antes.externalReference !== f.empresa
        || antes.customer !== reg.clienteId || antes.cycle !== 'MONTHLY' || antes.valorCentavos !== f.fundador || !(antes.nextDueDate < data)) recusar('identidade');
    reg.salto = {assinaturaId:id, antes:antes.nextDueDate, alvo:data, intencao:true}; salvar(); // prova ANTES do PUT
    await ajustar(id, data);
    const depois = await p.obterAssinatura(id);
    conferir(f.chave + '.salto.vencimento', typeof depois?.nextDueDate === 'string' && depois.nextDueDate >= data, true);
    conferir(f.chave + '.salto.valor', depois?.valorCentavos, f.fundador);
    reg.salto.depois = depois.nextDueDate; salvar();
    return reg.salto;
}

/**
 * Prova de autoria, só a partir do estado gravado ANTES de cada criação:
 *  - fixtures: S1 provou IDs/códigos/e-mails livres E a rodada gravou intencaoFixture;
 *  - assinatura sandbox de F: S1 provou referência livre no Asaas E a rodada gravou intencaoCheckout;
 *  - webhook: só se a rodada gravou a intenção de CRIÁ-LO (nunca o reutilizado).
 */
function recursosComprovados(r) {
    const livre = r?.precheck?.fixturesLivres === true;
    return {
        fixtures: livre && r.intencaoFixture === true,
        assinaturas: Object.fromEntries(PAGANTES.map(f => [f.chave, livre && r?.precheck?.asaasLivre?.[f.chave] === true && r[f.chave]?.intencaoCheckout === true])),
        webhook: r?.intencaoWebhook === true && r?.webhookReutilizado !== true && typeof r?.webhookNome === 'string' && r.webhookNome.length > 0,
    };
}

function conferirRegistro(chave, linha, esperado, f, tempo) {
    conferir(chave + '.registro.existe', !!linha, true);
    const [estado, enviado, aplicado, erro, tentado] = esperado;
    conferir(chave + '.registro.estado', linha.estado, estado); conferir(chave + '.registro.enviado', linha.enviado, enviado);
    conferir(chave + '.registro.aplicado', linha.aplicado, aplicado); conferir(chave + '.registro.erro', linha.ultimo_erro ?? null, erro);
    conferir(chave + '.registro.tentado', linha.tentado, tentado);
    conferir(chave + '.registro.primeira', linha.primeira, tempo.primeira); conferir(chave + '.registro.para', linha.para, f.email);
    conferir(chave + '.registro.chave', linha.chave_ok, true); conferir(chave + '.registro.unico', Number(linha.total), 1);
}
function conferirTela(chave, dto, esperado, f, tempo) {
    conferir(chave + '.tela.estado', dto?.estado, esperado[0]); conferir(chave + '.tela.avisoEnviado', dto?.avisoEnviado, esperado[1]);
    conferir(chave + '.tela.dataRegular', dto?.dataRegular, tempo.primeira); conferir(chave + '.tela.valorRegular', dto?.valorRegular, f.regular);
    conferir(chave + '.tela.ciclo', dto?.ciclo, f.ciclo);
}
/** Asaas depois do preço regular: assinatura regular com próximo vencimento ≥ data regular; 1ª cobrança paga com valor Fundador. */
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

/**
 * Encerramento idempotente (finally e recuperação). Nunca lança; o erro original prevalece no chamador. Só toca o que tem prova.
 * Por pagante: remove no sandbox a assinatura da referência (ids conferidos; a listagem omite removidas, então a prova é a
 * releitura por id: 404 ou deleted=true). Cobranças pagas permanecem pagas. NUNCA escreve vaga, contratação ou renovação:
 * vaga CONFIRMADA é permanente; vaga RESERVADA (interrupção antes do pagamento) fica e é reportada para decisão própria.
 * Depois remove só o webhook criado pela rodada e desativa usuários, vínculos e empresas das fixtures. Nunca apaga linha.
 */
async function encerrar({db, conectado, r, p, api, salvar}) {
    let erro = null;
    const gravar = () => { try { salvar(); } catch { /* disco indisponível não impede o encerramento */ } };
    const falhar = (etapa, e) => { erro ??= Object.assign(Error('LIMPEZA_' + etapa), {etapa});
        r.falhasEncerramento = [...(r.falhasEncerramento ?? []), {etapa, mensagem:String(e?.message ?? e).slice(0, 120)}]; gravar(); };
    try {
        if (conectado) await db.query('ROLLBACK').catch(() => {});
        const prova = recursosComprovados(r);
        r.encerramento = {inicio:new Date().toISOString(), prova}; gravar();
        for (const f of PAGANTES) {
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
                const ids = [...new Set([...subs.map(s => s.id), ...(assinaturaId ? [assinaturaId] : [])])];
                let removidas = 0;
                for (const id of ids) {
                    const a = await p.obterAssinatura(id);
                    if (a === null || a?.deleted === true) continue;
                    assert.equal(a.externalReference, f.empresa, 'SUB_DE_OUTRA_REFERENCIA');
                    if (clienteId) assert.equal(a.customer, clienteId, 'SUB_DE_OUTRO_CLIENTE');
                    assert.equal((await p.removerAssinatura(id)).removida, true, 'SUB_NAO_REMOVIDA'); removidas++;
                }
                const ok = (await Promise.all(ids.map(id => p.obterAssinatura(id)))).every(a => a === null || a?.deleted === true);
                r.encerramento[f.chave] = {acao:!ids.length ? 'NADA_A_REMOVER' : ok ? 'ASSINATURA_REMOVIDA_COMPROVADA' : 'REMOCAO_NAO_COMPROVADA',
                    assinaturas:ids.length, removidas, pagamentoIntencionado:r[f.chave]?.intencaoPagamento === true}; gravar();
                if (!ok) throw Error('REMOCAO_NAO_COMPROVADA');
            } catch (e) { r.limpezaAssinaturaPendente = true; falhar('ASSINATURA_' + f.chave, e); }
        }
        try {
            if (prova.webhook) {
                if (!r.webhookId) {
                    const lista = await api('/webhooks?limit=100'); assert.ok(lista && !lista.hasMore, 'WEBHOOKS_PAGINADOS');
                    const candidatos = lista.data.filter(w => w.name === r.webhookNome && w.url === URL_WEBHOOK);
                    assert.ok(candidatos.length <= 1, 'WEBHOOK_AMBIGUO'); r.webhookId = candidatos[0]?.id; gravar();
                }
                if (r.webhookId) { const w = await api('/webhooks/' + encodeURIComponent(r.webhookId));
                    if (w) { assert.equal(w.name, r.webhookNome, 'WEBHOOK_DE_OUTRO_NOME'); assert.equal(w.url, URL_WEBHOOK, 'WEBHOOK_DE_OUTRA_URL');
                        await api('/webhooks/' + encodeURIComponent(r.webhookId), 'DELETE'); } }
                r.encerramento.webhook = 'ENCERRADO';
            } else r.encerramento.webhook = 'NADA_CRIADO_PELA_RODADA';
            gravar();
        } catch (e) { r.limpezaWebhookPendente = true; falhar('WEBHOOK', e); }
        try {
            if (!prova.fixtures) r.encerramento.fixtures = 'NADA_CRIADO_PELA_RODADA';
            else if (!conectado) throw Error('BANCO_INDISPONIVEL');
            else {
                // Além do ID reservado, cada UPDATE confere o marcador da fixture (e-mail ou código + nome).
                await db.query('BEGIN');
                await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[]) AND email=ANY($2::text[])', [FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)]);
                await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.usuario)]);
                await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status<>'DESATIVADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.nome)]);
                await db.query('COMMIT'); r.fixturesDesativadas = true; r.encerramento.fixtures = 'DESATIVADAS';
            }
            gravar();
        } catch (e) { if (conectado) await db.query('ROLLBACK').catch(() => {}); r.limpezaBancoPendente = true; falhar('BANCO', e); }
        try {
            if (prova.fixtures && conectado) {
                // Só leitura: estado final das vagas das fixtures. RESERVADA = interrupção antes do pagamento; liberação exige decisão própria.
                const vagas = (await db.query('SELECT empresa_id::text AS e, estado FROM assinatura_fundadores WHERE empresa_id=ANY($1::uuid[])', [IDS_EMPRESAS])).rows;
                r.encerramento.vagasFinais = Object.fromEntries(vagas.map(x => [FIXTURES.find(f => f.empresa === x.e)?.chave ?? 'FORA', x.estado])); gravar();
                const presas = Object.entries(r.encerramento.vagasFinais).filter(([, e]) => e === 'RESERVADA').map(([k]) => k);
                if (presas.length) throw Error('VAGA_RESERVADA_SEM_LIBERACAO ' + presas.join(','));
            }
        } catch (e) { r.vagaReservadaPendente = true; falhar('VAGAS', e); }
    } catch (e) { falhar('ENCERRAMENTO', e); }
    try { r.encerramento = {...(r.encerramento ?? {}), fim:new Date().toISOString()}; } catch { /* nada */ }
    gravar();
    return erro;
}

/** Cliente Asaas sandbox, API restrita (webhooks, confirmação sandbox) e ajuste de vencimento por id. */
async function provedorSandbox() {
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO');
    const bruto = async (caminho, method, body) => {
        const res = await fetch(ASAAS + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao', 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status});
        return res.json().catch(() => null);
    };
    const api = (caminho, method = 'GET', body) => {
        assert.ok(/^\/(webhooks(\/[A-Za-z0-9_-]{1,100}|\?limit=100)?|sandbox\/payment\/[A-Za-z0-9_-]{1,100}\/confirm)$/.test(caminho), 'CAMINHO_ASAAS_RECUSADO');
        return bruto(caminho, method, body);
    };
    const ajustar = (id, data) => {
        assert.match(String(id), /^[A-Za-z0-9_-]{1,100}$/); assert.match(data, DATA);
        return bruto('/subscriptions/' + encodeURIComponent(id), 'PUT', {nextDueDate:data, updatePendingPayments:false});
    };
    return {p:criarClienteAsaas(cfg.config), api, ajustar, cfg:cfg.config};
}

async function campanha(db) {
    return (await db.query(`SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
        count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`)).rows[0];
}
const pausa = ms => new Promise(ok => setTimeout(ok, ms));
/** Trava por empresa ocupada (execução concorrente/webhook): tenta de novo; qualquer outro erro sobe. */
async function comRetentativa(trabalho, {tentativas = 5, esperar = () => pausa(3000)} = {}) {
    for (let i = 0; ; i++) {
        try { return await trabalho(); }
        catch (e) { if (e?.code === 'CONTRATACAO_EM_ANDAMENTO' && i < tentativas) { await esperar(); continue; } throw e; }
    }
}
const SQL_REGISTROS = `SELECT r.empresa_id::text AS empresa_id, r.estado, r.aviso_enviado_em IS NOT NULL AS enviado, r.preco_aplicado_em IS NOT NULL AS aplicado,
    r.aviso_tentado_em IS NOT NULL AS tentado, r.ultimo_erro, r.primeira_data_regular::text AS primeira,
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
    const {p, api} = await provedorSandbox();
    const db = new Client(opts); let conectado = false, erro = null;
    try {
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1');
    } catch (e) { conectado = false; erro = e; }
    // Mesmo sem banco, o encerramento do Asaas roda; o erro de conexão é o original e prevalece.
    erro = erroFinal(erro, await encerrar({db, conectado, r, p, api, salvar}));
    if (conectado) r.campanhaDepois = await campanha(db).catch(() => null);
    await db.end().catch(() => {});
    r.recuperado = !erro; salvar();
    console.log(JSON.stringify({resultado:erro ? 'ENCERRAMENTO_INCOMPLETO' : 'ENCERRADO', erro:erro ? String(erro.message).slice(0, 80) : null,
        encerramento:r.encerramento ?? null, campanhaAntes:r.campanhaAntes ?? null, campanhaDepois:r.campanhaDepois ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

async function main() {
    const opts = alvo(process.env);
    assert.ok(g1Presente(fs.readFileSync(path.join(__dirname, '..', 'lib', 'assinatura', 'renovacao-fundador.ts'), 'utf8')), 'G1_AUSENTE_S1');
    assert.ok(horaBrasil(new Date()) < HORA_LIMITE_BRT, 'HORARIO_S1');
    const {Pool} = require('pg');
    const {criarHashSenha} = await import('../lib/autenticacao/senha.ts');
    const precos = await import('../lib/comercial/pacote-precos.ts');
    const pacotesAdmin = await import('../lib/comercial/pacotes-admin.ts');
    const {processarRenovacao} = await import('../lib/assinatura/renovacao-fundador.ts');
    const {repositorioRenovacao} = await import('../lib/assinatura/renovacao-repositorio.ts');
    const {travaPorEmpresa} = await import('../lib/assinatura/cobranca.ts');
    const {p, api, ajustar, cfg} = await provedorSandbox();
    exigirDisco();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    assert.ok(!fs.existsSync(ARQUIVO), 'RODADA_EXISTENTE_S1');
    const r = {marca:MARCA, inicio:new Date().toISOString(), diaInicio:diaBrasil(new Date()), pid:process.pid, modoEmail:MODO_EMAIL, etapas:[], resultados:{}, tempo:{}};
    r.empresa = 'hml-pr-r3'; // só compõe o nome do webhook em prepararWebhook ("Kidmais staging ensaio hml-pr-r3")
    fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'}); // uma rodada só
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    const pool = new Pool({...opts, max:5}); pool.on('error', () => undefined);
    let db = null, conectado = false, erro, etapa = 'PRECHECK';
    const marcar = e => { etapa = e; r.etapas.push(e); salvar(); };
    const senhas = new Map(FIXTURES.map(f => [f.chave, 'Sintetica-' + randomBytes(24).toString('hex')])); // só em memória
    const tx = {query: async (t, v) => { const x = await db.query(t, v); return {rows:x.rows, rowCount:x.rowCount}; }};
    const transacao = async trabalho => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='30s'"); await c.query("SET LOCAL lock_timeout='5s'");
            const x = await trabalho(c); await c.query('COMMIT'); return x; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    };
    // ---- Renovação: allow-list, provedor restrito, SINK por fixture, `agora` deslocado e relogioReal verdadeiro.
    const esc = escopo(), contagem = {}, perder = new Set();
    const sinks = Object.fromEntries(PAGANTES.map(f => [f.chave, sinkIdempotente(EMAIL[f.chave])]));
    const deps = {repositorio:repositorioRestrito(repositorioRenovacao(transacao), esc), provedor:provedorRestrito(p, esc, {perderRespostaPreco:perder, contagem}),
        origem:BASE, simular:false, travar:travaPorEmpresa(transacao), relogioReal:() => new Date()};
    const rodar = async (f, quando) => {
        const t = r.tempo[f.chave], agora = relogio(t.offsets[quando]);
        conferir(f.chave + '.dia.' + quando, diaBrasil(agora()), t.dias[quando]);
        try { return await comRetentativa(() => processarRenovacao(esc.empresa(f.empresa), {...deps, enviar:envioDaFixture(f, sinks[f.chave].enviar), agora})); }
        catch (e) {
            if (e?.parada) throw e;
            r.errosReprocessaveis = [...(r.errosReprocessaveis ?? []), {chave:f.chave, quando, mensagem:String(e?.message ?? e).slice(0, 60)}];
            return 'ERRO_REPROCESSAVEL';
        }
    };
    const registros = async () => Object.fromEntries((await db.query(SQL_REGISTROS, [PAGANTES.map(f => f.empresa)])).rows
        .map(x => [PAGANTES.find(f => f.empresa === x.empresa_id).chave, x]));
    // Sessão administrativa de uma fixture; cookies e CSRF só em memória.
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
    const publico = async (caminho, method = 'GET', body) => {
        assert.ok(caminho.startsWith('/api/fechamentos') || caminho.startsWith('/api/disponibilidade') || caminho.startsWith('/b/')
            || caminho.startsWith('/api/identidade/consultar-cpf'));
        const res = await fetch(BASE + caminho, {method, redirect:'manual', signal:AbortSignal.timeout(60000),
            headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        const texto = await res.text(); let j = null; try { j = JSON.parse(texto); } catch { /* página HTML */ }
        return {status:res.status, j, texto};
    };
    const hash = v => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
    const preservacao = async () => {
        const hashes = {};
        for (const [tabela, coluna, volateis] of PRESERVADAS)
            hashes[tabela] = hash((await db.query(sqlPreservacao(tabela, coluna, volateis), [IDS_EMPRESAS])).rows.map(x => x.linha)); // só hash, nunca linhas
        return hashes;
    };
    const proximoMes = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const i = d.toISOString().slice(0, 10);
        d.setUTCMonth(d.getUTCMonth() + 1, 0); return `inicio=${i}&fim=${d.toISOString().slice(0, 10)}`; };
    const kidmaisPublico = async () => {
        const pacotes = await publico('/api/fechamentos/pacotes'), agenda = await publico('/api/disponibilidade?' + proximoMes());
        assert.equal(pacotes.status, 200, 'KIDMAIS_PACOTES'); assert.equal(agenda.status, 200, 'KIDMAIS_AGENDA');
        return {pacotes:hash(pacotes.j), agenda:hash(projecaoAgenda(agenda.j))};
    };
    const s = Object.fromEntries(FIXTURES.map(f => [f.chave, sessao(f)]));
    const tela = async f => { const x = await s[f.chave].pedir('/api/admin/assinatura'); conferir(f.chave + '.tela.status', x.status, 200); return x.j.data; };
    const etapaRodada = async rodada => {
        marcar(rodada.id);
        for (const f of PAGANTES.filter(x => rodada.quando[x.chave])) {
            const q = rodada.quando[f.chave];
            const obtido = rodada.concorrente === f.chave
                ? (await Promise.all([rodar(f, q), rodar(f, q)])).reduce((a, b) => { conferir(f.chave + '.' + rodada.id + '.concorrente', b, a); return a; })
                : await rodar(f, q);
            r.resultados[rodada.id] = {...(r.resultados[rodada.id] ?? {}), [f.chave]:obtido}; salvar();
            conferirResultado(f.chave + '.' + rodada.id, obtido, rodada.esperado[f.chave]);
        }
        if (REGISTROS[rodada.id]) { const linhas = await registros();
            for (const f of PAGANTES) conferirRegistro(f.chave, linhas[f.chave], REGISTROS[rodada.id][f.chave], f, r.tempo[f.chave]); }
        if (TELAS[rodada.id]) for (const f of PAGANTES) conferirTela(f.chave, (await tela(f)).renovacao, TELAS[rodada.id][f.chave], f, r.tempo[f.chave]);
    };
    const contarEmails = () => Object.fromEntries(PAGANTES.map(f => [f.chave, {tentativas:sinks[f.chave].tentativas(), entregas:sinks[f.chave].entregas()}]));
    try {
        // ---- S1: alvo, identidade do banco, schema 074–077, fixtures livres, campanha com 3 vagas, referências Asaas livres.
        db = await pool.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        r.conexao = conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1'); salvar();
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL AND to_regclass('public.financeiro_categorias') IS NOT NULL
            AND to_regclass('public.assinatura_fundadores') IS NOT NULL AND to_regclass('public.assinatura_renovacoes') IS NOT NULL
            AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.assinatura_renovacoes') AND NOT tgisinternal AND tgenabled = 'O') = 2
            AND to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL AND to_regclass('public.clientes_cpf_canonico_uk') IS NULL
            AND to_regclass('public.empresa_regras_pagamento') IS NOT NULL AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR lower(btrim(email))=ANY($4::text[])) AS ocupado`,
            [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        r.campanhaAntes = await campanha(db); salvar();
        if (!cabeNaCampanha(r.campanhaAntes)) throw Object.assign(Error('FUNDADOR_SEM_VAGAS_S4'), {parada:'S4'});
        // Prova de autoria para o encerramento: só depois de S1 aprovar, gravada ANTES de qualquer criação.
        r.precheck = {fixturesLivres:true, asaasLivre:{}}; salvar();
        for (const f of PAGANTES) {
            assert.equal(await p.buscarClientePorReferencia(f.empresa), null, 'CLIENTE_ASAAS_PREEXISTENTE_S1');
            assert.equal((await p.listarAssinaturasPorReferencia(f.empresa)).length, 0, 'ASSINATURA_ASAAS_PREEXISTENTE_S1');
            r.precheck.asaasLivre[f.chave] = true; salvar();
        }
        r.antes = await preservacao(); r.kidmaisAntes = await kidmaisPublico(); salvar();

        // ---- Fixtures (uma transação). Nenhuma linha de outra empresa é tocada.
        marcar('FIXTURES'); r.intencaoFixture = true; salvar(); await db.query('BEGIN');
        for (const f of FIXTURES) {
            let doc; do { doc = documento(); } while (doc === KIDMAIS_CNPJ
                || (await db.query('SELECT 1 FROM assinatura_fundadores WHERE documento_beneficiario=$1 UNION ALL SELECT 1 FROM empresa_assinaturas WHERE documento_teste=$1', [doc])).rowCount);
            await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
            await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Homologação',$3,'REPRESENTANTE_AUTORIZADO',true)",
                [f.usuario, f.email, await criarHashSenha(senhas.get(f.chave))]);
            await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.usuario]);
            await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            await db.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [f.empresa]);
            if (f.tipo === 'PLANO')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)", [f.empresa, doc]);
            if (f.tipo === 'TESTE')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)", [f.empresa, doc]);
            if (f.tipo === 'ISENTA')
                await db.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Homologação sintética staging 20261010 r3',$3)", [f.empresa, doc, f.usuario]);
            const regra = REGRAS[f.chave];
            if (regra)
                await db.query(`INSERT INTO empresa_regras_pagamento(empresa_id,pix_avista_percentual,pix_parcelado_percentual,cartao_rotulo,desconto_dia_util,motivo)
                    VALUES($1,$2,$3,$4,$5,'Homologação sintética staging 20261010 r3')`, [f.empresa, regra.pixAvista, regra.pixParcelado, regra.cartao, regra.diaUtil]);
        }
        await db.query('COMMIT'); r.fixture = true; salvar();

        // ---- Catálogo mínimo pelos serviços de domínio.
        marcar('CATALOGO');
        const horarios = (await db.query('SELECT id::text AS id FROM configuracao_agenda WHERE ativo')).rows.map(x => x.id);
        assert.ok(horarios.length > 0, 'AGENDA_SEM_HORARIOS');
        for (const f of FIXTURES.filter(x => x.catalogo)) {
            const ctx = () => ({empresaId:f.empresa, usuarioId:f.usuario, requestId:randomUUID(), motivo:'PACOTE_EDITADO'});
            const pacote = (await db.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
                VALUES ($1, 'POCKET', 'Pocket homologação', 1, true, true, 20, 30) RETURNING id`, [f.empresa])).rows[0].id;
            await db.query('BEGIN'); await precos.gravarFaixasPacote(tx, f.empresa, pacote, [{convidadosMin:FAIXA_POCKET.min, convidadosMax:FAIXA_POCKET.max, valor:FAIXA_POCKET.valor}], {minimo:FAIXA_POCKET.min, maximo:FAIXA_POCKET.max}, ctx()); await db.query('COMMIT');
            await db.query('BEGIN'); await pacotesAdmin.definirDisponibilidadePacoteAdmin(tx, pacote, {disponibilidade:[1,2,3,4,5,6,7].flatMap(dia => horarios.map(horarioId => ({dia, horarioId})))}, ctx()); await db.query('COMMIT');
        }
        r.catalogo = true; salvar();

        // ---- Pagamento Fundador no sandbox: F1 Essencial mensal, F2 Profissional anual, F5 Premium mensal. Vaga confirmada é permanente.
        for (const f of FIXTURES) await s[f.chave].entrar();
        marcar('WEBHOOK'); await prepararWebhook(api, cfg, r, salvar);
        for (const f of PAGANTES) {
            marcar('CHECKOUT_' + f.chave);
            const antes = await tela(f), anual = f.ciclo === 'ANUAL';
            conferir(f.chave + '.habilitado', antes?.ofertas?.habilitado, true); conferir(f.chave + '.fundador', antes.ofertas.fundador, true);
            conferir(f.chave + '.aguardandoVaga', antes.ofertas.aguardandoVaga, false);
            const oferta = antes.ofertas.planos.find(x => x.id === f.plano);
            conferir(f.chave + '.precoRegular', anual ? oferta?.anualRegular : oferta?.mensalRegular, f.regular);
            conferir(f.chave + '.precoFundador', anual ? oferta?.anual : oferta?.mensal, f.fundador);
            r[f.chave] = {intencaoCheckout:true, valor:f.fundador}; salvar(); // prova de autoria ANTES do checkout
            const ck = await s[f.chave].post('/api/admin/assinatura/checkout', {plano:f.plano, ciclo:f.ciclo, valorEsperadoCentavos:f.fundador, versao:antes.ofertas.versao});
            conferir(f.chave + '.checkout', ck.status, 200);
            const linha = (await db.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0];
            Object.assign(r[f.chave], {clienteId:linha.provedor_cliente_id, assinaturaId:linha.provedor_assinatura_id}); salvar();
            esc.vincular(f.empresa, linha.provedor_assinatura_id); // allow-list: só a assinatura criada por este checkout
            conferir(f.chave + '.vagaReservada', (await db.query('SELECT estado FROM assinatura_fundadores WHERE empresa_id=$1', [f.empresa])).rows.map(x => x.estado).join(), 'RESERVADA');
            const sub = await p.obterAssinatura(esc.assinatura(linha.provedor_assinatura_id));
            conferir(f.chave + '.asaas.referencia', sub?.externalReference, f.empresa); conferir(f.chave + '.asaas.valor', sub?.valorCentavos, f.fundador);
            conferir(f.chave + '.asaas.ciclo', sub?.cycle, anual ? 'YEARLY' : 'MONTHLY');
            const cobrancas = (await p.listarCobrancasDaAssinatura(sub.id)).filter(c => !c.deleted);
            r[f.chave].cobrancas = cobrancas.map(c => c.id); salvar();
            conferir(f.chave + '.asaas.cobrancas', cobrancas.length, 1); conferir(f.chave + '.asaas.pendente', cobrancas[0].status, 'PENDING');
            conferir(f.chave + '.cobranca.valor', cobrancas[0].valorCentavos, f.fundador); conferir(f.chave + '.cobranca.assinatura', cobrancas[0].assinaturaId, sub.id);
            conferir(f.chave + '.cobranca.vencimentoHoje', cobrancas[0].dueDate, diaBrasil(new Date()));
            r[f.chave].pagamentoId = cobrancas[0].id; r[f.chave].intencaoPagamento = true; salvar(); // a partir daqui a vaga fica confirmada
            await api('/sandbox/payment/' + encodeURIComponent(r[f.chave].pagamentoId) + '/confirm', 'POST');
            // Callback: evento do webhook processado para a empresa da fixture (até 3 min).
            for (let i = 0; ; i++) {
                const ev = (await db.query("SELECT 1 FROM cobranca_eventos WHERE empresa_id=$1 AND tipo IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND situacao='PROCESSADO'", [f.empresa])).rowCount;
                if (ev) break; if (i >= 180) throw Object.assign(Error('CALLBACK_S4'), {parada:'S4'}); await pausa(1000);
            }
            // Benefício: vaga e contratação confirmadas com o pagamento; fim = confirmação + 12 meses (UTC), conferido no banco.
            const b = (await db.query(`SELECT v.estado AS vaga, v.vaga AS numero, v.pagamento_confirmacao_id = $2 AS vaga_pagamento,
                    v.beneficio_fim = ((v.confirmada_em AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC' AS doze_meses,
                    v.beneficio_fim > clock_timestamp() + interval '364 days' AS vigente_um_ano,
                    to_char(v.beneficio_fim AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fim,
                    c.estado AS contratacao, c.ciclo, c.desconto_percentual, c.valor_regular_centavos, c.valor_final_centavos,
                    c.pagamento_confirmacao_id = $2 AS contrato_pagamento, a.contratacao_atual_id = c.id AS atual, a.situacao
                FROM assinatura_fundadores v JOIN assinatura_contratacoes c ON c.empresa_id=v.empresa_id AND c.fundador_id=v.id
                JOIN empresa_assinaturas a ON a.empresa_id=v.empresa_id WHERE v.empresa_id=$1`, [f.empresa, r[f.chave].pagamentoId])).rows;
            conferir(f.chave + '.beneficio.linhas', b.length, 1);
            conferir(f.chave + '.vagaConfirmada', b[0].vaga, 'CONFIRMADA'); conferir(f.chave + '.vagaPagamento', b[0].vaga_pagamento, true);
            conferir(f.chave + '.beneficio12Meses', b[0].doze_meses, true); conferir(f.chave + '.beneficioVigente', b[0].vigente_um_ano, true);
            conferir(f.chave + '.contratacaoConfirmada', b[0].contratacao, 'CONFIRMADA'); conferir(f.chave + '.contratacaoAtual', b[0].atual, true);
            conferir(f.chave + '.contratacaoCiclo', b[0].ciclo, f.ciclo); conferir(f.chave + '.situacao', b[0].situacao, 'ATIVA');
            conferir(f.chave + '.desconto', b[0].desconto_percentual, 40); conferir(f.chave + '.valorRegular', b[0].valor_regular_centavos, f.regular);
            conferir(f.chave + '.valorFinal', b[0].valor_final_centavos, f.fundador); conferir(f.chave + '.contratoPagamento', b[0].contrato_pagamento, true);
            Object.assign(r[f.chave], {vagaNumero:b[0].numero, primeiroVencimento:cobrancas[0].dueDate, beneficioFim:b[0].fim}); salvar();
            const depois = await tela(f);
            conferir(f.chave + '.acesso', depois.acesso?.nivel, 'COMPLETO'); conferir(f.chave + '.plano', depois.vagas?.plano, f.plano);
            conferir(f.chave + '.limitePessoas', depois.vagas?.limite, LIMITE_PESSOAS[f.plano]);
            r.tempo[f.chave] = planoTempo(diaBrasil(new Date()), primeiraEsperada(cobrancas[0].dueDate, b[0].fim, f.ciclo)); salvar();
        }
        // Campanha: exatamente três confirmações a mais, todas das pagantes (vagas de terceiros comparadas por hash).
        r.campanhaConfirmada = await campanha(db); salvar();
        conferir('campanha.ocupadas', r.campanhaConfirmada.ocupadas, r.campanhaAntes.ocupadas + PAGANTES.length);
        conferir('campanha.confirmadas', r.campanhaConfirmada.confirmadas, r.campanhaAntes.confirmadas + PAGANTES.length);

        // ---- Matriz do financeiro por plano (isenta e teste liberadas).
        marcar('MATRIZ_FINANCEIRO');
        for (const f of FIXTURES) {
            const e = FINANCEIRO[f.chave], x = s[f.chave], res = r.resultados[f.chave] = {};
            const categoria = (await db.query("SELECT id::text FROM financeiro_categorias WHERE empresa_id=$1 AND nome='Homologação'", [f.empresa])).rows[0].id;
            res.contasPagar = (await x.pedir('/api/admin/financeiro/contas-pagar')).status; conferir(f.chave + '.contasPagar', res.contasPagar, e.contasPagar);
            const criar = await x.post('/api/admin/financeiro/contas-pagar', {acao:'criar', descricao:'Conta sintética homologação', categoriaId:categoria, valor:10,
                vencimento:new Date(Date.now() + DIA_MS * 10).toISOString().slice(0, 10), chave:'hml-' + randomUUID()});
            res.criarConta = criar.status; conferir(f.chave + '.criarConta', res.criarConta, e.criarConta);
            if (e.criarConta === 403) conferir(f.chave + '.codigo', criar.j.codigo, 'RECURSO_FORA_DO_PLANO');
            const contas = (await db.query('SELECT count(*)::int n FROM financeiro_contas_pagar WHERE empresa_id=$1', [f.empresa])).rows[0].n;
            conferir(f.chave + '.contasGravadas', contas, e.criarConta === 200 ? 1 : 0);
            res.fluxo = (await x.pedir('/api/admin/financeiro/fluxo-caixa?' + proximoMes())).status; conferir(f.chave + '.fluxo', res.fluxo, e.fluxo);
            res.relatorios = (await x.pedir('/api/admin/financeiro/relatorios?' + proximoMes())).status; conferir(f.chave + '.relatorios', res.relatorios, e.relatorios);
            conferir(f.chave + '.visao', (await x.pedir('/api/admin/financeiro')).j.data?.financeiroCompleto, e.completo);
            conferir(f.chave + '.dashboard', (await x.pedir('/api/admin/dashboard')).j.data?.financeiroCompleto, e.completo);
            res.receber = (await x.pedir('/api/admin/financeiro/contas-receber')).status; conferir(f.chave + '.receber', res.receber, e.receber);
            conferir(f.chave + '.menu', (await x.pedir('/api/admin/autenticacao')).j.data?.recursos?.financeiroCompleto, e.completo);
            salvar();
        }
        const cruzado = await s.F1.pedir('/api/admin/financeiro/contas-pagar?empresaId=' + porChave.F2.empresa);
        r.resultados.cruzado = cruzado.status; if (cruzado.status === 200 || JSON.stringify(cruzado.j).includes('Conta sintética')) throw Object.assign(Error('CRUZADO_S2'), {parada:'S2'});

        // ---- Cotação e contratos pelo endereço público por empresa (sem sessão), regras 0% / 5% / 8% contra o legado 10%.
        marcar('MATRIZ_COTACAO');
        const q = c => '?empresa=' + c, {F1, F2, F4, F5} = porChave, c = r.resultados.cotacao = {};
        for (const [nome, caminho, esperado] of [
            ['paginaF2', '/b/' + F2.codigo + '/fechamento', 200], ['agendaPaginaF2', '/b/' + F2.codigo + '/disponibilidade', 200],
            ['paginaPremium', '/b/' + F5.codigo + '/fechamento', 200], ['pacotesPremium', '/api/fechamentos/pacotes' + q(F5.codigo), 200],
            ['pacotesF2', '/api/fechamentos/pacotes' + q(F2.codigo), 200], ['pacotesF4', '/api/fechamentos/pacotes' + q(F4.codigo), 200],
            ['essencial', '/api/fechamentos/pacotes' + q(F1.codigo), 404], ['inexistente', '/api/fechamentos/pacotes' + q('hml-inexistente'), 404],
            ['formatoRuim', '/api/fechamentos/pacotes?empresa=HML_RUIM', 404], ['pdf', '/api/fechamentos/tabela-pacotes' + q(F2.codigo), 404],
            ['paginaEssencial', '/b/' + F1.codigo + '/fechamento', 404]]) {
            const resp = await publico(caminho); c[nome] = resp.status; conferir('cotacao.' + nome, resp.status, esperado);
            if (esperado === 404 && resp.j) conferir('cotacao.' + nome + '.codigo', resp.j.codigo ?? 'PDF', nome === 'pdf' ? 'PDF' : 'COTACAO_PUBLICA_INDISPONIVEL');
        }
        conferir('cotacao.pacotesF2.lista', JSON.stringify((await publico('/api/fechamentos/pacotes' + q(F2.codigo))).j.pacotes.map(x => x.codigo)), '["POCKET"]');
        const agenda = (await publico('/api/disponibilidade?' + proximoMes() + '&empresa=' + F2.codigo)).j;
        conferir('cotacao.agenda.comercial', JSON.stringify(agenda.comercial), '{"pacoteOverrides":[],"descontos":[]}');
        let horario = null;
        for (const dia of agenda.data) for (const per of dia.periodos ?? []) for (const h of per.horarios ?? [])
            if (!horario && h.status === 'DISPONIVEL' && h.ajusteMinutos === 0) horario = {data:dia.data, base:per.codigo === 'TURNO_1' ? 'almoco' : 'noite', inicio:h.inicio, fim:h.fim};
        assert.ok(horario, 'SEM_HORARIO_DISPONIVEL');
        const cotacao = await publico('/api/fechamentos/cotacao' + q(F2.codigo), 'POST', {pacote:'pocket', dataFesta:horario.data, horarioBase:horario.base, ajusteHorario:'0',
            horarioInicio:horario.inicio, horarioFim:horario.fim, convidados:20});
        conferir('cotacao.valor', cotacao.status, 200);
        conferir('preco.cotacao.tabela', Math.round(Number(cotacao.j.data.valorTabela) * 100), precoEsperado(0));
        conferir('preco.cotacao.aplicado', Math.round(Number(cotacao.j.data.valor) * 100), precoEsperado(0));
        const cpf = cpfSintetico();
        const pedido = (codigo, extra = {}) => publico('/api/fechamentos' + q(codigo), 'POST', {identidadeTipo:'NOVO_CLIENTE', dataFesta:horario.data, horarioBase:horario.base,
            ajusteHorario:'0', horarioInicio:horario.inicio, horarioFim:horario.fim, statusDisponibilidade:'disponivel', pacote:'pocket', convidadosPagantes:20,
            buffetDefinicao:'depois', adicionaisSelecionados:[], valorCombinado:String(cotacao.j.data.valor), formaPagamento:'pix_avista',
            nomeCliente:'Cliente Sintético Homologação', cpf, email:'cliente-hml-' + randomBytes(4).toString('hex') + '@example.invalid', whatsapp:'11900000000',
            cep:'01001000', logradouro:'Rua Sintética', numero:'1', bairro:'Centro', cidade:'São Paulo', uf:'SP',
            nomeAniversariante:'Aniversariante Sintético', idadeAniversariante:5, observacoesCliente:'Pedido sintético de homologação 20261010 r3', ...extra});
        const versaoContrato = async fechamentoId => (await db.query(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' AS final,
                v.snapshot->'comercial'->>'descontoFormaPagamentoPercentual' AS desconto_forma
              FROM contrato_versoes v JOIN contratos k ON k.id = v.contrato_id WHERE k.fechamento_id = $1 ORDER BY v.numero_versao DESC LIMIT 1`, [fechamentoId])).rows[0];
        /** Condição gravada e contrato EFETIVAMENTE gerado pela API da empresa, comparados ao valor esperado independente. */
        const contratoComRegra = async (chave, fechamentoId, regra) => {
            conferir(`cotacao.pedido${chave}.empresa`, (await db.query('SELECT empresa_id::text e FROM fechamentos WHERE id=$1', [fechamentoId])).rows[0]?.e, porChave[chave].empresa);
            const cond = (await db.query("SELECT condicao_pagamento->>'descontoPercentual' AS desconto FROM fechamentos WHERE id=$1", [fechamentoId])).rows[0];
            conferir(`cotacao.pedido${chave}.regraPagamento`, cond?.desconto, String(regra));
            const k = await s[chave].post('/api/admin/contratos', {fechamentoId});
            c['contrato' + chave] = k.status; conferir(`contrato.${chave}.gerado`, k.status, 201);
            const v = await versaoContrato(fechamentoId);
            conferir(`preco.contrato${chave}.valorFinal`, Math.round(Number(v?.final) * 100), precoEsperado(regra));
            conferir(`preco.contrato${chave}.descontoForma`, Number(v?.desconto_forma), regra);
            r.resultados['contrato' + chave] = {status:k.status, valorFinalCentavos:Math.round(Number(v?.final) * 100), esperadoCentavos:precoEsperado(regra)}; salvar();
        };
        const p2 = await pedido(F2.codigo); c.pedidoF2 = p2.status; conferir('cotacao.pedidoF2', p2.status, 201); conferir('cotacao.pedidoF2.semCrm', p2.j.crm, undefined);
        conferir('preco.fechamentoF2.tabela', Math.round(Number((await db.query('SELECT valor_tabela::text AS t FROM fechamentos WHERE id=$1', [p2.j.fechamentoId])).rows[0]?.t) * 100), precoEsperado(0));
        await contratoComRegra('F2', p2.j.fechamentoId, 0); // F2 sem linha de regra (077): 0% → 150000; o legado daria 135000
        // Identidade por empresa: o CPF do cliente de F2 é visto só em F2; nem F4 nem o endereço atual (Kidmais) o enxergam.
        const consultaCpf = async codigo => (await publico('/api/identidade/consultar-cpf' + (codigo ? q(codigo) : ''), 'POST', {cpf})).j?.situacao;
        c.identidadeF2 = await consultaCpf(F2.codigo); conferir('identidade.F2', c.identidadeF2, 'CLIENTE_EXISTENTE');
        c.identidadeF4 = await consultaCpf(F4.codigo); conferir('identidade.F4', c.identidadeF4, 'NOVO_CLIENTE');
        c.identidadeKidmais = await consultaCpf(null); conferir('identidade.enderecoAtual', c.identidadeKidmais, 'NOVO_CLIENTE');
        const p4 = await pedido(F4.codigo); c.pedidoF4MesmoCpf = p4.status; conferir('cotacao.pedidoF4', p4.status, 201);
        conferir('cotacao.pedidoF4.chaves', JSON.stringify(Object.keys(p4.j).sort()), JSON.stringify(Object.keys(p2.j).sort()));
        const cli = (await db.query('SELECT c.empresa_id::text e, c.cpf FROM fechamentos f JOIN clientes c ON c.id=f.cliente_id WHERE f.id=$1', [p4.j.fechamentoId])).rows[0];
        conferir('cotacao.pedidoF4.empresa', cli?.e, F4.empresa); conferir('cotacao.pedidoF4.cpfPorEmpresa', cli?.cpf, cpf);
        await contratoComRegra('F4', p4.j.fechamentoId, REGRAS.F4.pixAvista);
        const p5 = await pedido(F5.codigo, {cpf:cpfSintetico()}); c.pedidoF5 = p5.status; conferir('cotacao.pedidoF5', p5.status, 201);
        await contratoComRegra('F5', p5.j.fechamentoId, REGRAS.F5.pixAvista);
        const kidmaisRegra = (await db.query(`SELECT r.pix_avista_percentual = 10 AND r.pix_parcelado_percentual = 3 AND r.cartao_rotulo = 'Cielo' AND r.desconto_dia_util AS ok
            FROM empresa_regras_pagamento r JOIN empresas e ON e.id = r.empresa_id WHERE e.codigo = 'kidmais'`)).rows;
        conferir('regra.kidmaisLegada', kidmaisRegra.length <= 1 && kidmaisRegra.every(x => x.ok === true), true);
        const antesF2 = (await db.query('SELECT count(*)::int n FROM fechamentos WHERE empresa_id=$1', [F2.empresa])).rows[0].n;
        const p3 = await pedido(F2.codigo, {identidadeTipo:'CLIENTE_EXISTENTE', provaIdentidade:'p'.repeat(40)});
        c.clienteExistenteProvaInvalida = p3.status; conferir('cotacao.clienteExistente.recusado', p3.status >= 400, true);
        conferir('cotacao.clienteExistente.semGravacao', (await db.query('SELECT count(*)::int n FROM fechamentos WHERE empresa_id=$1', [F2.empresa])).rows[0].n, antesF2);
        const html = (await publico('/b/' + F2.codigo + '/fechamento')).texto;
        conferir('marca.semLogoKidmais', /kidmais-logo-horizontal/.test(html), false);
        conferir('marca.iconeNeutro', html.includes('/icone-orcamento.svg'), true);
        conferir('marca.titulo', /<title>Orçamento da festa<\/title>/.test(html), true);

        // ---- Renovação nas MESMAS três pagantes. Só fixtures; mesmo dia real do início.
        marcar('RENOVACAO');
        conferir('dia.inalterado', diaBrasil(new Date()), r.diaInicio);
        for (const rodada of RODADAS.slice(0, 3)) await etapaRodada(rodada);
        for (const f of PAGANTES) conferir(f.chave + '.semEnvioAntesDoLimite', sinks[f.chave].tentativas(), 0);
        const cruzada = await s.F5.pedir('/api/admin/assinatura?empresaId=' + F2.empresa);
        conferir('tenant.renovacaoCruzada', cruzada.status === 200 && cruzada.j?.data?.renovacao?.ciclo === 'ANUAL', false);
        perder.add(r.F2.assinaturaId);
        await etapaRodada(RODADAS[3]);
        conferir('R2.erros', JSON.stringify((r.errosReprocessaveis ?? []).map(e => [e.chave, e.mensagem])), JSON.stringify([['F2','RESPOSTA_PERDIDA_SIMULADA']]));
        conferir('F2.precoAplicadoNoProvedor', (await p.obterAssinatura(esc.assinatura(r.F2.assinaturaId)))?.valorCentavos, F2.regular);
        r.resultados.emailsR2 = contarEmails(); salvar();
        conferir('R2.emails', JSON.stringify(r.resultados.emailsR2), JSON.stringify({F1:{tentativas:1, entregas:0}, F2:{tentativas:1, entregas:1}, F5:{tentativas:1, entregas:1}}));
        await etapaRodada(RODADAS[4]);
        for (const f of [F1, F5]) {
            const sub = await p.obterAssinatura(esc.assinatura(r[f.chave].assinaturaId));
            conferir(f.chave + '.semAumentoAntecipado', sub?.valorCentavos, f.fundador);
            conferir(f.chave + '.vencimentoAntesDaRegular', sub?.nextDueDate < r.tempo[f.chave].primeira, true);
        }
        // ---- Salto do próximo vencimento SÓ nas assinaturas sandbox mensais registradas (F1, F5).
        marcar('SALTO_VENCIMENTO');
        for (const f of [F1, F5]) await ajustarVencimentoDaRodada({f, r, esc, p, ajustar, salvar});
        await etapaRodada(RODADAS[5]); await etapaRodada(RODADAS[6]);
        for (const f of [F2, F5]) {
            const sub = await p.obterAssinatura(esc.assinatura(r[f.chave].assinaturaId)), cobrancas = await p.listarCobrancasDaAssinatura(sub.id);
            const d = divergenciasPrecoRegular(sub, cobrancas, f, r.tempo[f.chave], r[f.chave].pagamentoId);
            r.resultados['ASAAS_' + f.chave] = d.length ? d : 'PRECO_REGULAR_NA_DATA'; salvar();
            conferir(f.chave + '.asaas.precoRegular', d.length, 0);
        }
        const s1 = await p.obterAssinatura(esc.assinatura(r.F1.assinaturaId));
        conferir('F1.suspensa', s1?.status, 'INACTIVE'); conferir('F1.semAumento', s1?.valorCentavos, F1.fundador);
        conferir('F2.umPut', contagem.precoAssinatura?.[r.F2.assinaturaId], 1); conferir('F5.umPut', contagem.precoAssinatura?.[r.F5.assinaturaId], 1);
        conferir('F1.semPut', contagem.precoAssinatura?.[r.F1.assinaturaId], undefined);
        conferir('F1.umaSuspensao', contagem.suspensao?.[r.F1.assinaturaId], 1);
        conferir('F2F5.semSuspensao', (contagem.suspensao?.[r.F2.assinaturaId] ?? 0) + (contagem.suspensao?.[r.F5.assinaturaId] ?? 0), 0);
        for (const f of PAGANTES) { conferir(f.chave + '.tentativas', sinks[f.chave].tentativas(), TENTATIVAS[f.chave]); conferir(f.chave + '.entregas', sinks[f.chave].entregas(), ENTREGAS[f.chave]); }

        // ---- Cancelamento pela tela (Gestão, senha reconfirmada): acesso pago preservado; processador encerra a renovação.
        marcar('CANCELAMENTO');
        for (const f of [F2, F5]) {
            conferir(f.chave + '.reautenticar', (await s[f.chave].post('/api/admin/autenticacao', {acao:'reautenticar', senha:senhas.get(f.chave)})).status, 200);
            conferir(f.chave + '.cancelamento', (await s[f.chave].post('/api/admin/assinatura/cancelamento', {confirmar:true})).status, 200);
            conferir(f.chave + '.periodoPago', (await tela(f)).acesso?.nivel, 'COMPLETO');
            conferir(f.chave + '.primeiraPagaPreservada', ['RECEIVED','CONFIRMED'].includes((await p.obterCobranca(r[f.chave].pagamentoId))?.status), true);
        }
        await etapaRodada(RODADAS[7]);
        r.resultados.emails = contarEmails(); salvar();
        for (const f of PAGANTES) { conferir(f.chave + '.tentativasFinais', sinks[f.chave].tentativas(), TENTATIVAS[f.chave]); conferir(f.chave + '.entregasFinais', sinks[f.chave].entregas(), ENTREGAS[f.chave]); }

        // ---- Escopo, Kidmais e terceiros intactos (S3).
        marcar('PRESERVACAO');
        r.escopo = {empresas:Object.keys(esc.uso).map(id => PAGANTES.find(f => f.empresa === id)?.chave ?? 'FORA'), contagem};
        conferir('escopo.soPagantes', r.escopo.empresas.every(k => k !== 'FORA'), true);
        conferir('dia.final', diaBrasil(new Date()), r.diaInicio);
        r.kidmaisDepois = await kidmaisPublico();
        conferir('kidmais.pacotes', r.kidmaisDepois.pacotes, r.kidmaisAntes.pacotes); conferir('kidmais.agenda', r.kidmaisDepois.agenda, r.kidmaisAntes.agenda);
        r.depois = await preservacao();
        for (const [tabela] of PRESERVADAS) if (r.depois[tabela] !== r.antes[tabela]) throw Object.assign(Error('PRESERVACAO_S3'), {parada:'S3', tabela});
        r.aprovado = true; salvar();
    } catch (e) {
        // Erro original da rodada: registrado antes do encerramento e preservado como resultado final.
        erro = e ?? Error('FALHA_DESCONHECIDA');
        r.falha = {etapa, parada:e?.parada ?? null, item:e?.item ?? e?.tabela ?? null, obtido:e?.obtido ?? null, esperado:e?.esperado ?? null,
            http:e?.status ?? null, mensagem:String(e?.message ?? e).slice(0, 120)};
        try { salvar(); } catch { /* o encerramento roda mesmo sem gravar o estado */ }
        console.error(JSON.stringify(r.falha));
    } finally {
        // ---- Encerramento: SEMPRE roda (sucesso, falha ou parada), só sobre recursos comprovados; nunca lança.
        erro = erroFinal(erro, await encerrar({db, conectado, r, p, api, salvar}));
        if (conectado) {
            // Vagas confirmadas são permanentes (074): depois do encerramento a campanha continua com +3; terceiros idênticos.
            r.campanhaDepois = await campanha(db).catch(() => null);
            r.depoisEncerramento = await preservacao().catch(() => null);
            if (r.depoisEncerramento && r.antes && PRESERVADAS.some(([t]) => r.depoisEncerramento[t] !== r.antes[t]))
                erro = erroFinal(erro, Object.assign(Error('PRESERVACAO_APOS_ENCERRAMENTO'), {parada:'S3'}));
        }
        db?.release(); await pool.end().catch(() => {});
    }
    if (!erro && (r.campanhaDepois?.confirmadas !== r.campanhaAntes?.confirmadas + PAGANTES.length || r.campanhaDepois?.ocupadas !== r.campanhaAntes?.ocupadas + PAGANTES.length))
        erro = Error('CAMPANHA_DIVERGENTE');
    r.concluido = !erro; try { salvar(); } catch { /* idem */ }
    console.log(JSON.stringify({resultado:erro ? 'INCOMPLETO' : 'PASS', falha:r.falha ?? null, erro:erro ? String(erro.message).slice(0, 80) : null,
        modoEmail:MODO_EMAIL, tempo:r.tempo, resultados:r.resultados, campanhaAntes:r.campanhaAntes ?? null, campanhaConfirmada:r.campanhaConfirmada ?? null,
        campanhaDepois:r.campanhaDepois ?? null, vagas:Object.fromEntries(PAGANTES.map(f => [f.chave, r[f.chave]?.vagaNumero ?? null])),
        saltos:Object.fromEntries([porChave.F1, porChave.F5].map(f => [f.chave, r[f.chave]?.salto ? {antes:r[f.chave].salto.antes, alvo:r[f.chave].salto.alvo} : null])),
        encerramento:r.encerramento ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'RODADA') main().catch(e => { console.error('HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES ' + String(e?.message ?? '').slice(0, 60)); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_PAGAMENTO_RENOVACAO'); process.exitCode = 1; }
}
module.exports = {FIXTURES, PAGANTES, PRECOS, REGRAS, PRESERVADAS, FINANCEIRO, LIMITE_PESSOAS, RODADAS, REGISTROS, TELAS, EMAIL, TENTATIVAS, ENTREGAS,
    MARCA, FLAG, FLAG_ENCERRAR, ARQUIVO, DIR, MODO_EMAIL, VAGAS_CAMPANHA, HORA_LIMITE_BRT, alvo, alvoEncerramento, modo, conferir, conferirResultado,
    cabeNaCampanha, g1Presente, precoEsperado, diaBrasil, horaBrasil, somarDias, somarMeses, diasEntre, primeiraEsperada, planoTempo, relogio,
    escopo, repositorioRestrito, provedorRestrito, idSink, sinkIdempotente, envioDaFixture, ajustarVencimentoDaRodada, recursosComprovados,
    conferirRegistro, conferirTela, divergenciasPrecoRegular, encerrar, comRetentativa, SQL_REGISTROS};
