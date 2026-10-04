import type { ArquivoSelecionado, CampoExtraido, EstadoCampo, ExtracaoContrato, Extrator } from "./modelo.ts";

/**
 * Fluxo da importação de contrato histórico: upload → análise → revisão → Human Gate.
 *
 * Função pura, sem rede e sem persistência. A etapa final (`pronto`) é só um estado visual:
 * a gravação definitiva de cliente, contrato, festa ou pagamentos não existe nesta versão
 * e será habilitada apenas após validação do Import Engine.
 */

export const TAMANHO_MAXIMO_BYTES = 15 * 1024 * 1024;
const TIPOS_ACEITOS: Readonly<Record<string, string>> = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG" };
const EXTENSOES_ACEITAS = /\.(pdf|jpe?g|png)$/i;
export const ACEITE_ARQUIVO = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

/** Etapas simuladas: o DEMO ADAPTER não lê nem envia o arquivo, então nenhuma mensagem afirma processamento real. */
export const ETAPAS_ANALISE = [
  "Simulando leitura do contrato",
  "Simulando identificação do cliente",
  "Simulando análise das condições",
  "Preparando demonstração da revisão",
] as const;

export type ValidacaoArquivo = { ok: true } | { ok: false; mensagem: string };

export function validarArquivo(arquivo: ArquivoSelecionado): ValidacaoArquivo {
  const tipoAceito = arquivo.tipo ? Object.hasOwn(TIPOS_ACEITOS, arquivo.tipo) : EXTENSOES_ACEITAS.test(arquivo.nome);
  if (!tipoAceito) return { ok: false, mensagem: "Envie o contrato em PDF, JPG ou PNG." };
  if (arquivo.tamanhoBytes <= 0) return { ok: false, mensagem: "O arquivo está vazio." };
  if (arquivo.tamanhoBytes > TAMANHO_MAXIMO_BYTES) return { ok: false, mensagem: "O arquivo passa de 15 MB. Envie uma versão menor." };
  return { ok: true };
}

export function formatoArquivo(arquivo: ArquivoSelecionado) {
  return TIPOS_ACEITOS[arquivo.tipo] ?? arquivo.nome.split(".").pop()?.toUpperCase() ?? "";
}

export function tamanhoLegivel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export type FluxoImportacao =
  | { etapa: "upload"; erro: string | null }
  | { etapa: "analisando"; arquivo: ArquivoSelecionado; passo: number }
  | { etapa: "revisao"; extracao: ExtracaoContrato; revisados: readonly string[]; confirmando: boolean }
  | { etapa: "pronto"; extracao: ExtracaoContrato; revisados: readonly string[] };

export type AcaoImportacao =
  | { tipo: "selecionar"; arquivo: ArquivoSelecionado }
  | { tipo: "avancar" }
  | { tipo: "cancelar" }
  | { tipo: "alternarRevisado"; campoId: string }
  | { tipo: "corrigir"; campoId: string; valor: string }
  | { tipo: "abrirConfirmacao" }
  | { tipo: "fecharConfirmacao" }
  | { tipo: "marcarPronto" }
  | { tipo: "recomecar" };

export const FLUXO_INICIAL: FluxoImportacao = { etapa: "upload", erro: null };

export function todosCampos(extracao: ExtracaoContrato): CampoExtraido[] {
  return extracao.secoes.flatMap((secao) => secao.campos);
}

export function contagemEstados(extracao: ExtracaoContrato): Record<EstadoCampo, number> {
  const contagem: Record<EstadoCampo, number> = { ENCONTRADO: 0, PRECISA_REVISAO: 0, NAO_ENCONTRADO: 0 };
  for (const campo of todosCampos(extracao)) contagem[campo.estado] += 1;
  return contagem;
}

/** Campos que o operador ainda precisa confirmar, e os que ficarão em branco. */
export function pendencias(extracao: ExtracaoContrato, revisados: readonly string[]) {
  const campos = todosCampos(extracao);
  return {
    revisar: campos.filter((campo) => campo.estado === "PRECISA_REVISAO" && !revisados.includes(campo.id)),
    naoEncontrados: campos.filter((campo) => campo.estado === "NAO_ENCONTRADO"),
  };
}

