import { fontesPreparacao } from '@/lib/fechamentos/services/revisao-operacional.service';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { jsonNoStore, apiErrorResponse } from '@/lib/http/api-response';
import { fontesEdicao, edicaoDaVersao, versaoDoTenant } from '@/lib/contratos/services/administrativo.service';
import { fonteDaRevisaoInicial } from '@/lib/contratos/services/revisao-inicial';
import { calcularResumoComercial, listarPacotesComerciais, listarCatalogoAdicionais } from '@/lib/comercial/services';
import { consultarDisponibilidadeData } from '@/lib/disponibilidade/services';
import { listarCodigosInclusos } from '@/lib/comercial/composicao';
import { isPricingServiceError } from '@/lib/comercial/services/errors';
import type { CatalogoAdicionais } from '@/lib/comercial/services/models';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { lerRegrasPagamento } from '@/lib/comercial/regras-pagamento';
export async function GET(request: NextRequest, context: {
    params: Promise<{
        versaoId: string;
    }>;
}) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const versaoId = z.string().uuid().parse((await context.params).versaoId);
        const q = request.nextUrl.searchParams;
        // sessão → tenant provado → versão/fechamento → empresa do fechamento = tenant → dados.
        // A empresa do alvo nunca autoriza: versão de outra empresa responde como inexistente.
        const data = await withTenantTransaction(sessao, q.get('empresaId'), async (tx, tenant) => {
            const { versao: v, empresaId } = await versaoDoTenant(tx, versaoId, tenant.empresaComprovada);
            const preparada = await fontesPreparacao(v.id, tx);
            const somenteRevisao = !preparada && !!(await edicaoDaVersao(v.id, tx))?.origem_versao_id;
            const fonte = preparada ?? await fonteDaRevisaoInicial(v, await fontesEdicao(v.snapshot.fechamento.id, tx), tx);
            const dataEvento = z.string().date().parse(q.get('data') || fonte.fechamento.dataEvento);
            const convidados = z.coerce.number().int().positive().parse(q.get('convidados') || fonte.fechamento.convidados);
            const configuracaoAgendaId = z.string().uuid().parse(q.get('periodo') || fonte.fechamento.configuracaoAgendaId);
            const pacoteId = z.string().uuid().parse(q.get('pacote') || fonte.fechamento.pacoteId);
            const adicionais = q.has('adicionais') ? z.array(z.object({ codigo: z.string().max(80), quantidade: z.number().positive() }).strict()).max(60).parse(JSON.parse(q.get('adicionais')!)) : fonte.adicionais;
            const disponibilidade = await consultarDisponibilidadeData(dataEvento, tx, preparada ? fonte.fechamento.id : undefined, { fechamentoId: fonte.fechamento.id });
            // Opções de troca de vínculo: só da empresa já comprovada (= empresa do fechamento).
            const vinculos = preparada ? {
                clientes: (await tx.query("SELECT id,nome_completo FROM clientes WHERE empresa_id=$1::uuid AND status<>'MESCLADO' ORDER BY nome_completo", [empresaId])).rows,
                aniversariantes: (await tx.query('SELECT a.id,a.cliente_id,a.nome FROM aniversariantes a JOIN clientes c ON c.id=a.cliente_id WHERE a.ativo AND c.empresa_id=$1::uuid ORDER BY a.nome', [empresaId])).rows,
                responsaveis: (await tx.query('SELECT r.id,r.cliente_id,r.nome FROM responsaveis_adicionais r JOIN clientes c ON c.id=r.cliente_id WHERE r.ativo AND c.empresa_id=$1::uuid ORDER BY r.nome', [empresaId])).rows,
            } : null;
            // Catálogo e prévia só da empresa comprovada; `?pacote=` não escolhe outra empresa.
            const pacotes = await listarPacotesComerciais({ data: dataEvento, configuracaoAgendaId, empresaId });
            let catalogo: CatalogoAdicionais | null = null;
            let resumo = null, erroPreco = null;
            try {
                catalogo = await listarCatalogoAdicionais({ data: dataEvento, convidados, empresaId });
            } catch (e) {
                // A falta de preço não impede corrigir o cadastro de um contrato histórico.
                // Falhas de banco/autorização continuam interrompendo a leitura.
                if (!isPricingServiceError(e)) throw e;
                erroPreco = e.message;
            }
            const incluidos = await listarCodigosInclusos(tx, pacoteId, empresaId);
            try {
                // Fora da transação do tenant: um erro de preço aqui não pode abortar a prova de tenant.
                resumo = await calcularResumoComercial({ data: dataEvento, configuracaoAgendaId, pacoteId, convidados, adicionais, empresaEsperada: empresaId });
            }
            catch (e) {
                if (isPricingServiceError(e))
                    erroPreco = e.message;
                else
                    throw e;
            }
            // Regras de pagamento da empresa comprovada (077); null = antes da 077 (prévia usa o legado).
            const regrasPagamento = await lerRegrasPagamento(tx, empresaId);
            return { fonte, somenteRevisao, vinculos, disponibilidade, pacotes, catalogo, resumo, erroPreco, incluidos, regrasPagamento };
        });
        return jsonNoStore({ ok: true, data });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
