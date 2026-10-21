import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, statfs, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DbExecutor } from '../db/contracts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { BOM, linhaCsv } from '../assinatura/csv.ts';
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO, type Entidade } from './entidades.ts';
import { crc32, escreverZip, MAXIMO_ENTRADAS_ZIP, type EntradaArquivo } from './zip.ts';

/**
 * Pacote completo e verificável dos dados de UMA empresa (formato 1), montado em FLUXO:
 *   - cada tabela é lida por cursor, em lotes, e gravada num CSV temporário com SHA-256 e CRC-32 incrementais;
 *   - cada PDF de contrato vem um por vez para o seu arquivo temporário;
 *   - o ZIP é montado em arquivo, lendo dos temporários; a rota envia o ZIP por fluxo só depois da revalidação final.
 * Memória: um lote por vez (LOTE linhas ou 1 PDF) + o manifesto. Disco: a pasta temporária do sistema (os.tmpdir()),
 * nunca o disco persistente da aplicação; tudo é apagado por `limpar()` (servico.ts garante em erro, fim e abandono).
 *
 * As leituras rodam dentro de uma transação REPEATABLE READ READ ONLY aberta por quem chama (servico.ts): todos os
 * arquivos refletem o mesmo instante. Nada aqui decide quem pode exportar — a prova do tenant fica em guarda.ts.
 * Tabela pública que não está no inventário nem em FORA_DO_ESCOPO recusa a exportação inteira (503): um pacote dito
 * "completo" nunca omite dados em silêncio (migration nova sem decisão).
 *
 * Conteúdo: dados/<grupo>/<entidade>.csv, arquivos/contratos/<documento>.pdf, LEIA-ME.txt, MANIFESTO.json (versão, data,
 * empresa, contagens, colunas e SHA-256 de cada arquivo) e SHA256SUMS.txt (formato do sha256sum, inclui o MANIFESTO).
 */
export const FORMATO = 'kidmais-exportacao';
export const VERSAO_FORMATO = 1;
/** Linhas por FETCH do cursor. */
export const LOTE = 100;
/** Prefixo das pastas temporárias (a limpeza de sobras antigas só toca pastas com este prefixo). */
export const PREFIXO_TEMPORARIO = 'kidmais-exportacao-';
/** Disco persistente da produção no Render: nunca usado para temporários. */
const DISCO_PERSISTENTE = '/opt/render/project/src/data';

export type Limites = { linhasPorArquivo: number; bytesTotal: number; tempoMs: number };
/** Recusa o pacote inteiro (nunca parcial) acima destes valores. */
export const LIMITES_PADRAO: Limites = { linhasPorArquivo: 200_000, bytesTotal: 150 * 1024 * 1024, tempoMs: 120_000 };
/** Folga mínima de disco além do que o pacote ainda vai ocupar. */
const FOLGA_DISCO = 32 * 1024 * 1024;

/** Tipos cujo valor é texto livre: só esses recebem a neutralização de fórmula do CSV. */
const TIPOS_TEXTO = new Set(['text', 'character varying', 'character', 'USER-DEFINED', 'ARRAY', 'json', 'jsonb', 'inet', 'cidr', 'xml']);

export type ArquivoManifesto = {
    caminho: string;
    tipo: 'csv' | 'pdf' | 'texto';
    bytes: number;
    sha256: string;
    entidade?: string;
    tabela?: string;
    grupo?: string;
    descricao?: string;
    linhas?: number;
    colunas?: string[];
    colunasExcluidas?: { coluna: string; motivo: string }[];
};
export type Manifesto = {
    formato: typeof FORMATO;
    versaoFormato: number;
    geradoEm: string;
    empresa: { id: string; codigo: string; nome: string; situacao: string };
    consistencia: string;
    hash: string;
    csv: Record<string, string>;
    arquivos: ArquivoManifesto[];
    entidadesAusentes: { entidade: string; tabela: string; motivo: string }[];
    foraDoEscopo: { tabela: string; motivo: string }[];
    totais: { arquivos: number; linhas: number; bytes: number; pdfs: number };
};
/** Pacote pronto em disco. `limpar()` é idempotente e apaga a pasta temporária inteira. */
export type PacoteGerado = {
    dir: string; zipCaminho: string; zipBytes: number; zipSha256: string;
    manifesto: Manifesto; manifestoSha256: string; nomeArquivo: string;
    limpar: () => Promise<void>;
};
export type Disco = { livre: (dir: string) => Promise<number> };
export const DISCO_PADRAO: Disco = { livre: async (dir) => { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); } };

