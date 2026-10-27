import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { processarRenovacao, primeiraRenovacaoRegular, diasAntes, mensagemRenovacao, type ContextoRenovacao, type DepsRenovacao } from './renovacao-fundador.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

const E = '11111111-1111-4111-8111-111111111111';
function fixture() {
    let agora = new Date('2027-09-09T12:00:00Z');
    const c: ContextoRenovacao = { empresaId: E, contratacaoId: '22222222-2222-4222-8222-222222222222', situacao: 'ATIVA', empresaAtiva: true,
        isenta: false, assinaturaId: 'sub_1', clienteId: 'cus_1', ciclo: 'MENSAL', plano: 'ESSENCIAL', valorFinal: 11820, valorRegular: 19700,
        beneficioFim: '2027-10-09T12:00:00.000Z', primeiroPagamentoId: 'pay_1', destinatarioId: '33333333-3333-4333-8333-333333333333',
        email: 'gestor@example.invalid', destinatarioValido: true, registro: null };
    let sub: AssinaturaProvedor = { id: 'sub_1', customer: 'cus_1', externalReference: E, status: 'ACTIVE', deleted: false,
        cycle: 'MONTHLY', valorCentavos: 11820, nextDueDate: '2027-10-09' };
    const primeiro: CobrancaProvedor = { id: 'pay_1', dueDate: '2026-10-09', status: 'RECEIVED', deleted: false, paymentDate: '2026-10-09',
        invoiceUrl: null, valorCentavos: 11820, assinaturaId: 'sub_1', clienteId: 'cus_1', billingType: 'UNDEFINED' };
    const antiga: CobrancaProvedor = { ...primeiro, id: 'old', dueDate: '2027-09-09', status: 'OVERDUE' };
    const nova: CobrancaProvedor = { ...primeiro, id: 'new', dueDate: '2027-10-09', status: 'PENDING' };
    const parcelas = [primeiro,antiga,nova];
    const chamadas: string[] = [], chaves: string[] = [];
    let quedaDepoisDePreco = false, falhaEmail = false;
    const deps: DepsRenovacao = {
        agora: () => agora, origem: 'https://kidmais.example', simular: false, travar: async (_e,f) => f(),
        repositorio: {
            ler: async () => structuredClone(c),
            criar: async r => { chamadas.push('criar'); c.registro ??= structuredClone(r); return structuredClone(c.registro); },
            marcar: async (empresa,id,a) => {
                assert.equal(empresa,E); assert.equal(id,c.registro!.id); chamadas.push(`estado:${a.estado}`);
                const r = c.registro!; r.estado = a.estado; r.ultimoErro = a.erro ?? null;
                if (a.tentativa) r.avisoTentadoEm ??= agora.toISOString();
                if (a.envioId) r.avisoEnviadoEm ??= agora.toISOString();
                if (a.regular) r.precoAplicadoEm ??= agora.toISOString();
            },
        },
        enviar: async m => {
            assert.equal(c.registro!.estado,'AVISANDO', 'intenção foi persistida antes do envio');
            chamadas.push('enviar'); chaves.push(m.idempotencia!);
            if (falhaEmail) throw new Error('Resposta perdida.');
            return { provedor: 'arquivo', idExterno: 'email_1' };
        },
        provedor: {
            obterAssinatura: async () => ({ ...sub }),
            obterCobranca: async id => ({ ...parcelas.find(p => p.id === id)! }),
            listarCobrancasDaAssinatura: async () => structuredClone(parcelas),
            atualizarValorAssinatura: async (_id,v) => {
                chamadas.push('preco'); sub.valorCentavos = v;
                if (quedaDepoisDePreco) { quedaDepoisDePreco = false; throw new Error('Resposta perdida depois de aplicar.'); }
                return { ...sub };
            },
            atualizarValorCobranca: async (p,v) => { chamadas.push(`parcela:${p.id}`); const alvo = parcelas.find(x => x.id === p.id)!; alvo.valorCentavos = v; return { ...alvo }; },
            suspenderGeracao: async () => { chamadas.push('suspender'); sub = { ...sub, status: 'INACTIVE' }; return sub; },
        },
    };
    return { c,deps,sub,parcelas,chamadas,chaves, dia: (s: string) => { agora = new Date(s); },
        falharEmail: (v: boolean) => { falhaEmail = v; }, perderRespostaPreco: () => { quedaDepoisDePreco = true; } };
}

