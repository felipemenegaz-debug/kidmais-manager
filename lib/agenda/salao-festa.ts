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
/** gravou: o salão do destino da revisão mudou nesta chamada (hash e número podem ter mudado; quem chama relê). */
export type EscolhaSalao = { exigido: boolean; salao: string | null; gravou?: boolean };

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
  /** S-C: convidados da festa; entre os livres, prefere salão que comporta (NULL comporta). Não é filtro. */
  convidados: number | null;
};

async function instalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * Primeiro salão elegível e livre para o alvo, preferindo o atual; null quando não há nenhum.
 * S-C: depois do preferido, os que comportam os convidados vêm primeiro; sem nenhum que comporte, fica o primeiro livre
 * (limite declarado no plano: a garantia do cliente público é a revalidação na cotação e na criação).
 */
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
      ORDER BY (s.id = $9::uuid) DESC NULLS LAST, COALESCE(s.capacidade_convidados >= $10::int, true) DESC, s.ordem, s.nome
      LIMIT 1`,
    [alvo.fechamentoId, alvo.data, alvo.inicio, alvo.fim, alvo.configuracaoId, alvo.empresaId, alvo.estabelecimentoId, alvo.pacoteId, alvo.preferido, alvo.convidados],
  );
  return r.rows[0]?.id ?? null;
}

/** 102 instalada: o salão tem mínimo de convidados (comporta = mínimo ≤ N ≤ capacidade). */
async function minimoInstalado(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'convidados_minimo' AND NOT attisdropped) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * S-E (R-E2/R3-E5): salões ELEGÍVEIS, LIVRES e que COMPORTAM estritamente o alvo (mínimo ≤ N ≤ capacidade; limite nulo
 * aberto; festa sem número de convidados não é filtrada por capacidade), opcionalmente só o salão `somente`. Mesma elegibilidade e
 * conflito de salaoElegivelLivre, sem fallback para quem não comporta. Ordem: menor capacidade que comporta, nulos por
 * último, depois (ordem, id).
 */
async function saloesQueServem(tx: DbExecutor, alvo: Omit<Alvo, 'preferido'>, somente: string | null) {
  const elegivel = (await combinadosInstalados(tx)) ? "AND kidmais098_salao_elegivel(s.id)" : "";
  const minimo = (await minimoInstalado(tx)) ? "AND (s.convidados_minimo IS NULL OR $9::int >= s.convidados_minimo)" : "";
  const r = await tx.query<{ id: string; nome: string }>(
    `SELECT s.id::text AS id, s.nome
       FROM agenda_saloes s
      WHERE s.ativo AND s.empresa_id = $6::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM $7::uuid ${elegivel}
        AND ($10::uuid IS NULL OR s.id = $10::uuid)
        AND (NOT EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = $5::uuid)
             OR EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = $5::uuid AND h.salao_id = s.id))
        AND (NOT EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = $8::uuid)
             OR EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = $8::uuid AND p.salao_id = s.id))
        AND ($9::int IS NULL OR ((s.capacidade_convidados IS NULL OR $9::int <= s.capacidade_convidados) ${minimo}))
        AND NOT kidmais094_conflito_ocupacao($1::uuid, $2::date, $3::time, $4::time, $6::uuid, $7::uuid, $5::uuid, s.id)
      ORDER BY s.capacidade_convidados NULLS LAST, s.ordem, s.id`,
    [alvo.fechamentoId, alvo.data, alvo.inicio, alvo.fim, alvo.configuracaoId, alvo.empresaId, alvo.estabelecimentoId, alvo.pacoteId, alvo.convidados, somente],
  );
  return r.rows;
}

export type SalaoDaEmissao =
  | { porSalao: false }
  | { porSalao: true; salao: { id: string; nome: string } }
  | { porSalao: true; salao: null; motivo: 'ESCOLHIDO_NAO_SERVE' | 'PREFERIDO_NAO_SERVE' | 'SEM_SALAO_QUE_SERVE' };

/** 106 instalada: fechamentos.salao_preferido_id existe (preferência do cliente, fase S-D). */
export async function preferidoInstalado(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.fechamentos') AND attname = 'salao_preferido_id' AND NOT attisdropped) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/** Uuid nulo: destino de uma festa que ainda não existe (criação), para a função de conflito da 094. */
const SEM_FESTA = '00000000-0000-0000-0000-000000000000';

/**
 * S-D (R-D1/R3-D4): o salão `salaoId` SERVE ao destino — elegível no escopo, permitido pelo horário e pelo pacote,
 * comporta (mínimo ≤ N ≤ capacidade) e está LIVRE no intervalo — pela MESMA regra estrita da emissão (saloesQueServem).
 * Sem a 094 ou fora de POR_SALAO: false. Chamar com a trava da data adquirida. Nunca devolve outro salão.
 */
export async function salaoServeNoDestino(
  tx: DbExecutor,
  destino: { fechamentoId?: string | null; data: string; inicio: string; fim: string; configuracaoId: string; pacoteId: string;
    empresaId: string; estabelecimentoId: string | null; convidados: number | null },
  salaoId: string,
) {
  if (!(await instalada(tx))) return false;
  const porSalao = (await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = $1::uuid AND c.estabelecimento_id IS NOT DISTINCT FROM $2::uuid
                       AND c.capacidade_tipo = 'POR_SALAO') AS ok`,
    [destino.empresaId, destino.estabelecimentoId],
  )).rows[0]?.ok === true;
  if (!porSalao) return false;
  const servem = await saloesQueServem(tx, { ...destino, fechamentoId: destino.fechamentoId ?? SEM_FESTA }, salaoId);
  return servem.some((s) => s.id === salaoId);
}

