import { limiteConfigurado, validarArquivoEnviado, type ArquivoValidado } from "../../importacao-contrato/arquivo.ts";
import { SCHEMA_VERSAO } from "../../importacao-contrato/extracao.ts";
import type { ExtracaoContrato } from "../../importacao-contrato/modelo.ts";
import { montarRevisao } from "../../importacao-contrato/rascunho.ts";
import type { ExtracaoRegistrada, RegistroExtracao } from "../../importacao-contrato/repositorio-documentos.ts";
import { hojeBrasilia } from "../../financeiro/calculos.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { envioDocumentoExternoAutorizado, grupoAtivo, inteligenciaAtiva } from "../flags.ts";
import { classificar, exigirGrupoNaEmpresa, recursoDesativado, type DependenciasGateway, type RespostaGateway } from "../gateway.ts";
import type { RoteadorModelos } from "../modelos/roteador.ts";
import { InteligenciaError } from "../politica.ts";
import { anotarUsoModelo, novoRastreio, type RastreioInteligencia } from "../rastreio.ts";
import { extrairDocumento, type LeitorPdf, type Metodo } from "./extrair.ts";

/**
 * Document Foundation (feature DOCUMENT): upload real → documento privado → extração → revisão estruturada.
 *
 * Grava só registros técnicos da própria feature (documento, original, extração, evidências). Nenhum dado
 * de negócio (cliente, contrato, pagamento) nasce aqui. Abrir uma importação a partir do documento é da
 * feature IMPORT, que lê a extração registrada.
 */
export const PAPEIS_DOCUMENTO = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"] as const;

export type PortaDocumentos = {
  disponivel(tx: DbExecutor): Promise<boolean>;
  registrarDocumento(tx: DbExecutor, entrada: { empresaId: string; usuarioId: string; arquivo: ArquivoValidado }): Promise<{ documentoId: string; originalId: string; existente: boolean }>;
  registrarExtracao(tx: DbExecutor, extracao: RegistroExtracao): Promise<{ extracaoId: string }>;
  ultimaExtracao(tx: DbExecutor, empresaId: string, documentoId: string): Promise<ExtracaoRegistrada | null>;
};

export type DependenciasDocumento = DependenciasGateway & {
  documentos: PortaDocumentos | null;
  roteador: RoteadorModelos | null;
  /** Leitor de PDF isolado (Worker) na produção; ausente ⇒ em processo, com os mesmos limites. */
  lerPdf?: LeitorPdf;
};

export type ArquivoRecebido = { nome: string; tipo: string; bytes: Uint8Array };

export type DocumentoPublico = {
  documentoId: string;
  reaproveitado: boolean;
  metodo: Metodo | null;
  extracao: ExtracaoContrato | null;
  avisos: string[];
};

const MENSAGEM_FALLBACK = "Não foi possível processar o contrato agora. Nenhum cadastro foi alterado; tente de novo.";

export function exigirPapelDocumento(sessao: SessaoParaTenant) {
  if (!(PAPEIS_DOCUMENTO as readonly string[]).includes(sessao.papel)) throw new InteligenciaError("INTELIGENCIA_NAO_AUTORIZADA", "Seu acesso não permite importar contratos.", 403);
}

/** A extração guardada é a revisão estruturada; qualquer outro formato é tratado como ausente. */
export function extracaoGuardada(registro: ExtracaoRegistrada | null): ExtracaoContrato | null {
  const r = registro?.resultado as Partial<ExtracaoContrato> | null | undefined;
  return r && Array.isArray(r.secoes) && typeof r.fonte === "string" ? (r as ExtracaoContrato) : null;
}

export async function responderComRastreio(rastreio: RastreioInteligencia, deps: Pick<DependenciasGateway, "relogio" | "registrar">, trabalho: () => Promise<unknown>, fallback = MENSAGEM_FALLBACK): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  try {
    return { status: 200, corpo: { ok: true, data: await trabalho() } };
  } catch (error) {
    const falha = classificar(error, fallback);
    rastreio.resultado = falha.resultado;
    rastreio.codigo = falha.codigo;
    rastreio.causa = falha.causa;
    rastreio.fallback = rastreio.fallback || falha.fallback;
    return { status: falha.status, corpo: { ok: false, erro: falha.erro, codigo: falha.codigo } };
  } finally {
    rastreio.duracaoMs = Math.max(0, Math.round(relogio() - inicio));
    try { deps.registrar(rastreio); } catch { /* O trace nunca derruba a resposta. */ }
  }
}