test('datas mensais preservam âncora e anual não prolonga desconto pelo atraso da primeira confirmação', () => {
    assert.equal(primeiraRenovacaoRegular('2026-01-31','2027-03-01T00:00:00Z','MENSAL'),'2027-03-31');
    assert.equal(primeiraRenovacaoRegular('2024-02-29','2025-03-05T00:00:00Z','ANUAL'),'2025-02-28');
    assert.equal(diasAntes('2027-10-09'),'2027-09-09');
    assert.throws(() => primeiraRenovacaoRegular('2026-02-30','2027-03-01','MENSAL'));
});

test('antes da janela só prepara registro durável; não envia nem muda preço', async () => {
    const f = fixture(); f.dia('2027-08-01T12:00:00Z');
    assert.equal(await processarRenovacao(E,f.deps),'AGUARDANDO_AVISO');
    assert.equal(f.c.registro?.primeiraDataRegular,'2027-10-09');
    assert.deepEqual(f.chamadas,['criar']);
});

test('avisa 30 dias antes, aumenta próximas e somente parcelas da renovação; retry não duplica', async () => {
    const f = fixture();
    assert.equal(await processarRenovacao(E,f.deps),'REGULAR');
    assert.equal(f.parcelas[1].valorCentavos,11820, 'vencida antiga não muda');
    assert.equal(f.parcelas[2].valorCentavos,19700);
    assert.equal(f.c.registro?.estado,'REGULAR');
    assert.ok(f.chamadas.indexOf('enviar') < f.chamadas.indexOf('preco'));
    assert.ok(f.chamadas.indexOf('estado:APLICANDO') < f.chamadas.indexOf('preco'));
    await processarRenovacao(E,f.deps);
    assert.equal(f.chamadas.filter(x => x === 'enviar').length,1);
    assert.equal(f.chamadas.filter(x => x === 'preco').length,1);
    assert.equal(f.chamadas.filter(x => x === 'parcela:new').length,1);
});

test('última parcela com desconto ainda não gerada adia alteração da recorrência', async () => {
    const f = fixture(); f.sub.nextDueDate = '2027-09-10';
    assert.equal(await processarRenovacao(E,f.deps),'AGUARDANDO_ULTIMA_PARCELA');
    assert.equal(f.chamadas.includes('preco'),false);
    assert.equal(f.c.registro?.estado,'AVISADA');
});

test('resposta perdida após alterar preço é reconciliada sem repetir PUT de assinatura', async () => {
    const f = fixture(); f.perderRespostaPreco();
    await assert.rejects(processarRenovacao(E,f.deps),/Resposta perdida/);
    assert.equal(f.c.registro?.estado,'APLICANDO');
    assert.equal(await processarRenovacao(E,f.deps),'REGULAR');
    assert.equal(f.chamadas.filter(x => x === 'preco').length,1);
    assert.equal(f.chamadas.filter(x => x === 'enviar').length,1);
});

test('envio incerto reutiliza chave e payload; não aumenta até confirmação', async () => {
    const f = fixture(); f.falharEmail(true);
    assert.equal(await processarRenovacao(E,f.deps),'ENVIO_INCERTO');
    const payload = structuredClone(f.c.registro!.mensagem);
    assert.equal(f.chamadas.includes('preco'),false);
    f.falharEmail(false);
    assert.equal(await processarRenovacao(E,f.deps),'REGULAR');
    assert.deepEqual(f.c.registro!.mensagem,payload);
    assert.equal(new Set(f.chaves).size,1);
});

