import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { gerarPacote } from '../exportacao/pacote.ts';
import { lerZip } from '../exportacao/zip.ts';
import type { MensagemEmail } from '../acessos/email.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta } from './ofertas.ts';
import { lerEstadoComercial } from './estado.ts';
import { processarEvento, registrarEvento, sincronizarEmpresa } from './sincronizacao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { concluirArrependimento, consultarArrependimento, enviarEmailConclusao, evidenciaDaAssinatura, notificarRegistro, registrarArrependimentoAtendimento, manifestacoesDaEmpresa, PROTOCOLO_ARREPENDIMENTO, registrarArrependimento,
    registrarComunicacaoIntermediador, type DepsArrependimento } from './arrependimento.ts';

/**
 * 097 — direito de arrependimento pela mesma ferramenta (grupo C do parecer de apoio, 23/10/2026) no PostgreSQL
 * DESCARTÁVEL sobre o modelo 089. E-mail FALSO; provedor FALSO só para levar a empresa a ATIVA pelo caminho real (o
 * registro do arrependimento nunca o chama):
 *   1. sem a 097: a tela indica o canal oficial e o registro é recusado com ARREPENDIMENTO_INDISPONIVEL;
 *   2. 097: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação;
 *   3. registro FORA da regra comercial (mensal ativa há mais de 7 dias) e com o provedor desligado: protocolo KA-, nada
 *      no provedor, auditoria, e-mail ao solicitante e aviso interno; repetição pela chave devolve o mesmo protocolo;
 *   4. Gestão só (outro papel recusado), senha recente exigida, confirmação exigida; empresa em TESTE também registra;
 *   5. guarda: núcleo imutável, acompanhamento uma vez só, nasce RECEBIDA, sem DELETE; restrições de conclusão;
 *   6. atendimento: RESTITUIDO exige comunicação e valor e encerra o acesso; NAO_APLICAVEL não muda o acesso;
 *   7. conferência D-C4: manifestação RECEBIDA há mais de 1 h vira pendência (SEM_COMUNICACAO / SEM_CONCLUSAO);
 *   8. exportação: com a 097, as manifestações da empresa entram no pacote (colunas conferidas, sem chave, aviso interno,
 *      quem concluiu nem dados de outra empresa); FK empresa_id → empresa_assinaturas no catálogo;
 *   9. vigia (P2-C3): aviso interno não entregue alarma já; RECEBIDA há 1 h ou mais alarma; leitura READ ONLY;
 *  10. rollback recusado com manifestação registrada.
 * Revisão 2765be2: P2-N6 (pedido anterior à recontratação não captura a assinatura nova) e P3-N1 (e-mail com o efeito real) no caso 6f.
 * 23/10/2026: registro pelo atendimento de pedido recebido pelo canal oficial e e-mail do resultado na conclusão (caso 6e).
 * Revisão f6b6fbb: P2-N4 (evento roteado não prova titularidade) no caso 6c; P2-N5 (tabelas opcionais ausentes) no caso 6d.
 * Revisão 5a129de: P2-N3 (assinatura restituída sem vínculo atual ou anterior à recontratação) no caso 6c.
 * Revisão d72d8b8: P2-N1 (pedido sem vínculo) no caso 6b; P2-N2 (cobrança antecipada) no caso 6.
 * Revisão 8da88ba: P2-C1 (sincronização não reabre a restituída; pagamento novo reativa; pedido antigo não encerra a
 * recontratação) no caso 6; P3-C1 (postcheck confere colunas, tipos e NOT NULL; guarda segura contra NULL) nos casos 2 e 5.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre: ler('database/checks/20261023_097_precheck.sql'), up: ler('database/migrations/20261023_097_assinatura_arrependimentos.sql'),
    post: ler('database/checks/20261023_097_postcheck.sql'), down: ler('database/rollback/20261023_097_assinatura_arrependimentos_down.sql'),
};
const vigia = createRequire(import.meta.url)('../../scripts/arrependimento-vigia.cjs') as {
    lerVigia: (c: unknown, instanteMs?: number | null) => Promise<{ instalado: boolean; recebidas: number; alarmes: { tipo: string; quantidade: number }[]; codigo: number }>;
};
const reconciliar = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as {
    lerPendenciasEncerramento: (c: unknown, instanteMs?: number | null) => Promise<{ item: string; resultado: string; motivo: string; recebidoMs: number }[]>;
};
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const CANAL = 'plataforma@example.test';
const SEM_PROVEDOR = { SITE_ATENDIMENTO_EMAIL: CANAL };
const COM_PROVEDOR = { ...SEM_PROVEDOR, ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_de_teste_sem_valor', ASAAS_WEBHOOK_TOKEN: 'token-webhook-sintetico-de-teste-32+caracteres' };

let client: Client;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
const ids: Record<string, string> = {};
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try { const r = await acao(); await q('COMMIT'); return r; }
    catch (error) { await q('ROLLBACK'); throw error; }
}
async function erro(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }

const enviados: MensagemEmail[] = [];
const enviarEmail = async (m: MensagemEmail) => { enviados.push(m); return { provedor: 'arquivo' as const, idExterno: null }; };
const tenant = () => ({ empresaComprovada: ids.atual, membershipId: 'm', usuarioId: ids.usuario, papelAtual: ids.papel ?? 'REPRESENTANTE_AUTORIZADO' });
function deps(env: Record<string, string | undefined> = SEM_PROVEDOR, email: DepsArrependimento['enviarEmail'] = enviarEmail): DepsArrependimento {
    return { withTenantTransaction: (_s, _e, t) => emTx(() => t(client as never, tenant() as never)), withTransaction: (t) => emTx(() => t(client as never)), env, enviarEmail: email };
}
async function sessao(reautenticadaHaSegundos = 10) {
    const r = (await q(`SELECT to_char((clock_timestamp() - make_interval(secs => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c`, [reautenticadaHaSegundos])).rows[0];
    return { id: 's', usuario_id: ids.usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: r.a, consultado_em: r.c, expira_em: '', csrf_hash: '' };
}
const ctx = () => ({ requestId: randomUUID() });
const pedir = async (motivo = 'Desisti', chave = randomUUID(), env: Record<string, string | undefined> = SEM_PROVEDOR) =>
    registrarArrependimento(await sessao(), null, { chave, confirmar: true, motivo }, ctx(), deps(env));
const linha = async (protocolo: string) => (await q('SELECT * FROM assinatura_arrependimentos WHERE protocolo = $1', [protocolo])).rows[0];
const situacaoAssinatura = async (empresaId: string) => (await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [empresaId])).rows[0].situacao as string;

/** Provedor falso só para levar a empresa a ATIVA pelo caminho real (sincronização); o arrependimento não o usa. */
const assinaturas = new Map<string, AssinaturaProvedor>();
const cobrancas = new Map<string, CobrancaProvedor[]>();
let chamadasProvedor = 0;
const provedor = {
    async obterAssinatura(id: string) { chamadasProvedor++; return assinaturas.get(id) ?? null; },
    async listarCobrancasDaAssinatura(id: string) { chamadasProvedor++; return (cobrancas.get(id) ?? []).map((c) => ({ ...c })); },
    async listarAssinaturasPorReferencia(ref: string) { chamadasProvedor++; return [...assinaturas.values()].filter((a) => a.externalReference === ref); },
};
let seq = 0;
async function empresaEmTeste(documento: string) {
    const empresaId = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Arrependimento', 'PROVISIONAMENTO') RETURNING id", [`ar${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresaId]);
    await emTx(() => iniciarTeste(client as never, { empresaId, documento }));
    return empresaId;
}
/** Mensal paga há 40 dias (fora da garantia de 7 dias), ATIVA pela sincronização. */
async function empresaAtivaAntiga(documento: string) {
    const empresaId = await empresaEmTeste(documento);
    const n = ++seq, sub = `sub_ar_${n}`;
    const venc = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date - 40, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    assinaturas.set(sub, { id: sub, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_ar_${n}`, externalReference: empresaId, valorCentavos: 19_700 });
    cobrancas.set(sub, [{ id: `pay_${sub}_1`, status: 'RECEIVED', dueDate: venc, paymentDate: venc, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresaId, `cus_ar_${n}`, sub]);
    const r = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return empresaId;
}

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Arrependimento', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`ar${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    ids.atendimento = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Atendimento', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`at${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('1. sem a 097: a tela indica o canal oficial; o registro é recusado com ARREPENDIMENTO_INDISPONIVEL', { skip: !opt() }, async () => {
    ids.atual = await empresaEmTeste('11222333000181');
    const c = await consultarArrependimento(await sessao(), null, deps());
    assert.deepEqual(c, { instalado: false, canalOficial: 'contato@demerzellabs.com.br', manifestacoes: [] });
    assert.equal(await erro(pedir()), 'ARREPENDIMENTO_INDISPONIVEL');
    assert.equal(enviados.length, 0);
});

test('2. 097: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação', { skip: !opt() }, async () => {
    await q(SQL.pre); await q(SQL.up); await q(SQL.post);
    await assert.rejects(q(SQL.up), /097 já aplicada/); await q('ROLLBACK').catch(() => undefined);
    await assert.rejects(q(SQL.pre), /aplicação anterior ou parcial/);
    await q(SQL.down);
    assert.equal((await q("SELECT to_regclass('public.assinatura_arrependimentos') IS NULL AS ok")).rows[0].ok, true);
    await q(SQL.pre); await q(SQL.up); await q(SQL.post);
    // Postcheck por igualdade exata: uma restrição afrouxada ("OR true") ou a mais é recusada (alteração desfeita).
    for (const alteracao of [
        `ALTER TABLE assinatura_arrependimentos DROP CONSTRAINT assinatura_arrependimentos_conclusao_check,
           ADD CONSTRAINT assinatura_arrependimentos_conclusao_check CHECK ((situacao = 'RECEBIDO' AND concluido_em IS NULL) OR true)`,
        'ALTER TABLE assinatura_arrependimentos ADD CONSTRAINT assinatura_arrependimentos_extra_check CHECK (true)',
        'ALTER TABLE assinatura_arrependimentos DROP CONSTRAINT assinatura_arrependimentos_intermediador_check',
        'ALTER TABLE assinatura_arrependimentos DROP CONSTRAINT assinatura_arrependimentos_restituicao_check',
    ]) {
        await q('BEGIN');
        try { await q(alteracao); await assert.rejects(q(SQL.post), /restrição ausente ou com definição divergente/); }
        finally { await q('ROLLBACK'); }
    }
    // P3-C1: NOT NULL retirado, tipo trocado ou coluna a mais são recusados pelo postcheck.
    for (const alteracao of [
        'ALTER TABLE assinatura_arrependimentos ALTER COLUMN situacao DROP NOT NULL',
        'ALTER TABLE assinatura_arrependimentos ALTER COLUMN aviso_interno DROP NOT NULL',
        'ALTER TABLE assinatura_arrependimentos ALTER COLUMN motivo TYPE varchar(500)',
        'ALTER TABLE assinatura_arrependimentos ADD COLUMN extra text',
    ]) {
        await q('BEGIN');
        // Tipo trocado também reescreve o CHECK da coluna: recusado já pela conferência das restrições.
        try { await q(alteracao); await assert.rejects(q(SQL.post), /colunas, tipos ou NOT NULL divergentes|restrição ausente ou com definição divergente/, alteracao); }
        finally { await q('ROLLBACK'); }
    }
    await q(SQL.post);
});

let protocoloA = '';
test('3. fora da regra comercial e sem provedor: protocolo na hora, nada no provedor, auditoria, e-mails; chave repetida devolve o mesmo', { skip: !opt() }, async () => {
    ids.atual = await empresaAtivaAntiga('11444777000161');
    const antesProvedor = chamadasProvedor;
    enviados.length = 0;
    const chave = randomUUID();
    const r = await pedir('Não vou usar', chave);
    assert.match(r.protocolo, PROTOCOLO_ARREPENDIMENTO);
    assert.equal(r.repetido, false);
    assert.equal(r.situacao, 'RECEBIDO');
    assert.equal(r.provedorDisponivel, false, 'provedor desligado neste ambiente: registro aceito mesmo assim');
    assert.equal(r.dentroDe7Dias, null, 'sem contratação confirmada: informativo nulo');
    assert.equal(r.emailConfirmacao, 'ENVIADO'); assert.equal(r.avisoInterno, 'ENVIADO');
    assert.equal(chamadasProvedor, antesProvedor, 'o registro nunca chama o provedor');
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA', 'o registro não muda o acesso sozinho');
    const l = await linha(r.protocolo);
    assert.deepEqual([l.canal, l.situacao_assinatura, l.motivo, l.situacao, l.email_confirmacao, l.aviso_interno], ['FERRAMENTA', 'ATIVA', 'Não vou usar', 'RECEBIDO', 'ENVIADO', 'ENVIADO']);
    const a = (await q("SELECT dados_depois FROM auditoria WHERE acao = 'ARREPENDIMENTO_REGISTRADO' AND entidade_id = $1", [ids.atual])).rows;
    assert.equal(a.length, 1); assert.equal(a[0].dados_depois.protocolo, r.protocolo);
    const [gestao, interno] = [enviados.find((m) => m.para !== CANAL)!, enviados.find((m) => m.para === CANAL)!];
    assert.match(gestao.assunto, new RegExp(r.protocolo)); assert.match(gestao.texto, /restituição dos valores pagos/);
    assert.match(interno.assunto, /^\[AÇÃO HOJE\]/); assert.match(interno.texto, /Prazo: IMEDIATO/);
    assert.ok(!interno.texto.includes('Buffet Arrependimento') && !interno.texto.includes('@example.test'), 'aviso interno sem nome nem e-mail');
    // Mesma chave: mesmo protocolo, sem novo e-mail nem nova auditoria.
    const de2 = await pedir('Não vou usar', chave);
    assert.equal(de2.protocolo, r.protocolo); assert.equal(de2.repetido, true);
    assert.equal(enviados.length, 2);
    assert.equal(Number((await q("SELECT count(*) AS n FROM auditoria WHERE acao = 'ARREPENDIMENTO_REGISTRADO' AND entidade_id = $1", [ids.atual])).rows[0].n), 1);
    // Outra chave registra outra manifestação (não há "uma só por empresa": cada pedido conta).
    const outro = await pedir('Segundo pedido', randomUUID(), COM_PROVEDOR);
    assert.notEqual(outro.protocolo, r.protocolo); assert.equal(outro.provedorDisponivel, true);
    const c = await consultarArrependimento(await sessao(), null, deps());
    assert.deepEqual(c.manifestacoes.map((m) => m.protocolo).sort(), [r.protocolo, outro.protocolo].sort());
    assert.ok(c.manifestacoes.every((m) => !('id' in m)));
    protocoloA = r.protocolo;
});

test('4. só a Gestão, com senha recente e confirmação; empresa em TESTE também registra; e-mail falho não desfaz', { skip: !opt() }, async () => {
    const atual = ids.atual;
    ids.papel = 'OPERADOR';
    assert.equal(await erro(pedir()), 'COBRANCA_SEM_PERMISSAO');
    assert.equal(await erro(consultarArrependimento(await sessao(), null, deps())), 'COBRANCA_SEM_PERMISSAO');
    delete ids.papel;
    assert.equal(await erro(registrarArrependimento(await sessao(600), null, { chave: randomUUID(), confirmar: true }, ctx(), deps())), 'REAUTENTICACAO');
    assert.equal(await erro(registrarArrependimento(await sessao(), null, { chave: randomUUID() }, ctx(), deps())), 'DADOS_INVALIDOS');
    assert.equal(await erro(registrarArrependimento(await sessao(), null, { chave: 'x', confirmar: true }, ctx(), deps())), 'DADOS_INVALIDOS');
    ids.atual = await empresaEmTeste('22333444000181');
    const falha = async () => { throw new Error('smtp'); };
    const r = await registrarArrependimento(await sessao(), null, { chave: randomUUID(), confirmar: true }, ctx(), deps(SEM_PROVEDOR, falha));
    assert.match(r.protocolo, PROTOCOLO_ARREPENDIMENTO);
    assert.deepEqual([r.emailConfirmacao, r.avisoInterno], ['FALHOU', 'FALHOU']);
    const l = await linha(r.protocolo);
    assert.deepEqual([l.situacao_assinatura, l.email_confirmacao, l.aviso_interno, l.motivo], ['TESTE', 'FALHOU', 'FALHOU', null]);
    ids.atual = atual;
});

test('5. guarda: núcleo imutável, acompanhamento uma vez só, nasce RECEBIDA, sem DELETE; restrições de conclusão', { skip: !opt() }, async () => {
    const p = protocoloA;
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET motivo = 'outro' WHERE protocolo = $1", [p]), /imutável/);
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET solicitado_em = solicitado_em - interval '1 day' WHERE protocolo = $1", [p]), /imutável/);
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET email_confirmacao = 'FALHOU' WHERE protocolo = $1", [p]), /imutável/);
    await assert.rejects(q('DELETE FROM assinatura_arrependimentos WHERE protocolo = $1', [p]), /não é apagada/);
    await assert.rejects(q(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, situacao_assinatura, provedor_disponivel, situacao)
        VALUES ('KA-20261023-ABCDEFGH', $1, $2, 'ATENDIMENTO', $3, 'ATIVA', false, 'RESTITUIDO')`, [ids.atual, randomUUID(), ids.usuario]), /nasce RECEBIDA/);
    await assert.rejects(q(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, situacao_assinatura, provedor_disponivel)
        VALUES ('KM-20261023-ABCDEFGH', $1, $2, 'ATENDIMENTO', $3, 'ATIVA', false)`, [ids.atual, randomUUID(), ids.usuario]), /protocolo_check/);
    // P3-C1: sem o NOT NULL (schema divergente), a guarda ainda recusa nascer com situação NULL (desfeito).
    await q('BEGIN');
    try {
        await q('ALTER TABLE assinatura_arrependimentos ALTER COLUMN situacao DROP NOT NULL');
        await assert.rejects(q(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, situacao_assinatura, provedor_disponivel, situacao)
            VALUES ('KA-20261023-ABCDEFGJ', $1, $2, 'ATENDIMENTO', $3, 'ATIVA', false, NULL)`, [ids.atual, randomUUID(), ids.usuario]), /nasce RECEBIDA/);
    } finally { await q('ROLLBACK'); }
    // Pelo atendimento: canal ATENDIMENTO aceito (registro de pedido recebido pelo canal oficial).
    await q(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, situacao_assinatura, provedor_disponivel)
        VALUES ('KA-20261023-ABCDEFGH', $1, $2, 'ATENDIMENTO', $3, 'ATIVA', false)`, [ids.atual, randomUUID(), ids.usuario]);
    // Restrições: RESTITUIDO sem comunicação ou sem valor recusado (guardas do banco além do serviço).
    await assert.rejects(q(`UPDATE assinatura_arrependimentos SET situacao = 'RESTITUIDO', concluido_em = clock_timestamp(), concluido_por = $2, conclusao_referencia = 'estorno 1',
        valor_restituido_centavos = 100 WHERE protocolo = $1`, [p, ids.atendimento]), /conclusao_check/);
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET intermediador_comunicado_em = clock_timestamp() WHERE protocolo = $1", [p]), /intermediador_check/);
    await assert.rejects(q(`UPDATE assinatura_arrependimentos SET situacao = 'NAO_APLICAVEL', concluido_em = clock_timestamp(), concluido_por = $2, conclusao_referencia = 'justificativa',
        valor_restituido_centavos = 100 WHERE protocolo = $1`, [p, ids.atendimento]), /conclusao_check/);
    // Limite e cobrança da restituição só existem na restituição.
    await assert.rejects(q(`UPDATE assinatura_arrependimentos SET situacao = 'NAO_APLICAVEL', concluido_em = clock_timestamp(), concluido_por = $2, conclusao_referencia = 'justificativa',
        restituicao_limite = current_date WHERE protocolo = $1`, [p, ids.atendimento]), /restituicao_check/);
});

test('6. atendimento: RESTITUIDO exige comunicação e valor e encerra o acesso; NAO_APLICAVEL não muda o acesso', { skip: !opt() }, async () => {
    const empresaId = ids.atual, p = protocoloA;
    const concluir = (situacao: 'RESTITUIDO' | 'NAO_APLICAVEL', valorCentavos: number | null, protocolo = p) =>
        emTx(() => concluirArrependimento(client as never, { empresaId, protocolo, usuarioId: ids.atendimento, situacao, referencia: 'estorno Asaas 23/10', valorCentavos,
            cobrancaIds: situacao === 'RESTITUIDO' ? ['pay_qualquer'] : null }));
    assert.equal(await erro(concluir('RESTITUIDO', 19_700)), 'CONFLITO', 'sem comunicação ao intermediador');
    assert.equal(await erro(concluir('RESTITUIDO', null)), 'DADOS_INVALIDOS');
    // Outra empresa não alcança o protocolo.
    const outra = await empresaEmTeste('33444555000181');
    assert.equal(await erro(emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: outra, protocolo: p, referencia: 'Asaas' }))), 'CONFLITO');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId, protocolo: p, referencia: 'estorno pedido no Asaas' }));
    assert.equal(await erro(emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId, protocolo: p, referencia: 'de novo' }))), 'CONFLITO', 'uma vez só');
    const sub = (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [empresaId])).rows[0].s as string;
    assert.equal((await linha(p)).provedor_assinatura_id, sub, 'assinatura do provedor gravada no registro');
    assert.equal(await erro(emTx(() => concluirArrependimento(client as never, { empresaId, protocolo: p, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno', valorCentavos: 1, cobrancaIds: ['pay inválido'] }))), 'DADOS_INVALIDOS');
    // Revisão d72d8b8 (P2-N2): restituição sem cobrança identificada é recusada.
    for (const cobrancaIds of [null, [], ['  ']])
        assert.equal(await erro(emTx(() => concluirArrependimento(client as never, { empresaId, protocolo: p, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
            referencia: 'estorno', valorCentavos: 1, cobrancaIds }))), 'DADOS_INVALIDOS', JSON.stringify(cobrancaIds));
    assert.equal(await erro(emTx(() => concluirArrependimento(client as never, { empresaId, protocolo: p, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno', valorCentavos: 1, cobrancaIds: ['pay_x'], assinaturaId: 'sub_outra' }))), 'CONFLITO', 'assinatura diferente da do registro');
    const r = await emTx(() => concluirArrependimento(client as never, { empresaId, protocolo: p, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno Asaas 23/10', valorCentavos: 19_700, cobrancaIds: [`pay_${sub}_1`] }));
    assert.deepEqual(r, { protocolo: p, situacao: 'RESTITUIDO', encerrou: true, mesmaAssinatura: true, evidencia: 'REGISTRO' });
    assert.equal(await situacaoAssinatura(empresaId), 'ENCERRADA');
    const l6 = await linha(p);
    assert.deepEqual(l6.restituicao_cobranca_ids, [`pay_${sub}_1`]);
    assert.equal(l6.restituicao_assinatura_id, null, 'com vínculo no registro, a assinatura restituída é a dele');
    assert.equal((await q("SELECT $1::date = (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS ok", [l6.restituicao_limite])).rows[0].ok, true, 'limite = data da conclusão (Brasília)');
    const e = await lerEstadoComercial(client as never, empresaId);
    assert.equal(e.acesso.nivel, 'SOMENTE_LEITURA');
    // P2-C1 (REVIEW C1 do Astra): o provedor ainda mostra a assinatura ACTIVE e a cobrança antiga RECEIVED (remoção ou
    // estorno ainda não refletidos). A reconsulta NÃO reabre o período restituído.
    assert.equal(assinaturas.get(sub)!.status, 'ACTIVE');
    const s1 = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s1.resultado === 'SINCRONIZADA' && s1.depois, 'ENCERRADA', JSON.stringify(s1));
    assert.equal(await situacaoAssinatura(empresaId), 'ENCERRADA');
    // Outra cobrança da mesma assinatura com vencimento até o limite (não declarada) também não reabre.
    const hoje = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    cobrancas.get(sub)!.push({ id: `pay_${sub}_hoje`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub });
    const s2 = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s2.resultado === 'SINCRONIZADA' && s2.depois, 'ENCERRADA', 'cobrança com vencimento até o limite não sustenta período');
    // P2-N2 (REVIEW N2 do Astra): cobrança ANTECIPADA — vencimento futuro, paga até o limite, não declarada — não reabre.
    const amanha = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 1, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const depois = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 31, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    cobrancas.get(sub)!.push({ id: `pay_${sub}_antecipada`, status: 'RECEIVED', dueDate: amanha, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub });
    const sa = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(sa.resultado === 'SINCRONIZADA' && sa.depois, 'ENCERRADA', 'antecipada (paga até o limite) não é pagamento novo');
    // Pagamento NOVO — feito depois da conclusão (data de pagamento posterior ao limite) — reativa, como na 089.
    cobrancas.get(sub)!.push({ id: `pay_${sub}_novo`, status: 'RECEIVED', dueDate: depois, paymentDate: amanha, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub });
    const s3 = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s3.resultado === 'SINCRONIZADA' && s3.depois, 'ATIVA', JSON.stringify(s3));
    assert.equal(await erro(concluir('NAO_APLICAVEL', null)), 'CONFLITO', 'conclusão uma vez só');
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET valor_restituido_centavos = 1 WHERE protocolo = $1", [p]), /imutável/);
    // NAO_APLICAVEL em outra empresa ativa: não muda o acesso, exige referência (justificativa).
    ids.atual = await empresaAtivaAntiga('44555666000181');
    const n = await pedir('Pedido duplicado por engano');
    const rn = await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: n.protocolo, usuarioId: ids.atendimento, situacao: 'NAO_APLICAVEL',
        referencia: 'Cliente retirou o pedido por e-mail' }));
    assert.deepEqual(rn, { protocolo: n.protocolo, situacao: 'NAO_APLICAVEL', encerrou: false, mesmaAssinatura: true, evidencia: null });
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA');
    const ln = await linha(n.protocolo);
    assert.deepEqual([ln.restituicao_limite, ln.restituicao_assinatura_id, ln.restituicao_cobranca_ids], [null, null, null]);
    // P2-C1: pedido feito na assinatura antiga e concluído depois da recontratação (outra assinatura no provedor) fica
    // RESTITUIDO sem encerrar o período novo, e o limite vale só para a assinatura antiga.
    const antigo = await pedir('Pedido antes da recontratação');
    const subAntiga = (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [ids.atual])).rows[0].s as string;
    const subNova = `${subAntiga}_nova`;
    const hojeN = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const cliente = assinaturas.get(subAntiga)!.customer;
    assinaturas.set(subNova, { id: subNova, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: cliente, externalReference: ids.atual, valorCentavos: 19_700 });
    cobrancas.set(subNova, [{ id: `pay_${subNova}_1`, status: 'RECEIVED', dueDate: hojeN, paymentDate: hojeN, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subNova }]);
    // Recontratação real: a assinatura antiga é cancelada (a troca de assinatura no provedor só é aceita depois disso) e
    // a nova é vinculada e paga; a sincronização leva a empresa a ATIVA pela assinatura nova.
    await q("UPDATE empresa_assinaturas SET situacao = 'CANCELADA_FIM_PERIODO', cancelada_em = clock_timestamp() WHERE empresa_id = $1", [ids.atual]);
    await q('UPDATE empresa_assinaturas SET provedor_assinatura_id = $2 WHERE empresa_id = $1', [ids.atual, subNova]);
    const sr = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(sr.resultado === 'SINCRONIZADA' && sr.depois, 'ATIVA', JSON.stringify(sr));
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: antigo.protocolo, referencia: 'estorno da assinatura antiga' }));
    const ra = await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: antigo.protocolo, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno da assinatura antiga', valorCentavos: 19_700, cobrancaIds: [`pay_${subAntiga}_1`] }));
    assert.deepEqual(ra, { protocolo: antigo.protocolo, situacao: 'RESTITUIDO', encerrou: false, mesmaAssinatura: false, evidencia: 'REGISTRO' });
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA', 'recontratação não é encerrada por pedido antigo');
    const sn = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(sn.resultado === 'SINCRONIZADA' && sn.depois, 'ATIVA', 'o limite da assinatura antiga não alcança a nova');
    const lista = await emTx(() => manifestacoesDaEmpresa(client as never, ids.atual));
    assert.equal(lista.find((x) => x.protocolo === n.protocolo)?.situacao, 'NAO_APLICAVEL');
    assert.equal(lista.find((x) => x.protocolo === antigo.protocolo)?.situacao, 'RESTITUIDO');
});

test('6b. pedido registrado sem vínculo com o provedor (P2-N1): conclusão exige a assinatura atual; cobrança declarada e limite valem', { skip: !opt() }, async () => {
    // REVIEW N1 do Astra: registro em TESTE, sem provedor_assinatura_id.
    ids.atual = await empresaEmTeste('77888999000181');
    const r = await pedir('Pedido antes do vínculo');
    assert.equal((await linha(r.protocolo)).provedor_assinatura_id, null);
    // O vínculo da mesma contratação é recuperado e o pagamento leva a ATIVA (associação sintética, sem desligar gatilhos).
    const n = ++seq, sub = `sub_ar_${n}`;
    const hoje = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    assinaturas.set(sub, { id: sub, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_ar_${n}`, externalReference: ids.atual, valorCentavos: 19_700 });
    cobrancas.set(sub, [{ id: `pay_${sub}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [ids.atual, `cus_ar_${n}`, sub]);
    const s0 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s0.resultado === 'SINCRONIZADA' && s0.depois, 'ATIVA');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: r.protocolo, referencia: 'estorno pedido no Asaas' }));
    const concluir = (assinaturaId: string | null) => emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: r.protocolo, usuarioId: ids.atendimento,
        situacao: 'RESTITUIDO', referencia: 'estorno Asaas', valorCentavos: 19_700, cobrancaIds: [`pay_${sub}_1`], assinaturaId }));
    // Ausência de vínculo não é tratada como recontratação: sem a assinatura confirmada, a conclusão é recusada.
    assert.equal(await erro(concluir(null)), 'CONFLITO');
    assert.equal(await erro(concluir('sub_de_outra_empresa')), 'CONFLITO', 'sem prova de que é desta empresa');
    assert.equal((await linha(r.protocolo)).situacao, 'RECEBIDO', 'recusa não grava nada');
    assert.deepEqual(await concluir(sub), { protocolo: r.protocolo, situacao: 'RESTITUIDO', encerrou: true, mesmaAssinatura: true, evidencia: 'ATUAL' });
    const l = await linha(r.protocolo);
    assert.deepEqual([l.provedor_assinatura_id, l.restituicao_assinatura_id, l.restituicao_cobranca_ids], [null, sub, [`pay_${sub}_1`]]);
    // A reconsulta com a cobrança ainda RECEIVED não reabre (antes: ATIVA).
    const s1 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s1.resultado === 'SINCRONIZADA' && s1.depois, 'ENCERRADA', JSON.stringify(s1));
    // Cobrança declarada é excluída mesmo com vencimento e pagamento posteriores (declaração explícita prevalece).
    const amanha = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 1, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    cobrancas.get(sub)![0] = { ...cobrancas.get(sub)![0], dueDate: amanha, paymentDate: amanha };
    const s2 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s2.resultado === 'SINCRONIZADA' && s2.depois, 'ENCERRADA');
    // Controle de nova contratação: assinatura nova paga reativa (a restituída não a alcança).
    const subNova = `${sub}_nova`;
    assinaturas.set(subNova, { id: subNova, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_ar_${n}`, externalReference: ids.atual, valorCentavos: 19_700 });
    cobrancas.set(subNova, [{ id: `pay_${subNova}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subNova }]);
    await q('UPDATE empresa_assinaturas SET provedor_assinatura_id = $2 WHERE empresa_id = $1', [ids.atual, subNova]);
    const s3 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s3.resultado === 'SINCRONIZADA' && s3.depois, 'ATIVA', JSON.stringify(s3));
    // Banco: com vínculo no registro, a assinatura restituída informada não pode divergir dele.
    await q('BEGIN');
    try {
        const outro = (await q("SELECT protocolo FROM assinatura_arrependimentos WHERE provedor_assinatura_id IS NOT NULL AND situacao = 'RECEBIDO' LIMIT 1")).rows[0]?.protocolo;
        if (outro) await assert.rejects(q(`UPDATE assinatura_arrependimentos SET intermediador_comunicado_em = coalesce(intermediador_comunicado_em, clock_timestamp()),
            intermediador_referencia = coalesce(intermediador_referencia, 'ref'), situacao = 'RESTITUIDO', concluido_em = clock_timestamp(), concluido_por = $2,
            conclusao_referencia = 'estorno', valor_restituido_centavos = 1, restituicao_limite = current_date, restituicao_cobranca_ids = ARRAY['pay_x'],
            restituicao_assinatura_id = 'sub_divergente' WHERE protocolo = $1`, [outro, ids.atendimento]), /restituicao_assinatura_check/);
    } finally { await q('ROLLBACK'); }
    await q('BEGIN');
    try {
        await assert.rejects(q(`UPDATE assinatura_arrependimentos SET restituicao_cobranca_ids = ARRAY['pay x'] WHERE protocolo = $1`, [r.protocolo]), /cobranca_ids_check|imutável/);
    } finally { await q('ROLLBACK'); }
});

