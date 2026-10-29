import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg, { type Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from '../comercial/postgres-descartavel.ts';
import { capacidadeRenovacao, lerRetrato, type Retrato } from './renovacao-schema.ts';
import { consultarRenovacao, repositorioRenovacao } from './renovacao-repositorio.ts';
import { RETRATO_075, RETRATO_109 } from './renovacao-schema-retratos.ts';
import { emTx, empresaFundador, hojeBanco, somar, usuarioSintetico } from './renovacao-109-apoio.postgres.test-apoio.ts';

const usuarioGestao = async (c: Client) => (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão 109', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
    usuarioSintetico())).rows[0].id as string;

/**
 * B-9 production — detector do retrato (plano rev. 5 §2.6, R2-F2/R3-F1/R4-F1) no PG DESCARTÁVEL, modelo 108 (075 íntegra);
 * a suíte aplica a 109 no meio. Cada desvio é feito numa transação e DESFEITO (DDL transacional): um componente por vez, com
 * os demais intactos, nas DUAS versões. A prova é o detector (INCOMPATIVEL), não uma falha posterior do processador.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const exigir = createRequire(import.meta.url);
let client: Client;
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), 'utf8');
const T = 'public.assinatura_renovacoes';

async function desvio(nome: string, ddl: string[]) {
    await client.query('BEGIN');
    try {
        for (const x of ddl) await client.query(x);
        const c = await capacidadeRenovacao(client as never);
        assert.equal(c.capacidade, 'INCOMPATIVEL', nome);
        return (c as { divergencias: string[] }).divergencias;
    } finally { await client.query('ROLLBACK'); }
}

/** Desvios comuns às duas versões, derivados do retrato aprovado (nada fica de fora por esquecimento). */
async function bateriaComum(versao: '075' | '109', retrato: Retrato) {
    const guarda = retrato.gatilhos.find((g) => g.nome === 'assinatura_renovacoes_075_guarda')!.funcao as string;
    const testados: string[] = [];
    for (const c of retrato.constraints) {
        if (c.tipo === 'n' || c.tipo === 'p') continue; // NOT NULL e PK: cobertos abaixo por ALTER próprios
        const d = await desvio(`${versao}: sem ${c.nome}`, [`ALTER TABLE ${T} DROP CONSTRAINT ${c.nome} CASCADE`]);
        assert.ok(d.some((x) => x.startsWith(`constraints:${c.nome}:`)), `${versao}: ${c.nome} na lista`);
        testados.push(c.nome);
    }
    // CHECKs de evidência e prazo, aviso_dias e mensagem precisam ter sido exercitados (R3-F1).
    const checks = retrato.constraints.filter((c) => c.tipo === 'c');
    for (const pad of [/aviso_dias = 30/, /America\/Sao_Paulo/, /'AVISADA'/, /preco_aplicado_em >= aviso_enviado_em/, /idempotencia/, /ultimo_erro/, /primeira_data_regular > primeiro_vencimento/])
        assert.ok(checks.some((c) => pad.test(String(c.def)) && testados.includes(c.nome)), `${versao}: CHECK ${pad}`);
    const prazo = checks.find((c) => /America\/Sao_Paulo/.test(String(c.def)))!;
    await desvio(`${versao}: CHECK do prazo NOT VALID`, [`ALTER TABLE ${T} DROP CONSTRAINT ${prazo.nome}`, `ALTER TABLE ${T} ADD CONSTRAINT ${prazo.nome} ${prazo.def} NOT VALID`]);
    await desvio(`${versao}: constraint a mais`, [`ALTER TABLE ${T} ADD CONSTRAINT kidmais_extra_check CHECK (true)`]);
    await desvio(`${versao}: default de aviso_dias`, [`ALTER TABLE ${T} ALTER COLUMN aviso_dias SET DEFAULT 31`]);
    await desvio(`${versao}: NOT NULL a menos`, [`ALTER TABLE ${T} ALTER COLUMN mensagem DROP NOT NULL`]);
    await desvio(`${versao}: PK trocada`, [`ALTER TABLE ${T} DROP CONSTRAINT assinatura_renovacoes_pkey CASCADE`, `ALTER TABLE ${T} ADD CONSTRAINT assinatura_renovacoes_pkey PRIMARY KEY (id, empresa_id)`]);
    await desvio(`${versao}: sem índice pendentes`, [`DROP INDEX public.assinatura_renovacoes_pendentes_idx`]);
    await desvio(`${versao}: coluna a mais`, [`ALTER TABLE ${T} ADD COLUMN extra int`]);
    for (const g of retrato.gatilhos) {
        await desvio(`${versao}: ${g.nome} desabilitado`, [`ALTER TABLE ${T} DISABLE TRIGGER ${g.nome}`]);
        await desvio(`${versao}: sem ${g.nome}`, [`DROP TRIGGER ${g.nome} ON ${T}`]);
    }
    // R4-F1: WHEN (false), UPDATE OF estado e sem UPDATE, mesmos nome, momento e função.
    const recriar = (def: string) => [`DROP TRIGGER assinatura_renovacoes_075_guarda ON ${T}`, def];
    await desvio(`${versao}: guarda com WHEN (false)`, recriar(`CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR UPDATE OR DELETE ON ${T} FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${guarda}()`));
    await desvio(`${versao}: guarda com UPDATE OF estado`, recriar(`CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR UPDATE OF estado OR DELETE ON ${T} FOR EACH ROW EXECUTE FUNCTION ${guarda}()`));
    await desvio(`${versao}: guarda sem UPDATE`, recriar(`CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR DELETE ON ${T} FOR EACH ROW EXECUTE FUNCTION ${guarda}()`));
    // Função: corpo, search_path e SECURITY DEFINER.
    const corpo = (await client.query(`SELECT prosrc FROM pg_proc WHERE oid = '${guarda}()'::regprocedure`)).rows[0].prosrc as string;
    await desvio(`${versao}: corpo da guarda alterado`, [`CREATE OR REPLACE FUNCTION ${guarda}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$${corpo.replace("IF TG_OP IN ('DELETE','TRUNCATE')", "IF TG_OP IN ('TRUNCATE')")}$f$`]);
    await desvio(`${versao}: search_path da guarda`, [`ALTER FUNCTION ${guarda}() SET search_path = public, pg_catalog`]);
    await desvio(`${versao}: guarda SECURITY DEFINER`, [`ALTER FUNCTION ${guarda}() SECURITY DEFINER`]);
    return testados.length;
}