test('fora da janela idempotente ou prazo de aviso, revisão suspende novas cobranças e permanece visível', async () => {
    const f = fixture(); f.falharEmail(true); await processarRenovacao(E,f.deps);
    f.dia('2027-09-10T12:00:00Z');
    assert.equal(await processarRenovacao(E,f.deps),'JANELA_AVISO_PERDIDA');
    assert.equal(f.c.registro?.estado,'REVISAO');
    assert.equal(f.chamadas.includes('suspender'),true);
    const n = f.chamadas.filter(x => x === 'enviar').length;
    await processarRenovacao(E,f.deps);
    assert.equal(f.c.registro?.estado,'REVISAO');
    assert.equal(f.chamadas.filter(x => x === 'enviar').length,n);
    assert.equal(f.chamadas.includes('preco'),false);
});

test('cancelada, isenta ou empresa suspensa não chama pagamento nem envia aviso', async () => {
    for (const alterar of [(c: ContextoRenovacao) => { c.isenta = true; }, (c: ContextoRenovacao) => { c.situacao = 'CANCELADA_FIM_PERIODO'; }, (c: ContextoRenovacao) => { c.empresaAtiva = false; }]) {
        const f = fixture(); alterar(f.c);
        f.deps.provedor.obterAssinatura = async () => { throw new Error('Não deve acessar provedor.'); };
        assert.equal(await processarRenovacao(E,f.deps),'CANCELADA');
        assert.deepEqual(f.chamadas,[]);
    }
});

test('Gestão revogada ou e-mail alterado não recebe aviso', async () => {
    const f = fixture(); f.dia('2027-08-01T12:00:00Z'); await processarRenovacao(E,f.deps);
    f.dia('2027-09-09T12:00:00Z'); f.c.email = 'novo@example.invalid';
    assert.equal(await processarRenovacao(E,f.deps),'DESTINATARIO_ALTERADO');
    assert.equal(f.chamadas.includes('enviar'),false);
});

test('pagamento da renovação já processado com desconto exige revisão sem cobrar diferença', async () => {
    const f = fixture(); f.parcelas[2].status = 'RECEIVED';
    assert.equal(await processarRenovacao(E,f.deps),'COBRANCA_JA_PROCESSADA');
    assert.equal(f.chamadas.includes('preco'),false);
    assert.equal(f.chamadas.some(x => x.startsWith('parcela:')),false);
});

test('parcela paga entre listagem e PUT não é reprecificada', async () => {
    const f = fixture(); const ler = f.deps.provedor.obterCobranca;
    f.deps.provedor.obterCobranca = async id => { const p = await ler(id); return id === 'new' ? { ...p!, status: 'RECEIVED' } : p; };
    assert.equal(await processarRenovacao(E,f.deps),'COBRANCA_JA_PROCESSADA');
    assert.equal(f.chamadas.includes('parcela:new'),false);
});

test('assinatura de outra empresa é recusada antes de envio ou mutação', async () => {
    const f = fixture(); f.sub.externalReference = 'outra';
    assert.equal(await processarRenovacao(E,f.deps),'IDENTIDADE_DIVERGENTE');
    assert.deepEqual(f.chamadas,[]);
});

test('simulação não grava, envia, altera preço ou suspende, inclusive nas falhas', async () => {
    for (const caso of ['aviso','tarde','regular'] as const) {
        const f = fixture();
        if (caso === 'regular') await processarRenovacao(E,f.deps);
        if (caso === 'tarde') f.dia('2027-10-01T12:00:00Z');
        f.deps.simular = true; f.chamadas.length = 0;
        const antes = JSON.stringify(f.c);
        await processarRenovacao(E,f.deps);
        assert.deepEqual(f.chamadas,[]); assert.equal(JSON.stringify(f.c),antes);
    }
});

