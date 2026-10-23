import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { consultarOfertas, prepararOferta, type PedidoOferta } from './ofertas.ts';
import { ativarCampanhaAprovada, janelaCalculada, REGRA_APROVADA, resumoCampanha } from './campanha.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { createRequire } from 'node:module';
import { repositorioRenovacao } from './renovacao-repositorio.ts';
import { consultarEncerramento, solicitarEncerramento, type DepsDevolucao } from './devolucao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * 090 — campanha Fundador em duas fases, no PostgreSQL DESCARTÁVEL sobre o modelo 089 (067/068/074a/075/089 pela receita).
 * Provedor e e-mail FALSOS. Datas de campanha SINTÉTICAS (nenhuma data de abertura foi decidida):
 *   1. seis concessões LEGADO criadas pelo código antigo (sem a 090), aplicação com precheck/postcheck, preservação
 *      coluna a coluna, reaplicação recusada, rollback vazio e reaplicação;
 *   2. sem campanha ativada a regra anterior continua (LEGADO);
 *   3. guardas da campanha (rascunho, decisões obrigatórias, datas calculadas no banco, imutabilidade, só uma ativação);
 *   4. janela: 22 adesões sem vaga numerada, retomada idempotente, mesma empresa em duas conexões, chave operacional;
 *   5. fronteira: pedido que espera a trava atravessa o corte e vira lote posterior (relógio lido depois da trava);
 *   6. lote posterior: 20 vagas, disputa real da última em duas conexões, "em confirmação" e depois preço cheio;
 *   7. pagamento tardio de oferta da janela (sincronização), repetido sem efeito, renovação 075 e devolução L1/089.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const UP = ler('database/migrations/20261022_090_campanha_fundador.sql');
const PRE = ler('database/checks/20261022_090_precheck.sql');
const POST = ler('database/checks/20261022_090_postcheck.sql');
const DOWN = ler('database/rollback/20261022_090_campanha_fundador_down.sql');
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const TOKEN = 'token-webhook-sintetico-de-teste-32+caracteres';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_de_teste_sem_valor',
    ASAAS_WEBHOOK_TOKEN: TOKEN, SITE_ATENDIMENTO_EMAIL: 'plataforma@example.test', ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: 'true' };
const ENV_DESLIGADA = { ...ENV, ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: undefined };
const COM_DESCONTO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
const CHEIO: PedidoOferta = { ...COM_DESCONTO, valorEsperadoCentavos: 19700 };
// 90 s: o caso 4 cabe com folga mesmo numa máquina lenta; o caso 5 espera até o corte.
const JANELA_SEGUNDOS = 90;

let client: Client;
let outro: Client;
let terceiro: Client;
let usuario = '';
let campanhaId = '';
let seq = 0;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTxDe<T>(c: Client, acao: (c: Client) => Promise<T>): Promise<T> {
    await c.query('BEGIN');
    try { const r = await acao(c); await c.query('COMMIT'); return r; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
}
const emTx = <T>(acao: () => Promise<T>) => emTxDe(client, acao);
const codigo = (e: unknown) => (e as { code?: string })?.code;

/** CNPJ sintético com DV oficial (raiz não repetida). */
function cnpj(n: number) {
    const base = `9${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
async function empresaEmTeste() {
    const n = ++seq;
    const empresaId = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Campanha', 'PROVISIONAMENTO') RETURNING id", [`cp${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresaId]);
    await emTx(() => iniciarTeste(client as never, { empresaId, documento: cnpj(n) }));
    return empresaId;
}
const ofertaEm = (c: Client, empresaId: string, pedido: PedidoOferta = COM_DESCONTO, env: Record<string, string | undefined> = ENV) =>
    emTxDe(c, (x) => prepararOferta(x as never, empresaId, usuario, pedido, env));
const concessao = async (empresaId: string) => (await q('SELECT * FROM assinatura_fundadores WHERE empresa_id = $1 AND estado <> \'LIBERADA\'', [empresaId])).rows[0];
/** Confirmação como a sincronização faz (mesma transação: vaga + contratação). Só para encher o lote. */
async function confirmarDireto(empresaId: string) {
    await emTx(async () => {
        const c = (await q("SELECT id, fundador_id FROM assinatura_contratacoes WHERE empresa_id = $1 AND estado = 'EM_ABERTO'", [empresaId])).rows[0];
        const pay = `pay_${randomBytes(4).toString('hex')}`;
        await q("UPDATE assinatura_fundadores SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $2 WHERE id = $1", [c.fundador_id, pay]);
        await q("UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $2, provedor_assinatura_id = $3 WHERE id = $1",
            [c.id, pay, `sub_${pay}`]);
    });
}
/** Espera até as conexões indicadas estarem bloqueadas por trava no servidor (pg_stat_activity), observadas pela terceira. */
async function esperarNoServidor(pids: number[], eventos: string[]) {
    for (let i = 0; i < 150; i++) {
        const n = (await terceiro.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = ANY($2::text[])", [pids, eventos])).rows[0].n;
        if (n === pids.length) return;
        await new Promise(r => setTimeout(r, 20));
    }
    assert.fail('as duas conexões não chegaram a esperar a trava no servidor');
}
/** Linhas antigas da 074a (sem as colunas novas), para provar preservação. */
const SNAP = `SELECT id, empresa_id, documento_beneficiario, vaga, estado, reservada_em, confirmada_em, beneficio_fim, pagamento_confirmacao_id,
    liberada_em, evidencia_liberacao FROM assinatura_fundadores ORDER BY id`;

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    outro = await conectarDescartavel({ travar: false });
    terceiro = await conectarDescartavel({ travar: false });
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Campanha', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`cp${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => {
    if (outro) await outro.end().catch(() => undefined);
    if (terceiro) await terceiro.end().catch(() => undefined);
    if (client) await encerrarDescartavel(client);
});

