import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { LIMITE_PERGUNTAS_APROVADAS } from './core.ts';
import { acessoAtendimento, configuracao, tem082 } from './service.ts';
import { agrupadorSemFonte, type GrupoSemFonte, type PassagemSemFonte } from './sem-fonte-texto.ts';

export const DIAS_SEM_FONTE = 30;
/** Tamanho do lote lido por vez; a janela inteira é lida (paginação por em + id), o limite vale só para os grupos mostrados. */
export const LOTE_SEM_FONTE = 500;

export type PerguntasSemFonte = {
  disponivel: boolean; dias: number; grupos: GrupoSemFonte[]; omitidasSensiveis: number; limite: number; publicadas: number;
};

/**
 * Fatia 7: passagens recentes com o motivo INFORMACAO_INDISPONIVEL (pergunta sem fonte), agrupadas, para a pessoa
 * responsável criar a resposta aprovada. Só leitura: empresa comprovada e ambiente atual; só REPRESENTANTE_AUTORIZADO
 * (o mesmo papel que salva a configuração). Conversa com "não contatar" fica de fora. Sem a 082 não há passagem gravada.
 * Janela: de `agora` − 30 dias até `agora`, inclusive nos dois extremos (passagem com data futura fica de fora).
 */
export async function perguntasSemFonte(sessao: SessaoParaTenant, agora = new Date(), lote = LOTE_SEM_FONTE): Promise<PerguntasSemFonte> {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    if (papel !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO');
    const config = await configuracao(tx, empresa);
    const perguntas = (config?.perguntas ?? []).map((p) => p.pergunta);
    const base = { dias: DIAS_SEM_FONTE, limite: LIMITE_PERGUNTAS_APROVADAS, publicadas: perguntas.length };
    if (!(await tem082(tx))) return { ...base, disponivel: false, grupos: [], omitidasSensiveis: 0 };
    const desde = new Date(agora.getTime() - DIAS_SEM_FONTE * 86_400_000).toISOString();
    const ate = agora.toISOString();
    const agrupador = agrupadorSemFonte(perguntas);
    let cursor: { em: string; id: string } | null = null;
    for (;;) {
      const linhas: (PassagemSemFonte & { id: string })[] = (await tx.query<PassagemSemFonte & { id: string }>(`SELECT id::text AS id, passagem->'ultimaMensagem' #>> '{}' AS "ultimaMensagem", passagem->>'em' AS em
          FROM whatsapp_atendimento_conversas
         WHERE empresa_id=$1 AND ambiente=$2 AND passagem IS NOT NULL AND jsonb_typeof(passagem)='object' AND nao_contatar=false
           AND (passagem->'motivos' ? 'INFORMACAO_INDISPONIVEL' OR passagem->>'motivo'='INFORMACAO_INDISPONIVEL')
           AND passagem->>'em' >= $3 AND passagem->>'em' <= $4
           AND ($5::text IS NULL OR (passagem->>'em', id::text) < ($5::text, $6::text))
         ORDER BY passagem->>'em' DESC, id::text DESC LIMIT $7`, [empresa, ambienteAtendimento(), desde, ate, cursor?.em ?? null, cursor?.id ?? null, lote])).rows;
      agrupador.adicionar(linhas);
      if (linhas.length < lote) break;
      const ultima = linhas[linhas.length - 1];
      cursor = { em: String(ultima.em), id: ultima.id };
    }
    return { ...base, disponivel: true, ...agrupador.resultado() };
  });
}
