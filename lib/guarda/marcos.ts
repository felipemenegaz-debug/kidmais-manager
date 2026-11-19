import type { DbExecutor } from "../db/contracts.ts";

/**
 * Datas-base da guarda dos dados de cada cliente do buffet (guarda fase 1b, 19/11/2026). SÓ LEITURA: nada aqui apaga
 * ou altera dados; o resultado alimenta o detalhe do cliente (G3) e, depois, a simulação da anonimização (fase 3).
 *
 * Fonte dos prazos: DPA 2026-11-17, seção "guarda-clientes" (lib/cadastro/documentos-legais.ts):
 *   - contrato: 5 anos da data da festa ou do último pagamento, o que for mais tarde; festa cancelada, do cancelamento;
 *   - contato de quem contratou (campanhas): até pedir para sair, ou 5 anos sem festa nem contato, o que vier primeiro;
 *   - interessado que nunca contratou: 2 anos sem contato.
 * "Contato" é só iniciativa do cliente: mensagem recebida no WhatsApp pelo número do cadastro, pedido pelo formulário do
 * site, resposta à pesquisa. Campanha enviada e não respondida não conta. Sem nenhum desses registros, o marco do
 * interessado é a data do cadastro (origem CADASTRO).
 * Festa contratada = contrato assinado no Core (cancelado depois de assinado conta pelo cancelamento) ou contrato
 * histórico importado e ainda não integrado (ia_importacoes IMPORTADA); importado sem data válida conta pela data da
 * importação (mais tarde que a festa real, então nunca encurta o prazo).
 * Mescla: cliente MESCLADO conta para o principal (o principal soma os registros dos mesclados nele).
 * Datas em dia civil (AAAA-MM-DD). Vencimento em 29/02 de ano não bissexto vai para 28/02 (nunca depois).
 */

export type Dia = string; // AAAA-MM-DD
export type OrigemContato = "WHATSAPP" | "FORMULARIO_SITE" | "PESQUISA" | "CADASTRO";
export type FestaContratada = { dataEvento: Dia; ultimoPagamento: Dia | null; canceladaEm: Dia | null };
export type EntradaMarcos = {
  cadastradoEm: Dia;
  festas: FestaContratada[];
  contatos: { dia: Dia; origem: Exclude<OrigemContato, "CADASTRO"> }[];
  saidaCampanhas: Dia | null;
};
export type Vencimento = { data: Dia; marco: Dia; motivo: string };
export type Marcos = {
  categoria: "CONTRATOU" | "INTERESSADO";
  ultimaFesta: Dia | null;
  ultimoPagamento: Dia | null;
  ultimoContato: { dia: Dia; origem: OrigemContato } | null;
  saidaCampanhas: Dia | null;
  contrato: Vencimento | null;
  campanhas: Vencimento | null;
  interessado: Vencimento | null;
  /** Quando vencem TODOS os prazos que se aplicam (o mais tarde deles). */
  todosVencidosEm: Dia;
};

const DIA = /^\d{4}-\d{2}-\d{2}$/;
function dia(v: string): Dia {
  const d = v.slice(0, 10);
  if (!DIA.test(d)) throw new Error(`data inválida: ${v}`);
  return d;
}
const maior = (a: Dia | null, b: Dia | null): Dia | null => (a === null ? b : b === null ? a : a >= b ? a : b);
const maiorDe = (lista: (Dia | null)[]) => lista.reduce<Dia | null>((m, d) => maior(m, d), null);

