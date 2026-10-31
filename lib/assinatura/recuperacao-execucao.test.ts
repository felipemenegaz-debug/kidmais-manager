import assert from 'node:assert/strict';
import test from 'node:test';
import {
    avaliarLiberacao, CODIGOS_ANTIGOS, codigoFinal, codigoNoAr, codigoSeguro, conferirFila, conferirVinculoDasDecisoes, divergenciasDeMarcadores, EVENTOS_OBRIGATORIOS,
    falhaDeCobertura, falhaDoCaso,
    lerCobrancasRemotas, lerDecisoes, MARCADORES, MARCADORES_NEUTROS, marcadoresDoAmbiente, MODOS, modoAdmitido, orfasRemotas, proporDuasVezes, validarBackup, validarProvaCronAntigo,
    type ConferenciaFila, type Decisoes,
} from './recuperacao-execucao.ts';
import { identidadeDoCaso, type PropostaDoCaso } from './recuperacao-casos.ts';
import { hashCanonico } from './recuperacao-hash.ts';
import { AsaasFalhou, type CobrancaProvedor, type WebhookProvedor } from './asaas.ts';
import { EVENTOS_SUPORTADOS } from './sincronizacao.ts';

/** B-14 (plano rev. 8.1, §3.2, §3.6–§3.10, §5): regras da execução, sem banco nem rede. */
const URL_WEBHOOK = 'https://kidmais.example/api/integracoes/asaas/webhook';
const webhook = (extra: Partial<WebhookProvedor> = {}): WebhookProvedor => ({ id: 'wh_1', url: URL_WEBHOOK, enabled: true, interrupted: false, sendType: 'SEQUENTIALLY',
    events: [...EVENTOS_OBRIGATORIOS, 'PAYMENT_CREATED'], ...extra });
const lista = (...ws: WebhookProvedor[]) => async () => ({ itens: ws, totalCount: ws.length });

test('códigos (§3.10): 1 domina; 3 nunca vira 2; RESTORE nunca 0; JANELA 0 só sem pendência', () => {
    assert.equal(codigoFinal({ modo: 'JANELA', recusaTecnica: true, coberturaIncompleta: true, pendencias: 3 }), 1);
    assert.equal(codigoFinal({ modo: 'JANELA', recusaTecnica: false, coberturaIncompleta: true, pendencias: 3 }), 3);
    assert.equal(codigoFinal({ modo: 'JANELA', recusaTecnica: false, coberturaIncompleta: false, pendencias: 1 }), 2);
    assert.equal(codigoFinal({ modo: 'JANELA', recusaTecnica: false, coberturaIncompleta: false, pendencias: 0 }), 0);
    assert.equal(codigoFinal({ modo: 'RESTORE', recusaTecnica: false, coberturaIncompleta: false, pendencias: 0 }), 2);
    assert.equal(codigoFinal({ modo: 'RESTORE', recusaTecnica: false, coberturaIncompleta: true, pendencias: 0 }), 3);
});

test('fila (§3.7): configuração única, habilitada, não interrompida, SEQUENTIALLY e os 11 eventos', async () => {
    assert.ok(EVENTOS_OBRIGATORIOS.every((e) => EVENTOS_SUPORTADOS.has(e)));
    assert.equal(EVENTOS_OBRIGATORIOS.length, 11);
    assert.deepEqual((await conferirFila(lista(webhook(), webhook({ id: 'outro', url: 'https://outro.example/x' })), URL_WEBHOOK)).codigo, 0);
    // Barra final e maiúsculas no host não mudam a rota.
    assert.equal((await conferirFila(lista(webhook({ url: 'https://KIDMAIS.example/api/integracoes/asaas/webhook/' })), URL_WEBHOOK)).codigo, 0);
    const casos: [string, WebhookProvedor[], string[]][] = [
        ['zero', [], ['SEM_CONFIGURACAO']],
        ['duas', [webhook(), webhook({ id: 'wh_2' })], ['CONFIGURACAO_DUPLICADA']],
        ['desabilitada', [webhook({ enabled: false })], ['DESABILITADA']],
        ['interrompida', [webhook({ interrupted: true })], ['INTERROMPIDA']],
        ['sendType', [webhook({ sendType: 'NON_SEQUENTIALLY' })], ['SEND_TYPE']],
    ];
    for (const [rotulo, ws, motivos] of casos) {
        const f = await conferirFila(lista(...ws), URL_WEBHOOK);
        assert.deepEqual([f.codigo, f.motivos], [2, motivos], rotulo);
        assert.equal(f.soInterrompida, rotulo === 'interrompida', rotulo);
    }
    for (const e of EVENTOS_OBRIGATORIOS) {
        const f = await conferirFila(lista(webhook({ events: EVENTOS_OBRIGATORIOS.filter((x) => x !== e) })), URL_WEBHOOK);
        assert.deepEqual([f.codigo, f.motivos, f.faltantes], [2, ['EVENTOS_FALTANDO'], [e]], e);
    }
    // Interrompida E faltando evento: não é a exceção da liberação.
    assert.equal((await conferirFila(lista(webhook({ interrupted: true, events: [] })), URL_WEBHOOK)).soInterrompida, false);
    const incompleta = await conferirFila(async () => { throw new AsaasFalhou('listar webhooks', null, 'LISTA_INCOMPLETA'); }, URL_WEBHOOK);
    assert.deepEqual([incompleta.codigo, incompleta.motivos], [3, ['LISTAGEM_INCOMPLETA']]);
    // Nada além de estado e eventos: nem URL nem id.
    assert.equal(JSON.stringify(await conferirFila(lista(webhook({ enabled: false })), URL_WEBHOOK)).includes('kidmais.example'), false);
});