test('6c. pedido sem vínculo (P2-N3): assinatura restituída ≠ atual — sem vínculo nenhum e recontratação antes da conclusão', { skip: !opt() }, async () => {
    const hoje = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const concluirCom = (empresaId: string, protocolo: string, assinaturaId: string | null, cobranca: string, comProvedor = true) =>
        emTx(() => concluirArrependimento(client as never, { empresaId, protocolo, usuarioId: ids.atendimento, situacao: 'RESTITUIDO', referencia: 'estorno Asaas',
            valorCentavos: 19_700, cobrancaIds: [cobranca], assinaturaId }, comProvedor ? provedor as never : null));

    // Ramo A (REVIEW N3-A): sem vínculo no registro NEM na conclusão. A assinatura remota é desta empresa (referência no
    // provedor). Antes: aceita e descartada em silêncio. Agora: sem prova recusa; com prova é GRAVADA.
    ids.atual = await empresaEmTeste('88999000000198');
    const a = await pedir('Sem vínculo nenhum');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: a.protocolo, referencia: 'estorno pedido' }));
    const subA = `sub_ar_a_${++seq}`;
    assert.equal(await erro(concluirCom(ids.atual, a.protocolo, null, `pay_${subA}_1`)), 'CONFLITO', 'sem a assinatura: recusa');
    assert.equal(await erro(concluirCom(ids.atual, a.protocolo, subA, `pay_${subA}_1`)), 'CONFLITO', 'desconhecida no provedor: recusa');
    assinaturas.set(subA, { id: subA, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_a_${seq}`, externalReference: ids.atual, valorCentavos: 19_700 });
    assert.equal(await erro(concluirCom(ids.atual, a.protocolo, subA, `pay_${subA}_1`, false)), 'CONFLITO', 'sem provedor e sem registro local: recusa');
    const outraEmpresa = await empresaEmTeste('99000111000165');
    assinaturas.set(`${subA}_alheia`, { id: `${subA}_alheia`, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: 'cus_x', externalReference: outraEmpresa, valorCentavos: 1 });
    assert.equal(await erro(concluirCom(ids.atual, a.protocolo, `${subA}_alheia`, 'pay_x')), 'CONFLITO', 'assinatura de outra empresa: recusa');
    assert.equal((await linha(a.protocolo)).situacao, 'RECEBIDO', 'recusas não gravam');
    const ra = await concluirCom(ids.atual, a.protocolo, subA, `pay_${subA}_1`);
    assert.deepEqual(ra, { protocolo: a.protocolo, situacao: 'RESTITUIDO', encerrou: false, mesmaAssinatura: false, evidencia: 'PROVEDOR' });
    assert.equal((await linha(a.protocolo)).restituicao_assinatura_id, subA, 'assinatura informada gravada, não descartada');
    // O vínculo é recuperado depois: a assinatura restituída e suas cobranças pagas até o limite não levam a ATIVA.
    cobrancas.set(subA, [{ id: `pay_${subA}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subA },
        { id: `pay_${subA}_2`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subA }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [ids.atual, `cus_a_${seq}`, subA]);
    const sA = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.notEqual(sA.resultado === 'SINCRONIZADA' && sA.depois, 'ATIVA', 'cobranças restituídas (declarada e paga até o limite) não ativam: ' + JSON.stringify(sA));

    // Ramo B (REVIEW N3-B): pedido sem vínculo; a empresa RECONTRATA (assinatura nova paga, ATIVA) antes da conclusão.
    // O atendimento identifica a assinatura ANTIGA: aceita com prova, gravada, sem encerrar a nova.
    ids.atual = await empresaEmTeste('11000222000120');
    const b = await pedir('Pedido da contratação antiga');
    const subAntiga = `sub_ar_b_${++seq}`, subNova = `${subAntiga}_nova`;
    assinaturas.set(subAntiga, { id: subAntiga, status: 'INACTIVE', deleted: true, cycle: 'MONTHLY', customer: `cus_b_${seq}`, externalReference: ids.atual, valorCentavos: 19_700 });
    assinaturas.set(subNova, { id: subNova, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_b_${seq}`, externalReference: ids.atual, valorCentavos: 19_700 });
    cobrancas.set(subNova, [{ id: `pay_${subNova}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subNova }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [ids.atual, `cus_b_${seq}`, subNova]);
    const s0 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s0.resultado === 'SINCRONIZADA' && s0.depois, 'ATIVA');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: b.protocolo, referencia: 'estorno da antiga' }));
    // P2-N4 (REVIEW N4 do Astra), pela cadeia real registrar → processar → concluir: um evento autenticado traz uma
    // assinatura ALHEIA (no provedor, de outra empresa) com a referência de roteamento desta empresa. O evento é gravado
    // com empresa_id desta empresa, mas isso é roteamento, não titularidade: a conclusão com a assinatura do evento é
    // recusada — sem provedor (nenhuma fonte local de titularidade) e com provedor (a referência remota é de outra empresa).
    const subAlheia = `${subAntiga}_alheia`;
    assinaturas.set(subAlheia, { id: subAlheia, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: 'cus_alheio', externalReference: outraEmpresa, valorCentavos: 19_700 });
    // Um evento é PROCESSADO; o outro FALHOU (leitura do provedor falha durante o processamento) — os dois ficam com o
    // empresa_id desta empresa, gravado pelo próprio processarEvento.
    const provedorFalho = { ...provedor, async obterAssinatura() { throw new Error('provedor fora'); } };
    for (const [evento, prov] of [[`evt_${subAlheia}_ok`, provedor], [`evt_${subAlheia}_x`, provedorFalho]] as const) {
        const reg = await emTx(() => registrarEvento(client as never, { eventoId: evento, tipo: 'PAYMENT_RECEIVED', criadoNoProvedor: null, assinaturaId: subAlheia,
            cobrancaId: `pay_${subAlheia}_1`, checkoutId: null, referenciaExterna: ids.atual }));
        await emTx(() => processarEvento(client as never, reg.id, { provedor: prov as never }));
    }
    const eventos = (await q('SELECT situacao, empresa_id FROM cobranca_eventos WHERE assinatura_provedor_id = $1 ORDER BY evento_id', [subAlheia])).rows;
    assert.ok(eventos.length === 2 && eventos.every((e) => e.empresa_id === ids.atual), 'eventos roteados para esta empresa: ' + JSON.stringify(eventos));
    assert.ok(eventos.some((e) => e.situacao === 'PROCESSADO') && eventos.some((e) => e.situacao === 'FALHOU'), JSON.stringify(eventos));
    const chamadas = chamadasProvedor;
    assert.equal(await erro(concluirCom(ids.atual, b.protocolo, subAlheia, `pay_${subAlheia}_1`, false)), 'CONFLITO', 'evento roteado não prova titularidade (sem provedor)');
    assert.equal(await erro(concluirCom(ids.atual, b.protocolo, subAlheia, `pay_${subAlheia}_1`)), 'CONFLITO', 'provedor consultado: referência de outra empresa');
    assert.ok(chamadasProvedor > chamadas, 'sem fonte local de titularidade, o provedor é consultado');
    assert.equal((await linha(b.protocolo)).situacao, 'RECEBIDO', 'recusas não gravam');
    // A assinatura antiga legítima (excluída no provedor, referência desta empresa) é aceita pelo provedor.
    const rb = await concluirCom(ids.atual, b.protocolo, subAntiga, `pay_${subAntiga}_1`);
    assert.deepEqual(rb, { protocolo: b.protocolo, situacao: 'RESTITUIDO', encerrou: false, mesmaAssinatura: false, evidencia: 'PROVEDOR' });
    assert.equal((await linha(b.protocolo)).restituicao_assinatura_id, subAntiga);
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA', 'a assinatura nova não é encerrada');
    const s1 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s1.resultado === 'SINCRONIZADA' && s1.depois, 'ATIVA', 'o corte da antiga não alcança a nova');
});

