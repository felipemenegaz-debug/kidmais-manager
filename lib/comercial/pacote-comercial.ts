import type { DbExecutor } from "../db/contracts.ts";
import type { FaixaFixa } from "./modelo-preco.ts";
import { ModeloPrecoError } from "./modelo-preco.ts";
import { MOTIVOS_PACOTE, motivoOu } from "./motivos-pacote.ts";
import { aplicarPrecoDaRevisao, copiarPrecosPacote, gravarFaixasPacote, lerFaixasPacote } from "./pacote-precos.ts";
import {
  PacoteAdminError,
  consultarPacoteAdmin,
  criarPacoteAdmin,
  definirCategoriasPacoteAdmin,
  definirDisponibilidadePacoteAdmin,
  duplicarPacoteAdmin,
  editarPacoteNaoUtilizado,
  inserirRevisaoPacoteAdmin,
  promoverRevisaoPacoteAdmin,
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
  disponibilidade: Array<{ dia: number; horarioId: string }>;
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
    disponibilidade: disponibilidade.rows.map((linha) => ({
      dia: Number(linha.dia_semana),
      horarioId: linha.configuracao_agenda_id,
    })),
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
  let revisao: { origem: PacoteAdmin; novaId: string } | null = null;
  const dados = {
    nome: input.nome,
    descricao: input.descricao,
    duracaoMinutos: input.duracaoMinutos,
    convidadosMinimos: input.convidadosMinimos,
    convidadosMaximos: input.convidadosMaximos,
  };
  try {
    if (!input.id) {
      pacote = await criarPacoteAdmin(tx, { empresaId: ctx.empresaId, ...dados }, contexto);
    } else {
      const atual = await consultarPacoteAdmin(tx, ctx.empresaId, input.id);
      if (!atual) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
      if (atual.arquivadoEm) recusar("ARQUIVADO", "Pacote arquivado não é editado por esta ação.", 409);
      if (atual.utilizado) {
        revisao = await inserirRevisaoPacoteAdmin(tx, input.id, dados, contexto);
        pacote = { ...revisao.origem, id: revisao.novaId, nome: input.nome, vigente: false, revisaoAnteriorId: input.id, utilizado: false };
      } else {
        pacote = await editarPacoteNaoUtilizado(tx, input.id, dados, contexto);
      }
    }
  } catch (error) {
    if (error instanceof ModeloPrecoError) recusar("DADOS_INVALIDOS", error.message, 409);
    throw error;
  }
  await definirDisponibilidadePacoteAdmin(tx, pacote.id, { disponibilidade: input.disponibilidade }, contexto);
  const comCategorias = await definirCategoriasPacoteAdmin(
    tx,
    pacote.id,
    input.categorias,
    { ...contexto, motivo: MOTIVOS_PACOTE.composicao },
  );
  let avisoPrecos: string | null = null;
  try {
    if (revisao && input.id) {
      const precos = await aplicarPrecoDaRevisao(
        tx,
        ctx.empresaId,
        input.id,
        revisao.novaId,
        input.faixas,
        { minimo: input.convidadosMinimos, maximo: input.convidadosMaximos },
        contexto,
      );
      avisoPrecos = precos.aviso;
      pacote = await promoverRevisaoPacoteAdmin(tx, input.id, revisao.novaId, dados, contexto, { origem: revisao.origem });
    } else {
      const precos = await gravarFaixasPacote(
        tx,
        ctx.empresaId,
        comCategorias.id,
        input.faixas,
        { minimo: input.convidadosMinimos, maximo: input.convidadosMaximos },
        contexto,
      );
      avisoPrecos = precos.aviso;
      pacote = comCategorias;
    }
  } catch (error) {
    if (error instanceof ModeloPrecoError) recusar("DADOS_INVALIDOS", error.message, 409);
    throw error;
  }
  return { pacote, avisoPrecos };
}

export async function duplicarPacoteComercial(tx: DbExecutor, origemId: string, ctx: Contexto) {
  const contexto = { ...ctx, motivo: motivoOu(ctx.motivo, MOTIVOS_PACOTE.duplicado) };
  const copia = await duplicarPacoteAdmin(tx, origemId, undefined, contexto);
  await copiarPrecosPacote(tx, ctx.empresaId, origemId, copia.id, contexto);
  return { pacote: copia, avisoPrecos: null as string | null };
}
