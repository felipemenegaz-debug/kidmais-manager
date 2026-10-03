import type { DbExecutor } from '../../db/contracts.ts';
import type { SnapshotHistorico } from '../../importacao-contrato/plano.ts';

/**
 * Persistência da integração de contratos importados (migration 061). Toda leitura filtra a empresa comprovada
 * no próprio SQL; outra empresa ou inexistente responde como ausente. Nenhuma função decide regra de negócio.
 */
/** Exige a 061 (vínculo) E a 062 (agenda por empresa e unidade): com agenda global a integração fica indisponível. */
export async function integracaoDisponivel(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.contrato_importacoes') IS NOT NULL AND to_regclass('public.contrato_importacao_financeiro') IS NOT NULL
        AND to_regclass('public.ia_importacoes') IS NOT NULL
        AND to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

export type ImportacaoParaIntegrar = { id: string; clienteId: string; documentoId: string; status: string; snapshot: SnapshotHistorico | null };

export async function lerImportacao(tx: DbExecutor, empresaId: string, importacaoId: string, travar: boolean): Promise<ImportacaoParaIntegrar | null> {
  const r = await tx.query<{ id: string; cliente_id: string | null; documento_id: string; status: string; snapshot: SnapshotHistorico | null }>(
    `SELECT id::text, cliente_id::text, documento_id::text, status, resultado->'contratoHistorico' AS snapshot
       FROM ia_importacoes WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? ' FOR UPDATE' : ''}`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  if (!l || !l.cliente_id) return null;
  return { id: l.id, clienteId: l.cliente_id, documentoId: l.documento_id, status: l.status, snapshot: l.snapshot && typeof l.snapshot === 'object' ? l.snapshot : null };
}

export async function documentoOriginal(tx: DbExecutor, empresaId: string, documentoId: string) {
  const r = await tx.query<{ id: string; sha256: string }>(
    `SELECT id::text, sha256 FROM ia_documento_originais WHERE documento_id = $1::uuid AND empresa_id = $2::uuid ORDER BY versao DESC LIMIT 1`,
    [documentoId, empresaId],
  );
  return r.rows[0] ?? null;
}

export type ClienteIntegracao = { id: string; nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null; status: string };

export async function clienteDaEmpresa(tx: DbExecutor, empresaId: string, clienteId: string, travar: boolean): Promise<ClienteIntegracao | null> {
  const r = await tx.query<{ id: string; nome_completo: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null; status: string }>(
    `SELECT id::text, nome_completo, cpf, telefone, whatsapp, email, status FROM clientes
      WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? ' FOR SHARE' : ''}`,
    [clienteId, empresaId],
  );
  const l = r.rows[0];
  return l ? { id: l.id, nomeCompleto: l.nome_completo, cpf: l.cpf, telefone: l.telefone, whatsapp: l.whatsapp, email: l.email, status: l.status } : null;
}

/** Unidades elegíveis para agenda (regra única da 062: kidmais062_unidade_agendavel; D6). A integração exige a 062. */
export async function estabelecimentosAtivos(tx: DbExecutor, empresaId: string) {
  const r = await tx.query<{ id: string; nome: string }>(
    `SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND public.kidmais062_unidade_agendavel(empresa_id, id) ORDER BY nome, id`,
    [empresaId],
  );
  return r.rows;
}

export type PacoteReferencia = { id: string; codigo: string; nome: string; duracaoMinutos: number | null };

/** Pacotes da empresa (ativos primeiro) com alguma linha de preço: o Core exige a âncora de preço no fechamento. */
export async function pacotesDaEmpresa(tx: DbExecutor, empresaId: string): Promise<Array<PacoteReferencia & { ativo: boolean }>> {
  const r = await tx.query<{ id: string; codigo: string; nome: string; duracao_minutos: number | null; ativo: boolean }>(
    `SELECT p.id::text, p.codigo, p.nome, p.duracao_minutos, p.ativo FROM pacotes p
      WHERE p.empresa_id = $1::uuid
        AND EXISTS(SELECT 1 FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id AND t.empresa_id = p.empresa_id WHERE pp.pacote_id = p.id)
      ORDER BY p.ativo DESC, p.ordem_exibicao, p.nome`,
    [empresaId],
  );
  return r.rows.map((l) => ({ id: l.id, codigo: l.codigo, nome: l.nome, duracaoMinutos: l.duracao_minutos == null ? null : Number(l.duracao_minutos), ativo: l.ativo }));
}

export async function pacoteDaEmpresa(tx: DbExecutor, empresaId: string, pacoteId: string): Promise<PacoteReferencia | null> {
  const r = await tx.query<{ id: string; codigo: string; nome: string; duracao_minutos: number | null }>(
    `SELECT id::text, codigo, nome, duracao_minutos FROM pacotes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR SHARE`,
    [pacoteId, empresaId],
  );
  const l = r.rows[0];
  return l ? { id: l.id, codigo: l.codigo, nome: l.nome, duracaoMinutos: l.duracao_minutos == null ? null : Number(l.duracao_minutos) } : null;
}

/**
 * Âncora de preço do fechamento (o Core exige pacote/tabela/preço coerentes da mesma empresa). Não define valor:
 * o contratado é o do documento. Preferência: tabela vigente na data do evento, depois ativa, categoria do dia,
 * faixa de convidados, tabela mais recente.
 */
export async function precoReferencia(tx: DbExecutor, empresaId: string, pacoteId: string, data: string, convidados: number) {
  const r = await tx.query<{ tabela_preco_id: string; preco_pacote_id: string; categoria: 'PADRAO' | 'NOBRE' }>(
    `SELECT t.id::text AS tabela_preco_id, pp.id::text AS preco_pacote_id, pp.categoria_horario AS categoria
       FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      WHERE pp.pacote_id = $1::uuid AND t.empresa_id = $2::uuid
      ORDER BY (t.vigencia_inicio <= $3::date AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= $3::date)) DESC,
               t.ativa DESC,
               (pp.categoria_horario = CASE WHEN extract(isodow FROM $3::date) IN (6, 7) THEN 'NOBRE' ELSE 'PADRAO' END) DESC,
               ($4::int BETWEEN pp.convidados_min AND coalesce(pp.convidados_max, 32767)) DESC,
               pp.ativo DESC, t.vigencia_inicio DESC, pp.id
      LIMIT 1
      FOR SHARE OF pp, t`,
    [pacoteId, empresaId, data, convidados],
  );
  const l = r.rows[0];
  return l ? { tabelaPrecoId: l.tabela_preco_id, precoPacoteId: l.preco_pacote_id, categoria: l.categoria } : null;
}

/**
 * Turno que contém o início (ou o primeiro ativo), no mesmo nível que a disponibilidade usa (062, D5): unidade →
 * empresa → modelos globais. O turno é só classificação; o horário gravado é o do documento.
 */
export async function configuracaoAgenda(tx: DbExecutor, horarioInicio: string, empresaId: string, estabelecimentoId: string | null) {
  const r = await tx.query<{ id: string }>(
    `WITH candidatas AS (
       SELECT id, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, ordem_exibicao,
              CASE WHEN estabelecimento_id IS NOT NULL THEN 2 WHEN empresa_id IS NOT NULL THEN 1 ELSE 0 END AS nivel
         FROM configuracao_agenda
        WHERE ativo AND (empresa_id IS NULL OR (empresa_id = $2::uuid AND (estabelecimento_id IS NULL OR estabelecimento_id = $3::uuid)))
     )
     SELECT id::text FROM candidatas WHERE nivel = (SELECT max(nivel) FROM candidatas)
      ORDER BY ($1::time BETWEEN horario_inicio_padrao - make_interval(mins => tolerancia_inicio_minutos) AND horario_fim_padrao) DESC, ordem_exibicao, id
      LIMIT 1`,
    [horarioInicio, empresaId, estabelecimentoId],
  );
  return r.rows[0]?.id ?? null;
}

/** Lock da data no mesmo namespace do Core (kidmais:agenda:YYYY-MM-DD). Segura até o fim da transação. */
export async function travarData(tx: DbExecutor, data: string) {
  await tx.query('SELECT public.kidmais_lock_datas_revisao(ARRAY[$1::date])', [data]);
}

/**
 * Sobreposição no MESMO recurso (062: empresa/unidade) com contratação que ocupa agenda ou bloqueio que alcança o
 * recurso. Mesmas regras dos gatilhos; não identifica o ocupante. A integração só roda com a 062 instalada.
 */
export async function conflitoAgenda(tx: DbExecutor, data: string, inicio: string, fim: string, empresaId: string, estabelecimentoId: string | null) {
  const r = await tx.query<{ ocupado: boolean; bloqueado: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM public.kidmais062_ocupacoes_escopo($1::date, $1::date) o
                    WHERE o.horario_inicio < $3::time AND o.horario_fim > $2::time
                      AND public.kidmais062_mesmo_recurso($4::uuid, $5::uuid, o.empresa_id, o.estabelecimento_id)) AS ocupado,
            EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data = $1::date
                    AND public.kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, $4::uuid, $5::uuid)
                    AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio < $3::time AND b.horario_fim > $2::time))) AS bloqueado`,
    [data, inicio, fim, empresaId, estabelecimentoId],
  );
  return r.rows[0] ?? { ocupado: false, bloqueado: false };
}

/** Contratações do MESMO cliente no mesmo dia, nesta empresa: possível vínculo a conferir (nunca deduplicado sozinho). */
export async function possiveisVinculos(tx: DbExecutor, empresaId: string, clienteId: string, data: string) {
  const r = await tx.query<{ fechamento_id: string; contrato_id: string | null; status: string; horario_inicio: string; horario_fim: string; com_pagamento: boolean }>(
    `SELECT f.id::text AS fechamento_id, c.id::text AS contrato_id, coalesce(c.status, f.status) AS status,
            to_char(f.horario_inicio, 'HH24:MI') AS horario_inicio, to_char(f.horario_fim, 'HH24:MI') AS horario_fim,
            EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = c.id) AS com_pagamento
       FROM fechamentos f LEFT JOIN contratos c ON c.fechamento_id = f.id
      WHERE f.empresa_id = $1::uuid AND f.cliente_id = $2::uuid AND f.data_evento = $3::date
        AND f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO') AND coalesce(c.status, '') <> 'CANCELADO'
      ORDER BY f.horario_inicio, f.id`,
    [empresaId, clienteId, data],
  );
  return r.rows.map((l) => ({ fechamentoId: l.fechamento_id, contratoId: l.contrato_id, status: l.status, horario: `${l.horario_inicio}–${l.horario_fim}`, comPagamento: l.com_pagamento }));
}

export type VinculoExistente = {
  id: string; contratoId: string; fechamentoId: string; versaoId: string; payloadHash: string; chave: string;
  financeiroDeclarado: 'CONFERIDO' | 'NAO_CONFERIDO'; financeiro: { id: string; pagamentoId: string; payloadHash: string; chave: string } | null;
  /** Valor contratado da versão conferida (centavos): a pendência de pagamentos nunca muda o contratado. */
  valorContratadoCentavos: number;
};

export async function vinculoDaImportacao(tx: DbExecutor, empresaId: string, importacaoId: string): Promise<VinculoExistente | null> {
  const r = await tx.query<{ id: string; contrato_id: string; fechamento_id: string; versao_id: string; payload_hash: string; chave: string; declarado: 'CONFERIDO' | 'NAO_CONFERIDO'; fin_id: string | null; pagamento_id: string | null; fin_hash: string | null; fin_chave: string | null; valor_contratado: string | null }>(
    `SELECT ci.id::text, ci.contrato_id::text, ci.fechamento_id::text, ci.contrato_versao_id::text AS versao_id, ci.payload_hash,
            ci.chave_idempotencia::text AS chave, ci.financeiro_declarado AS declarado,
            f.id::text AS fin_id, f.pagamento_id::text, f.payload_hash AS fin_hash, f.chave_idempotencia::text AS fin_chave,
            (SELECT v.snapshot->'comercial'->>'valorFinalContrato' FROM contrato_versoes v WHERE v.id = ci.contrato_versao_id) AS valor_contratado
       FROM contrato_importacoes ci LEFT JOIN contrato_importacao_financeiro f ON f.contrato_importacao_id = ci.id
      WHERE ci.importacao_id = $1::uuid AND ci.empresa_id = $2::uuid`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    id: l.id, contratoId: l.contrato_id, fechamentoId: l.fechamento_id, versaoId: l.versao_id, payloadHash: l.payload_hash.trim(), chave: l.chave,
    financeiroDeclarado: l.declarado,
    financeiro: l.fin_id ? { id: l.fin_id, pagamentoId: l.pagamento_id!, payloadHash: (l.fin_hash ?? '').trim(), chave: l.fin_chave! } : null,
    valorContratadoCentavos: Math.round(Number(l.valor_contratado ?? 0) * 100),
  };
}

/** A chave de idempotência é global (UNIQUE); reutilizada em outra importação ⇒ conflito, sem dizer onde. */
export async function chaveUsadaEmOutra(tx: DbExecutor, chave: string, importacaoId: string) {
  const r = await tx.query<{ outra: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM contrato_importacoes WHERE chave_idempotencia = $1::uuid AND importacao_id <> $2::uuid)
         OR EXISTS(SELECT 1 FROM contrato_importacao_financeiro f JOIN contrato_importacoes ci ON ci.id = f.contrato_importacao_id
                    WHERE f.chave_idempotencia = $1::uuid AND ci.importacao_id <> $2::uuid) AS outra`,
    [chave, importacaoId],
  );
  return r.rows[0]?.outra === true;
}