test('6d. evidências sem as tabelas opcionais da 074a e da 089 (P2-N5): consulta não quebra; ordem preservada', { skip: !opt() }, async () => {
    // REVIEW N5 do Astra: sem assinatura_encerramentos (e sem assinatura_contratacoes), a consulta resolvia o nome antes do
    // AND e falhava com 42P01. Tudo dentro de uma transação desfeita.
    ids.atual = await empresaAtivaAntiga('22111333000120');
    const atual = (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [ids.atual])).rows[0].s as string;
    const remota = `${atual}_remota`;
    assinaturas.set(remota, { id: remota, status: 'INACTIVE', deleted: true, cycle: 'MONTHLY', customer: 'cus_r', externalReference: ids.atual, valorCentavos: 1 });
    await q('BEGIN');
    try {
        await q('ALTER TABLE assinatura_encerramentos RENAME TO assinatura_encerramentos_fora');
        await q('ALTER TABLE assinatura_contratacoes RENAME TO assinatura_contratacoes_fora');
        assert.equal(await evidenciaDaAssinatura(client as never, ids.atual, atual, null), 'ATUAL');
        assert.equal(await evidenciaDaAssinatura(client as never, ids.atual, remota, null), null, 'sem fonte local e sem provedor');
        assert.equal(await evidenciaDaAssinatura(client as never, ids.atual, remota, provedor as never), 'PROVEDOR');
        assert.equal(await evidenciaDaAssinatura(client as never, ids.atual, 'sub_inexistente', provedor as never), null);
    } finally { await q('ROLLBACK'); }
    // Com as tabelas: a contratação CONFIRMADA da assinatura atual é fonte; a ordem devolve ATUAL primeiro.
    assert.equal(await emTx(() => evidenciaDaAssinatura(client as never, ids.atual, atual, null)), 'ATUAL');
});

