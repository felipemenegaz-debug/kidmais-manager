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