test('mensagem contém preços, data e cancelamento; HTML é escapado', () => {
    const f = fixture(); f.c.plano = '<script>bad</script>';
    const m = mensagemRenovacao(f.c,'id','2027-10-09','https://kidmais.example');
    assert.match(m.texto,/09\/10\/2027/); assert.match(m.texto,/cancelar/);
    assert.match(m.html,/&lt;script&gt;/); assert.doesNotMatch(m.html,/<script>/);
    assert.throws(() => mensagemRenovacao(f.c,'id','2027-10-09','http://externo.example'));
});

test('075 prepara histórico imutável, vínculos e rollback que recusa dados; não há seed ou DML de empresas', () => {
    const up = readFileSync('database/migrations/20261009_075_renovacao_fundador.sql','utf8');
    const down = readFileSync('database/rollback/20261009_075_renovacao_fundador_down.sql','utf8');
    assert.match(up,/FOREIGN KEY \(empresa_id,contratacao_id\)/);
    assert.match(up,/mensagem.*criado_em\)/);
    assert.match(up,/aviso_dias = 30/);
    assert.doesNotMatch(up,/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?(?:empresas|empresa_assinaturas|assinatura_contratacoes)\b/i);
    assert.match(down,/IF EXISTS \(SELECT 1 FROM public.assinatura_renovacoes\) THEN RAISE EXCEPTION/);
});

test('CLI inicia em simulação, aplicação exige sandbox, banco local e e-mail em arquivo', () => {
    const req = createRequire(import.meta.url);
    const { configuracaoExecucao } = req('../../scripts/assinatura-renovar.cjs');
    const env = { ASAAS_AMBIENTE:'sandbox', KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://sintetico:teste@127.0.0.1:55475/kidmais_renovacao_075_sintetica',
        KIDMAIS_RECONCILIAR_ALVO:'kidmais_renovacao_075_sintetica@127.0.0.1:55475' };
    assert.equal(configuracaoExecucao(env,[]).aplicar,false);
    assert.throws(() => configuracaoExecucao({ ...env, ASAAS_AMBIENTE:'production' },[]));
    assert.throws(() => configuracaoExecucao({ ...env, EMAIL_PROVIDER:'resend' },['--aplicar']));
    assert.equal(configuracaoExecucao({ ...env, EMAIL_PROVIDER:'arquivo' },['--aplicar']).aplicar,true);
});

/** G1: evidências gravadas com o relógio do banco (real), enquanto `agora` é deslocado só no processo. */
function comRelogioDoBanco(f: ReturnType<typeof fixture>, real: { t: Date }) {
    const original = f.deps.repositorio.marcar;
    f.deps.repositorio.marcar = async (empresa, id, a) => {
        const antes = { ...f.c.registro! };
        await original(empresa, id, a);
        const r = f.c.registro!;
        if (a.tentativa && !antes.avisoTentadoEm) r.avisoTentadoEm = real.t.toISOString();
        if (a.envioId && !antes.avisoEnviadoEm) r.avisoEnviadoEm = real.t.toISOString();
        if (a.regular && !antes.precoAplicadoEm) r.precoAplicadoEm = real.t.toISOString();
    };
}

test('G1: com agora deslocado +N dias e relogioReal, retentativa 1 h após falha continua dentro da janela de 23 h', async () => {
    const f = fixture(), real = { t: new Date('2026-10-10T12:00:00Z') };
    comRelogioDoBanco(f, real); f.deps.relogioReal = () => real.t;
    f.falharEmail(true);
    assert.equal(await processarRenovacao(E,f.deps),'ENVIO_INCERTO');
    assert.equal(f.c.registro!.avisoTentadoEm,'2026-10-10T12:00:00.000Z', 'tentativa gravada no relógio real');
    real.t = new Date('2026-10-10T13:00:00Z'); f.falharEmail(false);
    assert.equal(await processarRenovacao(E,f.deps),'REGULAR', 'datas de negócio seguem o agora deslocado (limite, data regular, preço)');
    assert.equal(f.chamadas.filter(x => x === 'enviar').length,2);
    assert.equal(new Set(f.chaves).size,1, 'mesma chave de idempotência');
});

