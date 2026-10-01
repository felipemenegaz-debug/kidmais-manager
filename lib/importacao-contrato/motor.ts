import type { DbExecutor } from "../db/contracts.ts";
import type { PlanoImportacao } from "./plano.ts";
import type { ImportacaoLida } from "./repositorio-importacao.ts";

/**
 * Import Engine (Fase 18). Só roda depois do Human Gate, dentro da mesma transação que revalidou tudo.
 *
 * Human Gate → Import Plan → serviços de domínio:
 * - CLIENTE: `cadastrarClienteInterno` (tenant comprovado, dedup, auditoria do CRM) ou vínculo com um
 *   cliente existente conferido por `obterClienteBase` no mesmo tenant. Nada é mesclado.
 * - CONTRATO_HISTORICO: snapshot do documento guardado na importação, ligado ao cliente.
 *   Não sobrescreve contrato assinado existente: nenhum contrato do Core é tocado.
 * - FESTA: pendente de serviço de domínio (não existe criação de festa para contrato histórico).
 * - PAGAMENTOS: só previstos, dentro do snapshot. Nenhum pagamento é criado nem marcado como pago.
 */
export type ServicosImportacao = {
  cadastrarCliente(tx: DbExecutor, empresaId: string, dados: { nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null }, contexto: { usuarioId: string; requestId: string }): Promise<{ clienteId: string }>;
  conferirCliente(tx: DbExecutor, empresaId: string, clienteId: string): Promise<void>;
  atualizarImportacao(tx: DbExecutor, empresaId: string, importacao: ImportacaoLida, versaoEsperada: number): Promise<boolean>;
};

export class ImportacaoError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 409) {
    super(message);
    this.name = "ImportacaoError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function executarImportacao(
  tx: DbExecutor,
  entrada: { empresaId: string; usuarioId: string; requestId: string; importacao: ImportacaoLida; plano: PlanoImportacao; agora: string },
  servicos: ServicosImportacao,
) {
  const { importacao, plano } = entrada;
  if (importacao.status !== "EM_REVISAO") throw new ImportacaoError("IMPORTACAO_ENCERRADA", "Esta importação já foi encerrada.");
  if (!plano.pronto) throw new ImportacaoError("IMPORTACAO_BLOQUEADA", plano.bloqueios[0] ?? "A importação ainda tem pendências.");
  const passoCliente = plano.passos.find((p) => p.tipo === "CLIENTE");
  if (!passoCliente || passoCliente.tipo !== "CLIENTE") throw new ImportacaoError("IMPORTACAO_BLOQUEADA", "Defina o cliente antes de importar.");

  let clienteId: string;
  if (passoCliente.acao === "VINCULAR") {
    await servicos.conferirCliente(tx, entrada.empresaId, passoCliente.clienteId);
    clienteId = passoCliente.clienteId;
  } else {
    clienteId = (await servicos.cadastrarCliente(tx, entrada.empresaId, passoCliente.dados, { usuarioId: entrada.usuarioId, requestId: entrada.requestId })).clienteId;
  }

  const pendencias = plano.passos.filter((p) => p.tipo === "FESTA").map((p) => ("motivo" in p ? p.motivo : ""));
  const concluida: ImportacaoLida = {
    ...importacao,
    status: "IMPORTADA",
    versao: importacao.versao + 1,
    clienteId,
    resultado: {
      clienteId,
      clienteAcao: passoCliente.acao,
      contratoHistorico: plano.snapshot,
      pendencias,
      importadoEm: entrada.agora,
      importadoPor: entrada.usuarioId,
    },
  };
  if (!await servicos.atualizarImportacao(tx, entrada.empresaId, concluida, importacao.versao)) {
    throw new ImportacaoError("IMPORTACAO_CONCORRENTE", "A importação mudou durante a confirmação. Nenhuma alteração foi feita.");
  }
  return { clienteId, clienteAcao: passoCliente.acao, pendencias };
}