test.before(async () => { if (opt()) client = await conectarDescartavel(); });
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('075 íntegra: capacidade 075, independente do search_path da sessão; nenhuma consulta cita a coluna nova', { skip: !opt() }, async () => {
    assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '075' });
    for (const caminho of ['public, pg_catalog', '"$user", public', 'pg_catalog'])  {
        await client.query(`SET search_path = ${caminho}`);
        assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '075' }, caminho);
        assert.equal((await client.query('SHOW search_path')).rows[0].search_path.replace(/\s/g, ''), caminho.replace(/\s/g, ''), 'caminho restaurado');
    }
    await client.query('RESET search_path');
    // Repositório da 075 (criar duas vezes, ler, consultar): nenhuma consulta menciona substitui_id.
    const consultas: string[] = [];
    const espiao = { query: (sql: string, p?: unknown[]) => { consultas.push(sql); return client.query(sql, p); } } as never;
    const usuario = await usuarioGestao(client);
    const e = await empresaFundador(client, usuario);
    const hoje = await hojeBanco(client);
    const repo = repositorioRenovacao((f) => emTx(client, () => f(espiao)));
    const base = { id: '12121212-1212-4212-8212-121212121212', empresaId: e.empresaId, contratacaoId: e.contratacaoId, destinatarioId: usuario,
        primeiroVencimento: somar(hoje, -300), primeiraDataRegular: somar(hoje, 60), estado: 'PENDENTE' as const,
        mensagem: { para: 'g@example.test', assunto: 'a', texto: 't', html: '<p>t</p>', idempotencia: 'kidmais-renovacao/12121212-1212-4212-8212-121212121212' },
        avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null };
    const a = await repo.criar(base);
    assert.equal((await repo.criar({ ...base, id: '13131313-1313-4313-8313-131313131313' })).id, a.id, '075: criar idempotente');
    await repo.ler(e.empresaId); await consultarRenovacao(espiao, e.empresaId);
    assert.ok(consultas.length > 4 && !consultas.some((s) => /substitui_id/.test(s)), 'nenhuma referência prematura à coluna nova');
    assert.equal(repo.substituir, undefined);
});

test('075: cada componente removido ou adulterado isoladamente → INCOMPATIVEL', { skip: !opt() }, async () => {
    assert.equal(await bateriaComum('075', RETRATO_075), 14, 'todas as constraints da 075 exceto NOT NULL e PK');
});