const ident = (nome: string) => `"${nome.replace(/"/g, '""')}"`;
const literal = (texto: string) => `'${texto.replace(/'/g, "''")}'`;
const nomeArquivoCsv = (e: Entidade) => `dados/${e.arquivo}.csv`;

type Coluna = { nome: string; tipo: string };

export function grandeDemais(detalhe: string): never {
    throw new PacoteAdminError('EXPORTACAO_GRANDE_DEMAIS',
        `Os dados desta empresa passam do limite da exportação em uma única vez (${detalhe}). Fale com o suporte para receber o pacote por outro meio.`, 413);
}
function demorada(): never {
    throw new PacoteAdminError('EXPORTACAO_DEMORADA', 'A exportação passou do tempo limite. Tente de novo em alguns minutos; se persistir, fale com o suporte.', 503);
}
function semEspaco(): never {
    throw new PacoteAdminError('EXPORTACAO_SEM_ESPACO', 'Não há espaço temporário suficiente no servidor para montar o pacote agora. Tente de novo em alguns minutos; se persistir, fale com o suporte.', 507);
}

/** Colunas exportadas da entidade e as excluídas (com motivo), a partir do schema real. Puro: testável sem banco. */
export function planejarColunas(e: Entidade, colunas: readonly Coluna[]) {
    const exportadas: Coluna[] = [];
    const excluidas: { coluna: string; motivo: string }[] = [];
    for (const c of colunas) {
        if (e.somente && !e.somente.includes(c.nome)) { excluidas.push({ coluna: c.nome, motivo: 'fora da lista de permissão (tabela compartilhada pela plataforma)' }); continue; }
        const declarada = e.excluir?.[c.nome];
        if (declarada) { excluidas.push({ coluna: c.nome, motivo: declarada }); continue; }
        if (SEGREDO.test(c.nome)) { excluidas.push({ coluna: c.nome, motivo: 'credencial ou segredo técnico (padrão de segurança)' }); continue; }
        exportadas.push(c);
    }
    return { exportadas, excluidas };
}

/** Expressões SQL (alias t) e o cabeçalho do CSV. bytea vira tamanho + SHA-256 (+ caminho do arquivo, se for o PDF). */
export function expressoes(e: Entidade, exportadas: readonly Coluna[]) {
    const sel: string[] = [];
    const cabecalho: string[] = [];
    const neutralizar: boolean[] = [];
    for (const c of exportadas) {
        const col = `t.${ident(c.nome)}`;
        if (c.tipo === 'bytea') {
            sel.push(`octet_length(${col})::text`, `encode(sha256(${col}), 'hex')`);
            cabecalho.push(`${c.nome}__bytes`, `${c.nome}__sha256`);
            neutralizar.push(false, false);
            if (e.arquivoBinario?.coluna === c.nome) {
                sel.push(`CASE WHEN ${col} IS NULL THEN NULL ELSE ${literal(`${e.arquivoBinario.pasta}/`)} || t.id::text || ${literal(`.${e.arquivoBinario.extensao}`)} END`);
                cabecalho.push(`${c.nome}__arquivo`);
                neutralizar.push(false);
            }
            continue;
        }
        sel.push(c.tipo === 'ARRAY' ? `to_json(${col})::text` : `${col}::text`);
        cabecalho.push(c.nome);
        neutralizar.push(TIPOS_TEXTO.has(c.tipo));
    }
    return { sel, cabecalho, neutralizar };
}

type Esquema = { tabelas: Set<string>; colunas: Map<string, Coluna[]>; chaves: Map<string, string[]> };

