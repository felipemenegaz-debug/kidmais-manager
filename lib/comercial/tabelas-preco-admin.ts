import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { centavosComerciais } from "./condicao-pagamento.ts";
import { exigirVinculoNaEmpresa, sqlPrecoPacoteMesmaEmpresa } from "./integridade-tenant.ts";
import { listarPacotesAdmin, PacoteAdminError } from "./pacotes-admin.ts";

export type ResultadoSimulacao =
  | { tipo: "PRECO"; centavos: number }
  | { tipo: "SOB_CONSULTA" }
  | { tipo: "AUSENTE" };

/** Valor vazio não vira zero. Sob consulta não é preço ausente. */
export function simularPrecoPacote(input: { valor: string | null; sobConsulta: boolean }): ResultadoSimulacao {
  if (input.sobConsulta) return { tipo: "SOB_CONSULTA" };
  if (input.valor == null || input.valor.trim() === "") return { tipo: "AUSENTE" };
  return { tipo: "PRECO", centavos: centavosComerciais(input.valor) };
}

function recusar(code: string, message: string, status: number, details: unknown = null): never {
  throw new PacoteAdminError(code, message, status, details);
}

export async function criarTabelaPrecoAdmin(
  tx: DbExecutor,
  input: { empresaId: string; codigo: string; nome: string; vigenciaInicio: string; vigenciaFim: string | null },
  ator: { usuarioId: string | null; requestId: string | null; motivo: string | null } = { usuarioId: null, requestId: null, motivo: null },
) {
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, $3, $4::date, $5::date, false)
     RETURNING id`,
    [input.empresaId, input.codigo, input.nome, input.vigenciaInicio, input.vigenciaFim],
  );
  const id = criada.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "A tabela não foi criada.", 500);
  await auditarMutacaoComercial(tx, {
    ...ator,
    acao: "TABELA_PRECO_CRIADA",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: id,
    empresaId: input.empresaId,
    antes: null,
    depois: input,
  });
  return id;
}

export async function incluirPrecoPacoteAdmin(
  tx: DbExecutor,
  input: { empresaId: string; tabelaId: string; pacoteId: string; convidadosMin: number; convidadosMax: number | null; tipoCalculo: "FIXO" | "POR_CONVIDADO"; valor: string; categoriaHorario: string; usuarioId?: string | null; requestId?: string | null; motivo?: string | null },
) {
  const simulacao = simularPrecoPacote({ valor: input.valor, sobConsulta: false });
  if (simulacao.tipo !== "PRECO") recusar("PRECO_AUSENTE", "Informe o preço. Vazio não é zero.", 409);
  await exigirVinculoNaEmpresa(tx, input.empresaId, {
    sql: sqlPrecoPacoteMesmaEmpresa(),
    params: [input.tabelaId, input.pacoteId],
  });
  const tabela = await tx.query<{ publicada_em: string | null }>(
    `SELECT publicada_em FROM tabelas_preco WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [input.tabelaId, input.empresaId],
  );
  if (!tabela.rows[0]) recusar("NAO_ENCONTRADO", "Tabela não encontrada nesta empresa.", 404);
  if (tabela.rows[0].publicada_em) recusar("TABELA_PUBLICADA", "Tabela publicada. O preço futuro nasce em outra tabela.", 409);
  await tx.query(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
    [input.tabelaId, input.pacoteId, input.convidadosMin, input.convidadosMax, input.tipoCalculo, input.valor, input.categoriaHorario],
  );
  await auditarMutacaoComercial(tx, {
    usuarioId: input.usuarioId ?? null,
    requestId: input.requestId ?? null,
    motivo: input.motivo ?? null,
    acao: "PRECO_PACOTE_INCLUIDO",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: input.tabelaId,
    empresaId: input.empresaId,
    antes: null,
    depois: input,
  });
}

export async function simularTabelaPublicada(
  tx: DbExecutor,
  input: { empresaId: string; data: string; pacoteId: string; convidados: number; categoriaHorario: string; sobConsulta: boolean },
): Promise<ResultadoSimulacao> {
  if (input.sobConsulta) return { tipo: "SOB_CONSULTA" };
  const resultado = await tx.query<{ valor: string | null }>(
    `SELECT pp.valor::text AS valor
       FROM tabelas_preco t
       JOIN precos_pacote pp ON pp.tabela_preco_id = t.id AND pp.ativo
      WHERE t.empresa_id = $1::uuid
        AND t.publicada_em IS NOT NULL
        AND t.vigencia_inicio <= $2::date
        AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= $2::date)
        AND pp.pacote_id = $3::uuid
        AND pp.categoria_horario = $4
        AND pp.convidados_min <= $5::smallint
        AND (pp.convidados_max IS NULL OR pp.convidados_max >= $5::smallint)
      ORDER BY t.vigencia_inicio DESC, t.publicada_em DESC, pp.convidados_min DESC
      LIMIT 1`,
    [input.empresaId, input.data, input.pacoteId, input.categoriaHorario, input.convidados],
  );
  return simularPrecoPacote({ valor: resultado.rows[0]?.valor ?? null, sobConsulta: false });
}

