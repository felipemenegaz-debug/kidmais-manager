import type { DbExecutor } from "../db/contracts.ts";
import { centavosComerciais } from "./condicao-pagamento.ts";
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

export async function publicarTabelaPrecoAdmin(
  tx: DbExecutor,
  input: { empresaId: string; tabelaId: string },
) {
  const atual = await tx.query<{ id: string; publicada_em: string | null }>(
    `SELECT id, publicada_em FROM tabelas_preco WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [input.tabelaId, input.empresaId],
  );
  if (!atual.rows[0]) recusar("NAO_ENCONTRADO", "Tabela não encontrada nesta empresa.", 404);
  if (atual.rows[0].publicada_em) recusar("CONFLITO", "A tabela já foi publicada.", 409);
  const publicada = await tx.query(
    `UPDATE tabelas_preco
        SET publicada_em = clock_timestamp()
      WHERE id = $1::uuid
        AND empresa_id = $2::uuid
        AND publicada_em IS NULL
        AND ativa = false`,
    [input.tabelaId, input.empresaId],
  );
  if (publicada.rowCount !== 1) recusar("CONFLITO", "A publicação encontrou outra versão da tabela.", 409);
}