/** Human Gate: só libera a confirmação quando todo campo “Precisa revisão” foi confirmado por uma pessoa. */
export function podeConfirmar(extracao: ExtracaoContrato, revisados: readonly string[]) {
  return pendencias(extracao, revisados).revisar.length === 0;
}

function valorDe(extracao: ExtracaoContrato, id: string) {
  return todosCampos(extracao).find((campo) => campo.id === id)?.valor ?? "Não encontrado";
}

export function resumoConfirmacao(extracao: ExtracaoContrato) {
  return [
    { rotulo: "Cliente", valor: valorDe(extracao, "contratante.nome") },
    { rotulo: "Data", valor: valorDe(extracao, "evento.data") },
    { rotulo: "Pacote", valor: valorDe(extracao, "pacote.nome") },
    { rotulo: "Convidados", valor: valorDe(extracao, "evento.convidados") },
    { rotulo: "Valor contratado", valor: valorDe(extracao, "valores.total") },
    { rotulo: "Condição de pagamento", valor: valorDe(extracao, "pagamentos.condicao") },
  ];
}

export function criarFluxoImportacao(extrair: Extrator) {
  return function fluxoImportacao(estado: FluxoImportacao, acao: AcaoImportacao): FluxoImportacao {
    switch (acao.tipo) {
      case "selecionar": {
        if (estado.etapa !== "upload") return estado;
        const validacao = validarArquivo(acao.arquivo);
        if (!validacao.ok) return { etapa: "upload", erro: validacao.mensagem };
        return { etapa: "analisando", arquivo: acao.arquivo, passo: 0 };
      }
      case "avancar": {
        if (estado.etapa !== "analisando") return estado;
        if (estado.passo < ETAPAS_ANALISE.length - 1) return { ...estado, passo: estado.passo + 1 };
        return { etapa: "revisao", extracao: extrair(estado.arquivo), revisados: [], confirmando: false };
      }
      case "cancelar":
      case "recomecar":
        return FLUXO_INICIAL;
      case "alternarRevisado": {
        if (estado.etapa !== "revisao" || estado.confirmando) return estado;
        const campo = todosCampos(estado.extracao).find((item) => item.id === acao.campoId);
        if (!campo || campo.estado !== "PRECISA_REVISAO") return estado;
        const revisados = estado.revisados.includes(campo.id)
          ? estado.revisados.filter((id) => id !== campo.id)
          : [...estado.revisados, campo.id];
        return { ...estado, revisados };
      }
      case "corrigir": {
        if (estado.etapa !== "revisao" || estado.confirmando) return estado;
        const existe = todosCampos(estado.extracao).some(c => c.id === acao.campoId);
        if (!existe || acao.valor.length > 4000) return estado;
        const valor = acao.valor.trim() || null;
        return { ...estado, extracao: { ...estado.extracao, secoes: estado.extracao.secoes.map(s => ({ ...s, campos: s.campos.map(c => c.id === acao.campoId ? { ...c, valor, estado: valor ? "ENCONTRADO" : "NAO_ENCONTRADO", origem: undefined, motivo: valor ? "Informado manualmente na demonstração." : undefined } : c) })) }, revisados: estado.revisados.filter(id => id !== acao.campoId) };
      }
      case "abrirConfirmacao":
        if (estado.etapa !== "revisao" || !podeConfirmar(estado.extracao, estado.revisados)) return estado;
        return { ...estado, confirmando: true };
      case "fecharConfirmacao":
        return estado.etapa === "revisao" ? { ...estado, confirmando: false } : estado;
      case "marcarPronto":
        // Estado visual apenas: nenhuma gravação acontece aqui ou em qualquer etapa deste fluxo.
        if (estado.etapa !== "revisao" || !estado.confirmando) return estado;
        return { etapa: "pronto", extracao: estado.extracao, revisados: estado.revisados };
    }
  };
}