test('matriz ramo × código × schema (§3.8)', () => {
    assert.deepEqual([...MODOS].sort(), ['fila', 'janela-conferir', 'janela-recuperar', 'restore-aplicar', 'restore-conferir', 'restore-drenagem', 'restore-inventario', 'restore-liberacao']);
    for (const m of MODOS) assert.equal(modoAdmitido(null, 'CANDIDATA', m), m === 'fila', `fora da lista: ${m}`);
    for (const m of MODOS) assert.equal(modoAdmitido(9, null, m), m === 'fila', `código desconhecido: ${m}`);
    // Código antigo: P0a/P0b com conferir + RESTORE; P1–P4 só RESTORE; P5…P11 só fila.
    assert.equal(modoAdmitido(0, 'ANTIGO', 'janela-conferir'), true);
    assert.equal(modoAdmitido(1, 'ANTIGO', 'janela-recuperar'), false);
    assert.equal(modoAdmitido(3, 'ANTIGO', 'janela-conferir'), false);
    assert.equal(modoAdmitido(3, 'ANTIGO', 'restore-inventario'), true);
    for (let i = 5; i <= 11; i++) for (const m of MODOS) assert.equal(modoAdmitido(i, 'ANTIGO', m), m === 'fila', `P${i} antigo ${m}`);
    // Candidata: JANELA completa e RESTORE a partir do P4.
    for (let i = 4; i <= 11; i++) for (const m of MODOS) assert.equal(modoAdmitido(i, 'CANDIDATA', m), true);
    assert.equal(modoAdmitido(3, 'CANDIDATA', 'janela-conferir'), false);
});

test('código no ar: candidata exata ou uma base antiga da lista fechada (B-23); outro commit recusa', () => {
    const cand = 'a'.repeat(40);
    assert.equal(codigoNoAr(cand, cand), 'CANDIDATA');
    // B-23: as duas bases de production (#232 e #274), por SHA completo; maiúsculas e espaços como o Render pode entregar.
    assert.deepEqual([...CODIGOS_ANTIGOS], ['00d3019ade199ce609eab296050e07f4b379e87b', '4ef9adb6830f0816f8a2f2ae0c98e16b8357db61']);
    for (const antigo of CODIGOS_ANTIGOS) {
        assert.equal(codigoNoAr(antigo, cand), 'ANTIGO', antigo);
        assert.equal(codigoNoAr(` ${antigo.toUpperCase()} `, cand), 'ANTIGO', antigo);
    }
    assert.ok(Object.isFrozen(CODIGOS_ANTIGOS));
    // Antes do B-23 bastava o prefixo `00d3019a`; agora qualquer outro SHA com o mesmo prefixo recusa.
    assert.equal(codigoNoAr(`00d3019a${'0'.repeat(32)}`, cand), null);
    assert.equal(codigoNoAr(`4ef9adb6${'0'.repeat(32)}`, cand), null);
    // A candidata vence quando coincide com uma base antiga (nunca deveria; a entrada declara a candidata).
    assert.equal(codigoNoAr(CODIGOS_ANTIGOS[1], CODIGOS_ANTIGOS[1]), 'CANDIDATA');
    assert.equal(codigoNoAr('b'.repeat(40), cand), null);
    assert.equal(codigoNoAr(undefined, cand), null);
    assert.equal(codigoNoAr('abc', 'abc'), null);
});

