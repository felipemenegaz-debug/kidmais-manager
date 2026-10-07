import type { DbExecutor } from '../db/contracts';
import { pendenciasImplantacao, SQL_SITUACAO_RESPONSAVEL } from './implantacao.ts';

/**
 * Alertas acionáveis do painel do desenvolvedor. Cada alerta nasce de um fato lido nas tabelas de plataforma, empresas,
 * memberships e convites — nunca de estimativa — e aponta para a seção da ficha onde a ação é feita.
 * Chamado DENTRO da transação de quem já exigiu a concessão de desenvolvedor (lib/desenvolvedor/resumo.ts).
 * Nenhum dado operacional (clientes, contratos, documentos, pagamentos) entra aqui; o e-mail do convite não é exposto.
 */
export type CodigoAlerta =
    | 'EMAIL_INDISPONIVEL' | 'SEM_GESTAO' | 'CONVITE_NAO_ENVIADO' | 'CONVITE_EXPIRADO' | 'RESPONSAVEL_SEM_ACESSO'
    | 'GESTAO_SEM_ACESSO' | 'IMPLANTACAO_INCOMPLETA' | 'IMPLANTACAO_PRONTA' | 'SEM_CADASTRO';
export type Severidade = 'ALTA' | 'MEDIA' | 'INFO';
export type Alerta = {
    codigo: CodigoAlerta; severidade: Severidade; empresaId: string | null; empresa: string | null;
    titulo: string; detalhe: string; desde: string | null; acao: { rotulo: string; href: string } | null;
};

/** Teto de empresas em implantação examinadas item a item (o resto aparece pela contagem do resumo). */
export const LIMITE_IMPLANTACAO = 50;
export const LIMITE_ALERTAS = 60;
const ORDEM: Record<Severidade, number> = { ALTA: 0, MEDIA: 1, INFO: 2 };

const ficha = (empresaId: string, secao: 'convites' | 'usuarios' | 'cadastro') => `/desenvolvedor/empresas/${empresaId}#t-${secao}`;

export function ordenarAlertas(alertas: Alerta[]): Alerta[] {
    return [...alertas].sort((a, b) => ORDEM[a.severidade] - ORDEM[b.severidade]
        || Number(a.empresaId !== null) - Number(b.empresaId !== null)
        || (a.desde ?? '9999').localeCompare(b.desde ?? '9999') || (a.empresa ?? '').localeCompare(b.empresa ?? ''));
}

export type AlertasDeps = { pendencias: typeof pendenciasImplantacao };

