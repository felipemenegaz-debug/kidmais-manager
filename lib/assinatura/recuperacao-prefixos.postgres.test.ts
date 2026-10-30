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
import { prefixoDoSchema } from './recuperacao-baseline.ts';
import { CODIGOS_ANTIGOS, EVENTOS_OBRIGATORIOS, marcadoresDoAmbiente, MODOS, modoAdmitido, type CodigoNoAr, type Modo } from './recuperacao-execucao.ts';
import { modoDrenagem, modoInventario, type Arquivos, type Execucao, type Resultado } from './recuperacao-modos.ts';
import { diferenca, TABELAS } from './recuperacao-efeitos.ts';
import { fotografar } from './recuperacao-fotografia.ts';
import { identidadeDoCaso } from './recuperacao-casos.ts';
import { hashCanonico } from './recuperacao-hash.ts';
import { iniciarTeste } from './servico.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { prepararOferta } from './ofertas.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';

import { registrarPedido } from './devolucao-registro.ts';
import { processarPedido, vincularCobrancaCriada, type ContextoProvedor } from '../creditos/pagamento.ts';
import { provedorSomenteLeitura } from './recuperacao-provedor.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * B-14 HB-3 (28/10/2026; plano rev. 8.1 §3.8, §11 item 2): matriz ramo × código × schema no PostgreSQL DESCARTÁVEL, em
 * CADA prefixo P0a…P11 da promoção e no PH exato do staging (P11 + 102/103/105). A mesma suíte roda em cada modelo
 * (KIDMAIS_POSTGRES_MODELO, posto pelo runner):
 *   1. o modelo É o prefixo esperado (migrations declaradas = conjunto do modelo; marcadores do sandbox batem);
 *   2. com o PACOTE ENTREGUE (a árvore mínima escrita num temporário fora do checkout, node_modules por junção), para cada
 *      código no ar (candidata, antigo) e cada modo: não admitido → 1 MODO_NAO_ADMITIDO antes de qualquer leitura de
 *      domínio; admitido → passa da porta (recusa só por motivo do próprio modo); nada gravado em nenhum caso;
 *   3. JANELA admitida (--conferir; --recuperar com a candidata) executa no schema do prefixo pelo pacote: código 0, nada
 *      gravado;
 *   4. RESTORE admitido: drenagem e inventário executam no schema do prefixo (sem créditos antes do P7), nada gravado.
 * Limite: o domínio está vazio (os casos com dados ficam na suíte de modos, em P11/PH); aqui se prova a compatibilidade de
 * cada caminho com o schema real de cada prefixo e a porta da matriz com o artefato que será entregue.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const MODELO = process.env.KIDMAIS_POSTGRES_MODELO ?? '';
const ESPERADO: Record<string, string> = {
    'b14-P0a': 'P0a', 'b14-P1': 'P1', 'b14-P2': 'P2', 'b14-P3': 'P3', 'b14-P4': 'P4', 'b14-P5': 'P5', 'b14-P6': 'P6', 'b14-P7': 'P7',
    'b14-P8': 'P8', 'b14-P9': 'P9', 'b14-P10': 'P10', 'b14-P11': 'P11', 'b14-PH-staging': 'PH',
};
const ativo = () => opt() && Object.hasOwn(ESPERADO, MODELO);
const BANCO = 'kidmais_pacotes_v1_descartavel';
const CAND = 'c'.repeat(40);
const COMMIT: Record<CodigoNoAr, string> = { CANDIDATA: CAND, ANTIGO: CODIGOS_ANTIGOS[1] }; // B-23: a base de production vigente (#274)
const URL_WEBHOOK = 'https://kidmais.example/api/integracoes/asaas/webhook';
const raiz = path.resolve(import.meta.dirname, '../..');
const requireCjs = createRequire(import.meta.url);

/**
 * Migrations além da 088 do modelo, pela MESMA regra e MESMA fonte da receita: o inventário aprovado de
 * `scripts/production/check-migrations.mjs` (não a pasta, que tem arquivos fora dele, como o `_999_` de down), `ate` e `sem`.
 */
async function declaradasDoModelo(nome: string): Promise<string[]> {
    const { MODELOS } = requireCjs('../../scripts/regressao-v1-postgres-receita.cjs') as { MODELOS: Record<string, { ate: string; sem: string[] }> };
    const m = MODELOS[nome];
    const inventario = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href) as { approvedFiles: readonly string[] };
    const numeros = [...inventario.approvedFiles].map((f) => f.split('_')[1]);
    const fim = numeros.indexOf(m.ate);
    assert.ok(fim >= 0, `checkpoint ${m.ate}`);
    return [...new Set(numeros.slice(0, fim + 1).filter((n) => !m.sem.includes(n) && /^\d{3}$/.test(n) && Number.parseInt(n, 10) > 88))].sort();
}

/** Asaas falso da suíte: começa vazio (domínio vazio nos primeiros testes); o teste com dados o povoa. Escrita proibida. */
const subs = new Map<string, AssinaturaProvedor>();
const daAssinatura = new Map<string, CobrancaProvedor[]>();
const avulsas = new Map<string, CobrancaProvedor>();
const WEBHOOK_OK = { id: 'wh_1', url: URL_WEBHOOK, enabled: true, interrupted: false, sendType: 'SEQUENTIALLY', events: [...EVENTOS_OBRIGATORIOS] };
let webhooks: (typeof WEBHOOK_OK)[] = [WEBHOOK_OK];
const cliente = {
    async obterAssinatura(id: string) { const x = subs.get(id); return x ? { ...x } : null; },
    async listarCobrancasDaAssinatura(id: string) { return (daAssinatura.get(id) ?? []).map((p) => ({ ...p })); },
    async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((x) => x.externalReference === ref).map((x) => ({ ...x })); },
    async obterCobranca(id: string) { const c = avulsas.get(id); return c ? { ...c, estornos: [...(c.estornos ?? [])] } : null; },
    async listarCobrancasPorReferencia(ref: string) { return [...avulsas.values()].filter((c) => c.externalReference === ref).map((c) => ({ ...c })); },
    async listarCobrancas() { const itens = [...avulsas.values(), ...[...daAssinatura.values()].flat()].map((c) => ({ ...c })); return { itens, totalCount: itens.length }; },
    async listarWebhooks() { return { itens: webhooks.map((w) => ({ ...w })), totalCount: webhooks.length }; },
    async removerAssinatura() { throw new Error('escrita no provedor proibida'); },
};

let client: Client;
let declaradas: string[] = [];
let indice = -1;
let pacote = '';
let pasta = '';
let cli: { main: (argv: string[], env: Record<string, string>, sair: (c: number) => void, deps: { cliente: unknown }) => Promise<void> };
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
const agoraIso = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS t")).rows[0].t as string;

