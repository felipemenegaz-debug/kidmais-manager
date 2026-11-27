import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { ambienteAtendimento, empresaPiloto } from './configuracao.ts';
import { acessoAtendimento, tem082 } from './service.ts';
import { limitesMesesSaoPaulo } from './mes-sao-paulo.ts';
import { contaNoTeto, tetoDoMes, type SituacaoTeto } from './teto-mensal.ts';

export { limitesMesesSaoPaulo };

const ESTADOS_SAIDA = ['ENTREGUE', 'SUBMETIDA', 'FALHOU', 'INCERTO', 'CANCELADA', 'PENDENTE', 'ENVIANDO'];
type SaidaPorEstado = { estado: string; equipe: number; automatica: number };
type MensagensNoMes = { mes: string; sessoes: number; entradas: number; saidas: SaidaPorEstado[]; primeiraMensagemEm: Date | null };
type UsoPorMoeda = { mes: string; moeda: string | null; custo: string | null; chamadas: number };

export type MesResultadoAtendimento = {
  mes: string;
  sessoes: number;
  entradas: number;
  saidas: SaidaPorEstado[];
  ia: {
    chamadas: number;
    semPreco: number;
    custos: { moeda: string; custoEstimadoMicros: string }[];
  };
};

/**
 * teto: 3b (D-LAN-3), consumo do mês pela Cloud API (135, estimativa), com a franquia da Meta e o limite do Wall-e.
 * null quando não se aplica: a empresa não envia pela Meta (piloto pelo Gupshup) ou a 135 não está no banco.
 */
export type ResultadoAtendimento = { primeiraMensagemEm: string | null; meses: MesResultadoAtendimento[]; teto: SituacaoTeto | null };
function pilotoAtual() { try { return empresaPiloto(); } catch { return null; } }

// O índice (conversa_id, criada_em) atende às faixas do relatório e às buscas por uma única entrada na recursão.
// Uma pausa de pelo menos 24 h garante um novo início, independentemente do que veio antes. Recuar só pelas entradas
// ligadas por intervalos menores evita impor uma margem fixa incorreta quando a sequência cruza vários dias.
// Ecos do app WhatsApp Business (F1): respostas que a equipe mandou pelo app ficam fora do Resultado (não passaram pelo
// iA.Fest). `fonte` só existe com a 082 (R3-4): sem ela, o SQL não cita a coluna.
export const SEM_ECO_DO_APP = " AND (m.fonte IS NULL OR m.fonte->>'tipo' IS DISTINCT FROM 'APP_WHATSAPP')";
const MENSAGENS = `
  WITH RECURSIVE periodos(mes, inicio, fim) AS (
    VALUES ($3::text, $5::timestamptz, $6::timestamptz), ($4::text, $6::timestamptz, $7::timestamptz)
  ), conversas AS (
    SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND ambiente = $2
  ), mensagens AS (
    SELECT m.conversa_id, m.criada_em, m.direcao, m.estado, m.autor_usuario_id IS NOT NULL AS humana
      FROM conversas c JOIN whatsapp_atendimento_mensagens m ON m.conversa_id = c.id
     WHERE m.empresa_id = $1 AND m.ambiente = $2 AND m.criada_em >= $5 AND m.criada_em < $7/*SEM_ECO*/
  ), anteriores(conversa_id, criada_em) AS (
    SELECT conversa_id, min(criada_em) FROM mensagens WHERE direcao = 'ENTRADA' GROUP BY conversa_id
    UNION ALL
    SELECT a.conversa_id, ultima.criada_em FROM anteriores a
      CROSS JOIN LATERAL (
        SELECT m.criada_em FROM whatsapp_atendimento_mensagens m
         WHERE m.conversa_id = a.conversa_id AND m.empresa_id = $1 AND m.ambiente = $2 AND m.direcao = 'ENTRADA'
           AND m.criada_em < a.criada_em AND m.criada_em > a.criada_em - interval '24 hours'
         ORDER BY m.criada_em DESC LIMIT 1
      ) ultima
  ), sessoes(conversa_id, inicio) AS (
    SELECT conversa_id, min(criada_em) FROM anteriores GROUP BY conversa_id
    UNION ALL
    SELECT s.conversa_id, proxima.criada_em FROM sessoes s
      CROSS JOIN LATERAL (
        SELECT m.criada_em FROM whatsapp_atendimento_mensagens m
         WHERE m.conversa_id = s.conversa_id AND m.empresa_id = $1 AND m.ambiente = $2 AND m.direcao = 'ENTRADA'
           AND m.criada_em >= s.inicio + interval '24 hours' AND m.criada_em < $7
         ORDER BY m.criada_em LIMIT 1
      ) proxima
  ), sessoes_por_mes AS (
    SELECT p.mes, count(*)::int AS total FROM periodos p JOIN sessoes s ON s.inicio >= p.inicio AND s.inicio < p.fim GROUP BY p.mes
  ), entradas_por_mes AS (
    SELECT p.mes, count(*)::int AS total FROM periodos p JOIN mensagens m ON m.criada_em >= p.inicio AND m.criada_em < p.fim
     WHERE m.direcao = 'ENTRADA' GROUP BY p.mes
  ), saidas_por_estado AS (
    SELECT p.mes, m.estado, (count(*) FILTER (WHERE m.humana))::int AS equipe,
           (count(*) FILTER (WHERE NOT m.humana))::int AS automatica
      FROM periodos p JOIN mensagens m ON m.criada_em >= p.inicio AND m.criada_em < p.fim
     WHERE m.direcao = 'SAIDA' GROUP BY p.mes, m.estado
  ), cobertura AS (
    SELECT min(primeira.criada_em) AS inicio FROM conversas c
      CROSS JOIN LATERAL (
        SELECT m.criada_em FROM whatsapp_atendimento_mensagens m
         WHERE m.conversa_id = c.id AND m.empresa_id = $1 AND m.ambiente = $2/*SEM_ECO*/
         ORDER BY m.criada_em LIMIT 1
      ) primeira
  )
  SELECT p.mes, COALESCE(s.total, 0) AS sessoes, COALESCE(e.total, 0) AS entradas,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('estado', se.estado, 'equipe', se.equipe, 'automatica', se.automatica)
                                    ORDER BY se.estado) FROM saidas_por_estado se WHERE se.mes = p.mes), '[]'::jsonb) AS saidas,
         c.inicio AS "primeiraMensagemEm"
    FROM periodos p CROSS JOIN cobertura c
    LEFT JOIN sessoes_por_mes s ON s.mes = p.mes LEFT JOIN entradas_por_mes e ON e.mes = p.mes`;
