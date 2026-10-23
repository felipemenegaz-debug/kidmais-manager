import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import type { MensagemEmail } from '../acessos/email.ts';
import { iniciarTeste } from './servico.ts';
import { lerEstadoComercial } from './estado.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { concluirArrependimento, consultarArrependimento, manifestacoesDaEmpresa, PROTOCOLO_ARREPENDIMENTO, registrarArrependimento,
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
 *   8. rollback recusado com manifestação registrada.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre: ler('database/checks/20261023_097_precheck.sql'), up: ler('database/migrations/20261023_097_assinatura_arrependimentos.sql'),
    post: ler('database/checks/20261023_097_postcheck.sql'), down: ler('database/rollback/20261023_097_assinatura_arrependimentos_down.sql'),
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
    ]) {
        await q('BEGIN');
        try { await q(alteracao); await assert.rejects(q(SQL.post), /restrição ausente ou com definição divergente/); }
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
    // Pelo atendimento: canal ATENDIMENTO aceito (registro de pedido recebido pelo canal oficial).
    await q(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, situacao_assinatura, provedor_disponivel)
        VALUES ('KA-20261023-ABCDEFGH', $1, $2, 'ATENDIMENTO', $3, 'ATIVA', false)`, [ids.atual, randomUUID(), ids.usuario]);
    // Restrições: RESTITUIDO sem comunicação ou sem valor recusado (guardas do banco além do serviço).
    await assert.rejects(q(`UPDATE assinatura_arrependimentos SET situacao = 'RESTITUIDO', concluido_em = clock_timestamp(), concluido_por = $2, conclusao_referencia = 'estorno 1',
        valor_restituido_centavos = 100 WHERE protocolo = $1`, [p, ids.atendimento]), /conclusao_check/);
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET intermediador_comunicado_em = clock_timestamp() WHERE protocolo = $1", [p]), /intermediador_check/);
    await assert.rejects(q(`UPDATE assinatura_arrependimentos SET situacao = 'NAO_APLICAVEL', concluido_em = clock_timestamp(), concluido_por = $2, conclusao_referencia = 'justificativa',
        valor_restituido_centavos = 100 WHERE protocolo = $1`, [p, ids.atendimento]), /conclusao_check/);
});

test('6. atendimento: RESTITUIDO exige comunicação e valor e encerra o acesso; NAO_APLICAVEL não muda o acesso', { skip: !opt() }, async () => {
    const empresaId = ids.atual, p = protocoloA;
    const concluir = (situacao: 'RESTITUIDO' | 'NAO_APLICAVEL', valorCentavos: number | null, protocolo = p) =>
        emTx(() => concluirArrependimento(client as never, { empresaId, protocolo, usuarioId: ids.atendimento, situacao, referencia: 'estorno Asaas 23/10', valorCentavos }));
    assert.equal(await erro(concluir('RESTITUIDO', 19_700)), 'CONFLITO', 'sem comunicação ao intermediador');
    assert.equal(await erro(concluir('RESTITUIDO', null)), 'DADOS_INVALIDOS');
    // Outra empresa não alcança o protocolo.
    const outra = await empresaEmTeste('33444555000181');
    assert.equal(await erro(emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: outra, protocolo: p, referencia: 'Asaas' }))), 'CONFLITO');
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId, protocolo: p, referencia: 'estorno pedido no Asaas' }));
    assert.equal(await erro(emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId, protocolo: p, referencia: 'de novo' }))), 'CONFLITO', 'uma vez só');
    const r = await concluir('RESTITUIDO', 19_700);
    assert.deepEqual(r, { protocolo: p, situacao: 'RESTITUIDO', encerrou: true });
    assert.equal(await situacaoAssinatura(empresaId), 'ENCERRADA');
    const e = await lerEstadoComercial(client as never, empresaId);
    assert.equal(e.acesso.nivel, 'SOMENTE_LEITURA');
    assert.equal(await erro(concluir('NAO_APLICAVEL', null)), 'CONFLITO', 'conclusão uma vez só');
    await assert.rejects(q("UPDATE assinatura_arrependimentos SET valor_restituido_centavos = 1 WHERE protocolo = $1", [p]), /imutável/);
    // NAO_APLICAVEL em outra empresa ativa: não muda o acesso, exige referência (justificativa).
    ids.atual = await empresaAtivaAntiga('44555666000181');
    const n = await pedir('Pedido duplicado por engano');
    const rn = await emTx(() => concluirArrependimento(client as never, { empresaId: ids.atual, protocolo: n.protocolo, usuarioId: ids.atendimento, situacao: 'NAO_APLICAVEL',
        referencia: 'Cliente retirou o pedido por e-mail' }));
    assert.deepEqual(rn, { protocolo: n.protocolo, situacao: 'NAO_APLICAVEL', encerrou: false });
    assert.equal(await situacaoAssinatura(ids.atual), 'ATIVA');
    const lista = await emTx(() => manifestacoesDaEmpresa(client as never, ids.atual));
    assert.equal(lista[0].situacao, 'NAO_APLICAVEL');
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

test('8. rollback recusado com manifestação registrada', { skip: !opt() }, async () => {
    await assert.rejects(q(SQL.down), /rollback recusado: já há manifestação/);
    await q('ROLLBACK').catch(() => undefined);
    assert.equal((await q("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0].ok, true);
});