test('6e. atendimento: pedido recebido pelo canal oficial registrado com a data real; e-mail do resultado na conclusão', { skip: !opt() }, async () => {
    ids.atual = await empresaAtivaAntiga('33222111000100');
    const m = (await q("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id",
        [ids.atual, ids.usuario])).rows[0].id;
    await q("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
    const emailGestao = (await q('SELECT email FROM usuarios_administrativos WHERE id = $1', [ids.usuario])).rows[0].email as string;
    const registrar = (o: Partial<{ chave: string; emailSolicitante: string; recebidoEm: string; referencia: string }>) => emTx(() => registrarArrependimentoAtendimento(client as never,
        { empresaId: ids.atual, atendenteId: ids.atendimento, chave: randomUUID(), emailSolicitante: emailGestao, recebidoEm: '', referencia: 'E-mail recebido em contato@ com assunto Desistência', ...o }));
    const instante = async (expr: string) => (await q(`SELECT to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    // A assinatura de teste acabou de nascer: recebimento antes dela é recusado (a regra vale também aqui).
    assert.equal(await erro(registrar({ recebidoEm: await instante("clock_timestamp() - interval '2 hours'") })), 'DADOS_INVALIDOS', 'antes da assinatura');
    // Remetente que não é Gestão ativa da empresa: recusa (confirmar a identidade antes).
    assert.equal(await erro(registrar({ emailSolicitante: 'outra.pessoa@example.test', recebidoEm: await instante('clock_timestamp()') })), 'CONFLITO');
    // Data fora da janela: futura, ou mais de 90 dias atrás.
    assert.equal(await erro(registrar({ recebidoEm: await instante("clock_timestamp() + interval '1 hour'") })), 'DADOS_INVALIDOS');
    assert.equal(await erro(registrar({ recebidoEm: await instante("clock_timestamp() - interval '91 days'") })), 'DADOS_INVALIDOS');
    const antes = Number((await q('SELECT count(*) AS n FROM assinatura_arrependimentos WHERE empresa_id = $1', [ids.atual])).rows[0].n);
    assert.equal(antes, 0, 'recusas não gravam');
    // Válido.
    const recebidoEm = await instante('clock_timestamp()');
    const chave = randomUUID();
    const r = await registrar({ chave, recebidoEm, emailSolicitante: emailGestao.toUpperCase() });
    assert.equal(r.repetido, false);
    const l = await linha(r.m.protocolo);
    assert.deepEqual([l.canal, l.solicitado_por, l.situacao, l.email_confirmacao, l.aviso_interno], ['ATENDIMENTO', ids.usuario, 'RECEBIDO', 'PENDENTE', 'PENDENTE']);
    assert.equal(new Date(l.solicitado_em).toISOString(), new Date(recebidoEm).toISOString(), 'vale a data REAL do recebimento');
    assert.match(l.motivo, /^Recebido pelo canal oficial: E-mail recebido/);
    const aud = (await q("SELECT usuario_id, dados_depois FROM auditoria WHERE acao = 'ARREPENDIMENTO_REGISTRADO' AND entidade_id = $1", [ids.atual])).rows;
    assert.equal(aud.length, 1); assert.equal(aud[0].usuario_id, ids.atendimento); assert.equal(aud[0].dados_depois.canal, 'ATENDIMENTO');
    // Mesma chave: mesmo protocolo, nada novo.
    const de2 = await registrar({ chave, recebidoEm });
    assert.equal(de2.repetido, true); assert.equal(de2.m.protocolo, r.m.protocolo);
    // Depois do COMMIT: confirmação ao solicitante e aviso interno.
    enviados.length = 0;
    const n = await notificarRegistro({ withTransaction: (t) => emTx(() => t(client as never)), env: SEM_PROVEDOR, enviarEmail }, r);
    assert.deepEqual(n, { emailConfirmacao: 'ENVIADO', avisoInterno: 'ENVIADO' });
    assert.deepEqual(enviados.map((x) => x.para).sort(), [CANAL, emailGestao].sort());
    // A idade conta da data do recebimento: daqui a 2 h, vencido para o vigia.
    const v = await vigia.lerVigia(client, Date.parse(recebidoEm) + 2 * 3600_000);
    assert.ok(v.alarmes.some((a) => a.tipo === 'VENCIDO_SEM_COMUNICACAO'));

    // Conclusão NAO_APLICAVEL → e-mail do resultado com a justificativa; gravado uma vez.
    const deps = { withTransaction: <T,>(t: (tx: never) => Promise<T>) => emTx(() => t(client as never)), env: SEM_PROVEDOR, enviarEmail };
    assert.equal(await enviarEmailConclusao(deps, ids.atual, r.m.protocolo), null, 'RECEBIDO: nada a enviar');
    await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: r.m.protocolo, usuarioId: ids.atendimento, situacao: 'NAO_APLICAVEL',
        referencia: 'O pedido foi retirado pelo cliente por e-mail' }));
    enviados.length = 0;
    assert.equal(await enviarEmailConclusao(deps, ids.atual, r.m.protocolo), 'ENVIADO');
    assert.equal(enviados.length, 1); assert.equal(enviados[0].para, emailGestao);
    assert.match(enviados[0].texto, /Resultado: não se aplica\. Motivo: O pedido foi retirado pelo cliente por e-mail/);
    assert.equal(await enviarEmailConclusao(deps, ids.atual, r.m.protocolo), 'ENVIADO', 'não reenvia');
    assert.equal(enviados.length, 1);
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET email_conclusao = 'FALHOU' WHERE protocolo = $1", [r.m.protocolo]), /imutável/);
    // Restituição com falha de envio: FALHOU registrado, conclusão mantida.
    const r2 = await registrar({ recebidoEm: await instante('clock_timestamp()') });
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: r2.m.protocolo, referencia: 'estorno pedido' }));
    const sub = (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [ids.atual])).rows[0].s as string;
    assert.equal((await linha(r2.m.protocolo)).provedor_assinatura_id, null, 'vínculo sem contratação confirmada até o recebimento: pedido sem vínculo (P2-N6)');
    await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: r2.m.protocolo, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno Asaas', valorCentavos: 19_700, cobrancaIds: [`pay_${sub}_1`], assinaturaId: sub }));
    assert.equal(await situacaoAssinatura(ids.atual), 'ENCERRADA');
    const falha = async () => { throw new Error('smtp'); };
    assert.equal(await enviarEmailConclusao({ ...deps, enviarEmail: falha }, ids.atual, r2.m.protocolo), 'FALHOU');
    assert.deepEqual([(await linha(r2.m.protocolo)).situacao, (await linha(r2.m.protocolo)).email_conclusao], ['RESTITUIDO', 'FALHOU']);
    // Banco: RECEBIDO não tem e-mail de conclusão; nasce sem ele.
    const r3 = await registrar({ recebidoEm: await instante('clock_timestamp()') });
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET email_conclusao = 'ENVIADO' WHERE protocolo = $1", [r3.m.protocolo]), /conclusao_email_check/);
});

test('6f. pedido do canal oficial recebido ANTES da recontratação (P2-N6) e e-mail com o efeito real (P3-N1)', { skip: !opt() }, async () => {
    const instante = async (expr: string) => (await q(`SELECT to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    const gestao = async (empresaId: string) => {
        const m = (await q("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id",
            [empresaId, ids.usuario])).rows[0].id;
        await q("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
    };
    const emailGestao = (await q('SELECT email FROM usuarios_administrativos WHERE id = $1', [ids.usuario])).rows[0].email as string;
    const lancar = (empresaId: string, recebidoEm: string) => emTx(() => registrarArrependimentoAtendimento(client as never, { empresaId, atendenteId: ids.atendimento,
        chave: randomUUID(), emailSolicitante: emailGestao, recebidoEm, referencia: 'E-mail de desistência recebido em contato@' }));
    const deps = { withTransaction: <T,>(t: (tx: never) => Promise<T>) => emTx(() => t(client as never)), env: SEM_PROVEDOR, enviarEmail };
    const hoje = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;

    // (a) REVIEW N6: o e-mail chega na assinatura A; antes do lançamento a empresa recontrata (B, paga, ATIVA).
    ids.atual = await empresaAtivaAntiga('44111222000157');
    await gestao(ids.atual);
    const subA = (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [ids.atual])).rows[0].s as string;
    const recebidoEm = await instante('clock_timestamp()');
    const subB = `${subA}_nova`, cliente = assinaturas.get(subA)!.customer;
    assinaturas.set(subB, { id: subB, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: cliente, externalReference: ids.atual, valorCentavos: 19_700 });
    cobrancas.set(subB, [{ id: `pay_${subB}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: subB }]);
    await q("UPDATE empresa_assinaturas SET situacao = 'CANCELADA_FIM_PERIODO', cancelada_em = clock_timestamp() WHERE empresa_id = $1", [ids.atual]);
    await q('UPDATE empresa_assinaturas SET provedor_assinatura_id = $2 WHERE empresa_id = $1', [ids.atual, subB]);
    const s0 = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s0.resultado === 'SINCRONIZADA' && s0.depois, 'ATIVA');
    const r = await lancar(ids.atual, recebidoEm);
    assert.equal((await linha(r.m.protocolo)).provedor_assinatura_id, null, 'a assinatura NOVA não é capturada como a do pedido');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: r.m.protocolo, referencia: 'estorno da antiga' }));
    const concluir = (assinaturaId: string | null) => emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: r.m.protocolo, usuarioId: ids.atendimento,
        situacao: 'RESTITUIDO', referencia: 'estorno Asaas', valorCentavos: 19_700, cobrancaIds: [`pay_${subA}_1`], assinaturaId }, provedor as never));
    assert.equal(await erro(concluir(null)), 'CONFLITO', 'sem a assinatura informada não conclui (e não encerra B)');
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA');
    assert.deepEqual(await concluir(subA), { protocolo: r.m.protocolo, situacao: 'RESTITUIDO', encerrou: false, mesmaAssinatura: false, evidencia: 'PROVEDOR' });
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA', 'a recontratação continua ativa');
    // P3-N1: o e-mail diz que a contratação atual permanece ativa — não promete somente leitura.
    enviados.length = 0;
    assert.equal(await enviarEmailConclusao(deps, ids.atual, r.m.protocolo), 'ENVIADO');
    assert.match(enviados[0].texto, /Este pedido se refere à contratação anterior e não altera a sua contratação atual\./);
    assert.doesNotMatch(enviados[0].texto, /somente leitura|permanece ativa/);
    // P3-R1: com a contratação atual EM ATRASO, o texto continua sem afirmar que ela está ativa.
    await q("UPDATE empresa_assinaturas SET situacao = 'EM_ATRASO', em_atraso_desde = clock_timestamp() - interval '30 days' WHERE empresa_id = $1", [ids.atual]);
    const r2 = await lancar(ids.atual, await instante('clock_timestamp()'));
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: r2.m.protocolo, referencia: 'estorno' }));
    await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: r2.m.protocolo, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno Asaas', valorCentavos: 19_700, cobrancaIds: [`pay_${subA}_2`], assinaturaId: subA }, provedor as never));
    enviados.length = 0;
    assert.equal(await enviarEmailConclusao(deps, ids.atual, r2.m.protocolo), 'ENVIADO');
    assert.match(enviados[0].texto, /não altera a sua contratação atual/);
    assert.doesNotMatch(enviados[0].texto, /ativa|somente leitura/);

    // (b) Recebimento DEPOIS de uma contratação CONFIRMADA da assinatura atual: o vínculo do pedido é a atual.
    //     (c) Recebimento ANTES dessa confirmação: sem vínculo (não se sabe qual assinatura valia).
    ids.atual = await empresaEmTeste('55222333000157');
    await gestao(ids.atual);
    const antesDaConfirmacao = await instante('clock_timestamp()');
    await emTx(() => prepararOferta(client as never, ids.atual, ids.usuario, { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11_820, versao: '2026-10-20' },
        { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' }));
    const subC = `sub_ar_c_${++seq}`;
    assinaturas.set(subC, { id: subC, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: `cus_c_${seq}`, externalReference: ids.atual, valorCentavos: 11_820 });
    cobrancas.set(subC, [{ id: `pay_${subC}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 11_820, billingType: 'PIX',
        assinaturaId: subC, clienteId: `cus_c_${seq}` }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [ids.atual, `cus_c_${seq}`, subC]);
    const sc = await emTx(() => sincronizarEmpresa(client as never, ids.atual, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(sc.resultado === 'SINCRONIZADA' && sc.depois, 'ATIVA', JSON.stringify(sc));
    assert.equal(Number((await q("SELECT count(*) AS n FROM assinatura_contratacoes WHERE empresa_id = $1 AND estado = 'CONFIRMADA' AND provedor_assinatura_id = $2", [ids.atual, subC])).rows[0].n), 1);
    const depois = await lancar(ids.atual, await instante('clock_timestamp()'));
    assert.equal((await linha(depois.m.protocolo)).provedor_assinatura_id, subC, 'contratação confirmada até o recebimento: vínculo provado');
    const antes = await lancar(ids.atual, antesDaConfirmacao);
    assert.equal((await linha(antes.m.protocolo)).provedor_assinatura_id, null, 'recebido antes da confirmação: sem vínculo');
    // Com vínculo: a conclusão encerra e o e-mail diz somente leitura (efeito real).
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: depois.m.protocolo, referencia: 'estorno' }));
    const rc = await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: depois.m.protocolo, usuarioId: ids.atendimento, situacao: 'RESTITUIDO',
        referencia: 'estorno Asaas', valorCentavos: 11_820, cobrancaIds: [`pay_${subC}_1`] }));
    assert.equal(rc.encerrou, true);
    enviados.length = 0;
    assert.equal(await enviarEmailConclusao(deps, ids.atual, depois.m.protocolo), 'ENVIADO');
    assert.match(enviados[0].texto, /O período contratado foi encerrado; a área do sistema fica disponível em somente leitura/);
});

