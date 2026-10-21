import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { celula, csv } from '../assinatura/csv.ts';
import { crc32, lerZip, montarZip } from './zip.ts';
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO } from './entidades.ts';
import { expressoes, gerarPacote, planejarColunas, type Manifesto } from './pacote.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

test('ZIP: CRC-32 de referência, ida e volta com nomes UTF-8, deflate e armazenado, CRC adulterado recusado', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const grande = Buffer.from('linha;repetida\r\n'.repeat(500));
    const zip = montarZip([
        { caminho: 'MANIFESTO.json', conteudo: Buffer.from('{}') },
        { caminho: 'dados/clientes/aniversários.csv', conteudo: grande },
        { caminho: 'arquivos/contratos/x.pdf', conteudo: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
    ], new Date('2026-10-21T12:34:56Z'));
    const lido = lerZip(zip);
    assert.deepEqual([...lido.keys()], ['MANIFESTO.json', 'dados/clientes/aniversários.csv', 'arquivos/contratos/x.pdf']);
    assert.ok(lido.get('dados/clientes/aniversários.csv')!.equals(grande));
    assert.ok(zip.length < grande.length, 'conteúdo repetitivo comprimido');
    const adulterado = Buffer.from(zip);
    adulterado[30 + 'MANIFESTO.json'.length] ^= 0xff; // primeiro byte do conteúdo armazenado de MANIFESTO.json ({})
    assert.throws(() => lerZip(adulterado), /CRC|inválido/);
    for (const ruim of ['/abs', '../fora', 'a//b', 'a\\b', ''])
        assert.throws(() => montarZip([{ caminho: ruim, conteudo: Buffer.alloc(0) }], new Date()), /caminho inválido/);
    assert.throws(() => montarZip([{ caminho: 'a', conteudo: Buffer.alloc(1) }, { caminho: 'a', conteudo: Buffer.alloc(1) }], new Date()), /repetido/);
});

