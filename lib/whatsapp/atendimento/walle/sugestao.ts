import type { SessaoParaTenant } from '../../../saas/provar-tenant.ts';
import { hojeOperacao } from '../core.ts';
import { ambienteAtendimento } from '../configuracao.ts';
import { acessoAtendimento, configuracao, tem075 } from '../service.ts';
import { lerContexto } from './contexto.ts';
import { entenderPorRegras } from './entendimento.ts';
import { catalogosWallE, fontesPostgres } from './fontes-postgres.ts';
import { resolverWallE } from './resolver.ts';
import { NOME_MOTIVO } from './tipos.ts';

/**
 * Sugestão do Wall-e para o ATENDENTE (conversa com a equipe): o mesmo resolvedor, com as mesmas fontes oficiais, sobre a
 * última mensagem do cliente, sem modelo (regras locais: nenhum custo extra) e SEM gravar nada nem enviar. O texto volta
 * para a tela como sugestão editável; materiais da biblioteca são indicados para o atendente anexar pela prévia (preso
 * à versão). Contrato particular: nunca dados; o link individual continua sendo a mensagem pronta própria.
 */
export async function sugerirResposta(sessao: SessaoParaTenant, conversaId: string) {
  return acessoAtendimento(sessao, async (tx, empresa) => {
    if (!(await tem075(tx))) throw new Error('ATENDIMENTO_RECURSO_075_INDISPONIVEL');
    const ambiente = ambienteAtendimento();
    const conversa = (await tx.query<{ contexto: unknown }>('SELECT contexto FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3', [conversaId, empresa, ambiente])).rows[0];
    if (!conversa) throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    const ultima = (await tx.query<{ texto: string }>("SELECT texto FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 AND direcao='ENTRADA' AND texto IS NOT NULL ORDER BY criada_em DESC,id DESC LIMIT 1", [conversaId, empresa, ambiente])).rows[0];
    if (!ultima) return { texto: '', materiais: [], motivos: [] as string[] };
    const config = (await configuracao(tx, empresa)) ?? { ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } };
    const hoje = hojeOperacao();
    const catalogos = await catalogosWallE(tx, empresa, config, hoje);
    const contexto = lerContexto(conversa.contexto);
    const r = await resolverWallE({ texto: ultima.texto, entendimento: entenderPorRegras(ultima.texto, catalogos, contexto), contexto, config, catalogos, agora: new Date().toISOString() },
      fontesPostgres(tx, { empresaId: empresa, ambiente, hoje, linkContratoProprio: async () => null }), { sugestao: true });
    return {
      texto: r.saidas.filter((s) => s.texto).map((s) => s.texto).join('\n\n'),
      materiais: r.saidas.filter((s) => s.anexo).map((s) => ({ prontaId: s.anexo!.prontaId, titulo: s.anexo!.titulo, tipo: s.anexo!.tipo })),
      motivos: (r.passagem?.motivos ?? []).map((m) => NOME_MOTIVO[m]),
    };
  });
}
