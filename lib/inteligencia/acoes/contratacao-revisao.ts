import type { DbExecutor } from "../../db/contracts.ts";
import type { HumanGateDraft } from "../contratos.ts";
import { InteligenciaError } from "../politica.ts";
import { CAPACIDADE_CONTRATACAO, CODIGO_BANCO, payloadContratacaoSchema, type PayloadContratacao, type PortaContratacao } from "./contratacao.ts";
import { hashPayload } from "./hash.ts";
import type { RepositorioOperacoes } from "./tipos.ts";

/**
 * Revisão OFICIAL da contratação preparada pelo Kidmais (IA operacional, marco C).
 *
 * - Abrir a revisão (`lerPreparacao`) só LÊ: dono, empresa, cliente, estado, versão e prazo revalidados; nenhuma escrita.
 * - Concluir o formulário oficial com a referência (`criarVinculo`) passa pela MESMA criação do Fechamento administrativo,
 *   na mesma transação: a preparação é travada (FOR UPDATE), conferida (versão + hash + prazo + cliente + valor de
 *   tabela) e CONSUMIDA (EXECUTADA, com o resultado) junto com a criação. Repetir o envio devolve o Fechamento já criado;
 *   o "Confirmar" do chat nunca cria. Resultado: no máximo uma contratação por preparação.
 */
export type ReferenciaPreparacao = { operacaoId: string; versao: number; payloadHash: string };

export type PreparacaoRevisao =
  | {
    disponivel: true;
    referencia: ReferenciaPreparacao;
    expiraEm: string;
    /** Campos do formulário oficial já conferidos no Core (nenhum dado pessoal além do que o formulário já mostra). */
    campos: {
      pacote: PayloadContratacao["pacote"];
      convidadosPagantes: number;
      aniversarianteId: string | null;
      idadeAniversariante: number | null;
      temaFesta: string | null;
      dataFesta: string;
      horarioBase: PayloadContratacao["turno"];
      horarioDesejado: string | null;
    };
    pendencias: string[];
  }
  | { disponivel: false; motivo: string };

type Escopo = { empresaId: string; usuarioId: string; clienteId: string; agora: Date };

function conferir(draft: HumanGateDraft | null, escopo: Escopo): { draft: HumanGateDraft; payload: PayloadContratacao } | string {
  if (!draft || draft.capacidade !== CAPACIDADE_CONTRATACAO || draft.empresaId !== escopo.empresaId || draft.usuarioId !== escopo.usuarioId) return "Preparação não encontrada.";
  const payload = payloadContratacaoSchema.safeParse(draft.payload);
  if (!payload.success || payload.data.clienteId?.toLowerCase() !== escopo.clienteId.toLowerCase()) return "Esta preparação é de outro cliente.";
  return { draft, payload: payload.data };
}

const integra = (d: HumanGateDraft) => hashPayload({ capacidade: d.capacidade, ferramenta: d.ferramenta, empresaId: d.empresaId, usuarioId: d.usuarioId, versao: d.versao, payload: d.payload }) === d.payloadHash;

/** Leitura para ABRIR a revisão preenchida. Sem escrita; qualquer divergência ⇒ formulário vazio com o motivo. */
export async function lerPreparacao(repositorio: RepositorioOperacoes, tx: DbExecutor, operacaoId: string, escopo: Escopo): Promise<PreparacaoRevisao> {
  if (!await repositorio.disponivel(tx)) return { disponivel: false, motivo: "Preparações do Kidmais indisponíveis neste ambiente." };
  const conferido = conferir(await repositorio.buscar(tx, { operacaoId, empresaId: escopo.empresaId, usuarioId: escopo.usuarioId }, false), escopo);
  if (typeof conferido === "string") return { disponivel: false, motivo: conferido };
  const { draft, payload } = conferido;
  if (draft.estado === "EXECUTADA") return { disponivel: false, motivo: "Esta preparação já virou um Fechamento. Confira a contratação no CRM." };
  if (draft.estado !== "AGUARDANDO_CONFIRMACAO") return { disponivel: false, motivo: "Esta preparação foi encerrada ou ainda está incompleta no Kidmais." };
  if (Date.parse(draft.expiraEm) <= escopo.agora.getTime()) return { disponivel: false, motivo: "Esta preparação expirou. Peça de novo ao Kidmais ou preencha o formulário." };
  if (!integra(draft)) return { disponivel: false, motivo: "Preparação não encontrada." };
  return {
    disponivel: true,
    referencia: { operacaoId: draft.operacaoId, versao: draft.versao, payloadHash: draft.payloadHash },
    expiraEm: draft.expiraEm,
    campos: {
      pacote: payload.pacote, convidadosPagantes: payload.convidados, aniversarianteId: payload.aniversarianteId, idadeAniversariante: payload.idade,
      temaFesta: payload.tema, dataFesta: payload.data, horarioBase: payload.turno, horarioDesejado: payload.horario,
    },
    pendencias: payload.pendencias,
  };
}

