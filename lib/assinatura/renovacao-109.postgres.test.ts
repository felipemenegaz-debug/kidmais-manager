import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { consultarRenovacao, repositorioRenovacao, substituirRenovacao } from './renovacao-repositorio.ts';
import { capacidadeRenovacao } from './renovacao-schema.ts';
import type { RegistroRenovacao } from './renovacao-fundador.ts';
import { emTx, empresaFundador, hojeBanco, inserir, mensagem, somar, usuarioSintetico } from './renovacao-109-apoio.postgres.test-apoio.ts';

const usuarioGestao = async (c: Client) => (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão 109', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
    usuarioSintetico())).rows[0].id as string;

/**
 * B-9 production — migration 109 (renovação substituta) no PostgreSQL DESCARTÁVEL, modelo 109 (plano rev. 5 §2.5, §4).
 * Integridade da guarda nova (com as regras da 075), repositório (criar idempotente com histórico, filtro do vigente,
 * substituir na fronteira) e rollback (sem histórico volta ao retrato da 075; com cadeia recusa).
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
let client: Client;
let usuario = '';
let hoje = '';
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), 'utf8');
const semTransacao = (sql: string) => sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const tx = <T>(f: (t: Client) => Promise<T>) => emTx(client, () => f(client));
const repo = () => repositorioRenovacao((f) => emTx(client, () => f(client as never)), { capacidade: '109' });
const linhas = async (contratacao: string) => (await client.query(`SELECT id, estado, substitui_id, primeira_data_regular::text AS pdr
    FROM assinatura_renovacoes WHERE contratacao_id = $1 ORDER BY criado_em`, [contratacao])).rows;
async function recusa(sql: string, params: unknown[], padrao: RegExp) {
    await client.query('BEGIN');
    try { await assert.rejects(client.query(sql, params), padrao); } finally { await client.query('ROLLBACK'); }
}
async function substituirDireto(id: string) { await client.query("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA' WHERE id = $1", [id]); }

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    usuario = await usuarioGestao(client);
    hoje = await hojeBanco(client);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('capacidade do modelo 109 é 109; rollback SEM histórico volta exatamente ao retrato da 075 (e a 109 reaplica)', { skip: !opt() }, async () => {
    assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '109' });
    const e = await empresaFundador(client, usuario);
    await inserir(client, e, { pdr: somar(hoje, 200), pv: somar(hoje, -100) }); // raiz sem substituição: não é histórico
    await client.query('BEGIN');
    try {
        await client.query(semTransacao(ler('database/rollback/20261029_109_renovacao_substituta_down.sql')));
        assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '075' });
        await client.query(semTransacao(ler('database/migrations/20261029_109_renovacao_substituta.sql')));
        assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '109' });
    } finally { await client.query('ROLLBACK'); }
});

test('guarda 109: substituição só PENDENTE sem tentativa e com janela vencida; sem evidência nova; sucessor obrigatório no COMMIT', { skip: !opt() }, async () => {
    const e = await empresaFundador(client, usuario);
    const valida = await inserir(client, e, { pdr: somar(hoje, 31), pv: somar(hoje, -300) });
    await recusa("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA' WHERE id = $1", [valida], /janela de aviso vencida/);
    // A mesma contratação não aceita outra raiz (cadeia obrigatória).
    await recusa(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
        VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,$3,$4,$5,30,$6)`,
        [e.empresaId, e.contratacaoId, usuario, somar(hoje, -300), somar(hoje, 90), JSON.stringify(mensagem('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))], /raiz paralela recusada/);

    const e2 = await empresaFundador(client, usuario);
    const raiz = await inserir(client, e2, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    await recusa("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA', aviso_tentado_em = clock_timestamp() WHERE id = $1", [raiz],
        /substituida_sem_evidencia|sem tentativa de aviso|não acrescenta evidência/);
    // UPDATE solto, sem sucessor: recusado no COMMIT pelo gatilho diferido.
    await client.query('BEGIN');
    await substituirDireto(raiz);
    await assert.rejects(client.query('COMMIT'), /exige sucessor na mesma transação/);
    assert.equal((await linhas(e2.contratacaoId))[0].estado, 'PENDENTE', 'ROLLBACK total');

    // PENDENTE com tentativa preenchida (representável pela 075: mesmo estado): recusa ESPECÍFICA da tentativa.
    const e3 = await empresaFundador(client, usuario);
    const tentada = await inserir(client, e3, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    await client.query("UPDATE assinatura_renovacoes SET aviso_tentado_em = clock_timestamp() WHERE id = $1", [tentada]);
    await recusa("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA' WHERE id = $1", [tentada], /Substituição exige renovação sem tentativa de aviso\./);
    // AVISANDO: exclusão por estado.
    await client.query("UPDATE assinatura_renovacoes SET estado = 'AVISANDO' WHERE id = $1", [tentada]);
    await recusa("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA' WHERE id = $1", [tentada], /Substituição exige renovação pendente\./);
});

test('sucessor: data ≥ hoje+30 (inclusivo), mesma âncora, data posterior, mesma contratação; vínculo imutável; terminal; cadeia de 2', { skip: !opt() }, async () => {
    const e = await empresaFundador(client, usuario);
    const raiz = await inserir(client, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    const tentar = async (o: { pdr: string; pv?: string; contratacao?: string; empresa?: string }, padrao: RegExp) => {
        await client.query('BEGIN');
        try {
            await substituirDireto(raiz);
            await assert.rejects(inserir(client, { ...e, ...(o.contratacao ? { contratacaoId: o.contratacao } : {}), ...(o.empresa ? { empresaId: o.empresa } : {}) },
                { pdr: o.pdr, pv: o.pv ?? somar(hoje, -355), substitui: raiz }), padrao);
        } finally { await client.query('ROLLBACK'); }
    };
    await tentar({ pdr: somar(hoje, 29) }, /pelo menos 30 dias/);
    await tentar({ pdr: somar(hoje, 40), pv: somar(hoje, -354) }, /mesma âncora/);
    const outra = await empresaFundador(client, usuario);
    await tentar({ pdr: somar(hoje, 40), contratacao: outra.contratacaoId, empresa: outra.empresaId }, /cadeia_fk|predecessor substituído|violates foreign key/);
    // +30 exato: aceito.
    let suc1 = '';
    await tx(async () => { await substituirDireto(raiz); suc1 = await inserir(client, e, { pdr: somar(hoje, 30), pv: somar(hoje, -355), substitui: raiz }); });
    // Vínculo imutável em todas as direções; SUBSTITUIDA terminal; os CHECKs da 075 valem no sucessor.
    await recusa('UPDATE assinatura_renovacoes SET substitui_id = NULL WHERE id = $1', [suc1], /imutáveis/);
    await recusa('UPDATE assinatura_renovacoes SET substitui_id = $2 WHERE id = $1', [suc1, suc1], /imutáveis|cadeia/);
    await recusa("UPDATE assinatura_renovacoes SET estado = 'PENDENTE' WHERE id = $1", [raiz], /terminal/);
    await recusa("UPDATE assinatura_renovacoes SET estado = 'AVISADA' WHERE id = $1", [suc1], /Transição|check constraint/);
    await recusa('DELETE FROM assinatura_renovacoes WHERE id = $1', [raiz], /não é apagado/);
    // Dois sucessores do mesmo predecessor e dois vigentes: recusados.
    await recusa(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem,substitui_id)
        VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,$2,$3,$4,$5,30,$6,$7)`,
        [e.empresaId, e.contratacaoId, usuario, somar(hoje, -355), somar(hoje, 60), JSON.stringify(mensagem('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), raiz], /substitui_uq|predecessor substituído|duplicate key/);
    // O sucessor (pdr = hoje+30) já está com a janela vencida? Não: limite = hoje. Avança a cadeia com um sucessor de janela vencida.
    const e4 = await empresaFundador(client, usuario);
    const r4 = await inserir(client, e4, { pdr: somar(hoje, 5), pv: somar(hoje, -360) });
    let s4 = '';
    await tx(async () => { await substituirDireto(r4); s4 = await inserir(client, e4, { pdr: somar(hoje, 20), pv: somar(hoje, -360), substitui: r4 }).catch((x) => { throw x; }); }).catch(() => undefined);
    assert.equal(s4, '', 'sucessor com data < hoje+30 nunca nasce');
    await tx(async () => { await substituirDireto(r4); s4 = await inserir(client, e4, { pdr: somar(hoje, 35), pv: somar(hoje, -360), substitui: r4 }); });
    assert.deepEqual((await linhas(e4.contratacaoId)).map((l) => l.estado), ['SUBSTITUIDA', 'PENDENTE']);
});

test('repositório 109: criar idempotente antes e depois de 1 substituição; segunda substituição recusada com a janela do sucessor válida; ler/consultar só o vigente; substituir na fronteira', { skip: !opt() }, async () => {
    const e = await empresaFundador(client, usuario);
    const r = repo();
    const base: RegistroRenovacao = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', empresaId: e.empresaId, contratacaoId: e.contratacaoId, destinatarioId: usuario,
        primeiroVencimento: somar(hoje, -355), primeiraDataRegular: somar(hoje, 10), mensagem: mensagem('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), estado: 'PENDENTE',
        avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null };
    const a = await r.criar(base);
    assert.equal((await r.criar({ ...base, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })).id, a.id, 'segunda criação devolve o mesmo vigente');
    const s1 = await r.substituir!(e.empresaId, a, { ...base, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', primeiraDataRegular: somar(hoje, 30),
        mensagem: mensagem('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') });
    assert.deepEqual([s1.estado, s1.substituto], ['PENDENTE', true]);
    assert.equal((await r.criar(base)).id, s1.id, 'depois de uma substituição: o vigente é o sucessor, sem linha nova');
    assert.equal((await linhas(e.contratacaoId)).length, 2);
    // Segunda substituição exige a janela do sucessor vencida: com pdr = hoje+30 o limite é hoje → ainda válida.
    await assert.rejects(r.substituir!(e.empresaId, s1, { ...base, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', primeiraDataRegular: somar(hoje, 60),
        mensagem: mensagem('ffffffff-ffff-4fff-8fff-ffffffffffff') }), /janela de aviso vencida/);
    assert.equal((await linhas(e.contratacaoId)).filter((l) => l.estado === 'SUBSTITUIDA').length, 1, 'ROLLBACK: nada mudou');
    const lido = await r.ler(e.empresaId);
    assert.equal(lido?.registro?.id, s1.id);
    const dto = await consultarRenovacao(client as never, e.empresaId);
    assert.equal(dto?.dataRegular, somar(hoje, 30), 'DTO só do vigente');

    // Raiz e um sucessor criados por INSERT direto: criar devolve o sucessor (cadeia de 2). A cadeia de 3 está no teste próprio abaixo.
    const e2 = await empresaFundador(client, usuario);
    const raiz2 = await inserir(client, e2, { pdr: somar(hoje, 5), pv: somar(hoje, -360) });
    let meio = '';
    await tx(async () => { await substituirDireto(raiz2); meio = await inserir(client, e2, { pdr: somar(hoje, 35), pv: somar(hoje, -360), substitui: raiz2 }); });
    assert.ok(meio);
    const r2 = repo();
    const base2 = { ...base, empresaId: e2.empresaId, contratacaoId: e2.contratacaoId, primeiroVencimento: somar(hoje, -360) };
    assert.equal((await r2.criar(base2)).id, meio);

    // Fronteira (R4-F3): controle com tentativa preenchida → UPDATE resolvido, rowCount 0, SEM exceção da guarda.
    const e3 = await empresaFundador(client, usuario);
    const t3 = await inserir(client, e3, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    await client.query('UPDATE assinatura_renovacoes SET aviso_tentado_em = clock_timestamp() WHERE id = $1', [t3]);
    const anterior = { ...base, id: t3, empresaId: e3.empresaId, contratacaoId: e3.contratacaoId };
    await client.query('BEGIN');
    try {
        const erro = await substituirRenovacao(client as never, e3.empresaId, anterior, { ...base, id: '99999999-9999-4999-8999-999999999999',
            primeiraDataRegular: somar(hoje, 40), mensagem: mensagem('99999999-9999-4999-8999-999999999999') }).then(() => null, (x: Error) => x.message);
        assert.equal(erro, 'SUBSTITUICAO_RECUSADA', 'rowCount 0 no repositório, não a mensagem do gatilho');
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual((await linhas(e3.contratacaoId)).map((l) => l.estado), ['PENDENTE'], 'sem INSERT, sem efeito');
});

test('rollback com histórico de substituição é recusado', { skip: !opt() }, async () => {
    await client.query('BEGIN');
    try { await assert.rejects(client.query(semTransacao(ler('database/rollback/20261029_109_renovacao_substituta_down.sql'))), /rollback recusado com histórico/); }
    finally { await client.query('ROLLBACK'); }
    assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '109' });
});

/**
 * F2 (revisão do código): cadeia de TRÊS registros. RELÓGIO SIMULADO DECLARADO: a guarda usa o relógio real do banco, então um
 * sucessor criado hoje nunca tem a janela vencida no mesmo dia. O 1º elo (raiz → S1, com S1 a hoje+10, "como se" criado há
 * 25 dias) é montado com session_replication_role = replica, que desliga os gatilhos SÓ nesta transação de fixture. A 2ª
 * substituição (S1 → S2) é REAL, pela guarda e pelo repositório. A guarda produtiva não é alterada.
 */
