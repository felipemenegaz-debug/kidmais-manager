/**
 * SQL dos avisos da assinatura (087). Sem a 087 instalada tudo é no-op: `avisosInstalados` = false.
 *   - destinatários = pessoas ATIVAS da Gestão (membership ATIVA, papel REPRESENTANTE_AUTORIZADO, usuário ativo);
 *   - enfileirar = INSERT … ON CONFLICT (empresa, tipo, marco, pessoa) DO NOTHING — idempotente;
 *   - registrarAvisosDaTransicao: chamado por sincronizarEmpresa NA MESMA transação da mudança gravada, dentro de um
 *     SAVEPOINT com erro engolido: falha de aviso nunca desfaz nem bloqueia a sincronização da cobrança. Só grava a
 *     intenção; o envio é posterior (after do webhook ou job diário).
 * Nenhuma leitura devolve senha, documento ou valores; o e-mail só sai na mensagem gravada.
 */
import type { DbExecutor } from '../db/contracts';
import { origemPublica } from '../acessos/email.ts';
import { prazosDeAcesso } from './configuracao.ts';
import { lerEstadoComercial } from './estado.ts';
import { avisosDaTransicao, avisosLigados, LIMITE_DESTINATARIOS, type EstadoTransicao } from './avisos.ts';
import { contextoElegivel, novosAvisos, type AlteracaoAviso, type AvisoGravado, type ContextoAviso, type NovoAviso, type RepositorioAvisos } from './avisos-envio.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';

type Transacao = <T>(f: (tx: DbExecutor) => Promise<T>) => Promise<T>;
const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CAMPOS = `id::text AS id, empresa_id::text AS "empresaId", tipo, ${ISO('marco')} AS marco, destinatario_id::text AS "destinatarioId",
    mensagem, estado, ${ISO('tentado_em')} AS "tentadoEm", ${ISO('enviado_em')} AS "enviadoEm", id_externo AS "idExterno",
    ultimo_erro AS "ultimoErro", ${ISO('criado_em')} AS "criadoEm"`;

export async function avisosInstalados(tx: DbExecutor) {
    return (await tx.query<{ instalada087: boolean }>("SELECT to_regclass('public.assinatura_avisos') IS NOT NULL AS instalada087")).rows[0]?.instalada087 === true;
}

export async function gestaoDaEmpresa(tx: DbExecutor, empresaId: string) {
    return (await tx.query<{ id: string; email: string }>(
        `SELECT u.id::text AS id, u.email FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo
          ORDER BY m.criado_em, u.id LIMIT ${LIMITE_DESTINATARIOS}`, [empresaId])).rows;
}

export async function contextoAviso(tx: DbExecutor, empresaId: string): Promise<ContextoAviso | null> {
    const e = (await tx.query<{ nome: string; ativa: boolean }>('SELECT nome, (status = \'ATIVA\') AS ativa FROM empresas WHERE id = $1::uuid', [empresaId])).rows[0];
    if (!e)
        return null;
    const estado = await lerEstadoComercial(tx, empresaId);
    return { empresaId, empresa: e.nome, empresaAtiva: e.ativa, assinatura: estado.assinatura, excecoes: estado.excecoes, agora: estado.agora, gestao: await gestaoDaEmpresa(tx, empresaId) };
}

export async function inserirAviso(tx: DbExecutor, n: NovoAviso) {
    const r = await tx.query<{ id: string }>(
        `INSERT INTO assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem)
         VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::uuid, $6::jsonb)
         ON CONFLICT ON CONSTRAINT assinatura_avisos_087_um_por_evento DO NOTHING RETURNING id`,
        [n.id, n.empresaId, n.tipo, n.marco, n.destinatarioId, JSON.stringify(n.mensagem)]);
    return r.rows.length === 1;
}

export function repositorioAvisos(withTransaction: Transacao): RepositorioAvisos {
    return {
        instalado: () => withTransaction(avisosInstalados),
        empresas: () => withTransaction(async (tx) => (await tx.query<{ empresa_id: string }>(
            `SELECT a.empresa_id::text AS empresa_id FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
              WHERE e.status = 'ATIVA' ORDER BY a.empresa_id`)).rows.map((r) => r.empresa_id)),
        contexto: (empresaId) => withTransaction((tx) => contextoAviso(tx, empresaId)),
        enfileirar: (n) => withTransaction((tx) => inserirAviso(tx, n)),
        pendentes: (limite, empresaId) => withTransaction(async (tx) => (await tx.query<{ id: string }>(
            `SELECT id::text AS id FROM assinatura_avisos WHERE estado IN ('PENDENTE','ENVIANDO') AND ($2::uuid IS NULL OR empresa_id = $2::uuid)
              ORDER BY criado_em, id LIMIT $1`, [limite, empresaId ?? null])).rows.map((r) => r.id)),
        ler: (id) => withTransaction(async (tx) => {
            const aviso = (await tx.query<AvisoGravado>(`SELECT ${CAMPOS} FROM assinatura_avisos WHERE id = $1::uuid`, [id])).rows[0];
            return aviso ? { aviso, contexto: await contextoAviso(tx, aviso.empresaId) } : null;
        }),
        marcar: (id, a: AlteracaoAviso) => withTransaction(async (tx) => {
            const r = await tx.query(`UPDATE assinatura_avisos SET estado = $2, ultimo_erro = $3,
                tentado_em = CASE WHEN $4 THEN COALESCE(tentado_em, clock_timestamp()) ELSE tentado_em END,
                enviado_em = CASE WHEN $5::text IS NOT NULL THEN COALESCE(enviado_em, clock_timestamp()) ELSE enviado_em END,
                id_externo = COALESCE(id_externo, $5::text)
                WHERE id = $1::uuid RETURNING id`, [id, a.estado, a.erro ?? null, a.tentativa ?? false, a.envioId ?? null]);
            if (r.rowCount !== 1)
                throw new Error('Aviso da assinatura não encontrado.');
        }),
    };
}

