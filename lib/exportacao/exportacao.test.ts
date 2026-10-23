import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { celula, csv } from '../assinatura/csv.ts';
import { crc32, escreverZip, lerZip } from './zip.ts';
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO } from './entidades.ts';
import { BLOCO_PDF_BYTES, expressoes, gerarPacote, Gravador, limparSobras, naoClassificadas, planejarColunas, PREFIXO_TEMPORARIO, type Manifesto } from './pacote.ts';
import { exportacoesEmAndamento, exportarPacoteCompleto, MAXIMO_SIMULTANEAS } from './servico.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const pasta = () => mkdtempSync(join(tmpdir(), 'kidmais-teste-exportacao-'));

test('ZIP em arquivo: CRC-32 de referência e incremental, ida e volta com nomes UTF-8, deflate e armazenado, adulteração recusada', async () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('56789'), crc32(Buffer.from('1234'))), 0xcbf43926, 'incremental');
    const dir = pasta();
    try {
        const grande = Buffer.from('linha;repetida\r\n'.repeat(50_000));
        const itens = [
            { caminho: 'MANIFESTO.json', conteudo: Buffer.from('{}'), armazenar: false },
            { caminho: 'dados/clientes/aniversários.csv', conteudo: grande, armazenar: false },
            { caminho: 'arquivos/contratos/x.pdf', conteudo: Buffer.from('%PDF-1.4 teste'), armazenar: true },
        ];
        const entradas = itens.map((x, i) => { const arquivo = join(dir, `${i}.tmp`); writeFileSync(arquivo, x.conteudo); return { caminho: x.caminho, arquivo, bytes: x.conteudo.length, crc: crc32(x.conteudo), armazenar: x.armazenar }; });
        const destino = join(dir, 'p.zip');
        const tamanho = await escreverZip(entradas, destino, new Date('2026-10-21T12:34:56Z'));
        const zip = readFileSync(destino);
        assert.equal(zip.length, tamanho);
        const lido = lerZip(zip);
        assert.deepEqual([...lido.keys()], itens.map((x) => x.caminho));
        for (const x of itens) assert.ok(lido.get(x.caminho)!.equals(x.conteudo), x.caminho);
        assert.ok(zip.length < grande.length / 10, 'conteúdo repetitivo comprimido em fluxo');
        const adulterado = Buffer.from(zip);
        adulterado[zip.indexOf('%PDF')] ^= 0xff; // conteúdo armazenado do PDF
        assert.throws(() => lerZip(adulterado), /CRC|inválido/);
        const ruim = { ...entradas[0], bytes: entradas[0].bytes + 1 };
        await assert.rejects(escreverZip([ruim], join(dir, 'r.zip'), new Date()), /tamanho divergente/);
        for (const c of ['/abs', '../fora', 'a//b', 'a\\b', ''])
            await assert.rejects(escreverZip([{ ...entradas[0], caminho: c }], join(dir, 'r.zip'), new Date()), /caminho inválido/);
        await assert.rejects(escreverZip([entradas[0], entradas[0]], join(dir, 'r.zip'), new Date()), /repetido/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('CSV: neutralização de fórmula (inclusive após espaços e em largura total) só onde pedido; número negativo fica número', () => {
    assert.equal(celula('-12.50', false), '-12.50');
    assert.equal(celula('-12.50'), "'-12.50");
    const arquivo = csv(['texto', 'valor'], [['=1+1', '-3']], [true, false]);
    assert.equal(arquivo, "\uFEFFtexto;valor\r\n'=1+1;-3\r\n");
    assert.equal(csv(['a'], [['+55']]), "\uFEFFa\r\n'+55\r\n", 'padrão continua neutralizando tudo');
    for (const perigosa of [' =1+1', '\t=1', '  @SUM(A1)', '＝1+1', '＋55', '－1', '＠SUM(A1)', '\u3000=1', '\r=1'])
        assert.ok(celula(perigosa).replace(/^"/, '').startsWith("'"), JSON.stringify(perigosa));
    for (const normal of ['Ana', ' Ana', 'a=b', '1-2', 'e-mail@x'])
        assert.ok(!celula(normal).replace(/^"/, '').startsWith("'"), JSON.stringify(normal));
});

test('inventário: arquivos e tabelas únicos, filtro sempre pela empresa ($1), subconsultas qualificadas, nada sem decisão', () => {
    const arquivos = ENTIDADES.map((e) => e.arquivo);
    const tabelas = ENTIDADES.map((e) => e.tabela);
    assert.equal(new Set(arquivos).size, arquivos.length);
    assert.equal(new Set(tabelas).size, tabelas.length, 'uma tabela, um arquivo');
    for (const e of ENTIDADES) {
        assert.match(e.onde, /\$1::uuid/, e.tabela);
        assert.match(e.onde, /^t\./, `${e.tabela}: condição sobre o alias t`);
        // Toda coluna citada na condição tem alias: `empresa_id` solto cairia na tabela de fora numa subconsulta. Exceção:
        // a associação perfil ↔ empresa, que é a mesma constante de lib/perfil/autorizacao.ts (colunas da própria empresas).
        if (!e.onde.includes('JOIN LATERAL')) assert.doesNotMatch(e.onde, /(?<![.\w])(empresa_id|id|cliente_id|fechamento_id|contrato_id|pagamento_id)\b(?!\s*\()/, `${e.tabela}: coluna sem alias`);
        assert.doesNotMatch(e.onde, /\b(INSERT|UPDATE|DELETE|;)\b/i);
        assert.ok(!Object.hasOwn(FORA_DO_ESCOPO, e.tabela), `${e.tabela} não pode estar dentro e fora`);
        assert.ok(e.arquivo.split('/').length === 2 && /^[a-z_]+\/[a-z_]+$/.test(e.arquivo), e.arquivo);
    }
    for (const [tabela, motivo] of Object.entries(FORA_DO_ESCOPO)) assert.ok(motivo.length > 10, `${tabela}: motivo`);
    for (const t of ['sessoes_administrativas', 'recuperacoes_senha', 'limites_autenticacao', 'cadastros_publicos', 'auditoria']) assert.ok(Object.hasOwn(FORA_DO_ESCOPO, t), t);
    assert.deepEqual(ENTIDADES.find((e) => e.tabela === 'usuarios_administrativos')?.somente, ['id', 'nome', 'email', 'cargo', 'ativo', 'criado_em']);
    assert.ok(ENTIDADES.find((e) => e.tabela === 'contrato_assinaturas')?.excluir?.sessao_id, 'P3-1: sessao_id fora');
});

/**
 * P2-3 — independente de modelo de banco: toda tabela criada pelas migrations do repositório (menos as removidas por
 * migration posterior; arquivos *_down.sql não contam) tem decisão no inventário, e o inventário não cita tabela que
 * não existe. Migration nova com tabela (ex.: a 089) faz este teste falhar até alguém classificar.
 */
export function tabelasDasMigrations(dir = 'database/migrations') {
    const tabelas = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.endsWith('_down.sql')).sort()) {
        const sql = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
        for (const m of sql.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi)) tabelas.set(m[1].toLowerCase(), f);
        for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi)) tabelas.delete(m[1].toLowerCase());
        for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s+RENAME\s+TO\s+"?([a-z_0-9]+)"?/gi)) {
            const origem = tabelas.get(m[1].toLowerCase());
            if (origem) { tabelas.delete(m[1].toLowerCase()); tabelas.set(m[2].toLowerCase(), f); }
        }
    }
    return tabelas;
}