test('migrações declaradas × marcadores presentes: qualquer divergência recusa', () => {
    assert.deepEqual(divergenciasDeMarcadores(['089', '092', '093'], new Set(['089', '093'])), []);
    assert.deepEqual(divergenciasDeMarcadores(['089'], new Set(['089', '095'])), ['095']);
    assert.deepEqual(divergenciasDeMarcadores(['089', '097'], new Set(['089'])), ['097']);
    assert.equal(Object.keys(MARCADORES).includes('092'), false, '092/099/100 só pelo CONFERIR do B-5');
});

test('marcadores das neutras (PH): conferidos só em sandbox; production inalterado', () => {
    assert.deepEqual(Object.keys(marcadoresDoAmbiente('producao')).sort(), Object.keys(MARCADORES).sort());
    assert.deepEqual(Object.keys(marcadoresDoAmbiente('sandbox')).sort(), [...Object.keys(MARCADORES), ...Object.keys(MARCADORES_NEUTROS)].sort());
    const sb = marcadoresDoAmbiente('sandbox');
    // 105 presente e não declarada (ou declarada e ausente) recusa em sandbox; em production nem é olhada.
    assert.deepEqual(divergenciasDeMarcadores(['089'], new Set(['089', '105']), sb), ['105']);
    assert.deepEqual(divergenciasDeMarcadores(['089', '102'], new Set(['089']), sb), ['102']);
    assert.deepEqual(divergenciasDeMarcadores(['089'], new Set(['089', '105'])), []);
    assert.equal(Object.hasOwn(MARCADORES_NEUTROS, '103'), false, '103 só insere uma linha: sem objeto próprio');
});

test('backup (D-B14-2/12): mesmo banco, validado, sha, até 24 h e, no RESTORE, depois do restore', () => {
    const agora = Date.parse('2026-10-28T12:00:00Z');
    const ok = { banco: 'kidmais_production', sha256: 'f'.repeat(64), validado: true, concluido_em: '2026-10-28T11:00:00Z' };
    assert.equal(validarBackup(ok, { banco: 'kidmais_production', agoraMs: agora }), null);
    assert.equal(validarBackup(null, { banco: 'kidmais_production', agoraMs: agora }), 'BACKUP_ILEGIVEL');
    assert.equal(validarBackup({ ...ok, banco: 'x' }, { banco: 'kidmais_production', agoraMs: agora }), 'BACKUP_DE_OUTRO_BANCO');
    assert.equal(validarBackup({ ...ok, sha256: 'x' }, { banco: 'kidmais_production', agoraMs: agora }), 'BACKUP_SEM_SHA');
    assert.equal(validarBackup({ ...ok, validado: false }, { banco: 'kidmais_production', agoraMs: agora }), 'BACKUP_NAO_VALIDADO');
    assert.equal(validarBackup({ ...ok, concluido_em: '2026-10-27T11:00:00Z' }, { banco: 'kidmais_production', agoraMs: agora }), 'BACKUP_FORA_DO_PRAZO');
    assert.equal(validarBackup(ok, { banco: 'kidmais_production', agoraMs: agora, restauradoEmMs: Date.parse('2026-10-28T11:30:00Z') }), 'BACKUP_ANTERIOR_AO_RESTORE');
});

test('prova do cron antigo (D-B14-18): só os cinco campos, do artefato 7ce0916f', () => {
    const ok = { artefato: '7ce0916f', concluida: true, codigo: 0, relatorio: { divergente: false, incompleto: false, kidmais: { violada: false } } };
    assert.equal(validarProvaCronAntigo(ok), null);
    assert.equal(validarProvaCronAntigo({ ...ok, artefato: 'outro' }), 'ARTEFATO_DIFERENTE');
    assert.equal(validarProvaCronAntigo({ ...ok, concluida: false }), 'EXECUCAO_NAO_CONCLUIDA');
    assert.equal(validarProvaCronAntigo({ ...ok, codigo: 2 }), 'CODIGO_DIFERENTE_DE_0');
    assert.equal(validarProvaCronAntigo({ ...ok, relatorio: { ...ok.relatorio, divergente: true } }), 'DIVERGENTE');
    assert.equal(validarProvaCronAntigo({ ...ok, relatorio: { ...ok.relatorio, incompleto: true } }), 'INCOMPLETO');
    assert.equal(validarProvaCronAntigo({ ...ok, relatorio: { divergente: false, incompleto: false } }), 'GRATUIDADE_VIOLADA');
    // O formato do artefato não tem pendentesConhecidos: a prova não depende dele.
    assert.equal(validarProvaCronAntigo({ ...ok, relatorio: { ...ok.relatorio, pendentesConhecidos: [] } }), null);
});

