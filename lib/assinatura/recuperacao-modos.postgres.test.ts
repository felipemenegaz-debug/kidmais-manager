import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { processarEvento, registrarEvento, sincronizarEmpresa } from './sincronizacao.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import { processarEventoCreditos, processarPedido, vincularCobrancaCriada, type ContextoProvedor } from '../creditos/pagamento.ts';
import { provedorSomenteLeitura } from './recuperacao-provedor.ts';
import { TABELAS } from './recuperacao-efeitos.ts';
import { hashCanonico, hashProposta } from './recuperacao-hash.ts';
import { EVENTOS_OBRIGATORIOS } from './recuperacao-execucao.ts';
import { identidadeDoCaso } from './recuperacao-casos.ts';
import { pedidosDaFila } from '../creditos/fila.ts';
import { modoAplicarCaso, modoConferirCaso, modoDrenagem, modoInventario, modoJanela, modoLiberacao, type Arquivos, type Execucao, type Resultado } from './recuperacao-modos.ts';
import { AsaasFalhou, type AssinaturaProvedor, type CobrancaProvedor, type WebhookProvedor } from './asaas.ts';

/**
 * B-14 incremento 4 (plano rev. 8.1, §3.2, §3.5, §3.6, §4, §5) no PostgreSQL DESCARTÁVEL, modelo 097, Asaas FALSO único
 * para a suíte inteira (todas as empresas do banco são conhecidas por ele):
 *   1. JANELA --conferir: estável → código 0, nada gravado; base selada uma vez e comparada; recusa de recriar a base;
 *   2. JANELA divergente: --conferir 2 sem gravar; --recuperar aplica (COMMIT por caso); a conferência seguinte fecha 0;
 *   3. RESTORE: drenagem, inventário (nada gravado, arquivo de casos, órfã), conferir-caso NAO_APLICADO, liberação
 *      bloqueada por "nenhuma ação" com efeito, aplicar-caso (invalida a liberação), conferir-caso APLICADO/DIVERGENTE,
 *      liberação LIBERADA, repetição recusada; SIGTERM → 1 sem arquivo; LIMITE_EXECUCAO → 3;
 *   4. P3-R2-1: a fila do painel mostra a situação e a conferência da cobrança do pedido retido.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
const DIA = 86400000;
const MIGRACOES_P9 = ['089', '090', '092', '093', '094', '095', '096', '097', '099'];
const URL_WEBHOOK = 'https://kidmais.example/api/integracoes/asaas/webhook';

let client: Client;
let usuario = '';
let seq = 0;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
function cnpj(n: number) {
    const base = `7${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
const docs = () => Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
const hoje = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
const agoraIso = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS t")).rows[0].t as string;

/** Asaas falso da suíte: assinaturas, cobranças por assinatura, avulsas, listagem por data (comprovada) e webhooks. */
const subs = new Map<string, AssinaturaProvedor>();
const daAssinatura = new Map<string, CobrancaProvedor[]>();
const avulsas = new Map<string, CobrancaProvedor>();
let webhooks: WebhookProvedor[] = [{ id: 'wh_1', url: URL_WEBHOOK, enabled: true, interrupted: false, sendType: 'SEQUENTIALLY', events: [...EVENTOS_OBRIGATORIOS] }];
const cliente = {
    async obterAssinatura(id: string) { const s = subs.get(id); return s ? { ...s } : null; },
    async listarCobrancasDaAssinatura(id: string) { return (daAssinatura.get(id) ?? []).map((p) => ({ ...p })); },
    async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((s) => s.externalReference === ref).map((s) => ({ ...s })); },
    async obterCobranca(id: string) { const c = avulsas.get(id); return c ? { ...c, estornos: [...(c.estornos ?? [])] } : null; },
    async listarCobrancasPorReferencia(ref: string) { return [...avulsas.values()].filter((c) => c.externalReference === ref).map((c) => ({ ...c })); },
    async listarCobrancas() { const itens = [...avulsas.values(), ...[...daAssinatura.values()].flat()].map((c) => ({ ...c })); return { itens, totalCount: itens.length }; },
    async listarWebhooks() { return { itens: webhooks.map((w) => ({ ...w })), totalCount: webhooks.length }; },
    async removerAssinatura() { throw new Error('escrita no provedor proibida'); },
};

