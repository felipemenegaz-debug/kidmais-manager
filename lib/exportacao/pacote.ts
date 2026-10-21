import { createHash } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { csv } from '../assinatura/csv.ts';
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO, type Entidade } from './entidades.ts';
import { montarZip, type EntradaZip } from './zip.ts';

/**
 * Pacote completo e verificável dos dados de UMA empresa (formato 1). Executa só leituras, dentro de uma transação
 * REPEATABLE READ READ ONLY aberta por quem chama (servico.ts): todos os arquivos refletem o mesmo instante.
 * Nada aqui decide quem pode exportar — a prova do tenant e a autorização ficam em guarda.ts.
 *
 * Conteúdo: dados/<grupo>/<entidade>.csv (um por tabela), arquivos/contratos/<documento>.pdf, LEIA-ME.txt,
 * MANIFESTO.json (versão, data, empresa, contagens, colunas e SHA-256 de cada arquivo) e SHA256SUMS.txt (formato do
 * sha256sum, inclui o MANIFESTO). Formato documentado em docs/EXPORTACAO_DADOS_20261021.md.
 */
export const FORMATO = 'kidmais-exportacao';
export const VERSAO_FORMATO = 1;

export type Limites = { linhasPorArquivo: number; bytesTotal: number; tempoMs: number };
/** Limites do pacote em memória (instância do Render): acima deles a exportação é recusada inteira, nunca truncada. */
export const LIMITES_PADRAO: Limites = { linhasPorArquivo: 200_000, bytesTotal: 150 * 1024 * 1024, tempoMs: 120_000 };

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
export type PacoteGerado = { zip: Buffer; manifesto: Manifesto; manifestoSha256: string; nomeArquivo: string };

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ident = (nome: string) => `"${nome.replace(/"/g, '""')}"`;
const nomeArquivoCsv = (e: Entidade) => `dados/${e.arquivo}.csv`;

type Coluna = { nome: string; tipo: string };