const ID1 = '1'.repeat(64), ID2 = '2'.repeat(64), ORFA = '3'.repeat(64);
const filaOk: ConferenciaFila = { codigo: 0, motivos: [], configuracoes: 1, enabled: true, interrupted: false, sendType: 'SEQUENTIALLY', faltantes: [], soInterrompida: false };
const INV = '11111111-1111-4111-8111-111111111111', H1 = 'a'.repeat(64);
const inventario = { formato: 1 as const, execucao: INV, schema: 'P9', codigoNoAr: 'CANDIDATA' as const, reinicio: '2026-10-28T10:00:00.000Z',
    casos: [{ identidade: ID1, hash: H1 }, { identidade: ID2, hash: null }], orfas: [{ identidade: ORFA }] };
const dec = (extra: Partial<Decisoes> = {}): Decisoes => ({ formato: 2, inventario: INV, digestInventario: hashCanonico(inventario),
    casos: { [ID1]: { decisao: 'APLICAR', proposta: H1 }, [ID2]: { decisao: 'NENHUMA', proposta: null } }, orfas: { [ORFA]: 'ACEITA' }, eventosSemEmpresa: {}, coberturaAceita: false, retencaoAceita: false, ...extra });
const SEM = '6'.repeat(64);
const DISP = { disposicao: 'SEM_EFEITO_COMPROVADO' as const, evidencia: 'Asaas sandbox: assinatura de teste apagada, sem cobrança' };
const invSem = { ...inventario, eventosSemEmpresa: [SEM], contextoSemEmpresa: [{ identidade: SEM, tipo: 'PAYMENT_CONFIRMED', situacao: 'PENDENTE',
    recebidoEm: '2026-10-28T09:00:00.000000Z', motivo: 'ASSINATURA_SEM_EMPRESA_LOCAL', referencias: { evento: 'evt_1', assinatura: 'sub_1', cobranca: null, referenciaExterna: null } }] };
const decSem = (extra: Partial<Decisoes> = {}) => dec({ digestInventario: hashCanonico(invSem), eventosSemEmpresa: { [SEM]: DISP }, ...extra });

test('decisões: lista fechada de valores, ids opacos e o inventário (execução + digest)', () => {
    assert.deepEqual(lerDecisoes(dec()), dec());
    assert.throws(() => lerDecisoes({ ...dec(), casos: { [ID1]: { decisao: 'TALVEZ', proposta: H1 } } }), /DECISOES_INVALIDAS/);
    assert.throws(() => lerDecisoes({ ...dec(), casos: { 'empresa-x': { decisao: 'APLICAR', proposta: null } } }), /DECISOES_INVALIDAS/);
    assert.throws(() => lerDecisoes({ ...dec(), formato: 1 }), /DECISOES_INVALIDAS/);
    assert.throws(() => lerDecisoes({ ...dec(), inventario: 'NAO_EXISTE' }), /DECISOES_INVALIDAS/);
    assert.throws(() => lerDecisoes({ ...dec(), retencaoAceita: undefined }), /DECISOES_INVALIDAS/);
    // Achado do H7 + P2-1 (Astra): eventos sem empresa (opcional; ausente = nenhuma decisão), id opaco, disposição da lista
    // fechada e evidência curta. Aceite nu (ACEITA), risco assumido, evidência vazia/curta/multilinha ou campo a mais: recusa.
    const semCampo: Partial<Decisoes> = dec();
    delete semCampo.eventosSemEmpresa;
    assert.deepEqual(lerDecisoes(semCampo).eventosSemEmpresa, {});
    assert.deepEqual(lerDecisoes(decSem()).eventosSemEmpresa, { [SEM]: DISP });
    assert.deepEqual(lerDecisoes(decSem({ eventosSemEmpresa: { [SEM]: { disposicao: 'TRATADO_FORA', evidencia: '  chamado 123 no Asaas, estornado  ' } } })).eventosSemEmpresa,
        { [SEM]: { disposicao: 'TRATADO_FORA', evidencia: 'chamado 123 no Asaas, estornado' } });
    const invalida = (v: unknown) => assert.throws(() => lerDecisoes({ ...dec(), eventosSemEmpresa: { [SEM]: v } }), /DECISOES_INVALIDAS/, JSON.stringify(v));
    for (const v of ['ACEITA', null, { disposicao: 'RISCO_ASSUMIDO', evidencia: DISP.evidencia }, { disposicao: 'SEM_EFEITO_COMPROVADO' },
        { ...DISP, evidencia: 'curta' }, { ...DISP, evidencia: '          ' }, { ...DISP, evidencia: 'linha um\nlinha dois' }, { ...DISP, evidencia: 'protocolo 42 estorno concluido' }, { ...DISP, evidencia: 'protocolo 42 estorno concluido' },
        { ...DISP, evidencia: 'x'.repeat(501) },
        { ...DISP, extra: 1 }]) invalida(v);
    assert.throws(() => lerDecisoes({ ...dec(), eventosSemEmpresa: { 'evento-x': DISP } }), /DECISOES_INVALIDAS/);
    assert.throws(() => lerDecisoes({ ...dec(), eventosSemEmpresa: [SEM] }), /DECISOES_INVALIDAS/);
});

