import { fontesPreparacao } from '@/lib/fechamentos/services/revisao-operacional.service';
import { db } from '@/lib/db/postgres';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { jsonNoStore, apiErrorResponse } from '@/lib/http/api-response';
import { buscarVersaoPorId } from '@/lib/contratos/repositories';
import { fontesEdicao, conflito, edicaoDaVersao } from '@/lib/contratos/services/administrativo.service';
import { fonteDaRevisaoInicial } from '@/lib/contratos/services/revisao-inicial';
import { calcularResumoComercial, listarPacotesComerciais, listarCatalogoAdicionais } from '@/lib/comercial/services';
import { consultarDisponibilidadeData } from '@/lib/disponibilidade/services';
import { listarCodigosInclusos } from '@/lib/comercial/composicao';
export async function GET(request: NextRequest, context: {
    params: Promise<{
        versaoId: string;
    }>;
}) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const v = await buscarVersaoPorId(z.string().uuid().parse((await context.params).versaoId));
        if (!v)
            conflito('Versão não encontrada.');
        const preparada=await fontesPreparacao(v.id);
        const somenteRevisao = !preparada && !!(await edicaoDaVersao(v.id))?.origem_versao_id;
        const fonte = preparada ?? await fonteDaRevisaoInicial(v,await fontesEdicao(v.snapshot.fechamento.id));
        const q = request.nextUrl.searchParams, data = z.string().date().parse(q.get('data') || fonte.fechamento.dataEvento);
        const convidados = z.coerce.number().int().positive().parse(q.get('convidados') || fonte.fechamento.convidados);
        const configuracaoAgendaId = z.string().uuid().parse(q.get('periodo') || fonte.fechamento.configuracaoAgendaId);
        const pacoteId = z.string().uuid().parse(q.get('pacote') || fonte.fechamento.pacoteId);
        const adicionais = q.has('adicionais') ? z.array(z.object({ codigo: z.string().max(80), quantidade: z.number().positive() }).strict()).max(60).parse(JSON.parse(q.get('adicionais')!)) : fonte.adicionais;
        const disponibilidade = await consultarDisponibilidadeData(data,undefined,preparada?fonte.fechamento.id:undefined);
        const vinculos=preparada ? {clientes:(await db().query("SELECT id,nome_completo FROM clientes WHERE status<>'MESCLADO' ORDER BY nome_completo")).rows,aniversariantes:(await db().query('SELECT id,cliente_id,nome FROM aniversariantes WHERE ativo ORDER BY nome')).rows,responsaveis:(await db().query('SELECT id,cliente_id,nome FROM responsaveis_adicionais WHERE ativo ORDER BY nome')).rows}:null;
        const pacotes = await listarPacotesComerciais({ data, configuracaoAgendaId });
        const catalogo = await listarCatalogoAdicionais({ data, convidados });
        let resumo = null, erroPreco = null;
        try {
            resumo = await calcularResumoComercial({ data, configuracaoAgendaId, pacoteId, convidados, adicionais });
        }
        catch (e) {
            if (e instanceof Error)
                erroPreco = e.message;
            else
                throw e;
        }
        return jsonNoStore({ ok: true, data: { fonte, somenteRevisao, vinculos, disponibilidade, pacotes, catalogo, resumo, erroPreco, incluidos: await listarCodigosInclusos(db(), pacoteId) } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