async function empresaAtiva() {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Modos', 'PROVISIONAMENTO') RETURNING id", [`rm${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Modos Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `rm${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    await emTx(() => prepararOferta(client as never, id, usuario, { ...PEDIDO, documentos: docs() }, ENV));
    const dia = await hoje();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: dia };
    subs.set(sub.id, sub);
    daAssinatura.set(sub.id, [{ id: `pay_${k}`, status: 'RECEIVED', dueDate: dia, paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    const r = await emTx(() => sincronizarEmpresa(client as never, id, { provedor: provedorSomenteLeitura(cliente) as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return { id, sub };
}

async function pedidoWalle(empresaId: string, clienteId: string) {
    const pedidoId = randomUUID();
    const dia = await hoje();
    const letras = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
    const protocolo = `KM-${dia.replaceAll('-', '')}-${Array.from(randomBytes(8), (b) => letras[b % letras.length]).join('')}`;
    await q(`INSERT INTO ia_credito_pedidos (id, empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256, quantidade,
            preco_centavos, validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
        VALUES ($1, $2, $3, 'WALLE', 'CATALOGO-B14', 'WALLE_1000', '{}'::jsonb, 'creditos-ia-20261022.demo', $4, 1000, 9900, 90, 'PIX', 'sandbox', $5, $4,
            'CRIACAO_EM_CURSO', $6, $7::date)`, [pedidoId, empresaId, protocolo, 'a'.repeat(64), randomUUID(), usuario, dia]);
    const pagamento: CobrancaProvedor = { id: `pay_${randomBytes(5).toString('hex')}`, status: 'PENDING', dueDate: dia, paymentDate: null, invoiceUrl: null, deleted: false,
        valorCentavos: 9900, clienteId, billingType: 'PIX', externalReference: `km:sandbox:creditos:${pedidoId}`, assinaturaId: null };
    avulsas.set(pagamento.id, pagamento);
    const ctx: ContextoProvedor = { provedor: provedorSomenteLeitura(cliente) as never, ambiente: 'sandbox', conta: 'padrao' };
    await emTx(() => vincularCobrancaCriada(client as never, pedidoId, ctx, pagamento));
    return { pedidoId, pagamento, ctx };
}

/** Digest de TODAS as linhas das tabelas da lista fechada: prova de que nada foi gravado. */
async function digest() {
    const partes: string[] = [];
    for (const t of Object.keys(TABELAS).sort()) {
        if (!(await q("SELECT to_regclass('public.' || $1) IS NOT NULL AS ok", [t])).rows[0].ok) continue;
        partes.push(`${t}:${(await q(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) AS h FROM public.${t} x`)).rows[0].h}`);
    }
    return partes.join('|');
}

function arquivosEmMemoria(): Arquivos & { mapa: Map<string, unknown> } {
    const mapa = new Map<string, unknown>();
    return {
        mapa,
        ler: (n) => (mapa.has(n) ? JSON.parse(JSON.stringify(mapa.get(n))) : null),
        gravarNovo: (n, c) => { if (mapa.has(n)) throw new Error('EEXIST'); mapa.set(n, JSON.parse(JSON.stringify(c))); },
        invalidar: (n) => { mapa.set(`${n}.invalidada`, mapa.get(n)); mapa.delete(n); },
        listar: (p) => [...mapa.keys()].filter((k) => k.startsWith(p) && k.endsWith('.json')).sort(),
    };
}
const arquivos = arquivosEmMemoria();
const execucao = (extra: Partial<Execucao> = {}): Execucao => ({ client: client as never, cliente, execucao: randomUUID(), ambiente: 'sandbox',
    creditos: { ambiente: 'sandbox', conta: 'padrao' }, controle: { parar: async () => null }, arquivos, migracoes: MIGRACOES_P9, codigoNoAr: 'CANDIDATA', ...extra });
const janela = async () => ({ desde: new Date(Date.parse(await agoraIso()) - DIA).toISOString(), ate: await agoraIso() });

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Modos', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`rm${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

let estavel: { id: string; sub: AssinaturaProvedor };

test('JANELA --conferir estável → 0, nada gravado; base selada uma vez; comparação com a base → 0', { skip: !opt() }, async () => {
    estavel = await empresaAtiva();
    const p = await pedidoWalle(estavel.id, estavel.sub.customer!);
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    const j = await janela();
    const antes = await digest();
    const r = await modoJanela(execucao(), { ...j, recuperar: false, selar: 'base-e0.json' });
    assert.equal(await digest(), antes, 'conferir não grava');
    assert.deepEqual([r.codigo, r.resultado, r.classes], [0, 'CONCLUIDA', { RECONCILIADA: 2 }]);
    assert.match(String(r.baseSelada), /^[0-9a-f]{64}$/);
    const sha = r.baseSelada as string;
    // A base nunca é recriada.
    const de_novo = await modoJanela(execucao(), { ...j, recuperar: false, selar: 'base-e0.json' });
    assert.deepEqual([de_novo.codigo, de_novo.baseRecusada, de_novo.baseSelada], [2, 'BASE_JA_EXISTE', null]);
    const comBase = await modoJanela(execucao(), { ...(await janela()), recuperar: false, base: { nome: 'base-e0.json', sha } });
    assert.deepEqual([comBase.codigo, (comBase.base as { valida: boolean }).valida], [0, true]);
    const shaErrado = await modoJanela(execucao(), { ...(await janela()), recuperar: false, base: { nome: 'base-e0.json', sha: 'f'.repeat(64) } });
    assert.deepEqual([shaErrado.codigo, (shaErrado.base as { motivo: string }).motivo], [2, 'BASELINE_INVALIDA']);
});

test('JANELA divergente: --conferir 2 sem gravar; --recuperar aplica por caso; a conferência seguinte fecha 0', { skip: !opt() }, async () => {
    const { id } = await empresaAtiva();
    const p = await pedidoWalle(id, (await q('SELECT provedor_cliente_id AS c FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].c);
    // Pagamento confirmado no Asaas, webhook perdido: o crédito não existe.
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    const antes = await digest();
    const c = await modoJanela(execucao(), { ...(await janela()), recuperar: false });
    assert.equal(await digest(), antes);
    assert.equal(c.codigo, 2);
    const pend = (c.pendentes as { identidade: string; classe: string }[]).find((i) => i.identidade === identidadeDoCaso('PEDIDO', p.pedidoId));
    assert.equal(pend?.classe, 'PROPOSTA');
    const rec = await modoJanela(execucao(), { ...(await janela()), recuperar: true });
    assert.deepEqual([rec.codigo, rec.aplicados], [2, [identidadeDoCaso('PEDIDO', p.pedidoId)]]);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p.pedidoId])).rows[0].estado, 'CREDITADO');
    const depois = await modoJanela(execucao(), { ...(await janela()), recuperar: false });
    assert.deepEqual([depois.codigo, depois.classes], [0, { RECONCILIADA: 4 }]);
});

test('JANELA: parada técnica → 1; LIMITE_EXECUCAO → 3 (cobertura), nunca 2', { skip: !opt() }, async () => {
    const j = await janela();
    assert.equal((await modoJanela(execucao({ controle: { parar: async () => 'SIGTERM' } }), { ...j, recuperar: false })).codigo, 1);
    assert.equal((await modoJanela(execucao({ controle: { parar: async () => 'LIMITE_EXECUCAO' } }), { ...j, recuperar: false })).codigo, 3);
});

/** Decisões (formato 2) presas ao inventário: execução, digest do arquivo de casos e hash de cada proposta. */
function decidir(inv: Resultado, escolha: (identidade: string) => 'APLICAR' | 'OUTRA' | 'NENHUMA', extra: Record<string, unknown> = {}) {
    const arquivo = arquivos.ler(`casos-${inv.execucao}.json`) as { casos: { identidade: string; hash: string | null }[]; orfas: { identidade: string }[] };
    const nome = `decisoes-${randomBytes(4).toString('hex')}.json`;
    arquivos.gravarNovo(nome, { formato: 2, inventario: inv.execucao, digestInventario: hashCanonico(arquivo), coberturaAceita: false, retencaoAceita: false,
        casos: Object.fromEntries(arquivo.casos.map((c) => [c.identidade, { decisao: escolha(c.identidade), proposta: c.hash }])),
        orfas: Object.fromEntries(arquivo.orfas.map((o) => [o.identidade, 'ACEITA'])), ...extra });
    return nome;
}
async function drenar(contencaoDesde?: string) {
    const reinicio = await agoraIso();
    const dren = await modoDrenagem(execucao(), { reinicio, contencaoDesde: contencaoDesde ?? new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
    assert.deepEqual([dren.codigo, dren.resultado], [2, 'PASS']);
    return { reinicio, drenagem: `drenagem-${dren.execucao}.json` };
}

test('RESTORE completo: drenagem → inventário → conferir/liberar/aplicar/conferir/liberar', { skip: !opt() }, async () => {
    const { reinicio, drenagem } = await drenar();
    // Caso novo: crédito pago no Asaas e perdido no restore; e uma cobrança de créditos sem pedido local (órfã).
    const { id } = await empresaAtiva();
    const p = await pedidoWalle(id, (await q('SELECT provedor_cliente_id AS c FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].c);
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    const orfa = `pay_${randomBytes(5).toString('hex')}`;
    avulsas.set(orfa, { id: orfa, status: 'RECEIVED', dueDate: await hoje(), paymentDate: await hoje(), invoiceUrl: null, deleted: false, valorCentavos: 9900,
        externalReference: `km:sandbox:creditos:${randomUUID()}`, assinaturaId: null });
    const caso = identidadeDoCaso('PEDIDO', p.pedidoId);
    const desde = (await janela()).desde;

    // Inventário: nada gravado; arquivo de casos com a proposta; órfã ORFA_CREDITOS.
    let antes = await digest();
    const inv = await modoInventario(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio });
    assert.equal(await digest(), antes, 'inventário não grava');
    assert.deepEqual([inv.codigo, inv.resultado], [2, 'ASSISTIDO']);
    const casos = arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string; classe: string; proposta: unknown }[] };
    assert.equal(inv.digestDoArquivo, hashCanonico(casos));
    const aprovado = casos.casos.find((c) => c.identidade === caso)!;
    assert.equal(aprovado.classe, 'PROPOSTA');
    assert.ok(casos.casos.every((c) => !('antes' in c)), 'a fotografia interna não vai para o arquivo');
    assert.deepEqual((inv.orfas as { identidade: string; classe: string }[]).map((o) => o.classe), ['ORFA_CREDITOS']);
    const j = { casos: inv.arquivoDeCasos as string, identidade: caso, proposta: aprovado.hash };

    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: randomUUID() })).resultado, 'NAO_APLICADO');
    assert.equal(await digest(), antes, 'conferir-caso não grava');

    // Liberação com "nenhuma ação" num caso com efeito: bloqueada.
    const lib1 = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: decidir(inv, () => 'NENHUMA'), urlWebhook: URL_WEBHOOK });
    assert.deepEqual([lib1.codigo, lib1.resultado, lib1.bloqueios], [2, 'BLOQUEADA', ['COM_EFEITO_NORMAL']]);
    assert.equal(await digest(), antes, 'liberação não grava');
    assert.equal(arquivos.listar('liberacao-').length, 1);
    // P2-4: decisões de um inventário inexistente ou com digest de outro arquivo → recusa.
    const forjado = decidir(inv, () => 'NENHUMA', { inventario: randomUUID() });
    await assert.rejects(modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: forjado, urlWebhook: URL_WEBHOOK }), /INVENTARIO_DAS_DECISOES_INEXISTENTE/);
    const alterado = decidir(inv, () => 'NENHUMA', { digestInventario: 'e'.repeat(64) });
    await assert.rejects(modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: alterado, urlWebhook: URL_WEBHOOK }), /INVENTARIO_DAS_DECISOES_ALTERADO/);

    // Proposta adulterada (hash não confere) → recusa antes de qualquer SQL.
    await assert.rejects(modoAplicarCaso(execucao(), { ...j, proposta: 'f'.repeat(64) }), /HASH_DA_PROPOSTA_DIVERGENTE/);
    // P2-5: o registro da aplicação (e a invalidação) vêm ANTES do COMMIT; se falharem, nada é gravado.
    const semRegistro: Arquivos = { ...arquivos, gravarNovo: (n, c) => { if (n.startsWith('aplicacao-')) throw new Error('disco'); arquivos.gravarNovo(n, c); } };
    await assert.rejects(modoAplicarCaso(execucao({ arquivos: semRegistro }), j), /REGISTRO_DA_APLICACAO_FALHOU/);
    assert.equal(await digest(), antes, 'sem registro, sem COMMIT');
    // P2-R2-2: parada que chega durante a gravação do comprovante (3ª conferência: entrada, depois da aplicação, depois do
    // comprovante) → ROLLBACK explícito: nem efeitos nem comprovante confirmados, nenhum registro.
    let chamadasAp = 0;
    const nReg = arquivos.listar('aplicacao-').length;
    await assert.rejects(modoAplicarCaso(execucao({ controle: { parar: async () => (++chamadasAp >= 3 ? 'SIGTERM' : null) } }), j), /SIGTERM/);
    assert.equal(chamadasAp, 3);
    assert.equal(await digest(), antes, 'parada depois do comprovante: nada confirmado');
    assert.equal(arquivos.listar('aplicacao-').length, nReg);
    assert.equal(arquivos.listar('liberacao-').length, 0, 'a invalidação vem antes da tentativa');
    // A liberação é refeita (invalidada pela tentativa acima) e o aplicar-caso a invalida de novo antes do COMMIT.
    await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: decidir(inv, () => 'NENHUMA'), urlWebhook: URL_WEBHOOK });
    assert.equal(arquivos.listar('liberacao-').length, 1);
    // P2-R1-1: a execução A registrou a tentativa e morreu antes do COMMIT (desfeita); a B aplica a mesma proposta depois.
    const execA = randomUUID();
    arquivos.gravarNovo(`aplicacao-${execA}.json`, { formato: 1, execucao: execA, identidade: caso, hash: aprovado.hash, inicio: await agoraIso(), estado: 'COMMIT_TENTADO' });
    const ap = await modoAplicarCaso(execucao(), j);
    assert.deepEqual([ap.codigo, ap.resultado], [2, 'APLICADO']);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p.pedidoId])).rows[0].estado, 'CREDITADO');
    // Comprovante transacional da B (auditoria só de inserção), com caso e hash.
    const comp = (await q("SELECT dados_depois FROM auditoria WHERE request_id = $1 AND acao = 'RECUPERACAO_B14_CASO_APLICADO'", [ap.execucao])).rows;
    assert.deepEqual(comp.map((r) => [r.dados_depois.caso, r.dados_depois.hash]), [[caso, aprovado.hash]]);
    // P2-R1-2: o início registrado é o da transação: nunca posterior ao DEFAULT now() da auditoria gravada nela (microssegundos, no banco).
    const ini = (arquivos.ler(`aplicacao-${ap.execucao}.json`) as { inicio: string }).inicio;
    assert.equal((await q("SELECT $1::timestamptz <= min(criado_em) AND $1::timestamptz = min(criado_em) AS ok FROM auditoria WHERE request_id = $2", [ini, ap.execucao])).rows[0].ok, true);
    // A conferência da A não pode ser comprovada pelos efeitos da B (sem comprovante da A) → DIVERGENTE.
    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: execA })).resultado, 'DIVERGENTE');
    assert.equal(arquivos.listar('liberacao-').length, 0, 'liberação anterior invalidada');
    const registro = arquivos.ler(`aplicacao-${ap.execucao}.json`) as { estado: string; inicio: string };
    assert.equal(registro.estado, 'COMMIT_TENTADO');
    // P2-3: APLICADO só com a prova da aplicação (registro com início e execução); sem registro → DIVERGENTE.
    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: ap.execucao as string })).resultado, 'APLICADO');
    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: randomUUID() })).resultado, 'DIVERGENTE');
    // Registro com início POSTERIOR à aplicação real: as linhas não provam esta aplicação → DIVERGENTE.
    const tarde = randomUUID();
    arquivos.gravarNovo(`aplicacao-${tarde}.json`, { formato: 1, execucao: tarde, identidade: caso, hash: aprovado.hash, inicio: new Date(Date.now() + 3_600_000).toISOString(), estado: 'COMMIT_TENTADO' });
    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: tarde })).resultado, 'DIVERGENTE');
    // Repetir a aplicação: o estado mudou → DIVERGENTE (1), nada gravado.
    antes = await digest();
    const de_novo = await modoAplicarCaso(execucao(), j);
    assert.deepEqual([de_novo.codigo, de_novo.resultado], [1, 'DIVERGENTE']);
    assert.equal(await digest(), antes);

    // Proposta aprovada com efeito diferente do gravado (mesma prova de execução) → conferir-caso DIVERGENTE.
    const outro = structuredClone(aprovado) as { identidade: string; hash: string; proposta: { efeitos: { tabela: string; colunas: Record<string, { depois: unknown }> }[] } };
    outro.proposta.efeitos.find((e) => e.tabela === 'ia_credito_lotes')!.colunas.quantidade.depois = 999;
    outro.hash = hashProposta(outro.proposta as never);
    arquivos.gravarNovo('casos-adulterado.json', { formato: 1, casos: [outro] });
    const exAdult = randomUUID();
    arquivos.gravarNovo(`aplicacao-${exAdult}.json`, { formato: 1, execucao: exAdult, identidade: caso, hash: outro.hash, inicio: registro.inicio, estado: 'COMMIT_TENTADO' });
    assert.deepEqual((await modoConferirCaso(execucao(), { casos: 'casos-adulterado.json', identidade: caso, proposta: outro.hash, execucaoDaAplicacao: exAdult })).resultado, 'DIVERGENTE');

    // Liberação final: tudo SEM_EFEITO, decidido, órfã aceita, fila 0 → LIBERADA (RESTORE nunca 0).
    const aplicar = decidir(inv, (i) => (i === caso ? 'APLICAR' : 'NENHUMA'));
    const lib2 = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: aplicar, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([lib2.codigo, lib2.resultado, lib2.bloqueios], [2, 'LIBERADA', []]);
    // Fila só interrompida: libera com as exigências; desabilitada: bloqueia; ilegível: cobertura (3; P2-7).
    webhooks = [{ ...webhooks[0], interrupted: true }];
    const lib3 = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: aplicar, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([lib3.resultado, lib3.exigenciasPosReabertura], ['LIBERADA', ['REATIVAR_FILA', 'NOVA_LEITURA_FILA_CODIGO_0', 'CONFIRMAR_ENTREGA']]);
    webhooks = [{ ...webhooks[0], interrupted: false, enabled: false }];
    const lib4 = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: aplicar, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([lib4.resultado, lib4.bloqueios], ['BLOQUEADA', ['FILA:DESABILITADA']]);
    webhooks = [{ ...webhooks[0], enabled: true }];
    const filaFora = { ...cliente, listarWebhooks: async () => { throw new AsaasFalhou('listar webhooks', 503, 'HTTP'); } };
    const lib5 = await modoLiberacao(execucao({ cliente: filaFora }), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: aplicar, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([lib5.codigo, lib5.resultado], [3, 'BLOQUEADA']);

    // P2-6: SIGTERM chegando durante a leitura da fila (depois dos casos) → INTERROMPIDA (1), sem registro de liberação.
    let lida = false;
    const lenta = { ...cliente, listarWebhooks: async () => { lida = true; return cliente.listarWebhooks(); } };
    const nLib = arquivos.listar('liberacao-').length;
    const sig = await modoLiberacao(execucao({ cliente: lenta, controle: { parar: async () => (lida ? 'SIGTERM' : null) } }),
        { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: aplicar, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([sig.codigo, sig.resultado, arquivos.listar('liberacao-').length], [1, 'INTERROMPIDA', nLib]);

    // Drenagem de outro reinício não vale; SIGTERM no inventário → 1 sem arquivo; LIMITE_EXECUCAO → 3 sem arquivo de casos.
    await assert.rejects(modoInventario(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio: '2026-01-01T00:00:00.000Z' }), /DRENAGEM_NAO_COMPROVADA/);
    const n = arquivos.listar('casos-').length;
    const sigInv = await modoInventario(execucao({ controle: { parar: async () => 'SIGTERM' } }), { desde, ate: await agoraIso(), drenagem, reinicio });
    assert.deepEqual([sigInv.codigo, arquivos.listar('casos-').length], [1, n]);
    const lim = await modoInventario(execucao({ controle: { parar: async () => 'LIMITE_EXECUCAO' } }), { desde, ate: await agoraIso(), drenagem, reinicio });
    assert.deepEqual([lim.codigo, arquivos.listar('casos-').length], [3, n]);
    // P2-R1-3: SIGTERM chegando durante a ÚLTIMA amostra da drenagem → INTERROMPIDA, sem PASS gravado.
    let chamadas = 0;
    const nDren = arquivos.listar('drenagem-').length;
    const r1 = await agoraIso();
    const tardia = await modoDrenagem(execucao({ controle: { parar: async () => (++chamadas >= 3 ? 'SIGTERM' : null) } }), { reinicio: r1, contencaoDesde: r1, amostras: 2, intervaloMs: 0, esperar: async () => undefined });
    assert.deepEqual([tardia.codigo, tardia.resultado, arquivos.listar('drenagem-').length], [1, 'INTERROMPIDA', nDren]);
    // conferir-caso com parada → INTERROMPIDA (entrada) e também depois do trabalho.
    assert.deepEqual((await modoConferirCaso(execucao({ controle: { parar: async () => 'SIGTERM' } }), { ...j, execucaoDaAplicacao: ap.execucao as string })).resultado, 'INTERROMPIDA');
    let c2 = 0;
    const conf = await modoConferirCaso(execucao({ controle: { parar: async () => (++c2 >= 2 ? 'LIMITE_EXECUCAO' : null) } }), { ...j, execucaoDaAplicacao: ap.execucao as string });
    assert.deepEqual([conf.codigo, conf.resultado], [3, 'INTERROMPIDA']);
    // Inventário: prazo esgotado DEPOIS das listagens remotas → 3, sem arquivo de casos.
    let listou = false;
    const listando = { ...cliente, listarCobrancas: async () => { listou = true; return cliente.listarCobrancas(); } };
    const nCasos = arquivos.listar('casos-').length;
    const tarde3 = await modoInventario(execucao({ cliente: listando, controle: { parar: async () => (listou ? 'LIMITE_EXECUCAO' : null) } }), { desde, ate: await agoraIso(), drenagem, reinicio });
    assert.deepEqual([tarde3.codigo, tarde3.resultado, arquivos.listar('casos-').length], [3, 'INTERROMPIDA', nCasos]);
    // P2-7: drenagem parada pelo prazo → 3; por SIGTERM → 1.
    const r0 = await agoraIso();
    assert.equal((await modoDrenagem(execucao({ controle: { parar: async () => 'LIMITE_EXECUCAO' } }), { reinicio: r0, contencaoDesde: r0, amostras: 1 })).codigo, 3);
    assert.equal((await modoDrenagem(execucao({ controle: { parar: async () => 'SIGTERM' } }), { reinicio: r0, contencaoDesde: r0, amostras: 1 })).codigo, 1);
});