test('P2-4 (incremento 4): decisões presas ao inventário que declaram', () => {
    const ctx = { schema: 'P9', codigoNoAr: 'CANDIDATA' as const, reinicio: inventario.reinicio };
    assert.equal(conferirVinculoDasDecisoes(dec(), inventario, ctx), null);
    assert.equal(conferirVinculoDasDecisoes(dec(), null, ctx), 'INVENTARIO_DAS_DECISOES_INEXISTENTE');
    assert.equal(conferirVinculoDasDecisoes(dec({ inventario: '22222222-2222-4222-8222-222222222222' }), inventario, ctx), 'INVENTARIO_DAS_DECISOES_INEXISTENTE');
    assert.equal(conferirVinculoDasDecisoes(dec(), { ...inventario, casos: [...inventario.casos, { identidade: '9'.repeat(64), hash: null }] }, ctx), 'INVENTARIO_DAS_DECISOES_ALTERADO');
    assert.equal(conferirVinculoDasDecisoes(dec(), inventario, { ...ctx, reinicio: '2026-10-29T00:00:00.000Z' }), 'INVENTARIO_DE_OUTRO_CONTEXTO');
    assert.equal(conferirVinculoDasDecisoes(dec(), inventario, { ...ctx, codigoNoAr: 'ANTIGO' }), 'INVENTARIO_DE_OUTRO_CONTEXTO');
    // Decisão sobre outra proposta (hash diferente do apresentado), caso a mais, caso sem decisão, órfã a mais.
    assert.equal(conferirVinculoDasDecisoes(dec({ casos: { [ID1]: { decisao: 'APLICAR', proposta: 'b'.repeat(64) }, [ID2]: { decisao: 'NENHUMA', proposta: null } } }), inventario, ctx), 'DECISAO_FORA_DO_INVENTARIO');
    assert.equal(conferirVinculoDasDecisoes(dec({ casos: { ...dec().casos, ['8'.repeat(64)]: { decisao: 'OUTRA', proposta: null } } }), inventario, ctx), 'DECISAO_FORA_DO_INVENTARIO');
    assert.equal(conferirVinculoDasDecisoes(dec({ casos: { [ID1]: { decisao: 'APLICAR', proposta: H1 } } }), inventario, ctx), 'CASO_DO_INVENTARIO_SEM_DECISAO');
    assert.equal(conferirVinculoDasDecisoes(dec({ orfas: {} }), inventario, ctx), 'ORFAS_FORA_DO_INVENTARIO');
    // Achado do H7: evento sem empresa do inventário exige decisão; decisão de evento fora do inventário é recusada; P2-1:
    // o inventário tem de trazer o contexto apresentado (o de antes da correção, só com ids, não serve).
    assert.equal(conferirVinculoDasDecisoes(decSem(), invSem, ctx), null);
    assert.equal(conferirVinculoDasDecisoes(decSem({ eventosSemEmpresa: {} }), invSem, ctx), 'EVENTO_SEM_EMPRESA_DO_INVENTARIO_SEM_DECISAO');
    assert.equal(conferirVinculoDasDecisoes(dec({ eventosSemEmpresa: { [SEM]: DISP } }), inventario, ctx), 'EVENTOS_SEM_EMPRESA_FORA_DO_INVENTARIO');
    assert.equal(conferirVinculoDasDecisoes(decSem({ eventosSemEmpresa: { [SEM]: DISP, ['7'.repeat(64)]: DISP } }), invSem, ctx), 'EVENTOS_SEM_EMPRESA_FORA_DO_INVENTARIO');
    const semContexto = { ...inventario, eventosSemEmpresa: [SEM] };
    assert.equal(conferirVinculoDasDecisoes(decSem({ digestInventario: hashCanonico(semContexto) }), semContexto, ctx), 'EVENTO_SEM_EMPRESA_SEM_CONTEXTO');
    // O contexto é parte do arquivo: alterá-lo depois da decisão muda o digest.
    const outroContexto = { ...invSem, contextoSemEmpresa: [{ ...invSem.contextoSemEmpresa[0], tipo: 'PAYMENT_DELETED' }] };
    assert.equal(conferirVinculoDasDecisoes(decSem(), outroContexto, ctx), 'INVENTARIO_DAS_DECISOES_ALTERADO');
});