test('CSV: neutralização de fórmula só onde pedido; número negativo fica número', () => {
    assert.equal(celula('-12.50', false), '-12.50');
    assert.equal(celula('-12.50'), "'-12.50");
    const arquivo = csv(['texto', 'valor'], [['=1+1', '-3']], [true, false]);
    assert.equal(arquivo, "\uFEFFtexto;valor\r\n'=1+1;-3\r\n");
    assert.equal(csv(['a'], [['+55']]), "\uFEFFa\r\n'+55\r\n", 'padrão continua neutralizando tudo');
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
    // As tabelas de credenciais nunca entram.
    for (const t of ['sessoes_administrativas', 'recuperacoes_senha', 'limites_autenticacao', 'cadastros_publicos', 'auditoria']) assert.ok(Object.hasOwn(FORA_DO_ESCOPO, t), t);
    assert.deepEqual(ENTIDADES.find((e) => e.tabela === 'usuarios_administrativos')?.somente, ['id', 'nome', 'email', 'cargo', 'ativo', 'criado_em']);
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

/** Executor falso: duas tabelas presentes (clientes e contrato_documentos), o resto ausente neste "ambiente". */
function bancoFalso(linhasClientes: number) {
    const pdf = Buffer.from('%PDF-1.4 falso');
    const consultas: string[] = [];
    const tx: DbExecutor = {
        async query<Row extends object>(sql: string, valores: readonly unknown[] = []) {
            consultas.push(sql);
            const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
            if (/FROM empresas WHERE id = \$1/.test(sql)) return r([{ id: valores[0], codigo: 'Buffet Ágil', nome: 'Buffet Ágil', status: 'ATIVA', agora: '2026-10-21T12:00:00.000Z' }]);
            if (sql.includes('information_schema.columns')) return r([
                { tabela: 'clientes', nome: 'id', tipo: 'uuid' }, { tabela: 'clientes', nome: 'nome_completo', tipo: 'text' },
                { tabela: 'clientes', nome: 'senha_hash', tipo: 'text' }, { tabela: 'clientes', nome: 'saldo', tipo: 'numeric' },
                { tabela: 'contrato_documentos', nome: 'id', tipo: 'uuid' }, { tabela: 'contrato_documentos', nome: 'conteudo_pdf', tipo: 'bytea' },
                { tabela: 'auditoria', nome: 'id', tipo: 'uuid' },
            ]);
            if (sql.includes('pg_index')) return r([{ tabela: 'clientes', coluna: 'id' }, { tabela: 'contrato_documentos', coluna: 'id' }]);
            if (sql.includes('FROM "clientes" t')) {
                assert.match(sql, /WHERE t\.empresa_id = \$1::uuid ORDER BY t\."id" LIMIT/);
                assert.doesNotMatch(sql, /senha_hash/);
                return r(Array.from({ length: linhasClientes }, (_, i) => ({ c0: `id-${i}`, c1: i === 0 ? '=HYPERLINK("x")' : `Cliente ${i}`, c2: '-10.50' })));
            }
            if (sql.includes('FROM "contrato_documentos" t')) {
                if (sql.includes('coalesce(sum(')) return r([{ n: String(pdf.length) }]);
                if (sql.includes(' AS b ')) return r([{ id: 'doc-1', b: pdf }]);
                return r([{ c0: 'doc-1', c1: String(pdf.length), c2: sha(pdf), c3: 'arquivos/contratos/doc-1.pdf' }]);
            }
            throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
        },
    };
    return { tx, consultas, pdf };
}

test('pacote: manifesto, SHA256SUMS e ZIP consistentes; ausentes declaradas; só leituras; limites recusam inteiro', async () => {
    const { tx, consultas, pdf } = bancoFalso(3);
    const p = await gerarPacote(tx, '00000000-0000-4000-8000-000000000001');
    assert.ok(consultas.every((s) => /^\s*SELECT/i.test(s)), 'só SELECT');
    assert.equal(p.nomeArquivo, 'kidmais-exportacao-buffet--gil-20261021T120000Z.zip');
    const arquivos = lerZip(p.zip);
    const manifestoBuf = arquivos.get('MANIFESTO.json')!;
    assert.equal(sha(manifestoBuf), p.manifestoSha256);
    const m = JSON.parse(manifestoBuf.toString('utf8')) as Manifesto;
    assert.deepEqual(m, p.manifesto);
    assert.equal(m.versaoFormato, 1);
    assert.equal(m.geradoEm, '2026-10-21T12:00:00.000Z');
    for (const a of m.arquivos) assert.equal(sha(arquivos.get(a.caminho)!), a.sha256, a.caminho);
    const clientes = m.arquivos.find((a) => a.tabela === 'clientes')!;
    assert.equal(clientes.linhas, 3);
    assert.deepEqual(clientes.colunas, ['id', 'nome_completo', 'saldo']);
    assert.deepEqual(clientes.colunasExcluidas, [{ coluna: 'senha_hash', motivo: 'credencial ou segredo técnico (padrão de segurança)' }]);
    const csvClientes = arquivos.get('dados/clientes/clientes.csv')!.toString('utf8');
    assert.ok(csvClientes.includes(`"'=HYPERLINK(""x"")";-10.50`), 'texto neutralizado, número intacto');
    assert.ok(arquivos.get('arquivos/contratos/doc-1.pdf')!.equals(pdf));
    assert.equal(m.totais.pdfs, 1);
    assert.equal(m.entidadesAusentes.length, ENTIDADES.length - 2, 'tabelas ausentes listadas, não inventadas');
    assert.deepEqual(m.foraDoEscopo.map((f) => f.tabela), ['auditoria'], 'fora do escopo: só as que existem no ambiente');
    const somas = arquivos.get('SHA256SUMS.txt')!.toString('utf8').trim().split('\n');
    assert.equal(somas.at(-1), `${p.manifestoSha256}  MANIFESTO.json`);
    for (const l of somas) { const [h, c] = l.split('  '); assert.equal(sha(arquivos.get(c)!), h, c); }
    assert.ok(arquivos.get('LEIA-ME.txt')!.toString('utf8').includes('sha256sum -c SHA256SUMS.txt'));

    await assert.rejects(gerarPacote(bancoFalso(5).tx, 'x', { linhasPorArquivo: 4, bytesTotal: 1e9, tempoMs: 60_000 }), (e: { code?: string; httpStatus?: number }) => e.code === 'EXPORTACAO_GRANDE_DEMAIS' && e.httpStatus === 413);
    await assert.rejects(gerarPacote(bancoFalso(5).tx, 'x', { linhasPorArquivo: 100, bytesTotal: 50, tempoMs: 60_000 }), /limite/);
    let t = 0;
    await assert.rejects(gerarPacote(bancoFalso(1).tx, 'x', undefined, () => (t += 200_000)), (e: { code?: string }) => e.code === 'EXPORTACAO_DEMORADA');
});

function fontes(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? fontes(p) : /\.(ts|tsx)$/.test(n) ? [p.split('\\').join('/')] : [];
    });
}

