import type { DbExecutor } from "../db/contracts.ts";

/**
 * 094 (decisão de Felipe em 22/10/2026): com capacidade por salão, o sistema escolhe o salão da festa — um salão
 * ATIVO da unidade, permitido pelo horário e pelo pacote, e livre no intervalo; o salão atual fica se ainda servir.
 * Pareceres do Astra (P1): sem salão elegível livre, a festa NÃO pode ocupar a agenda (quem chama recusa), e o salão
 * já gravado nunca é aceito sem revalidar; a remarcação valida o salão contra o DESTINO.
 * Chamar com os locks da data já adquiridos e ANTES da conferência de conflito.
 * 098 (salão combinado): candidato só se ELEGÍVEL (ativo e, se combinado, com todos os membros ativos) e permitido por
 * identidade no horário e no pacote (A e B liberados não liberam AB); o conflito é por interseção de salões (função
 * da 094 com a regra da 098). A trava dos salões fica na validação diferida do banco, por último e em ordem de id.
 */
export type EscolhaSalao = { exigido: boolean; salao: string | null };

type Alvo = {
  fechamentoId: string;
  data: string;
  inicio: string;
  fim: string;
  configuracaoId: string;
  pacoteId: string;
  empresaId: string;
  estabelecimentoId: string | null;
  preferido: string | null;
};

async function instalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/** Primeiro salão elegível e livre para o alvo, preferindo o atual; null quando não há nenhum. */
async function salaoElegivelLivre(tx: DbExecutor, alvo: Alvo): Promise<string | null> {
  const elegivel = (await combinadosInstalados(tx)) ? "AND kidmais098_salao_elegivel(s.id)" : "";
  const r = await tx.query<{ id: string }>(
    `SELECT s.id::text AS id
       FROM agenda_saloes s
      WHERE s.ativo AND s.empresa_id = $6::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM $7::uuid ${elegivel}
        AND (NOT EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = $5::uuid)
             OR EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = $5::uuid AND h.salao_id = s.id))
        AND (NOT EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = $8::uuid)
             OR EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = $8::uuid AND p.salao_id = s.id))
        AND NOT kidmais094_conflito_ocupacao($1::uuid, $2::date, $3::time, $4::time, $6::uuid, $7::uuid, $5::uuid, s.id)
      ORDER BY (s.id = $9::uuid) DESC NULLS LAST, s.ordem, s.nome
      LIMIT 1`,
    [alvo.fechamentoId, alvo.data, alvo.inicio, alvo.fim, alvo.configuracaoId, alvo.empresaId, alvo.estabelecimentoId, alvo.pacoteId, alvo.preferido],
  );
  return r.rows[0]?.id ?? null;
}

/** 098 instalada (salão combinado e elegibilidade). */
export async function combinadosInstalados(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_salao_elegivel(uuid)') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

const POR_SALAO =`EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = f.empresa_id
                     AND c.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id AND c.capacidade_tipo = 'POR_SALAO')`;

export async function escolherSalaoDaFesta(tx: DbExecutor, fechamentoId: string): Promise<string | null> {
  return (await escolherSalao(tx, fechamentoId)).salao;
}

/** Salão da própria festa (confirmação, formalização, importação). Grava a escolha quando muda. */
export async function escolherSalao(tx: DbExecutor, fechamentoId: string): Promise<EscolhaSalao> {
  if (!(await instalada(tx))) return { exigido: false, salao: null };
  const festa = await tx.query<{
    salao_id: string | null; por_salao: boolean; data: string; inicio: string; fim: string; cfg: string; pacote: string;
    empresa: string; unidade: string | null;
  }>(
    `SELECT f.salao_id::text AS salao_id, ${POR_SALAO} AS por_salao, f.data_evento::text AS data,
            f.horario_inicio::text AS inicio, f.horario_fim::text AS fim, f.configuracao_agenda_id::text AS cfg,
            f.pacote_id::text AS pacote, f.empresa_id::text AS empresa, f.estabelecimento_id::text AS unidade
       FROM fechamentos f WHERE f.id = $1::uuid FOR UPDATE`,
    [fechamentoId],
  );
  const f = festa.rows[0];
  if (!f || !f.por_salao) return { exigido: false, salao: f?.salao_id ?? null };
  const salao = await salaoElegivelLivre(tx, {
    fechamentoId, data: f.data, inicio: f.inicio, fim: f.fim, configuracaoId: f.cfg, pacoteId: f.pacote,
    empresaId: f.empresa, estabelecimentoId: f.unidade, preferido: f.salao_id,
  });
  if (salao && salao !== f.salao_id) await tx.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [fechamentoId, salao]);
  return { exigido: true, salao };
}