/**
 * S-E (R-E1/R-E2/R3-E5): salão a fixar no documento na EMISSÃO de uma versão. SÓ LEITURA: não grava fechamentos.salao_id
 * nem ocupa a agenda (a ocupação continua nascendo na assinatura). Chamar com a trava da data adquirida (leitura coerente).
 * Ordem: o salão já escolhido pela equipe (fechamentos.salao_id) — se não serve mais, recusa (uma escolha explícita nunca
 * vira outra); sem escolha, o automático estrito (saloesQueServem). Sem 094 ou fora de POR_SALAO: documento como antes.
 * documentoAtual: o salão do documento em elaboração; se ainda serve, fica (o documento não troca de salão sozinho).
 * proposta: destino da revisão inicial (antes da 1ª assinatura); o salão gravado da festa só conta como escolha da
 * equipe se a proposta mantém data, horário e configuração (a edição de qualquer um deles zera o salão, edicao.repository).
 * S-D: a preferência do cliente (fechamentos.salao_preferido_id, 106) vem logo depois da equipe e antes do documento
 * atual e do automático; se não serve, recusa com PREFERIDO_NAO_SERVE (nunca vira outro salão).
 */
export type DestinoProposto = { data: string; inicio: string; fim: string; configuracaoId: string; pacoteId: string; convidados: number | null };