test('G1: relogioReal mede a janela de 23 h no relógio real; sem ele o comportamento anterior é mantido', async () => {
    const tarde = fixture(), real = { t: new Date('2026-10-10T12:00:00Z') };
    comRelogioDoBanco(tarde, real); tarde.deps.relogioReal = () => real.t; tarde.falharEmail(true);
    await processarRenovacao(E,tarde.deps);
    real.t = new Date('2026-10-11T11:00:00Z');
    assert.equal(await processarRenovacao(E,tarde.deps),'ENVIO_INCERTO_FORA_JANELA');
    assert.equal(tarde.chamadas.filter(x => x === 'enviar').length,1, 'sem retry cego após 23 h reais');

    const sem = fixture(), realSem = { t: new Date('2026-10-10T12:00:00Z') };
    comRelogioDoBanco(sem, realSem); sem.falharEmail(true);
    await processarRenovacao(E,sem.deps);
    realSem.t = new Date('2026-10-10T13:00:00Z'); sem.falharEmail(false);
    assert.equal(await processarRenovacao(E,sem.deps),'ENVIO_INCERTO_FORA_JANELA', 'sem relogioReal a janela usa agora (lacuna G1)');
    assert.equal(sem.c.registro!.estado,'REVISAO');

    const padrao = fixture(); padrao.falharEmail(true);
    await processarRenovacao(E,padrao.deps); padrao.falharEmail(false);
    assert.equal(await processarRenovacao(E,padrao.deps),'REGULAR', 'sem deslocamento e sem relogioReal: inalterado');
});

test('G1: relogioReal não decide datas de negócio', async () => {
    const f = fixture(); f.dia('2027-08-01T12:00:00Z');
    f.deps.relogioReal = () => new Date('2030-01-01T00:00:00Z');
    assert.equal(await processarRenovacao(E,f.deps),'AGUARDANDO_AVISO');
    assert.equal(await processarRenovacao(E,f.deps),'AGUARDANDO_AVISO');
    assert.equal(f.chamadas.includes('enviar'),false);
});

// ---- B-9 (plano rev. 3.1): modo agendado nunca grava REVISAO nem suspende; janela de aviso de 33 a 30 dias (D-B9-5).
const agendado = () => { const f = fixture(); f.deps.modoAgendado = true; return f; };
const semRevisao = (chamadas: string[]) => {
    assert.equal(chamadas.includes('estado:REVISAO'), false, 'nenhuma REVISAO gravada');
    assert.equal(chamadas.includes('suspender'), false, 'nenhuma suspensão');
};
/** N-ésima chamada (1-based) de obterAssinatura devolve o que `trocar` produzir. */
function assinaturaNaChamada(f: ReturnType<typeof fixture>, n: number, trocar: (s: AssinaturaProvedor) => AssinaturaProvedor) {
    const original = f.deps.provedor.obterAssinatura; let k = 0;
    f.deps.provedor.obterAssinatura = async (id) => { const s = await original(id); k++; return k === n ? trocar(s!) : s; };
}

test('B-9: REVISAO existente retorna antes de vigência, rede ou escrita', async () => {
    const f = agendado();
    f.c.registro = { id: 'r1', empresaId: E, contratacaoId: f.c.contratacaoId, destinatarioId: f.c.destinatarioId, primeiroVencimento: '2026-10-09',
        primeiraDataRegular: '2027-10-09', mensagem: mensagemRenovacao(f.c, 'r1', '2027-10-09', 'https://kidmais.example'), estado: 'REVISAO',
        avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: 'JANELA_AVISO_PERDIDA' };
    f.c.isenta = true; // nem a vigência é considerada antes
    f.deps.provedor.obterAssinatura = async () => { throw new Error('Rede proibida.'); };
    assert.equal(await processarRenovacao(E, f.deps), 'REVISAO_EXISTENTE');
    assert.deepEqual(f.chamadas, []);
});