test('P2-7: falha absorvida pelo serviço (evento FALHOU) conta como falha do caso', () => {
    const p = (falha: string | null, resultado: unknown) => ({ falha, resultado }) as unknown as PropostaDoCaso;
    assert.equal(falhaDoCaso(p('ERRO_INTERNO: X', null)), 'ERRO_INTERNO: X');
    assert.equal(falhaDoCaso(p(null, { situacao: 'FALHOU', motivo: 'PROVEDOR_INDISPONIVEL: obter cobrança (503)' })), 'PROVEDOR_INDISPONIVEL: obter cobrança (503)');
    assert.equal(falhaDeCobertura(falhaDoCaso(p(null, { situacao: 'FALHOU', motivo: 'PROVEDOR_INDISPONIVEL: x' }))), true);
    assert.equal(falhaDoCaso(p(null, { situacao: 'FALHOU' })), 'EVENTO_FALHOU');
    assert.equal(falhaDoCaso(p(null, { situacao: 'PROCESSADO' })), null);
});

test('liberação (§5): tudo decidido, tudo SEM_EFEITO, órfãs decididas, cobertura aceita e fila 0', () => {
    const itens = [{ identidade: ID1, semEfeito: true, falha: null }, { identidade: ID2, semEfeito: true, falha: null }];
    const base = { itens, orfas: [ORFA], semEmpresa: [] as string[], coberturaIncompleta: false, decisoes: dec(), fila: filaOk, codigo: 'CANDIDATA' as const, provaCronAntigo: null, retencaoAcima14Dias: false };
    assert.deepEqual(avaliarLiberacao(base), { liberada: true, bloqueios: [], exigenciasPosReabertura: [], excecaoExpressa: false });
    // Achado do H7 (EVENTO_SEM_EMPRESA): sem aceite bloqueia só pelo motivo próprio (não CASO_SEM_DECISAO/COM_EFEITO_NORMAL);
    // aceito libera; evento novo (não aceito) depois do inventário bloqueia.
    assert.deepEqual(avaliarLiberacao({ ...base, semEmpresa: [SEM] }).bloqueios, ['EVENTO_SEM_EMPRESA_SEM_DECISAO']);
    assert.equal(avaliarLiberacao({ ...base, semEmpresa: [SEM], decisoes: decSem() }).liberada, true);
    assert.deepEqual(avaliarLiberacao({ ...base, semEmpresa: [SEM, '7'.repeat(64)], decisoes: decSem() }).bloqueios, ['EVENTO_SEM_EMPRESA_SEM_DECISAO']);
    // "Nenhuma ação" com efeito normal bloqueia (D-B14-17).
    assert.deepEqual(avaliarLiberacao({ ...base, itens: [itens[0], { identidade: ID2, semEfeito: false, falha: null }] }).bloqueios, ['COM_EFEITO_NORMAL']);
    assert.deepEqual(avaliarLiberacao({ ...base, itens: [...itens, { identidade: '4'.repeat(64), semEfeito: true, falha: null }] }).bloqueios, ['CASO_SEM_DECISAO']);
    assert.deepEqual(avaliarLiberacao({ ...base, orfas: [ORFA, '5'.repeat(64)] }).bloqueios, ['ORFA_SEM_DECISAO']);
    assert.deepEqual(avaliarLiberacao({ ...base, coberturaIncompleta: true }).bloqueios, ['COBERTURA_NAO_ACEITA']);
    assert.equal(avaliarLiberacao({ ...base, coberturaIncompleta: true, decisoes: dec({ coberturaAceita: true }) }).liberada, true);
    // P2-8: retenção acima de 14 dias exige aceite próprio (o da cobertura não serve).
    assert.deepEqual(avaliarLiberacao({ ...base, retencaoAcima14Dias: true, decisoes: dec({ coberturaAceita: true }) }).bloqueios, ['RETENCAO_ACIMA_DE_14_DIAS_NAO_ACEITA']);
    assert.equal(avaliarLiberacao({ ...base, retencaoAcima14Dias: true, decisoes: dec({ retencaoAceita: true }) }).liberada, true);
    // Fila: só `interrupted` libera, com as três exigências depois da reabertura; qualquer outro motivo bloqueia.
    const interrompida = avaliarLiberacao({ ...base, fila: { ...filaOk, codigo: 2, motivos: ['INTERROMPIDA'], interrupted: true, soInterrompida: true } });
    assert.deepEqual([interrompida.liberada, interrompida.exigenciasPosReabertura], [true, ['REATIVAR_FILA', 'NOVA_LEITURA_FILA_CODIGO_0', 'CONFIRMAR_ENTREGA']]);
    for (const motivos of [['DESABILITADA'], ['SEND_TYPE'], ['EVENTOS_FALTANDO'], ['SEM_CONFIGURACAO'], ['INTERROMPIDA', 'EVENTOS_FALTANDO']])
        assert.equal(avaliarLiberacao({ ...base, fila: { ...filaOk, codigo: 2, motivos, soInterrompida: false } }).liberada, false, motivos.join());
    assert.equal(avaliarLiberacao({ ...base, fila: { ...filaOk, codigo: 3, motivos: ['LISTAGEM_INCOMPLETA'] } }).liberada, false);
    // Código antigo: a prova é o cron antigo (exceção expressa); o efeito sob a candidata vira evidência complementar.
    const antigo = { ...base, codigo: 'ANTIGO' as const, itens: [itens[0], { identidade: ID2, semEfeito: false, falha: null }] };
    assert.deepEqual(avaliarLiberacao({ ...antigo, provaCronAntigo: null }), { liberada: true, bloqueios: [], exigenciasPosReabertura: [], excecaoExpressa: true });
    assert.deepEqual(avaliarLiberacao({ ...antigo, provaCronAntigo: 'DIVERGENTE' }).bloqueios, ['SEM_PROVA_DO_CRON_ANTIGO:DIVERGENTE']);
});

