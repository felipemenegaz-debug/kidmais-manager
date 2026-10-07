import type { CadastroContratual } from '../../clientes/cadastro-contratual.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { buscarCategoriaHorarioAplicavel } from '../../comercial/repositories/comercial.repository.ts';
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

export type ImportacaoParaIntegrar = { id: string; clienteId: string; documentoId: string; status: string; snapshot: SnapshotHistorico | null; recebimentosDocumento?: unknown };

export async function lerImportacao(tx: DbExecutor, empresaId: string, importacaoId: string, travar: boolean): Promise<ImportacaoParaIntegrar | null> {
  const r = await tx.query<{ id: string; cliente_id: string | null; documento_id: string; status: string; snapshot: SnapshotHistorico | null; recebimentos_documento: unknown }>(
    `SELECT id::text, cliente_id::text, documento_id::text, status, resultado->'contratoHistorico' AS snapshot, dados->'extracao'->'recebimentosDocumento' AS recebimentos_documento
       FROM ia_importacoes WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? ' FOR UPDATE' : ''}`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  if (!l || !l.cliente_id) return null;
  return { id: l.id, clienteId: l.cliente_id, documentoId: l.documento_id, status: l.status, recebimentosDocumento: l.recebimentos_documento, snapshot: l.snapshot && typeof l.snapshot === 'object' ? l.snapshot : null };
}

export async function documentoOriginal(tx: DbExecutor, empresaId: string, documentoId: string) {
  const r = await tx.query<{ id: string; sha256: string }>(
    `SELECT id::text, sha256 FROM ia_documento_originais WHERE documento_id = $1::uuid AND empresa_id = $2::uuid ORDER BY versao DESC LIMIT 1`,
    [documentoId, empresaId],
  );
  return r.rows[0] ?? null;
}

export type ClienteIntegracao = { id: string; nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null; status: string } & Partial<Record<keyof CadastroContratual, string | null>>;

export async function clienteDaEmpresa(tx: DbExecutor, empresaId: string, clienteId: string, travar: boolean): Promise<ClienteIntegracao | null> {
  const r = await tx.query<{ id: string; nome_completo: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null; status: string } & Partial<Record<keyof CadastroContratual, string | null>>>(
    `SELECT id::text, nome_completo, cpf, rg, telefone, whatsapp, email, cep, logradouro, numero, complemento, bairro, cidade, uf, status FROM clientes
      WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? ' FOR SHARE' : ''}`,
    [clienteId, empresaId],
  );
  const l = r.rows[0];
  return l ? { ...l, id: l.id, nomeCompleto: l.nome_completo, cpf: l.cpf, telefone: l.telefone, whatsapp: l.whatsapp, email: l.email, status: l.status } : null;
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
export async function precoReferencia(tx: DbExecutor, empresaId: string, pacoteId: string, data: string, convidados: number, regraHorario: 'PADRAO' | 'NOBRE' | null) {
  // Com regra de categoria para a data e o turno: a linha da categoria da regra vem primeiro, depois a GERAL (vale para
  // todos os horários). Sem regra: a MESMA ordem de antes (palpite pelo fim de semana), para não mudar importações que já
  // funcionavam. A categoria da linha é devolvida como está: é a categoria do PREÇO aplicado.
  const r = await tx.query<{ tabela_preco_id: string; preco_pacote_id: string; categoria: 'GERAL' | 'PADRAO' | 'NOBRE' }>(
    `SELECT t.id::text AS tabela_preco_id, pp.id::text AS preco_pacote_id, pp.categoria_horario AS categoria
       FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      WHERE pp.pacote_id = $1::uuid AND t.empresa_id = $2::uuid
      ORDER BY (t.vigencia_inicio <= $3::date AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= $3::date)) DESC,
               t.ativa DESC,
               (CASE WHEN $5::text IS NOT NULL THEN pp.categoria_horario = $5::text
                     ELSE pp.categoria_horario = CASE WHEN extract(isodow FROM $3::date) IN (6, 7) THEN 'NOBRE' ELSE 'PADRAO' END END) DESC,
               ($5::text IS NOT NULL AND pp.categoria_horario = 'GERAL') DESC,
               ($4::int BETWEEN pp.convidados_min AND coalesce(pp.convidados_max, 32767)) DESC,
               pp.ativo DESC, t.vigencia_inicio DESC, pp.id
      LIMIT 1
      FOR SHARE OF pp, t`,
    [pacoteId, empresaId, data, convidados, regraHorario],
  );
  const l = r.rows[0];
  return l ? { tabelaPrecoId: l.tabela_preco_id, precoPacoteId: l.preco_pacote_id, categoria: l.categoria } : null;
}

/**
 * Regra de categoria do horário (PADRAO/NOBRE) pela MESMA consulta do fechamento comum (obterContextoComercial): a regra
 * ativa e vigente de `regras_categoria_horario` para o dia da semana da data e o turno. null SÓ quando a consulta
 * comprova que não há regra (ou não há turno); erros de banco propagam e nunca viram "sem regra".
 */
export async function regraCategoriaHorario(tx: DbExecutor, data: string, configuracaoAgendaId: string | null): Promise<'PADRAO' | 'NOBRE' | null> {
  if (!configuracaoAgendaId) return null;
  const regra = await buscarCategoriaHorarioAplicavel(data, configuracaoAgendaId, tx);
  if (!regra) return null;
  // Configuração inválida não é "sem regra": falha alto em vez de cair no fallback.
  if (regra.categoriaHorario !== 'PADRAO' && regra.categoriaHorario !== 'NOBRE') throw new Error('Regra de categoria de horário com valor inválido.');
  return regra.categoriaHorario;
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

/**
 * Serialização da DETECÇÃO DE DUPLICIDADE da integração: UMA por empresa, para toda confirmação (inclusive evento
 * passado, que não trava a agenda, slots diferentes e datas divergentes — a busca complementar alcança outras datas,
 * então a chave não pode ser a data). Só a integração usa esse namespace; na ordem global ele fica entre a
 * unidade/habilitação e a data (empresa → unidade → habilitação → duplicidade → data → contratação). Segura até o fim da
 * transação: a próxima confirmação da mesma empresa espera o commit e então enxerga a contratação recém-integrada.
 * Confirmações de contrato histórico são humanas e curtas; empresas diferentes não se esperam.
 */
export async function travarDuplicidade(tx: DbExecutor, empresaId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('kidmais:importacao-duplicidade:' || $1::text, 0))", [empresaId]);
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

export type SinalDuplicidade = 'MESMO_CLIENTE' | 'MESMO_CONTATO' | 'MESMO_ANIVERSARIANTE' | 'MESMO_VALOR' | 'MESMO_DOCUMENTO'
  | 'DATA_DO_DOCUMENTO' | 'DATA_INVERTIDA' | 'DATA_PROXIMA';
export type AlcanceDuplicidade = 'MESMO_DIA' | 'OUTRA_DATA';

/** Datas próximas (em dias) para a busca complementar com sinais combinados; a festa do ano seguinte fica fora. */
export const JANELA_DATA_PROXIMA_DIAS = 90;

/** Nome comparável no SQL: sem acento, minúsculo, espaços simples. */
const NOME_SQL = (expr: string) => `lower(translate(regexp_replace(btrim(${expr}), '\\s+', ' ', 'g'), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ', 'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'))`;
/** Só os dígitos (CPF e telefone comparáveis no SQL). */
const DIGITOS_SQL = (expr: string) => `regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g')`;

/** Dia e mês trocados (leitura DD/MM × MM/DD), quando a troca dá outra data válida. */
export function dataInvertida(data: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m || m[2] === m[3] || Number(m[3]) > 12) return null;
  const trocada = `${m[1]}-${m[3]}-${m[2]}`;
  const d = new Date(`${trocada}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== trocada ? null : trocada;
}

/** Contato comparável do cliente da importação: CPF (11 dígitos) e telefones (8+ dígitos), só dígitos. */
export function contatoComparavel(c: { cpf: string | null; telefone: string | null; whatsapp: string | null }) {
  const so = (v: string | null) => (v ?? '').replace(/\D/g, '');
  const cpf = so(c.cpf).length === 11 ? so(c.cpf) : null;
  const telefones = [...new Set([so(c.telefone), so(c.whatsapp)].filter((t) => t.length >= 8))];
  return { cpf, telefones };
}

/**
 * Possível duplicidade a conferir (nunca unida nem recusada sozinha; a decisão é explícita, com motivo, e auditada).
 * Contratações ativas da MESMA empresa (outra empresa nunca aparece):
 * - **mesmo dia** da festa decidida, com pelo menos um sinal: mesmo cliente, mesmo contato (CPF/telefone de outro
 *   cadastro), mesmo aniversariante (nome normalizado), mesmo valor contratado vigente ou o mesmo documento original;
 * - **outra data** (busca complementar, para data lida errada ou corrigida de forma divergente): o mesmo documento
 *   original em qualquer data; a data lida no documento (quando o operador a corrigiu) ou a data com dia e mês trocados,
 *   com pelo menos um sinal pessoal; ou data a até JANELA_DATA_PROXIMA_DIAS dias com pelo menos DOIS sinais entre
 *   {cliente ou contato, aniversariante, valor}. Nome ou data sozinhos não bastam; a festa do ano seguinte não aparece
 *   por proximidade.
 */
export async function possiveisVinculos(tx: DbExecutor, empresaId: string, e: {
  clienteId: string | null; data: string; dataDocumento: string | null; aniversariante: string | null; valorCentavos: number; documentoSha256: string;
  cpf: string | null; telefones: string[];
}) {
  const dataDocumento = e.dataDocumento && e.dataDocumento !== e.data ? e.dataDocumento : null;
  const r = await tx.query<{ fechamento_id: string; contrato_id: string | null; status: string; data_evento: string; horario_inicio: string; horario_fim: string; com_pagamento: boolean; importado: boolean; sinais: SinalDuplicidade[] }>(
    `WITH base AS (
       SELECT f.id, f.data_evento, f.status AS f_status, f.horario_inicio, f.horario_fim, c.id AS contrato_id, c.status AS c_status,
              coalesce(f.cliente_id = $2::uuid, false) AS mesmo_cliente,
              (f.cliente_id IS DISTINCT FROM $2::uuid AND cl.id IS NOT NULL AND (
                 ($9::text IS NOT NULL AND ${DIGITOS_SQL('cl.cpf')} = $9::text)
                 OR (cardinality($10::text[]) > 0 AND (${DIGITOS_SQL('cl.telefone')} = ANY($10::text[]) OR ${DIGITOS_SQL('cl.whatsapp')} = ANY($10::text[]))))) AS mesmo_contato,
              ($4::text IS NOT NULL AND length(btrim($4::text)) >= 2 AND a.nome IS NOT NULL AND ${NOME_SQL('a.nome')} = ${NOME_SQL('$4::text')}) AS mesmo_aniversariante,
              CASE WHEN (vv.snapshot->'comercial'->>'valorFinalContrato') ~ '^[0-9]+(\\.[0-9]+)?$'
                   THEN round((vv.snapshot->'comercial'->>'valorFinalContrato')::numeric * 100) = $5::bigint ELSE false END AS mesmo_valor,
              EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.fechamento_id = f.id AND ci.documento_sha256 = $6) AS mesmo_documento,
              EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.fechamento_id = f.id) AS importado
         FROM fechamentos f
         LEFT JOIN contratos c ON c.fechamento_id = f.id
         LEFT JOIN contrato_fluxos cf ON cf.contrato_id = c.id
         LEFT JOIN contrato_versoes vv ON vv.id = cf.versao_vigente_id
         LEFT JOIN aniversariantes a ON a.id = f.aniversariante_id
         LEFT JOIN clientes cl ON cl.id = f.cliente_id
        WHERE f.empresa_id = $1::uuid
          AND f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO') AND coalesce(c.status, '') <> 'CANCELADO'
          AND (f.data_evento = $3::date OR f.data_evento = $7::date OR f.data_evento = $8::date
               OR abs(f.data_evento - $3::date) <= $11::int
               OR EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.fechamento_id = f.id AND ci.documento_sha256 = $6))
     ), sinal AS (
       SELECT base.*, (mesmo_cliente OR mesmo_contato) AS pessoa,
              (mesmo_cliente OR mesmo_contato)::int + mesmo_aniversariante::int + mesmo_valor::int AS combinados,
              data_evento = $3::date AS mesmo_dia
         FROM base
     )
     SELECT id::text AS fechamento_id, contrato_id::text, coalesce(c_status, f_status) AS status, data_evento::text,
            to_char(horario_inicio, 'HH24:MI') AS horario_inicio, to_char(horario_fim, 'HH24:MI') AS horario_fim,
            EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = sinal.contrato_id) AS com_pagamento,
            importado,
            array_remove(ARRAY[CASE WHEN mesmo_cliente THEN 'MESMO_CLIENTE' END, CASE WHEN mesmo_contato THEN 'MESMO_CONTATO' END,
                               CASE WHEN mesmo_aniversariante THEN 'MESMO_ANIVERSARIANTE' END, CASE WHEN mesmo_valor THEN 'MESMO_VALOR' END,
                               CASE WHEN mesmo_documento THEN 'MESMO_DOCUMENTO' END,
                               CASE WHEN NOT mesmo_dia AND data_evento = $7::date THEN 'DATA_DO_DOCUMENTO' END,
                               CASE WHEN NOT mesmo_dia AND data_evento = $8::date THEN 'DATA_INVERTIDA' END,
                               CASE WHEN NOT mesmo_dia AND abs(data_evento - $3::date) <= $11::int THEN 'DATA_PROXIMA' END], NULL) AS sinais
       FROM sinal
      WHERE (mesmo_dia AND (pessoa OR mesmo_aniversariante OR mesmo_valor OR mesmo_documento))
         OR (NOT mesmo_dia AND (mesmo_documento
              OR ((data_evento = $7::date OR data_evento = $8::date) AND (pessoa OR mesmo_aniversariante OR mesmo_valor))
              OR (abs(data_evento - $3::date) <= $11::int AND combinados >= 2)))
      ORDER BY NOT mesmo_dia, abs(data_evento - $3::date), data_evento, horario_inicio, id`,
    [empresaId, e.clienteId, e.data, e.aniversariante, e.valorCentavos, e.documentoSha256, dataDocumento, dataInvertida(e.data),
      e.cpf, e.telefones, JANELA_DATA_PROXIMA_DIAS],
  );
  return r.rows.map((l) => ({
    fechamentoId: l.fechamento_id, contratoId: l.contrato_id, status: l.status, data: l.data_evento,
    alcance: (l.data_evento === e.data ? 'MESMO_DIA' : 'OUTRA_DATA') as AlcanceDuplicidade,
    horario: `${l.horario_inicio}–${l.horario_fim}`, comPagamento: l.com_pagamento, importado: l.importado, sinais: l.sinais,
  }));
}

/** Unidade antes da data (ordem única de locks da 062: empresa → unidade → habilitação → data → contratação). */
export async function travarUnidade(tx: DbExecutor, estabelecimentoId: string) {
  await tx.query('SELECT public.kidmais062_travar_habilitacao($1::uuid)', [estabelecimentoId]);
}

export type VinculoExistente = {
  id: string; contratoId: string; fechamentoId: string; versaoId: string; payloadHash: string; chave: string;
  financeiroDeclarado: 'CONFERIDO' | 'NAO_CONFERIDO'; financeiro: { id: string; pagamentoId: string; payloadHash: string; chave: string } | null;
  /** Valor contratado da versão conferida (centavos): a pendência de pagamentos nunca muda o contratado. */
  valorContratadoCentavos: number;
  /** Contrato integrado cancelado: o vínculo é histórico; reimportar exige enviar o arquivo de novo (064). */
  contratoCancelado: boolean;
};

export async function vinculoDaImportacao(tx: DbExecutor, empresaId: string, importacaoId: string): Promise<VinculoExistente | null> {
  const r = await tx.query<{ id: string; contrato_id: string; fechamento_id: string; versao_id: string; payload_hash: string; chave: string; declarado: 'CONFERIDO' | 'NAO_CONFERIDO'; fin_id: string | null; pagamento_id: string | null; fin_hash: string | null; fin_chave: string | null; valor_contratado: string | null; contrato_status: string | null }>(
    `SELECT ci.id::text, ci.contrato_id::text, ci.fechamento_id::text, ci.contrato_versao_id::text AS versao_id, ci.payload_hash,
            ci.chave_idempotencia::text AS chave, ci.financeiro_declarado AS declarado,
            f.id::text AS fin_id, f.pagamento_id::text, f.payload_hash AS fin_hash, f.chave_idempotencia::text AS fin_chave,
            (SELECT v.snapshot->'comercial'->>'valorFinalContrato' FROM contrato_versoes v WHERE v.id = ci.contrato_versao_id) AS valor_contratado,
            (SELECT c.status FROM contratos c WHERE c.id = ci.contrato_id) AS contrato_status
       FROM contrato_importacoes ci LEFT JOIN contrato_importacao_financeiro f ON f.contrato_importacao_id = ci.id
      WHERE ci.importacao_id = $1::uuid AND ci.empresa_id = $2::uuid`,
    [importacaoId, empresaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    id: l.id, contratoId: l.contrato_id, fechamentoId: l.fechamento_id, versaoId: l.versao_id, payloadHash: l.payload_hash.trim(), chave: l.chave,
    contratoCancelado: l.contrato_status === 'CANCELADO',
    financeiroDeclarado: l.declarado,
    financeiro: l.fin_id ? { id: l.fin_id, pagamentoId: l.pagamento_id!, payloadHash: (l.fin_hash ?? '').trim(), chave: l.fin_chave! } : null,
    valorContratadoCentavos: Math.round(Number(l.valor_contratado ?? 0) * 100),
  };
}

export type CaminhoFinanceiro = 'CONFERIR_HISTORICO' | 'PLANO_NA_VERSAO_VIGENTE' | 'AGUARDAR_REVISAO' | 'CONCLUIDO';

/**
 * Caminho OFICIAL dos pagamentos do contrato histórico: obrigação já existente (conferida na integração ou criada no
 * Financeiro) ⇒ CONCLUIDO (Financeiro do contrato); revisão aberta ⇒ aguardar; versão conferida vigente ⇒ "Conferir
 * pagamentos"; revisão vigente ⇒ plano nativo na versão vigente.
 */
export function caminhoFinanceiro(e: { conferido: boolean; comPagamento: boolean; revisaoAberta: boolean; vigenteConferida: boolean }): CaminhoFinanceiro {
  if (e.conferido || e.comPagamento) return 'CONCLUIDO';
  if (e.revisaoAberta) return 'AGUARDAR_REVISAO';
  return e.vigenteConferida ? 'CONFERIR_HISTORICO' : 'PLANO_NA_VERSAO_VIGENTE';
}

export async function estadoFinanceiroDoContrato(tx: DbExecutor, contratoId: string, versaoConferidaId: string) {
  const r = await tx.query<{ com_pagamento: boolean; revisao_aberta: boolean; vigente_conferida: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes pv ON pv.id = p.contrato_versao_id WHERE pv.contrato_id = $1::uuid) AS com_pagamento,
            EXISTS(SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_id = $1::uuid AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')) AS revisao_aberta,
            coalesce((SELECT cf.versao_vigente_id = $2::uuid FROM contrato_fluxos cf WHERE cf.contrato_id = $1::uuid), false) AS vigente_conferida`,
    [contratoId, versaoConferidaId],
  );
  const l = r.rows[0];
  return { comPagamento: l?.com_pagamento === true, revisaoAberta: l?.revisao_aberta === true, vigenteConferida: l?.vigente_conferida === true };
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