const legado: string[] = [];
test('1. código atual sem a 090: seis concessões legadas; aplicação preserva tudo; reaplicação recusada; rollback vazio e reaplicação', { skip: !opt() }, async () => {
    assert.equal((await q("SELECT to_regclass('public.assinatura_campanhas') IS NULL AS ok")).rows[0].ok, true, 'modelo 089: 090 ausente');
    for (let i = 0; i < 6; i++) {
        const e = await empresaEmTeste(); legado.push(e);
        const o = await ofertaEm(client, e);
        assert.equal(o.valor_final_centavos, 11820);
    }
    await confirmarDireto(legado[0]); await confirmarDireto(legado[1]);
    // Uma liberada com evidência (como os roteiros de homologação: contratação cancelada antes).
    await emTx(async () => {
        await q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética liberada' WHERE empresa_id = $1", [legado[2]]);
        await q("UPDATE assinatura_fundadores SET estado = 'LIBERADA', liberada_em = clock_timestamp(), evidencia_liberacao = 'Fixture sintética: sem cobrança' WHERE empresa_id = $1", [legado[2]]);
    });
    const antes = (await q(SNAP)).rows;
    const contratosAntes = (await q('SELECT to_jsonb(c) AS j FROM assinatura_contratacoes c ORDER BY id')).rows;
    assert.deepEqual(antes.map(r => r.estado).sort(), ['CONFIRMADA', 'CONFIRMADA', 'LIBERADA', 'RESERVADA', 'RESERVADA', 'RESERVADA']);

    await q(PRE); await q(UP); await q(POST);
    assert.deepEqual((await q(SNAP)).rows, antes, 'colunas antigas intactas');
    assert.deepEqual((await q('SELECT to_jsonb(c) AS j FROM assinatura_contratacoes c ORDER BY id')).rows, contratosAntes);
    assert.deepEqual((await q("SELECT DISTINCT origem, campanha_id IS NULL AS sem FROM assinatura_fundadores")).rows, [{ origem: 'LEGADO', sem: true }]);
    await assert.rejects(q(UP), /090 já aplicada/); await q('ROLLBACK').catch(() => undefined);
    await assert.rejects(q(PRE), /aplicação anterior ou parcial/);
    // INSERT direto sem origem não herda LEGADO (padrão removido).
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga) SELECT empresa_id, documento_teste, 19 FROM empresa_assinaturas WHERE empresa_id = $1", [legado[2]]),
        /origem da concessão obrigatória/);
    await q(DOWN);
    assert.deepEqual((await q(SNAP)).rows, antes, 'rollback devolve as linhas intactas');
    assert.equal((await q("SELECT to_regclass('public.assinatura_fundadores_vaga_uk') IS NOT NULL AS ok")).rows[0].ok, true);
    await q(PRE); await q(UP); await q(POST);
    assert.deepEqual((await q(SNAP)).rows, antes);
});

test('2. com a 090 e sem campanha ativada: regra anterior (LEGADO), retomada idempotente, resumo LEGADO', { skip: !opt() }, async () => {
    const e = await empresaEmTeste();
    const o = await ofertaEm(client, e);
    const f = await concessao(e);
    assert.deepEqual([f.origem, f.campanha_id, f.vaga >= 1 && f.vaga <= 20, o.fundador_id === f.id], ['LEGADO', null, true, true]);
    assert.deepEqual(await ofertaEm(client, e), o, 'retomada devolve a mesma oferta');
    const r = await emTx(() => consultarOfertas(client as never, e, ENV));
    assert.deepEqual([r?.campanha, r?.bloqueio], [{ fase: 'LEGADO' }, null]);
    // Pendente legada (RESERVADA, sem pagamento) retoma a própria oferta.
    assert.equal((await ofertaEm(client, legado[3])).fundador_id, (await concessao(legado[3])).id);
    legado.push(e);
});

