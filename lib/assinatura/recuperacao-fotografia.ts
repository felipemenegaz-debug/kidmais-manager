import type { DbExecutor } from '../db/contracts';
import { TABELAS, type Fotografia, type Linha } from './recuperacao-efeitos.ts';

/**
 * B-14 (plano rev. 8.1, §3.3, §3.4): fotografia das linhas de cobrança de UMA empresa, para a diferença antes/depois do
 * caso. Só leitura. Tabela ausente (schema antigo, prefixos da §3.5) fica de fora sem erro. Ordem determinística.
 */
const FILTROS: Record<string, string> = {
    empresa_assinaturas: 'empresa_id = $1::uuid',
    assinatura_contratacoes: 'empresa_id = $1::uuid',
    assinatura_fundadores: 'empresa_id = $1::uuid',
    assinatura_encerramentos: 'empresa_id = $1::uuid',
    assinatura_arrependimentos: 'empresa_id = $1::uuid',
    cobranca_eventos: 'empresa_id = $1::uuid OR id = ANY($2::uuid[])',
    auditoria: 'entidade_id = $1::uuid',
    ia_credito_pedidos: 'empresa_id = $1::uuid',
    ia_credito_cobrancas: 'empresa_id = $1::uuid',
    ia_credito_carteiras: 'empresa_id = $1::uuid',
    ia_credito_lotes: 'empresa_id = $1::uuid',
    ia_credito_lancamentos: 'empresa_id = $1::uuid',
    ia_credito_devolucoes: 'empresa_id = $1::uuid',
    ia_credito_notificacoes: 'empresa_id = $1::uuid',
};

/**
 * Colunas de texto livre que NÃO entram na fotografia (revisão de 27/10, P3-6: minimização na origem). A omissão não esconde
 * escrita: `motivo` é imutável pelo gatilho da 097; as referências só mudam junto de colunas que continuam na fotografia
 * (`intermediador_comunicado_em`, `situacao`/`concluido_em`).
 */
const OMITIDAS: Record<string, readonly string[]> = {
    assinatura_arrependimentos: ['motivo', 'intermediador_referencia', 'conclusao_referencia'],
};

export async function tabelasPresentes(tx: DbExecutor): Promise<string[]> {
    const nomes = Object.keys(TABELAS);
    const r = await tx.query<{ nome: string }>(`SELECT nome FROM unnest($1::text[]) AS nome WHERE to_regclass('public.' || nome) IS NOT NULL ORDER BY nome`, [nomes]);
    return r.rows.map((l) => l.nome);
}

export async function fotografar(tx: DbExecutor, alvo: { empresaId: string; eventoIds?: readonly string[] }, presentes?: readonly string[]): Promise<Fotografia> {
    const foto: Fotografia = {};
    for (const tabela of presentes ?? await tabelasPresentes(tx)) {
        const filtro = FILTROS[tabela];
        if (!filtro) continue;
        // Nome da tabela vem só da lista fechada acima (nunca de entrada externa).
        // Só o filtro dos eventos usa $2: o PostgreSQL recusa parâmetro a mais no comando preparado.
        const params: unknown[] = filtro.includes('$2') ? [alvo.empresaId, [...(alvo.eventoIds ?? [])]] : [alvo.empresaId];
        const fora = OMITIDAS[tabela] ? ` - ARRAY[${OMITIDAS[tabela].map((c) => `'${c}'`).join(', ')}]::text[]` : '';
        const r = await tx.query<{ l: Linha }>(`SELECT to_jsonb(t)${fora} AS l FROM public.${tabela} t WHERE ${filtro} ORDER BY (to_jsonb(t)${fora})::text`, params);
        foto[tabela] = r.rows.map((x) => x.l);
    }
    return foto;
}

/** Colunas comerciais do instante que a aplicação pode regravar (lista fechada, §3.4). */
const REGRAVAVEIS: Record<string, readonly string[]> = { empresa_assinaturas: TABELAS.empresa_assinaturas.doInstante ?? [] };

/**
 * Regrava os valores comerciais aprovados (D-B14-7: nunca recalculados de agora) depois de o processamento normal rodar
 * em T2. Só grava com mudança (§3.3.1). A diferença final é comparada com a proposta aprovada por quem chama.
 */
export async function regravarDoInstante(tx: DbExecutor, valores: readonly { tabela: string; chave: string; coluna: string; valor: unknown }[]) {
    for (const v of valores) {
        if (!REGRAVAVEIS[v.tabela]?.includes(v.coluna) || typeof v.valor !== 'string') throw new Error(`Valor do instante não regravável: ${v.tabela}.${v.coluna}`);
        await tx.query(`UPDATE empresa_assinaturas SET ${v.coluna} = $2::timestamptz WHERE empresa_id = $1::uuid AND ${v.coluna} IS DISTINCT FROM $2::timestamptz`,
            [v.chave, v.valor]);
    }
}
