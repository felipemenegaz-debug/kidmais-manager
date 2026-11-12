import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { modoAdmitido, EVENTOS_OBRIGATORIOS, type CodigoNoAr } from './recuperacao-execucao.ts';
import type { Arquivos, Execucao, Resultado } from './recuperacao-modos.ts';
import { TABELAS } from './recuperacao-efeitos.ts';
import { identidadeDoCaso } from './recuperacao-casos.ts';
import { hashCanonico } from './recuperacao-hash.ts';
import { prefixoDoSchema } from './recuperacao-baseline.ts';
import { iniciarTeste } from './servico.ts';
import { registrarEvento, sincronizarEmpresa } from './sincronizacao.ts';
import { registrarAvisosDaTransicao } from './avisos-repositorio.ts';
import { provedorSomenteLeitura } from './recuperacao-provedor.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * B-23c §6, etapa 2 (validação dirigida, plano r2 aprovado pelo Astra; precisão do parecer r2): o B-14 com a trava
 * ASSINATURA_AVISOS_EMAIL DESLIGADA não muda `assinatura_avisos`, que fica fora da fotografia e do comparador do B-14.
 * PostgreSQL DESCARTÁVEL, com o PACOTE ENTREGUE (a árvore mínima de `arvore-recuperacao-b14.cjs`, escrita fora do checkout,
 * como em recuperacao-prefixos). A mesma suíte roda em quatro modelos (KIDMAIS_POSTGRES_MODELO, posto pelo runner):
 *   b14-P0a        (087 presente, código ANTIGO 5e4340db: o estado de production desde 03/11/2026)
 *   b14-P0a-sem087 (087 ausente,  código ANTIGO)
 *   b14-P11        (087 presente, código CANDIDATA)
 *   b14-P11-sem087 (087 ausente,  código CANDIDATA)
 * Em cada um, casos EMPRESA (pagamento confirmado no provedor e perdido localmente: o período cresce, que é exatamente a
 * transição que gera PAGAMENTO_CONFIRMADO) e EVENTO (PAYMENT_RECEIVED pendente), pelos modos admitidos ao código:
 *   1. o modelo é o declarado: com a 087, tabela e funções `kidmais_087_*` presentes; sem a 087, ausentes;
 *   2. CLI do pacote com a trava ligada → AVISOS_EMAIL_LIGADOS, nada muda;
 *   3. trava desligada: JANELA --conferir (ROLLBACK) e, com a candidata, --recuperar e a conferência seguinte; RESTORE
 *      drenagem → inventário → aplicar-caso → conferir-caso. Com a 087, o conteúdo INTEGRAL de `assinatura_avisos`
 *      (todas as linhas e colunas, inclusive alterações em linhas existentes: há uma linha pré-existente) é igual antes e
 *      depois; sem a 087, a tabela e as funções continuam ausentes;
 *   4. CONTROLE POSITIVO (prova de que o comparador e a fixture enxergam o gancho): os MESMOS modos do pacote, chamados
 *      diretamente (sem a guarda do CLI) com a trava LIGADA, mudam `assinatura_avisos` com a 087 — e o caso sai APLICADO
 *      sem o comparador do B-14 perceber; sem a 087, nada é criado (avisosInstalados = false).
 * Limite: domínio sintético e Asaas falso; não substitui a homologação nem a matriz completa de prefixos.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const MODELO = process.env.KIDMAIS_POSTGRES_MODELO ?? '';
const MODELOS: Record<string, { com087: boolean; codigo: CodigoNoAr }> = {
    'b14-P0a': { com087: true, codigo: 'ANTIGO' }, 'b14-P0a-sem087': { com087: false, codigo: 'ANTIGO' },
    'b14-P11': { com087: true, codigo: 'CANDIDATA' }, 'b14-P11-sem087': { com087: false, codigo: 'CANDIDATA' },
};
const ativo = () => opt() && Object.hasOwn(MODELOS, MODELO);
const M = () => MODELOS[MODELO];
const BANCO = 'kidmais_pacotes_v1_descartavel';
const CAND = 'c'.repeat(40);
const ANTIGO = '5e4340db485520eabc84f67f090907de7fddac06';
const URL_WEBHOOK = 'https://kidmais.example/api/integracoes/asaas/webhook';
const TRAVA = 'ASSINATURA_AVISOS_EMAIL';
const raiz = path.resolve(import.meta.dirname, '../..');
const requireCjs = createRequire(import.meta.url);

