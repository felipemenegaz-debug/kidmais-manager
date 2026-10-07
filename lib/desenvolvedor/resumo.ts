import type { SessaoAdmin } from '../autenticacao/service.ts';
import { situacaoEmail } from '../acessos/email.ts';
import { exigirDesenvolvedorNaTransacao } from './autorizacao.ts';
import { alertasPainel } from './alertas.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Resumo do painel inicial. Só contagens e metadados das tabelas de plataforma, empresas, memberships, convites e
 * auditoria administrativa. Nenhum conteúdo de contrato, documento, cliente ou pagamento.
 */
const ACOES_ADMINISTRATIVAS = `a.origem IN ('PAINEL_DESENVOLVEDOR', 'CONVITE_PUBLICO', 'RECUPERACAO_PUBLICA', 'PERFIL_SENHA', 'HG8_CICLO_EMPRESA', 'ADMIN_USUARIOS', 'CADASTRO_PUBLICO', 'COBRANCA')`;

export async function resumoPainel(sessao: SessaoAdmin, deps: PainelDeps = painelDepsPadrao) {
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const interessadas = (await tx.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM plataforma_interessadas GROUP BY status')).rows;
        const empresas = (await tx.query<{ em_implantacao: number; ativas: number; suspensas: number; aguardando_acesso: number; em_configuracao: number; sem_cadastro: number }>(
            `SELECT count(*) FILTER (WHERE e.status = 'ATIVA' AND c.implantacao IN ('AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO'))::int AS em_implantacao,
                    count(*) FILTER (WHERE e.status = 'ATIVA' AND (c.implantacao IS NULL OR c.implantacao = 'CONCLUIDA'))::int AS ativas,
                    count(*) FILTER (WHERE e.status = 'SUSPENSA')::int AS suspensas,
                    count(*) FILTER (WHERE e.status = 'ATIVA' AND c.implantacao = 'AGUARDANDO_PRIMEIRO_ACESSO')::int AS aguardando_acesso,
                    count(*) FILTER (WHERE e.status = 'ATIVA' AND c.implantacao = 'EM_CONFIGURACAO')::int AS em_configuracao,
                    count(*) FILTER (WHERE c.empresa_id IS NULL AND e.status <> 'DESATIVADA')::int AS sem_cadastro
               FROM empresas e LEFT JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id`)).rows[0];
        const aguardando = (await tx.query<{ id: string; nome: string; implantacao: string; criado_em: string; convites_pendentes: number }>(
            `SELECT e.id, e.nome, c.implantacao, e.criado_em::text,
                    (SELECT count(*)::int FROM convites_acesso v WHERE v.empresa_id = e.id AND v.status = 'PENDENTE' AND v.expira_em > clock_timestamp()) AS convites_pendentes
               FROM empresas e JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id
              WHERE e.status = 'ATIVA' AND c.implantacao IN ('AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO')
              ORDER BY (c.implantacao = 'AGUARDANDO_PRIMEIRO_ACESSO') DESC, e.criado_em LIMIT 10`)).rows;
        const convites = (await tx.query<{ pendentes: number; expirados: number; nao_enviados: number }>(
            `SELECT count(*) FILTER (WHERE status = 'PENDENTE' AND expira_em > clock_timestamp())::int AS pendentes,
                    count(*) FILTER (WHERE status = 'PENDENTE' AND expira_em <= clock_timestamp())::int AS expirados,
                    count(*) FILTER (WHERE status = 'PENDENTE' AND envios = 0)::int AS nao_enviados
               FROM convites_acesso`)).rows[0];
        const convitesPendentes = (await tx.query<{ id: string; empresa_id: string; empresa: string; email: string; expira_em: string; expirado: boolean; envios: number }>(
            `SELECT v.id, v.empresa_id, e.nome AS empresa, v.email, v.expira_em::text, v.expira_em <= clock_timestamp() AS expirado, v.envios
               FROM convites_acesso v JOIN empresas e ON e.id = v.empresa_id
              WHERE v.status = 'PENDENTE' ORDER BY v.expira_em LIMIT 10`)).rows;
        const atividades = (await tx.query<{ id: string; acao: string; origem: string; criado_em: string; ator: string | null; empresa_id: string | null; empresa: string | null; resultado: string | null }>(
            `SELECT a.id, a.acao, a.origem, a.criado_em::text, u.nome AS ator, emp.id AS empresa_id, emp.nome AS empresa, a.dados_depois->>'resultado' AS resultado
               FROM auditoria a
               LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
               LEFT JOIN empresas emp ON emp.id = CASE WHEN a.entidade_tipo = 'EMPRESA' THEN a.entidade_id
                                                      WHEN (a.dados_depois->>'empresaId') ~ '^[0-9a-f-]{36}$' THEN (a.dados_depois->>'empresaId')::uuid END
              WHERE ${ACOES_ADMINISTRATIVAS}
              ORDER BY a.criado_em DESC LIMIT 15`)).rows;
        const email = situacaoEmail();
        const alertas = await alertasPainel(tx, { configurado: email.configurado, motivo: email.motivo });
        return {
            interessadas: Object.fromEntries(interessadas.map((i) => [i.status, i.n])) as Record<string, number>,
            empresas: {
                emImplantacao: empresas.em_implantacao, ativas: empresas.ativas, suspensas: empresas.suspensas,
                aguardandoPrimeiroAcesso: empresas.aguardando_acesso, emConfiguracao: empresas.em_configuracao, semCadastro: empresas.sem_cadastro,
            },
            aguardando,
            convites: { pendentes: convites.pendentes, expirados: convites.expirados, naoEnviados: convites.nao_enviados },
            convitesPendentes,
            atividades,
            envioEmail: { configurado: email.configurado, motivo: email.motivo },
            alertas,
        };
    });
}