/** Aniversariante ativo do cliente com o mesmo nome (o CRM já impede dois ativos com o mesmo nome no cliente). */
export async function aniversarianteDoCliente(tx: DbExecutor, clienteId: string, nome: string) {
  const r = await tx.query<{ id: string }>(
    `SELECT id::text FROM aniversariantes WHERE cliente_id = $1::uuid AND ativo AND lower(btrim(nome)) = lower(btrim($2)) ORDER BY criado_em LIMIT 1`,
    [clienteId, nome],
  );
  return r.rows[0]?.id ?? null;
}

/** Resultado já gravado de uma integração (repetição após timeout devolve o mesmo, sem escrever nada). */
export async function resultadoGravado(tx: DbExecutor, empresaId: string, vinculoId: string) {
  const r = await tx.query<{ contrato_id: string; fechamento_id: string; festa_id: string | null; agenda: boolean; situacao: string | null; recebido: string | null; saldo: string | null; pagamento_id: string | null }>(
    `SELECT ci.contrato_id::text, ci.fechamento_id::text,
            (SELECT fe.id::text FROM festas fe WHERE fe.contrato_id = ci.contrato_id AND fe.invalidada_em IS NULL) AS festa_id,
            (public.kidmais019_ocupa(ci.fechamento_id) AND NOT public.kidmais061_historico_passado(ci.fechamento_id)) AS agenda,
            f.situacao, f.recebido_centavos::text AS recebido, f.saldo_centavos::text AS saldo, f.pagamento_id::text
       FROM contrato_importacoes ci LEFT JOIN contrato_importacao_financeiro f ON f.contrato_importacao_id = ci.id
      WHERE ci.id = $1::uuid AND ci.empresa_id = $2::uuid`,
    [vinculoId, empresaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    contratoId: l.contrato_id, fechamentoId: l.fechamento_id, festaId: l.festa_id, agendaOcupada: l.agenda === true,
    financeiro: l.situacao
      ? { situacao: l.situacao, pendente: false, pagamentoId: l.pagamento_id, recebidoCentavos: Number(l.recebido), saldoCentavos: Number(l.saldo) }
      : { situacao: 'NAO_CONFERIDO', pendente: true },
  };
}

export async function festaDoContrato(tx: DbExecutor, contratoId: string) {
  const r = await tx.query<{ id: string }>(`SELECT id::text FROM festas WHERE contrato_id = $1::uuid AND invalidada_em IS NULL`, [contratoId]);
  return r.rows[0]?.id ?? null;
}

export async function inserirContrato(tx: DbExecutor, e: { fechamentoId: string; usuarioId: string }) {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO contratos (fechamento_id, status, versao_atual, criado_por_usuario_id, assinado_em)
     VALUES ($1::uuid, 'ASSINADO', 1, $2::uuid, now()) RETURNING id::text`,
    [e.fechamentoId, e.usuarioId],
  );
  return r.rows[0].id;
}

/** Versão 1 ASSINADA por conferência em papel: documento = sha256 do original importado; sem template, sem OTP. */
export async function inserirVersaoConferida(tx: DbExecutor, e: { contratoId: string; snapshot: unknown; snapshotHash: string; documentoSha256: string; usuarioId: string }) {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot_schema_versao, snapshot, snapshot_hash,
                                   gerado_por_usuario_id, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', 1, $2::jsonb, $3, $4::uuid, now(), NULL, $5, 'CONFERENCIA_PAPEL') RETURNING id::text`,
    [e.contratoId, JSON.stringify(e.snapshot), e.snapshotHash, e.usuarioId, e.documentoSha256],
  );
  return r.rows[0].id;
}