const proposta = (hash: string | null, falha: string | null = null) => ({ caso: { tipo: 'PEDIDO', id: 'p', empresaId: 'e' }, identidade: 'i', falha, hash, proposta: null,
    semEfeito: false, resultado: null, antes: null }) as unknown as PropostaDoCaso;

test('dupla leitura por caso (§3.6 b): igual → CONSISTENTE; diferente e igual na 3ª → RELIDO; mudou de novo → INCONCLUSIVO', async () => {
    const sequencia = (...hs: (string | null)[]) => { let k = 0; return async () => proposta(hs[k++] ?? null); };
    assert.equal((await proporDuasVezes(sequencia('a', 'a'))).consistencia, 'CONSISTENTE');
    const relido = await proporDuasVezes(sequencia('a', 'b', 'b'));
    assert.deepEqual([relido.consistencia, relido.p.hash], ['RELIDO', 'b']);
    assert.equal((await proporDuasVezes(sequencia('a', 'b', 'c'))).consistencia, 'INCONCLUSIVO');
    // Revisão do HB-3 (28/10): coluna comercial do instante (cancelada_em = agora) não torna o caso instável; a leitura sim.
    const cancelamento = (cancelada: string | null, leitura = 'L1') => ({ caso: { tipo: 'EMPRESA', id: 'e', empresaId: 'e' }, identidade: 'i', falha: null, hash: `h-${cancelada}-${leitura}`,
        proposta: { formato: 1, caso: 'i', precondicoes: { local: 'x', remoto: [leitura] }, efeitos: [{ tabela: 'empresa_assinaturas', chave: 'e', operacao: 'UPDATE',
            colunas: { situacao: { antes: 'ATIVA', depois: 'CANCELADA_FIM_PERIODO' }, cancelada_em: { antes: null, depois: cancelada } } }] },
        semEfeito: false, resultado: null, antes: null }) as unknown as PropostaDoCaso;
    const em = (...xs: PropostaDoCaso[]) => { let k = 0; return async () => xs[k++]; };
    assert.equal((await proporDuasVezes(em(cancelamento('2026-10-28T10:00:00.001Z'), cancelamento('2026-10-28T10:00:00.009Z')))).consistencia, 'CONSISTENTE');
    assert.equal((await proporDuasVezes(em(cancelamento('2026-10-28T10:00:00.001Z'), cancelamento(null), cancelamento('2026-10-28T10:00:00.009Z')))).consistencia, 'INCONCLUSIVO',
        'presença × ausência do instante continua contando');
    assert.equal((await proporDuasVezes(em(cancelamento('t1', 'L1'), cancelamento('t2', 'L2'), cancelamento('t3', 'L3')))).consistencia, 'INCONCLUSIVO', 'leitura que muda');
    let n = 0;
    await proporDuasVezes(async () => { n++; return proposta('x'); });
    assert.equal(n, 2, 'só duas leituras quando iguais');
    assert.equal(falhaDeCobertura('PROVEDOR_INDISPONIVEL: obter cobrança (503)'), true);
    assert.equal(falhaDeCobertura('LISTA_INCOMPLETA: listar'), true);
    assert.equal(falhaDeCobertura('ERRO_INTERNO: FUNDADOR_DIVERGENTE'), false);
    assert.equal(falhaDeCobertura(null), false);
});

