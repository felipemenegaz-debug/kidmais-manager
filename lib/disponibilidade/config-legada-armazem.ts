import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DbExecutor } from '../db/contracts.ts';
import { AvailabilityServiceError } from './services/errors.ts';

/**
 * Onde moram as regras e descontos legados da agenda pública (E2, `lib/disponibilidade/config-legada.ts`).
 *
 * Até a 128 eram o arquivo `data/disponibilidade.json`, no disco persistente do web. A 128 cria
 * `disponibilidade_config_legada` (uma linha) para o disco poder sair (vault "Convites geracao sobrevive ao deploy
 * 20261120", fase 2). Ordem de leitura:
 *   1. 128 aplicada e linha presente: o banco;
 *   2. senão, o arquivo (disco ainda montado, ou ambiente local);
 *   3. sem arquivo: listas vazias.
 * Gravação: com a 128, sempre no banco (a primeira gravação parte do arquivo, se a linha ainda não existir); sem a 128,
 * no arquivo, como antes. Na leitura para gravar (`travar`), a linha do banco também é conferida sem tolerância (item que
 * não é objeto = 409 CONFIG_LEGADA_ILEGIVEL). Sem a linha (com ou sem a 128), o arquivo é a única fonte e é lido sem
 * tolerância: ilegível, com campo que não é lista ou com item que não é objeto é recusado (gravar listas vazias
 * ou cortadas apagaria as regras); ausente só é aceito fora da Render (ambiente local sem arquivo).
 * A leitura comum continua tolerante (agenda pública não cai por arquivo ruim): campo que não é lista vira [] e item que
 * não é objeto é descartado, preservando os itens válidos. A cópia única do disco para o banco é `scripts/disco-para-banco-128.cjs`.
 */
export type ConfigLegada = {
    pacoteOverrides: Array<Record<string, unknown>>;
    descontos: Array<Record<string, unknown>>;
};

export function arquivoConfigLegada(cwd = process.cwd()) {
    return path.join(cwd, 'data', 'disponibilidade.json');
}

const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CAMPOS = ['pacoteOverrides', 'descontos'] as const;

/** Tolerante (leitura): campo que não é lista vira []; item que não é objeto sai. */
function normalizar(bruto: unknown): ConfigLegada {
    const config = (objeto(bruto) ? bruto : {}) as Record<string, unknown>;
    const lista = (v: unknown) => (Array.isArray(v) ? v.filter(objeto) : []);
    return { pacoteOverrides: lista(config.pacoteOverrides), descontos: lista(config.descontos) };
}

/** Estrito (base de gravação): campo presente que não é lista, ou item que não é objeto, é recusado. Ausente = []. */
function conferirForma(bruto: unknown): ConfigLegada | null {
    if (!objeto(bruto)) return null;
    for (const campo of CAMPOS) {
        const v = bruto[campo];
        if (v === undefined) continue;
        if (!Array.isArray(v) || !v.every(objeto)) return null;
    }
    return normalizar(bruto);
}

async function lerArquivo(arquivo: string): Promise<ConfigLegada> {
    try {
        return normalizar(JSON.parse(await fs.readFile(arquivo, 'utf8')));
    } catch {
        return { pacoteOverrides: [], descontos: [] };
    }
}

const recusa = (code: string) => new AvailabilityServiceError(code,
    'As regras comerciais da agenda pública não puderam ser lidas da origem salva. Nada foi gravado; avise o suporte.', 409);

/** Base da primeira gravação no banco: o arquivo, sem tolerância. */
async function lerArquivoParaGravar(arquivo: string, env: Record<string, string | undefined>): Promise<ConfigLegada> {
    let texto: string;
    try {
        texto = await fs.readFile(arquivo, 'utf8');
    } catch (e) {
        if ((e as { code?: string })?.code === 'ENOENT' && env.RENDER !== 'true') return { pacoteOverrides: [], descontos: [] };
        throw recusa((e as { code?: string })?.code === 'ENOENT' ? 'CONFIG_LEGADA_AUSENTE' : 'CONFIG_LEGADA_ILEGIVEL');
    }
    let bruto: unknown;
    try { bruto = JSON.parse(texto); } catch { throw recusa('CONFIG_LEGADA_ILEGIVEL'); }
    const config = conferirForma(bruto);
    if (!config) throw recusa('CONFIG_LEGADA_ILEGIVEL');
    return config;
}

export async function tabelaConfigLegadaInstalada(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>(
        "SELECT to_regclass('public.disponibilidade_config_legada') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

/** Lê a configuração legada (banco, depois arquivo). `travar` segura a linha até o fim da transação (gravação). */
export async function lerConfigLegada(tx: DbExecutor,
    opcoes: { arquivo?: string; travar?: boolean; env?: Record<string, string | undefined> } = {}): Promise<ConfigLegada> {
    const arquivo = opcoes.arquivo ?? arquivoConfigLegada();
    if (await tabelaConfigLegadaInstalada(tx)) {
        const linha = (await tx.query<{ conteudo: unknown }>(
            `SELECT conteudo FROM disponibilidade_config_legada WHERE id = 1${opcoes.travar ? ' FOR UPDATE' : ''}`)).rows[0];
        if (linha) {
            if (!opcoes.travar) return normalizar(linha.conteudo);
            // Base de gravação: a linha sem tolerância (a 128 confere o tipo das listas, não o dos itens). Item que não é
            // objeto é recusado, para a edição seguinte não gravar o descarte por cima.
            const config = conferirForma(linha.conteudo);
            if (!config) throw recusa('CONFIG_LEGADA_ILEGIVEL');
            return config;
        }
    }
    // Sem linha (com a 128 a gravação vai para o banco; sem ela, regrava o arquivo): a base da gravação é o arquivo real,
    // sem tolerância. Só a leitura comum aceita arquivo ruim como vazio.
    if (opcoes.travar) return lerArquivoParaGravar(arquivo, opcoes.env ?? process.env);
    return lerArquivo(arquivo);
}

/** Grava a configuração legada: no banco com a 128; sem ela, no arquivo (comportamento anterior). */
export async function salvarConfigLegada(tx: DbExecutor, config: ConfigLegada, opcoes: { arquivo?: string } = {}) {
    const conteudo = normalizar(JSON.parse(JSON.stringify(config)));
    if (await tabelaConfigLegadaInstalada(tx)) {
        await tx.query(
            `INSERT INTO disponibilidade_config_legada (id, conteudo, origem, atualizado_em)
             VALUES (1, $1::jsonb, 'PAINEL', clock_timestamp())
             ON CONFLICT (id) DO UPDATE SET conteudo = EXCLUDED.conteudo, origem = 'PAINEL', atualizado_em = clock_timestamp()`,
            [JSON.stringify(conteudo)]);
        return 'BANCO' as const;
    }
    const arquivo = opcoes.arquivo ?? arquivoConfigLegada();
    await fs.mkdir(path.dirname(arquivo), { recursive: true });
    await fs.writeFile(arquivo, JSON.stringify(conteudo, null, 2), 'utf8');
    return 'ARQUIVO' as const;
}