async function lerEsquema(tx: DbExecutor): Promise<Esquema> {
    const tabelas = new Set((await tx.query<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.t));
    const nomes = [...new Set([...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)])];
    const colunas = new Map<string, Coluna[]>();
    for (const r of (await tx.query<{ tabela: string; nome: string; tipo: string }>(
        `SELECT c.table_name AS tabela, c.column_name AS nome, c.data_type AS tipo
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.table_name = ANY($1::text[])
          ORDER BY c.table_name, c.ordinal_position`, [nomes])).rows) {
        const lista = colunas.get(r.tabela) ?? [];
        lista.push({ nome: r.nome, tipo: r.tipo });
        colunas.set(r.tabela, lista);
    }
    const chaves = new Map<string, string[]>();
    for (const r of (await tx.query<{ tabela: string; coluna: string }>(
        `SELECT c.relname AS tabela, a.attname AS coluna
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary AND c.relname = ANY($1::text[])
          ORDER BY c.relname, array_position(i.indkey::int2[], a.attnum)`, [nomes])).rows) {
        const lista = chaves.get(r.tabela) ?? [];
        lista.push(r.coluna);
        chaves.set(r.tabela, lista);
    }
    return { tabelas, colunas, chaves };
}

/** Tabelas públicas do banco sem decisão (nem no pacote, nem fora com motivo). Puro. */
export function naoClassificadas(tabelas: Iterable<string>): string[] {
    const conhecidas = new Set([...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)]);
    return [...tabelas].filter((t) => !conhecidas.has(t)).sort();
}

/** Arquivo temporário gravado em fluxo, com SHA-256, CRC-32 e tamanho incrementais. */
class Gravador {
    private hash: Hash = createHash('sha256');
    private crc = 0;
    bytes = 0;
    readonly arquivo: string;
    private fh: FileHandle;
    private constructor(arquivo: string, fh: FileHandle) { this.arquivo = arquivo; this.fh = fh; }
    static async abrir(arquivo: string) { return new Gravador(arquivo, await open(arquivo, 'wx', 0o600)); }
    async escrever(b: Buffer) {
        if (b.length === 0) return;
        await this.fh.write(b, 0, b.length);
        this.hash.update(b);
        this.crc = crc32(b, this.crc);
        this.bytes += b.length;
    }
    /**
     * Texto em UTF-8 por um buffer REUTILIZADO (cresce só quando um lote é maior que o anterior): o fluxo de lotes
     * não deixa um Buffer novo por lote para o coletor de lixo — é o que mantém a memória externa baixa.
     */
    private reuso: Buffer = Buffer.allocUnsafe(0);
    async escreverTexto(texto: string): Promise<number> {
        const tamanho = Buffer.byteLength(texto, 'utf8');
        if (tamanho > this.reuso.length) this.reuso = Buffer.allocUnsafe(Math.max(tamanho, 1024 * 1024));
        const n = this.reuso.write(texto, 0, 'utf8');
        await this.escrever(this.reuso.subarray(0, n));
        return n;
    }
    async fechar() {
        this.reuso = Buffer.allocUnsafe(0);
        await this.fh.close();
        return { sha256: this.hash.digest('hex'), crc: this.crc, bytes: this.bytes };
    }
}

const LEIA_ME = (m: Pick<Manifesto, 'empresa' | 'geradoEm'>) => [
    'Kidmais Manager — exportação dos dados da empresa',
    '',
    `Empresa: ${m.empresa.nome} (${m.empresa.codigo})`,
    `Gerado em (UTC): ${m.geradoEm}`,
    `Formato: ${FORMATO}, versão ${VERSAO_FORMATO}`,
    '',
    'Conteúdo',
    '- dados/: um arquivo CSV por tipo de registro (separador ponto e vírgula, UTF-8 com BOM; abre no Excel).',
    '- arquivos/contratos/: PDF de cada documento de contrato; a coluna conteudo_pdf__arquivo de',
    '  dados/contratos/contrato_documentos.csv indica o arquivo de cada linha.',
    '- MANIFESTO.json: lista de arquivos com quantidade de linhas, colunas e SHA-256 de cada um, além do que',
    '  ficou fora do pacote e por quê.',
    '- SHA256SUMS.txt: os mesmos hashes (inclusive o do MANIFESTO.json) no formato do sha256sum.',
    '',
    'Como conferir',
    '- Linux ou macOS, na pasta extraída: sha256sum -c SHA256SUMS.txt (ou shasum -a 256 -c SHA256SUMS.txt).',
    '- Windows (PowerShell), um arquivo: Get-FileHash -Algorithm SHA256 .\\dados\\clientes\\clientes.csv',
    '  e compare com o valor do MANIFESTO.json (o PowerShell mostra em maiúsculas; é o mesmo valor).',
    '- O hash do MANIFESTO.json também aparece na tela no momento do download e fica registrado na auditoria da',
    '  plataforma: se ele confere, todos os hashes listados nele também valem.',
    '',
    'Observações',
    '- Datas e horas em UTC. Valores como estão no banco (texto do PostgreSQL); colunas *_centavos estão em centavos.',
    "- Células de texto que começam com = + - @ (também depois de espaços, e nas formas ＝＋－＠) recebem um apóstrofo (')",
    '  na frente para o Excel não executar fórmulas; o valor original é o texto sem esse apóstrofo.',
    '- Imagens, mídias do WhatsApp e outros arquivos binários aparecem só com tamanho e SHA-256 (veja o MANIFESTO).',
    '- Senhas, hashes de senha, códigos de links públicos, tokens e credenciais nunca entram no pacote.',
    '',
].join('\r\n');