test('estático: a exceção da empresa suspensa só serve à exportação; rota e auditoria sem conteúdo nem IP', () => {
    const usam = [...fontes('app'), ...fontes('lib'), ...fontes('components')]
        .filter((f) => !f.endsWith('.test.ts') && /provarTenantParaExportacao|empresasSuspensasExportaveis/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(usam.sort(), ['app/api/admin/exportacao/empresas-suspensas/route.ts', 'app/api/admin/exportacao/route.ts', 'lib/exportacao/guarda.ts', 'lib/exportacao/servico.ts'].sort());
    const guarda = readFileSync('lib/exportacao/guarda.ts', 'utf8');
    assert.match(guarda, /status !== 'SUSPENSA'/);
    assert.doesNotMatch(guarda, /DESATIVADA'\)|IN \('ATIVA', 'SUSPENSA'/, 'desativada nunca');
    assert.match(guarda, /exigirGestaoNoTenant\(tenant, MENSAGEM_GESTAO\)/);
    const servico = readFileSync('lib/exportacao/servico.ts', 'utf8');
    assert.match(servico, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
    assert.doesNotMatch(servico, /\bip\b|user_agent|userAgent/);
    assert.equal((servico.match(/INSERT INTO/g) ?? []).length, 1, 'só a auditoria escreve');
    for (const f of fontes('lib/exportacao').filter((x) => !x.includes('.test.') && !x.endsWith('servico.ts')))
        assert.doesNotMatch(readFileSync(f, 'utf8'), /INSERT INTO|UPDATE \w+ SET|DELETE FROM/, f);
    const rota = readFileSync('app/api/admin/exportacao/route.ts', 'utf8');
    assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/);
    assert.match(rota, /"Cache-Control": "no-store"/);
    assert.match(rota, /"X-Kidmais-Manifesto-Sha256": r\.manifestoSha256/);
    assert.match(rota, /"Content-Type": "application\/zip"/);
    assert.doesNotMatch(rota, /withTenantTransaction/, 'todas as exportações passam pela guarda da exportação');
    assert.match(readFileSync('lib/assinatura/paywall.ts', 'utf8'), /'\/api\/admin\/exportacao'/, 'paywall sempre permite (inclui a lista de suspensas)');
    const tela = readFileSync('components/admin/Assinatura.tsx', 'utf8');
    assert.match(tela, /<ExportacaoDados \/>/);
    const comp = readFileSync('components/admin/ExportacaoDados.tsx', 'utf8');
    assert.match(comp, /tipo=clientes/); assert.match(comp, /tipo=contas-receber/); assert.match(comp, /tipo=completa/);
    assert.match(readFileSync('components/admin/AdminShell.tsx', 'utf8'), /<ExportacaoEmpresasSuspensas \/>/);
});