/** Migrations além da 088 do modelo, pela mesma regra e fonte da receita (como em recuperacao-prefixos). */
async function declaradasDoModelo(nome: string): Promise<string[]> {
    const { MODELOS: R } = requireCjs('../../scripts/regressao-v1-postgres-receita.cjs') as { MODELOS: Record<string, { ate: string; sem: string[] }> };
    const m = R[nome];
    const inventario = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href) as { approvedFiles: readonly string[] };
    const numeros = [...inventario.approvedFiles].map((f) => f.split('_')[1]);
    const fim = numeros.indexOf(m.ate);
    assert.ok(fim >= 0, `checkpoint ${m.ate}`);
    return [...new Set(numeros.slice(0, fim + 1).filter((n) => !m.sem.includes(n) && /^\d{3}$/.test(n) && Number.parseInt(n, 10) > 88))].sort();
}

/** Asaas falso da suíte (escrita proibida). */
const subs = new Map<string, AssinaturaProvedor>();
const daAssinatura = new Map<string, CobrancaProvedor[]>();
const avulsas = new Map<string, CobrancaProvedor>();
const cliente = {
    async obterAssinatura(id: string) { const x = subs.get(id); return x ? { ...x } : null; },
    async listarCobrancasDaAssinatura(id: string) { return (daAssinatura.get(id) ?? []).map((p) => ({ ...p })); },
    async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((x) => x.externalReference === ref).map((x) => ({ ...x })); },
    async obterCobranca(id: string) { const c = avulsas.get(id); return c ? { ...c, estornos: [...(c.estornos ?? [])] } : null; },
    async listarCobrancasPorReferencia(ref: string) { return [...avulsas.values()].filter((c) => c.externalReference === ref).map((c) => ({ ...c })); },
    async listarCobrancas() { const itens = [...avulsas.values(), ...[...daAssinatura.values()].flat()].map((c) => ({ ...c })); return { itens, totalCount: itens.length }; },
    async listarWebhooks() { return { itens: [{ id: 'wh_1', url: URL_WEBHOOK, enabled: true, interrupted: false, sendType: 'SEQUENTIALLY', events: [...EVENTOS_OBRIGATORIOS] }], totalCount: 1 }; },
    async removerAssinatura() { throw new Error('escrita no provedor proibida'); },
};
const somenteLeitura = provedorSomenteLeitura(cliente as never);

let client: Client;
let declaradas: string[] = [];
let indice = -1;
let pacote = '';
let pasta = '';
let usuario = '';
let seq = 0;
let cli: { main: (argv: string[], env: Record<string, string>, sair: (c: number) => void, deps: { cliente: unknown }) => Promise<void> };
type Modos = typeof import('./recuperacao-modos.ts');
let modos: Modos;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
const agoraIso = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS t")).rows[0].t as string;
const hojeBr = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
const maisMeses = (dia: string, n: number) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try { const r = await acao(); await q('COMMIT'); return r; }
    catch (error) { await q('ROLLBACK'); throw error; }
}
function cnpj(n: number) {
    const base = `6${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let t = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { t += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = t % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}

/**
 * Retrato INDEPENDENTE do B-14 (o comparador dele não enxerga a tabela): presença da 087 e, com ela, o conteúdo integral de
 * `assinatura_avisos` (todas as colunas de todas as linhas, ordenadas pelo texto da linha).
 */
async function retratoAvisos() {
    const existe = (await q("SELECT to_regclass('public.assinatura_avisos') IS NOT NULL AS ok")).rows[0].ok as boolean;
    const funcoes = Number((await q("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname LIKE 'kidmais\\_087\\_%'")).rows[0].n);
    if (!existe) return { existe, funcoes, linhas: 0, conteudo: null as string | null };
    const r = (await q("SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(x)::text, E'\\n' ORDER BY to_jsonb(x)::text), '')) AS h FROM public.assinatura_avisos x")).rows[0];
    return { existe, funcoes, linhas: Number(r.n), conteudo: r.h as string };
}
/** Digest das tabelas da lista fechada do B-14 (o que o próprio B-14 enxerga). */
async function digestB14() {
    const partes: string[] = [];
    for (const t of Object.keys(TABELAS).sort()) {
        if (!(await q("SELECT to_regclass('public.' || $1) IS NOT NULL AS ok", [t])).rows[0].ok) continue;
        partes.push(`${t}:${(await q(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) AS h FROM public.${t} x`)).rows[0].h}`);
    }
    return partes.join('|');
}