export async function publicarTabelaPrecoAdmin(
  tx: DbExecutor,
  input: { empresaId: string; tabelaId: string; usuarioId?: string | null; requestId?: string | null; motivo?: string | null },
) {
  const atual = await tx.query<{
    id: string;
    publicada_em: string | null;
    ativa: boolean;
    vigencia_inicio: string;
    vigencia_fim: string | null;
  }>(
    `SELECT id, publicada_em, ativa, vigencia_inicio::text AS vigencia_inicio, vigencia_fim::text AS vigencia_fim
       FROM tabelas_preco
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      FOR UPDATE`,
    [input.tabelaId, input.empresaId],
  );
  const linha = atual.rows[0];
  if (!linha) recusar("NAO_ENCONTRADO", "Tabela não encontrada nesta empresa.", 404);
  if (linha.publicada_em) recusar("CONFLITO", "A tabela já foi publicada.", 409);
  if (linha.ativa !== false) recusar("ESTADO_INESPERADO", "Só uma tabela inativa e ainda não publicada pode ser publicada.", 409);
  if (linha.vigencia_fim && linha.vigencia_fim < linha.vigencia_inicio) {
    recusar("VIGENCIA_INVALIDA", "A vigência termina antes de começar.", 409);
  }
  const lacunas = await tx.query<{ codigo: string; detalhe: string }>(
    `SELECT codigo, detalhe FROM kidmais_047_lacunas_escopo($1::uuid)`,
    [input.tabelaId],
  );
  if (lacunas.rows.length > 0) {
    recusar(
      lacunas.rows[0].codigo,
      lacunas.rows.map((lacuna) => `${lacuna.codigo}: ${lacuna.detalhe}`).join(" "),
      409,
      lacunas.rows,
    );
  }
  const cruzado = await tx.query(
    `SELECT 1
       FROM precos_pacote pp
       JOIN pacotes p ON p.id = pp.pacote_id
      WHERE pp.tabela_preco_id = $1::uuid
        AND p.empresa_id IS DISTINCT FROM $2::uuid
      LIMIT 1`,
    [input.tabelaId, input.empresaId],
  );
  if (cruzado.rows[0]) recusar("EMPRESA_DIVERGENTE", "A tabela só publica pacote da mesma empresa.", 403);
  const invalida = await tx.query(
    `SELECT 1
       FROM precos_pacote
      WHERE tabela_preco_id = $1::uuid
        AND (
          convidados_min < 1
          OR (convidados_max IS NOT NULL AND convidados_max < convidados_min)
          OR valor <= 0
          OR tipo_calculo NOT IN ('FIXO', 'POR_CONVIDADO')
          OR categoria_horario NOT IN ('GERAL', 'PADRAO', 'NOBRE')
        )
      LIMIT 1`,
    [input.tabelaId],
  );
  if (invalida.rows[0]) recusar("FAIXA_INVALIDA", "A tabela tem faixa, valor ou categoria inválidos.", 409);
  const sobreposta = await tx.query(
    `SELECT 1
       FROM precos_pacote a
       JOIN precos_pacote b
         ON b.tabela_preco_id = a.tabela_preco_id
        AND b.pacote_id = a.pacote_id
        AND b.categoria_horario = a.categoria_horario
        AND b.id <> a.id
        AND a.ativo
        AND b.ativo
        AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
            && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
      WHERE a.tabela_preco_id = $1::uuid
      LIMIT 1`,
    [input.tabelaId],
  );
  if (sobreposta.rows[0]) recusar("FAIXA_SOBREPOSTA", "Faixas de convidados se sobrepõem.", 409);
  const vigencia = await tx.query(
    `SELECT 1
       FROM tabelas_preco outra
      WHERE outra.id <> $1::uuid
        AND outra.empresa_id IS NOT DISTINCT FROM $2::uuid
        AND outra.publicada_em IS NOT NULL
        AND daterange(outra.vigencia_inicio, COALESCE(outra.vigencia_fim, 'infinity'::date), '[]')
            && daterange($3::date, COALESCE($4::date, 'infinity'::date), '[]')
      LIMIT 1`,
    [input.tabelaId, input.empresaId, linha.vigencia_inicio, linha.vigencia_fim],
  );
  if (vigencia.rows[0]) recusar("VIGENCIA_SOBREPOSTA", "Já existe tabela publicada desta empresa na mesma vigência.", 409);
  const publicada = await tx.query<{ publicada_em: string }>(
    `UPDATE tabelas_preco
        SET publicada_em = clock_timestamp()
      WHERE id = $1::uuid
        AND empresa_id = $2::uuid
        AND publicada_em IS NULL
        AND ativa = false
        AND vigencia_inicio = $3::date
        AND vigencia_fim IS NOT DISTINCT FROM $4::date
      RETURNING publicada_em::text AS publicada_em`,
    [input.tabelaId, input.empresaId, linha.vigencia_inicio, linha.vigencia_fim],
  );
  const publicadaEm = publicada.rows[0]?.publicada_em;
  if (publicada.rowCount !== 1 || publicadaEm == null || publicadaEm === "") {
    recusar("CONFLITO", "A publicação encontrou outra versão da tabela.", 409);
  }
  await auditarMutacaoComercial(tx, {
    usuarioId: input.usuarioId ?? null,
    requestId: input.requestId ?? null,
    motivo: input.motivo ?? null,
    acao: "TABELA_PRECO_PUBLICADA",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: input.tabelaId,
    empresaId: input.empresaId,
    antes: { publicadaEm: null, ativa: false, vigenciaInicio: linha.vigencia_inicio, vigenciaFim: linha.vigencia_fim },
    depois: { publicadaEm, ativa: false },
  });
}