export async function inserirEdicaoConcluida(tx: DbExecutor, e: { contratoId: string; versaoId: string; dadosFonte: Record<string, unknown>; alteracoes: Record<string, unknown>; usuarioId: string }) {
  await tx.query(
    `INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, origem_versao_id, tipo, estado, revisao, dados_fonte, alteracoes,
                                   criado_por_usuario_id, atualizado_por_usuario_id)
     VALUES ($1::uuid, $2::uuid, NULL, 'INICIAL', 'CONCLUIDA', 1, $3::jsonb, $4::jsonb, $5::uuid, $5::uuid)`,
    [e.versaoId, e.contratoId, JSON.stringify({ ...e.dadosFonte, schemaVersao: 1 }), JSON.stringify(e.alteracoes), e.usuarioId],
  );
}

export async function inserirFluxoVigente(tx: DbExecutor, contratoId: string, versaoId: string) {
  await tx.query(
    `INSERT INTO contrato_fluxos (contrato_id, versao_em_preparacao_id, versao_vigente_id) VALUES ($1::uuid, NULL, $2::uuid)`,
    [contratoId, versaoId],
  );
}

export async function inserirVinculo(tx: DbExecutor, e: {
  empresaId: string; importacaoId: string; estabelecimentoId: string | null; clienteId: string; fechamentoId: string; contratoId: string; versaoId: string;
  documento: { id: string; sha256: string }; financeiroDeclarado: 'CONFERIDO' | 'NAO_CONFERIDO'; decisoes: unknown; declaracao: string;
  chave: string; payloadHash: string; usuarioId: string; papel: string; requestId: string;
}) {
  const r = await tx.query<{ id: string; agenda_a_partir_de: string; conferido_em: string }>(
    `INSERT INTO contrato_importacoes (empresa_id, importacao_id, estabelecimento_id, cliente_id, fechamento_id, contrato_id, contrato_versao_id,
                                       documento_original_id, documento_sha256, situacao_contrato, financeiro_declarado, agenda_a_partir_de,
                                       decisoes, declaracao, chave_idempotencia, payload_hash, conferido_por, conferido_papel, conferido_em, request_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, 'VIGENTE', $10, CURRENT_DATE,
             $11::jsonb, $12, $13::uuid, $14, $15::uuid, $16, now(), $17::uuid)
     RETURNING id::text, agenda_a_partir_de::text, conferido_em::text`,
    [e.empresaId, e.importacaoId, e.estabelecimentoId, e.clienteId, e.fechamentoId, e.contratoId, e.versaoId, e.documento.id, e.documento.sha256,
      e.financeiroDeclarado, JSON.stringify(e.decisoes), e.declaracao, e.chave, e.payloadHash, e.usuarioId, e.papel, e.requestId],
  );
  return r.rows[0];
}