test('B-9: identidade divergente inicial (linha 97) vira alerta sem escrita', async () => {
    const f = agendado(); assinaturaNaChamada(f, 1, (s) => ({ ...s, customer: 'cus_outro' }));
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_IDENTIDADE_DIVERGENTE');
    assert.deepEqual(f.chamadas, []); assert.equal(f.c.registro, null);
});

test('B-9: identidade divergente na confirmação final (linha 178), depois dos PUTs, é alerta e preserva APLICANDO', async () => {
    const f = agendado(); assinaturaNaChamada(f, 3, (s) => ({ ...s, customer: 'cus_outro' }));
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_IDENTIDADE_DIVERGENTE');
    assert.ok(f.chamadas.includes('preco')); assert.equal(f.c.registro?.estado, 'APLICANDO');
    assert.equal(f.chamadas.includes('estado:CANCELADA'), false); semRevisao(f.chamadas);
});

test('B-9: assinatura inativa com identidade conferida na confirmação final continua CANCELADA', async () => {
    const f = agendado(); assinaturaNaChamada(f, 3, (s) => ({ ...s, status: 'INACTIVE' }));
    assert.equal(await processarRenovacao(E, f.deps), 'CANCELADA');
    assert.equal(f.c.registro?.estado, 'CANCELADA'); semRevisao(f.chamadas);
});

test('B-9: caso da revisão (próximo vencimento inválido depois do aviso, sem corrida) mantém AVISADA, sem revisão nem suspensão', async () => {
    const f = agendado(); f.sub.nextDueDate = 'invalida';
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_PROXIMO_VENCIMENTO_INVALIDO');
    assert.equal(f.c.registro?.estado, 'AVISADA'); assert.ok(f.chamadas.includes('enviar')); semRevisao(f.chamadas);
    // Sem modo agendado (ferramenta restrita), o comportamento anterior continua: revisão e suspensão.
    const g = fixture(); g.sub.nextDueDate = 'invalida';
    assert.equal(await processarRenovacao(E, g.deps), 'PROXIMO_VENCIMENTO_INVALIDO');
    assert.equal(g.c.registro?.estado, 'REVISAO'); assert.ok(g.chamadas.includes('suspender'));
});

test('B-9: parcela que vira RECEIVED entre a listagem e a releitura, depois do PUT da assinatura, é alerta sem outro PUT', async () => {
    const f = agendado(); const ler = f.deps.provedor.obterCobranca;
    f.deps.provedor.obterCobranca = async (id) => { const p = await ler(id); return id === 'new' ? { ...p!, status: 'RECEIVED' } : p; };
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_COBRANCA_JA_PROCESSADA');
    assert.ok(f.chamadas.includes('preco')); assert.equal(f.chamadas.some((x) => x.startsWith('parcela:')), false);
    assert.equal(f.c.registro?.estado, 'APLICANDO'); semRevisao(f.chamadas);
});

