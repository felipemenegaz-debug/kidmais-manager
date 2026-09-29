import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import type { CampoExtraido, ExtracaoContrato } from "../../importacao-contrato/modelo.ts";
import { classificarMatch, montarPlano, type DecisaoCliente, type PlanoImportacao } from "../../importacao-contrato/plano.ts";
import { dadosNormalizados } from "../../importacao-contrato/rascunho.ts";
import type { AnaliseDuplicidade } from "../../importacao-contrato/plano.ts";
import type { ExtracaoRegistrada } from "../../importacao-contrato/repositorio-documentos.ts";
import type { ImportacaoLida } from "../../importacao-contrato/repositorio-importacao.ts";
import { jsonCanonico } from "../acoes/hash.ts";
import { ErroCampo } from "../acoes/human-gate.ts";
import type { FerramentaAcao } from "../acoes/tipos.ts";
import type { CampoRascunho } from "../contratos.ts";
import { InteligenciaError } from "../politica.ts";

/**
 * Confirmação da importação histórica (Human Gate, Fase 19).
 *
 * Começa só pela tela de importação. No clique, relê a importação travada, confere a versão revisada,
 * refaz a busca de cliente no tenant e o plano: se qualquer coisa mudou desde o preview, o hash muda e a
 * confirmação é recusada. Só então o Import Engine grava pelos serviços de domínio.
 *
 * Minimização: o registro do Human Gate guarda só o hash do plano e um resumo de exibição
 * (sem CPF, telefone ou e-mail). Os dados completos ficam na importação, no tenant.
 */
export const PAPEIS_IMPORTACAO = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"] as const;

export type DadosImportacao = { extracao: ExtracaoContrato; revisados: string[]; decisaoCliente: DecisaoCliente };

export const decisaoSchema = z.union([
  z.object({ tipo: z.literal("VINCULAR"), clienteId: z.string().uuid() }).strict(),
  z.object({ tipo: z.literal("CRIAR") }).strict(),
]).nullable();

const resumoSchema = z.object({
  cliente: z.string().nullable(),
  data: z.string().nullable(),
  pacote: z.string().nullable(),
  convidados: z.string().nullable(),
  valor: z.string().nullable(),
  pagamento: z.string(),
  itens: z.string().nullable(),
  naoEncontrados: z.number().int(),
  evidencias: z.number().int(),
}).strict();

const payloadSchema = z.object({
  importacaoId: z.string().uuid(),
  versaoImportacao: z.number().int().min(1),
  decisaoCliente: decisaoSchema,
  planoHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  resumo: resumoSchema.optional(),
}).strict();
type Payload = z.infer<typeof payloadSchema>;

/**
 * Serviços reais ligados na composição da feature IMPORT: repositório de importação (ia_importacoes),
 * leitura da extração registrada pela feature DOCUMENT, análise de duplicidade do CRM e Import Engine.
 */
export type PortaImportacao = {
  disponivel(tx: DbExecutor): Promise<boolean>;
  ultimaExtracao(tx: DbExecutor, empresaId: string, documentoId: string): Promise<ExtracaoRegistrada | null>;
  abrirImportacao(tx: DbExecutor, e: { empresaId: string; documentoId: string; extracaoId: string; usuarioId: string; dados: Record<string, unknown> }): Promise<ImportacaoLida>;
  lerImportacao(tx: DbExecutor, empresaId: string, id: string, travar: boolean): Promise<ImportacaoLida | null>;
  /** Somente leitura: ativa do documento ou, sem ativa, a última descartada. */
  importacaoPorDocumento(tx: DbExecutor, empresaId: string, documentoId: string): Promise<ImportacaoLida | null>;
  atualizarImportacao(tx: DbExecutor, empresaId: string, i: ImportacaoLida, versaoEsperada: number): Promise<boolean>;
  analisarCliente(tx: DbExecutor, empresaId: string, dados: { nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null }): Promise<AnaliseDuplicidade>;
  executar(tx: DbExecutor, entrada: { empresaId: string; usuarioId: string; requestId: string; importacao: ImportacaoLida; plano: PlanoImportacao; agora: string }): Promise<{ clienteId: string; clienteAcao: "VINCULAR" | "CRIAR"; pendencias: string[] }>;
};

export function dadosDaImportacao(i: ImportacaoLida): DadosImportacao {
  const dados = i.dados as Partial<DadosImportacao>;
  if (!dados.extracao || !Array.isArray(dados.revisados)) throw new InteligenciaError("IMPORTACAO_INVALIDA", "Rascunho de importação inválido.", 409);
  return { extracao: dados.extracao, revisados: dados.revisados, decisaoCliente: dados.decisaoCliente ?? null };
}

/** Busca de cliente no tenant + plano. Usada no preview da tela, no preview do gate e de novo no clique. */
export async function planejar(tx: DbExecutor, empresaId: string, porta: PortaImportacao, dados: DadosImportacao): Promise<PlanoImportacao> {
  const normal = dadosNormalizados(dados.extracao.secoes.flatMap((s) => s.campos));
  const c = normal.contratante;
  const analise = c.nome && c.nome.trim().length >= 3
    ? await porta.analisarCliente(tx, empresaId, { nomeCompleto: c.nome, cpf: c.cpf, telefone: c.telefone, whatsapp: c.whatsapp, email: c.email })
    : null;
  return montarPlano(dados.extracao, dados.revisados, classificarMatch(normal, analise), dados.decisaoCliente);
}

export function hashPlano(plano: PlanoImportacao) {
  return createHash("sha256").update(jsonCanonico(plano)).digest("hex");
}

const reais = (c: number | null | undefined) => (c == null ? null : `R$ ${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`);
const dataBr = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);