test('P2-8: contenção acima de 14 dias exige aceite explícito da retenção', { skip: !opt() }, async () => {
    const { reinicio, drenagem } = await drenar(new Date(Date.now() - 15 * 86_400_000).toISOString());
    const desde = (await janela()).desde;
    const inv = await modoInventario(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio });
    const sem = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: decidir(inv, () => 'NENHUMA'), urlWebhook: URL_WEBHOOK });
    assert.deepEqual([sem.resultado, sem.bloqueios, sem.retencaoAcima14Dias], ['BLOQUEADA', ['RETENCAO_ACIMA_DE_14_DIAS_NAO_ACEITA'], true]);
    const com = await modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: decidir(inv, () => 'NENHUMA', { retencaoAceita: true }), urlWebhook: URL_WEBHOOK });
    assert.deepEqual([com.resultado, com.bloqueios], ['LIBERADA', []]);
    const lib = arquivos.ler(`liberacao-${com.execucao}.json`) as { limitacoes: string[] };
    assert.deepEqual(lib.limitacoes, ['RETENCAO_ACIMA_DE_14_DIAS']);
});

test('P2-2: conferir-caso localiza o evento que a própria aplicação concluiu', { skip: !opt() }, async () => {
    const { id, sub } = await empresaAtiva();
    const ev = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomBytes(5).toString('hex')}`, tipo: 'PAYMENT_RECEIVED', criadoNoProvedor: null,
        assinaturaId: sub.id, cobrancaId: null, checkoutId: null, referenciaExterna: null }));
    subs.set(sub.id, { ...sub, status: 'INACTIVE' });
    const { reinicio, drenagem } = await drenar();
    const inv = await modoInventario(execucao(), { desde: (await janela()).desde, ate: await agoraIso(), drenagem, reinicio });
    const casoEv = identidadeDoCaso('EVENTO', ev.id);
    const aprovado = (arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string }[] }).casos.find((c) => c.identidade === casoEv)!;
    const j = { casos: inv.arquivoDeCasos as string, identidade: casoEv, proposta: aprovado.hash };
    const ap = await modoAplicarCaso(execucao(), j);
    assert.equal(ap.resultado, 'APLICADO');
    assert.equal((await q('SELECT situacao FROM cobranca_eventos WHERE id = $1', [ev.id])).rows[0].situacao, 'PROCESSADO');
    assert.deepEqual((await modoConferirCaso(execucao(), { ...j, execucaoDaAplicacao: ap.execucao as string })).resultado, 'APLICADO');
    // A aplicação de um evento já concluído não o localiza (D-I4-8).
    await assert.rejects(modoAplicarCaso(execucao(), j), /CASO_NAO_LOCALIZADO/);
    // Estado coerente no provedor e no banco: a empresa fica estável para os testes seguintes.
    assert.equal((await q('SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows.length, 1);
});

test('P2-1: cobrança não canônica paga é caso próprio, lida mesmo sem evento', { skip: !opt() }, async () => {
    const { id } = await empresaAtiva();
    const p = await pedidoWalle(id, (await q('SELECT provedor_cliente_id AS c FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].c);
    const extra = `pay_${randomBytes(5).toString('hex')}`;
    avulsas.set(extra, { ...p.pagamento, id: extra, status: 'RECEIVED', paymentDate: await hoje() });
    const cobrancaId = (await q(`INSERT INTO ia_credito_cobrancas (empresa_id, pedido_id, provedor, ambiente, conta, pagamento_id, referencia_externa, canonica, valor_centavos,
            forma_provedor, situacao_provedor, url_fatura, vencimento) VALUES ($1, $2, 'ASAAS', 'sandbox', 'padrao', $3, $4, false, 9900, 'PIX', 'PENDING', NULL, $5::date) RETURNING id`,
        [id, p.pedidoId, extra, `km:sandbox:creditos:${p.pedidoId}`, await hoje()])).rows[0].id as string;
    const caso = identidadeDoCaso('COBRANCA', cobrancaId);
    const antes = await digest();
    const c = await modoJanela(execucao(), { ...(await janela()), recuperar: false });
    assert.equal(await digest(), antes);
    const item = (c.pendentes as { identidade: string; tipo: string; classe: string; recusas: string[] }[]).find((i) => i.identidade === caso);
    // Lida e processada (processarExtra) sem evento: o pagamento duplicado vira efeito com recusa do serviço — decisão da pessoa.
    assert.deepEqual([item?.tipo, item?.classe, item?.recusas], ['COBRANCA', 'PROPOSTA', ['SERVICO:PAGAMENTO_DUPLICADO']]);
    // A JANELA não grava sozinha um caso com recusa: continua pendente, sem escrita.
    const rec = await modoJanela(execucao(), { ...(await janela()), recuperar: true });
    assert.equal((rec.aplicados as string[]).includes(caso), false);
    assert.equal((await q('SELECT revisao_motivo FROM ia_credito_cobrancas WHERE id = $1', [cobrancaId])).rows[0].revisao_motivo, null);
    // No RESTORE, a mesma cobrança é caso do inventário, com proposta para Felipe decidir.
    const { reinicio, drenagem } = await drenar();
    const inv = await modoInventario(execucao(), { desde: (await janela()).desde, ate: await agoraIso(), drenagem, reinicio });
    const noInv = (inv.casos as { identidade: string; classe: string; hash: string | null }[]).find((i) => i.identidade === caso);
    assert.equal(noInv?.classe, 'PROPOSTA');
    assert.match(String(noInv?.hash), /^[0-9a-f]{64}$/);
    // Fecha o cenário pela via normal (o webhook da extra), para não contaminar os testes seguintes.
    await emTx(() => processarEventoCreditos(client as never, { cobrancaProvedorId: extra, referenciaExterna: null }, { pedidoId: p.pedidoId, cobrancaId, canonica: false }, p.ctx));
});

test('P2-7: JANELA — reaplicação com hash divergente é recusa (1); falha absorvida pelo evento é cobertura (3)', { skip: !opt() }, async () => {
    const { id, sub } = await empresaAtiva();
    const p = await pedidoWalle(id, sub.customer!);
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    // As duas leituras da proposta veem RECEIVED; a reexecução da aplicação vê PENDING → hash diferente → desfeita.
    let n = 0;
    const virando = { ...cliente, obterCobranca: async (pid: string) => (pid === p.pagamento.id && ++n > 2 ? { ...avulsas.get(pid)!, status: 'PENDING' } : cliente.obterCobranca(pid)) };
    const antes = await digest();
    const r = await modoJanela(execucao({ cliente: virando }), { ...(await janela()), recuperar: true });
    assert.deepEqual([r.codigo, r.resultado, r.divergentes], [1, 'HASH_DIVERGENTE', [identidadeDoCaso('PEDIDO', p.pedidoId)]]);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p.pedidoId])).rows[0].estado, 'AGUARDANDO_PAGAMENTO');
    assert.equal(await digest(), antes, 'nada gravado do caso divergente');
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'PENDING' });
    // Evento cuja leitura falha no provedor: processarEvento marca FALHOU e devolve o motivo (não lança).
    const ev = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomBytes(5).toString('hex')}`, tipo: 'PAYMENT_RECEIVED', criadoNoProvedor: null,
        assinaturaId: sub.id, cobrancaId: null, checkoutId: null, referenciaExterna: null }));
    let m = 0;
    const cai = { ...cliente, obterAssinatura: async (sid: string) => { if (sid === sub.id && ++m > 2) throw new AsaasFalhou('obter assinatura', 503, 'HTTP'); return cliente.obterAssinatura(sid); } };
    const f = await modoJanela(execucao({ cliente: cai }), { ...(await janela()), recuperar: false });
    assert.equal(f.codigo, 3);
    assert.ok((f.cobertura as { inconclusivos: string[] }).inconclusivos.includes(identidadeDoCaso('EVENTO', ev.id)));
    // O evento continua pendente no banco (conferir não grava); processado pelo provedor normal, fica coerente.
    await emTx(() => processarEvento(client as never, ev.id, { provedor: provedorSomenteLeitura(cliente) as never }));
});