export async function inserirFinanceiro(tx: DbExecutor, e: {
  empresaId: string; vinculoId: string; pagamentoId: string; situacao: 'NAO_PAGO' | 'PARCIALMENTE_PAGO' | 'PAGO';
  contratado: number; recebido: number; saldo: number; decisoes: unknown; chave: string; payloadHash: string; usuarioId: string; papel: string; requestId: string;
}) {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO contrato_importacao_financeiro (empresa_id, contrato_importacao_id, pagamento_id, situacao, contratado_centavos, recebido_centavos,
                                                 saldo_centavos, decisoes, chave_idempotencia, payload_hash, conferido_por, conferido_papel, request_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::uuid, $10, $11::uuid, $12, $13::uuid) RETURNING id::text`,
    [e.empresaId, e.vinculoId, e.pagamentoId, e.situacao, e.contratado, e.recebido, e.saldo, JSON.stringify(e.decisoes), e.chave, e.payloadHash, e.usuarioId, e.papel, e.requestId],
  );
  return r.rows[0].id;
}

/** Festa da conferência histórica: autoria do operador (nunca SISTEMA), evento FESTA_CRIADA imutável. */
export async function inserirFesta(tx: DbExecutor, e: { contratoId: string; versaoId: string; chave: string; payloadHash: string; usuarioId: string; requestId: string; causa: Record<string, unknown>; identidade: Record<string, unknown> }) {
  const f = (await tx.query<{ id: string }>(
    `INSERT INTO public.festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por, origem_criacao)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'IMPORTACAO_HISTORICA') RETURNING id::text`,
    [e.contratoId, e.versaoId, e.chave, e.payloadHash, e.usuarioId],
  )).rows[0];
  await tx.query(
    `INSERT INTO public.festa_eventos (festa_id, tipo, entidade_id, usuario_id, identidade_snapshot, request_id, chave_idempotencia,
                                       payload_hash, versao_contratual_id, dados_antes, dados_depois, motivo, ocorrido_em, ator_tipo, origem_iniciadora)
     VALUES ($1::uuid, 'FESTA_CRIADA', $1::uuid, $2::uuid, $3::jsonb, $4::uuid, $5::uuid, $6, $7::uuid, NULL, $8::jsonb,
             'Integração de contrato histórico conferido (assinado em papel)', clock_timestamp(), 'USUARIO', 'CONTRATO')`,
    [f.id, e.usuarioId, JSON.stringify(e.identidade), e.requestId, e.chave, e.payloadHash, e.versaoId, JSON.stringify(e.causa)],
  );
  return f.id;
}