export type ResultadoCriacao = { fechamentoId: string; status: string; clienteId: string };
export type EntradaFormulario = { pacote: string; convidadosPagantes: number; dataFesta: string; horarioBase: string };

export type VinculoPreparacao = {
  validar(tx: DbExecutor, ctx: { empresaId: string; usuarioId: string; clienteId: string; input: EntradaFormulario }): Promise<{ repetido: ResultadoCriacao | null }>;
  concluir(tx: DbExecutor, resultado: ResultadoCriacao): Promise<void>;
};

/**
 * Vínculo do envio oficial com a preparação. `validar` roda ANTES da criação e `concluir` DEPOIS, na mesma transação do
 * serviço de domínio (qualquer falha desfaz a criação inteira). Valor de tabela diferente do visto na preparação (para o
 * mesmo pacote, convidados, data e turno) ⇒ recusa e nova revisão; nunca grava em cima de uma prévia desatualizada.
 */
export function criarVinculo(repositorio: RepositorioOperacoes, porta: Pick<PortaContratacao, "pacote" | "horarios" | "precoTabela">, ref: ReferenciaPreparacao, agora: () => Date): VinculoPreparacao {
  let travado: HumanGateDraft | null = null;
  return {
    async validar(tx, ctx) {
      const escopo = { empresaId: ctx.empresaId, usuarioId: ctx.usuarioId, clienteId: ctx.clienteId, agora: agora() };
      const conferido = conferir(await repositorio.buscar(tx, { operacaoId: ref.operacaoId, empresaId: ctx.empresaId, usuarioId: ctx.usuarioId }, true), escopo);
      if (typeof conferido === "string") throw new InteligenciaError("PREPARACAO_INVALIDA", conferido, 404);
      const { draft, payload } = conferido;
      if (draft.versao !== ref.versao || draft.payloadHash !== ref.payloadHash || !integra(draft)) {
        throw new InteligenciaError("PREPARACAO_DESATUALIZADA", "A preparação mudou depois que esta revisão foi aberta. Recarregue a revisão.", 409);
      }
      // Reenvio (clique duplo, retry, outra aba): devolve o Fechamento já criado por esta preparação.
      if (draft.estado === "EXECUTADA") {
        const r = draft.resultado as Partial<ResultadoCriacao> & { entidadeId?: string } | null;
        if (!r?.entidadeId || !r.status) throw new InteligenciaError("PREPARACAO_INVALIDA", "Preparação já encerrada.", 409);
        return { repetido: { fechamentoId: r.entidadeId, status: r.status, clienteId: ctx.clienteId } };
      }
      if (draft.estado !== "AGUARDANDO_CONFIRMACAO") throw new InteligenciaError("PREPARACAO_ENCERRADA", "Esta preparação foi encerrada. Envie sem ela ou peça uma nova ao Kidmais.", 409);
      if (Date.parse(draft.expiraEm) <= escopo.agora.getTime()) throw new InteligenciaError("PREPARACAO_EXPIRADA", "A preparação expirou. Envie sem ela ou peça uma nova ao Kidmais.", 409);
      const mesmo = ctx.input.pacote === payload.pacote && ctx.input.convidadosPagantes === payload.convidados && ctx.input.dataFesta === payload.data && ctx.input.horarioBase === payload.turno;
      if (mesmo && payload.precoTabelaCentavos !== null) {
        const pacote = await porta.pacote(tx, ctx.empresaId, CODIGO_BANCO[payload.pacote]);
        const agenda = await porta.horarios(tx, payload.data, payload.turno);
        const atual = pacote && agenda ? await porta.precoTabela(tx, ctx.empresaId, { data: payload.data, configuracaoAgendaId: agenda.configuracaoId, pacoteId: pacote.id, convidados: payload.convidados }) : null;
        if (atual !== payload.precoTabelaCentavos) {
          throw new InteligenciaError("PREPARACAO_PRECO_ALTERADO", "O valor de tabela mudou desde a preparação. Confira o valor e envie sem a preparação, ou peça uma nova ao Kidmais.", 409);
        }
      }
      travado = draft;
      return { repetido: null };
    },
    async concluir(tx, resultado) {
      if (!travado) throw new InteligenciaError("PREPARACAO_INVALIDA", "Preparação não conferida.", 409);
      const executada: HumanGateDraft = {
        ...travado, estado: "EXECUTADA", atualizadoEm: agora().toISOString(),
        resultado: { entidadeId: resultado.fechamentoId, status: resultado.status, mensagem: "Fechamento criado pela revisão oficial.", destino: `/clientes/${resultado.clienteId}?tab=eventos` },
      };
      if (!await repositorio.atualizar(tx, executada, { versao: travado.versao, estado: "AGUARDANDO_CONFIRMACAO" })) {
        throw new InteligenciaError("PREPARACAO_CONCORRENTE", "A preparação mudou durante o envio. Nenhuma alteração foi feita.", 409);
      }
    },
  };
}