test('RESTORE com o código antigo: a liberação exige a prova do cron 7ce0916f (exceção expressa)', { skip: !opt() }, async () => {
    const { reinicio, drenagem } = await drenar();
    const desde = (await janela()).desde;
    const inv = await modoInventario(execucao({ codigoNoAr: 'ANTIGO' }), { desde, ate: await agoraIso(), drenagem, reinicio });
    const nome = decidir(inv, () => 'NENHUMA');
    const sem = await modoLiberacao(execucao({ codigoNoAr: 'ANTIGO' }), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: nome, urlWebhook: URL_WEBHOOK });
    assert.deepEqual([sem.resultado, sem.bloqueios], ['BLOQUEADA', ['SEM_PROVA_DO_CRON_ANTIGO:AUSENTE']]);
    arquivos.gravarNovo('prova-cron.json', { artefato: '7ce0916f', concluida: true, codigo: 0, relatorio: { divergente: false, incompleto: false, kidmais: { violada: false } } });
    const com = await modoLiberacao(execucao({ codigoNoAr: 'ANTIGO' }), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: nome, urlWebhook: URL_WEBHOOK, provaCron: 'prova-cron.json' });
    assert.deepEqual([com.resultado, com.excecaoExpressa], ['LIBERADA', true]);
    // Decisões de um inventário do código antigo não valem com a candidata no ar (contexto).
    await assert.rejects(modoLiberacao(execucao(), { desde, ate: await agoraIso(), drenagem, reinicio, decisoes: nome, urlWebhook: URL_WEBHOOK }), /INVENTARIO_DE_OUTRO_CONTEXTO/);
});