test('7. conferência D-C4: RECEBIDA há mais de 1 h vira pendência (SEM_COMUNICACAO / SEM_CONCLUSAO); concluídas não', { skip: !opt() }, async () => {
    ids.atual = await empresaAtivaAntiga('55666777000181');
    const a = await pedir('Sem comunicação');
    const b = await pedir('Comunicada, sem conclusão');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.atual, protocolo: b.protocolo, referencia: 'Asaas' }));
    const agora = Date.now();
    const antes = (await reconciliar.lerPendenciasEncerramento(client, agora)).filter((x) => x.item === 'ARREPENDIMENTO_PENDENTE');
    const daqui2h = (await reconciliar.lerPendenciasEncerramento(client, agora + 2 * 3600_000)).filter((x) => x.item === 'ARREPENDIMENTO_PENDENTE');
    // Todas as manifestações desta suíte têm menos de 1 h: agora nenhuma pendência; daqui a 2 h, todas as RECEBIDAS.
    assert.deepEqual(antes, []);
    const abertas = (await q(`SELECT CASE WHEN intermediador_comunicado_em IS NULL THEN 'SEM_COMUNICACAO' ELSE 'SEM_CONCLUSAO' END AS r, canal
        FROM assinatura_arrependimentos WHERE situacao = 'RECEBIDO' ORDER BY solicitado_em`)).rows;
    assert.equal(daqui2h.length, abertas.length, 'toda manifestação RECEBIDA aparece depois de 1 h; concluídas não');
    assert.deepEqual(daqui2h.map((x) => [x.resultado, x.motivo]), abertas.map((x) => [x.r, x.canal]));
    assert.ok(daqui2h.some((x) => x.resultado === 'SEM_COMUNICACAO') && daqui2h.some((x) => x.resultado === 'SEM_CONCLUSAO'));
    assert.ok(daqui2h.every((x) => !JSON.stringify(x).includes(a.protocolo) && !JSON.stringify(x).includes(b.protocolo)), 'protocolo não vai para o alarme');
});