test('3. guardas da campanha: rascunho, decisões obrigatórias, datas do banco, imutável, ativação única', { skip: !opt() }, async () => {
    await assert.rejects(q("INSERT INTO assinatura_campanhas (codigo, versao_regra, estado) VALUES ('x-ativa', 'v1', 'ATIVA')"), /nasce em RASCUNHO/);
    campanhaId = (await q("INSERT INTO assinatura_campanhas (codigo, versao_regra) VALUES ('fundador-teste', 'fundador-2026-sintetica-v1') RETURNING id")).rows[0].id;
    await assert.rejects(q("UPDATE assinatura_campanhas SET estado = 'ATIVA' WHERE id = $1", [campanhaId]), /contagem da janela não decidida/);
    // D1/D3 no schema: só oferta persistida e só 7 dias.
    await assert.rejects(q("UPDATE assinatura_campanhas SET elegibilidade = 'PAGAMENTO_CONFIRMADO' WHERE id = $1", [campanhaId]), /elegibilidade_check/);
    await assert.rejects(q("UPDATE assinatura_campanhas SET validade_oferta = '8 days' WHERE id = $1", [campanhaId]), /validade_oferta_check/);
    await assert.rejects(q(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'CALENDARIO_LOCAL', abertura_data = (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 2
        WHERE id = $1`, [campanhaId]), /assinatura_campanhas_ativacao_check/);
    // Calendário local numa data futura (em transação desfeita): datas = cálculo TS; antes da abertura não há venda nem LEGADO.
    const e3 = await empresaEmTeste();
    await q('BEGIN');
    try {
        // D1–D3 (22/10/2026): a ativação aprovada fixa calendário de Brasília, oferta persistida e 7 dias de validade.
        const daqui2 = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 2, 'YYYY-MM-DD') AS d")).rows[0].d;
        await ativarCampanhaAprovada(client as never, { codigo: 'fundador-teste', aberturaData: daqui2, autorizacao: 'Teste sintético sem autorização real', operadorId: usuario });
        const r = (await q(`SELECT to_char(abertura_data, 'YYYY-MM-DD') AS d, contagem, elegibilidade, extract(epoch FROM validade_oferta)::int AS v,
              to_char(inicio AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS i, to_char(janela_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS f
            FROM assinatura_campanhas WHERE id = $1`, [campanhaId])).rows[0];
        assert.deepEqual([r.d, r.contagem, r.elegibilidade, r.v], [daqui2, REGRA_APROVADA.contagem, REGRA_APROVADA.elegibilidade, 7 * 86400]);
        assert.deepEqual({ inicio: r.i, janelaFim: r.f }, janelaCalculada('CALENDARIO_LOCAL', { data: r.d }));
        await assert.rejects(prepararOferta(client as never, e3, usuario, COM_DESCONTO, ENV), (x) => codigo(x) === 'CAMPANHA_ANTES_DA_ABERTURA');
        // Encerrar exige motivo (gatilho e CHECK).
        await q('SAVEPOINT s');
        await assert.rejects(q("UPDATE assinatura_campanhas SET estado = 'ENCERRADA' WHERE id = $1", [campanhaId]), /encerramento exige motivo/);
        await q('ROLLBACK TO SAVEPOINT s');
        await q("UPDATE assinatura_campanhas SET estado = 'ENCERRADA', motivo_encerramento = 'Teste sintético de encerramento' WHERE id = $1", [campanhaId]);
    } finally { await q('ROLLBACK'); }
    // Sem ativação retroativa no calendário (função aprovada e guarda do banco).
    const ontem = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 'YYYY-MM-DD') AS d")).rows[0].d;
    await q('BEGIN');
    try {
        await assert.rejects(ativarCampanhaAprovada(client as never, { codigo: 'fundador-teste', aberturaData: ontem, autorizacao: 'Teste sintético sem autorização real', operadorId: usuario }), /no passado/);
        await assert.rejects(q(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'CALENDARIO_LOCAL', elegibilidade = 'OFERTA_PERSISTIDA', validade_oferta = '7 days',
            abertura_data = $2::date, autorizacao = 'Teste sintético sem autorização real', ativada_por = $3 WHERE id = $1`, [campanhaId, ontem, usuario]), /data de abertura no passado/);
    } finally { await q('ROLLBACK'); }
    // Corrida LEGADO × ativação: com a ativação em andamento (trava da alocação), a reserva LEGADO espera e depois é recusada.
    const corrida = await empresaEmTeste();
    const pidOutro = (await outro.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    await q('BEGIN');
    // Ativação real: horário exato, janela terminando em JANELA_SEGUNDOS (720 h depois de um início no passado).
    await q(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'HORARIO_EXATO', elegibilidade = 'OFERTA_PERSISTIDA', validade_oferta = '7 days',
        inicio = clock_timestamp() - interval '720 hours' + make_interval(secs => $3), autorizacao = 'Teste sintético sem autorização real', ativada_por = $2
        WHERE id = $1`, [campanhaId, usuario, JANELA_SEGUNDOS]);
    const legadoTardio = outro.query("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga, origem) SELECT empresa_id, documento_teste, 20, 'LEGADO' FROM empresa_assinaturas WHERE empresa_id = $1", [corrida])
        .then(() => 'GRAVOU', (x: Error) => x.message);
    let esperando = false;
    try {
        for (let i = 0; i < 100 && !esperando; i++) {
            esperando = (await terceiro.query("SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS w FROM pg_stat_activity WHERE pid = $1", [pidOutro])).rows[0]?.w === true;
            if (!esperando) await new Promise(r => setTimeout(r, 20));
        }
    } finally { await q('COMMIT'); }
    assert.ok(esperando, 'a reserva LEGADO espera a trava da alocação (advisory) tomada pela ativação');
    assert.match(await legadoTardio, /concessão legada encerrada/);
    const c = (await q('SELECT janela_fim - inicio AS d, abertura_data IS NOT NULL AS a, ativada_em IS NOT NULL AS t FROM assinatura_campanhas WHERE id = $1', [campanhaId])).rows[0];
    assert.deepEqual([c.d.hours ?? c.d.days * 24, c.a, c.t], [720, true, true]);
    for (const sql of ["UPDATE assinatura_campanhas SET janela_fim = janela_fim + interval '1 day' WHERE id = $1",
        "UPDATE assinatura_campanhas SET validade_oferta = '30 days' WHERE id = $1", "UPDATE assinatura_campanhas SET estado = 'RASCUNHO' WHERE id = $1",
        'DELETE FROM assinatura_campanhas WHERE id = $1'])
        await assert.rejects(q(sql, [campanhaId]), /090: /);
    await assert.rejects(q('TRUNCATE assinatura_campanhas CASCADE'), /090: /);
    const outra = (await q("INSERT INTO assinatura_campanhas (codigo, versao_regra) VALUES ('fundador-outra', 'v2-sintetica') RETURNING id")).rows[0].id;
    await assert.rejects(q(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'HORARIO_EXATO', elegibilidade = 'OFERTA_PERSISTIDA', validade_oferta = '7 days',
        inicio = clock_timestamp(), autorizacao = 'Teste sintético sem autorização', ativada_por = $2 WHERE id = $1`, [outra, usuario]), /duplicate key|já existe campanha/);
    await q('DELETE FROM assinatura_campanhas WHERE id = $1', [outra]);
    // Regra antiga encerrada; rollback recusado.
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga, origem) SELECT empresa_id, documento_teste, 20, 'LEGADO' FROM empresa_assinaturas WHERE empresa_id = $1", [legado[2]]),
        /concessão legada encerrada/);
    await assert.rejects(q(DOWN), /rollback recusado/); await q('ROLLBACK').catch(() => undefined);
});