const MENSAGENS_COM_082 = MENSAGENS.replaceAll('/*SEM_ECO*/', SEM_ECO_DO_APP);
const MENSAGENS_SEM_082 = MENSAGENS.replaceAll('/*SEM_ECO*/', '');
export const mensagensSql = (r082: boolean) => (r082 ? MENSAGENS_COM_082 : MENSAGENS_SEM_082);

// O registro de uso não tem coluna de ambiente. Staging e produção mantêm bancos separados.
const USO_IA = `
  SELECT periodo_mes AS mes, moeda, sum(custo_estimado_micros)::text AS custo, count(*)::int AS chamadas
    FROM ia_uso_modelo
   WHERE empresa_id = $1 AND capacidade = 'whatsapp_atendimento' AND periodo_mes IN ($2, $3)
   GROUP BY periodo_mes, moeda ORDER BY periodo_mes, moeda`;

export async function resultadoAtendimento(sessao: SessaoParaTenant, agora = new Date()): Promise<ResultadoAtendimento> {
  return acessoAtendimento(sessao, async (tx, empresa) => {
    const ambiente = ambienteAtendimento();
    const [atual, anterior] = limitesMesesSaoPaulo(agora);
    const mensagens = await tx.query<MensagensNoMes>(mensagensSql(await tem082(tx)), [empresa, ambiente, anterior.mes, atual.mes, anterior.inicio, atual.inicio, atual.fim]);
    const uso = await tx.query<UsoPorMoeda>(USO_IA, [empresa, anterior.mes, atual.mes]);
    const teto = contaNoTeto(empresa, pilotoAtual()) ? await tetoDoMes(tx, empresa, ambiente) : null;

    return {
      primeiraMensagemEm: mensagens.rows[0]?.primeiraMensagemEm?.toISOString() ?? null,
      meses: [atual.mes, anterior.mes].map(mes => {
        const { sessoes, entradas, saidas } = mensagens.rows.find(linha => linha.mes === mes)!;
        const porEstado = new Map(saidas.map(saida => [saida.estado, saida]));
        const estados = new Set([...ESTADOS_SAIDA, ...porEstado.keys()]);
        const ia: MesResultadoAtendimento['ia'] = { chamadas: 0, semPreco: 0, custos: [] };
        for (const linha of uso.rows.filter(linha => linha.mes === mes)) {
          ia.chamadas += linha.chamadas;
          if (linha.custo === null) ia.semPreco += linha.chamadas;
          else if (linha.moeda !== null) ia.custos.push({ moeda: linha.moeda, custoEstimadoMicros: linha.custo });
        }
        return { mes, sessoes, entradas, saidas: Array.from(estados, estado => porEstado.get(estado) ?? { estado, equipe: 0, automatica: 0 }), ia };
      }),
      teto,
    };
  });
}