test('8. exportação da empresa: manifestações dela no pacote, colunas conferidas, sem dados internos nem de outra empresa', { skip: !opt() }, async () => {
    // FK direta empresa_id → empresa_assinaturas(empresa_id) no catálogo (o filtro do inventário segue uma FK real).
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.assinatura_arrependimentos'::regclass
        AND pg_get_constraintdef(oid) = 'FOREIGN KEY (empresa_id) REFERENCES empresa_assinaturas(empresa_id)'`)).rows[0].n, 1);
    const esta = ids.atual;
    const protocolos = (await q('SELECT protocolo FROM assinatura_arrependimentos WHERE empresa_id = $1 ORDER BY protocolo', [esta])).rows.map((r) => r.protocolo as string);
    const deOutra = (await q('SELECT protocolo FROM assinatura_arrependimentos WHERE empresa_id <> $1', [esta])).rows.map((r) => r.protocolo as string);
    assert.ok(protocolos.length >= 2 && deOutra.length >= 1);
    await q('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let pacote: Awaited<ReturnType<typeof gerarPacote>>;
    try { pacote = await gerarPacote(client as never, esta); }
    finally { await q('COMMIT'); }
    const zip = readFileSync(pacote.zipCaminho);
    await pacote.limpar();
    const a = pacote.manifesto.arquivos.find((x) => x.tabela === 'assinatura_arrependimentos');
    assert.ok(a, 'entidade no pacote com a 097 instalada');
    assert.ok(!pacote.manifesto.entidadesAusentes.some((x) => x.tabela === 'assinatura_arrependimentos'));
    assert.deepEqual(a!.colunas, ['id', 'protocolo', 'empresa_id', 'canal', 'solicitado_por', 'solicitado_em', 'motivo', 'situacao_assinatura', 'contratado_em',
        'dentro_de_7_dias', 'provedor_disponivel', 'provedor_assinatura_id', 'intermediador_comunicado_em', 'intermediador_referencia', 'situacao', 'concluido_em',
        'conclusao_referencia', 'valor_restituido_centavos', 'restituicao_limite', 'restituicao_assinatura_id', 'restituicao_cobranca_ids', 'email_confirmacao', 'email_conclusao']);
    assert.equal(a!.linhas, protocolos.length);
    const csv = lerZip(zip).get(a!.caminho)!.toString('utf8');
    for (const p of protocolos) assert.ok(csv.includes(p), `protocolo ${p} no CSV`);
    for (const p of deOutra) assert.ok(!csv.includes(p), 'nada de outra empresa');
    assert.ok(!csv.includes(ids.atendimento), 'quem do atendimento concluiu não sai');
});

test('9. vigia (P2-C3): aviso interno não entregue alarma já; RECEBIDA há 1 h alarma; nada é gravado', { skip: !opt() }, async () => {
    const antes = Number((await q('SELECT count(*) AS n FROM assinatura_arrependimentos')).rows[0].n);
    // Registro novo com aviso interno sem canal configurado: alarma na execução seguinte, antes de 1 h.
    ids.atual = await empresaAtivaAntiga('66777888000181');
    const semCanal = await registrarArrependimento(await sessao(), null, { chave: randomUUID(), confirmar: true }, ctx(), deps({}));
    assert.equal(semCanal.avisoInterno, 'NAO_CONFIGURADO');
    const agora = Number((await q('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms')).rows[0].ms);
    const r0 = await vigia.lerVigia(client, agora);
    assert.equal(r0.instalado, true);
    assert.equal(r0.codigo, 2);
    assert.deepEqual(r0.alarmes.map((a) => a.tipo), ['AVISO_INTERNO_NAO_ENTREGUE']);
    // Daqui a 2 h: todas as RECEBIDAS vencidas alarmam (comunicadas ou não).
    const r2 = await vigia.lerVigia(client, agora + 2 * 3600_000);
    const abertas = Number((await q("SELECT count(*) AS n FROM assinatura_arrependimentos WHERE situacao = 'RECEBIDO'")).rows[0].n);
    assert.equal(r2.recebidas, abertas);
    const vencidas = r2.alarmes.filter((a) => a.tipo.startsWith('VENCIDO_')).reduce((t, a) => t + a.quantidade, 0);
    assert.equal(vencidas, abertas);
    assert.equal(Number((await q('SELECT count(*) AS n FROM assinatura_arrependimentos')).rows[0].n), antes + 1, 'o vigia não grava');
    assert.ok(!JSON.stringify(r2).includes(semCanal.protocolo));
});

test('10. rollback recusado com manifestação registrada', { skip: !opt() }, async () => {
    await assert.rejects(q(SQL.down), /rollback recusado: já há manifestação/);
    await q('ROLLBACK').catch(() => undefined);
    assert.equal((await q("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0].ok, true);
});