const janela: string[] = [];
test('4. janela: 22 adesões sem vaga numerada, chave operacional, inserções diretas recusadas, mesma empresa em duas conexões', { skip: !opt() }, async () => {
    const d = await empresaEmTeste();
    await assert.rejects(ofertaEm(client, d, COM_DESCONTO, ENV_DESLIGADA), (x) => codigo(x) === 'CAMPANHA_DESLIGADA');
    const desligada = await emTx(() => consultarOfertas(client as never, d, ENV_DESLIGADA));
    assert.deepEqual([desligada?.habilitado, desligada?.bloqueio?.codigo], [false, 'CAMPANHA_DESLIGADA']);
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_contratacoes WHERE empresa_id = $1', [d])).rows[0].n, 0);
    janela.push(d);
    for (let i = 0; i < 21; i++) janela.push(await empresaEmTeste());
    for (const e of janela) {
        const o = await ofertaEm(client, e);
        const f = await concessao(e);
        assert.deepEqual([o.valor_final_centavos, f.origem, f.vaga, f.campanha_id, f.regra_versao], [11820, 'JANELA', null, campanhaId, 'fundador-2026-sintetica-v1']);
        assert.ok(new Date(f.oferta_valida_ate).getTime() - new Date(f.reservada_em).getTime() === 7 * 86_400_000);
    }
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'JANELA'")).rows[0].n, 22, 'mais de 20 na janela');
    const r = await emTx(() => resumoCampanha(client as never, ENV));
    assert.equal(r.fase, 'JANELA');
    // Retomada não cria outra concessão.
    assert.equal((await ofertaEm(client, janela[0])).fundador_id, (await concessao(janela[0])).id);
    // Inserções diretas: vaga na janela, lote posterior antes do corte, campanha em rascunho.
    const e = await empresaEmTeste();
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga, origem, campanha_id) SELECT empresa_id, documento_teste, 3, 'JANELA', $2 FROM empresa_assinaturas WHERE empresa_id = $1", [e, campanhaId]),
        /assinatura_fundadores_vaga_check/);
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga, origem, campanha_id) SELECT empresa_id, documento_teste, 1, 'POS_JANELA', $2 FROM empresa_assinaturas WHERE empresa_id = $1", [e, campanhaId]),
        /lote posterior só depois da janela/);
    const rascunho = (await q("INSERT INTO assinatura_campanhas (codigo, versao_regra) VALUES ('rascunho-x', 'v9-sintetica') RETURNING id")).rows[0].id;
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, origem, campanha_id) SELECT empresa_id, documento_teste, 'JANELA', $2 FROM empresa_assinaturas WHERE empresa_id = $1", [e, rascunho]),
        /campanha não está ativa/);
    await q('DELETE FROM assinatura_campanhas WHERE id = $1', [rascunho]);
    // Mesma empresa em duas conexões ao mesmo tempo: uma oferta, uma concessão. A terceira conexão segura a linha da
    // empresa até as duas estarem esperando no servidor (corrida observada, não sequencial por acaso).
    const pids = [(await q('SELECT pg_backend_pid() AS p')).rows[0].p, (await outro.query('SELECT pg_backend_pid() AS p')).rows[0].p];
    await terceiro.query('BEGIN'); await terceiro.query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [e]);
    const duas = Promise.all([ofertaEm(client, e), ofertaEm(outro, e)]);
    try { await esperarNoServidor(pids, ['transactionid', 'tuple']); } finally { await terceiro.query('COMMIT'); }
    const [a, b] = await duas;
    assert.equal(a.id, b.id);
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_fundadores WHERE empresa_id = $1', [e])).rows[0].n, 1);
    janela.push(e);
});