/** Pasta temporária própria em os.tmpdir() (nunca o disco persistente). */
export async function criarPastaTemporaria(base = tmpdir()): Promise<string> {
    const raiz = path.resolve(base);
    if (raiz.replace(/\\/g, '/').startsWith(DISCO_PERSISTENTE)) throw new Error('exportação: pasta temporária no disco persistente recusada');
    return mkdtemp(path.join(raiz, PREFIXO_TEMPORARIO));
}

/** Remove sobras de exportações anteriores (processo reiniciado no meio) com mais de `idadeMs`. */
export async function limparSobras(base = tmpdir(), idadeMs = 60 * 60 * 1000, agora = Date.now()): Promise<number> {
    let removidas = 0;
    for (const nome of await readdir(base).catch(() => [] as string[])) {
        if (!nome.startsWith(PREFIXO_TEMPORARIO)) continue;
        const p = path.join(base, nome);
        const s = await stat(p).catch(() => null);
        if (s?.isDirectory() && agora - s.mtimeMs > idadeMs) { await rm(p, { recursive: true, force: true }); removidas++; }
    }
    return removidas;
}

type Opcoes = { limites?: Limites; relogio?: () => number; disco?: Disco; lote?: number };

/** Dados lidos para a pasta temporária, ainda sem o ZIP (fase de leitura, dentro da transação). */
export type DadosLidos = {
    dir: string; empresa: Manifesto['empresa']; geradoEm: string;
    arquivos: ArquivoManifesto[]; entradas: EntradaArquivo[]; ausentes: Manifesto['entidadesAusentes'];
    foraDoEscopo: Manifesto['foraDoEscopo']; linhas: number; bytes: number; pdfs: number;
};

/**
 * Lê todas as entidades da empresa para arquivos temporários em `dir`. `tx` deve estar em REPEATABLE READ READ ONLY
 * com TimeZone UTC (servico.ts). Recusa inteira (413/503/507) acima dos limites; nunca deixa pacote parcial.
 */
