import type { DbExecutor } from '../db/contracts';
import { EMPRESA_SAAS_DO_PERFIL } from '../perfil/autorizacao.ts';
import { estruturaCadastroInstalada } from '../perfil/cadastro-service.ts';

/**
 * Pendências REAIS de implantação de uma contratante (D5): o que ainda impede a empresa de operar sozinha.
 *
 * Obrigatórias para marcar a implantação como CONCLUÍDA (validadas no servidor, em lib/desenvolvedor/empresas.ts):
 *   - GESTAO_ATIVA: ao menos uma pessoa com papel Gestão, vínculo ATIVO e conta ativa (nasce do aceite do convite);
 *   - PERFIL_CRIADO: o Perfil da empresa (026/027) existe e está associado a esta empresa (criado pela Gestão em
 *     Configurações → Perfil da empresa; lib/perfil/criacao.ts);
 *   - PERFIL_APLICADO: o cadastro do perfil foi aplicado ao menos uma vez (nome, CNPJ, endereço e contato).
 * Informativa (não bloqueia): CONVITE_RESPONSAVEL — convites pendentes vencidos ou nunca enviados.
 * Onde a estrutura do perfil não está instalada, os itens de perfil deixam de ser obrigatórios (não há como atendê-los).
 * Nenhum dado operacional (clientes, contratos, documentos, pagamentos) entra aqui.
 */
export type CodigoPendencia = 'GESTAO_ATIVA' | 'CONVITE_RESPONSAVEL' | 'PERFIL_CRIADO' | 'PERFIL_APLICADO';
export type AcaoPendencia = 'CONVITES' | 'PERFIL' | 'PLATAFORMA' | null;
export type Pendencia = { codigo: CodigoPendencia; titulo: string; atendida: boolean; obrigatoria: boolean; detalhe: string; acao: AcaoPendencia };
export type DadosImplantacao = {
    gestoesAtivas: number;
    convites: { pendentes: number; expirados: number; naoEnviados: number };
    perfil: { estruturaInstalada: boolean; existe: boolean; ambiguo: boolean; versao: number };
};
export type Implantacao = { itens: Pendencia[]; podeConcluir: boolean; pendentesObrigatorias: CodigoPendencia[] };

export function classificarPendencias(d: DadosImplantacao): Implantacao {
    const itens: Pendencia[] = [];
    const gestao = d.gestoesAtivas >= 1;
    itens.push({
        codigo: 'GESTAO_ATIVA', titulo: 'Responsável com acesso de Gestão', obrigatoria: true, atendida: gestao,
        detalhe: gestao ? `${d.gestoesAtivas} pessoa(s) com Gestão ativa nesta empresa.` : 'Ninguém com papel Gestão e vínculo ativo. O acesso nasce quando o responsável aceita o convite.',
        acao: gestao ? null : 'CONVITES',
    });
    const problemas = d.convites.expirados + d.convites.naoEnviados;
    itens.push({
        codigo: 'CONVITE_RESPONSAVEL', titulo: 'Convites pendentes', obrigatoria: false, atendida: problemas === 0,
        detalhe: problemas === 0
            ? (d.convites.pendentes > 0 ? `${d.convites.pendentes} convite(s) pendente(s) dentro do prazo.` : 'Nenhum convite pendente com problema.')
            : `${d.convites.expirados} expirado(s) e ${d.convites.naoEnviados} nunca enviado(s). Reenvie ou cancele.`,
        acao: problemas === 0 ? null : 'CONVITES',
    });
    if (!d.perfil.estruturaInstalada) {
        itens.push({ codigo: 'PERFIL_CRIADO', titulo: 'Perfil da empresa', obrigatoria: false, atendida: false, detalhe: 'A estrutura do Perfil da empresa não está instalada neste ambiente.', acao: 'PLATAFORMA' });
    }
    else {
        const criado = d.perfil.existe && !d.perfil.ambiguo;
        itens.push({
            codigo: 'PERFIL_CRIADO', titulo: 'Perfil da empresa criado', obrigatoria: true, atendida: criado,
            detalhe: d.perfil.ambiguo ? 'Mais de um perfil associado a esta empresa: a plataforma precisa corrigir a associação.'
                : criado ? 'Perfil criado e associado a esta empresa.' : 'A Gestão da empresa cria o perfil em Configurações → Perfil da empresa.',
            acao: d.perfil.ambiguo ? 'PLATAFORMA' : criado ? null : 'PERFIL',
        });
        const aplicado = criado && d.perfil.versao >= 1;
        itens.push({
            codigo: 'PERFIL_APLICADO', titulo: 'Cadastro do perfil aplicado', obrigatoria: true, atendida: aplicado,
            detalhe: aplicado ? `Cadastro aplicado (versão ${d.perfil.versao}).` : 'Nome comercial, razão social, CNPJ, endereço e contato ainda não foram aplicados pela Gestão.',
            acao: aplicado ? null : 'PERFIL',
        });
    }
    const pendentesObrigatorias = itens.filter((i) => i.obrigatoria && !i.atendida).map((i) => i.codigo);
    return { itens, podeConcluir: pendentesObrigatorias.length === 0, pendentesObrigatorias };
}

export async function lerDadosImplantacao(tx: DbExecutor, empresaId: string): Promise<DadosImplantacao> {
    const gestoes = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo`, [empresaId])).rows[0]?.n ?? 0;
    const convites = (await tx.query<{ pendentes: number; expirados: number; nao_enviados: number }>(
        `SELECT count(*) FILTER (WHERE status = 'PENDENTE' AND expira_em > clock_timestamp())::int AS pendentes,
                count(*) FILTER (WHERE status = 'PENDENTE' AND expira_em <= clock_timestamp())::int AS expirados,
                count(*) FILTER (WHERE status = 'PENDENTE' AND envios = 0)::int AS nao_enviados
           FROM convites_acesso WHERE empresa_id = $1::uuid`, [empresaId])).rows[0] ?? { pendentes: 0, expirados: 0, nao_enviados: 0 };
    const estruturaInstalada = await estruturaCadastroInstalada(tx);
    let perfil = { estruturaInstalada, existe: false, ambiguo: false, versao: 0 };
    if (estruturaInstalada) {
        const perfis = (await tx.query<{ id: string; versao: number }>(
            `SELECT p.id::text AS id, p.versao::int AS versao FROM public.perfil_empresas p JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos = 1 WHERE e.id = $1::uuid ORDER BY p.id`,
            [empresaId])).rows;
        perfil = { estruturaInstalada, existe: perfis.length >= 1, ambiguo: perfis.length > 1, versao: perfis.length === 1 ? Number(perfis[0].versao) : 0 };
    }
    return { gestoesAtivas: gestoes, convites: { pendentes: convites.pendentes, expirados: convites.expirados, naoEnviados: convites.nao_enviados }, perfil };
}

export async function pendenciasImplantacao(tx: DbExecutor, empresaId: string): Promise<Implantacao> {
    return classificarPendencias(await lerDadosImplantacao(tx, empresaId));
}
