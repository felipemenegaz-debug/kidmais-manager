import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { portaDescartavel } from '../comercial/alvo-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * B-9 — entrada agendada (scripts/assinatura-renovacao-cron.cjs → executarCron) contra o repositório REAL (074a/075) no
 * PostgreSQL DESCARTÁVEL, modelo 097. Asaas e e-mail FALSOS, com estado num arquivo: cada execução roda num PROCESSO FILHO,
 * o que permite SIGKILL de verdade no meio do envio e do PUT. Cobre: seleção global (elegíveis e inelegíveis) e interseção
 * com o filtro; simulação sem escrita; fluxo aviso → preço; Resend indisponível e resposta perdida; sobreposição; perda da
 * trava; interrupção entre empresas; queda abrupta (SIGKILL) durante envio e PUT, com retomada.
 */
const exigir = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const TRAVA = 'kidmais:renovacao-cron';
const DIA = 86400000;

let client: Client;
let usuario = '';
let seq = 0;
let dir = '';
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
function cnpj(n: number) {
    const base = `5${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
const docs = () => Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };

type Estado = { subs: Record<string, AssinaturaProvedor>; pagamentos: Record<string, CobrancaProvedor[]>; envios: string[]; puts: number; leituras: Record<string, number> };
const arquivoEstado = () => path.join(dir, 'provedor.json');
const lerEstado = (): Estado => JSON.parse(readFileSync(arquivoEstado(), 'utf8'));
const gravarEstado = (s: Estado) => writeFileSync(arquivoEstado(), JSON.stringify(s));

/** Empresa em teste com Gestão ativa; `fundador` confirma uma oferta Fundador pelo caminho do produto (sincronizarEmpresa). */
async function empresa(tipo: 'CONFIRMADA' | 'RESERVADA' | 'SEM_FUNDADOR') {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Renovação', 'PROVISIONAMENTO') RETURNING id", [`rn${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Renovação Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `rn${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    if (tipo === 'SEM_FUNDADOR') return id;
    await emTx(() => prepararOferta(client as never, id, usuario, { ...PEDIDO, documentos: docs() }, ENV));
    if (tipo === 'RESERVADA') return id;
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: hoje };
    const pay = { id: `pay_${k}`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(x: string) { return x === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(x: string) { return x === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === id ? [{ ...sub }] : []; },
    };
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    const r = await emTx(() => sincronizarEmpresa(client as never, id, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    const e = lerEstado(); e.subs[sub.id] = sub; e.pagamentos[sub.id] = [pay]; gravarEstado(e);
    return id;
}
const subDe = async (empresaId: string) => (await q('SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE empresa_id = $1', [empresaId])).rows[0].s as string;
const registro = async (empresaId: string) => (await q(`SELECT estado, primeira_data_regular::text AS pdr, aviso_enviado_em IS NOT NULL AS avisado,
    aviso_tentado_em IS NOT NULL AS tentado, ultimo_erro FROM assinatura_renovacoes WHERE empresa_id = $1`, [empresaId])).rows[0] ?? null;
const meioDia = (data: string, dias: number) => new Date(Date.parse(`${data}T15:00:00Z`) - dias * DIA).toISOString();

/** Processo filho com a entrada real. `etapa` pendura num ponto (ENVIO, PUT, PROCESSO) e avisa por stdout; `interromper` liga a interrupção. */
const FILHO = String.raw`
const fs = require('node:fs');
const pg = require(process.env.KM_PG);
const { executarCron } = require(process.env.KM_CRON);
(async () => {
  const { senhaRecusada } = await import(process.env.KM_ALVO);
  const arq = process.env.KM_ESTADO, etapa = process.env.KM_ETAPA || '';
  const st = () => JSON.parse(fs.readFileSync(arq, 'utf8')), salvar = (s) => fs.writeFileSync(arq, JSON.stringify(s));
  const pendurar = (marca) => { process.stdout.write(marca + '\n'); return new Promise(() => {}); };
  let interrompido = false, chamadas = 0;
  const esperarLiberacao = async () => { while (!fs.existsSync(arq + '.continuar')) await new Promise((r) => setTimeout(r, 50)); };
  const provedor = {
    obterAssinatura: async (id) => {
      { const s = st(); s.leituras[id] = (s.leituras[id] || 0) + 1; salvar(s); }
      chamadas++;
      if (etapa === 'PROCESSO' && chamadas === 1) { process.stdout.write('NO_PROCESSO\n'); await esperarLiberacao(); }
      if (etapa === 'INTERROMPER') interrompido = true;
      const s = st().subs[id]; return s ? { ...s } : null;
    },
    obterCobranca: async (id) => { for (const l of Object.values(st().pagamentos)) { const p = l.find((x) => x.id === id); if (p) return { ...p }; } return null; },
    listarCobrancasDaAssinatura: async (id) => { const s = st(); s.leituras[id] = (s.leituras[id] || 0) + 1; salvar(s); return s.pagamentos[id] ?? []; },
    atualizarValorAssinatura: async (id, v) => { const s = st(); s.subs[id].valorCentavos = v; s.puts++; salvar(s); if (etapa === 'PUT') return pendurar('NO_PUT'); if (etapa === 'PUT_PERDIDO') throw new Error('Resposta perdida depois do PUT.'); return { ...s.subs[id] }; },
    atualizarValorCobranca: async (p, v) => { const s = st(); const l = s.pagamentos[p.assinaturaId]; const x = l.find((y) => y.id === p.id); x.valorCentavos = v; salvar(s); return { ...x }; },
    suspenderGeracao: async () => { throw new Error('Suspensão proibida no modo agendado.'); },
  };
  const enviar = async (m) => {
    const s = st(); s.envios.push(m.idempotencia); salvar(s);
    if (etapa === 'ENVIO') return pendurar('NO_ENVIO');
    if (etapa === 'RESEND_FORA' || etapa === 'RESPOSTA_PERDIDA') throw new Error('Resend indisponível ou resposta perdida.');
    return { provedor: 'resend', idExterno: 'email_' + s.envios.length };
  };
  const cfg = JSON.parse(process.env.KM_CFG); if (cfg.agora) cfg.agora = new Date(cfg.agora);
  const conexao = { host: '127.0.0.1', port: Number(process.env.KM_PORTA), user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel', password: senhaRecusada };
  const r = await executarCron(cfg, { Pool: pg.Pool, Client: pg.Client, conexao, provedor, enviar, origem: 'https://kidmais.example', interrompido: () => interrompido });
  process.stdout.write('RELATORIO ' + JSON.stringify(r) + '\n');
})().catch((e) => { process.stdout.write('FALHA ' + (e && e.message) + '\n'); process.exitCode = 1; });
`;

type ItemRel = { empresaId: string; resultado: string; motivo: string | null; estadoEntrada: string; estadoSaida: string;
    precoRemoto: { assinatura: string; confirmado: boolean; estadoPersistido: string; parcelasDaRenovacao: { regulares: number; fundador: number } } | null };
type Rel = { execucao: string; codigo: number; processadas: number; resultados: Record<string, number>; alertas: ItemRel[]; emAndamento: ItemRel[]; avisosNaJanela: number };
function rodar(modo: 'simular' | 'aplicar', o: { empresas?: string[]; agora?: string; etapa?: string; matarEm?: string; aoVer?: [string, () => void] } = {}): Promise<Rel | 'MORTO'> {
    const cfg = { ambiente: 'staging', modo, rebaixado: false, alvo: { database: 'kidmais_pacotes_v1_descartavel', local: true }, empresas: o.empresas ?? null, agora: o.agora ?? null };
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', KM_PG: exigir.resolve('pg'), KM_CRON: path.join(raiz, 'scripts/assinatura-renovacao-cron.cjs'),
        KM_ALVO: new URL('../comercial/alvo-descartavel.ts', import.meta.url).href, KM_ESTADO: arquivoEstado(), KM_ETAPA: o.etapa ?? '',
        KM_CFG: JSON.stringify(cfg), KM_PORTA: String(portaDescartavel()), KIDMAIS_DESCARTAVEL_PORTA: String(portaDescartavel()),
        KIDMAIS_DESCARTAVEL_AUTORIZACAO: process.env.KIDMAIS_DESCARTAVEL_AUTORIZACAO ?? '', KIDMAIS_POSTGRES_DESCARTAVEL: 'kidmais_pacotes_v1_descartavel' };
    const arq = path.join(dir, `filho-${randomBytes(3).toString('hex')}.cjs`);
    writeFileSync(arq, FILHO);
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', arq], { env, cwd: raiz });
        let saida = '';
        p.stdout.on('data', (d: Buffer) => {
            saida += String(d);
            if (o.matarEm && saida.includes(o.matarEm)) { p.kill('SIGKILL'); }
            if (o.aoVer && saida.includes(o.aoVer[0])) { const acao = o.aoVer[1]; o.aoVer = undefined; acao(); }
        });
        p.stderr.on('data', () => undefined);
        p.on('error', reject);
        const limite = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`Filho excedeu 90 s: ${saida.slice(0, 300)}`)); }, 90_000);
        p.on('exit', () => {
            clearTimeout(limite);
            if (o.matarEm && saida.includes(o.matarEm)) return resolve('MORTO');
            const linha = saida.split('\n').find((l) => l.startsWith('RELATORIO '));
            if (!linha) return reject(new Error(`Filho sem relatório: ${saida.slice(0, 300)}`));
            resolve(JSON.parse(linha.slice('RELATORIO '.length)));
        });
    });
}
const relatorio = async (p: Promise<Rel | 'MORTO'>) => { const r = await p; assert.notEqual(r, 'MORTO'); return r as Rel; };
async function semTravaGlobal() {
    for (let i = 0; i < 100; i++) {
        const ok = (await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'kidmais-renovacao-cron%'")).rows[0].n === 0;
        if (ok) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('conexões do processo morto não foram encerradas');
}

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    dir = mkdtempSync(path.join(tmpdir(), 'kidmais-b9-'));
    gravarEstado({ subs: {}, pagamentos: {}, envios: [], puts: 0, leituras: {} });
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Renovação', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`rn${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => {
    if (client) await encerrarDescartavel(client);
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

let A = '', A2 = '', B = '', C = '';
test('1. seleção global (só Fundador confirmado), interseção com o filtro e simulação sem nenhuma escrita', { skip: !opt() }, async () => {
    A = await empresa('CONFIRMADA'); A2 = await empresa('CONFIRMADA'); B = await empresa('RESERVADA'); C = await empresa('SEM_FUNDADOR');
    const cancelada = await empresa('RESERVADA');
    await q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética cancelada' WHERE empresa_id = $1", [cancelada]);
    const sim = await relatorio(rodar('simular'));
    assert.deepEqual([sim.execucao, sim.codigo, sim.processadas, sim.resultados.AGUARDANDO_AVISO], ['CONCLUIDA', 0, 2, 2], 'só A e A2');
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_renovacoes')).rows[0].n, 0, 'simulação não grava');
    const filtro = await relatorio(rodar('simular', { empresas: [A, B, C, cancelada] }));
    assert.deepEqual([filtro.processadas, filtro.resultados.NAO_ELEGIVEL, filtro.codigo], [1, 3, 0], 'A processada; B, C e a cancelada fora da seleção');
});

test('2. fluxo aplicar: registro, janela −34/−33, aviso uma vez, última parcela, preço regular; sem revisão nem suspensão', { skip: !opt() }, async () => {
    const r1 = await relatorio(rodar('aplicar', { empresas: [A] }));
    assert.equal(r1.codigo, 0); const reg = await registro(A); assert.equal(reg.estado, 'PENDENTE');
    const pdr = reg.pdr as string;
    const sub = await subDe(A);
    let e = lerEstado(); e.subs[sub].nextDueDate = new Date(Date.parse(pdr) - 30 * DIA).toISOString().slice(0, 10); gravarEstado(e);
    assert.equal((await relatorio(rodar('aplicar', { empresas: [A], agora: meioDia(pdr, 34) }))).resultados.AGUARDANDO_AVISO, 1);
    assert.equal(lerEstado().envios.length, 0);
    const r3 = await relatorio(rodar('aplicar', { empresas: [A], agora: meioDia(pdr, 33) }));
    assert.deepEqual([r3.resultados.AGUARDANDO_ULTIMA_PARCELA, r3.codigo], [1, 0]);
    assert.deepEqual([(await registro(A)).estado, lerEstado().envios.length], ['AVISADA', 1]);
    const andamento = r3.emAndamento.find((i) => i.empresaId === A);
    assert.deepEqual([r3.alertas.length, andamento?.estadoSaida, andamento?.precoRemoto?.assinatura, andamento?.precoRemoto?.confirmado], [0, 'AVISADA', 'FUNDADOR', true],
        'P2-3: sem alerta, a releitura sai em emAndamento');
    e = lerEstado(); e.subs[sub].nextDueDate = pdr; e.pagamentos[sub].push({ ...e.pagamentos[sub][0], id: `ren_${sub}`, dueDate: pdr, status: 'PENDING', paymentDate: null }); gravarEstado(e);
    const r4 = await relatorio(rodar('aplicar', { empresas: [A], agora: meioDia(pdr, 1) }));
    assert.deepEqual([r4.resultados.REGULAR, r4.codigo], [1, 0]);
    e = lerEstado();
    assert.deepEqual([(await registro(A)).estado, e.subs[sub].valorCentavos, e.pagamentos[sub].find((p) => p.dueDate === pdr)?.valorCentavos, e.envios.length], ['REGULAR', 19700, 19700, 1]);
});

test('3. sobreposição: outra sessão com a trava → EXECUCAO_SOBREPOSTA, saída 0, nada processado', { skip: !opt() }, async () => {
    const outro = await conectarDescartavel({ travar: false });
    try {
        await outro.query('SELECT pg_advisory_lock(hashtext($1))', [TRAVA]);
        const r = await relatorio(rodar('simular'));
        assert.deepEqual([r.execucao, r.codigo, r.processadas], ['EXECUCAO_SOBREPOSTA', 0, 0]);
    } finally { await outro.end(); }
});

test('4. perda da conexão da trava no meio: nenhuma empresa nova, TRAVA_PERDIDA, saída 2', { skip: !opt() }, async () => {
    const liberar = arquivoEstado() + '.continuar';
    let r: Rel;
    // O filho para na primeira consulta ao provedor (marca NO_PROCESSO); só então a conexão da trava é derrubada.
    let derrubar: () => void = () => undefined;
    const pronto = new Promise<void>((ok) => { derrubar = ok; });
    const filho = rodar('aplicar', { etapa: 'PROCESSO', aoVer: ['NO_PROCESSO', () => derrubar()] });
    try {
        await Promise.race([pronto, new Promise((_ok, falha) => setTimeout(() => falha(new Error('NO_PROCESSO não apareceu')), 60_000))]);
        await q("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'kidmais-renovacao-cron-trava'");
    } finally { writeFileSync(liberar, '1'); }
    try { r = await relatorio(filho); } finally { rmSync(liberar, { force: true }); }
    assert.deepEqual([r.execucao, r.codigo, r.processadas], ['TRAVA_PERDIDA', 2, 1], 'A2 não foi iniciada');
    await semTravaGlobal();
});

test('5. interrupção entre empresas: termina a atual, não começa outra, libera a trava, saída 1', { skip: !opt() }, async () => {
    // Empresas novas, sem registro: a primeira consulta ao provedor liga a interrupção (registro PENDENTE fora da janela sai antes da rede).
    const X = await empresa('CONFIRMADA'), Y = await empresa('CONFIRMADA');
    const r = await relatorio(rodar('simular', { etapa: 'INTERROMPER', empresas: [X, Y] }));
    assert.deepEqual([r.execucao, r.codigo, r.processadas], ['INTERROMPIDA', 1, 1]);
    await semTravaGlobal();
});

test('6. Resend indisponível: ENVIO_INCERTO em AVISANDO (0 na primeira); repetida → intenção pendente (2); resposta perdida reenvia com a mesma chave', { skip: !opt() }, async () => {
    await relatorio(rodar('aplicar', { empresas: [A2] }));
    const pdr = (await registro(A2)).pdr as string;
    const antes = lerEstado().envios.length;
    const r1 = await relatorio(rodar('aplicar', { empresas: [A2], agora: meioDia(pdr, 33), etapa: 'RESEND_FORA' }));
    assert.deepEqual([r1.resultados.ENVIO_INCERTO, r1.codigo, (await registro(A2)).estado], [1, 0, 'AVISANDO']);
    const r2 = await relatorio(rodar('aplicar', { empresas: [A2], agora: meioDia(pdr, 33), etapa: 'RESPOSTA_PERDIDA' }));
    assert.deepEqual([r2.codigo, r2.alertas[0]?.motivo], [2, 'INTENCAO_PENDENTE_REPETIDA']);
    const sub = await subDe(A2); const e = lerEstado(); e.subs[sub].nextDueDate = new Date(Date.parse(pdr) - 30 * DIA).toISOString().slice(0, 10); gravarEstado(e);
    const r3 = await relatorio(rodar('aplicar', { empresas: [A2], agora: meioDia(pdr, 32) }));
    assert.deepEqual([r3.codigo, (await registro(A2)).estado], [0, 'AVISADA']);
    const envios = lerEstado().envios.slice(antes);
    assert.deepEqual([envios.length, new Set(envios).size], [3, 1], 'três tentativas, uma chave');
    assert.equal((await q("SELECT count(*)::int AS n FROM assinatura_renovacoes WHERE estado = 'REVISAO'")).rows[0].n, 0);
});

test('7. SIGKILL durante o envio e durante o PUT: trava cai com a conexão; retomada pela releitura, sem PUT repetido', { skip: !opt() }, async () => {
    const D = await empresa('CONFIRMADA');
    await relatorio(rodar('aplicar', { empresas: [D] }));
    const pdr = (await registro(D)).pdr as string; const sub = await subDe(D);
    let e = lerEstado(); e.subs[sub].nextDueDate = pdr; e.pagamentos[sub].push({ ...e.pagamentos[sub][0], id: `ren_${sub}`, dueDate: pdr, status: 'PENDING', paymentDate: null }); gravarEstado(e);
    assert.equal(await rodar('aplicar', { empresas: [D], agora: meioDia(pdr, 33), etapa: 'ENVIO', matarEm: 'NO_ENVIO' }), 'MORTO');
    await semTravaGlobal();
    assert.equal((await registro(D)).estado, 'AVISANDO', 'intenção persistida antes do envio');
    // Retomada: reenvio com a mesma chave; segue para o preço e morre no PUT.
    assert.equal(await rodar('aplicar', { empresas: [D], agora: meioDia(pdr, 33), etapa: 'PUT', matarEm: 'NO_PUT' }), 'MORTO');
    await semTravaGlobal();
    assert.equal((await registro(D)).estado, 'APLICANDO');
    const putsAntes = lerEstado().puts;
    const r = await relatorio(rodar('aplicar', { empresas: [D], agora: meioDia(pdr, 32) }));
    e = lerEstado();
    assert.deepEqual([r.resultados.REGULAR, (await registro(D)).estado, e.puts, e.pagamentos[sub].find((p) => p.dueDate === pdr)?.valorCentavos], [1, 'REGULAR', putsAntes, 19700],
        'releitura viu a assinatura já regular: nenhum PUT de assinatura repetido');
    const chaves = e.envios.filter((k) => k.includes('kidmais-renovacao/'));
    assert.ok(chaves.length >= 2 && new Set(chaves.slice(-2)).size === 1, 'mesma chave depois da queda');
});

test('8. P2-1: PUT com resposta perdida → ERRO_REPROCESSAVEL relido sob a trava (APLICANDO, assinatura REGULAR)', { skip: !opt() }, async () => {
    const G = await empresa('CONFIRMADA');
    await relatorio(rodar('aplicar', { empresas: [G] }));
    const pdr = (await registro(G)).pdr as string; const sub = await subDe(G);
    const e = lerEstado(); e.subs[sub].nextDueDate = pdr; e.pagamentos[sub].push({ ...e.pagamentos[sub][0], id: `ren_${sub}`, dueDate: pdr, status: 'PENDING', paymentDate: null }); gravarEstado(e);
    const r = await relatorio(rodar('aplicar', { empresas: [G], agora: meioDia(pdr, 33), etapa: 'PUT_PERDIDO' }));
    const a = r.alertas.find((i) => i.empresaId === G);
    assert.deepEqual([r.codigo, a?.resultado, a?.estadoSaida, a?.precoRemoto?.assinatura, a?.precoRemoto?.confirmado, a?.precoRemoto?.parcelasDaRenovacao.fundador],
        [2, 'ERRO_REPROCESSAVEL', 'APLICANDO', 'REGULAR', true, 1]);
    assert.equal((await registro(G)).estado, 'APLICANDO');
});

test('9. P2-2: registro já em REVISAO (com aviso enviado) não gera nenhuma leitura do provedor na execução agendada', { skip: !opt() }, async () => {
    const H = await empresa('CONFIRMADA');
    await relatorio(rodar('aplicar', { empresas: [H] }));
    const pdr = (await registro(H)).pdr as string; const sub = await subDe(H);
    let e = lerEstado(); e.subs[sub].nextDueDate = new Date(Date.parse(pdr) - 30 * DIA).toISOString().slice(0, 10); gravarEstado(e);
    await relatorio(rodar('aplicar', { empresas: [H], agora: meioDia(pdr, 33) }));
    assert.equal((await registro(H)).estado, 'AVISADA');
    // REVISAO gravada pela rotina SEM modo agendado (como faria a ferramenta restrita): próximo vencimento inválido.
    const { processarRenovacao } = await import('./renovacao-fundador.ts');
    const { repositorioRenovacao } = await import('./renovacao-repositorio.ts');
    e = lerEstado(); e.subs[sub].nextDueDate = 'invalida'; gravarEstado(e);
    const provedor = {
        obterAssinatura: async (id: string) => ({ ...lerEstado().subs[id] }),
        obterCobranca: async () => null, listarCobrancasDaAssinatura: async (id: string) => lerEstado().pagamentos[id] ?? [],
        atualizarValorAssinatura: async () => { throw new Error('não'); }, atualizarValorCobranca: async () => { throw new Error('não'); },
        suspenderGeracao: async (id: string) => ({ ...lerEstado().subs[id] }),
    };
    const resultado = await processarRenovacao(H, { repositorio: repositorioRenovacao((t) => emTx(() => t(client as never))), provedor: provedor as never,
        enviar: async () => { throw new Error('não'); }, origem: 'https://kidmais.example', agora: () => new Date(meioDia(pdr, 32)), simular: false, travar: async (_e, f) => f() });
    assert.equal(resultado, 'PROXIMO_VENCIMENTO_INVALIDO');
    assert.equal((await registro(H)).estado, 'REVISAO');
    const antes = lerEstado().leituras[sub] ?? 0;
    const r = await relatorio(rodar('aplicar', { empresas: [H], agora: meioDia(pdr, 31) }));
    const a = r.alertas.find((i) => i.empresaId === H);
    assert.deepEqual([a?.resultado, a?.precoRemoto, r.codigo], ['REVISAO_EXISTENTE', null, 2]);
    assert.equal(lerEstado().leituras[sub] ?? 0, antes, 'nenhuma leitura do provedor para o registro em REVISAO');
});

test('10. P3-T1: a conferência da trava usa a chave exata — perder a trava global com OUTRA trava de sessão ainda presa dá 0', { skip: !opt() }, async () => {
    const { SQL_TRAVA_MINHA, TRAVA_GLOBAL } = exigir(path.join(raiz, 'scripts/assinatura-renovacao-cron.cjs')) as { SQL_TRAVA_MINHA: string; TRAVA_GLOBAL: string };
    const sessao = await conectarDescartavel({ travar: false });
    const minha = async () => (await sessao.query(SQL_TRAVA_MINHA, [TRAVA_GLOBAL])).rows[0].n as number;
    try {
        // Chaves com hashtext positivo e negativo, para conferir a recomposição classid/objid nos dois sinais.
        const sinais = (await sessao.query("SELECT hashtext($1) AS a, hashtext('kidmais:outra-trava') AS b", [TRAVA_GLOBAL])).rows[0];
        await sessao.query("SELECT pg_advisory_lock(hashtext('kidmais:outra-trava'))");
        assert.equal(await minha(), 0, 'só a outra trava: não é a nossa');
        await sessao.query('SELECT pg_advisory_lock(hashtext($1))', [TRAVA_GLOBAL]);
        assert.equal(await minha(), 1, 'as duas presas: a nossa é reconhecida');
        await sessao.query('SELECT pg_advisory_unlock(hashtext($1))', [TRAVA_GLOBAL]);
        assert.equal(await minha(), 0, 'perdemos a nossa e a outra continua: 0 (uma contagem genérica daria 1)');
        // Chave de sinal oposto ao da nossa também é distinguida.
        const oposta = Number(sinais.a) < 0 ? 1 : -1;
        await sessao.query('SELECT pg_advisory_lock($1::bigint)', [oposta]);
        assert.equal(await minha(), 0);
    } finally {
        await sessao.query('SELECT pg_advisory_unlock_all()');
        await sessao.end();
    }
});