export async function lerDados(tx: DbExecutor, empresaId: string, dir: string, opcoes: Opcoes = {}): Promise<DadosLidos> {
    const limites = opcoes.limites ?? LIMITES_PADRAO;
    const relogio = opcoes.relogio ?? Date.now;
    const disco = opcoes.disco ?? DISCO_PADRAO;
    const lote = opcoes.lote ?? LOTE;
    const inicio = relogio();
    const conferirTempo = () => { if (relogio() - inicio > limites.tempoMs) demorada(); };
    let bytes = 0;
    let conferidoDisco = 0;
    const somar = async (n: number) => {
        bytes += n;
        if (bytes > limites.bytesTotal) grandeDemais(`mais de ${Math.round(limites.bytesTotal / 1024 / 1024)} MB`);
        // De 16 em 16 MB: ainda cabe o que falta (dados + ZIP) com folga?
        if (bytes - conferidoDisco >= 16 * 1024 * 1024) { conferidoDisco = bytes; if (await disco.livre(dir) < bytes + FOLGA_DISCO) semEspaco(); }
    };
    if (await disco.livre(dir) < FOLGA_DISCO) semEspaco();

    const empresa = (await tx.query<{ id: string; codigo: string; nome: string; status: string; agora: string }>(
        `SELECT id::text AS id, codigo, nome, status, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS agora
           FROM empresas WHERE id = $1::uuid`, [empresaId])).rows[0];
    if (!empresa) throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403);
    const esquema = await lerEsquema(tx);
    const semDecisao = naoClassificadas(esquema.tabelas);
    if (semDecisao.length) {
        // Nomes de tabela (não dados) no log do servidor, para a equipe classificar.
        console.error(`[exportacao] tabelas públicas não classificadas no inventário: ${semDecisao.join(', ')}`);
        throw new PacoteAdminError('EXPORTACAO_INVENTARIO_DESATUALIZADO',
            'A exportação completa está temporariamente indisponível: há dados novos que ainda não entraram no pacote. A equipe foi avisada; tente de novo mais tarde ou fale com o suporte.', 503);
    }

    const arquivos: ArquivoManifesto[] = [];
    const entradas: EntradaArquivo[] = [];
    const ausentes: Manifesto["entidadesAusentes"] = [];
    let linhasTotal = 0;
    let pdfs = 0;
    let seq = 0;
    const temporario = () => path.join(dir, `${String(++seq).padStart(5, '0')}.tmp`);

    for (const e of ENTIDADES) {
        conferirTempo();
        const colunasTabela = esquema.colunas.get(e.tabela);
        if (!colunasTabela) { ausentes.push({ entidade: e.arquivo, tabela: e.tabela, motivo: 'tabela não existe neste ambiente (migration não aplicada)' }); continue; }
        const { exportadas, excluidas } = planejarColunas(e, colunasTabela);
        const { sel, cabecalho, neutralizar } = expressoes(e, exportadas);
        const chave = (esquema.chaves.get(e.tabela) ?? []).filter((c) => colunasTabela.some((x) => x.nome === c));
        const ordem = chave.length ? chave.map((c) => `t.${ident(c)}`).join(', ') : sel.map((_, i) => String(i + 1)).join(', ');
        const rotulos = sel.map((_, i) => `c${i}`);
        const bin = e.arquivoBinario && exportadas.some((c) => c.nome === e.arquivoBinario!.coluna && c.tipo === 'bytea') ? e.arquivoBinario : null;
        const iSha = bin ? cabecalho.indexOf(`${bin.coluna}__sha256`) : -1, iArq = bin ? cabecalho.indexOf(`${bin.coluna}__arquivo`) : -1;
        const esperado = new Map<string, string>();

        const g = await Gravador.abrir(temporario());
        let linhas = 0;
        try {
            await somar(await g.escreverTexto(`${BOM}${linhaCsv(cabecalho)}\r\n`));
            await tx.query(`DECLARE exportacao_cursor NO SCROLL CURSOR FOR SELECT ${sel.map((s, i) => `${s} AS ${rotulos[i]}`).join(', ')} FROM ${ident(e.tabela)} t WHERE ${e.onde} ORDER BY ${ordem}`, [empresaId]);
            let falhou = false;
            try {
                for (;;) {
                    conferirTempo();
                    const bloco = (await tx.query<Record<string, string | null>>(`FETCH ${lote} FROM exportacao_cursor`)).rows;
                    if (bloco.length === 0) break;
                    linhas += bloco.length;
                    if (linhas > limites.linhasPorArquivo) grandeDemais(`mais de ${limites.linhasPorArquivo} registros em ${e.arquivo}`);
                    let texto = '';
                    for (const l of bloco) {
                        const valores = rotulos.map((r) => l[r]);
                        texto += `${linhaCsv(valores, neutralizar)}\r\n`;
                        if (bin && valores[iArq]) esperado.set(valores[iArq] as string, valores[iSha] as string);
                    }
                    await somar(await g.escreverTexto(texto));
                }
            } catch (erro) {
                falhou = true;
                throw erro;
            } finally {
                // Com a transação já abortada (ex.: prazo do comando), o CLOSE falharia e esconderia a causa.
                await tx.query('CLOSE exportacao_cursor').catch((erro) => { if (!falhou) throw erro; });
            }
        } finally {
            const r = await g.fechar();
            const caminho = nomeArquivoCsv(e);
            entradas.push({ caminho, arquivo: g.arquivo, bytes: r.bytes, crc: r.crc, armazenar: false });
            arquivos.push({ caminho, tipo: 'csv', entidade: e.arquivo, tabela: e.tabela, grupo: e.grupo, descricao: e.descricao, linhas,
                colunas: cabecalho, colunasExcluidas: excluidas, bytes: r.bytes, sha256: r.sha256 });
        }
        linhasTotal += linhas;

        if (bin) {
            const col = `t.${ident(bin.coluna)}`;
            const total = Number((await tx.query<{ n: string }>(`SELECT coalesce(sum(octet_length(${col})), 0)::text AS n FROM ${ident(e.tabela)} t WHERE ${e.onde}`, [empresaId])).rows[0].n);
            if (bytes + total > limites.bytesTotal) grandeDemais(`mais de ${Math.round(limites.bytesTotal / 1024 / 1024)} MB`);
            if (entradas.length + esperado.size + 3 > MAXIMO_ENTRADAS_ZIP) grandeDemais(`mais de ${MAXIMO_ENTRADAS_ZIP} arquivos`);
            await tx.query(`DECLARE exportacao_binarios NO SCROLL CURSOR FOR SELECT t.id::text AS id, ${col} AS b FROM ${ident(e.tabela)} t WHERE ${e.onde} AND ${col} IS NOT NULL ORDER BY t.id`, [empresaId]);
            let vistos = 0;
            let falhou = false;
            try {
                for (;;) {
                    conferirTempo();
                    const d = (await tx.query<{ id: string; b: Buffer }>('FETCH 1 FROM exportacao_binarios')).rows[0];
                    if (!d) break;
                    const caminhoBin = `${bin.pasta}/${d.id}.${bin.extensao}`;
                    const gb = await Gravador.abrir(temporario());
                    await gb.escrever(d.b);
                    const r = await gb.fechar();
                    await somar(r.bytes);
                    // O hash calculado aqui tem de ser o mesmo que o banco calculou para o CSV (mesma fotografia).
                    if (esperado.get(caminhoBin) !== r.sha256) throw new Error(`exportação: hash divergente em ${caminhoBin}`);
                    entradas.push({ caminho: caminhoBin, arquivo: gb.arquivo, bytes: r.bytes, crc: r.crc, armazenar: true });
                    arquivos.push({ caminho: caminhoBin, tipo: 'pdf', tabela: e.tabela, grupo: e.grupo, bytes: r.bytes, sha256: r.sha256 });
                    vistos++;
                    pdfs++;
                }
            } catch (erro) {
                falhou = true;
                throw erro;
            } finally {
                await tx.query('CLOSE exportacao_binarios').catch((erro) => { if (!falhou) throw erro; });
            }
            if (vistos !== esperado.size) throw new Error('exportação: quantidade de PDFs divergente do CSV');
        }
    }
    const foraDoEscopo = Object.entries(FORA_DO_ESCOPO).filter(([t]) => esquema.colunas.has(t)).map(([tabela, motivo]) => ({ tabela, motivo }));
    return { dir, empresa: { id: empresa.id, codigo: empresa.codigo, nome: empresa.nome, situacao: empresa.status }, geradoEm: empresa.agora,
        arquivos, entradas, ausentes, foraDoEscopo, linhas: linhasTotal, bytes, pdfs };
}

