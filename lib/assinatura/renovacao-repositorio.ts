import type { DbExecutor } from '../db/contracts';
import type { CapacidadeRenovacao, ContextoRenovacao, RegistroRenovacao, RepositorioRenovacao } from './renovacao-fundador.ts';
import { AVISO_FUNDADOR_DIAS } from './renovacao-fundador.ts';

type Transacao = <T>(f: (tx: DbExecutor) => Promise<T>) => Promise<T>;
const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CAMPOS = `id, empresa_id AS "empresaId", contratacao_id AS "contratacaoId", destinatario_id AS "destinatarioId",
    primeiro_vencimento::text AS "primeiroVencimento", primeira_data_regular::text AS "primeiraDataRegular", mensagem, estado,
    ${ISO('aviso_tentado_em')} AS "avisoTentadoEm", ${ISO('aviso_enviado_em')} AS "avisoEnviadoEm",
    ${ISO('preco_aplicado_em')} AS "precoAplicadoEm", ultimo_erro AS "ultimoErro"`;
/** 109: a projeção do vínculo só depois da classificação do schema; com a 075 a coluna nunca é citada. */
const camposDe = (capacidade: CapacidadeRenovacao) => capacidade === '109' ? `${CAMPOS}, (substitui_id IS NOT NULL) AS substituto` : CAMPOS;
/** Registro vigente: comparação de texto válida nos dois schemas (075 nunca tem SUBSTITUIDA). */
const VIGENTE = "estado <> 'SUBSTITUIDA'";

export async function renovacaoInstalada(tx: DbExecutor) {
    return (await tx.query<{ instalada075: boolean }>("SELECT to_regclass('public.assinatura_renovacoes') IS NOT NULL AS instalada075")).rows[0]?.instalada075 === true;
}

export function repositorioRenovacao(withTransaction: Transacao, opcoes: { capacidade?: CapacidadeRenovacao } = {}): RepositorioRenovacao {
    const capacidade = opcoes.capacidade ?? '075';
    const campos = camposDe(capacidade);
    const repo: RepositorioRenovacao = {
        ler: empresaId => withTransaction(async tx => {
            if (!await renovacaoInstalada(tx)) return null;
            const c = (await tx.query<Omit<ContextoRenovacao,'registro'>>(`SELECT a.empresa_id AS "empresaId", c.id AS "contratacaoId",
                a.situacao, (e.status = 'ATIVA') AS "empresaAtiva", EXISTS (SELECT 1 FROM assinatura_isencoes i WHERE i.empresa_id = a.empresa_id) AS isenta,
                a.provedor_assinatura_id AS "assinaturaId", a.provedor_cliente_id AS "clienteId", c.ciclo, c.plano,
                c.valor_final_centavos AS "valorFinal", c.valor_regular_centavos AS "valorRegular",
                ${ISO('f.beneficio_fim')} AS "beneficioFim", c.pagamento_confirmacao_id AS "primeiroPagamentoId",
                c.criada_por AS "destinatarioId", u.email,
                (u.ativo AND EXISTS (SELECT 1 FROM memberships m WHERE m.empresa_id = a.empresa_id AND m.usuario_id = u.id
                    AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO')) AS "destinatarioValido"
                FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
                JOIN assinatura_contratacoes c ON c.empresa_id = a.empresa_id AND c.id = a.contratacao_atual_id
                JOIN assinatura_fundadores f ON f.empresa_id = c.empresa_id AND f.id = c.fundador_id
                JOIN usuarios_administrativos u ON u.id = c.criada_por
                WHERE a.empresa_id = $1::uuid AND c.estado = 'CONFIRMADA' AND f.estado = 'CONFIRMADA'`, [empresaId])).rows[0];
            if (!c) return null;
            const registro = (await tx.query<RegistroRenovacao>(`SELECT ${campos} FROM assinatura_renovacoes WHERE empresa_id = $1::uuid AND contratacao_id = $2::uuid AND ${VIGENTE}`, [empresaId,c.contratacaoId])).rows[0] ?? null;
            return { ...c, registro };
        }),
        /**
         * R2-F1 (plano rev. 5 §2.6): lê o vigente ANTES de inserir, sob a trava de linha da empresa (espera). Histórico sem
         * vigente nunca ganha raiz nova. Só sem linha alguma: INSERT com ON CONFLICT sem alvo (UNIQUE da 075 ou índice parcial
         * da 109). Sem nenhuma serialização, a 109 pode recusar a raiz paralela com exceção (interleaving b): segurança, não
         * idempotência.
         */
        criar: r => withTransaction(async tx => {
            await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [r.empresaId]);
            const vigente = async () => (await tx.query<RegistroRenovacao>(`SELECT ${campos} FROM assinatura_renovacoes WHERE empresa_id = $1::uuid AND contratacao_id = $2::uuid AND ${VIGENTE}`, [r.empresaId,r.contratacaoId])).rows[0];
            const existente = await vigente();
            if (existente) return existente;
            const historico = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM assinatura_renovacoes WHERE empresa_id = $1::uuid AND contratacao_id = $2::uuid', [r.empresaId,r.contratacaoId])).rows[0]?.n ?? 0;
            if (historico > 0) throw new Error('HISTORICO_SEM_VIGENTE');
            await tx.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
                VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::date,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
                [r.id,r.empresaId,r.contratacaoId,r.destinatarioId,r.primeiroVencimento,r.primeiraDataRegular,AVISO_FUNDADOR_DIAS,JSON.stringify(r.mensagem)]);
            const row = await vigente();
            if (!row) throw new Error('Registro de renovação não persistido.');
            return row;
        }),
        marcar: (empresaId,id,a) => withTransaction(async tx => {
            await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
            const r = await tx.query(`UPDATE assinatura_renovacoes SET estado = $3, ultimo_erro = $4,
                aviso_tentado_em = CASE WHEN $5 THEN COALESCE(aviso_tentado_em,clock_timestamp()) ELSE aviso_tentado_em END,
                aviso_enviado_em = CASE WHEN $6::text IS NOT NULL THEN COALESCE(aviso_enviado_em,clock_timestamp()) ELSE aviso_enviado_em END,
                aviso_id_externo = COALESCE(aviso_id_externo,$6::text),
                preco_aplicado_em = CASE WHEN $7 THEN COALESCE(preco_aplicado_em,clock_timestamp()) ELSE preco_aplicado_em END
                WHERE empresa_id = $1::uuid AND id = $2::uuid RETURNING id`, [empresaId,id,a.estado,a.erro ?? null,a.tentativa ?? false,a.envioId ?? null,a.regular ?? false]);
            if (r.rowCount !== 1) throw new Error('Registro de renovação não encontrado.');
        }),
    };
    if (capacidade === '109') repo.substituir = (empresaId, anterior, sucessor) => withTransaction(tx => substituirRenovacao(tx, empresaId, anterior, sucessor));
    return repo;
}

