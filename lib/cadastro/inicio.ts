import type { DbExecutor } from '../db/contracts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import { lerDadosImplantacao } from '../desenvolvedor/implantacao.ts';

/**
 * Início guiado (E7) da empresa comprovada: o mínimo para operar, cada item a partir de um fato do banco — nunca de
 * estimativa. Só contagens e marcadores; nenhum dado de cliente é devolvido. Tabelas ausentes (migration não aplicada)
 * deixam o item como "não disponível", sem quebrar a tela.
 */
export type PassoInicio = { codigo: string; titulo: string; feito: boolean | null; detalhe: string; href: string; somenteGestao: boolean };

async function contar(tx: DbExecutor, sql: string, params: unknown[]): Promise<number | null> {
    await tx.query('SAVEPOINT kidmais_inicio');
    try {
        const n = Number((await tx.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);
        await tx.query('RELEASE SAVEPOINT kidmais_inicio');
        return n;
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_inicio');
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === '42P01' || error.code === '42703'))
            return null;
        throw error;
    }
}

export async function primeirosPassos(tx: DbExecutor, tenant: TenantComprovado) {
    const empresa = tenant.empresaComprovada;
    const implantacao = await lerDadosImplantacao(tx, empresa);
    const pacotes = await contar(tx, 'SELECT count(*)::int AS n FROM pacotes WHERE empresa_id = $1::uuid AND ativo AND arquivado_em IS NULL', [empresa]);
    const pix = await contar(tx, 'SELECT count(*)::int AS n FROM empresa_pix_recebimento WHERE empresa_id = $1::uuid', [empresa]);
    const pessoas = await contar(tx, "SELECT count(*)::int AS n FROM memberships WHERE empresa_id = $1::uuid AND status = 'ATIVA'", [empresa]);
    const convites = await contar(tx, "SELECT count(*)::int AS n FROM convites_acesso WHERE empresa_id = $1::uuid AND status = 'PENDENTE' AND expira_em > clock_timestamp()", [empresa]);
    const clientes = await contar(tx, 'SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1::uuid', [empresa]);
    const perfilAplicado = implantacao.perfil.existe && !implantacao.perfil.ambiguo && implantacao.perfil.versao >= 1;
    const passos: PassoInicio[] = [
        { codigo: 'PERFIL', titulo: 'Perfil da empresa', feito: implantacao.perfil.estruturaInstalada ? perfilAplicado : null, somenteGestao: true, href: '/admin/configuracoes/perfil-empresa',
            detalhe: perfilAplicado ? 'Nome, CNPJ, endereço e contato aplicados.' : implantacao.perfil.existe ? 'Perfil criado; falta aplicar o cadastro.' : 'Crie o perfil com nome, endereço e contato que aparecem nos contratos.' },
        { codigo: 'PACOTES', titulo: 'Pacotes', feito: pacotes === null ? null : pacotes > 0, somenteGestao: true, href: '/admin/configuracoes/pacotes',
            detalhe: pacotes ? `${pacotes} pacote(s) ativo(s).` : 'Cadastre os pacotes que você vende.' },
        { codigo: 'PIX', titulo: 'Chave Pix para receber', feito: pix === null ? null : pix > 0, somenteGestao: true, href: '/admin/configuracoes/pix',
            detalhe: pix ? 'Chave configurada: as parcelas mostram o Pix copia e cola.' : 'Configure a chave Pix da empresa para as parcelas.' },
        { codigo: 'EQUIPE', titulo: 'Equipe', feito: pessoas === null ? null : pessoas > 1 || (convites ?? 0) > 0, somenteGestao: true, href: '/admin/configuracoes/acessos',
            detalhe: (pessoas ?? 0) > 1 ? `${pessoas} pessoas com acesso.` : (convites ?? 0) > 0 ? `${convites} convite(s) aguardando aceite.` : 'Convide quem trabalha com você (opcional).' },
        { codigo: 'CLIENTE', titulo: 'Primeiro cliente', feito: clientes === null ? null : clientes > 0, somenteGestao: false, href: '/clientes',
            detalhe: clientes ? `${clientes} cliente(s) cadastrado(s).` : 'Cadastre o primeiro cliente para fazer um contrato.' },
    ];
    const considerados = passos.filter((p) => p.feito !== null && p.codigo !== 'EQUIPE');
    return { passos, concluidos: considerados.filter((p) => p.feito).length, total: considerados.length, gestao: tenant.papelAtual === 'REPRESENTANTE_AUTORIZADO' };
}