/** Upload real. O arquivo é validado antes de qualquer transação. */
export async function atenderDocumento(
  pedido: { lerArquivo(): Promise<ArquivoRecebido | null>; empresaSolicitada: string | null; sinal?: AbortSignal },
  deps: DependenciasDocumento,
): Promise<RespostaGateway> {
  const rastreio = novoRastreio("inteligencia.documento", deps.requestId());
  rastreio.capacidade = "extrair_documento";
  rastreio.intencao = "UI";
  return responderComRastreio(rastreio, deps, async (): Promise<DocumentoPublico> => {
    if (!inteligenciaAtiva(deps.env) || !grupoAtivo(deps.env, "CONTRACT_IMPORT")) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;
    exigirPapelDocumento(sessao);
    const porta = deps.documentos;
    if (!porta) throw new InteligenciaError("DOCUMENTOS_INDISPONIVEIS", "O envio de documentos não está disponível neste ambiente.", 503);
    const recebido = await pedido.lerArquivo();
    if (!recebido) throw new InteligenciaError("DADOS_INVALIDOS", "Envie o arquivo do contrato.", 400);
    const validacao = validarArquivoEnviado({ nome: recebido.nome, tipoDeclarado: recebido.tipo, bytes: recebido.bytes, limiteBytes: limiteConfigurado(deps.env.AI_UPLOAD_MAX_BYTES) });
    if (!validacao.ok) throw new InteligenciaError(validacao.codigo, validacao.mensagem, 422);
    const arquivo = validacao.arquivo;

    const recepcao = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      exigirGrupoNaEmpresa(deps.env, "CONTRACT_IMPORT", tenant);
      if (!await porta.disponivel(tx)) throw new InteligenciaError("DOCUMENTOS_INDISPONIVEIS", "O envio de documentos ainda não está disponível neste ambiente.", 503);
      const registro = await porta.registrarDocumento(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, arquivo });
      const anterior = registro.existente ? extracaoGuardada(await porta.ultimaExtracao(tx, tenant.empresaComprovada, registro.documentoId)) : null;
      return { tenant, registro, anterior };
    });
    // Reenvio do mesmo arquivo: devolve a extração que já existe, sem ler de novo.
    if (recepcao.anterior) {
      rastreio.estado = "reaproveitado";
      return { documentoId: recepcao.registro.documentoId, reaproveitado: true, metodo: null, extracao: recepcao.anterior, avisos: ["DOCUMENTO_JA_ENVIADO"] };
    }

    const iniciadoEm = deps.agora().toISOString();
    // Extração fora de transação: chamada de modelo nunca segura lock no banco.
    const extracao = await extrairDocumento({
      sinal: pedido.sinal,
      lerPdf: deps.lerPdf,
      arquivo,
      roteador: deps.roteador,
      envioExterno: envioDocumentoExternoAutorizado(deps.env),
      alvo: { empresaId: recepcao.tenant.empresaComprovada, capacidade: "extrair_documento", correlationId: rastreio.requestId, hoje: hojeBrasilia(deps.agora()) },
    });
    anotarUsoModelo(rastreio, extracao.usos);
    const revisao = montarRevisao(extracao.lida, extracao.paginas, { nome: arquivo.nomeSeguro, tipo: arquivo.contentType, tamanhoBytes: arquivo.tamanhoBytes });
    const evidencias = revisao.secoes.flatMap((s) => s.campos).filter((c) => c.evidencia).map((c) => ({ campo: c.id, pagina: c.evidencia!.pagina, trecho: c.evidencia!.trecho, conferida: c.evidencia!.conferida }));

    await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
      if (tenant.empresaComprovada !== recepcao.tenant.empresaComprovada) throw new InteligenciaError("TENANT_NAO_COMPROVADO", "A empresa mudou durante o envio.", 403);
      return porta.registrarExtracao(tx, {
        empresaId: tenant.empresaComprovada, documentoId: recepcao.registro.documentoId, originalId: recepcao.registro.originalId,
        metodo: extracao.metodo, provedor: extracao.provedor, modelo: extracao.modelo, schemaVersao: SCHEMA_VERSAO, status: extracao.status,
        resultado: revisao as unknown as Record<string, unknown>, erro: extracao.avisos.find((a) => a.startsWith("MODELO_"))?.slice(0, 40) ?? null,
        correlationId: rastreio.requestId, iniciadoEm, concluidoEm: deps.agora().toISOString(), evidencias,
      });
    });
    rastreio.estado = extracao.metodo;
    rastreio.ferramentasExecutadas = [`documentos.extrair.${extracao.metodo.toLowerCase()}`];
    return { documentoId: recepcao.registro.documentoId, reaproveitado: false, metodo: extracao.metodo, extracao: revisao, avisos: extracao.avisos };
  });
}