export type OpcoesTransicao = { env?: Record<string, string | undefined>; origem?: () => string; gerarId?: () => string };

/**
 * Intenção dos avisos de PAGAMENTO_CONFIRMADO / CANCELAMENTO_CONFIRMADO, na transação de sincronizarEmpresa.
 * Desligado (ASSINATURA_AVISOS_EMAIL) ou sem mudança relevante: nenhuma consulta. Qualquer erro: SAVEPOINT desfeito,
 * aviso registrado em log sem dados, sincronização segue. Devolve quantos avisos foram criados.
 */
export async function registrarAvisosDaTransicao(tx: DbExecutor, empresaId: string, antes: EstadoTransicao, depois: EstadoTransicao, o: OpcoesTransicao = {}) {
    const env = o.env ?? process.env;
    if (!avisosLigados(env))
        return 0;
    await tx.query('SAVEPOINT kidmais_avisos_assinatura');
    try {
        const prazos = prazosDeAcesso(env);
        const marcos = avisosDaTransicao(antes, depois, prazos);
        let criados = 0;
        if (marcos.length && await avisosInstalados(tx)) {
            const c = await contextoAviso(tx, empresaId);
            if (contextoElegivel(c))
                for (const n of novosAvisos(c, marcos, (o.origem ?? origemPublica)(), prazos, o.gerarId))
                    if (await inserirAviso(tx, n)) criados++;
        }
        await tx.query('RELEASE SAVEPOINT kidmais_avisos_assinatura');
        return criados;
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_avisos_assinatura');
        await tx.query('RELEASE SAVEPOINT kidmais_avisos_assinatura');
        console.warn('[avisos da assinatura] intenção não registrada; a sincronização segue', error instanceof Error ? error.name : typeof error);
        return 0;
    }
}

export type ResultadoDevolucao = 'AVISO_DEVOLVIDO' | 'AVISO_JA_DEVOLVIDO' | 'AVISO_NAO_ELEGIVEL' | 'DESCONHECIDO' | 'AMBIGUO';

/** Falha de entrega informada pelo webhook do Resend: só ENVIADO → DEVOLVIDO, idempotente. Sem a 087: DESCONHECIDO. */
export async function registrarDevolucaoAviso(tx: DbExecutor, entrada: { idExterno: string; motivo: string; eventoId: string }): Promise<ResultadoDevolucao> {
    if (!await avisosInstalados(tx))
        return 'DESCONHECIDO';
    const achados = (await tx.query<{ id: string; empresaId: string; estado: string; tipo: string }>(
        'SELECT id::text AS id, empresa_id::text AS "empresaId", estado, tipo FROM assinatura_avisos WHERE id_externo = $1 LIMIT 2 FOR UPDATE', [entrada.idExterno])).rows;
    if (achados.length === 0)
        return 'DESCONHECIDO';
    if (achados.length > 1)
        return 'AMBIGUO';
    const a = achados[0];
    if (a.estado === 'DEVOLVIDO')
        return 'AVISO_JA_DEVOLVIDO';
    if (a.estado !== 'ENVIADO')
        return 'AVISO_NAO_ELEGIVEL';
    const r = await tx.query(`UPDATE assinatura_avisos SET estado = 'DEVOLVIDO', ultimo_erro = $2 WHERE id = $1::uuid AND estado = 'ENVIADO' RETURNING id`, [a.id, entrada.motivo]);
    if (r.rowCount !== 1)
        return 'AVISO_NAO_ELEGIVEL';
    await auditarCobranca(tx, {
        acao: 'AVISO_ASSINATURA_ENTREGA_FALHOU', empresaId: a.empresaId, origem: { tipo: 'WEBHOOK', eventoId: entrada.eventoId.slice(0, 120) },
        antes: { estado: 'ENVIADO' }, depois: { avisoId: a.id, tipo: a.tipo, estado: 'DEVOLVIDO', motivo: entrada.motivo },
    });
    return 'AVISO_DEVOLVIDO';
}