test('109 aplicada pela suíte: capacidade 109; cada componente comum e próprio adulterado → INCOMPATIVEL', { skip: !opt() }, async () => {
    await client.query(ler('database/checks/20261029_109_precheck.sql'));
    await client.query(ler('database/migrations/20261029_109_renovacao_substituta.sql'));
    await client.query(ler('database/checks/20261029_109_postcheck.sql'));
    assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '109' });
    assert.equal(await bateriaComum('109', RETRATO_109), 17, 'todas as constraints da 109 exceto NOT NULL e PK');
    // Próprios da 109.
    await desvio('sucessor não diferido', [`DROP TRIGGER assinatura_renovacoes_109_sucessor ON ${T}`,
        `CREATE CONSTRAINT TRIGGER assinatura_renovacoes_109_sucessor AFTER UPDATE ON ${T} DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_sucessor()`]);
    await desvio('sucessor comum (não constraint)', [`DROP TRIGGER assinatura_renovacoes_109_sucessor ON ${T}`,
        `CREATE TRIGGER assinatura_renovacoes_109_sucessor AFTER UPDATE ON ${T} FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_sucessor()`]);
    await desvio('índice vigente com outro predicado', ['DROP INDEX public.assinatura_renovacoes_109_vigente_uq',
        `CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq ON ${T} (contratacao_id) WHERE estado <> 'CANCELADA'`]);
    await desvio('índice vigente não único', ['DROP INDEX public.assinatura_renovacoes_109_vigente_uq', `CREATE INDEX assinatura_renovacoes_109_vigente_uq ON ${T} (contratacao_id) WHERE estado <> 'SUBSTITUIDA'`]);
    await desvio('FK da cadeia NOT VALID', [`ALTER TABLE ${T} DROP CONSTRAINT assinatura_renovacoes_109_cadeia_fk`,
        `ALTER TABLE ${T} ADD CONSTRAINT assinatura_renovacoes_109_cadeia_fk FOREIGN KEY (empresa_id, contratacao_id, substitui_id) REFERENCES ${T} (empresa_id, contratacao_id, id) NOT VALID`]);
    await desvio('UNIQUE antiga de volta', [`ALTER TABLE ${T} ADD CONSTRAINT assinatura_renovacoes_contratacao_id_key UNIQUE (contratacao_id)`]);
    await desvio('coluna substitui_id de outro tipo', [`ALTER TABLE ${T} DROP CONSTRAINT assinatura_renovacoes_109_cadeia_fk`, `ALTER TABLE ${T} ALTER COLUMN substitui_id TYPE text`]);
    assert.deepEqual(await capacidadeRenovacao(client as never), { capacidade: '109' }, 'tudo desfeito');
});

test('cron com schema INCOMPATIVEL: código 1, nada processado, nenhuma chamada ao provedor nem envio', { skip: !opt() }, async () => {
    const { executarCron } = exigir('../../scripts/assinatura-renovacao-cron.cjs');
    const chamadas: string[] = [];
    const provedor = new Proxy({}, { get: (_t, nome) => async () => { chamadas.push(String(nome)); throw new Error('provedor não deveria ser chamado'); } });
    const conexao = { host: '127.0.0.1', port: portaDescartavel(), user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel', password: senhaRecusada };
    const antes = (await client.query('SELECT count(*)::int AS n, max(atualizado_em) AS m FROM assinatura_renovacoes')).rows[0];
    await client.query(`ALTER TABLE ${T} DISABLE TRIGGER assinatura_renovacoes_075_guarda`);
    try {
        const r = await executarCron({ ambiente: 'staging', modo: 'aplicar', rebaixado: false, alvo: { database: 'kidmais_pacotes_v1_descartavel', local: true }, empresas: null, agora: null },
            { Pool: pg.Pool, Client: pg.Client, conexao, provedor, enviar: async () => { chamadas.push('enviar'); throw new Error('sem envio'); }, origem: 'https://kidmais.example' });
        assert.deepEqual([r.codigo, r.execucao, r.processadas], [1, 'SCHEMA_RENOVACAO_INCOMPATIVEL', 0]);
        assert.ok(r.divergencias.includes('gatilhos:assinatura_renovacoes_075_guarda:DIVERGE'));
        assert.ok(!JSON.stringify(r).includes('CREATE'), 'só nomes, sem definições');
    } finally { await client.query(`ALTER TABLE ${T} ENABLE TRIGGER assinatura_renovacoes_075_guarda`); }
    assert.deepEqual(chamadas, []);
    assert.deepEqual((await client.query('SELECT count(*)::int AS n, max(atualizado_em) AS m FROM assinatura_renovacoes')).rows[0], antes);
    assert.deepEqual(await lerRetrato(client as never) !== null, true);
});