/** Digest de todas as linhas das tabelas da lista fechada (as presentes neste prefixo): prova de que nada foi gravado. */
async function digest() {
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
    // O pacote entregue: a árvore mínima escrita FORA do checkout, como a ENTREGA-1..N a grava no serviço.
    const { arvore } = requireCjs('../../scripts/arvore-recuperacao-b14.cjs') as { arvore: (r: string) => { arquivos: { arquivo: string; conteudo: Buffer }[] } };
    pacote = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-pacote-'));
    for (const x of arvore(raiz).arquivos) {
        fs.mkdirSync(path.dirname(path.join(pacote, x.arquivo)), { recursive: true });
        fs.writeFileSync(path.join(pacote, x.arquivo), x.conteudo);
    }
    fs.symlinkSync(path.join(raiz, 'node_modules'), path.join(pacote, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    cli = requireCjs(path.join(pacote, 'scripts/recuperacao-pagamentos-producao.cjs'));
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-prefixo-evid-'));
});
test.after(async () => {
    if (client) await encerrarDescartavel(client);
    if (pacote) { fs.unlinkSync(path.join(pacote, 'node_modules')); fs.rmSync(pacote, { recursive: true, force: true }); }
    if (pasta) fs.rmSync(pasta, { recursive: true, force: true });
});

const ambienteCli = (codigo: CodigoNoAr): Record<string, string> => {
    const porta = process.env.KIDMAIS_DESCARTAVEL_PORTA!;
    return { DATABASE_URL: `postgresql://kidmais_descartavel@127.0.0.1:${porta}/${BANCO}`, KIDMAIS_B14_ALVO: `${BANCO}@127.0.0.1:${porta}`, KIDMAIS_B14_DESCARTAVEL: BANCO,
        ASAAS_AMBIENTE: 'sandbox', RENDER_GIT_COMMIT: COMMIT[codigo] };
};
async function rodar(argv: string[], codigo: CodigoNoAr) {
    const saidas: string[] = [];
    const log = console.log;
    let c: number | null = null;
    console.log = (s: string) => saidas.push(s);
    try { await cli.main([...argv, `--saida=${pasta}`], ambienteCli(codigo), (x: number) => { c = x; }, { cliente }); }
    finally { console.log = log; }
    return { codigo: c, r: JSON.parse(saidas.at(-1)!) as Record<string, unknown> };
}
/** Argumentos válidos por modo. Os do RESTORE apontam para arquivos inexistentes (ou contenção depois do reinício): passada a porta, o modo recusa por motivo próprio. */
async function argumentos(modo: Exclude<Modo, 'fila'>) {
    const agora = await agoraIso();
    const desde = new Date(Date.parse(agora) - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const reinicio = new Date(Date.parse(agora) - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const comuns = [`--migracoes=${declaradas.length ? declaradas.join(',') : 'nenhuma'}`, `--candidata=${CAND}`];
    const sha = 'a'.repeat(64), u = randomUUID();
    const r: Record<Exclude<Modo, 'fila'>, string[]> = {
        'janela-conferir': ['--janela', '--conferir', `--desde=${desde}`, `--ate=${agora}`],
        'janela-recuperar': ['--janela', '--recuperar', `--desde=${desde}`, `--ate=${agora}`, `--backup=export-inexistente-${u}.json`],
        'restore-drenagem': ['--restore', '--drenagem', `--reinicio=${reinicio}`, `--contencao-desde=${agora}`],
        'restore-inventario': ['--restore', '--inventario', `--desde=${desde}`, `--reinicio=${reinicio}`, `--drenagem=drenagem-${u}.json`],
        'restore-aplicar': ['--restore', `--aplicar-caso=${sha}`, `--proposta=${sha}`, `--casos=casos-${u}.json`, `--backup=export-inexistente-${u}.json`, `--restaurado-em=${reinicio}`],
        'restore-conferir': ['--restore', `--conferir-caso=${sha}`, `--proposta=${sha}`, `--casos=casos-${u}.json`, `--execucao=${u}`],
        'restore-liberacao': ['--restore', '--liberacao', `--desde=${desde}`, `--reinicio=${reinicio}`, `--drenagem=drenagem-${u}.json`, `--decisoes=decisoes-${u}.json`, `--url-webhook=${URL_WEBHOOK}`],
    };
    return [...r[modo], ...comuns];
}

test('o modelo é o prefixo esperado; marcadores do sandbox batem com as migrations declaradas', { skip: !ativo() }, async () => {
    const schema = prefixoDoSchema(declaradas, 'sandbox');
    assert.equal(schema?.nome, ESPERADO[MODELO], `${MODELO}: ${declaradas.join(',')}`);
    if (schema!.nome === 'PH') assert.equal(prefixoDoSchema(declaradas, 'producao'), null, 'PH nunca em production');
    else assert.equal(prefixoDoSchema(declaradas, 'producao')?.nome, schema!.nome, 'prefixo da promoção vale igual em production');
    const presentes: string[] = [];
    for (const [m, o] of Object.entries(marcadoresDoAmbiente('sandbox'))) {
        const sql = o.tipo === 'tabela' ? "SELECT to_regclass('public.' || $1) IS NOT NULL AS ok"
            : "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS ok";
        if ((await q(sql, [o.nome])).rows[0].ok) presentes.push(m);
    }
    assert.deepEqual(presentes.sort(), declaradas.filter((m) => Object.hasOwn(marcadoresDoAmbiente('sandbox'), m)).sort(), 'o modelo tem exatamente os marcadores declarados');
});

test('matriz §3.8 com o pacote entregue: não admitido → 1 MODO_NAO_ADMITIDO; admitido passa da porta; nada gravado', { skip: !ativo() }, async () => {
    const antes = await digest();
    const vistos: string[] = [];
    for (const codigo of ['CANDIDATA', 'ANTIGO'] as const) {
        for (const modo of MODOS.filter((m): m is Exclude<Modo, 'fila'> => m !== 'fila')) {
            const { codigo: c, r } = await rodar(await argumentos(modo), codigo);
            const admitido = modoAdmitido(indice, codigo, modo);
            if (!admitido) assert.deepEqual([c, r.motivo], [1, 'MODO_NAO_ADMITIDO'], `${codigo} ${modo}`);
            else {
                assert.ok(!['MODO_NAO_ADMITIDO', 'SCHEMA_FORA_DA_LISTA', 'CODIGO_NO_AR_DESCONHECIDO', 'MIGRACOES_DIVERGENTES', 'ALVO', 'ERRO_INTERNO'].includes(String(r.motivo)),
                    `${codigo} ${modo}: ${JSON.stringify(r)}`);
                vistos.push(`${codigo}:${modo}`);
            }
        }
    }
    assert.equal(await digest(), antes, 'nenhuma combinação grava');
    // Oráculo da matriz: P0a/P1 admitem conferir com o antigo; P2–P3 só RESTORE com o antigo; P4+ JANELA com a candidata.
    if (indice <= 1) assert.ok(vistos.includes('ANTIGO:janela-conferir') && !vistos.includes('CANDIDATA:janela-conferir'));
    if (indice >= 2 && indice <= 3) assert.ok(vistos.includes('ANTIGO:restore-inventario') && !vistos.some((v) => v.includes('janela')));
    if (indice >= 4) assert.ok(vistos.includes('CANDIDATA:janela-recuperar'));
    if (indice >= 5) assert.ok(!vistos.some((v) => v.startsWith('ANTIGO:')), 'código antigo depois de 090/094: nada além de --fila');
});

test('JANELA admitida executa no schema do prefixo pelo pacote: código 0, nada gravado', { skip: !ativo() }, async () => {
    const codigos = (['CANDIDATA', 'ANTIGO'] as const).filter((c) => modoAdmitido(indice, c, 'janela-conferir'));
    assert.ok(codigos.length > 0 || (indice >= 2 && indice <= 3), 'só P2/P3 ficam sem JANELA');
    const antes = await digest();
    for (const codigo of codigos) {
        const { codigo: c, r } = await rodar(await argumentos('janela-conferir'), codigo);
        assert.deepEqual([c, r.modo, r.resultado], [0, 'JANELA_CONFERIR', 'CONCLUIDA'], `${codigo}: ${JSON.stringify(r)}`);
        assert.equal(r.schema, ESPERADO[MODELO]);
    }
    if (modoAdmitido(indice, 'CANDIDATA', 'janela-recuperar')) {
        const backup = `export-${randomBytes(6).toString('hex')}.json`;
        fs.writeFileSync(path.join(pasta, backup), JSON.stringify({ banco: BANCO, sha256: 'b'.repeat(64), validado: true, concluido_em: new Date().toISOString() }), { mode: 0o600 });
        const args = (await argumentos('janela-recuperar')).map((a) => (a.startsWith('--backup=') ? `--backup=${backup}` : a));
        const { codigo: c, r } = await rodar(args, 'CANDIDATA');
        assert.deepEqual([c, r.modo, r.resultado], [0, 'JANELA_RECUPERAR', 'CONCLUIDA'], JSON.stringify(r));
    }
    assert.equal(await digest(), antes, 'domínio vazio: nada a gravar');
});

test('RESTORE admitido: drenagem e inventário executam no schema do prefixo; nada gravado', { skip: !ativo() }, async () => {
    const mapa = new Map<string, unknown>();
    const arquivos: Arquivos = {
        ler: (n) => (mapa.has(n) ? JSON.parse(JSON.stringify(mapa.get(n))) : null),
        gravarNovo: (n, c) => { if (mapa.has(n)) throw new Error('EEXIST'); mapa.set(n, JSON.parse(JSON.stringify(c))); },
        invalidar: (n) => { mapa.set(`${n}.invalidada`, mapa.get(n)); mapa.delete(n); },
        listar: (p) => [...mapa.keys()].filter((k) => k.startsWith(p) && k.endsWith('.json')).sort(),
    };
    const creditos = (await q("SELECT to_regclass('public.ia_credito_pedidos') IS NOT NULL AS ok")).rows[0].ok as boolean;
    assert.equal(creditos, indice >= 7, 'créditos só a partir do P7');
    const antes = await digest();
    for (const codigo of (['CANDIDATA', 'ANTIGO'] as const).filter((c) => modoAdmitido(indice, c, 'restore-inventario'))) {
        const x: Execucao = { client: client as never, cliente: cliente as never, execucao: randomUUID(), ambiente: 'sandbox', creditos: creditos ? { ambiente: 'sandbox', conta: 'padrao' } : null,
            controle: { parar: async () => null }, arquivos, migracoes: declaradas, codigoNoAr: codigo };
        const reinicio = await agoraIso();
        const dren = await modoDrenagem(x, { reinicio, contencaoDesde: new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
        assert.deepEqual([dren.codigo, dren.resultado], [2, 'PASS'], `${codigo}: ${JSON.stringify(dren)}`);
        const inv = await modoInventario({ ...x, execucao: randomUUID() }, { desde: new Date(Date.parse(reinicio) - 86_400_000).toISOString(), ate: await agoraIso(),
            drenagem: `drenagem-${dren.execucao}.json`, reinicio });
        assert.equal(inv.modo, 'RESTORE_INVENTARIO');
        assert.equal(inv.schema, ESPERADO[MODELO]);
        assert.ok([0, 2].includes(inv.codigo), `${codigo}: ${JSON.stringify(inv)}`);
    }
    assert.equal(await digest(), antes, 'RESTORE de leitura não grava');
});

/**
 * Revisão do HB-3 (P2): contraexemplos da §11 COM DADOS, em cada prefixo, para cada código admitido no RESTORE, e a
 * JANELA admitida com dados. Empresa ATIVA cujo cancelamento no provedor se perdeu localmente ("decisão perdida": a
 * proposta tem as recusas da §4); desde o P1, também um pedido de encerramento local (ENCERRAMENTO_089_097); desde o P7,
 * um crédito pago no provedor e perdido localmente. Cadeia: drenagem → inventário (nada gravado) → T1/T2 (mudança no
 * provedor entre o inventário e a aplicação → DIVERGENTE, nada gravado) → aplicação com os EFEITOS EXATOS da proposta
 * (fotografia antes/depois) → COMMIT incerto resolvido pelo conferir-caso (APLICADO pela execução da aplicação; outra
 * execução → DIVERGENTE) → liberação (com o código antigo, só com a prova do cron 7ce0916f).
 */
let usuario = '';
let seq = 0;
const hojeBr = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
function cnpj(n: number) {
    const base = `5${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let t = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { t += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = t % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try { const r = await acao(); await q('COMMIT'); return r; }
    catch (error) { await q('ROLLBACK'); throw error; }
}
const somenteLeitura = provedorSomenteLeitura(cliente as never);
/** Empresa ATIVA pelo pagamento da 1ª cobrança (sem a oferta Fundador), pelo caminho do produto no schema deste prefixo. */
async function empresaAtiva() {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Prefixo', 'PROVISIONAMENTO') RETURNING id", [`pf${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Prefixo Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `pf${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    const dia = await hojeBr();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: dia };
    subs.set(sub.id, sub);
    daAssinatura.set(sub.id, [{ id: `pay_${k}`, status: 'RECEIVED', dueDate: dia, paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    await emTx(() => sincronizarEmpresa(client as never, id, { provedor: somenteLeitura as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal((await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].situacao, 'ATIVA');
    return { id, sub };
}
/** Pedido de créditos WALLE com cobrança canônica vinculada (pago no provedor, perdido localmente). Só com a 095. */
async function creditoPerdido(empresaId: string, clienteId: string) {
    const pedidoId = randomUUID();
    const dia = await hojeBr();
    const letras = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
    const protocolo = `KM-${dia.replaceAll('-', '')}-${Array.from(randomBytes(8), (b) => letras[b % letras.length]).join('')}`;
    await q(`INSERT INTO ia_credito_pedidos (id, empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256, quantidade,
            preco_centavos, validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
        VALUES ($1, $2, $3, 'WALLE', 'CATALOGO-B14', 'WALLE_1000', '{}'::jsonb, 'creditos-ia-20261022.demo', $4, 1000, 9900, 90, 'PIX', 'sandbox', $5, $4,
            'CRIACAO_EM_CURSO', $6, $7::date)`, [pedidoId, empresaId, protocolo, 'a'.repeat(64), randomUUID(), usuario, dia]);
    const pagamento: CobrancaProvedor = { id: `pay_${randomBytes(5).toString('hex')}`, status: 'PENDING', dueDate: dia, paymentDate: null, invoiceUrl: null, deleted: false,
        valorCentavos: 9900, clienteId, billingType: 'PIX', externalReference: `km:sandbox:creditos:${pedidoId}`, assinaturaId: null };
    avulsas.set(pagamento.id, pagamento);
    const ctx: ContextoProvedor = { provedor: somenteLeitura as never, ambiente: 'sandbox', conta: 'padrao' };
    await emTx(() => vincularCobrancaCriada(client as never, pedidoId, ctx, pagamento));
    avulsas.set(pagamento.id, { ...pagamento, status: 'RECEIVED', paymentDate: dia });
    return pedidoId;
}

type Modos = typeof import('./recuperacao-modos.ts');
let modosPacote: Modos | null = null;
/** Revisão do HB-3 r2 (P2): os modos do PACOTE ENTREGUE (a árvore escrita fora do checkout), não os do checkout. */
async function modosDoPacote(): Promise<Modos> {
    modosPacote ??= await import(pathToFileURL(path.join(pacote, 'lib/assinatura/recuperacao-modos.ts')).href) as Modos;
    return modosPacote;
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
function decidirCom(arquivos: Arquivos, inv: Resultado, escolha: (identidade: string) => 'APLICAR' | 'NENHUMA') {
    const arquivo = arquivos.ler(`casos-${inv.execucao}.json`) as { casos: { identidade: string; hash: string | null }[]; orfas: { identidade: string }[] };
    const nome = `decisoes-${randomBytes(4).toString('hex')}.json`;
    arquivos.gravarNovo(nome, { formato: 2, inventario: inv.execucao, digestInventario: hashCanonico(arquivo), coberturaAceita: false, retencaoAceita: false,
        casos: Object.fromEntries(arquivo.casos.map((c) => [c.identidade, { decisao: escolha(c.identidade), proposta: c.hash }])),
        orfas: Object.fromEntries(arquivo.orfas.map((o) => [o.identidade, 'ACEITA'])) });
    return nome;
}
/** Cliente cuja resposta do COMMIT se perde. `gravou`: o servidor confirmou antes da perda (true) ou desfez (false). */
function commitSemResposta(gravou: boolean): Client {
    return new Proxy(client, {
        get(alvo, chave) {
            if (chave === 'query') return async (sql: unknown, params?: unknown[]) => {
                if (typeof sql === 'string' && /^\s*COMMIT\s*$/i.test(sql)) { await alvo.query(gravou ? 'COMMIT' : 'ROLLBACK'); throw new Error('resposta do COMMIT perdida'); }
                return alvo.query(sql as string, params);
            };
            const v = (alvo as unknown as Record<string | symbol, unknown>)[chave];
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
        },
    });
}
const execCom = (arquivos: Arquivos, codigo: CodigoNoAr, creditos: boolean, extra: Partial<Execucao> = {}): Execucao => ({ client: client as never, cliente: cliente as never,
    execucao: randomUUID(), ambiente: 'sandbox', creditos: creditos ? { ambiente: 'sandbox', conta: 'padrao' } : null, controle: { parar: async () => null }, arquivos,
    migracoes: declaradas, codigoNoAr: codigo, ...extra });
/** Revisão do HB-3 r3 (P2): efeitos COMPLETOS — tabela, chave, operação, antes e depois de cada coluna, inclusive a auditoria. */
const efeitosCompletos = (e: unknown[]) => (e as object[]).map((x) => hashCanonico(JSON.parse(JSON.stringify(x)))).sort();
/**
 * Efeitos GRAVADOS por uma aplicação = os da proposta + exatamente UM comprovante transacional da própria aplicação (auditoria
 * RECUPERACAO_B14_CASO_APLICADO, que não faz parte da proposta). Devolve os demais, para comparar com a proposta.
 */
function semComprovante(gravados: { tabela: string; colunas: Record<string, { depois: unknown }> }[], identidade: string) {
    const comprovantes = gravados.filter((x) => x.tabela === 'auditoria' && x.colunas.acao?.depois === 'RECUPERACAO_B14_CASO_APLICADO');
    assert.equal(comprovantes.length, 1, 'um comprovante da aplicação');
    assert.equal(JSON.parse(String(comprovantes[0].colunas.dados_depois?.depois ?? '{}')).caso, identidade);
    return gravados.filter((x) => !comprovantes.includes(x));
}
const garantirUsuario = async () => {
    if (usuario) return;
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Prefixo', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`pf${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
};

test('RESTORE com dados em cada prefixo, pelo PACOTE: decisão perdida, T1/T2, COMMIT sem resposta (gravou/não gravou), efeitos exatos, invalidação após Tf, liberação; JANELA com dados', { skip: !ativo() }, async () => {
    const M = await modosDoPacote();
    await garantirUsuario();
    const creditos = indice >= 7;
    for (const codigo of (['ANTIGO', 'CANDIDATA'] as const).filter((c) => modoAdmitido(indice, c, 'restore-inventario'))) {
        const arquivos = emMemoria();
        const ex = (extra: Partial<Execucao> = {}) => execCom(arquivos, codigo, creditos, extra);
        // Estado restaurado: empresa ATIVA local; no provedor, a assinatura foi cancelada (decisão perdida no restore).
        const { id, sub } = await empresaAtiva();
        if (indice >= 1) await emTx(() => registrarPedido(client as never, { empresaId: id, tipo: 'CANCELAMENTO_FIM_PERIODO', chave: randomUUID(), solicitadoPor: usuario,
            motivo: null, ciclo: 'MENSAL', situacaoAnterior: 'ATIVA', provedorAssinaturaId: sub.id, cancelamentoProvedor: 'CONFIRMADO' }));
        subs.set(sub.id, { ...sub, status: 'INACTIVE' });
        const pedidoId = creditos ? await creditoPerdido(id, sub.customer!) : null;

        const reinicio = await agoraIso();
        const dren = await M.modoDrenagem(ex(), { reinicio, contencaoDesde: new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
        const drenagem = `drenagem-${dren.execucao}.json`;
        const desde = new Date(Date.parse(reinicio) - 86_400_000).toISOString();
        const inventariar = () => M.modoInventario(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio });
        let antes = await digest();
        let inv = await inventariar();
        assert.equal(await digest(), antes, `${codigo}: inventário não grava`);
        assert.equal(inv.schema, ESPERADO[MODELO]);
        const casoEmpresa = identidadeDoCaso('EMPRESA', id);
        const daEmpresa = (inv.casos as { identidade: string; classe: string; recusas: string[] }[]).find((c) => c.identidade === casoEmpresa)!;
        assert.equal(daEmpresa?.classe, 'PROPOSTA');
        for (const r of ['QUEDA_SITUACAO', 'DATA_DO_INSTANTE', ...(indice >= 1 ? ['ENCERRAMENTO_089_097'] : [])])
            assert.ok(daEmpresa.recusas.includes(r), `${codigo}: recusa ${r} em ${daEmpresa.recusas.join(',')}`);
        const casoCredito = pedidoId ? identidadeDoCaso('PEDIDO', pedidoId) : null;
        if (casoCredito) assert.equal((inv.casos as { identidade: string; classe: string }[]).find((c) => c.identidade === casoCredito)?.classe, 'PROPOSTA');
        const proposta = (identidade: string) => (arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string; proposta: { efeitos: unknown[] } }[] })
            .casos.find((c) => c.identidade === identidade)!;

        // T1/T2: o provedor muda entre o inventário e a aplicação (assinatura removida) → DIVERGENTE, nada gravado.
        subs.set(sub.id, { ...sub, status: 'INACTIVE', deleted: true });
        antes = await digest();
        const t2 = await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa, proposta: proposta(casoEmpresa).hash });
        assert.deepEqual([t2.codigo, t2.resultado, await digest() === antes], [1, 'DIVERGENTE', true], `${codigo}: T2`);
        subs.set(sub.id, { ...sub, status: 'INACTIVE' });

        // Mudança SÓ operacional entre T1 e T2 (uma auditoria nova da empresa, sem efeito comercial) → DIVERGENTE (1), nada
        // gravado; a proposta caducou: INVENTARIO novo.
        await q(`INSERT INTO auditoria (acao, entidade_tipo, entidade_id, ator_tipo, dados_depois, origem) VALUES ('B14_TESTE_OPERACIONAL', 'EMPRESA_ASSINATURA', $1, 'SISTEMA', '{}'::jsonb, 'SISTEMA')`, [id]);
        antes = await digest();
        const operacional = await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa, proposta: proposta(casoEmpresa).hash });
        assert.deepEqual([operacional.codigo, operacional.resultado, await digest() === antes], [1, 'DIVERGENTE', true], `${codigo}: mudança só operacional`);
        inv = await inventariar();
        // "Nenhuma ação" num caso com efeito: com a candidata, a liberação BLOQUEIA (COM_EFEITO_NORMAL); com o código antigo,
        // vale a prova do cron antigo (exceção expressa) e a falta dela bloqueia.
        const nenhuma = await M.modoLiberacao(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio, decisoes: decidirCom(arquivos, inv, () => 'NENHUMA'), urlWebhook: URL_WEBHOOK,
            provaCron: null });
        assert.equal(nenhuma.resultado, 'BLOQUEADA', JSON.stringify(nenhuma));
        assert.ok((nenhuma.bloqueios as string[]).includes(codigo === 'CANDIDATA' ? 'COM_EFEITO_NORMAL' : 'SEM_PROVA_DO_CRON_ANTIGO:AUSENTE'), JSON.stringify(nenhuma.bloqueios));

        // COMMIT sem resposta, servidor DESFEZ: a aplicação recusa (COMMIT_INDETERMINADO) e o conferir-caso dá NAO_APLICADO.
        const e1 = randomUUID();
        await assert.rejects(M.modoAplicarCaso(ex({ client: commitSemResposta(false) as never, execucao: e1 }), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa,
            proposta: proposta(casoEmpresa).hash }), /COMMIT_INDETERMINADO/);
        assert.equal(await digest(), antes, `${codigo}: desfeito`);
        assert.equal((await M.modoConferirCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa, proposta: proposta(casoEmpresa).hash, execucaoDaAplicacao: e1 })).resultado,
            'NAO_APLICADO', `${codigo}: COMMIT perdido sem gravar`);

        // COMMIT sem resposta, servidor GRAVOU: recusa igual; o conferir-caso dá APLICADO; efeitos EXATOS da proposta.
        const e2 = randomUUID();
        const fotoAntes = await fotografar(client as never, { empresaId: id });
        await assert.rejects(M.modoAplicarCaso(ex({ client: commitSemResposta(true) as never, execucao: e2 }), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa,
            proposta: proposta(casoEmpresa).hash }), /COMMIT_INDETERMINADO/);
        assert.deepEqual(efeitosCompletos(semComprovante(diferenca(fotoAntes, await fotografar(client as never, { empresaId: id })) as never, casoEmpresa)), efeitosCompletos(proposta(casoEmpresa).proposta.efeitos),
            `${codigo}: efeitos exatos`);
        assert.equal((await M.modoConferirCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa, proposta: proposta(casoEmpresa).hash, execucaoDaAplicacao: e2 })).resultado,
            'APLICADO', `${codigo}: COMMIT perdido depois de gravar`);
        assert.equal((await M.modoConferirCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoEmpresa, proposta: proposta(casoEmpresa).hash, execucaoDaAplicacao: randomUUID() })).resultado,
            'DIVERGENTE');

        if (casoCredito) {
            // Mesma empresa: a proposta do crédito do inventário anterior caducou (DIVERGENTE); INVENTARIO novo.
            antes = await digest();
            assert.equal((await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoCredito, proposta: proposta(casoCredito).hash })).resultado, 'DIVERGENTE');
            assert.equal(await digest(), antes);
            inv = await inventariar();
            // Liberação ANTES de aplicar o crédito: bloqueada (efeito pendente), mas registrada (Tf).
            const lib0 = await M.modoLiberacao(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio, decisoes: decidirCom(arquivos, inv, () => 'APLICAR'), urlWebhook: URL_WEBHOOK,
                provaCron: null });
            assert.equal(lib0.resultado, 'BLOQUEADA');
            assert.equal(arquivos.listar('liberacao-').length, 1);
            // Invalidação após Tf: a aplicação invalida a liberação registrada antes do COMMIT.
            const fotoC = await fotografar(client as never, { empresaId: id });
            const ap = await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: casoCredito, proposta: proposta(casoCredito).hash });
            assert.deepEqual([ap.codigo, ap.resultado], [2, 'APLICADO']);
            assert.equal(arquivos.listar('liberacao-').length, 0, `${codigo}: liberação invalidada pela aplicação após Tf`);
            assert.deepEqual(efeitosCompletos(semComprovante(diferenca(fotoC, await fotografar(client as never, { empresaId: id })) as never, casoCredito)), efeitosCompletos(proposta(casoCredito).proposta.efeitos),
                `${codigo}: efeitos exatos do crédito`);
        }

        // Liberação: casos decididos; com o código antigo, só com a prova do cron antigo (exceção expressa).
        let prova: string | null = null;
        if (codigo === 'ANTIGO') {
            prova = `prova-cron-${randomBytes(4).toString('hex')}.json`;
            arquivos.gravarNovo(prova, { artefato: '7ce0916f', concluida: true, codigo: 0, relatorio: { divergente: false, incompleto: false, kidmais: { violada: false } } });
        }
        antes = await digest();
        const lib = await M.modoLiberacao(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio, decisoes: decidirCom(arquivos, inv, () => 'APLICAR'), urlWebhook: URL_WEBHOOK,
            provaCron: prova });
        assert.equal(await digest(), antes, `${codigo}: liberação não grava`);
        assert.equal(lib.resultado, 'LIBERADA', `${codigo}: ${JSON.stringify(lib)}`);
    }

    // JANELA com dados onde é admitida.
    for (const codigo of (['ANTIGO', 'CANDIDATA'] as const).filter((c) => modoAdmitido(indice, c, 'janela-conferir'))) {
        const ex = () => execCom(emMemoria(), codigo, creditos);
        const { id, sub } = await empresaAtiva();
        subs.set(sub.id, { ...sub, status: 'INACTIVE' });
        const desde = new Date(Date.now() - 86_400_000).toISOString();
        const antes = await digest();
        const conf = await M.modoJanela(ex(), { desde, ate: new Date().toISOString(), recuperar: false });
        assert.equal(await digest(), antes, `${codigo}: --conferir não grava`);
        assert.equal(conf.codigo, 2, `${codigo}: ${JSON.stringify(conf)}`);
        if (modoAdmitido(indice, codigo, 'janela-recuperar')) {
            const rec = await M.modoJanela(ex(), { desde, ate: new Date().toISOString(), recuperar: true });
            assert.ok((rec.aplicados as string[]).includes(identidadeDoCaso('EMPRESA', id)), JSON.stringify(rec));
            assert.equal((await M.modoJanela(ex(), { desde, ate: new Date().toISOString(), recuperar: false })).codigo, 0);
        }
    }
});