async function gravarTexto(arquivo: string, texto: string) {
    const g = await Gravador.abrir(arquivo);
    await g.escreverTexto(texto);
    return { g, ...(await g.fechar()) };
}

async function sha256DoArquivo(arquivo: string) {
    const h = createHash('sha256');
    for await (const bloco of createReadStream(arquivo)) h.update(bloco as Buffer);
    return h.digest('hex');
}

/** Fase de montagem (fora da transação): LEIA-ME, MANIFESTO, SHA256SUMS e o ZIP em arquivo; apaga os temporários de dados. */
export async function montarPacote(d: DadosLidos, disco: Disco = DISCO_PADRAO): Promise<Omit<PacoteGerado, 'limpar'>> {
    if (await disco.livre(d.dir) < d.bytes + FOLGA_DISCO) semEspaco();
    const leiaMe = await gravarTexto(path.join(d.dir, 'leia-me.tmp'), `${BOM}${LEIA_ME({ empresa: d.empresa, geradoEm: d.geradoEm })}`);
    const arquivos = [...d.arquivos, { caminho: 'LEIA-ME.txt', tipo: 'texto' as const, bytes: leiaMe.bytes, sha256: leiaMe.sha256 }];
    const manifesto: Manifesto = {
        formato: FORMATO,
        versaoFormato: VERSAO_FORMATO,
        geradoEm: d.geradoEm,
        empresa: d.empresa,
        consistencia: 'Fotografia única do banco (transação REPEATABLE READ somente leitura): todos os arquivos refletem o mesmo instante (geradoEm).',
        hash: 'SHA-256 do conteúdo exato de cada arquivo, em hexadecimal minúsculo. O hash deste MANIFESTO.json está em SHA256SUMS.txt, na tela do download e na auditoria.',
        csv: {
            separador: ';', codificacao: 'UTF-8 com BOM', fimDeLinha: 'CRLF', aspas: 'RFC 4180 (aspas duplas dobradas)', nulo: 'célula vazia',
            formulas: "texto que começa com = + - @ (também depois de espaços, nas formas ＝＋－＠, ou tabulação/CR) recebe um apóstrofo (') na frente; números, datas e identificadores não",
            datas: 'UTC, texto do PostgreSQL (ex.: 2026-10-21 13:45:00+00)', listasEJson: 'texto JSON', booleanos: 'true/false',
            binarios: 'colunas <nome>__bytes e <nome>__sha256; o PDF dos contratos também em <nome>__arquivo (caminho no pacote)',
        },
        arquivos,
        entidadesAusentes: d.ausentes,
        foraDoEscopo: d.foraDoEscopo,
        totais: { arquivos: arquivos.length, linhas: d.linhas, bytes: arquivos.reduce((s, a) => s + a.bytes, 0), pdfs: d.pdfs },
    };
    const man = await gravarTexto(path.join(d.dir, 'manifesto.tmp'), `${JSON.stringify(manifesto, null, 2)}\n`);
    const somas = await gravarTexto(path.join(d.dir, 'somas.tmp'),
        [...arquivos.map((a) => `${a.sha256}  ${a.caminho}`), `${man.sha256}  MANIFESTO.json`].join('\n') + '\n');
    const zipCaminho = path.join(d.dir, 'pacote.zip');
    const zipBytes = await escreverZip([
        { caminho: 'MANIFESTO.json', arquivo: man.g.arquivo, bytes: man.bytes, crc: man.crc, armazenar: false },
        { caminho: 'SHA256SUMS.txt', arquivo: somas.g.arquivo, bytes: somas.bytes, crc: somas.crc, armazenar: false },
        { caminho: 'LEIA-ME.txt', arquivo: leiaMe.g.arquivo, bytes: leiaMe.bytes, crc: leiaMe.crc, armazenar: false },
        ...d.entradas,
    ], zipCaminho, new Date(Date.parse(d.geradoEm)));
    // Os temporários de dados não servem mais: só o ZIP fica até o envio.
    for (const e of [...d.entradas, { arquivo: man.g.arquivo }, { arquivo: somas.g.arquivo }, { arquivo: leiaMe.g.arquivo }]) await rm(e.arquivo, { force: true });
    const carimbo = d.geradoEm.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const codigo = d.empresa.codigo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'empresa';
    return { dir: d.dir, zipCaminho, zipBytes, zipSha256: await sha256DoArquivo(zipCaminho), manifesto, manifestoSha256: man.sha256,
        nomeArquivo: `kidmais-exportacao-${codigo}-${carimbo}.zip` };
}

/** limpar() idempotente da pasta temporária. */
export function limpadorDe(dir: string, depois?: () => void) {
    let feito = false;
    return async () => {
        if (feito) return;
        feito = true;
        try { await rm(dir, { recursive: true, force: true }); } finally { depois?.(); }
    };
}

/**
 * Atalho (testes e roteiros): lê na transação já aberta e monta o pacote numa pasta temporária nova. Em erro, a pasta
 * é apagada; em sucesso, quem chama apaga com `limpar()`.
 */
export async function gerarPacote(tx: DbExecutor, empresaId: string, opcoes: Opcoes & { base?: string } = {}): Promise<PacoteGerado> {
    const dir = await criarPastaTemporaria(opcoes.base);
    const limpar = limpadorDe(dir);
    try {
        const dados = await lerDados(tx, empresaId, dir, opcoes);
        return { ...(await montarPacote(dados, opcoes.disco)), limpar };
    } catch (erro) {
        await limpar();
        throw erro;
    }
}