export async function escolherSalaoParaEmissao(
  tx: DbExecutor, fechamentoId: string, documentoAtual: string | null = null, proposta?: DestinoProposto,
): Promise<SalaoDaEmissao> {
  if (!(await instalada(tx))) return { porSalao: false };
  const f = (await tx.query<{
    salao_id: string | null; por_salao: boolean; data: string; inicio: string; fim: string; cfg: string; pacote: string;
    empresa: string; unidade: string | null; convidados: number | null;
  }>(
    `SELECT f.salao_id::text AS salao_id, ${POR_SALAO} AS por_salao, f.data_evento::text AS data, f.convidados,
            f.horario_inicio::text AS inicio, f.horario_fim::text AS fim, f.configuracao_agenda_id::text AS cfg,
            f.pacote_id::text AS pacote, f.empresa_id::text AS empresa, f.estabelecimento_id::text AS unidade
       FROM fechamentos f WHERE f.id = $1::uuid`,
    [fechamentoId],
  )).rows[0];
  if (!f || !f.por_salao) return { porSalao: false };
  // S-D (D5.6/R3-E5): a preferência do cliente (106) é uma escolha EXPLÍCITA, logo depois da equipe.
  const preferido = (await preferidoInstalado(tx))
    ? (await tx.query<{ p: string | null }>(`SELECT salao_preferido_id::text AS p FROM fechamentos WHERE id = $1::uuid`, [fechamentoId])).rows[0]?.p ?? null
    : null;
  const mesmoDestino = !proposta || (proposta.data === f.data && proposta.inicio.slice(0, 5) === f.inicio.slice(0, 5)
    && proposta.fim.slice(0, 5) === f.fim.slice(0, 5) && proposta.configuracaoId === f.cfg);
  const equipe = mesmoDestino ? f.salao_id : null;
  const alvo = proposta
    ? { fechamentoId, ...proposta, empresaId: f.empresa, estabelecimentoId: f.unidade }
    : { fechamentoId, data: f.data, inicio: f.inicio, fim: f.fim, configuracaoId: f.cfg, pacoteId: f.pacote,
      empresaId: f.empresa, estabelecimentoId: f.unidade, convidados: f.convidados };
  const servem = await saloesQueServem(tx, alvo, equipe);
  if (equipe) return servem[0] ? { porSalao: true, salao: servem[0] } : { porSalao: true, salao: null, motivo: 'ESCOLHIDO_NAO_SERVE' };
  // Preferência do cliente para o MESMO destino da criação: serve ou a emissão é recusada (nunca troca em silêncio; a
  // equipe escolhe outro salão de forma explícita e o cliente vê esse salão no contrato antes de assinar).
  if (preferido && mesmoDestino) {
    const dele = (await saloesQueServem(tx, alvo, preferido))[0];
    return dele ? { porSalao: true, salao: dele } : { porSalao: true, salao: null, motivo: 'PREFERIDO_NAO_SERVE' };
  }
  const atual = documentoAtual ? (await saloesQueServem(tx, alvo, documentoAtual))[0] : undefined;
  if (atual) return { porSalao: true, salao: atual };
  return servem[0] ? { porSalao: true, salao: servem[0] } : { porSalao: true, salao: null, motivo: 'SEM_SALAO_QUE_SERVE' };
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

/**
 * Salão da própria festa (confirmação, formalização, importação). Grava a escolha quando muda.
 * S-E (R-E2/R3-E2): com `exigido` (o salão fixado no documento V3), NÃO escolhe: confere que a festa não está em outro
 * salão e que o exigido serve (elegível, livre e comporta) e o grava se a festa ainda não tiver salão; senão, sem salão.
 * capacidade: false = não reavalia convidados (salão da base ao assinar uma revisão, que leva a festa ao destino).
 * Nunca há substituto.
 */
export async function escolherSalao(tx: DbExecutor, fechamentoId: string, exigido?: string, opcoes: { capacidade?: boolean } = {}): Promise<EscolhaSalao> {
  if (!(await instalada(tx))) return { exigido: false, salao: null };
  const festa = await tx.query<{
    salao_id: string | null; por_salao: boolean; data: string; inicio: string; fim: string; cfg: string; pacote: string;
    empresa: string; unidade: string | null; convidados: number | null;
  }>(
    `SELECT f.salao_id::text AS salao_id, ${POR_SALAO} AS por_salao, f.data_evento::text AS data, f.convidados,
            f.horario_inicio::text AS inicio, f.horario_fim::text AS fim, f.configuracao_agenda_id::text AS cfg,
            f.pacote_id::text AS pacote, f.empresa_id::text AS empresa, f.estabelecimento_id::text AS unidade
       FROM fechamentos f WHERE f.id = $1::uuid FOR UPDATE`,
    [fechamentoId],
  );
  const f = festa.rows[0];
  if (!f || !f.por_salao) return { exigido: false, salao: f?.salao_id ?? null };
  if (exigido) {
    if (f.salao_id && f.salao_id !== exigido) return { exigido: true, salao: null };
    const serve = (await saloesQueServem(tx, {
      fechamentoId, data: f.data, inicio: f.inicio, fim: f.fim, configuracaoId: f.cfg, pacoteId: f.pacote,
      empresaId: f.empresa, estabelecimentoId: f.unidade, convidados: opcoes.capacidade === false ? null : f.convidados,
    }, exigido))[0];
    if (!serve) return { exigido: true, salao: null };
    if (f.salao_id !== exigido) await tx.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [fechamentoId, exigido]);
    return { exigido: true, salao: exigido };
  }
  const salao = await salaoElegivelLivre(tx, {
    fechamentoId, data: f.data, inicio: f.inicio, fim: f.fim, configuracaoId: f.cfg, pacoteId: f.pacote,
    empresaId: f.empresa, estabelecimentoId: f.unidade, preferido: f.salao_id, convidados: f.convidados,
  });
  if (salao && salao !== f.salao_id) await tx.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [fechamentoId, salao]);
  return { exigido: true, salao };
}