test('P3-R2-1: a fila do painel mostra a situação e a conferência da cobrança do pedido retido', { skip: !opt() }, async () => {
    const { id } = await empresaAtiva();
    const p = await pedidoWalle(id, (await q('SELECT provedor_cliente_id AS c FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].c);
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: null });
    const restore: ContextoProvedor = { ...p.ctx, baseValidade: 'PAGAMENTO' };
    assert.equal((await emTx(() => processarPedido(client as never, p.pedidoId, restore))).motivo, 'SEM_DATA_PAGAMENTO');
    avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'REFUNDED', paymentDate: await hoje() });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    const linha = (await emTx(() => pedidosDaFila(client as never))).find((l) => l.empresa_id === id)!;
    assert.deepEqual([linha.estado, linha.revisao_motivo, linha.cobranca_situacao, linha.retida_pela_pessoa], ['REVISAO', 'SEM_DATA_PAGAMENTO', 'REFUNDED', true]);
    assert.ok(linha.cobranca_conferida_em, 'última conferência visível');
});


/** Entrada real (CLI) contra o banco descartável, com o Asaas falso injetado: alvo, TLS local, trava, marcadores, backup. */
test('entrada (CLI): alvo confirmado, trava ocupada → 1, marcadores divergentes → 1, backup ausente → 1, conferência 0/2 sem gravar', { skip: !opt() }, async () => {
    const { createRequire } = await import('node:module');
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { prefixoDoSchema } = await import('./recuperacao-baseline.ts');
    const { marcadoresDoAmbiente } = await import('./recuperacao-execucao.ts');
    const cli = createRequire(import.meta.url)('../../scripts/recuperacao-pagamentos-producao.cjs');
    const porta = process.env.KIDMAIS_DESCARTAVEL_PORTA;
    const banco = 'kidmais_pacotes_v1_descartavel';
    const cand = 'c'.repeat(40);
    // Migrations declaradas = marcadores presentes + as sem marcador, como faria o CONFERIR do B-5 (o modelo 097 tem a 091;
    // a 100 só troca uma função: declarada). Em sandbox entram os marcadores das neutras (PH); a 103 não tem objeto
    // próprio: declarada pela linha SERVICOS.
    const presentes: string[] = [];
    for (const [m, o] of Object.entries(marcadoresDoAmbiente('sandbox'))) {
        const sql = o.tipo === 'tabela' ? "SELECT to_regclass('public.' || $1) IS NOT NULL AS ok"
            : "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS ok";
        if ((await q(sql, [o.nome])).rows[0].ok) presentes.push(m);
    }
    if ((await q("SELECT to_regclass('public.adicional_categorias') IS NOT NULL AND EXISTS (SELECT 1 FROM adicional_categorias WHERE codigo = 'SERVICOS') AS ok")).rows[0].ok)
        presentes.push('103');
    const declaradas = [...presentes, '092', '099', '100'].sort();
    const neutras = declaradas.filter((m) => Number.parseInt(m, 10) >= 102);
    const schema = prefixoDoSchema(declaradas, 'sandbox');
    assert.ok(schema, `modelo num prefixo da lista: ${declaradas.join(',')}`);
    // PH (D-HML-1 = B): com neutras, o schema é PH em sandbox e fora da lista em production.
    assert.equal(schema!.nome, neutras.length ? 'PH' : 'P11', declaradas.join(','));
    if (neutras.length) assert.equal(prefixoDoSchema(declaradas, 'producao'), null, 'PH nunca em production');
    const env = { DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${banco}`, KIDMAIS_B14_ALVO: `${banco}@127.0.0.1:${porta}`, KIDMAIS_B14_DESCARTAVEL: banco,
        ASAAS_AMBIENTE: 'sandbox', RENDER_GIT_COMMIT: cand };
    const pasta = mkdtempSync(join(tmpdir(), 'b14-cli-'));
    const saidas: string[] = [];
    const log = console.log;
    const rodar = async (argv: string[], extra: Record<string, string> = {}) => {
        let codigo: number | null = null;
        console.log = (s: string) => saidas.push(s);
        try { await cli.main([...argv, `--saida=${pasta}`], { ...env, ...extra }, (c: number) => { codigo = c; }, { cliente }); }
        finally { console.log = log; }
        return { codigo, r: JSON.parse(saidas.at(-1)!) };
    };
    const j = await janela();
    const conferir = ['--janela', '--conferir', `--desde=${j.desde.replace(/\.\d+Z$/, 'Z')}`, `--ate=${(await agoraIso()).replace(/\.\d+Z$/, 'Z')}`, `--migracoes=${declaradas.join(',')}`, `--candidata=${cand}`];
    try {
        const antes = await digest();
        const ok = await rodar(conferir);
        assert.ok([0, 2].includes(ok.codigo!), JSON.stringify(ok.r));
        assert.equal(ok.r.modo, 'JANELA_CONFERIR');
        assert.equal(await digest(), antes, 'a entrada não grava na conferência');
        assert.equal(saidas.join('').includes('kidmais_descartavel@'), false, 'a URL nunca sai');
        assert.ok(readdirSync(pasta).some((n) => n.startsWith('execucao-')));
        // Alvo não confirmado.
        assert.equal((await rodar(conferir, { KIDMAIS_B14_ALVO: `${banco}@127.0.0.1:1` })).r.motivo, 'ALVO_NAO_CONFIRMADO');
        // Commit no ar desconhecido → modo não admitido.
        assert.equal((await rodar(conferir, { RENDER_GIT_COMMIT: 'd'.repeat(40) })).r.motivo, 'CODIGO_NO_AR_DESCONHECIDO');
        // Trava ocupada por outra execução do B-14.
        await q('SELECT pg_advisory_lock(1414, 1027)');
        try {
            const t = await rodar(conferir);
            assert.deepEqual([t.codigo, t.r.motivo], [1, 'TRAVA_OCUPADA']);
        }
        finally { await q('SELECT pg_advisory_unlock(1414, 1027)'); }
        // Marcadores divergentes: declarar P10 (sem a 091) com a tabela da 091 presente.
        // No PH, sem a 091 o schema fica P10 + neutras, que não é PH (exige o P11 completo): recusa antes, pelo schema.
        const semA091 = declaradas.filter((m) => m !== '091');
        const m = await rodar(conferir.map((a) => (a.startsWith('--migracoes=') ? `--migracoes=${semA091.join(',')}` : a)));
        if (neutras.length) {
            assert.equal(prefixoDoSchema(semA091, 'sandbox'), null);
            assert.deepEqual([m.codigo, m.r.motivo], [1, 'SCHEMA_FORA_DA_LISTA']);
        }
        else {
            assert.ok(prefixoDoSchema(semA091));
            assert.deepEqual([m.codigo, m.r.motivo, m.r.migracoes], [1, 'MIGRACOES_DIVERGENTES', ['091']]);
        }
        // PH: neutra presente e não declarada (o CONFERIR omitiu a 102/105) recusa pelo marcador da neutra.
        for (const n of neutras.filter((x) => x !== '103')) {
            const sem = declaradas.filter((x) => x !== n);
            const r = await rodar(conferir.map((a) => (a.startsWith('--migracoes=') ? `--migracoes=${sem.join(',')}` : a)));
            assert.deepEqual([r.codigo, r.r.motivo, r.r.migracoes], [1, 'MIGRACOES_DIVERGENTES', [n]], n);
        }
        // Modo que grava sem backup válido.
        const recuperar = ['--janela', '--recuperar', ...conferir.slice(2), '--backup=export-inexistente.json'];
        const b = await rodar(recuperar);
        assert.deepEqual([b.codigo, b.r.motivo], [1, 'BACKUP_ILEGIVEL']);
        assert.equal(await digest(), antes, 'nada gravado nas recusas');
    }
    finally { rmSync(pasta, { recursive: true, force: true }); }
});

/**
 * Achado do H7 + revisão do Astra (P2-1, P3-1). Isolamento sem apagar (a 068 proíbe DELETE em cobranca_eventos): os eventos
 * do teste são de 2020 e já concluídos (IGNORADO), então só entram numa janela que cubra 2020 — nunca nas janelas de "último
 * dia" dos demais testes, nem pelo filtro PENDENTE/FALHOU. A prova do isolamento está no fim do próprio teste.
 */
test('achado do H7: evento sem empresa com contexto, disposição e evidência; evento novo depois do inventário bloqueia', { skip: !opt() }, async () => {
    const { reinicio, drenagem } = await drenar();
    const desde = '2020-01-01T00:00:00.000Z', ate2020 = '2020-01-02T00:00:00.000Z';
    const evento = async (n: string, ref: { assinatura?: string; cobranca?: string }) => (await q(`INSERT INTO cobranca_eventos (provedor, evento_id, tipo,
            assinatura_provedor_id, cobranca_provedor_id, situacao, recebido_em, processado_em)
        VALUES ('ASAAS', $1, 'PAYMENT_CONFIRMED', $2, $3, 'IGNORADO', '2020-01-01T12:00:00Z', '2020-01-01T12:00:01Z') RETURNING id`,
    [`evt_sem_empresa_${n}_${randomBytes(4).toString('hex')}`, ref.assinatura ?? null, ref.cobranca ?? null])).rows[0].id as string;
    const id1 = await evento('1', { assinatura: `sub_inexistente_${randomBytes(3).toString('hex')}` });
    const sem1 = identidadeDoCaso('EVENTO', id1);
    let antes = await digest();
    const inv = await modoInventario(execucao(), { desde, ate: ate2020, drenagem, reinicio });
    assert.equal(await digest(), antes, 'inventário não grava');
    // Contexto: público sem referências do provedor; o arquivo restrito traz as referências (caminho de correlação).
    assert.deepEqual(inv.eventosSemEmpresa, [sem1]);
    assert.deepEqual(inv.contextoSemEmpresa, [{ identidade: sem1, tipo: 'PAYMENT_CONFIRMED', situacao: 'IGNORADO', recebidoEm: '2020-01-01T12:00:00.000000Z',
        motivo: 'ASSINATURA_SEM_EMPRESA_LOCAL' }]);
    const arquivo = arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string }[]; contextoSemEmpresa: { identidade: string; referencias: { evento: string; assinatura: string } }[] };
    assert.ok(!arquivo.casos.some((c) => c.identidade === sem1), 'não é caso');
    const linha = (await q('SELECT evento_id, assinatura_provedor_id FROM cobranca_eventos WHERE id = $1', [id1])).rows[0];
    assert.deepEqual([arquivo.contextoSemEmpresa[0].referencias.evento, arquivo.contextoSemEmpresa[0].referencias.assinatura], [linha.evento_id, linha.assinatura_provedor_id]);
    // Sem decisão sobre o evento do inventário: recusa no vínculo (antes da correção: BLOQUEADA para sempre).
    const lib = (decisoes: string) => modoLiberacao(execucao(), { desde, ate: ate2020, drenagem, reinicio, decisoes, urlWebhook: URL_WEBHOOK });
    await assert.rejects(lib(decidir(inv, () => 'NENHUMA')), /EVENTO_SEM_EMPRESA_DO_INVENTARIO_SEM_DECISAO/);
    // Aceite nu (formato da rodada 1) é decisão inválida.
    await assert.rejects(lib(decidir(inv, () => 'NENHUMA', { eventosSemEmpresa: { [sem1]: 'ACEITA' } })), /DECISOES_INVALIDAS/);
    const decidido = decidir(inv, () => 'NENHUMA', { eventosSemEmpresa: { [sem1]: { disposicao: 'SEM_EFEITO_COMPROVADO', evidencia: 'assinatura inexistente no Asaas sandbox (teste)' } } });
    antes = await digest();
    const ok = await lib(decidido);
    assert.equal(await digest(), antes, 'liberação não grava');
    // A suíte compartilha o banco: outros casos podem ter bloqueios próprios. O que se exige é a ausência dos deste achado.
    assert.deepEqual([ok.eventosSemEmpresa, ok.eventosSemEmpresaSemDecisao], [[sem1], []]);
    assert.ok(!(ok.bloqueios as string[]).some((b) => b.startsWith('EVENTO_SEM_EMPRESA') || b === 'CASO_SEM_DECISAO'), String(ok.bloqueios));
    assert.deepEqual((arquivos.ler(`liberacao-${ok.execucao}.json`) as { eventosSemEmpresa: unknown }).eventosSemEmpresa, { [sem1]: 'SEM_EFEITO_COMPROVADO' });
    // Evento sem empresa chegado depois do inventário decidido: bloqueia só pelo motivo próprio e aparece com contexto.
    const sem2 = identidadeDoCaso('EVENTO', await evento('2', { cobranca: `pay_inexistente_${randomBytes(3).toString('hex')}` }));
    const novo = await lib(decidido);
    assert.equal(novo.resultado, 'BLOQUEADA');
    assert.deepEqual(new Set(novo.bloqueios as string[]), new Set([...(ok.bloqueios as string[]), 'EVENTO_SEM_EMPRESA_SEM_DECISAO']));
    assert.deepEqual(novo.comEfeito, ok.comEfeito, 'o evento sem empresa não vira caso com efeito');
    assert.deepEqual((novo.eventosSemEmpresaSemDecisao as { identidade: string; motivo: string }[]).map((c) => [c.identidade, c.motivo]), [[sem2, 'COBRANCA_SEM_VINCULO_LOCAL']]);
    // JANELA não recebe decisões: os eventos continuam pendência (código 2), com contexto.
    const jan = await modoJanela(execucao(), { desde, ate: ate2020, recuperar: false });
    assert.notEqual(jan.codigo, 0);
    assert.deepEqual(new Set(jan.eventosSemEmpresa as string[]), new Set([sem1, sem2]));
    // Isolamento (P3-1): fora de uma janela de 2020 os eventos não existem para a ferramenta.
    const atual = await modoJanela(execucao(), { ...(await janela()), recuperar: false });
    assert.deepEqual(atual.eventosSemEmpresa, []);
});