/** Fixture histórica: desliga os gatilhos SÓ na transação da fixture para pôr datas no passado (o 095 fixa creditado_em). */
async function noPassado(sql: string, params: unknown[]) {
    await emTx(async () => { await q('SET LOCAL session_replication_role = replica'); await q(sql, params); });
}
async function empresaComOfertaFundadorPerdida() {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Fundador', 'PROVISIONAMENTO') RETURNING id", [`ff${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Fundador Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `ff${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    const docs = Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
    await emTx(() => prepararOferta(client as never, id, usuario, { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20', documentos: docs },
        { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' }));
    // Restore: a reserva da vaga Fundador se perdeu (LIBERADA) enquanto o provedor já recebeu a 1ª cobrança da oferta.
    await noPassado("UPDATE assinatura_fundadores SET estado = 'LIBERADA', liberada_em = clock_timestamp(), evidencia_liberacao = 'restore: reserva perdida (fixture B-14)' WHERE empresa_id = $1", [id]);
    const dia = await hojeBr();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: dia };
    subs.set(sub.id, sub);
    daAssinatura.set(sub.id, [{ id: `pay_${k}`, status: 'RECEIVED', dueDate: dia, paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820, assinaturaId: sub.id,
        clienteId: sub.customer, billingType: 'PIX' }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    return id;
}

test('liberação em cada prefixo e código, pelo PACOTE: crédito correto não bloqueia × estorno não tratado bloqueia (desde o P7); fila recusada bloqueia; interrompida libera com as três exigências', { skip: !ativo() }, async () => {
    const M = await modosDoPacote();
    await garantirUsuario();
    const creditos = indice >= 7;
    const ctxNormal: ContextoProvedor = { provedor: somenteLeitura as never, ambiente: 'sandbox', conta: 'padrao' };
    for (const codigo of (['ANTIGO', 'CANDIDATA'] as const).filter((c) => modoAdmitido(indice, c, 'restore-liberacao'))) {
        const arquivos = emMemoria();
        const ex = () => execCom(arquivos, codigo, creditos);
        let correto: string | null = null, incorreto: string | null = null;
        if (creditos) {
            const pagamentoDe = (pedido: string) => [...avulsas.values()].find((c) => c.externalReference === `km:sandbox:creditos:${pedido}`)!;
            // Crédito CORRETO (creditado e igual no provedor) e crédito com ESTORNO não tratado (o provedor tem um parcial novo).
            const f = await empresaAtiva();
            correto = await creditoPerdido(f.id, f.sub.customer!);
            await emTx(() => processarPedido(client as never, correto!, ctxNormal));
            const g = await empresaAtiva();
            incorreto = await creditoPerdido(g.id, g.sub.customer!);
            await emTx(() => processarPedido(client as never, incorreto!, ctxNormal));
            avulsas.set(pagamentoDe(incorreto).id, { ...pagamentoDe(incorreto), estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
        }
        const reinicio = await agoraIso();
        const dren = await M.modoDrenagem(ex(), { reinicio, contencaoDesde: new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
        const drenagem = `drenagem-${dren.execucao}.json`;
        const desde = new Date(Date.parse(reinicio) - 86_400_000).toISOString();
        let inv = await M.modoInventario(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio });
        const casos = inv.casos as { identidade: string; classe: string }[];
        if (correto) assert.equal(casos.find((c) => c.identidade === identidadeDoCaso('PEDIDO', correto!))?.classe, 'RECONCILIADA', `${codigo}: crédito correto`);
        if (incorreto) assert.equal(casos.find((c) => c.identidade === identidadeDoCaso('PEDIDO', incorreto!))?.classe, 'PROPOSTA', `${codigo}: estorno não tratado`);
        const prova = () => {
            if (codigo !== 'ANTIGO') return null;
            const nome = `prova-cron-${randomBytes(4).toString('hex')}.json`;
            arquivos.gravarNovo(nome, { artefato: '7ce0916f', concluida: true, codigo: 0, relatorio: { divergente: false, incompleto: false, kidmais: { violada: false } } });
            return nome;
        };
        const liberar = () => M.modoLiberacao(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio, decisoes: decidirCom(arquivos, inv, () => 'NENHUMA'), urlWebhook: URL_WEBHOOK,
            provaCron: prova() });
        if (incorreto && codigo === 'CANDIDATA') {
            // O estorno não tratado tem efeito: "nenhuma ação" bloqueia; aplicado, o caso some e a liberação passa.
            const bloq = await liberar();
            assert.deepEqual([bloq.resultado, (bloq.bloqueios as string[]).includes('COM_EFEITO_NORMAL')], ['BLOQUEADA', true], JSON.stringify(bloq));
            const ap = (arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string }[] }).casos.find((c) => c.identidade === identidadeDoCaso('PEDIDO', incorreto!))!;
            assert.equal((await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: ap.identidade, proposta: ap.hash })).resultado, 'APLICADO');
            inv = await M.modoInventario(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio });
        }
        if (incorreto && codigo === 'ANTIGO') {
            // Com o código antigo vale a prova do cron (exceção expressa); o caso aplicado deixa o banco coerente para a candidata.
            const ap = (arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string }[] }).casos.find((c) => c.identidade === identidadeDoCaso('PEDIDO', incorreto!))!;
            assert.equal((await M.modoAplicarCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: ap.identidade, proposta: ap.hash })).resultado, 'APLICADO');
            inv = await M.modoInventario(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio });
        }
        // Fila: OK → liberada sem exigências; interrompida (o resto certo) → liberada COM as três exigências pós-reabertura;
        // desabilitada, sem webhook ou com evento faltando → bloqueada.
        try {
            const ok = await liberar();
            assert.deepEqual([ok.resultado, ok.exigenciasPosReabertura], ['LIBERADA', []], `${codigo}: ${JSON.stringify(ok)}`);
            webhooks = [{ ...WEBHOOK_OK, interrupted: true }];
            const interrompida = await liberar();
            assert.deepEqual([interrompida.resultado, interrompida.exigenciasPosReabertura], ['LIBERADA', ['REATIVAR_FILA', 'NOVA_LEITURA_FILA_CODIGO_0', 'CONFIRMAR_ENTREGA']],
                JSON.stringify(interrompida));
            for (const recusada of [[{ ...WEBHOOK_OK, enabled: false }], [], [{ ...WEBHOOK_OK, events: EVENTOS_OBRIGATORIOS.slice(1) }], [{ ...WEBHOOK_OK, interrupted: true, enabled: false }]]) {
                webhooks = recusada as (typeof WEBHOOK_OK)[];
                const r = await liberar();
                assert.equal(r.resultado, 'BLOQUEADA', `${codigo}: fila ${JSON.stringify(recusada)} → ${JSON.stringify(r)}`);
                assert.ok((r.bloqueios as string[]).some((b) => b.startsWith('FILA:')), JSON.stringify(r.bloqueios));
            }
        }
        finally { webhooks = [WEBHOOK_OK]; }
    }
});