const pos: string[] = [];
test('5. fronteira: pedido que espera a trava atravessa o corte e vira lote posterior; inserção direta da janela recusada depois', { skip: !opt() }, async () => {
    const fim = Date.parse((await q("SELECT to_char(janela_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS f FROM assinatura_campanhas WHERE id = $1", [campanhaId])).rows[0].f);
    const agora = Date.parse((await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS a")).rows[0].a);
    assert.ok(fim > agora + 1500, `janela ainda aberta (restam ${fim - agora} ms)`);
    const e = await empresaEmTeste();
    await q("SET statement_timeout = '120s'");
    // Outra conexão segura a trava da campanha antes do corte e só solta depois dele.
    await outro.query('BEGIN');
    await outro.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'))");
    const pid = (await q('SELECT pg_backend_pid() AS p')).rows[0].p;
    const pedido = ofertaEm(client, e);
    let esperou = false;
    for (let i = 0; i < 100 && !esperou; i++) {
        esperou = (await outro.query("SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.w === true;
        if (!esperou) await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(esperou, 'o pedido espera a trava no servidor');
    await new Promise(r => setTimeout(r, Math.max(0, fim - Date.now()) + 1500));
    await outro.query('COMMIT');
    const o = await pedido;
    const f = await concessao(e);
    assert.deepEqual([o.valor_final_centavos, f.origem, f.vaga], [11820, 'POS_JANELA', 1], 'decidido pelo relógio depois da trava');
    pos.push(e);
    const x = await empresaEmTeste();
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, origem, campanha_id) SELECT empresa_id, documento_teste, 'JANELA', $2 FROM empresa_assinaturas WHERE empresa_id = $1", [x, campanhaId]),
        /janela da campanha encerrada/);
    pos.push(x);
});

test('6. lote posterior: 20 vagas, disputa real da última, em confirmação e depois preço cheio', { skip: !opt() }, async () => {
    await ofertaEm(client, pos[1]);
    while (pos.length < 19) { const e = await empresaEmTeste(); await ofertaEm(client, e); pos.push(e); }
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'POS_JANELA'")).rows[0].n, 19);
    const r19 = await emTx(() => resumoCampanha(client as never, ENV));
    assert.deepEqual(r19, { fase: 'POS_JANELA', vagasRestantes: 1, emConfirmacao: 19, limite: 20 });
    const a = await empresaEmTeste(), b = await empresaEmTeste();
    const pids = [(await q('SELECT pg_backend_pid() AS p')).rows[0].p, (await outro.query('SELECT pg_backend_pid() AS p')).rows[0].p];
    await terceiro.query('BEGIN'); await terceiro.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'))");
    const disputa = Promise.allSettled([ofertaEm(client, a), ofertaEm(outro, b)]);
    try { await esperarNoServidor(pids, ['advisory']); } finally { await terceiro.query('COMMIT'); }
    const resultados = await disputa;
    const ok = resultados.filter(x => x.status === 'fulfilled'), falha = resultados.filter(x => x.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1); assert.equal(codigo(falha[0].reason), 'FUNDADOR_AGUARDANDO');
    const vagas = (await q("SELECT vaga FROM assinatura_fundadores WHERE origem = 'POS_JANELA' AND campanha_id = $1 ORDER BY vaga", [campanhaId])).rows.map(r => r.vaga);
    assert.deepEqual(vagas, Array.from({ length: 20 }, (_, i) => i + 1));
    const perdedor = resultados[0].status === 'rejected' ? a : b;
    pos.push(perdedor === a ? b : a);
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_contratacoes WHERE empresa_id = $1', [perdedor])).rows[0].n, 0, 'perdedor sem oferta nem cobrança');
    // Inserção direta da 21ª: recusada pela guarda.
    await assert.rejects(q("INSERT INTO assinatura_fundadores (empresa_id, documento_beneficiario, vaga, origem, campanha_id) SELECT empresa_id, documento_teste, 20, 'POS_JANELA', $2 FROM empresa_assinaturas WHERE empresa_id = $1", [perdedor, campanhaId]),
        /esgotadas/);
    for (const e of pos) await confirmarDireto(e);
    assert.deepEqual(await emTx(() => resumoCampanha(client as never, ENV)), { fase: 'POS_JANELA', vagasRestantes: 0, emConfirmacao: 0, limite: 20 });
    await assert.rejects(ofertaEm(client, perdedor), (x) => codigo(x) === 'OFERTA_ALTERADA');
    const cheia = await ofertaEm(client, perdedor, CHEIO);
    assert.deepEqual([cheia.valor_final_centavos, cheia.fundador_id], [19700, null]);
    // Confirmadas continuam ocupando: nenhuma vaga volta.
    await assert.rejects(q("UPDATE assinatura_fundadores SET estado = 'LIBERADA', liberada_em = clock_timestamp(), evidencia_liberacao = 'tentativa' WHERE empresa_id = $1", [pos[0]]),
        /Transição ou identidade/);
});

test('7. pagamento tardio da janela: confirma como JANELA, não consome o lote; repetido sem efeito; renovação 075 e devolução L1', { skip: !opt() }, async () => {
    const w = janela[1];
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d;
    const sub: AssinaturaProvedor = { id: 'sub_tardia', customer: 'cus_tardia', externalReference: w, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820 };
    const pay: CobrancaProvedor = { id: 'pay_tardia', status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: 'sub_tardia', clienteId: 'cus_tardia', billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(id: string) { return id === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(id: string) { return id === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === w ? [{ ...sub }] : []; },
        async removerAssinatura() { sub.deleted = true; return { removida: true }; },
        async estornarCobranca() { throw new Error('estorno não esperado'); },
    };
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [w, sub.customer, sub.id]);
    const posAntes = (await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'POS_JANELA' AND estado <> 'LIBERADA'")).rows[0].n;
    const r = await emTx(() => sincronizarEmpresa(client as never, w, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    const f = await concessao(w);
    assert.deepEqual([f.origem, f.estado, f.pagamento_confirmacao_id], ['JANELA', 'CONFIRMADA', 'pay_tardia']);
    assert.equal(new Date(f.beneficio_fim).getTime() > new Date(f.confirmada_em).getTime(), true);
    const snap = (await q('SELECT to_jsonb(f) AS j FROM assinatura_fundadores f WHERE empresa_id = $1', [w])).rows[0].j;
    await emTx(() => sincronizarEmpresa(client as never, w, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.deepEqual((await q('SELECT to_jsonb(f) AS j FROM assinatura_fundadores f WHERE empresa_id = $1', [w])).rows[0].j, snap, 'evento repetido não muda a concessão');
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'POS_JANELA' AND estado <> 'LIBERADA'")).rows[0].n, posAntes, 'lote posterior intacto');
    // Renovação 075: a guarda aceita o contrato Fundador da janela, com o preço regular contratado.
    const repo = repositorioRenovacao((t) => emTx(() => t(client as never)));
    const ctx = await repo.ler(w);
    assert.ok(ctx && ctx.valorFinal === 11820 && ctx.valorRegular === 19700);
    const id = randomUUID();
    const reg = await repo.criar({ id, empresaId: w, contratacaoId: ctx!.contratacaoId, destinatarioId: usuario, primeiroVencimento: hoje,
        primeiraDataRegular: '2099-01-01', mensagem: { para: 'gestao@example.test', assunto: 'Aviso', texto: 't', html: '<p>t</p>', idempotencia: `kidmais-renovacao/${id}` } } as never);
    assert.equal(reg.estado, 'PENDENTE');
    // Devolução L1 (089): arrependimento devolve o valor efetivamente pago, sem cobrar o desconto de volta.
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [w, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [w, usuario]);
    const tenant = () => ({ empresaComprovada: w, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' });
    const deps: DepsDevolucao = { withTenantTransaction: (_s, _e, t) => emTx(() => t(client as never, tenant() as never)), withTransaction: (t) => emTx(() => t(client as never)),
        provedor: () => provedor as never, env: ENV, enviarEmail: async () => ({ provedor: 'arquivo' as const, idExterno: null }) };
    const tempo = (await q(`SELECT to_char((clock_timestamp() - interval '10 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c`)).rows[0];
    const sessao = { id: 's', usuario_id: usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: tempo.a, consultado_em: tempo.c, expira_em: '', csrf_hash: '' };
    const c = await consultarEncerramento(sessao as never, null, deps);
    assert.equal(c.opcoes?.arrependimento.disponivel && c.opcoes.arrependimento.valorCentavos, 11820);
    const p = await solicitarEncerramento(sessao as never, null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: 11820 }, { requestId: randomUUID() }, deps);
    assert.equal(p.valorDevolucaoCentavos, 11820);
    // A concessão é histórico: continua CONFIRMADA (não volta, não gera cobrança complementar).
    assert.equal((await concessao(w)).estado, 'CONFIRMADA');
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_contratacoes WHERE empresa_id = $1", [w])).rows[0].n, 1);
});

test('8. D3: pago depois do corte e dentro de 7 dias mantém JANELA; boleto vale o dia pago; sem data ou depois da validade vai para reconciliação (código visível, alarme); critério único por dia; retomar vencida é recusado', { skip: !opt() }, async () => {
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const provedorDe = (empresa: string, sufixo: string, pagoEm: string | null, datas: Partial<CobrancaProvedor> = {}) => {
        const sub: AssinaturaProvedor = { id: `sub_${sufixo}`, customer: `cus_${sufixo}`, externalReference: empresa, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820 };
        const pay = { id: `pay_${sufixo}`, status: 'RECEIVED', dueDate: hoje, paymentDate: pagoEm, deleted: false, invoiceUrl: null, valorCentavos: 11820,
            assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX', ...datas } as CobrancaProvedor;
        return { sub, provedor: {
            async obterAssinatura(id: string) { return id === sub.id ? { ...sub } : null; },
            async listarCobrancasDaAssinatura(id: string) { return id === sub.id ? [{ ...pay }] : []; },
            async listarAssinaturasPorReferencia(ref: string) { return ref === empresa ? [{ ...sub }] : []; },
        } };
    };
    const sincronizar = async (empresa: string, sufixo: string, pagoEm: string | null, datas: Partial<CobrancaProvedor> = {}) => {
        const { sub, provedor } = provedorDe(empresa, sufixo, pagoEm, datas);
        await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1 AND provedor_assinatura_id IS NULL", [empresa, sub.customer, sub.id]);
        return emTx(() => sincronizarEmpresa(client as never, empresa, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    };
    const posAntes = (await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'POS_JANELA' AND estado <> 'LIBERADA'")).rows[0].n;
    // Dentro da validade (6 dias depois de hoje; a janela já fechou): confirma JANELA.
    const dentro = janela[3];
    const diaFinal = async (empresa: string) => (await q("SELECT to_char(oferta_valida_ate AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d FROM assinatura_fundadores WHERE empresa_id = $1", [empresa])).rows[0].d as string;
    const depoisDe = (data: string, n: number) => { const x = new Date(`${data}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const r1 = await sincronizar(dentro, 'd3a', depoisDe(await diaFinal(dentro), -1));
    assert.equal(r1.resultado === 'SINCRONIZADA' && r1.depois, 'ATIVA');
    assert.deepEqual([(await concessao(dentro)).origem, (await concessao(dentro)).estado], ['JANELA', 'CONFIRMADA']);
    // Depois da validade (8 dias): FUNDADOR_OFERTA_EXPIRADA; nada muda (sem confirmar, liberar ou cobrar de novo).
    const fora = janela[4];
    const antes = (await q('SELECT to_jsonb(f) AS f, (SELECT to_jsonb(c) FROM assinatura_contratacoes c WHERE c.empresa_id = f.empresa_id) AS c FROM assinatura_fundadores f WHERE empresa_id = $1', [fora])).rows[0];
    const diaFinalFora = await diaFinal(fora);
    await assert.rejects(sincronizar(fora, 'd3b', depoisDe(diaFinalFora, 1)), (x) => codigo(x) === 'FUNDADOR_OFERTA_EXPIRADA');
    const depois = (await q('SELECT to_jsonb(f) AS f, (SELECT to_jsonb(c) FROM assinatura_contratacoes c WHERE c.empresa_id = f.empresa_id) AS c FROM assinatura_fundadores f WHERE empresa_id = $1', [fora])).rows[0];
    assert.deepEqual(depois, antes, 'reserva e contrato intactos: reconciliação manual');
    assert.equal((await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [fora])).rows[0].situacao, 'TESTE');
    // Reconciliação diária real (simulação): o código da recusa fica visível e a conferência de produção alarma.
    const reconciliar = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as {
        executarCiclo: (o: Record<string, unknown>) => Promise<{ empresas: Record<string, number>; incompleto: boolean }>; codigoDeSaida: (r: unknown, p: boolean) => number };
    const sinc = await import('./sincronizacao.ts');
    // Ciclo só desta empresa (sem eventos): o resultado é dela, não de outra empresa da suíte.
    const soFora = { ...sinc, empresasComProvedor: async () => [fora], eventosPendentes: async () => [] };
    const rel = await reconciliar.executarCiclo({ client, provedor: provedorDe(fora, 'd3b', depoisDe(diaFinalFora, 1)).provedor, aplicar: false, banco: 'kidmais_pacotes_v1_descartavel', sinc: soFora });
    assert.deepEqual(rel.empresas, { ERRO_FUNDADOR_OFERTA_EXPIRADA: 1 });
    assert.deepEqual([rel.incompleto, reconciliar.codigoDeSaida(rel, true)], [true, 2]);
    assert.deepEqual((await q('SELECT to_jsonb(f) AS f, (SELECT to_jsonb(c) FROM assinatura_contratacoes c WHERE c.empresa_id = f.empresa_id) AS c FROM assinatura_fundadores f WHERE empresa_id = $1', [fora])).rows[0], antes);
    // Boleto pago no ÚLTIMO dia da validade e compensado depois: vale o dia em que o cliente pagou (clientPaymentDate).
    const boleto = janela[7];
    const ultimoDia = (await q(`SELECT to_char(oferta_valida_ate AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d FROM assinatura_fundadores WHERE empresa_id = $1`, [boleto])).rows[0].d as string;
    const aposUltimo = (n: number) => { const x = new Date(`${ultimoDia}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const rb = await sincronizar(boleto, 'd3c', aposUltimo(3), { clientPaymentDate: ultimoDia, confirmedDate: aposUltimo(3), billingType: 'BOLETO' });
    assert.equal(rb.resultado === 'SINCRONIZADA' && rb.depois, 'ATIVA');
    assert.deepEqual([(await concessao(boleto)).origem, (await concessao(boleto)).estado], ['JANELA', 'CONFIRMADA']);
    // Sem nenhuma data de pagamento no provedor: reconciliação (nunca o relógio).
    await assert.rejects(sincronizar(janela[8], 'd3d', null), (x) => codigo(x) === 'FUNDADOR_OFERTA_EXPIRADA');
    assert.equal((await concessao(janela[8])).estado, 'RESERVADA');
    // Passagem de 7 dias SIMULADA no fixture (gatilhos suspensos só nesta sessão do banco descartável).
    const vencida = janela[5];
    await q("SET session_replication_role = replica");
    try {
        await q(`UPDATE assinatura_fundadores SET reservada_em = clock_timestamp() - interval '8 days', oferta_valida_ate = clock_timestamp() - interval '1 day'
            WHERE empresa_id = $1`, [vencida]);
    } finally { await q("SET session_replication_role = origin"); }
    const consulta = await emTx(() => consultarOfertas(client as never, vencida, ENV));
    assert.equal(consulta?.pendente?.fundadorValidoAte?.vencida, true);
    await assert.rejects(ofertaEm(client, vencida), (x) => codigo(x) === 'FUNDADOR_OFERTA_EXPIRADA');
    assert.equal((await concessao(vencida)).estado, 'RESERVADA', 'sem liberação automática');
    // Critério único por DIA local: fim da validade hoje, horas atrás, ainda vale hoje (tela e retomada). Perto da
    // meia-noite local, espera virar o dia para o bloco não atravessá-la.
    const faltam = Number((await q("SELECT extract(epoch FROM (date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') - clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AS s")).rows[0].s);
    if (faltam < 120) await new Promise(r => setTimeout(r, (faltam + 2) * 1000));
    const ultimo = janela[9];
    await q("SET session_replication_role = replica");
    try {
        await q(`UPDATE assinatura_fundadores SET
            oferta_valida_ate = (date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') + interval '1 second',
            reservada_em = (date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') + interval '1 second' - interval '7 days'
            WHERE empresa_id = $1`, [ultimo]);
    } finally { await q("SET session_replication_role = origin"); }
    assert.equal((await emTx(() => consultarOfertas(client as never, ultimo, ENV)))?.pendente?.fundadorValidoAte?.vencida, false);
    assert.equal((await ofertaEm(client, ultimo)).fundador_id, (await concessao(ultimo)).id, 'retomada aceita no último dia');
    // Validade informada a quem ainda está no prazo.
    const noPrazo = await emTx(() => consultarOfertas(client as never, janela[6], ENV));
    assert.equal(noPrazo?.pendente?.fundadorValidoAte?.vencida, false);
    assert.match(String(noPrazo?.pendente?.fundadorValidoAte?.dia), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem = 'POS_JANELA' AND estado <> 'LIBERADA'")).rows[0].n, posAntes, 'lote posterior intacto');
});

test('9. D4: pendente legada paga depois da ativação (mesmo 30 dias depois) mantém a condição LEGADO contratada, sem prazo da campanha e sem vaga nova', { skip: !opt() }, async () => {
    const e = legado[4];
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const d = new Date(`${hoje}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 30);
    const pagoEm = d.toISOString().slice(0, 10);
    const sub: AssinaturaProvedor = { id: 'sub_legado', customer: 'cus_legado', externalReference: e, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820 };
    const pay = { id: 'pay_legado', status: 'RECEIVED', dueDate: hoje, paymentDate: pagoEm, deleted: false, invoiceUrl: null, valorCentavos: 11820, assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(id: string) { return id === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(id: string) { return id === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === e ? [{ ...sub }] : []; },
    };
    const antes = (await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem <> 'LEGADO'")).rows[0].n;
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [e, sub.customer, sub.id]);
    const r = await emTx(() => sincronizarEmpresa(client as never, e, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    const f = await concessao(e);
    assert.deepEqual([f.origem, f.estado, f.campanha_id, f.oferta_valida_ate], ['LEGADO', 'CONFIRMADA', null, null]);
    assert.equal((await q("SELECT valor_final_centavos FROM assinatura_contratacoes WHERE empresa_id = $1 AND estado = 'CONFIRMADA'", [e])).rows[0].valor_final_centavos, 11820);
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE origem <> 'LEGADO'")).rows[0].n, antes, 'nenhuma concessão nova');
});

test('10. concessão própria sem oferta aberta: chave desligada bloqueia, ligada reaproveita a concessão, vencida recusa; oferta aberta continua retomável com a chave desligada (tela = servidor)', { skip: !opt() }, async () => {
    const cancelar = (e: string) => q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética cancelada' WHERE empresa_id = $1 AND estado = 'EM_ABERTO'", [e]);
    const propria = janela[10];
    await cancelar(propria);
    const concessaoAntes = await concessao(propria);
    assert.equal(concessaoAntes.estado, 'RESERVADA');
    await assert.rejects(ofertaEm(client, propria, COM_DESCONTO, ENV_DESLIGADA), (x) => codigo(x) === 'CAMPANHA_DESLIGADA');
    const fechada = await emTx(() => consultarOfertas(client as never, propria, ENV_DESLIGADA));
    assert.deepEqual([fechada?.habilitado, fechada?.bloqueio?.codigo], [false, 'CAMPANHA_DESLIGADA']);
    const nova = await ofertaEm(client, propria);
    assert.deepEqual([nova.fundador_id, nova.valor_final_centavos], [concessaoAntes.id, 11820], 'reaproveita a concessão: sem vaga nova nem 12 meses novos');
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_fundadores WHERE empresa_id = $1', [propria])).rows[0].n, 1);
    // Vencida e sem oferta aberta: não gera oferta nova com desconto.
    const vencida = janela[11];
    await cancelar(vencida);
    await q("SET session_replication_role = replica");
    try {
        await q(`UPDATE assinatura_fundadores SET reservada_em = clock_timestamp() - interval '9 days', oferta_valida_ate = clock_timestamp() - interval '2 days' WHERE empresa_id = $1`, [vencida]);
    } finally { await q("SET session_replication_role = origin"); }
    await assert.rejects(ofertaEm(client, vencida), (x) => codigo(x) === 'FUNDADOR_OFERTA_EXPIRADA');
    // Oferta aberta e chave desligada: a tela mostra a retomada, e o servidor devolve a mesma oferta.
    const aberta = janela[12];
    const consulta = await emTx(() => consultarOfertas(client as never, aberta, ENV_DESLIGADA));
    assert.deepEqual([consulta?.habilitado, consulta?.bloqueio, Boolean(consulta?.pendente)], [true, null, true]);
    const original = (await q("SELECT id FROM assinatura_contratacoes WHERE empresa_id = $1 AND estado = 'EM_ABERTO'", [aberta])).rows[0].id;
    assert.equal((await ofertaEm(client, aberta, COM_DESCONTO, ENV_DESLIGADA)).id, original);
});
