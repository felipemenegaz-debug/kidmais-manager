import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { acessoAtendimento } from './service.ts';

const FUSO = 'America/Sao_Paulo';
const mesEmSaoPaulo = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit' });
const offsetEmSaoPaulo = new Intl.DateTimeFormat('en', { timeZone: FUSO, timeZoneName: 'longOffset' });

export function limitesMesesSaoPaulo(agora: Date) {
  const partes = mesEmSaoPaulo.formatToParts(agora);
  const ano = Number(partes.find(p => p.type === 'year')?.value);
  const mes = Number(partes.find(p => p.type === 'month')?.value);
  const inicio = (deslocamento: number) => {
    const primeiroDia = new Date(Date.UTC(ano, mes - 1 + deslocamento, 1));
    const offset = offsetEmSaoPaulo.formatToParts(primeiroDia).find(p => p.type === 'timeZoneName')!.value.slice(3);
    return new Date(`${primeiroDia.toISOString().slice(0, 19)}${offset}`).toISOString();
  };
  const anterior = inicio(-1), atual = inicio(0), proximo = inicio(1);
  return [
    { mes: atual.slice(0, 7), inicio: atual, fim: proximo },
    { mes: anterior.slice(0, 7), inicio: anterior, fim: atual },
  ];
}

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

export type ResultadoAtendimento = { primeiraMensagemEm: string | null; meses: MesResultadoAtendimento[] };

// O índice (conversa_id, criada_em) atende às faixas do relatório e às buscas por uma única entrada na recursão.
// Uma pausa de pelo menos 24 h garante um novo início, independentemente do que veio antes. Recuar só pelas entradas
// ligadas por intervalos menores evita impor uma margem fixa incorreta quando a sequência cruza vários dias.
const MENSAGENS = `
  WITH RECURSIVE periodos(mes, inicio, fim) AS (
    VALUES ($3::text, $5::timestamptz, $6::timestamptz), ($4::text, $6::timestamptz, $7::timestamptz)
  ), conversas AS (
    SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND ambiente = $2
  ), mensagens AS (
    SELECT m.conversa_id, m.criada_em, m.direcao, m.estado, m.autor_usuario_id IS NOT NULL AS humana
      FROM conversas c JOIN whatsapp_atendimento_mensagens m ON m.conversa_id = c.id
     WHERE m.empresa_id = $1 AND m.ambiente = $2 AND m.criada_em >= $5 AND m.criada_em < $7
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
         WHERE m.conversa_id = c.id AND m.empresa_id = $1 AND m.ambiente = $2
         ORDER BY m.criada_em LIMIT 1
      ) primeira
  )
  SELECT p.mes, COALESCE(s.total, 0) AS sessoes, COALESCE(e.total, 0) AS entradas,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('estado', se.estado, 'equipe', se.equipe, 'automatica', se.automatica)
                                    ORDER BY se.estado) FROM saidas_por_estado se WHERE se.mes = p.mes), '[]'::jsonb) AS saidas,
         c.inicio AS "primeiraMensagemEm"
    FROM periodos p CROSS JOIN cobertura c
    LEFT JOIN sessoes_por_mes s ON s.mes = p.mes LEFT JOIN entradas_por_mes e ON e.mes = p.mes`;

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
    const mensagens = await tx.query<MensagensNoMes>(MENSAGENS, [empresa, ambiente, anterior.mes, atual.mes, anterior.inicio, atual.inicio, atual.fim]);
    const uso = await tx.query<UsoPorMoeda>(USO_IA, [empresa, anterior.mes, atual.mes]);

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
    };
  });
}
