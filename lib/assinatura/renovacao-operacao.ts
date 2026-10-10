import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { exigirDesenvolvedorNaTransacao } from '../desenvolvedor/autorizacao.ts';
import type { Alerta } from '../desenvolvedor/alertas.ts';
import { renovacaoInstalada } from './renovacao-repositorio.ts';

/**
 * G4 — visão operacional (painel do desenvolvedor, somente leitura) das renovações Fundador que precisam de pessoa:
 *   - REVISAO (janela perdida, envio incerto fora da janela, falha de entrega do webhook, divergência no provedor…);
 *   - AVISANDO com erro (envio incerto) ou parada há mais de 1 h;
 *   - APLICANDO parada há mais de 1 h (troca de preço interrompida; o processador retoma pela releitura).
 * Campos mínimos e sem dado pessoal: nunca destinatário, e-mail, mensagem, chave de envio nem id externo do provedor.
 * A concessão de desenvolvedor é conferida dentro da transação (lib/desenvolvedor/autorizacao.ts).
 */
export const LIMITE_RENOVACOES_OPERACAO = 200;
export type RenovacaoOperacao = {
    renovacaoId: string; empresaId: string; empresa: string; estado: 'REVISAO' | 'AVISANDO' | 'APLICANDO'; motivo: string | null;
    primeiraDataRegular: string; avisoEnviado: boolean; atualizadaEm: string;
};
type Linha = {
    id: string; empresa_id: string; empresa: string; estado: RenovacaoOperacao['estado']; ultimo_erro: string | null;
    primeira_data_regular: string; aviso_enviado: boolean; atualizada_em: string; total: number;
};

const SQL_OPERACAO = `SELECT r.id::text AS id, r.empresa_id::text AS empresa_id, e.nome AS empresa, r.estado, r.ultimo_erro,
        r.primeira_data_regular::text AS primeira_data_regular, (r.aviso_enviado_em IS NOT NULL) AS aviso_enviado,
        to_char(r.atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS atualizada_em, (count(*) OVER ())::int AS total
   FROM assinatura_renovacoes r JOIN empresas e ON e.id = r.empresa_id
  WHERE r.estado = 'REVISAO'
     OR (r.estado = 'AVISANDO' AND (r.ultimo_erro IS NOT NULL OR r.atualizado_em < clock_timestamp() - interval '1 hour'))
     OR (r.estado = 'APLICANDO' AND r.atualizado_em < clock_timestamp() - interval '1 hour')
  ORDER BY (r.estado = 'REVISAO') DESC, r.primeira_data_regular, r.atualizado_em
  LIMIT ${LIMITE_RENOVACOES_OPERACAO}`;

/** Leitura sem conferência: só para quem já exigiu a concessão na mesma transação (resumo do painel). */
export async function lerRenovacoesOperacao(tx: DbExecutor) {
    if (!await renovacaoInstalada(tx))
        return { instalada: false, itens: [] as RenovacaoOperacao[], total: 0 };
    const linhas = (await tx.query<Linha>(SQL_OPERACAO)).rows;
    return {
        instalada: true,
        itens: linhas.map((l): RenovacaoOperacao => ({
            renovacaoId: l.id, empresaId: l.empresa_id, empresa: l.empresa, estado: l.estado, motivo: l.ultimo_erro,
            primeiraDataRegular: l.primeira_data_regular, avisoEnviado: l.aviso_enviado, atualizadaEm: l.atualizada_em,
        })),
        total: linhas[0]?.total ?? 0,
    };
}

/** Painel do desenvolvedor: renovações que precisam de revisão. Sem concessão → 404 genérico, nada é lido. */
export async function renovacoesEmRevisao(tx: DbExecutor, sessao: Pick<SessaoAdmin, 'usuario_id'>) {
    await exigirDesenvolvedorNaTransacao(tx, sessao);
    return lerRenovacoesOperacao(tx);
}

/** Alertas do resumo do painel (mesmo formato de lib/desenvolvedor/alertas.ts). */
export function alertasRenovacao(itens: readonly RenovacaoOperacao[]): Alerta[] {
    return itens.map((r) => ({
        codigo: 'RENOVACAO_REVISAO', severidade: r.estado === 'REVISAO' ? 'ALTA' : 'MEDIA', empresaId: r.empresaId, empresa: r.empresa,
        desde: r.atualizadaEm,
        titulo: r.estado === 'REVISAO' ? 'Renovação Fundador em revisão' : 'Renovação Fundador parada',
        detalhe: r.estado === 'REVISAO'
            ? `Motivo: ${r.motivo ?? 'não informado'}. Primeira data regular ${r.primeiraDataRegular}. Nenhum aumento é aplicado até a revisão.`
            : `Estado ${r.estado}${r.motivo ? ` (${r.motivo})` : ''}. Primeira data regular ${r.primeiraDataRegular}. Conferir a execução da renovação.`,
        acao: { rotulo: 'Ver situação comercial', href: `/desenvolvedor/empresas/${r.empresaId}#t-comercial` },
    }));
}