test('contraexemplos da §11 em cada prefixo e CADA código admitido, pelo PACOTE: período local maior, Fundador perdido; desde o P7, devolução perdida, estorno > 90 dias, crédito vencido (aplicado, efeitos completos), parcial × disputa (aplicado, efeitos completos), COMMIT sem resposta no crédito, CRIACAO_INCERTA sem vínculo e cobrança extra', { skip: !ativo() }, async () => {
    const M = await modosDoPacote();
    await garantirUsuario();
    const creditos = indice >= 7;
    const dia = await hojeBr();
    const diasAtras = (n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const ctxNormal: ContextoProvedor = { provedor: somenteLeitura as never, ambiente: 'sandbox', conta: 'padrao' };
    for (const codigo of (['ANTIGO', 'CANDIDATA'] as const).filter((c) => modoAdmitido(indice, c, 'restore-inventario'))) {
        const arquivos = emMemoria();
        const ex = (extra: Partial<Execucao> = {}) => execCom(arquivos, codigo, creditos, extra);
        const esperados: [string, string][] = [];
        const aplicar: { identidade: string; empresaId: string; commitSemResposta?: boolean; depois?: () => Promise<void> }[] = [];

        // Período local maior que o calculado pela última cobrança paga.
        const a = await empresaAtiva();
        await q("UPDATE empresa_assinaturas SET periodo_atual_fim = clock_timestamp() + interval '200 days' WHERE empresa_id = $1", [a.id]);
        esperados.push([identidadeDoCaso('EMPRESA', a.id), 'PERIODO_LOCAL_MAIOR']);
        // Oferta/Fundador perdido: a vaga liberada no restore e a oferta paga no provedor.
        esperados.push([identidadeDoCaso('EMPRESA', await empresaComOfertaFundadorPerdida()), 'OFERTA_FUNDADOR']);

        if (creditos) {
            const b = await empresaAtiva();
            const pagamentoDe = (pedido: string) => [...avulsas.values()].find((c) => c.externalReference === `km:sandbox:creditos:${pedido}`)!;
            // Devolução perdida: crédito creditado, estornado pelo provedor (devolução nossa perdida no restore).
            const p1 = await creditoPerdido(b.id, b.sub.customer!);
            await emTx(() => processarPedido(client as never, p1, ctxNormal));
            avulsas.set(pagamentoDe(p1).id, { ...pagamentoDe(p1), status: 'REFUNDED' });
            esperados.push([identidadeDoCaso('PEDIDO', p1), 'ESTORNO_CHARGEBACK']);
            // Estorno > 90 dias sem evento: o mesmo, com o crédito de 100 dias atrás (o cron só relê os creditados de 90 dias).
            const p2 = await creditoPerdido(b.id, b.sub.customer!);
            await emTx(() => processarPedido(client as never, p2, ctxNormal));
            await noPassado("UPDATE ia_credito_pedidos SET creditado_em = creditado_em - interval '100 days', criado_em = criado_em - interval '100 days' WHERE id = $1", [p2]);
            avulsas.set(pagamentoDe(p2).id, { ...pagamentoDe(p2), status: 'REFUNDED', dueDate: diasAtras(100), paymentDate: diasAtras(100) });
            esperados.push([identidadeDoCaso('PEDIDO', p2), 'ESTORNO_CHARGEBACK']);
            // Pedido CRIACAO_INCERTA sem cobrança vinculada; a cobrança existe no provedor pela referência.
            const p4 = randomUUID();
            await q(`INSERT INTO ia_credito_pedidos (id, empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256, quantidade,
                    preco_centavos, validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
                VALUES ($1, $2, $3, 'WALLE', 'CATALOGO-B14', 'WALLE_1000', '{}'::jsonb, 'creditos-ia-20261022.demo', $4, 1000, 9900, 90, 'PIX', 'sandbox', $5, $4,
                    'CRIACAO_EM_CURSO', $6, $7::date)`, [p4, b.id, `KM-${dia.replaceAll('-', '')}-${Array.from(randomBytes(8), (x) => 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[x % 32]).join('')}`, 'a'.repeat(64), randomUUID(), usuario, dia]);
            await q("UPDATE ia_credito_pedidos SET estado = 'CRIACAO_INCERTA' WHERE id = $1", [p4]);
            avulsas.set(`pay_${p4.slice(0, 8)}`, { id: `pay_${p4.slice(0, 8)}`, status: 'PENDING', dueDate: dia, paymentDate: null, invoiceUrl: null, deleted: false, valorCentavos: 9900,
                clienteId: b.sub.customer, billingType: 'PIX', externalReference: `km:sandbox:creditos:${p4}`, assinaturaId: null });
            esperados.push([identidadeDoCaso('PEDIDO', p4), '']);
            // Cobrança extra (não canônica) paga: pagamento duplicado, decisão da pessoa.
            const extra = `pay_${randomBytes(5).toString('hex')}`;
            avulsas.set(extra, { ...pagamentoDe(p1), id: extra, status: 'RECEIVED', dueDate: dia, paymentDate: dia });
            const cobrancaId = (await q(`INSERT INTO ia_credito_cobrancas (empresa_id, pedido_id, provedor, ambiente, conta, pagamento_id, referencia_externa, canonica, valor_centavos,
                    forma_provedor, situacao_provedor, url_fatura, vencimento) VALUES ($1, $2, 'ASAAS', 'sandbox', 'padrao', $3, $4, false, 9900, 'PIX', 'PENDING', NULL, $5::date) RETURNING id`,
                [b.id, p1, extra, `km:sandbox:creditos:${p1}`, dia])).rows[0].id as string;
            esperados.push([identidadeDoCaso('COBRANCA', cobrancaId), 'SERVICO:PAGAMENTO_DUPLICADO']);

            // Casos APLICADOS com efeitos completos, cada um numa empresa própria (a pré-condição é a fotografia da empresa).
            // Crédito vencido: pago há 100 dias no provedor e perdido localmente → a proposta é a REVISAO (nunca crédito).
            const c = await empresaAtiva();
            const p3 = await creditoPerdido(c.id, c.sub.customer!);
            avulsas.set(pagamentoDe(p3).id, { ...pagamentoDe(p3), status: 'RECEIVED', dueDate: diasAtras(100), paymentDate: diasAtras(100) });
            esperados.push([identidadeDoCaso('PEDIDO', p3), 'SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO']);
            aplicar.push({ identidade: identidadeDoCaso('PEDIDO', p3), empresaId: c.id, depois: async () => {
                assert.deepEqual(Object.values((await q('SELECT estado, revisao_motivo FROM ia_credito_pedidos WHERE id = $1', [p3])).rows[0]), ['REVISAO', 'CREDITO_VENCIDO_NA_RECUPERACAO']);
                assert.equal(Number((await q('SELECT count(*) AS n FROM ia_credito_lotes WHERE pedido_id = $1', [p3])).rows[0].n), 0, 'vencido: nenhum lote');
            } });
            // Parcial × disputa no restore: o banco restaurado tem a disputa ABERTA; o provedor já voltou a pago com parcial.
            const d = await empresaAtiva();
            const p5 = await creditoPerdido(d.id, d.sub.customer!);
            await emTx(() => processarPedido(client as never, p5, ctxNormal));
            avulsas.set(pagamentoDe(p5).id, { ...pagamentoDe(p5), status: 'CHARGEBACK_REQUESTED' });
            await emTx(() => processarPedido(client as never, p5, ctxNormal));
            avulsas.set(pagamentoDe(p5).id, { ...pagamentoDe(p5), status: 'RECEIVED', estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
            esperados.push([identidadeDoCaso('PEDIDO', p5), 'ESTORNO_CHARGEBACK']);
            aplicar.push({ identidade: identidadeDoCaso('PEDIDO', p5), empresaId: d.id, depois: async () => {
                assert.deepEqual(Object.values((await q('SELECT disputa, retencao_motivo FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [p5])).rows[0]),
                    ['FAVORAVEL', 'ESTORNO_EXTERNO_PARCIAL']);
                const l = (await q('SELECT disponivel, bloqueado FROM ia_credito_lotes WHERE pedido_id = $1', [p5])).rows[0];
                assert.deepEqual([Number(l.disponivel), Number(l.bloqueado)], [0, 1000], 'D-HML-5: a favorável não desfaz a retenção');
            } });
            // COMMIT sem resposta no caso de CRÉDITO (servidor gravou): COMMIT_INDETERMINADO → conferir APLICADO.
            const e = await empresaAtiva();
            const p6 = await creditoPerdido(e.id, e.sub.customer!);
            aplicar.push({ identidade: identidadeDoCaso('PEDIDO', p6), empresaId: e.id, commitSemResposta: true });
        }

        const reinicio = await agoraIso();
        const dren = await M.modoDrenagem(ex(), { reinicio, contencaoDesde: new Date(Date.parse(reinicio) - 3_600_000).toISOString(), amostras: 2, intervaloMs: 0, esperar: async () => undefined });
        const drenagem = `drenagem-${dren.execucao}.json`;
        const desde = new Date(Date.parse(reinicio) - 86_400_000).toISOString();
        const antes = await digest();
        const inv = await M.modoInventario(ex(), { desde, ate: new Date().toISOString(), drenagem, reinicio });
        assert.equal(await digest(), antes, `${codigo}: inventário não grava`);
        const casos = inv.casos as { identidade: string; classe: string; recusas: string[] }[];
        for (const [identidade, recusa] of esperados) {
            const c = casos.find((x) => x.identidade === identidade);
            assert.ok(c, `${MODELO} ${codigo}: caso ${recusa || 'CRIACAO_INCERTA'} encontrado`);
            assert.notEqual(c!.classe, 'RECONCILIADA', `${MODELO} ${codigo}: ${recusa}`);
            if (recusa) assert.ok(c!.recusas.includes(recusa), `${MODELO} ${codigo}: ${recusa} em ${c!.recusas.join(',')}`);
        }
        // Aplicação com efeitos COMPLETOS (tabela, chave, operação, antes e depois, inclusive auditoria).
        for (const alvo of aplicar) {
            const proposta = (arquivos.ler(inv.arquivoDeCasos as string) as { casos: { identidade: string; hash: string; proposta: { efeitos: unknown[] } }[] }).casos.find((x) => x.identidade === alvo.identidade)!;
            const fotoAntes = await fotografar(client as never, { empresaId: alvo.empresaId });
            const execucao = randomUUID();
            if (alvo.commitSemResposta) {
                await assert.rejects(M.modoAplicarCaso(ex({ client: commitSemResposta(true) as never, execucao }), { casos: inv.arquivoDeCasos as string, identidade: alvo.identidade,
                    proposta: proposta.hash }), /COMMIT_INDETERMINADO/);
                assert.equal((await M.modoConferirCaso(ex(), { casos: inv.arquivoDeCasos as string, identidade: alvo.identidade, proposta: proposta.hash, execucaoDaAplicacao: execucao })).resultado,
                    'APLICADO', `${codigo}: COMMIT sem resposta no crédito`);
            }
            else {
                const r = await M.modoAplicarCaso(ex({ execucao }), { casos: inv.arquivoDeCasos as string, identidade: alvo.identidade, proposta: proposta.hash });
                assert.deepEqual([r.codigo, r.resultado], [2, 'APLICADO'], `${codigo} ${alvo.identidade}: ${JSON.stringify(r)}`);
            }
            assert.deepEqual(efeitosCompletos(semComprovante(diferenca(fotoAntes, await fotografar(client as never, { empresaId: alvo.empresaId })) as never, alvo.identidade)), efeitosCompletos(proposta.proposta.efeitos),
                `${codigo} ${alvo.identidade}: efeitos completos`);
            await alvo.depois?.();
        }
    }
});

test('linha de base S0 → S2 com dados: base selada no P0a com o código antigo, migrations na ordem do runbook, conferência no P10 com a candidata', { skip: !ativo() || MODELO !== 'b14-P0a' }, async () => {
    const M = await modosDoPacote();
    await garantirUsuario();
    const arquivos = emMemoria();
    await empresaAtiva();
    const desde = new Date(Date.now() - 86_400_000).toISOString();
    const e0 = await M.modoJanela(execCom(arquivos, 'ANTIGO', false), { desde, ate: new Date().toISOString(), recuperar: false, selar: 'base-e0.json' });
    assert.equal(e0.schema, 'P0a');
    const sha = e0.baseSelada as string;
    assert.match(String(sha), /^[0-9a-f]{64}$/, JSON.stringify(e0));
    // Promoção até a S2 sem 091 (P10), na ordem do runbook, no mesmo banco, com os dados.
    const { aplicarMigracoes } = requireCjs('../../scripts/regressao-v1-postgres-receita.cjs') as { aplicarMigracoes: (c: unknown, n: string[]) => Promise<void> };
    const s2 = ['089', '092', '093', '099', '090', '094', '095', '096', '097', '100'];
    await aplicarMigracoes(client, s2);
    const conf = await M.modoJanela(execCom(arquivos, 'CANDIDATA', true, { migracoes: [...s2].sort() }), { desde, ate: new Date().toISOString(), recuperar: false, base: { nome: 'base-e0.json', sha } });
    assert.equal(conf.schema, 'P10');
    const pendentes = (r: Resultado) => (r.pendentes as { identidade: string }[]).map((x) => x.identidade).sort();
    assert.deepEqual([(conf.base as { valida: boolean; agravados: unknown[] }).valida, (conf.base as { agravados: unknown[] }).agravados], [true, []], JSON.stringify(conf.base));
    // A pendência que já estava na E0 (de um teste anterior da suíte) e não piorou é tolerada pela base (§3.5): código 0.
    assert.ok(pendentes(e0).length > 0, 'a E0 tinha pendência preexistente');
    assert.deepEqual([conf.codigo, pendentes(conf)], [0, []], JSON.stringify(conf));
});