test('B-9 idempotente: no modo agendado, registro já CANCELADA de empresa não vigente não é regravado; fora dele, continua', async () => {
    const cancelado = (f: ReturnType<typeof fixture>) => {
        f.c.registro = { id: 'r1', empresaId: E, contratacaoId: f.c.contratacaoId, destinatarioId: f.c.destinatarioId, primeiroVencimento: '2026-10-09',
            primeiraDataRegular: '2027-10-09', mensagem: mensagemRenovacao(f.c, 'r1', '2027-10-09', 'https://kidmais.example'), estado: 'CANCELADA',
            avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null };
        f.c.empresaAtiva = false;
        f.deps.provedor.obterAssinatura = async () => { throw new Error('Rede proibida.'); };
    };
    const f = agendado(); cancelado(f);
    assert.equal(await processarRenovacao(E, f.deps), 'CANCELADA');
    assert.deepEqual(f.chamadas, [], 'nenhuma escrita');
    // Ferramenta restrita (sem modo agendado): o comportamento anterior é mantido.
    const g = fixture(); cancelado(g);
    assert.equal(await processarRenovacao(E, g.deps), 'CANCELADA');
    assert.deepEqual(g.chamadas, ['estado:CANCELADA']);
    // Registro ainda não cancelado de empresa não vigente continua sendo marcado no modo agendado, em qualquer outro estado.
    for (const estado of ['PENDENTE', 'AVISANDO', 'AVISADA', 'APLICANDO', 'REGULAR'] as const) {
        const h = agendado(); cancelado(h); h.c.registro!.estado = estado;
        assert.equal(await processarRenovacao(E, h.deps), 'CANCELADA', estado);
        assert.deepEqual(h.chamadas, ['estado:CANCELADA'], estado);
    }
});

test('B-9 idempotente: no modo agendado, registro já REGULAR não é regravado; mudança real continua escrita', async () => {
    const f = agendado();
    assert.equal(await processarRenovacao(E, f.deps), 'REGULAR');
    assert.ok(f.chamadas.includes('estado:REGULAR'), 'a primeira chegada a REGULAR é gravada');
    const regular = structuredClone(f.c.registro);
    f.chamadas.length = 0;
    assert.equal(await processarRenovacao(E, f.deps), 'REGULAR');
    assert.deepEqual(f.chamadas, [], 'nenhuma escrita, envio ou PUT');
    assert.deepEqual(f.c.registro, regular);
    // Ferramenta restrita: regrava como antes.
    const g = fixture();
    assert.equal(await processarRenovacao(E, g.deps), 'REGULAR'); g.chamadas.length = 0;
    assert.equal(await processarRenovacao(E, g.deps), 'REGULAR');
    assert.deepEqual(g.chamadas, ['estado:REGULAR']);
    // REGULAR → CANCELADA (assinatura inativa) continua sendo gravado no modo agendado.
    const h = agendado();
    assert.equal(await processarRenovacao(E, h.deps), 'REGULAR'); h.chamadas.length = 0;
    assinaturaNaChamada(h, 1, (s) => ({ ...s, status: 'INACTIVE' }));
    assert.equal(await processarRenovacao(E, h.deps), 'CANCELADA');
    assert.deepEqual(h.chamadas, ['estado:CANCELADA']);
});

test('B-9: primeiro pagamento divergente não cria registro nem suspende', async () => {
    const f = agendado(); f.parcelas[0].status = 'PENDING';
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_PRIMEIRO_PAGAMENTO_DIVERGENTE');
    assert.deepEqual(f.chamadas, []);
});

test('D-B9-5: janela de 33 a 30 dias, com registro PENDENTE preexistente e sem registro', async () => {
    // primeiraDataRegular 2027-10-09: −34 = 09-05, −33 = 09-06, −31 = 09-08, −30 = 09-09, −29 = 09-10 (meio-dia em Brasília).
    for (const preexistente of [true, false]) {
        const f = agendado();
        if (preexistente) {
            f.dia('2027-08-01T15:00:00Z');
            assert.equal(await processarRenovacao(E, f.deps), 'AGUARDANDO_AVISO');
            assert.equal(f.c.registro?.estado, 'PENDENTE');
        }
        f.dia('2027-09-05T15:00:00Z');
        assert.equal(await processarRenovacao(E, f.deps), 'AGUARDANDO_AVISO', '−34 ' + preexistente);
        assert.equal(f.chamadas.includes('enviar'), false);
        f.dia('2027-09-06T15:00:00Z');
        assert.notEqual(await processarRenovacao(E, f.deps), 'AGUARDANDO_AVISO', '−33 abre ' + preexistente);
        assert.equal(f.chamadas.filter((x) => x === 'enviar').length, 1);
    }
    for (const dia of ['2027-09-08T15:00:00Z', '2027-09-09T15:00:00Z']) {
        const f = agendado(); f.dia(dia); await processarRenovacao(E, f.deps);
        assert.equal(f.chamadas.includes('enviar'), true, dia);
    }
    const tarde = agendado(); tarde.dia('2027-09-10T15:00:00Z');
    assert.equal(await processarRenovacao(E, tarde.deps), 'ALERTA_JANELA_AVISO_PERDIDA', 'empresa alcançada só depois do −30');
    assert.equal(tarde.chamadas.includes('enviar'), false); semRevisao(tarde.chamadas);
});

