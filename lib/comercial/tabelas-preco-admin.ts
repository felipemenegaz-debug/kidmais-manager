import type { DbExecutor } from "../db/contracts.ts";
import { centavosComerciais } from "./condicao-pagamento.ts";
import { exigirVinculoNaEmpresa, sqlPrecoPacoteMesmaEmpresa } from "./integridade-tenant.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

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

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

export async function criarTabelaPrecoAdmin(
  tx: DbExecutor,
  input: { empresaId: string; codigo: string; nome: string; vigenciaInicio: string; vigenciaFim: string | null },
) {
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, $3, $4::date, $5::date, false)
     RETURNING id`,
    [input.empresaId, input.codigo, input.nome, input.vigenciaInicio, input.vigenciaFim],
  );
  return criada.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "A tabela não foi criada.", 500);
}

export async function incluirPrecoPacoteAdmin(
  tx: DbExecutor,
  input: { empresaId: string; tabelaId: string; pacoteId: string; convidadosMin: number; convidadosMax: number | null; tipoCalculo: "FIXO" | "POR_CONVIDADO"; valor: string; categoriaHorario: string },
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
  input: { empresaId: string; tabelaId: string },
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
  const ocupacao = await tx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM precos_pacote
      WHERE tabela_preco_id = $1::uuid
        AND ativo`,
    [input.tabelaId],
  );
  if (Number(ocupacao.rows[0]?.n ?? 0) < 1) recusar("TABELA_VAZIA", "Tabela vazia não é publicada.", 409);
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
          OR categoria_horario NOT IN ('PADRAO', 'NOBRE')
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
  // HG-4 permanece aberto: cobertura além de "não vazia" não está documentada e não é inventada aqui.
  const publicada = await tx.query(
    `UPDATE tabelas_preco
        SET publicada_em = clock_timestamp()
      WHERE id = $1::uuid
        AND empresa_id = $2::uuid
        AND publicada_em IS NULL
        AND ativa = false
        AND vigencia_inicio = $3::date
        AND vigencia_fim IS NOT DISTINCT FROM $4::date`,
    [input.tabelaId, input.empresaId, linha.vigencia_inicio, linha.vigencia_fim],
  );
  if (publicada.rowCount !== 1) recusar("CONFLITO", "A publicação encontrou outra versão da tabela.", 409);
}