test.before(async () => {
    if (!ativo()) return;
    client = await conectarDescartavel();
    declaradas = await declaradasDoModelo(MODELO);
    indice = prefixoDoSchema(declaradas, 'sandbox')?.indice ?? -1;
    const { arvore } = requireCjs('../../scripts/arvore-recuperacao-b14.cjs') as { arvore: (r: string) => { arquivos: { arquivo: string; conteudo: Buffer }[] } };
    pacote = fs.mkdtempSync(path.join(os.tmpdir(), 'b23c-pacote-'));
    for (const x of arvore(raiz).arquivos) {
        fs.mkdirSync(path.dirname(path.join(pacote, x.arquivo)), { recursive: true });
        fs.writeFileSync(path.join(pacote, x.arquivo), x.conteudo);
    }
    fs.symlinkSync(path.join(raiz, 'node_modules'), path.join(pacote, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    cli = requireCjs(path.join(pacote, 'scripts/recuperacao-pagamentos-producao.cjs'));
    modos = await import(pathToFileURL(path.join(pacote, 'lib/assinatura/recuperacao-modos.ts')).href) as Modos;
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b23c-evid-'));
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão B-23c', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`b23c${randomBytes(3).toString('hex')}@avisos.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => {
    if (client) await encerrarDescartavel(client);
    if (pacote) { fs.unlinkSync(path.join(pacote, 'node_modules')); fs.rmSync(pacote, { recursive: true, force: true }); }
    if (pasta) fs.rmSync(pasta, { recursive: true, force: true });
});

/** Empresa ATIVA pelo pagamento da 1ª cobrança, com uma pessoa da Gestão (destinatária elegível de aviso). */
async function empresaAtiva() {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet B-23c', 'PROVISIONAMENTO') RETURNING id", [`bc${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas B-23c Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `bc${n}@avisos.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    const dia = await hojeBr();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: maisMeses(dia, 1) };
    subs.set(sub.id, sub);
    daAssinatura.set(sub.id, [{ id: `pay_${k}`, status: 'RECEIVED', dueDate: dia, paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    // Trava explicitamente desligada na fixture: a linha pré-existente é criada à parte, abaixo.
    await emTx(() => sincronizarEmpresa(client as never, id, { provedor: somenteLeitura as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal((await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].situacao, 'ATIVA');
    return { id, sub };
}
/** Pagamento do ciclo seguinte confirmado no Asaas e perdido localmente: o período local fica um ciclo atrás. */
async function pagamentoPerdido(sub: AssinaturaProvedor) {
    const dia = await hojeBr();
    const k = randomBytes(4).toString('hex');
    daAssinatura.get(sub.id)!.push({ id: `pay_${k}`, status: 'RECEIVED', dueDate: maisMeses(dia, 1), paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' });
    subs.set(sub.id, { ...sub, nextDueDate: maisMeses(dia, 2) });
}
/** Linha PRÉ-EXISTENTE em assinatura_avisos (só com a 087): a comparação integral cobre alteração em linha existente. */
async function avisoExistente(empresaId: string) {
    if (!M().com087) return;
    const fim = (await q("SELECT to_char(periodo_atual_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS f FROM empresa_assinaturas WHERE empresa_id = $1", [empresaId])).rows[0].f;
    const criados = await emTx(() => registrarAvisosDaTransicao(client as never, empresaId, { situacao: 'TESTE', periodoAtualFim: null }, { situacao: 'ATIVA', periodoAtualFim: fim },
        { env: { [TRAVA]: 'ligado' } }));
    assert.equal(criados, 1, 'fixture: uma linha pré-existente');
}
function emMemoria(): Arquivos {
    const mapa = new Map<string, unknown>();
    return {
        ler: (n) => (mapa.has(n) ? JSON.parse(JSON.stringify(mapa.get(n))) : null),
        gravarNovo: (n, c) => { if (mapa.has(n)) throw new Error('EEXIST'); mapa.set(n, JSON.parse(JSON.stringify(c))); },
        invalidar: (n) => { mapa.set(`${n}.invalidada`, mapa.get(n)); mapa.delete(n); },
        listar: (p) => [...mapa.keys()].filter((k) => k.startsWith(p) && k.endsWith('.json')).sort(),
    };
}
const execCom = (arquivos: Arquivos, extra: Partial<Execucao> = {}): Execucao => ({ client: client as never, cliente: cliente as never, execucao: randomUUID(), ambiente: 'sandbox',
    creditos: null, controle: { parar: async () => null }, arquivos, migracoes: declaradas, codigoNoAr: M().codigo, ...extra });
/** Trava no process.env (o gancho lê o process.env quando a sincronização não passa `env`); restaurada sempre. */
async function comTrava<T>(valor: string | undefined, acao: () => Promise<T>): Promise<T> {
    const antes = process.env[TRAVA];
    if (valor === undefined) delete process.env[TRAVA]; else process.env[TRAVA] = valor;
    try { return await acao(); }
    finally { if (antes === undefined) delete process.env[TRAVA]; else process.env[TRAVA] = antes; }
}
const janela = async () => ({ desde: new Date(Date.parse(await agoraIso()) - 86_400_000).toISOString(), ate: await agoraIso() });

/** RESTORE: drenagem → inventário → aplicar-caso (cada caso PROPOSTA da empresa) → conferir-caso. */
/**
 * RESTORE por rodadas (ajuste de fixture declarado na execução 1 do §6): cada proposta vale para a fotografia do inventário
 * em que nasceu, e aplicar um caso muda o estado do outro (EMPRESA e EVENTO da mesma assinatura). Então cada rodada faz
 * drenagem → inventário NOVOS e aplica UM caso-alvo em PROPOSTA (EVENTO primeiro), com conferir-caso logo depois. Um alvo
 * que deixa de ser PROPOSTA depois de outro aplicado entra em `fechados`, com as classes de cada rodada em `rodadas`.
 */
async function restore(arquivos: Arquivos, empresaId: string, evento: string | null) {
    const alvo = [...(evento ? [identidadeDoCaso('EVENTO', evento)] : []), identidadeDoCaso('EMPRESA', empresaId)];
    const aplicacoes: Resultado[] = [];
    const aplicados: string[] = [];
    const rodadas: [string, string][][] = [];
    let inv: Resultado | null = null;
    let ultimo: { identidade: string; classe: string }[] = [];
    for (let rodada = 0; rodada <= alvo.length; rodada++) {
        const reinicio = await agoraIso();
        const dren = await modos.modoDrenagem(execCom(arquivos), { reinicio, contencaoDesde: new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
        assert.deepEqual([dren.codigo, dren.resultado], [2, 'PASS']);
        const desde = new Date(Date.parse(reinicio) - 86_400_000).toISOString();
        inv = await modos.modoInventario(execCom(arquivos), { desde, ate: new Date().toISOString(), drenagem: `drenagem-${dren.execucao}.json`, reinicio });
        const casos = arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string; classe: string }[] };
        rodadas.push(casos.casos.filter((x) => alvo.includes(x.identidade)).map((x) => [x.identidade === alvo[0] && evento ? 'EVENTO' : 'EMPRESA', x.classe]));
        const c = alvo.filter((a) => !aplicados.includes(a)).map((a) => casos.casos.find((x) => x.identidade === a && x.classe === 'PROPOSTA')).find(Boolean);
        ultimo = casos.casos;
        if (!c) break;
        const ap = await modos.modoAplicarCaso(execCom(arquivos), { casos: inv.arquivoDeCasos as string, identidade: c.identidade, proposta: c.hash });
        assert.deepEqual([ap.codigo, ap.resultado], [2, 'APLICADO'], `aplicar-caso: ${JSON.stringify({ rodadas, ap })}`);
        const conf = await modos.modoConferirCaso(execCom(arquivos), { casos: inv.arquivoDeCasos as string, identidade: c.identidade, proposta: c.hash, execucaoDaAplicacao: ap.execucao });
        assert.equal(conf.resultado, 'APLICADO', `conferir-caso: ${JSON.stringify({ rodadas, conf })}`);
        aplicacoes.push(ap);
        aplicados.push(c.identidade);
    }
    assert.ok(aplicados.length >= 1, `nenhuma proposta para a empresa: ${JSON.stringify(rodadas)}`);
    const fechados = alvo.filter((a) => !aplicados.includes(a));
    // P3 do Astra (§6 r2): um alvo só conta como fechado se estiver PRESENTE no inventário final e RECONCILIADA.
    for (const a of fechados) {
        const classes = ultimo.filter((x) => x.identidade === a).map((x) => x.classe);
        assert.deepEqual(classes, ["RECONCILIADA"], `alvo fechado sem aplicar precisa estar RECONCILIADA: ${JSON.stringify({ alvo: a.slice(0, 8), classes, rodadas })}`);
    }
    return { inv, aplicacoes, propostas: aplicados, fechados, rodadas };
}

test('B-23c §6: o modelo é o declarado (087 presente/ausente) e o prefixo admite os modos do código', { skip: !ativo() }, async () => {
    const r = await retratoAvisos();
    assert.deepEqual([r.existe, r.funcoes > 0], [M().com087, M().com087], `${MODELO}: ${JSON.stringify(r)}`);
    assert.ok(indice >= 0, 'prefixo reconhecido');
    assert.equal(modoAdmitido(indice, M().codigo, 'restore-aplicar'), true);
    assert.equal(modoAdmitido(indice, M().codigo, 'janela-recuperar'), M().codigo === 'CANDIDATA');
});

test('B-23c §6: CLI do pacote com a trava ligada → AVISOS_EMAIL_LIGADOS e nada muda', { skip: !ativo() }, async () => {
    const { id, sub } = await empresaAtiva();
    await avisoExistente(id);
    await pagamentoPerdido(sub);
    const porta = process.env.KIDMAIS_DESCARTAVEL_PORTA!;
    const env = { DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${BANCO}`, KIDMAIS_B14_ALVO: `${BANCO}@127.0.0.1:${porta}`, KIDMAIS_B14_DESCARTAVEL: BANCO,
        ASAAS_AMBIENTE: 'sandbox', RENDER_GIT_COMMIT: M().codigo === 'CANDIDATA' ? CAND : ANTIGO };
    const migracoes = declaradas.length ? `--migracoes=${declaradas.join(',')}` : '--migracoes=nenhuma';
    const antes = [await retratoAvisos(), await digestB14()];
    const saidas: string[] = [];
    const log = console.log;
    let codigo: number | null = null;
    console.log = (s: string) => saidas.push(s);
    const { desde } = await janela();
    try {
        await comTrava('ligado', () => cli.main(['--janela', '--conferir', `--desde=${desde}`, `--ate=${new Date().toISOString().slice(0, 19)}Z`, migracoes,
            `--candidata=${CAND}`, `--saida=${pasta}`], env, (c) => { codigo = c; }, { cliente }));
    }
    finally { console.log = log; }
    assert.deepEqual([codigo, JSON.parse(saidas.at(-1)!).motivo], [1, 'AVISOS_EMAIL_LIGADOS']);
    assert.deepEqual([await retratoAvisos(), await digestB14()], antes);
});

test('B-23c §6: trava DESLIGADA — JANELA e RESTORE com casos EMPRESA e EVENTO não mudam assinatura_avisos', { skip: !ativo() }, async () => {
    for (const trava of [undefined, 'desligado']) await comTrava(trava, async () => {
        // JANELA: --conferir (ROLLBACK por caso) e, com a candidata, --recuperar (COMMIT por caso) + conferência.
        const a = await empresaAtiva();
        await avisoExistente(a.id);
        await pagamentoPerdido(a.sub);
        let antes = await retratoAvisos();
        const b14 = await digestB14();
        const conf = await modos.modoJanela(execCom(emMemoria()), { ...(await janela()), recuperar: false });
        assert.equal(conf.codigo, 2, `JANELA --conferir vê o caso: ${JSON.stringify(conf.classes)}`);
        assert.equal(await digestB14(), b14, 'conferir não grava');
        assert.deepEqual(await retratoAvisos(), antes, `JANELA --conferir, trava ${trava}`);
        if (M().codigo === 'CANDIDATA') {
            const rec = await modos.modoJanela(execCom(emMemoria()), { ...(await janela()), recuperar: true });
            assert.ok((rec.aplicados as string[]).includes(identidadeDoCaso('EMPRESA', a.id)), JSON.stringify(rec.aplicados));
            assert.notEqual(await digestB14(), b14, 'a recuperação gravou no domínio do B-14');
            assert.deepEqual(await retratoAvisos(), antes, `JANELA --recuperar, trava ${trava}`);
            const depois = await modos.modoJanela(execCom(emMemoria()), { ...(await janela()), recuperar: false });
            assert.ok(!(depois.pendentes as { identidade: string }[] ?? []).some((p) => p.identidade === identidadeDoCaso('EMPRESA', a.id)), 'conferência seguinte fecha o caso');
        }
        // RESTORE: EMPRESA (pagamento perdido) e EVENTO (PAYMENT_RECEIVED pendente).
        const b = await empresaAtiva();
        await avisoExistente(b.id);
        await pagamentoPerdido(b.sub);
        const ev = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomBytes(5).toString('hex')}`, tipo: 'PAYMENT_RECEIVED', criadoNoProvedor: null,
            assinaturaId: b.sub.id, cobrancaId: null, checkoutId: null, referenciaExterna: null }));
        antes = await retratoAvisos();
        const r = await restore(emMemoria(), b.id, ev.id);
        assert.ok(r.propostas.includes(identidadeDoCaso('EVENTO', ev.id)), `o caso EVENTO foi aplicado: ${JSON.stringify(r.rodadas)}`);
        console.log(`# B-23c §6 ${MODELO} trava=${trava}: rodadas ${JSON.stringify(r.rodadas)}; aplicados ${r.propostas.length}; fechados sem aplicar ${r.fechados.length}`);
        assert.equal((await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [b.id])).rows[0].situacao, 'ATIVA');
        assert.deepEqual(await retratoAvisos(), antes, `RESTORE, trava ${trava}`);
        // Aplicar o EVENTO reconcilia também o EMPRESA da mesma assinatura (execução 3): uma terceira empresa, só com o
        // pagamento perdido, cobre o aplicar-caso EMPRESA com a trava desligada.
        const c = await empresaAtiva();
        await avisoExistente(c.id);
        await pagamentoPerdido(c.sub);
        antes = await retratoAvisos();
        const rc = await restore(emMemoria(), c.id, null);
        assert.deepEqual(rc.propostas, [identidadeDoCaso('EMPRESA', c.id)], JSON.stringify(rc.rodadas));
        assert.deepEqual(await retratoAvisos(), antes, `RESTORE só EMPRESA, trava ${trava}`);
    });
});

test('B-23c §6: CONTROLE POSITIVO — trava LIGADA sem a guarda: com a 087 o caso sai APLICADO e assinatura_avisos muda; sem a 087 nada', { skip: !ativo() }, async () => {
    const { id, sub } = await empresaAtiva();
    await avisoExistente(id);
    await pagamentoPerdido(sub);
    const antes = await retratoAvisos();
    const r = await comTrava('ligado', () => restore(emMemoria(), id, null));
    assert.ok(r.aplicacoes.length >= 1);
    const depois = await retratoAvisos();
    if (M().com087) {
        assert.notEqual(depois.conteudo, antes.conteudo, 'o retrato independente enxerga o gancho');
        assert.ok(depois.linhas > antes.linhas, 'PAGAMENTO_CONFIRMADO criado pela sincronização do caso');
        const novos = (await q("SELECT tipo FROM assinatura_avisos WHERE empresa_id = $1 ORDER BY criado_em", [id])).rows.map((x) => x.tipo);
        assert.ok(novos.filter((t) => t === 'PAGAMENTO_CONFIRMADO').length >= 2, JSON.stringify(novos));
    }
    else assert.deepEqual(depois, antes, 'sem a 087: avisosInstalados = false, nada criado');
    // Registro do que o comparador do B-14 deixou passar (evidência do motivo da guarda).
    assert.ok(hashCanonico({ modelo: MODELO, antes, depois }).length === 64);
});