/**
 * Salão do DESTINO de uma remarcação (no hold): horário, pacote e intervalo da revisão; prefere o salão atual da
 * festa se ele servir no destino. Grava em fechamento_revisoes.salao_id (copiado para a festa ao aplicar).
 */
export async function escolherSalaoDestinoRevisao(tx: DbExecutor, revisaoId: string): Promise<EscolhaSalao> {
  if (!(await instalada(tx))) return { exigido: false, salao: null };
  const destino = await tx.query<{
    fechamento_id: string; salao_atual: string | null; salao_destino: string | null; estado: string; por_salao: boolean;
    data: string; inicio: string; fim: string; cfg: string; pacote: string; empresa: string; unidade: string | null;
  }>(
    `SELECT r.fechamento_id::text AS fechamento_id, f.salao_id::text AS salao_atual, r.salao_id::text AS salao_destino,
            r.estado, ${POR_SALAO} AS por_salao,
            r.data_evento::text AS data, r.horario_inicio::text AS inicio, r.horario_fim::text AS fim,
            r.configuracao_agenda_id::text AS cfg, r.pacote_id::text AS pacote, f.empresa_id::text AS empresa,
            f.estabelecimento_id::text AS unidade
       FROM fechamento_revisoes r JOIN fechamentos f ON f.id = r.fechamento_id
      WHERE r.id = $1::uuid FOR UPDATE OF r`,
    [revisaoId],
  );
  const d = destino.rows[0];
  if (!d || !d.por_salao) return { exigido: false, salao: null };
  const definido = d.salao_destino ?? d.salao_atual;
  const salao = await salaoElegivelLivre(tx, {
    fechamentoId: d.fechamento_id, data: d.data, inicio: d.inicio, fim: d.fim, configuracaoId: d.cfg, pacoteId: d.pacote,
    empresaId: d.empresa, estabelecimentoId: d.unidade, preferido: definido,
  });
  // Revisão congelada não muda (guarda da 014): só confere que o salão já definido continua elegível e livre.
  if (d.estado !== 'EM_ELABORACAO') return { exigido: true, salao: salao && salao === definido ? salao : null };
  if (salao !== d.salao_destino) await tx.query(`UPDATE fechamento_revisoes SET salao_id = $2::uuid WHERE id = $1::uuid`, [revisaoId, salao]);
  return { exigido: true, salao };
}

/** Ao aplicar a revisão, a festa passa ao salão escolhido para o destino (sem a 094, nada a copiar). */
export async function aplicarSalaoDaRevisao(tx: DbExecutor, revisaoId: string) {
  if (!(await instalada(tx))) return;
  await tx.query(
    `UPDATE fechamentos f SET salao_id = r.salao_id
       FROM fechamento_revisoes r
      WHERE r.id = $1::uuid AND f.id = r.fechamento_id AND r.salao_id IS NOT NULL`,
    [revisaoId],
  );
}

/** Na formalização e na importação: o salão da festa do contrato; sem salão elegível livre, recusa. */
export async function escolherSalaoDoContrato(tx: DbExecutor, contratoId: string) {
  const r = await tx.query<{ fechamento_id: string }>(`SELECT fechamento_id::text AS fechamento_id FROM contratos WHERE id = $1::uuid`, [contratoId]);
  if (!r.rows[0]) return;
  const escolha = await escolherSalao(tx, r.rows[0].fechamento_id);
  if (escolha.exigido && !escolha.salao) {
    // Mesma mensagem e código da revalidação do destino (kidmais019_validar_destino).
    throw Object.assign(new Error('Horário indisponível: formalização não concluída'), { code: '23514' });
  }
}