export async function alertasPainel(tx: DbExecutor, envioEmail: { configurado: boolean; motivo: string | null }, deps: AlertasDeps = { pendencias: pendenciasImplantacao }): Promise<{ itens: Alerta[]; total: number }> {
    const alertas: Alerta[] = [];
    const convites = (await tx.query<{ empresa_id: string; empresa: string; nao_enviados: number; expirados: number; mais_antigo: string | null }>(
        `SELECT e.id::text AS empresa_id, e.nome AS empresa,
                count(*) FILTER (WHERE v.envios = 0 AND v.expira_em > clock_timestamp())::int AS nao_enviados,
                count(*) FILTER (WHERE v.expira_em <= clock_timestamp())::int AS expirados,
                min(v.criado_em)::text AS mais_antigo
           FROM convites_acesso v JOIN empresas e ON e.id = v.empresa_id
          WHERE v.status = 'PENDENTE' AND e.status = 'ATIVA'
          GROUP BY e.id, e.nome`)).rows;
    const algumNaoEnviado = convites.some((c) => c.nao_enviados > 0);
    if (!envioEmail.configurado)
        alertas.push({
            codigo: 'EMAIL_INDISPONIVEL', severidade: algumNaoEnviado ? 'ALTA' : 'MEDIA', empresaId: null, empresa: null, desde: null,
            titulo: 'Envio de e-mail indisponível',
            detalhe: `${envioEmail.motivo ?? 'Provedor de e-mail não configurado.'} Convites e recuperações de senha não chegam a ninguém até o envio ser configurado.`,
            acao: null,
        });
    for (const c of convites) {
        if (c.nao_enviados > 0)
            alertas.push({
                codigo: 'CONVITE_NAO_ENVIADO', severidade: 'ALTA', empresaId: c.empresa_id, empresa: c.empresa, desde: c.mais_antigo,
                titulo: 'Convite não enviado', detalhe: `${c.nao_enviados} convite(s) criado(s) e nunca enviado(s).${envioEmail.configurado ? ' Reenvie pela ficha.' : ' Configure o e-mail e reenvie.'}`,
                acao: { rotulo: 'Ver convites', href: ficha(c.empresa_id, 'convites') },
            });
        if (c.expirados > 0)
            alertas.push({
                codigo: 'CONVITE_EXPIRADO', severidade: 'MEDIA', empresaId: c.empresa_id, empresa: c.empresa, desde: c.mais_antigo,
                titulo: 'Convite expirado', detalhe: `${c.expirados} convite(s) pendente(s) venceram sem aceite. Reenvie (gera link novo) ou cancele.`,
                acao: { rotulo: 'Ver convites', href: ficha(c.empresa_id, 'convites') },
            });
    }
    const pessoas = (await tx.query<{ empresa_id: string; empresa: string; implantacao: string | null; gestoes: number; sem_acesso: number; responsavel: string | null; cadastro_em: string | null }>(
        `SELECT e.id::text AS empresa_id, e.nome AS empresa, c.implantacao, c.criado_em::text AS cadastro_em,
                (SELECT count(*)::int FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
                  WHERE m.empresa_id = e.id AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo) AS gestoes,
                (SELECT count(*)::int FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
                  WHERE m.empresa_id = e.id AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND (m.status = 'SUSPENSA' OR (m.status = 'ATIVA' AND NOT u.ativo))) AS sem_acesso,
                r.situacao AS responsavel
           FROM empresas e
           LEFT JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id
           LEFT JOIN (${SQL_SITUACAO_RESPONSAVEL}) r ON r.empresa_id = e.id::text
          WHERE e.status = 'ATIVA'
          ORDER BY e.criado_em`)).rows;
    const emImplantacao: typeof pessoas = [];
    for (const p of pessoas) {
        if (p.implantacao === null)
            alertas.push({
                codigo: 'SEM_CADASTRO', severidade: 'INFO', empresaId: p.empresa_id, empresa: p.empresa, desde: null,
                titulo: 'Sem cadastro administrativo', detalhe: 'Empresa ativa sem cadastro no painel (responsável e contato desconhecidos).',
                acao: { rotulo: 'Completar cadastro', href: ficha(p.empresa_id, 'cadastro') },
            });
        if (p.implantacao !== null && p.implantacao !== 'CONCLUIDA') {
            emImplantacao.push(p);
        }
        else if (p.gestoes === 0)
            alertas.push({
                codigo: 'SEM_GESTAO', severidade: 'ALTA', empresaId: p.empresa_id, empresa: p.empresa, desde: null,
                titulo: 'Empresa sem Gestão ativa', detalhe: 'Ninguém com papel Gestão, vínculo ativo e conta ativa. A empresa não consegue administrar pessoas nem o perfil.',
                acao: { rotulo: 'Ver pessoas', href: ficha(p.empresa_id, 'usuarios') },
            });
        if (p.sem_acesso > 0)
            alertas.push({
                codigo: 'GESTAO_SEM_ACESSO', severidade: 'MEDIA', empresaId: p.empresa_id, empresa: p.empresa, desde: null,
                titulo: 'Gestão sem acesso', detalhe: `${p.sem_acesso} pessoa(s) com Gestão estão com vínculo desativado ou conta inativa.`,
                acao: { rotulo: 'Ver pessoas', href: ficha(p.empresa_id, 'usuarios') },
            });
        if (p.responsavel === 'SEM_ACESSO')
            alertas.push({
                codigo: 'RESPONSAVEL_SEM_ACESSO', severidade: 'MEDIA', empresaId: p.empresa_id, empresa: p.empresa, desde: null,
                titulo: 'Responsável sem acesso', detalhe: 'O e-mail do responsável no cadastro não tem Gestão ativa nem convite válido nesta empresa.',
                acao: { rotulo: 'Convidar', href: ficha(p.empresa_id, 'convites') },
            });
    }
    for (const p of emImplantacao.slice(0, LIMITE_IMPLANTACAO)) {
        const imp = await deps.pendencias(tx, p.empresa_id);
        const faltam = imp.itens.filter((i) => i.obrigatoria && !i.atendida);
        alertas.push(faltam.length === 0
            ? {
                codigo: 'IMPLANTACAO_PRONTA', severidade: 'INFO', empresaId: p.empresa_id, empresa: p.empresa, desde: p.cadastro_em,
                titulo: 'Implantação pronta para concluir', detalhe: 'Todos os itens obrigatórios estão atendidos. Marque a implantação como concluída.',
                acao: { rotulo: 'Abrir implantação', href: ficha(p.empresa_id, 'cadastro') },
            }
            : {
                codigo: 'IMPLANTACAO_INCOMPLETA', severidade: faltam.some((i) => i.codigo === 'GESTAO_ATIVA') ? 'ALTA' : 'MEDIA',
                empresaId: p.empresa_id, empresa: p.empresa, desde: p.cadastro_em,
                titulo: 'Implantação incompleta', detalhe: `Falta: ${faltam.map((i) => i.titulo.toLowerCase()).join('; ')}.`,
                acao: { rotulo: 'Abrir implantação', href: ficha(p.empresa_id, faltam[0].acao === 'CONVITES' ? 'convites' : 'cadastro') },
            });
    }
    const ordenados = ordenarAlertas(alertas);
    return { itens: ordenados.slice(0, LIMITE_ALERTAS), total: ordenados.length };
}