const cob = (id: string, extra: Partial<CobrancaProvedor> = {}): CobrancaProvedor => ({ id, status: 'RECEIVED', dueDate: '2026-10-01', paymentDate: '2026-10-01', invoiceUrl: null,
    deleted: false, ...extra });

test('inventário remoto (D-B14-5): duas leituras completas; item que muda é relido; muda de novo → INCONCLUSIVO', async () => {
    const filtros = [{ campo: 'dateCreated' as const, desde: '2026-10-01' }];
    const leitor = (passadas: CobrancaProvedor[][], relida: (id: string) => CobrancaProvedor | null) => {
        let k = 0;
        return { listarCobrancas: async () => { const itens = passadas[k++] ?? []; return { itens, totalCount: itens.length }; }, obterCobranca: async (id: string) => relida(id) };
    };
    const igual = await lerCobrancasRemotas(leitor([[cob('a'), cob('b')], [cob('a'), cob('b')]], () => null), filtros);
    assert.deepEqual([igual.completa, igual.itens.map((c) => c.id), igual.inconclusivos], [true, ['a', 'b'], []]);
    const conjuntos = await lerCobrancasRemotas(leitor([[cob('a')], [cob('a'), cob('b')]], () => null), filtros);
    assert.deepEqual([conjuntos.completa, conjuntos.motivos], [false, ['CONJUNTOS_DIFERENTES:dateCreated']]);
    const relida = await lerCobrancasRemotas(leitor([[cob('a', { status: 'PENDING' })], [cob('a')]], () => cob('a')), filtros);
    assert.deepEqual([relida.completa, relida.inconclusivos, relida.itens[0].status], [true, [], 'RECEIVED']);
    const mudou = await lerCobrancasRemotas(leitor([[cob('a', { status: 'PENDING' })], [cob('a')]], () => cob('a', { status: 'REFUNDED' })), filtros);
    assert.deepEqual([mudou.inconclusivos, mudou.itens.length], [[identidadeDoCaso('COBRANCA_REMOTA', 'a')], 0]);
    // A descrição do estorno (texto livre) não conta como mudança.
    const descr = await lerCobrancasRemotas(leitor([[cob('a', { estornos: [{ status: 'DONE', valorCentavos: 1, descricao: 'x' }] })],
        [cob('a', { estornos: [{ status: 'DONE', valorCentavos: 1, descricao: 'y' }] })]], () => null), filtros);
    assert.deepEqual(descr.inconclusivos, []);
    const falhou = await lerCobrancasRemotas({ listarCobrancas: async () => { throw new AsaasFalhou('listar', null, 'LISTA_INCOMPLETA'); }, obterCobranca: async () => null }, filtros);
    assert.deepEqual([falhou.completa, falhou.motivos], [false, ['LISTA_FALHOU:dateCreated']]);
});

test('órfãs (§3.6.1, só RESTORE): coberta pelo local; créditos sem pedido; assinatura sem empresa; sem chave → INDETERMINADA', () => {
    const pedido = '11111111-1111-4111-8111-111111111111', outro = '22222222-2222-4222-8222-222222222222';
    const locais = { pagamentos: new Set(['pay_local']), pedidos: new Set([pedido]), assinaturas: new Set(['sub_local']) };
    const r = orfasRemotas([
        cob('pay_local'),
        cob('pay_ref', { externalReference: `km:producao:creditos:${pedido}` }),
        cob('pay_sub', { assinaturaId: 'sub_local' }),
        cob('pay_orfa_cred', { externalReference: `km:producao:creditos:${outro}` }),
        cob('pay_orfa_sub', { assinaturaId: 'sub_x' }),
        cob('pay_sandbox', { externalReference: `km:sandbox:creditos:${outro}` }),
        cob('pay_nada'),
    ], locais, 'producao');
    const por = Object.fromEntries(r.map((o) => [o.identidade, o.classe]));
    assert.deepEqual(por, {
        [identidadeDoCaso('COBRANCA_REMOTA', 'pay_orfa_cred')]: 'ORFA_CREDITOS',
        [identidadeDoCaso('COBRANCA_REMOTA', 'pay_orfa_sub')]: 'ORFA_ASSINATURA',
        [identidadeDoCaso('COBRANCA_REMOTA', 'pay_sandbox')]: 'INDETERMINADA',
        [identidadeDoCaso('COBRANCA_REMOTA', 'pay_nada')]: 'INDETERMINADA',
    });
});

test('códigos seguros na saída', () => {
    assert.equal(codigoSeguro('SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO'), 'SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO');
    assert.equal(codigoSeguro('Buffet da Ana'), 'OUTRO');
    assert.equal(codigoSeguro(42), 'OUTRO');
});