test('cadeia de 3: segunda substituição real; criar idempotente, ler, DTO e exportação sobre o último registro', { skip: !opt() }, async () => {
    const e = await empresaFundador(client, usuario);
    const raiz = await inserir(client, e, { pdr: somar(hoje, 5), pv: somar(hoje, -360) });
    let s1 = '';
    await tx(async () => {
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query("UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA' WHERE id = $1", [raiz]);
        s1 = await inserir(client, e, { pdr: somar(hoje, 10), pv: somar(hoje, -360), substitui: raiz });
    });
    const r = repo();
    const base = (id: string, pdr: string): RegistroRenovacao => ({ id, empresaId: e.empresaId, contratacaoId: e.contratacaoId, destinatarioId: usuario,
        primeiroVencimento: somar(hoje, -360), primeiraDataRegular: pdr, mensagem: mensagem(id), estado: 'PENDENTE',
        avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null });
    const vigente1 = await r.ler(e.empresaId);
    assert.equal(vigente1?.registro?.id, s1);
    const s2 = await r.substituir!(e.empresaId, vigente1!.registro!, base('c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', somar(hoje, 35)));
    assert.deepEqual([s2.estado, s2.substituto, s2.primeiraDataRegular], ['PENDENTE', true, somar(hoje, 35)]);
    const cadeia = await linhas(e.contratacaoId);
    assert.deepEqual(cadeia.map((l) => [l.estado, l.substitui_id]), [['SUBSTITUIDA', null], ['SUBSTITUIDA', raiz], ['PENDENTE', s1]]);
    // Idempotência e leitores sobre o último registro.
    assert.equal((await r.criar(base('d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3', somar(hoje, 99)))).id, s2.id);
    assert.equal((await linhas(e.contratacaoId)).length, 3, 'nenhuma linha nova');
    assert.equal((await r.ler(e.empresaId))?.registro?.id, s2.id);
    assert.equal((await consultarRenovacao(client as never, e.empresaId))?.dataRegular, somar(hoje, 35));
    // Exportação: as TRÊS gerações, com o vínculo, no pacote da empresa (leitura REPEATABLE READ READ ONLY).
    const { gerarPacote } = await import('../exportacao/pacote.ts');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
        const p = await gerarPacote(client as never, e.empresaId);
        try {
            const arq = p.manifesto.arquivos.find((a) => a.tabela === 'assinatura_renovacoes')!;
            assert.equal(arq.linhas, 3);
            assert.ok(arq.colunas!.includes('substitui_id'));
            // Vínculos DENTRO do CSV do pacote (revisão r2): raiz sem vínculo, S1 → raiz, S2 → S1.
            const { abrir, lerCsv } = await import('../exportacao/fixture.postgres.test-apoio.ts');
            const { arquivos } = abrir({ zip: readFileSync(p.zipCaminho), manifestoSha256: p.manifestoSha256 });
            const [cab, ...corpo] = lerCsv(arquivos.get(arq.caminho)!.toString('utf8')).filter((l) => l.length > 1);
            const [iId, iSub, iEstado] = ['id', 'substitui_id', 'estado'].map((c) => cab.indexOf(c));
            assert.deepEqual(Object.fromEntries(corpo.map((l) => [l[iId], [l[iSub], l[iEstado]]])),
                { [raiz]: ['', 'SUBSTITUIDA'], [s1]: [raiz, 'SUBSTITUIDA'], [s2.id]: [s1, 'PENDENTE'] });
        } finally { await p.limpar(); }
    } finally { await client.query('COMMIT'); }
});

