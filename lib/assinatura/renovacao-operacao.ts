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
 * Empresas desativadas e fixtures de homologação continuam visíveis (decisão de Felipe), mas distinguidas: cada item traz
 * `empresaStatus` e `fixtureHomologacao`, os fixtures vêm depois das empresas reais e o alerta do resumo é rebaixado.
 */
export const LIMITE_RENOVACOES_OPERACAO = 200;

/**
 * Prefixos de `empresas.codigo` usados SOMENTE pelas rodadas de homologação em staging (scripts/homologacao-*-staging.cjs:
 * hml-fundador-*, hml-pr-*, hml-pag-*, hml-renovacao-*, hml-planos-*). Lista explícita e conservadora: `nav-` NÃO entra —
 * é do seed local de navegador (banco descartável) e seus nomes ("Buffet Sintético … (TESTE navegador)") não começam por "TESTE ".
 */
export const PREFIXOS_CODIGO_FIXTURE_HOMOLOGACAO: readonly string[] = Object.freeze(['hml-']);
/** Todos os fixtures de homologação se chamam "TESTE Kidmais — …". */
export const PREFIXO_NOME_FIXTURE_HOMOLOGACAO = 'TESTE ';

/**
 * Fixture de homologação só quando AMBOS batem (maiúsculas/minúsculas exatas): código com prefixo sintético E nome iniciado
 * por "TESTE ". Na dúvida é empresa real — nunca rebaixar cliente de verdade por um só indício.
 */
export function ehFixtureHomologacao(empresa: { codigo: string | null | undefined; nome: string | null | undefined }): boolean {
    const { codigo, nome } = empresa;
    if (typeof codigo !== 'string' || typeof nome !== 'string') return false;
    return PREFIXOS_CODIGO_FIXTURE_HOMOLOGACAO.some((p) => codigo.startsWith(p)) && nome.startsWith(PREFIXO_NOME_FIXTURE_HOMOLOGACAO);
}

export type RenovacaoOperacao = {
    renovacaoId: string; empresaId: string; empresa: string; empresaStatus: string; fixtureHomologacao: boolean;
    estado: 'REVISAO' | 'AVISANDO' | 'APLICANDO'; motivo: string | null;
    primeiraDataRegular: string; avisoEnviado: boolean; atualizadaEm: string;
};
type Linha = {
    id: string; empresa_id: string; empresa: string; empresa_codigo: string; empresa_status: string; estado: RenovacaoOperacao['estado'];
    ultimo_erro: string | null; primeira_data_regular: string; aviso_enviado: boolean; atualizada_em: string; total: number;
};

/** Mesma regra de ehFixtureHomologacao, em SQL, só para ordenar (fixtures por último antes do LIMIT); literais vêm das constantes. */
const literal = (t: string) => `'${t.replace(/'/g, "''")}'`;
const SQL_FIXTURE = `((${PREFIXOS_CODIGO_FIXTURE_HOMOLOGACAO.map((p) => `left(e.codigo, ${p.length}) = ${literal(p)}`).join(' OR ')})`
    + ` AND left(e.nome, ${PREFIXO_NOME_FIXTURE_HOMOLOGACAO.length}) = ${literal(PREFIXO_NOME_FIXTURE_HOMOLOGACAO)})`;

const SQL_OPERACAO = `SELECT r.id::text AS id, r.empresa_id::text AS empresa_id, e.nome AS empresa, e.codigo AS empresa_codigo,
        e.status::text AS empresa_status, r.estado, r.ultimo_erro,
        r.primeira_data_regular::text AS primeira_data_regular, (r.aviso_enviado_em IS NOT NULL) AS aviso_enviado,
        to_char(r.atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS atualizada_em, (count(*) OVER ())::int AS total
   FROM assinatura_renovacoes r JOIN empresas e ON e.id = r.empresa_id
  WHERE r.estado = 'REVISAO'
     OR (r.estado = 'AVISANDO' AND (r.ultimo_erro IS NOT NULL OR r.atualizado_em < clock_timestamp() - interval '1 hour'))
     OR (r.estado = 'APLICANDO' AND r.atualizado_em < clock_timestamp() - interval '1 hour')
  ORDER BY ${SQL_FIXTURE} IS TRUE, (r.estado = 'REVISAO') DESC, r.primeira_data_regular, r.atualizado_em
  LIMIT ${LIMITE_RENOVACOES_OPERACAO}`;

