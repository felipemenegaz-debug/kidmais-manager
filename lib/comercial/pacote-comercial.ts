import type { DbExecutor } from "../db/contracts.ts";
import type { FaixaFixa } from "./modelo-preco.ts";
import { ModeloPrecoError } from "./modelo-preco.ts";
import { MOTIVOS_PACOTE, motivoOu } from "./motivos-pacote.ts";
import { copiarPrecosPacote, gravarFaixasPacote, lerFaixasPacote } from "./pacote-precos.ts";
import {
  PacoteAdminError,
  consultarPacoteAdmin,
  criarPacoteAdmin,
  criarRevisaoPacoteAdmin,
  definirCategoriasPacoteAdmin,
  definirDisponibilidadePacoteAdmin,
  duplicarPacoteAdmin,
  editarPacoteNaoUtilizado,
  type PacoteAdmin,
} from "./pacotes-admin.ts";

type Contexto = { empresaId: string; usuarioId: string; requestId: string; motivo?: string };

export type SalvarPacoteComercial = {
  id?: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number;
  convidadosMinimos: number;
  convidadosMaximos: number;
  dias: number[];
  horariosIds: string[];
  faixas: FaixaFixa[] | null;
  categorias: Array<{ categoriaId: string; escolhas: number }>;
};

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

function capacidade(input: SalvarPacoteComercial) {
  if (input.convidadosMaximos < input.convidadosMinimos) {
    recusar("DADOS_INVALIDOS", "O máximo de convidados não pode ser menor que o mínimo.", 409);
  }
  if (input.duracaoMinutos < 1) recusar("DADOS_INVALIDOS", "Informe a duração da festa.", 409);
}

export async function painelPacoteAdmin(tx: DbExecutor, empresaId: string, id: string) {
  const pacote = await tx.query(
    `SELECT p.id FROM pacotes p WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid`,
    [id, empresaId],
  );
  if (!pacote.rows[0]) return null;
  const atual = await consultarPacoteAdmin(tx, empresaId, id);
  if (!atual) return null;
  const disponibilidade = await tx.query<{ dia_semana: number; configuracao_agenda_id: string }>(
    `SELECT DISTINCT dia_semana, configuracao_agenda_id
       FROM regras_disponibilidade_pacote
      WHERE pacote_id = $1::uuid
        AND ativo
        AND estado = 'DISPONIVEL'
        AND vigencia_inicio <= CURRENT_DATE
        AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)
      ORDER BY dia_semana, configuracao_agenda_id`,
    [id],
  );
  const categorias = await tx.query<{ categoria_id: string; escolhas_max: number; ativo: boolean }>(
    `SELECT categoria_id, escolhas_max, ativo
       FROM pacote_buffet_categorias
      WHERE pacote_id = $1::uuid
      ORDER BY categoria_id`,
    [id],
  );
  const faixas = await lerFaixasPacote(tx, empresaId, id);
  return {
    pacote: atual,
    dias: [...new Set(disponibilidade.rows.map((linha) => Number(linha.dia_semana)))],
    horariosIds: [...new Set(disponibilidade.rows.map((linha) => linha.configuracao_agenda_id))],
    categorias: categorias.rows.map((linha) => ({
      categoriaId: linha.categoria_id,
      escolhas: Number(linha.escolhas_max),
      ativo: linha.ativo,
    })),
    faixas,
  };
}

export async function salvarPacoteComercial(
  tx: DbExecutor,
  input: SalvarPacoteComercial,
  ctx: Contexto,
): Promise<{ pacote: PacoteAdmin; avisoPrecos: string | null }> {
  capacidade(input);
  const motivo = motivoOu(ctx.motivo, input.id ? MOTIVOS_PACOTE.editado : "Criação administrativa");
  const contexto = { ...ctx, motivo };
  let pacote: PacoteAdmin;
  try {
    if (!input.id) {
      pacote = await criarPacoteAdmin(tx, {
        empresaId: ctx.empresaId,
        nome: input.nome,
        descricao: input.descricao,
        duracaoMinutos: input.duracaoMinutos,
        convidadosMinimos: input.convidadosMinimos,
        convidadosMaximos: input.convidadosMaximos,
      }, contexto);
    } else {
      const atual = await consultarPacoteAdmin(tx, ctx.empresaId, input.id);
      if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
      if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não é editado por esta ação.", 409);
      pacote = atual.utilizado
        ? await criarRevisaoPacoteAdmin(tx, input.id, {
          nome: input.nome,
          descricao: input.descricao,
          duracaoMinutos: input.duracaoMinutos,
          convidadosMinimos: input.convidadosMinimos,
          convidadosMaximos: input.convidadosMaximos,
        }, contexto)
        : await editarPacoteNaoUtilizado(tx, input.id, {
          nome: input.nome,
          descricao: input.descricao,
          duracaoMinutos: input.duracaoMinutos,
          convidadosMinimos: input.convidadosMinimos,
          convidadosMaximos: input.convidadosMaximos,
        }, contexto);
    }
  } catch (error) {
    if (error instanceof ModeloPrecoError) recusar("DADOS_INVALIDOS", error.message, 409);
    throw error;
  }
  await definirDisponibilidadePacoteAdmin(tx, pacote.id, { dias: input.dias, horariosIds: input.horariosIds }, contexto);
  const comCategorias = await definirCategoriasPacoteAdmin(
    tx,
    pacote.id,
    input.categorias,
    { ...contexto, motivo: MOTIVOS_PACOTE.composicao },
  );
  let avisoPrecos: string | null = null;
  try {
    const precos = await gravarFaixasPacote(
      tx,
      ctx.empresaId,
      comCategorias.id,
      input.faixas,
      { minimo: input.convidadosMinimos, maximo: input.convidadosMaximos },
      contexto,
    );
    avisoPrecos = precos.aviso;
  } catch (error) {
    if (error instanceof ModeloPrecoError) recusar("DADOS_INVALIDOS", error.message, 409);
    throw error;
  }
  return { pacote: comCategorias, avisoPrecos };
}

export async function duplicarPacoteComercial(tx: DbExecutor, origemId: string, ctx: Contexto) {
  const contexto = { ...ctx, motivo: motivoOu(ctx.motivo, MOTIVOS_PACOTE.duplicado) };
  const copia = await duplicarPacoteAdmin(tx, origemId, undefined, contexto);
  await copiarPrecosPacote(tx, ctx.empresaId, origemId, copia.id, contexto);
  return { pacote: copia, avisoPrecos: null as string | null };
}