test('D-B9-5: falha às 23h50 do −33 e retentativa às 00h10 do −32 reenvia com a mesma chave', async () => {
    const f = agendado(); f.falharEmail(true); f.dia('2027-09-07T02:50:00Z'); // 23h50 de 06/09 em Brasília
    assert.equal(await processarRenovacao(E, f.deps), 'ENVIO_INCERTO');
    f.falharEmail(false); f.dia('2027-09-07T03:10:00Z'); // 00h10 de 07/09
    assert.notEqual(await processarRenovacao(E, f.deps), 'ENVIO_INCERTO');
    assert.equal(new Set(f.chaves).size, 1); assert.equal(f.chamadas.filter((x) => x === 'enviar').length, 2);
});

test('retentativa estritamente abaixo de 23 h da primeira tentativa (o relógio não reinicia)', async () => {
    const base = Date.parse('2027-09-06T13:00:00Z');
    for (const [desvio, reenvia] of [[23 * 3600000 - 1, true], [23 * 3600000, false], [23 * 3600000 + 1, false]] as const) {
        const f = agendado(); f.falharEmail(true); f.dia(new Date(base).toISOString());
        await processarRenovacao(E, f.deps);
        f.dia(new Date(base + 3600000).toISOString());
        await processarRenovacao(E, f.deps); // segunda falha não reinicia o relógio
        f.falharEmail(false); f.dia(new Date(base + desvio).toISOString());
        const r = await processarRenovacao(E, f.deps);
        if (reenvia) assert.equal(f.chamadas.filter((x) => x === 'enviar').length, 3, String(desvio));
        else { assert.equal(r, 'ALERTA_ENVIO_INCERTO_FORA_JANELA', String(desvio)); semRevisao(f.chamadas); }
    }
});

test('meia-noite do −30: envio aceito depois da virada é recusado pela guarda da 075 → ENVIO_INCERTO em AVISANDO; no −29, alerta', async () => {
    const f = agendado(); f.dia('2027-09-10T02:59:59Z'); // 23h59m59s de 09/09 (−30) em Brasília
    const marcar = f.deps.repositorio.marcar;
    f.deps.repositorio.marcar = async (e, id, a) => {
        // Reproduz o CHECK da 075: aviso_enviado_em (Brasília) <= primeira_data_regular − 30.
        if (a.envioId && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(f.deps.agora()) > '2027-09-09') throw new Error('CHECK 075');
        return marcar(e, id, a);
    };
    const enviar = f.deps.enviar;
    f.deps.enviar = async (m) => { const r = await enviar(m); f.dia('2027-09-10T03:00:01Z'); return r; }; // aceito depois da virada
    assert.equal(await processarRenovacao(E, f.deps), 'ENVIO_INCERTO');
    assert.equal(f.c.registro?.estado, 'AVISANDO'); assert.equal(f.c.registro?.avisoEnviadoEm, null);
    f.dia('2027-09-10T15:00:00Z');
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_JANELA_AVISO_PERDIDA');
    assert.equal(f.c.registro?.estado, 'AVISANDO'); semRevisao(f.chamadas);
});