/**
 * F2: fronteira BRT da regra hoje+30 da 109. Sem injetar relógio na guarda (decisão: a guarda produtiva fica intacta), a
 * prova é em três partes: (1) a guarda usa UMA fonte de data, exatamente (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 * (2) essa expressão vira o dia às 03:00Z (meia-noite de Brasília), com instantes injetados na MESMA expressão; (3) o fuso
 * da sessão não muda a regra (UTC e UTC+14 aceitam hoje_BRT+30 e recusam +29). A travessia real da meia-noite não é executada.
 */
test('fronteira BRT da regra hoje+30: fonte única de data, virada às 03:00Z e independência do fuso da sessão', { skip: !opt() }, async () => {
    const fonte = "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date";
    const corpo = (await client.query("SELECT prosrc FROM pg_proc WHERE oid = 'public.kidmais_109_renovacao_guarda()'::regprocedure")).rows[0].prosrc as string;
    assert.equal(corpo.split(fonte).length - 1, 1, 'uma fonte de data');
    // O único outro relógio é o carimbo atualizado_em (instante, não data de negócio).
    assert.doesNotMatch(corpo.replace(fonte, '').replace('NEW.atualizado_em := clock_timestamp();', ''), /clock_timestamp|now\(\)|current_date|current_timestamp|localtime/i);
    const dia = async (instante: string) => (await client.query("SELECT ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text AS d", [instante])).rows[0].d;
    assert.equal(await dia('2027-01-01T02:59:59.999Z'), '2026-12-31');
    assert.equal(await dia('2027-01-01T03:00:00Z'), '2027-01-01');
    for (const fuso of ['UTC', 'Pacific/Kiritimati']) {
        await client.query(`SET TIME ZONE '${fuso}'`);
        try {
            const e = await empresaFundador(client, usuario);
            const raiz = await inserir(client, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
            await client.query('BEGIN');
            try {
                await substituirDireto(raiz);
                await assert.rejects(inserir(client, e, { pdr: somar(hoje, 29), pv: somar(hoje, -355), substitui: raiz }), /pelo menos 30 dias/, `${fuso}: +29`);
            } finally { await client.query('ROLLBACK'); }
            await tx(async () => { await substituirDireto(raiz); await inserir(client, e, { pdr: somar(hoje, 30), pv: somar(hoje, -355), substitui: raiz }); });
        } finally { await client.query('RESET TIME ZONE'); }
    }
});

test('F2: falha na consulta de alertasInformativos — serialização do RETORNO de executarCron (sem PUT) mantém alertas e campos; o JSON impresso pelo CLI está no teste R2-F1', { skip: !opt() }, async () => {
    const { createRequire } = await import('node:module');
    const pg = (await import('pg')).default;
    const { portaDescartavel, senhaRecusada } = await import('../comercial/postgres-descartavel.ts');
    const { executarCron } = createRequire(import.meta.url)('../../scripts/assinatura-renovacao-cron.cjs');
    const e = await empresaFundador(client, usuario);
    const raiz = await inserir(client, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    await client.query('UPDATE assinatura_renovacoes SET aviso_tentado_em = clock_timestamp() WHERE id = $1', [raiz]);
    class PoolSemInformativos extends pg.Pool {
        query(...a: unknown[]) {
            if (typeof a[0] === 'string' && a[0].includes('status::text AS status FROM empresas')) return Promise.reject(new Error('consulta final indisponível'));
            return (super.query as (...x: unknown[]) => unknown)(...a) as never;
        }
    }
    const sub = { ...e.sub, nextDueDate: somar(hoje, 10) };
    const provedor = { obterAssinatura: async (x: string) => (x === sub.id ? { ...sub } : null), listarCobrancasDaAssinatura: async () => [], obterCobranca: async () => null,
        atualizarValorAssinatura: async () => { throw new Error('sem PUT'); }, atualizarValorCobranca: async () => { throw new Error('sem PUT'); }, suspenderGeracao: async () => { throw new Error('sem PUT'); } };
    const conexao = { host: '127.0.0.1', port: portaDescartavel(), user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel', password: senhaRecusada };
    const r = await executarCron({ ambiente: 'staging', modo: 'aplicar', rebaixado: false, alvo: { database: 'kidmais_pacotes_v1_descartavel', local: true }, empresas: [e.empresaId], agora: null },
        { Pool: PoolSemInformativos, Client: pg.Client, conexao, provedor, enviar: async () => { throw new Error('sem envio'); }, origem: 'https://kidmais.example' });
    const final = JSON.parse(JSON.stringify({ ambiente: 'staging', modo: 'aplicar', ...r }));
    assert.equal(final.codigo, 2);
    assert.deepEqual(final.alertasInformativos, []);
    assert.deepEqual(final.alertas.map((a: { resultado: string; puts: unknown }) => [a.resultado, a.puts]),
        [['ALERTA_JANELA_AVISO_PERDIDA', { assinatura: 0, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 0 }]]);
    assert.deepEqual(final.putsTotais, { assinatura: 0, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 0, empresasComTentativa: 0 });
});

/**
 * R2-F1 (revisão do código r2): o JSON IMPRESSO pelo CLI real (main de scripts/assinatura-renovacao-cron.cjs, processo filho)
 * com PUT NÃO ZERO e a consulta final de alertasInformativos falhando. Driver pg real redirecionado ao PG descartável e Asaas
 * sandbox falso por `-r` (lib/assinatura/renovacao-cron-cli.postgres.test-apoio.cjs); nenhuma rede, nenhum alvo real.
 * Cenário: renovação já REGULAR com o preço do provedor de volta ao Fundador → PUT da assinatura fora de APLICANDO (D-PUT-1).
 */
test('R2-F1: CLI real — stdout com puts por item e putsTotais não zero, alertasInformativos vazio e código 2 após a falha da consulta final', { skip: !opt() }, async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const { portaDescartavel } = await import('../comercial/postgres-descartavel.ts');
    const e = await empresaFundador(client, usuario);
    const pdr = somar(hoje, 40);
    const id = await inserir(client, e, { pdr, pv: somar(hoje, -325) });
    await client.query("UPDATE assinatura_renovacoes SET estado = 'AVISANDO', aviso_tentado_em = clock_timestamp() WHERE id = $1", [id]);
    await client.query("UPDATE assinatura_renovacoes SET estado = 'AVISADA', aviso_enviado_em = clock_timestamp(), aviso_id_externo = 'email_cli' WHERE id = $1", [id]);
    await client.query("UPDATE assinatura_renovacoes SET estado = 'APLICANDO' WHERE id = $1", [id]);
    await client.query("UPDATE assinatura_renovacoes SET estado = 'REGULAR', preco_aplicado_em = clock_timestamp() WHERE id = $1", [id]);
    const final = (await client.query('SELECT valor_final_centavos AS f FROM assinatura_contratacoes WHERE id = $1', [e.contratacaoId])).rows[0].f as number;
    const sub = { id: e.sub.id, customer: e.sub.customer, externalReference: e.empresaId, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, value: final / 100, nextDueDate: pdr };
    const dir = mkdtempSync(path.join(tmpdir(), 'kidmais-cron-cli-'));
    try {
        const estado = path.join(dir, 'estado.json');
        const raiz = path.resolve(path.dirname((await import('node:url')).fileURLToPath(import.meta.url)), '../..');
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: tmpdir(), TMP: tmpdir(), NODE_ENV: 'test',
            KM_PG: createRequire(import.meta.url).resolve('pg'), KM_PORTA: String(portaDescartavel()), KM_SUB: JSON.stringify(sub), KM_ESTADO: estado,
            KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_RENOVACAO_MODO: 'aplicar', RENDER: 'true', RENDER_SERVICE_ID: 'crn-dbg512hsrm7s73chk57g',
            KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgres://fixture:secreto@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
            KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432', KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado',
            ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_fixture', ASAAS_WEBHOOK_TOKEN: 'x'.repeat(32),
            EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture', EMAIL_REMETENTE: 'teste@example.invalid', ADMIN_AUTH_ORIGIN: 'https://kidmais-manager-staging.onrender.com' };
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-r', path.join(raiz, 'lib/assinatura/renovacao-cron-cli.postgres.test-apoio.cjs'),
            path.join(raiz, 'scripts/assinatura-renovacao-cron.cjs'), `--empresas=${e.empresaId}`], { env, cwd: raiz, encoding: 'utf8', timeout: 120_000 });
        assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
        const impresso = JSON.parse(r.stdout);
        assert.deepEqual([impresso.ambiente, impresso.modo, impresso.execucao, impresso.codigo], ['staging', 'aplicar', 'CONCLUIDA', 2]);
        assert.deepEqual(impresso.alertasInformativos, [], 'a consulta final falhou: todos os alertas contam como reais');
        const item = impresso.alertas.find((a: { empresaId: string }) => a.empresaId === e.empresaId);
        assert.deepEqual([item.resultado, item.motivo], ['REGULAR', 'PUT_FORA_DE_APLICANDO']);
        assert.deepEqual(item.puts, { assinatura: 1, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 1 });
        assert.deepEqual(impresso.putsTotais, { assinatura: 1, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 1, empresasComTentativa: 1 });
        assert.ok(existsSync(estado) && JSON.parse((await import('node:fs')).readFileSync(estado, 'utf8')).puts === 1, 'um PUT real no Asaas falso');
        for (const segredo of ['secreto', 're_fixture', '$aact_hmlg_fixture', 'teste@example.invalid', e.sub.id]) assert.ok(!r.stdout.includes(segredo), `sem ${segredo}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