/**
 * 109: predecessor PENDENTE sem tentativa → SUBSTITUIDA e INSERT do sucessor, na MESMA transação (o gatilho diferido exige o
 * sucessor no COMMIT). UPDATE condicional com rowCount conferido; zero linhas lança SUBSTITUICAO_RECUSADA antes do INSERT.
 * Exportada para a prova da fronteira (controle × mutante) sem a conversão do resultado.
 */
export async function substituirRenovacao(tx: DbExecutor, empresaId: string, anterior: RegistroRenovacao, sucessor: RegistroRenovacao) {
    await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
    await tx.query('SELECT id FROM assinatura_renovacoes WHERE empresa_id = $1::uuid AND id = $2::uuid FOR UPDATE', [empresaId, anterior.id]);
    const u = await tx.query(`UPDATE assinatura_renovacoes SET estado = 'SUBSTITUIDA'
        WHERE empresa_id = $1::uuid AND id = $2::uuid AND contratacao_id = $3::uuid AND estado = 'PENDENTE' AND aviso_tentado_em IS NULL`,
        [empresaId, anterior.id, anterior.contratacaoId]);
    if (u.rowCount !== 1) throw new Error('SUBSTITUICAO_RECUSADA');
    await tx.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem,substitui_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::date,$7,$8::jsonb,$9::uuid)`,
        [sucessor.id, empresaId, anterior.contratacaoId, sucessor.destinatarioId, anterior.primeiroVencimento, sucessor.primeiraDataRegular,
            AVISO_FUNDADOR_DIAS, JSON.stringify(sucessor.mensagem), anterior.id]);
    const row = (await tx.query<RegistroRenovacao>(`SELECT ${camposDe('109')} FROM assinatura_renovacoes WHERE empresa_id = $1::uuid AND id = $2::uuid`, [empresaId, sucessor.id])).rows[0];
    if (!row) throw new Error('Sucessor da renovação não persistido.');
    return row;
}

/** DTO da tela: nunca expõe destinatário, mensagem completa ou erro interno. */
export async function consultarRenovacao(tx: DbExecutor, empresaId: string) {
    if (!await renovacaoInstalada(tx)) return null;
    return (await tx.query<{ estado: string; dataRegular: string; valorRegular: number; avisoEnviado: boolean; ciclo: string }>(`SELECT r.estado,
        r.primeira_data_regular::text AS "dataRegular", c.valor_regular_centavos AS "valorRegular", c.ciclo,
        (r.aviso_enviado_em IS NOT NULL) AS "avisoEnviado" FROM assinatura_renovacoes r
        JOIN empresa_assinaturas a ON a.empresa_id = r.empresa_id AND a.contratacao_atual_id = r.contratacao_id
        JOIN assinatura_contratacoes c ON c.id = r.contratacao_id AND c.empresa_id = r.empresa_id
        WHERE r.empresa_id = $1::uuid AND r.${VIGENTE}`, [empresaId])).rows[0] ?? null;
}

export async function empresasParaRenovacao(tx: DbExecutor) {
    if (!await renovacaoInstalada(tx)) throw new Error('Migration 075 não instalada.');
    return (await tx.query<{ empresa_id: string }>(`SELECT a.empresa_id FROM empresa_assinaturas a
        JOIN assinatura_contratacoes c ON c.id = a.contratacao_atual_id AND c.empresa_id = a.empresa_id
        WHERE c.fundador_id IS NOT NULL AND c.estado = 'CONFIRMADA' ORDER BY a.empresa_id`)).rows.map(r => r.empresa_id);
}