test('inventário × migrations do repositório: nenhuma tabela sem classificação, nenhuma classificação órfã', () => {
    const criadas = tabelasDasMigrations();
    assert.ok(criadas.size >= 174, `migrations lidas: ${criadas.size}`);
    const semDecisao = naoClassificadas(criadas.keys()).map((t) => `${t} (${criadas.get(t)})`);
    assert.deepEqual(semDecisao, [], 'tabela nova precisa entrar em ENTIDADES ou em FORA_DO_ESCOPO (com motivo) — lib/exportacao/entidades.ts');
    const orfas = [...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)].filter((t) => !criadas.has(t));
    assert.deepEqual(orfas, [], 'inventário cita tabela que nenhuma migration cria');
    // O próprio leitor reconhece CREATE/DROP/RENAME (sem isso o teste acima poderia passar vazio).
    const dir = pasta();
    try {
        writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE public.nova_x (id int);\nCREATE TABLE IF NOT EXISTS velha (id int);\n-- CREATE TABLE comentada (id int);');
        writeFileSync(join(dir, '002_b.sql'), 'DROP TABLE IF EXISTS velha;\nALTER TABLE nova_x RENAME TO nova_y;');
        writeFileSync(join(dir, '003_c_down.sql'), 'CREATE TABLE ignorada (id int);');
        assert.deepEqual([...tabelasDasMigrations(dir).keys()], ['nova_y']);
        assert.deepEqual(naoClassificadas(['clientes', 'nova_y', 'auditoria']), ['nova_y']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('colunas: segredos fora (declarados e pelo padrão), lista de permissão, bytea vira tamanho + SHA-256 (+ arquivo)', () => {
    const usuarios = ENTIDADES.find((e) => e.tabela === 'usuarios_administrativos')!;
    const u = planejarColunas(usuarios, [{ nome: 'id', tipo: 'uuid' }, { nome: 'email', tipo: 'text' }, { nome: 'senha_hash', tipo: 'text' }, { nome: 'papel', tipo: 'text' }]);
    assert.deepEqual(u.exportadas.map((c) => c.nome), ['id', 'email']);
    assert.deepEqual(u.excluidas.map((c) => c.coluna), ['senha_hash', 'papel']);
    const convites = ENTIDADES.find((e) => e.tabela === 'convites')!;
    const cv = planejarColunas(convites, [{ nome: 'id', tipo: 'uuid' }, { nome: 'publico_token', tipo: 'text' }, { nome: 'editor_hash', tipo: 'text' }, { nome: 'credencial_nova', tipo: 'text' }]);
    assert.deepEqual(cv.exportadas.map((c) => c.nome), ['id']);
    assert.match(cv.excluidas.find((x) => x.coluna === 'credencial_nova')!.motivo, /padrão/);
    for (const nome of ['senha_hash', 'token_hash', 'token', 'publico_token', 'csrf_hash', 'credencial_cifrada', 'posse_token', 'token_verificacao', 'state_hash', 'codigo_hash', 'token_prova_hash'])
        assert.match(nome, SEGREDO, nome);
    for (const nome of ['pdf_hash', 'snapshot_hash', 'token_expira_em', 'nome', 'chave_idempotencia']) assert.doesNotMatch(nome, SEGREDO, nome);
    const docs = ENTIDADES.find((e) => e.tabela === 'contrato_documentos')!;
    const ex = expressoes(docs, [{ nome: 'id', tipo: 'uuid' }, { nome: 'conteudo_pdf', tipo: 'bytea' }, { nome: 'categoria', tipo: 'text' }, { nome: 'tamanho_bytes', tipo: 'integer' }]);
    assert.deepEqual(ex.cabecalho, ['id', 'conteudo_pdf__bytes', 'conteudo_pdf__sha256', 'conteudo_pdf__arquivo', 'categoria', 'tamanho_bytes']);
    assert.deepEqual(ex.neutralizar, [false, false, false, false, true, false]);
    assert.ok(ex.sel.every((s) => !/\bt\."conteudo_pdf"::text/.test(s)), 'bytes nunca vão para o CSV');
});

/** Executor falso que fala o protocolo de cursor (DECLARE/FETCH/CLOSE): clientes e contrato_documentos presentes. */
function bancoFalso(linhasClientes: number, extras: string[] = [], pdf = Buffer.from('%PDF-1.4 falso')) {
    const consultas: string[] = [];
    const cursores = new Map<string, object[]>();
    const tx: DbExecutor = {
        async query<Row extends object>(sql: string, valores: readonly unknown[] = []) {
            consultas.push(sql);
            const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
            if (/FROM empresas WHERE id = \$1/.test(sql)) return r([{ id: valores[0], codigo: 'Buffet Ágil', nome: 'Buffet Ágil', status: 'ATIVA', agora: '2026-10-21T12:00:00.000Z' }]);
            if (sql.includes('information_schema.tables WHERE')) return r(['clientes', 'contrato_documentos', 'auditoria', ...extras].map((t) => ({ t })));
            if (sql.includes('information_schema.columns')) return r([
                { tabela: 'clientes', nome: 'id', tipo: 'uuid' }, { tabela: 'clientes', nome: 'nome_completo', tipo: 'text' },
                { tabela: 'clientes', nome: 'senha_hash', tipo: 'text' }, { tabela: 'clientes', nome: 'saldo', tipo: 'numeric' },
                { tabela: 'contrato_documentos', nome: 'id', tipo: 'uuid' }, { tabela: 'contrato_documentos', nome: 'conteudo_pdf', tipo: 'bytea' },
                { tabela: 'auditoria', nome: 'id', tipo: 'uuid' },
            ]);
            if (sql.includes('pg_index')) return r([{ tabela: 'clientes', coluna: 'id' }, { tabela: 'contrato_documentos', coluna: 'id' }]);
            const declarar = /^DECLARE (\w+) NO SCROLL CURSOR FOR (.*)$/s.exec(sql);
            if (declarar) {
                const [, nome, consulta] = declarar;
                if (consulta.includes('FROM "clientes" t')) {
                    assert.match(consulta, /WHERE t\.empresa_id = \$1::uuid ORDER BY t\."id"$/);
                    assert.doesNotMatch(consulta, /senha_hash/);
                    cursores.set(nome, Array.from({ length: linhasClientes }, (_, i) => ({ c0: `id-${i}`, c1: i === 0 ? '=HYPERLINK("x")' : `Cliente ${i}`, c2: '-10.50' })));
                } else if (nome === 'exportacao_binarios') cursores.set(nome, [{ id: 'doc-1', tamanho: pdf.length }]);
                else if (consulta.includes('FROM "contrato_documentos" t')) cursores.set(nome, [{ c0: 'doc-1', c1: String(pdf.length), c2: sha(pdf), c3: 'arquivos/contratos/doc-1.pdf' }]);
                else throw new Error(`cursor inesperado: ${consulta.slice(0, 80)}`);
                return r([]);
            }
            const buscar = /^FETCH (\d+) FROM (\w+)$/.exec(sql);
            if (buscar) { const fila = cursores.get(buscar[2])!; return r(fila.splice(0, Number(buscar[1]))); }
            if (/^CLOSE (\w+)$/.test(sql)) { cursores.delete(sql.slice(6)); return r([]); }
            if (sql.includes('coalesce(sum(')) return r([{ n: String(pdf.length) }]);
            if (sql.startsWith('SELECT substring(')) {
                assert.ok(sql.includes('empresa_id = $1::uuid'), 'filtro da empresa em cada bloco');
                assert.ok(sql.includes('t.id = $2::uuid'));
                assert.equal(valores[1], 'doc-1');
                assert.ok(Number(valores[3]) <= BLOCO_PDF_BYTES);
                const offset = Number(valores[2]) - 1;
                return r([{ b: pdf.subarray(offset, offset + Number(valores[3])) }]);
            }
            throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
        },
    };
    return { tx, consultas, pdf, cursores };
}

const discoFolgado = { livre: async () => 10 * 1024 * 1024 * 1024 };

test('PDFs em blocos: vazio, fronteira e cauda preservam bytes e hash sem leitura integral', async () => {
    for (const tamanho of [0, BLOCO_PDF_BYTES, BLOCO_PDF_BYTES * 2 + 17]) {
        const base = pasta();
        try {
            const pdf = Buffer.alloc(tamanho);
            for (let i = 0; i < tamanho; i++) pdf[i] = i % 251;
            const b = bancoFalso(0, [], pdf);
            const p = await gerarPacote(b.tx, '00000000-0000-4000-8000-000000000001', { base, disco: discoFolgado });
            assert.deepEqual(lerZip(readFileSync(p.zipCaminho)).get('arquivos/contratos/doc-1.pdf'), pdf);
            assert.equal(b.consultas.filter(s => s.startsWith('SELECT substring(')).length, Math.ceil(tamanho / BLOCO_PDF_BYTES));
            assert.doesNotMatch(b.consultas.find(s => s.startsWith('DECLARE exportacao_binarios'))!, /AS b FROM/);
            assert.equal(p.manifesto.arquivos.find(a => a.tipo === 'pdf')!.sha256, sha(pdf));
            await p.limpar();
            assert.deepEqual(readdirSync(base), []);
        } finally { rmSync(base, { recursive: true, force: true }); }
    }
});

test('falha, bloco truncado e adulteração recusam todo o pacote e limpam os temporários', async () => {
    for (const modo of ['falha', 'truncado', 'adulterado']) {
        const base = pasta();
        const b = bancoFalso(0, [], Buffer.alloc(BLOCO_PDF_BYTES + 17, 65));
        const original = b.tx.query.bind(b.tx);
        b.tx.query = async (sql, valores) => {
            if (sql.startsWith('SELECT substring(') && Number(valores?.[2]) > 1) {
                if (modo === 'falha') throw new Error('falha sintética no segundo bloco');
                const buffer = Buffer.alloc(modo === 'truncado' ? 16 : 17, 66);
                return { rows: [{ b: buffer }] as never[], rowCount: 1 };
            }
            return original(sql, valores);
        };
        try {
            await assert.rejects(gerarPacote(b.tx, '00000000-0000-4000-8000-000000000001', { base, disco: discoFolgado }),
                /falha sintética|tamanho divergente|hash divergente/);
            assert.deepEqual(readdirSync(base), []);
            assert.equal(b.cursores.size, 0);
        } finally { rmSync(base, { recursive: true, force: true }); }
    }
});

/** FileHandle falso: grava de verdade em memória, mas no máximo `limite(pedido)` bytes por chamada. */
function handleFalso(limite: (pedido: number) => number) {
    const gravado: Buffer[] = [];
    let chamadas = 0, fechado = false;
    const fh = {
        async write(b: Buffer, offset: number, length: number) {
            chamadas++;
            const n = Math.min(length, limite(length));
            gravado.push(Buffer.from(b.subarray(offset, offset + n)));
            return { bytesWritten: n, buffer: b };
        },
        async close() { fechado = true; },
    };
    return { fh: fh as unknown as FileHandle, conteudo: () => Buffer.concat(gravado), chamadas: () => chamadas, fechado: () => fechado };
}

test('Gravador.escrever (P3-2): escrita parcial continua do ponto certo; escrita sem progresso recusa', async () => {
    const dados = Buffer.alloc(1000);
    for (let i = 0; i < dados.length; i++) dados[i] = (i * 13) % 256;
    for (const [nome, limite, chamadasEsperadas] of [
        ['metade', (n: number) => Math.ceil(n / 2), 10],
        ['um byte', () => 1, 1000],
    ] as const) {
        const h = handleFalso(limite);
        const g = new Gravador('falso.tmp', h.fh);
        await g.escrever(dados);
        const r = await g.fechar();
        assert.ok(h.conteudo().equals(dados), `${nome}: bytes completos e na ordem`);
        assert.equal(h.chamadas(), chamadasEsperadas, `${nome}: uma chamada por parcial`);
        assert.equal(r.bytes, dados.length);
        assert.equal(r.sha256, sha(dados));
        assert.equal(r.crc, crc32(dados));
        assert.equal(h.fechado(), true);
    }
    // 0 bytes gravados: recusa em vez de laço infinito, e nada é contabilizado.
    const zero = handleFalso(() => 0);
    const g = new Gravador('falso.tmp', zero.fh);
    await assert.rejects(g.escrever(dados), /escrita temporária sem progresso/);
    assert.equal(zero.chamadas(), 1);
    assert.equal(g.bytes, 0);
    // Progresso parcial seguido de parada também recusa.
    let vez = 0;
    const trava = handleFalso((n) => (++vez === 1 ? Math.floor(n / 3) : 0));
    await assert.rejects(new Gravador('falso.tmp', trava.fh).escrever(dados), /sem progresso/);
    assert.equal(trava.conteudo().length, 333);
});

test('tamanho de PDF inválido no cursor (P3-3) recusa antes de qualquer bloco e limpa os temporários', async () => {
    for (const tamanho of [-1, 1.5, '14', Number.NaN, 2 ** 53]) {
        const base = pasta();
        const b = bancoFalso(0);
        const original = b.tx.query.bind(b.tx);
        b.tx.query = (async (sql: string, valores?: readonly unknown[]) => {
            const r = await original(sql, valores);
            if (sql === 'FETCH 1 FROM exportacao_binarios' && r.rows[0]) return { ...r, rows: [{ ...r.rows[0], tamanho }] };
            return r;
        }) as DbExecutor['query'];
        try {
            await assert.rejects(gerarPacote(b.tx, '00000000-0000-4000-8000-000000000001', { base, disco: discoFolgado }),
                /tamanho de PDF inválido/, `tamanho ${String(tamanho)}`);
            assert.equal(b.consultas.filter(s => s.startsWith('SELECT substring(')).length, 0);
            assert.deepEqual(readdirSync(base), []);
        } finally { rmSync(base, { recursive: true, force: true }); }
    }
});

test('close que falha depois de erro de bloco (P3-4) não esconde a causa; sem erro anterior, a falha do close aparece', async () => {
    // close é propriedade da instância do FileHandle: envolve o de cada arquivo aberto pelo Gravador (fecha de verdade e
    // então falha, enquanto quebrar estiver ligado).
    const abrirOriginal = Gravador.abrir;
    let quebrar = false;
    Gravador.abrir = async (arquivo: string) => {
        const g = await abrirOriginal.call(Gravador, arquivo);
        const fh = (g as unknown as { fh: FileHandle }).fh;
        const fecharOriginal = fh.close.bind(fh);
        fh.close = async () => { await fecharOriginal(); if (quebrar) throw new Error('close sintético'); };
        return g;
    };
    try {
        for (const [falharBloco, esperado] of [[true, /falha sintética no segundo bloco/], [false, /close sintético/]] as const) {
            const base = pasta();
            quebrar = false;
            const b = bancoFalso(0, [], Buffer.alloc(BLOCO_PDF_BYTES + 17, 65));
            const original = b.tx.query.bind(b.tx);
            b.tx.query = async (sql, valores) => {
                if (sql.startsWith('SELECT substring(') && Number(valores?.[2]) > 1) {
                    quebrar = true;
                    if (falharBloco) throw new Error('falha sintética no segundo bloco');
                }
                return original(sql, valores);
            };
            try {
                await assert.rejects(gerarPacote(b.tx, '00000000-0000-4000-8000-000000000001', { base, disco: discoFolgado }), esperado);
                assert.deepEqual(readdirSync(base), []);
                assert.equal(b.cursores.size, 0);
            } finally { quebrar = false; rmSync(base, { recursive: true, force: true }); }
        }
    } finally { Gravador.abrir = abrirOriginal; }
});

test('pacote em fluxo: manifesto, SHA256SUMS e ZIP consistentes; lotes; ausentes declaradas; só leituras; temporários apagados', async () => {
    const base = pasta();
    try {
        const { tx, consultas, pdf, cursores } = bancoFalso(7);
        const p = await gerarPacote(tx, '00000000-0000-4000-8000-000000000001', { lote: 3, disco: discoFolgado, base });
        assert.ok(consultas.every((s) => /^\s*(SELECT|DECLARE \w+ NO SCROLL CURSOR FOR SELECT|FETCH \d+ FROM \w+|CLOSE \w+)/i.test(s)), 'só leitura');
        assert.equal(consultas.filter((s) => s.startsWith('FETCH 3 FROM')).length, 4 + 2, 'clientes: 7 linhas em lotes de 3 + FETCH vazio; documentos: 1 + vazio');
        assert.equal(cursores.size, 0, 'todo cursor fechado');
        assert.ok(p.dir.startsWith(base) && p.dir.includes(PREFIXO_TEMPORARIO));
        assert.equal(p.nomeArquivo, 'kidmais-exportacao-buffet--gil-20261021T120000Z.zip');
        assert.deepEqual(readdirSync(p.dir), ['pacote.zip'], 'só o ZIP fica até o envio');
        const zip = readFileSync(p.zipCaminho);
        assert.equal(zip.length, p.zipBytes);
        assert.equal(sha(zip), p.zipSha256);
        const arquivos = lerZip(zip);
        const manifestoBuf = arquivos.get('MANIFESTO.json')!;
        assert.equal(sha(manifestoBuf), p.manifestoSha256);
        const m = JSON.parse(manifestoBuf.toString('utf8')) as Manifesto;
        assert.deepEqual(m, p.manifesto);
        assert.equal(m.versaoFormato, 1);
        for (const a of m.arquivos) assert.equal(sha(arquivos.get(a.caminho)!), a.sha256, a.caminho);
        const clientes = m.arquivos.find((a) => a.tabela === 'clientes')!;
        assert.equal(clientes.linhas, 7);
        assert.deepEqual(clientes.colunas, ['id', 'nome_completo', 'saldo']);
        const csvClientes = arquivos.get('dados/clientes/clientes.csv')!.toString('utf8');
        assert.equal(csvClientes.split('\r\n').length - 2, 7, 'cabeçalho + 7 linhas + fim');
        assert.ok(csvClientes.includes(`"'=HYPERLINK(""x"")";-10.50`), 'texto neutralizado, número intacto');
        assert.ok(arquivos.get('arquivos/contratos/doc-1.pdf')!.equals(pdf));
        assert.equal(m.entidadesAusentes.length, ENTIDADES.length - 2);
        assert.deepEqual(m.foraDoEscopo.map((f) => f.tabela), ['auditoria']);
        const somas = arquivos.get('SHA256SUMS.txt')!.toString('utf8').trim().split('\n');
        assert.equal(somas.at(-1), `${p.manifestoSha256}  MANIFESTO.json`);
        for (const l of somas) { const [h, c] = l.split('  '); assert.equal(sha(arquivos.get(c)!), h, c); }
        await p.limpar();
        await p.limpar();
        assert.equal(existsSync(p.dir), false, 'limpar() apaga a pasta e é idempotente');
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('pacote: limites, inventário desatualizado e falta de disco recusam inteiro e não deixam temporários', async () => {
    const base = pasta();
    const vazia = () => readdirSync(base).length === 0;
    try {
        await assert.rejects(gerarPacote(bancoFalso(5).tx, 'x', { limites: { linhasPorArquivo: 4, bytesTotal: 1e9, tempoMs: 60_000 }, disco: discoFolgado, base }), (e: { code?: string; httpStatus?: number }) => e.code === 'EXPORTACAO_GRANDE_DEMAIS' && e.httpStatus === 413);
        assert.ok(vazia());
        await assert.rejects(gerarPacote(bancoFalso(5).tx, 'x', { limites: { linhasPorArquivo: 100, bytesTotal: 50, tempoMs: 60_000 }, disco: discoFolgado, base }), /limite/);
        let t = 0;
        await assert.rejects(gerarPacote(bancoFalso(1).tx, 'x', { relogio: () => (t += 200_000), disco: discoFolgado, base }), (e: { code?: string }) => e.code === 'EXPORTACAO_DEMORADA');
        const erro = console.error;
        const log: string[] = [];
        console.error = (...a: unknown[]) => { log.push(a.join(' ')); };
        try {
            await assert.rejects(gerarPacote(bancoFalso(1, ['tabela_nova_089']).tx, 'x', { disco: discoFolgado, base }), (e: { code?: string; httpStatus?: number }) => e.code === 'EXPORTACAO_INVENTARIO_DESATUALIZADO' && e.httpStatus === 503);
        } finally { console.error = erro; }
        assert.ok(log.some((l) => l.includes('tabela_nova_089')), 'nome da tabela no log do servidor');
        await assert.rejects(gerarPacote(bancoFalso(1).tx, 'x', { disco: { livre: async () => 1024 }, base }), (e: { code?: string; httpStatus?: number }) => e.code === 'EXPORTACAO_SEM_ESPACO' && e.httpStatus === 507);
        assert.ok(vazia(), 'nenhuma pasta temporária sobra depois das recusas');
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('limparSobras: só pastas do prefixo e mais velhas que o prazo', async () => {
    const base = pasta();
    try {
        const velha = join(base, `${PREFIXO_TEMPORARIO}velha`), nova = join(base, `${PREFIXO_TEMPORARIO}nova`), alheia = join(base, 'outra-coisa');
        for (const d of [velha, nova, alheia]) { mkdirSync(d); writeFileSync(join(d, 'x'), 'x'); }
        const duasHoras = (Date.now() - 2 * 3600_000) / 1000;
        utimesSync(velha, duasHoras, duasHoras); utimesSync(alheia, duasHoras, duasHoras);
        assert.equal(await limparSobras(base), 1);
        assert.deepEqual([existsSync(velha), existsSync(nova), existsSync(alheia)], [false, true, true]);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('serviço: uma exportação por processo; a vaga volta em erro', { timeout: 10_000 }, async () => {
    assert.equal(MAXIMO_SIMULTANEAS, 1);
    let soltar: () => void = () => {};
    const bloqueio = new Promise<void>((r) => { soltar = r; });
    const transacao = async <T>(work: (tx: DbExecutor) => Promise<T>) => { await bloqueio; return work({ query: async () => { throw new Error('banco indisponível'); } } as DbExecutor); };
    const primeira = exportarPacoteCompleto({ usuario_id: '00000000-0000-4000-8000-000000000009', papel: 'X' }, null, {}, { transacao });
    assert.equal(exportacoesEmAndamento(), 1);
    await assert.rejects(exportarPacoteCompleto({ usuario_id: '00000000-0000-4000-8000-000000000009', papel: 'X' }, null, {}, { transacao }), (e: { code?: string; httpStatus?: number }) => e.code === 'EXPORTACAO_OCUPADA' && e.httpStatus === 429);
    soltar();
    await assert.rejects(primeira, /banco indisponível/);
    assert.equal(exportacoesEmAndamento(), 0, 'vaga liberada depois do erro');
});

function fontes(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? fontes(p) : /\.(ts|tsx)$/.test(n) ? [p.split('\\').join('/')] : [];
    });
}

test('estático: exceção da suspensa só na exportação; POST com CSRF; fluxo sem cópia; auditoria sem IP; temporários fora do disco persistente', () => {
    const usam = [...fontes('app'), ...fontes('lib'), ...fontes('components')]
        .filter((f) => !f.includes('.test.') && !f.includes('.test-apoio.') && /provarTenantParaExportacao|empresasSuspensasExportaveis/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(usam.sort(), ['app/api/admin/exportacao/empresas-suspensas/route.ts', 'app/api/admin/exportacao/route.ts', 'lib/exportacao/guarda.ts', 'lib/exportacao/servico.ts'].sort());
    const guarda = readFileSync('lib/exportacao/guarda.ts', 'utf8');
    assert.match(guarda, /status !== 'SUSPENSA'/);
    assert.doesNotMatch(guarda, /DESATIVADA'\)|IN \('ATIVA', 'SUSPENSA'/, 'desativada nunca');
    assert.match(guarda, /exigirGestaoNoTenant\(tenant, MENSAGEM_GESTAO\)/);
    assert.match(guarda, /opcoes\.permitirSelecaoNoutraEmpresa !== true\) recusar\(\)/);
    const servico = readFileSync('lib/exportacao/servico.ts', 'utf8');
    assert.match(servico, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
    assert.doesNotMatch(servico, /\bip\b|user_agent|userAgent/);
    assert.equal((servico.match(/INSERT INTO auditoria/g) ?? []).length, 2, 'só auditoria escreve (sucesso e recusa)');
    assert.equal((servico.match(/INSERT INTO|UPDATE \w+ SET|DELETE FROM/g) ?? []).length, 2);
    for (const f of fontes('lib/exportacao').filter((x) => !x.includes('.test.') && !x.includes('.test-apoio.') && !x.endsWith('servico.ts')))
        assert.doesNotMatch(readFileSync(f, 'utf8'), /INSERT INTO|UPDATE \w+ SET|DELETE FROM/, f);
    const pacote = readFileSync('lib/exportacao/pacote.ts', 'utf8');
    assert.match(pacote, /mkdtemp\(path\.join\(raiz, PREFIXO_TEMPORARIO\)\)/);
    assert.match(pacote, /'\/opt\/render\/project\/src\/data'/);
    assert.match(pacote, /DECLARE exportacao_cursor NO SCROLL CURSOR/);
    const rota = readFileSync('app/api/admin/exportacao/route.ts', 'utf8');
    assert.match(rota, /export async function POST\(request: NextRequest\)/);
    assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/, 'POST passa pela origem + CSRF do Admin');
    assert.match(rota, /if \(bruto === "completa"\) throw/, 'pacote completo não sai por GET');
    assert.match(rota, /exigirMesmaOrigem\(request\)/, 'CSV por GET recusa navegação de outro site');
    assert.match(rota, /Readable\.toWeb\(arquivo\)/);
    assert.match(rota, /arquivo\.once\("close", \(\) => \{ void r\.limpar\(\); \}\)/);
    assert.doesNotMatch(rota, /new Uint8Array/, 'sem cópia do pacote em memória');
    assert.doesNotMatch(rota, /withTenantTransaction/, 'todas as exportações passam pela guarda da exportação');
    assert.match(readFileSync('lib/assinatura/paywall.ts', 'utf8'), /'\/api\/admin\/exportacao'/, 'paywall sempre permite (inclui a lista de suspensas)');
    const comp = readFileSync('components/admin/ExportacaoDados.tsx', 'utf8');
    assert.match(comp, /method: 'POST'/);
    assert.match(comp, /tipo=clientes/); assert.match(comp, /tipo=contas-receber/);
    assert.match(readFileSync('components/admin/Assinatura.tsx', 'utf8'), /<ExportacaoEmpresasSuspensas /);
    assert.match(readFileSync('components/admin/AdminShell.tsx', 'utf8'), /<ExportacaoEmpresasSuspensas \/>/);
    assert.doesNotMatch(readFileSync('app/api/admin/exportacao/empresas-suspensas/route.ts', 'utf8'), /empresa_ativa_id \?/, 'lista também com empresa ativa (P3-4)');
});

test('bloco de Shell de produção (P2-5): só leitura, guarda do serviço, inventário atual embutido, sem gravação', async () => {
    const { gerarBloco, SERVICO_PRODUCAO } = await import('../../scripts/bloco-shell-exportacao-producao.mjs') as { gerarBloco: () => Promise<string>; SERVICO_PRODUCAO: string };
    const bloco = await gerarBloco();
    assert.equal(SERVICO_PRODUCAO, 'srv-dak77m2d0e5s73b8rkkg');
    assert.match(bloco, /if \[ "\$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" \]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO/);
    assert.match(bloco, /BEGIN READ ONLY/);
    assert.match(bloco, /SHOW transaction_read_only/);
    assert.match(bloco, /ROLLBACK/);
    assert.doesNotMatch(bloco.replace(/^#.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|COMMIT)\b/i, 'nenhuma escrita');
    assert.doesNotMatch(bloco, /console\.log\([^)]*DATABASE_URL/, 'a URL nunca é impressa');
    for (const t of [...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)]) assert.ok(bloco.includes(`"${t}"`), t);
    assert.match(bloco, /CODIGO_SAIDA_BLOCO=/);
});
