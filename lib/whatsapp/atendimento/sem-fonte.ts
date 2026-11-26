import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { LIMITE_PERGUNTAS_APROVADAS } from './core.ts';
import { acessoAtendimento, configuracao, tem082 } from './service.ts';
import { agruparSemFonte, type GrupoSemFonte, type PassagemSemFonte } from './sem-fonte-texto.ts';

export const DIAS_SEM_FONTE = 30;
const PASSAGENS_LIDAS = 500;

export type PerguntasSemFonte = {
  disponivel: boolean; dias: number; grupos: GrupoSemFonte[]; omitidasSensiveis: number; limite: number; publicadas: number;
};

/**
 * Fatia 7: passagens recentes com o motivo INFORMACAO_INDISPONIVEL (pergunta sem fonte), agrupadas, para a pessoa
 * responsável criar a resposta aprovada. Só leitura: empresa comprovada e ambiente atual; só REPRESENTANTE_AUTORIZADO
 * (o mesmo papel que salva a configuração). Conversa com "não contatar" fica de fora. Sem a 082 não há passagem gravada.
 */
export async function perguntasSemFonte(sessao: SessaoParaTenant, agora = new Date()): Promise<PerguntasSemFonte> {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    if (papel !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO');
    const config = await configuracao(tx, empresa);
    const perguntas = (config?.perguntas ?? []).map((p) => p.pergunta);
    const base = { dias: DIAS_SEM_FONTE, limite: LIMITE_PERGUNTAS_APROVADAS, publicadas: perguntas.length };
    if (!(await tem082(tx))) return { ...base, disponivel: false, grupos: [], omitidasSensiveis: 0 };
    const desde = new Date(agora.getTime() - DIAS_SEM_FONTE * 86_400_000).toISOString();
    const linhas = (await tx.query<PassagemSemFonte>(`SELECT passagem->'ultimaMensagem' #>> '{}' AS "ultimaMensagem", passagem->>'em' AS em
        FROM whatsapp_atendimento_conversas
       WHERE empresa_id=$1 AND ambiente=$2 AND passagem IS NOT NULL AND jsonb_typeof(passagem)='object' AND nao_contatar=false
         AND (passagem->'motivos' ? 'INFORMACAO_INDISPONIVEL' OR passagem->>'motivo'='INFORMACAO_INDISPONIVEL')
         AND passagem->>'em' >= $3
       ORDER BY passagem->>'em' DESC LIMIT ${PASSAGENS_LIDAS}`, [empresa, ambienteAtendimento(), desde])).rows;
    return { ...base, disponivel: true, ...agruparSemFonte(linhas, perguntas) };
  });
}