export type FaixaEscopo = { convidadosMin: number; convidadosMax: number | null };
export type CombinacaoEscopo = {
  pacoteId: string;
  categoriaHorario: "GERAL" | "PADRAO" | "NOBRE";
  coberturaContinua: boolean;
  limiteConvidadosMin: number | null;
  limiteConvidadosMax: number | null;
  faixas: FaixaEscopo[];
};

async function travarTabelaRascunho(tx: DbExecutor, empresaId: string, tabelaId: string) {
  const tabela = await tx.query<{ publicada_em: string | null }>(
    `SELECT publicada_em::text AS publicada_em
       FROM tabelas_preco
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      FOR UPDATE`,
    [tabelaId, empresaId],
  );
  const linha = tabela.rows[0];
  if (!linha) recusar("NAO_ENCONTRADO", "Tabela não encontrada nesta empresa.", 404);
  if (linha.publicada_em) recusar("TABELA_PUBLICADA", "Tabela publicada. O escopo futuro nasce em outra tabela.", 409);
}

/** Substitui o escopo declarado de um rascunho. Não infere faixa a partir do preço. */
export async function substituirEscopoTabelaAdmin(
  tx: DbExecutor,
  input: { empresaId: string; tabelaId: string; combinacoes: CombinacaoEscopo[]; usuarioId?: string | null; requestId?: string | null; motivo?: string | null },
) {
  await travarTabelaRascunho(tx, input.empresaId, input.tabelaId);
  for (const combinacao of input.combinacoes) {
    await exigirVinculoNaEmpresa(tx, input.empresaId, {
      sql: sqlPrecoPacoteMesmaEmpresa(),
      params: [input.tabelaId, combinacao.pacoteId],
    });
  }
  await tx.query(
    `DELETE FROM tabela_preco_escopo_faixas f
      USING tabela_preco_escopos e
      WHERE f.escopo_id = e.id
        AND e.tabela_preco_id = $1::uuid`,
    [input.tabelaId],
  );
  await tx.query(`DELETE FROM tabela_preco_escopos WHERE tabela_preco_id = $1::uuid`, [input.tabelaId]);
  for (const combinacao of input.combinacoes) {
    const criada = await tx.query<{ id: string }>(
      `INSERT INTO tabela_preco_escopos (
         tabela_preco_id, pacote_id, categoria_horario, cobertura_continua,
         limite_convidados_min, limite_convidados_max
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.tabelaId,
        combinacao.pacoteId,
        combinacao.categoriaHorario,
        combinacao.coberturaContinua,
        combinacao.limiteConvidadosMin,
        combinacao.limiteConvidadosMax,
      ],
    );
    const escopoId = criada.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "O escopo não foi gravado.", 500);
    for (const faixa of combinacao.faixas) {
      await tx.query(
        `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max)
         VALUES ($1::uuid, $2, $3)`,
        [escopoId, faixa.convidadosMin, faixa.convidadosMax],
      );
    }
  }
  await auditarMutacaoComercial(tx, {
    usuarioId: input.usuarioId ?? null,
    requestId: input.requestId ?? null,
    motivo: input.motivo ?? null,
    acao: "TABELA_PRECO_ESCOPO",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: input.tabelaId,
    empresaId: input.empresaId,
    antes: null,
    depois: { combinacoes: input.combinacoes },
  });
}

export async function consultarQuadroTabelaAdmin(tx: DbExecutor, empresaId: string, tabelaId: string | null) {
  const tabelas = await tx.query<{
    id: string;
    codigo: string;
    nome: string;
    vigencia_inicio: string;
    vigencia_fim: string | null;
    publicada: boolean;
  }>(
    `SELECT id, codigo, nome, vigencia_inicio::text AS vigencia_inicio, vigencia_fim::text AS vigencia_fim,
            publicada_em IS NOT NULL AS publicada
       FROM tabelas_preco
      WHERE empresa_id = $1::uuid
      ORDER BY vigencia_inicio, codigo`,
    [empresaId],
  );
  const pacotes = await listarPacotesAdmin(tx, empresaId);
  if (!tabelaId) return { tabelas: tabelas.rows, pacotes, quadro: null };
  if (!tabelas.rows.some((tabela) => tabela.id === tabelaId)) {
    recusar("NAO_ENCONTRADO", "Tabela não encontrada nesta empresa.", 404);
  }
  const combinacoes = await tx.query<{
    id: string;
    pacote_id: string;
    pacote_codigo: string;
    pacote_nome: string;
    categoria_horario: string;
    cobertura_continua: boolean;
    limite_convidados_min: number | null;
    limite_convidados_max: number | null;
  }>(
    `SELECT e.id, e.pacote_id, p.codigo AS pacote_codigo, p.nome AS pacote_nome,
            e.categoria_horario, e.cobertura_continua,
            e.limite_convidados_min, e.limite_convidados_max
       FROM tabela_preco_escopos e
       JOIN pacotes p ON p.id = e.pacote_id
      WHERE e.tabela_preco_id = $1::uuid
        AND p.empresa_id = $2::uuid
      ORDER BY p.codigo, e.categoria_horario`,
    [tabelaId, empresaId],
  );
  const faixas = await tx.query<{ escopo_id: string; convidados_min: number; convidados_max: number | null }>(
    `SELECT f.escopo_id, f.convidados_min, f.convidados_max
       FROM tabela_preco_escopo_faixas f
       JOIN tabela_preco_escopos e ON e.id = f.escopo_id
      WHERE e.tabela_preco_id = $1::uuid
      ORDER BY f.convidados_min`,
    [tabelaId],
  );
  const precos = await tx.query<{
    pacote_codigo: string;
    categoria_horario: string;
    convidados_min: number;
    convidados_max: number | null;
    tipo_calculo: string;
    valor: string;
    ativo: boolean;
  }>(
    `SELECT p.codigo AS pacote_codigo, pp.categoria_horario, pp.convidados_min, pp.convidados_max,
            pp.tipo_calculo, pp.valor::text AS valor, pp.ativo
       FROM precos_pacote pp
       JOIN pacotes p ON p.id = pp.pacote_id
      WHERE pp.tabela_preco_id = $1::uuid
        AND p.empresa_id = $2::uuid
      ORDER BY p.codigo, pp.categoria_horario, pp.convidados_min`,
    [tabelaId, empresaId],
  );
  const lacunas = await tx.query<{ codigo: string; detalhe: string }>(
    `SELECT codigo, detalhe FROM kidmais_047_lacunas_escopo($1::uuid)`,
    [tabelaId],
  );
  return {
    tabelas: tabelas.rows,
    pacotes,
    quadro: {
      tabela: tabelas.rows.find((tabela) => tabela.id === tabelaId) ?? null,
      combinacoes: combinacoes.rows.map((combinacao) => ({
        ...combinacao,
        faixas: faixas.rows.filter((faixa) => faixa.escopo_id === combinacao.id),
      })),
      precos: precos.rows,
      lacunas: lacunas.rows,
      completo: lacunas.rows.length === 0,
    },
  };
}