/** Soma anos a um dia civil; 29/02 em ano não bissexto vira 28/02 (o prazo nunca passa do máximo). */
export function somarAnos(d: Dia, anos: number): Dia {
  const [a, m, di] = dia(d).split("-").map(Number);
  const alvo = a + anos;
  const bissexto = (alvo % 4 === 0 && alvo % 100 !== 0) || alvo % 400 === 0;
  const diaFinal = m === 2 && di === 29 && !bissexto ? 28 : di;
  return `${String(alvo).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

/** Cálculo puro (sem banco, sem relógio): datas-base e vencimento de cada prazo. */
export function calcularMarcos(e: EntradaMarcos): Marcos {
  const festas = e.festas.map((f) => ({ dataEvento: dia(f.dataEvento), ultimoPagamento: f.ultimoPagamento ? dia(f.ultimoPagamento) : null, canceladaEm: f.canceladaEm ? dia(f.canceladaEm) : null }));
  const ativas = festas.filter((f) => !f.canceladaEm);
  const ultimaFesta = maiorDe(ativas.map((f) => f.dataEvento));
  const ultimoPagamento = maiorDe(festas.map((f) => f.ultimoPagamento));
  const contatos = e.contatos.map((c) => ({ dia: dia(c.dia), origem: c.origem })).sort((x, y) => (x.dia < y.dia ? 1 : x.dia > y.dia ? -1 : 0));
  const ultimoContatoReal = contatos[0] ?? null;
  const saida = e.saidaCampanhas ? dia(e.saidaCampanhas) : null;

  // Contrato: o mais tarde entre as festas; cada uma conta da festa/último pagamento ou, cancelada, do cancelamento.
  let contrato: Vencimento | null = null;
  for (const f of festas) {
    const marco = f.canceladaEm ?? (maior(f.dataEvento, f.ultimoPagamento) as Dia);
    const motivo = f.canceladaEm ? "5 anos do cancelamento da festa" : f.ultimoPagamento && f.ultimoPagamento > f.dataEvento ? "5 anos do último pagamento" : "5 anos da data da festa";
    const v = { data: somarAnos(marco, 5), marco, motivo };
    if (!contrato || v.data > contrato.data) contrato = v;
  }

  const contratou = festas.length > 0;
  let campanhas: Vencimento | null = null;
  let interessado: Vencimento | null = null;
  if (contratou) {
    // Festa (não cancelada) ou contato: o que for mais recente renova os 5 anos. Pedido de saída encerra na hora.
    const marco = maior(ultimaFesta, ultimoContatoReal?.dia ?? null) ?? maiorDe(festas.map((f) => f.canceladaEm ?? f.dataEvento)) as Dia;
    const porTempo = { data: somarAnos(marco, 5), marco, motivo: "5 anos sem festa nem contato" };
    campanhas = saida && saida < porTempo.data ? { data: saida, marco: saida, motivo: "pediu para sair das campanhas" } : porTempo;
  } else {
    const marco = ultimoContatoReal?.dia ?? dia(e.cadastradoEm);
    interessado = { data: somarAnos(marco, 2), marco, motivo: ultimoContatoReal ? "2 anos sem contato" : "2 anos do cadastro, sem contato registrado" };
  }

  const ultimoContato = ultimoContatoReal ?? (contratou ? null : { dia: dia(e.cadastradoEm), origem: "CADASTRO" as const });
  const todosVencidosEm = maiorDe([contrato?.data ?? null, campanhas?.data ?? null, interessado?.data ?? null]) as Dia;
  return { categoria: contratou ? "CONTRATOU" : "INTERESSADO", ultimaFesta, ultimoPagamento, ultimoContato, saidaCampanhas: saida,
    contrato, campanhas, interessado, todosVencidosEm };
}

async function tabelas(tx: DbExecutor) {
  const r = await tx.query<{ conversas: boolean; contatos: boolean; satisfacao: boolean; saidas: boolean; importacoes: boolean; integracao: boolean }>(
    `/* guarda:marcos-tabelas */
     SELECT to_regclass('public.whatsapp_atendimento_conversas') IS NOT NULL AS conversas,
            to_regclass('public.ia_importacoes') IS NOT NULL AS importacoes,
            to_regclass('public.contrato_importacoes') IS NOT NULL AS integracao,
            to_regclass('public.marketing_contatos') IS NOT NULL AS contatos,
            to_regclass('public.satisfacao_envios') IS NOT NULL AS satisfacao,
            to_regclass('public.marketing_saidas_contato') IS NOT NULL AS saidas`);
  const t = r.rows[0];
  if (!t) throw new Error("catálogo da guarda ilegível");
  return t;
}

/**
 * Leitura dos marcos de UM cliente da empresa (MESCLADO é lido pelo principal). Só SELECT; devolve null se o cliente
 * não for da empresa. Datas no fuso de São Paulo.
 */
export async function lerMarcosDoCliente(tx: DbExecutor, empresaId: string, clienteId: string): Promise<(Marcos & { clienteId: string }) | null> {
  const c = (await tx.query<{ id: string; cadastrado_em: string }>(
    `/* guarda:marcos-cliente */
     SELECT p.id::text, (p.criado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS cadastrado_em
       FROM clientes c JOIN clientes p ON p.id = COALESCE(CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id END, c.id)
      WHERE c.id = $2::uuid AND c.empresa_id = $1::uuid AND p.empresa_id = $1::uuid`, [empresaId, clienteId])).rows[0];
  if (!c) return null;
  const grupo = `SELECT id FROM clientes WHERE empresa_id = $1::uuid AND (id = $2::uuid OR (status = 'MESCLADO' AND cliente_principal_id = $2::uuid))`;
  const festas = (await tx.query<{ data_evento: string; ultimo_pagamento: string | null; cancelada_em: string | null }>(
    `/* guarda:marcos-festas */
     SELECT f.data_evento::text,
            (SELECT max((COALESCE(r.confirmado_em, r.recebido_em) AT TIME ZONE 'America/Sao_Paulo')::date)::text
               FROM contrato_versoes v JOIN pagamentos pg ON pg.contrato_versao_id = v.id
               JOIN pagamento_recebimentos r ON r.pagamento_id = pg.id
              WHERE v.contrato_id = k.id AND r.status = 'CONFIRMADO') AS ultimo_pagamento,
            CASE WHEN k.cancelado_em IS NOT NULL OR f.status = 'CANCELADO'
                 THEN (COALESCE(k.cancelado_em, f.atualizado_em) AT TIME ZONE 'America/Sao_Paulo')::date::text END AS cancelada_em
       FROM fechamentos f JOIN contratos k ON k.fechamento_id = f.id
      WHERE f.cliente_id IN (${grupo}) AND k.assinado_em IS NOT NULL`, [empresaId, c.id])).rows;
  const t = await tabelas(tx);
  if (t.importacoes) {
    const naoIntegrada = t.integracao ? " AND NOT EXISTS (SELECT 1 FROM contrato_importacoes ci WHERE ci.importacao_id = i.id AND ci.empresa_id = i.empresa_id)" : "";
    const importadas = (await tx.query<{ data_evento: string }>(
      `/* guarda:marcos-importadas */
       SELECT CASE WHEN i.resultado->'contratoHistorico'->'evento'->>'data' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                   THEN i.resultado->'contratoHistorico'->'evento'->>'data'
                   ELSE (i.atualizado_em AT TIME ZONE 'America/Sao_Paulo')::date::text END AS data_evento
         FROM ia_importacoes i
        WHERE i.empresa_id = $1::uuid AND i.status = 'IMPORTADA' AND i.cliente_id IN (${grupo})${naoIntegrada}`, [empresaId, c.id])).rows;
    for (const i of importadas) festas.push({ data_evento: i.data_evento, ultimo_pagamento: null, cancelada_em: null });
  }
  const partes: string[] = [];
  if (t.conversas) partes.push(`SELECT 'WHATSAPP' AS origem, (w.ultima_entrada_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
      FROM whatsapp_atendimento_conversas w JOIN clientes g ON g.id IN (${grupo})
     WHERE w.empresa_id = $1::uuid AND kidmais086_destino(w.contato) IN (kidmais086_destino(g.whatsapp), kidmais086_destino(g.telefone))`);
  if (t.contatos) partes.push(`SELECT 'FORMULARIO_SITE', (m.recebido_em AT TIME ZONE 'America/Sao_Paulo')::date
      FROM marketing_contatos m WHERE m.empresa_id = $1::uuid AND m.cliente_id IN (${grupo})`);
  if (t.satisfacao) partes.push(`SELECT 'PESQUISA', (s.respondido_em AT TIME ZONE 'America/Sao_Paulo')::date
      FROM satisfacao_envios s WHERE s.empresa_id = $1::uuid AND s.cliente_id IN (${grupo}) AND s.respondido_em IS NOT NULL`);
  const contatos = partes.length === 0 ? [] : (await tx.query<{ origem: Exclude<OrigemContato, "CADASTRO">; dia: string }>(
    `/* guarda:marcos-contatos */ SELECT origem, max(dia)::text AS dia FROM (${partes.join(" UNION ALL ")}) x WHERE dia IS NOT NULL GROUP BY origem`,
    [empresaId, c.id])).rows;
  const saida = !t.saidas ? null : (await tx.query<{ dia: string | null }>(
    `/* guarda:marcos-saida */
     SELECT (min(s.saiu_em) AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
       FROM marketing_saidas_contato s JOIN clientes g ON g.id IN (${grupo})
      WHERE s.empresa_id = $1::uuid AND s.encerrada_em IS NULL
        AND ((s.tipo = 'TELEFONE' AND s.valor IN (kidmais086_destino(g.whatsapp), kidmais086_destino(g.telefone)))
          OR (s.tipo = 'EMAIL' AND s.valor = kidmais127_email(g.email)))`, [empresaId, c.id])).rows[0]?.dia ?? null;
  return { clienteId: c.id, ...calcularMarcos({
    cadastradoEm: c.cadastrado_em,
    festas: festas.map((f) => ({ dataEvento: f.data_evento, ultimoPagamento: f.ultimo_pagamento, canceladaEm: f.cancelada_em })),
    contatos, saidaCampanhas: saida,
  }) };
}