export function grandeDemais(detalhe: string): never {
    throw new PacoteAdminError('EXPORTACAO_GRANDE_DEMAIS',
        `Os dados desta empresa passam do limite da exportação em uma única vez (${detalhe}). Fale com o suporte para receber o pacote por outro meio.`, 413);
}
function demorada(): never {
    throw new PacoteAdminError('EXPORTACAO_DEMORADA', 'A exportação passou do tempo limite. Tente de novo em alguns minutos; se persistir, fale com o suporte.', 503);
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
const literal = (texto: string) => `'${texto.replace(/'/g, "''")}'`;

type Esquema = { colunas: Map<string, Coluna[]>; chaves: Map<string, string[]> };

async function lerEsquema(tx: DbExecutor, tabelas: readonly string[]): Promise<Esquema> {
    const colunas = new Map<string, Coluna[]>();
    for (const r of (await tx.query<{ tabela: string; nome: string; tipo: string }>(
        `SELECT c.table_name AS tabela, c.column_name AS nome, c.data_type AS tipo
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.table_name = ANY($1::text[])
          ORDER BY c.table_name, c.ordinal_position`, [tabelas])).rows) {
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
          ORDER BY c.relname, array_position(i.indkey::int2[], a.attnum)`, [tabelas])).rows) {
        const lista = chaves.get(r.tabela) ?? [];
        lista.push(r.coluna);
        chaves.set(r.tabela, lista);
    }
    return { colunas, chaves };
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
    "- Células de texto que começam com = + - @ recebem um apóstrofo (') na frente para o Excel não executar fórmulas;",
    '  o valor original é o texto sem esse apóstrofo.',
    '- Imagens, mídias do WhatsApp e outros arquivos binários aparecem só com tamanho e SHA-256 (veja o MANIFESTO).',
    '- Senhas, hashes de senha, códigos de links públicos, tokens e credenciais nunca entram no pacote.',
    '',
].join('\r\n');

/**
 * Gera o pacote. `tx` deve estar em REPEATABLE READ READ ONLY com TimeZone UTC (servico.ts). Recusa inteira (413/503)
 * acima dos limites; nunca entrega pacote parcial.
 */
export async function gerarPacote(tx: DbExecutor, empresaId: string, limites: Limites = LIMITES_PADRAO, relogio: () => number = Date.now): Promise<PacoteGerado> {
    const inicio = relogio();
    const conferirTempo = () => { if (relogio() - inicio > limites.tempoMs) demorada(); };
    const empresa = (await tx.query<{ id: string; codigo: string; nome: string; status: string; agora: string }>(
        `SELECT id::text AS id, codigo, nome, status, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS agora
           FROM empresas WHERE id = $1::uuid`, [empresaId])).rows[0];
    if (!empresa) throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403);
    const esquema = await lerEsquema(tx, [...new Set([...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)])]);

    const dados: EntradaZip[] = [];
    const binarios: EntradaZip[] = [];
    const arquivos: ArquivoManifesto[] = [];
    const ausentes: Manifesto['entidadesAusentes'] = [];
    let bytes = 0;
    let linhasTotal = 0;
    const somar = (n: number) => { bytes += n; if (bytes > limites.bytesTotal) grandeDemais(`mais de ${Math.round(limites.bytesTotal / 1024 / 1024)} MB`); };

    for (const e of ENTIDADES) {
        conferirTempo();
        const colunasTabela = esquema.colunas.get(e.tabela);
        if (!colunasTabela) { ausentes.push({ entidade: e.arquivo, tabela: e.tabela, motivo: 'tabela não existe neste ambiente (migration não aplicada)' }); continue; }
        const { exportadas, excluidas } = planejarColunas(e, colunasTabela);
        const { sel, cabecalho, neutralizar } = expressoes(e, exportadas);
        const chave = (esquema.chaves.get(e.tabela) ?? []).filter((c) => colunasTabela.some((x) => x.nome === c));
        const ordem = chave.length ? chave.map((c) => `t.${ident(c)}`).join(', ') : sel.map((_, i) => String(i + 1)).join(', ');
        const rotulos = sel.map((_, i) => `c${i}`);
        const linhas = (await tx.query<Record<string, string | null>>(
            `SELECT ${sel.map((s, i) => `${s} AS ${rotulos[i]}`).join(', ')} FROM ${ident(e.tabela)} t WHERE ${e.onde} ORDER BY ${ordem} LIMIT ${limites.linhasPorArquivo + 1}`,
            [empresaId])).rows;
        if (linhas.length > limites.linhasPorArquivo) grandeDemais(`mais de ${limites.linhasPorArquivo} registros em ${e.arquivo}`);
        const conteudo = Buffer.from(csv(cabecalho, linhas.map((l) => rotulos.map((r) => l[r])), neutralizar), 'utf8');
        somar(conteudo.length);
        linhasTotal += linhas.length;
        const caminho = nomeArquivoCsv(e);
        dados.push({ caminho, conteudo });
        arquivos.push({ caminho, tipo: 'csv', entidade: e.arquivo, tabela: e.tabela, grupo: e.grupo, descricao: e.descricao, linhas: linhas.length,
            colunas: cabecalho, colunasExcluidas: excluidas, bytes: conteudo.length, sha256: sha256(conteudo) });

        const bin = e.arquivoBinario;
        if (bin && exportadas.some((c) => c.nome === bin.coluna && c.tipo === 'bytea')) {
            const col = `t.${ident(bin.coluna)}`;
            const total = Number((await tx.query<{ n: string }>(`SELECT coalesce(sum(octet_length(${col})), 0)::text AS n FROM ${ident(e.tabela)} t WHERE ${e.onde}`, [empresaId])).rows[0].n);
            somar(total);
            const iSha = cabecalho.indexOf(`${bin.coluna}__sha256`), iArq = cabecalho.indexOf(`${bin.coluna}__arquivo`);
            const esperado = new Map(linhas.filter((l) => l[rotulos[iArq]]).map((l) => [l[rotulos[iArq]] as string, l[rotulos[iSha]] as string]));
            const docs = (await tx.query<{ id: string; b: Buffer }>(
                `SELECT t.id::text AS id, ${col} AS b FROM ${ident(e.tabela)} t WHERE ${e.onde} AND ${col} IS NOT NULL ORDER BY t.id`, [empresaId])).rows;
            for (const d of docs) {
                conferirTempo();
                const caminhoBin = `${bin.pasta}/${d.id}.${bin.extensao}`;
                const hash = sha256(d.b);
                // O hash calculado aqui tem de ser o mesmo que o banco calculou para o CSV (mesma fotografia).
                if (esperado.get(caminhoBin) !== hash) throw new Error(`exportação: hash divergente em ${caminhoBin}`);
                binarios.push({ caminho: caminhoBin, conteudo: d.b });
                arquivos.push({ caminho: caminhoBin, tipo: 'pdf', tabela: e.tabela, grupo: e.grupo, bytes: d.b.length, sha256: hash });
            }
            if (docs.length !== esperado.size) throw new Error('exportação: quantidade de PDFs divergente do CSV');
        }
    }

    const geradoEm = empresa.agora;
    const empresaManifesto = { id: empresa.id, codigo: empresa.codigo, nome: empresa.nome, situacao: empresa.status };
    const leiaMe = Buffer.from(`${String.fromCharCode(0xfeff)}${LEIA_ME({ empresa: empresaManifesto, geradoEm })}`, 'utf8');
    arquivos.push({ caminho: 'LEIA-ME.txt', tipo: 'texto', bytes: leiaMe.length, sha256: sha256(leiaMe) });
    const pdfs = binarios.length;
    const manifesto: Manifesto = {
        formato: FORMATO,
        versaoFormato: VERSAO_FORMATO,
        geradoEm,
        empresa: empresaManifesto,
        consistencia: 'Fotografia única do banco (transação REPEATABLE READ somente leitura): todos os arquivos refletem o mesmo instante (geradoEm).',
        hash: 'SHA-256 do conteúdo exato de cada arquivo, em hexadecimal minúsculo. O hash deste MANIFESTO.json está em SHA256SUMS.txt, na tela do download e na auditoria.',
        csv: {
            separador: ';', codificacao: 'UTF-8 com BOM', fimDeLinha: 'CRLF', aspas: 'RFC 4180 (aspas duplas dobradas)', nulo: 'célula vazia',
            formulas: "texto que começa com = + - @ (ou tabulação/CR) recebe um apóstrofo (') na frente; números, datas e identificadores não",
            datas: 'UTC, texto do PostgreSQL (ex.: 2026-10-21 13:45:00+00)', listasEJson: 'texto JSON', booleanos: 'true/false',
            binarios: 'colunas <nome>__bytes e <nome>__sha256; o PDF dos contratos também em <nome>__arquivo (caminho no pacote)',
        },
        arquivos,
        entidadesAusentes: ausentes,
        foraDoEscopo: Object.entries(FORA_DO_ESCOPO).filter(([t]) => esquema.colunas.has(t)).map(([tabela, motivo]) => ({ tabela, motivo })),
        totais: { arquivos: arquivos.length, linhas: linhasTotal, bytes: arquivos.reduce((s, a) => s + a.bytes, 0), pdfs },
    };
    const manifestoBuf = Buffer.from(`${JSON.stringify(manifesto, null, 2)}\n`, 'utf8');
    const manifestoSha256 = sha256(manifestoBuf);
    const somas = Buffer.from([...arquivos.map((a) => `${a.sha256}  ${a.caminho}`), `${manifestoSha256}  MANIFESTO.json`].join('\n') + '\n', 'utf8');
    const zip = montarZip([
        { caminho: 'MANIFESTO.json', conteudo: manifestoBuf },
        { caminho: 'SHA256SUMS.txt', conteudo: somas },
        { caminho: 'LEIA-ME.txt', conteudo: leiaMe },
        ...dados,
        ...binarios,
    ], new Date(Date.parse(geradoEm)));
    const carimbo = geradoEm.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const codigo = empresa.codigo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'empresa';
    return { zip, manifesto, manifestoSha256, nomeArquivo: `kidmais-exportacao-${codigo}-${carimbo}.zip` };
}