function resumoDoPlano(plano: PlanoImportacao, campos: readonly CampoExtraido[]): z.infer<typeof resumoSchema> {
  const s = plano.snapshot;
  const cliente = plano.passos.find((p) => p.tipo === "CLIENTE");
  const previstos = (s.pagamentosPrevistos.entrada ? 1 : 0) + s.pagamentosPrevistos.parcelas.length;
  return {
    cliente: cliente?.tipo === "CLIENTE"
      ? (cliente.acao === "VINCULAR" ? `Vincular a ${plano.match.candidatos.find((c) => c.clienteId === cliente.clienteId)?.nome ?? "cliente existente"}` : `Criar cliente ${cliente.dados.nomeCompleto}`)
      : null,
    data: dataBr(s.evento.data),
    pacote: s.pacote.nome,
    convidados: s.evento.convidados == null ? null : String(s.evento.convidados),
    valor: reais(s.valores.total),
    pagamento: previstos
      ? `${s.pagamentosPrevistos.entrada ? `Entrada de ${reais(s.pagamentosPrevistos.entrada.valor)}` : "Sem entrada"}${s.pagamentosPrevistos.parcelas.length ? ` + ${s.pagamentosPrevistos.parcelas.length} parcela(s)` : ""} · previsto, não pago`
      : "Não informado",
    itens: s.pacote.itens,
    naoEncontrados: campos.filter((c) => c.estado === "NAO_ENCONTRADO" && c.id !== "pagamentos.realizados").length,
    evidencias: campos.filter((c) => c.evidencia?.conferida).length,
  };
}

const linha = (id: string, rotulo: string, valor: string | null): CampoRascunho => ({ id, rotulo, valor, obrigatorio: false });

async function planoAtual(tx: DbExecutor, empresaId: string, porta: PortaImportacao, payload: Payload) {
  const importacao = await porta.lerImportacao(tx, empresaId, payload.importacaoId, true);
  if (!importacao) throw new InteligenciaError("NAO_ENCONTRADO", "Importação não encontrada.", 404);
  if (importacao.status !== "EM_REVISAO" || importacao.versao !== payload.versaoImportacao) throw new ErroCampo([], "A revisão mudou depois do preview.");
  const dados = dadosDaImportacao(importacao);
  const plano = await planejar(tx, empresaId, porta, { ...dados, decisaoCliente: payload.decisaoCliente });
  if (!plano.pronto) throw new InteligenciaError("IMPORTACAO_BLOQUEADA", plano.bloqueios[0] ?? "A importação ainda tem pendências.", 409);
  return { importacao, dados, plano };
}

export function criarAcaoImportacao(porta: PortaImportacao): FerramentaAcao {
  const acao: FerramentaAcao<Payload> = {
    nome: "importacao.confirmar",
    capacidade: "importar_contrato",
    classe: "CONFIRM",
    grupo: "CONTRACT_IMPORT",
    papeis: PAPEIS_IMPORTACAO,
    descricao: "Importa um contrato histórico revisado, depois da sua confirmação.",
    titulo: "Importar contrato histórico",
    origem: "TELA",
    campos: [],
    extrair: () => ({}),
    faltando: () => [],
    validar(payload) {
      const lido = payloadSchema.safeParse(payload);
      if (!lido.success) throw new ErroCampo([], "Rascunho de importação inválido.");
      return lido.data;
    },
    async verificar(tx, tenant, payload) {
      const { dados, plano } = await planoAtual(tx, tenant.empresaComprovada, porta, payload);
      const campos = dados.extracao.secoes.flatMap((s) => s.campos);
      return { payload: { importacaoId: payload.importacaoId, versaoImportacao: payload.versaoImportacao, decisaoCliente: payload.decisaoCliente, planoHash: hashPlano(plano), resumo: resumoDoPlano(plano, campos) }, avisos: plano.avisos };
    },
    apresentar(p) {
      const r = p.resumo as z.infer<typeof resumoSchema> | undefined;
      if (!r) return [linha("importacao", "Importação", "Preparando…")];
      return [
        linha("cliente", "Cliente", r.cliente),
        linha("data", "Data da festa", r.data),
        linha("pacote", "Pacote original", r.pacote),
        linha("convidados", "Convidados", r.convidados),
        linha("valor", "Valor contratado", r.valor),
        linha("pagamento", "Pagamento previsto", r.pagamento),
        linha("itens", "Itens", r.itens),
        linha("naoEncontrados", "Campos não encontrados", String(r.naoEncontrados)),
        linha("evidencias", "Evidências conferidas no documento", String(r.evidencias)),
        linha("festa", "Festa", "Não será criada agora: depende de serviço do Core."),
      ];
    },
    async executar(tx, tenant, payload, contexto) {
      const { importacao, plano } = await planoAtual(tx, tenant.empresaComprovada, porta, payload);
      if (hashPlano(plano) !== payload.planoHash) throw new InteligenciaError("CONFIRMACAO_DESATUALIZADA", "O plano mudou depois do preview. Confira de novo.", 409);
      const resultado = await porta.executar(tx, { empresaId: tenant.empresaComprovada, usuarioId: contexto.usuarioId, requestId: contexto.operacaoId, importacao, plano, agora: new Date().toISOString() });
      return {
        entidadeId: resultado.clienteId,
        mensagem: `Contrato histórico importado${resultado.clienteAcao === "CRIAR" ? " e cliente criado" : " no cliente existente"}. Os pagamentos ficaram como previstos.`,
        destino: `/clientes/${resultado.clienteId}`,
      };
    },
  };
  return acao as unknown as FerramentaAcao;
}