/** Leitura sem conferência: só para quem já exigiu a concessão na mesma transação (resumo do painel). */
export async function lerRenovacoesOperacao(tx: DbExecutor) {
    if (!await renovacaoInstalada(tx))
        return { instalada: false, itens: [] as RenovacaoOperacao[], total: 0 };
    const linhas = (await tx.query<Linha>(SQL_OPERACAO)).rows;
    const itens = linhas.map((l): RenovacaoOperacao => ({
        renovacaoId: l.id, empresaId: l.empresa_id, empresa: l.empresa, empresaStatus: l.empresa_status,
        fixtureHomologacao: ehFixtureHomologacao({ codigo: l.empresa_codigo, nome: l.empresa }), estado: l.estado, motivo: l.ultimo_erro,
        primeiraDataRegular: l.primeira_data_regular, avisoEnviado: l.aviso_enviado, atualizadaEm: l.atualizada_em,
    }));
    // Reais antes de fixtures (sort estável: preserva a ordem do SQL dentro de cada grupo). O código da empresa não sai daqui.
    return { instalada: true, itens: itens.sort((a, b) => Number(a.fixtureHomologacao) - Number(b.fixtureHomologacao)), total: linhas[0]?.total ?? 0 };
}

/** Painel do desenvolvedor: renovações que precisam de revisão. Sem concessão → 404 genérico, nada é lido. */
export async function renovacoesEmRevisao(tx: DbExecutor, sessao: Pick<SessaoAdmin, 'usuario_id'>) {
    await exigirDesenvolvedorNaTransacao(tx, sessao);
    return lerRenovacoesOperacao(tx);
}

/**
 * Alertas do resumo do painel (mesmo formato de lib/desenvolvedor/alertas.ts). Severidade:
 *   empresa real não desativada → REVISAO urgente (ALTA), parada em atenção (MEDIA) — inalterado;
 *   empresa real desativada → atenção (MEDIA), com "(empresa desativada)" no título;
 *   fixture de homologação → INFO (menor nível existente), com "(fixture de homologação[, desativada])" no título.
 */
export function alertasRenovacao(itens: readonly RenovacaoOperacao[]): Alerta[] {
    return itens.map((r) => {
        const desativada = r.empresaStatus === 'DESATIVADA';
        const severidade: Alerta['severidade'] = r.fixtureHomologacao ? 'INFO' : desativada ? 'MEDIA' : r.estado === 'REVISAO' ? 'ALTA' : 'MEDIA';
        const sufixo = r.fixtureHomologacao ? (desativada ? ' (fixture de homologação, desativada)' : ' (fixture de homologação)')
            : desativada ? ' (empresa desativada)' : '';
        return {
            codigo: 'RENOVACAO_REVISAO', severidade, empresaId: r.empresaId, empresa: r.empresa, desde: r.atualizadaEm,
            titulo: (r.estado === 'REVISAO' ? 'Renovação Fundador em revisão' : 'Renovação Fundador parada') + sufixo,
            detalhe: r.estado === 'REVISAO'
                ? `Motivo: ${r.motivo ?? 'não informado'}. Primeira data regular ${r.primeiraDataRegular}. Nenhum aumento é aplicado até a revisão.`
                : `Estado ${r.estado}${r.motivo ? ` (${r.motivo})` : ''}. Primeira data regular ${r.primeiraDataRegular}. Conferir a execução da renovação.`,
            acao: { rotulo: 'Ver situação comercial', href: `/desenvolvedor/empresas/${r.empresaId}#t-comercial` },
        };
    });
}