/**
 * Salão do DESTINO de uma remarcação (no hold): horário, pacote, convidados e intervalo da revisão; prefere o salão já
 * definido (destino ou, sem ele, o atual da festa) se ele servir no destino. Grava em fechamento_revisoes.salao_id
 * (copiado para a festa ao aplicar).
 */
export async function escolherSalaoDestinoRevisao(tx: DbExecutor, revisaoId: string): Promise<EscolhaSalao> {
  if (!(await instalada(tx))) return { exigido: false, salao: null };
  const destino = await tx.query<{
    fechamento_id: string; salao_atual: string | null; salao_destino: string | null; estado: string; por_salao: boolean;
    data: string; inicio: string; fim: string; cfg: string; pacote: string; empresa: string; unidade: string | null;
    convidados: number | null;
  }>(
    `SELECT r.fechamento_id::text AS fechamento_id, r.convidados, f.salao_id::text AS salao_atual, r.salao_id::text AS salao_destino,
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
  // S-E (P2 do Astra, 27/10): o documento V3 da revisão fixa este salão, então a escolha é ESTRITA como na emissão
  // (saloesQueServem: mínimo ≤ N ≤ capacidade, sem fallback para quem não comporta). O definido fica se ainda serve;
  // senão, o menor que comporta; sem nenhum, null (o destino fica indisponível).
  const alvo = {
    fechamentoId: d.fechamento_id, data: d.data, inicio: d.inicio, fim: d.fim, configuracaoId: d.cfg, pacoteId: d.pacote,
    empresaId: d.empresa, estabelecimentoId: d.unidade, convidados: d.convidados,
  };
  const mantido = definido ? (await saloesQueServem(tx, alvo, definido))[0]?.id ?? null : null;
  // Revisão congelada não muda (guarda da 014): só confere que o salão já definido continua servindo (mesma regra estrita).
  if (d.estado !== 'EM_ELABORACAO') return { exigido: true, salao: mantido };
  const salao = mantido ?? (await saloesQueServem(tx, alvo, null))[0]?.id ?? null;
  if (salao !== d.salao_destino) {
    await tx.query(`UPDATE fechamento_revisoes SET salao_id = $2::uuid WHERE id = $1::uuid`, [revisaoId, salao]);
    await recalcularHashRevisao(tx, revisaoId);
    return { exigido: true, salao, gravou: true };
  }
  return { exigido: true, salao };
}

/**
 * S-E (104, plano rev. 4.1, R41-1): único ponto que grava o salão do destino numa revisão aberta; logo depois, num comando
 * separado, o hash volta a ser o da função do banco. Revisão com hash_versao 2 inclui o salão no hash: trocá-lo é mudança
 * de conteúdo (revisão + 1 e aprovações zeradas, como em salvarOperacaoPreparada; guardas da 014). Revisão em 1 (ou banco
 * sem a 104) devolve o mesmo hash e nada muda. Congelada não é tocada (o filtro por EM_ELABORACAO garante).
 */
export async function recalcularHashRevisao(tx: DbExecutor, revisaoId: string) {
  await tx.query(
    `UPDATE fechamento_revisoes
        SET conteudo_hash = kidmais_hash_revisao_operacional(id), revisao = revisao + 1,
            revisao_comercial_aprovada = NULL, aprovacao_negociacao_id = NULL,
            aprovado_comercial_por_usuario_id = NULL, aprovado_comercial_em = NULL
      WHERE id = $1::uuid AND estado = 'EM_ELABORACAO'
        AND conteudo_hash IS DISTINCT FROM kidmais_hash_revisao_operacional(id)`,
    [revisaoId],
  );
}

/**
 * S-E (R-E3): escolha EXPLÍCITA da equipe para o destino de uma revisão aberta (quem chama já conferiu que o salão serve).
 * Mesmo módulo e mesma regra do seletor: grava e, em seguida, recalcula o hash (R41-1). Só EM_ELABORACAO.
 */
export async function definirSalaoDestinoRevisao(tx: DbExecutor, revisaoId: string, salaoId: string) {
  const r = await tx.query(`UPDATE fechamento_revisoes SET salao_id = $2::uuid WHERE id = $1::uuid AND estado = 'EM_ELABORACAO'`, [revisaoId, salaoId]);
  if (r.rowCount !== 1) throw Object.assign(new Error('Revisão não está em elaboração.'), { code: '23514' });
  await recalcularHashRevisao(tx, revisaoId);
}

/** 104 aplicada: a revisão tem versão de hash (2 = com salão). */
export async function hashVersaoInstalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.fechamento_revisoes')
                     AND attname = 'hash_versao' AND NOT attisdropped) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * S-E (R-E2, revisão): salão do documento da preparação = o destino gravado na revisão (cópia do nome). Fora de POR_SALAO
 * (ou sem 094): undefined, documento como antes. Em POR_SALAO sem destino: null (a assinatura recusa).
 */
export async function salaoDoDestinoRevisao(tx: DbExecutor, revisaoId: string): Promise<{ id: string; nome: string } | null | undefined> {
  if (!(await instalada(tx))) return undefined;
  const r = (await tx.query<{ por_salao: boolean; id: string | null; nome: string | null }>(
    `SELECT ${POR_SALAO} AS por_salao, s.id::text AS id, s.nome
       FROM fechamento_revisoes r JOIN fechamentos f ON f.id = r.fechamento_id LEFT JOIN agenda_saloes s ON s.id = r.salao_id
      WHERE r.id = $1::uuid`,
    [revisaoId],
  )).rows[0];
  if (!r || !r.por_salao) return undefined;
  return r.id ? { id: r.id, nome: r.nome! } : null;
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

/**
 * Na formalização e na importação: o salão da festa do contrato; sem salão elegível livre, recusa.
 * S-E: `exigido` = salão fixado no documento (salaoExigidoDaFesta); indisponível ou festa em outro salão = recusa.
 */
export async function escolherSalaoDoContrato(tx: DbExecutor, contratoId: string, exigido?: string, opcoes: { capacidade?: boolean } = {}) {
  const r = await tx.query<{ fechamento_id: string }>(`SELECT fechamento_id::text AS fechamento_id FROM contratos WHERE id = $1::uuid`, [contratoId]);
  if (!r.rows[0]) return;
  const escolha = await escolherSalao(tx, r.rows[0].fechamento_id, exigido, opcoes);
  if (exigido && !escolha.salao) {
    throw Object.assign(new Error('O salão deste contrato não está mais disponível; o buffet vai enviar uma nova versão.'), { code: '23514', salaoExigido: true });
  }
  if (escolha.exigido && !escolha.salao) {
    // Mesma mensagem e código da revalidação do destino (kidmais019_validar_destino).
    throw Object.assign(new Error('Horário indisponível: formalização não concluída'), { code: '23514' });
  }
}
