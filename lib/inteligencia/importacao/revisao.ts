import { decisoesSchema } from "../../contratos/integracao-importados/modelo.ts";
import { z } from "zod";
import type { PlanoImportacao } from "../../importacao-contrato/plano.ts";
import { aplicarRevisao } from "../../importacao-contrato/rascunho.ts";
import type { ImportacaoLida } from "../../importacao-contrato/repositorio-importacao.ts";
import type { TenantComprovado } from "../../saas/provar-tenant.ts";
import { iniciarRascunhoComPayload, type ContextoGate, type DependenciasHumanGate } from "../acoes/human-gate.ts";
import type { FerramentaAcao } from "../acoes/tipos.ts";
import type { AIResponse } from "../contratos.ts";
import { exigirPapelDocumento, extracaoGuardada, extracaoTemDados, responderComRastreio } from "../documentos/upload.ts";
import { envioDocumentoExternoAutorizado, grupoAtivo, inteligenciaAtiva } from "../flags.ts";
import { exigirGrupoNaEmpresa, pedidoInvalido, recursoDesativado, type DependenciasGateway, type RespostaGateway } from "../gateway.ts";
import { InteligenciaError } from "../politica.ts";
import { novoRastreio } from "../rastreio.ts";
import { dadosDaImportacao, decisaoSchema, hashPlano, planejar, type DadosImportacao, type PortaImportacao } from "./acao.ts";

/**
 * Importação histórica (feature IMPORT): documento extraído → rascunho de importação → revisão →
 * Human Gate → Import Engine.
 *
 * Aqui só há escrita técnica do próprio rascunho de importação (ia_importacoes) e do rascunho do Human
 * Gate. Nenhuma mutação de negócio confirmável (cliente, contrato histórico) é executada antes do Human
 * Gate: ela só acontece em /operacoes, depois do clique.
 */
/**
 * Situação legível da importação (A6). EM_ANDAMENTO: aberta para revisão/confirmação; CONCLUIDA: importada
 * (resultado recuperável); CANCELADA: descartada. Consulta por documento sem importação: FALHOU (a extração
 * falhou) ou NAO_INICIADA. Confirmação que falha é desfeita inteira e a importação continua EM_ANDAMENTO.
 */
export type SituacaoImportacao = "EM_ANDAMENTO" | "CONCLUIDA" | "CANCELADA";

/** Resultado mínimo da importação concluída: sem snapshot do contrato, CPF ou contatos. */
export type ResultadoImportacaoPublico = { clienteId: string; clienteAcao: "VINCULAR" | "CRIAR"; pendencias: string[]; importadoEm: string; destino: string };

export type ImportacaoPublica = {
  id: string;
  documentoId: string;
  versao: number;
  status: ImportacaoLida["status"];
  situacao: SituacaoImportacao;
  resultado: ResultadoImportacaoPublico | null;
  extracao: DadosImportacao["extracao"];
  revisados: string[];
  decisaoCliente: DadosImportacao["decisaoCliente"];
};

/**
 * B5: DTO da consulta de status/resultado. Só identificação, estado e resultado mínimo: nunca extração,
 * campos revisados, decisão de cliente, snapshot do contrato, CPF ou outro dado bruto do documento.
 */
export type ConsultaImportacaoPublica = Pick<ImportacaoPublica, "id" | "documentoId" | "versao" | "status" | "situacao" | "resultado">;

const SITUACAO: Readonly<Record<ImportacaoLida["status"], SituacaoImportacao>> = { EM_REVISAO: "EM_ANDAMENTO", IMPORTADA: "CONCLUIDA", DESCARTADA: "CANCELADA" };

function resultadoPublico(i: ImportacaoLida): ResultadoImportacaoPublico | null {
  if (i.status !== "IMPORTADA" || !i.resultado) return null;
  const r = i.resultado as { clienteId?: unknown; clienteAcao?: unknown; pendencias?: unknown; importadoEm?: unknown };
  const clienteId = typeof r.clienteId === "string" ? r.clienteId : i.clienteId;
  if (!clienteId || (r.clienteAcao !== "VINCULAR" && r.clienteAcao !== "CRIAR") || typeof r.importadoEm !== "string") {
    throw new InteligenciaError("IMPORTACAO_INVALIDA", "Resultado da importação inválido.", 409);
  }
  const pendencias = Array.isArray(r.pendencias) ? r.pendencias.filter((p): p is string => typeof p === "string") : [];
  return { clienteId, clienteAcao: r.clienteAcao, pendencias, importadoEm: r.importadoEm, destino: `/clientes/${clienteId}` };
}

export type PlanoPublico = Pick<PlanoImportacao, "pronto" | "bloqueios" | "avisos" | "match">;

export type DependenciasImportacao = DependenciasGateway & {
  importacao: PortaImportacao | null;
  /** Motor do Human Gate (feature ACTIONS) e a ação de importação registrada. */
  gate: DependenciasHumanGate | null;
  acao: FerramentaAcao | null;
};

function publico(i: ImportacaoLida): ImportacaoPublica {
  const dados = dadosDaImportacao(i);
  return { id: i.id, documentoId: i.documentoId, versao: i.versao, status: i.status, situacao: SITUACAO[i.status], resultado: resultadoPublico(i), extracao: dados.extracao, revisados: dados.revisados, decisaoCliente: dados.decisaoCliente };
}

function consultaPublica(i: ImportacaoLida): ConsultaImportacaoPublica {
  return { id: i.id, documentoId: i.documentoId, versao: i.versao, status: i.status, situacao: SITUACAO[i.status], resultado: resultadoPublico(i) };
}

const planoPublico = (p: PlanoImportacao): PlanoPublico => ({ pronto: p.pronto, bloqueios: p.bloqueios, avisos: p.avisos, match: p.match });

const alvo = { importacaoId: z.string().uuid() };
const comVersao = { ...alvo, versao: z.number().int().min(1) };
const pedidoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("estado") }).strict(),
  z.object({ acao: z.literal("abrir"), documentoId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("ler"), ...alvo }).strict(),
  // A6: consulta somente leitura pelo documento (ex.: depois de recarregar a tela). Nunca abre nem grava.
  z.object({ acao: z.literal("consultar"), documentoId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("revisar"), ...comVersao, campoId: z.string().regex(/^[a-z]+\.[A-Za-z0-9_]{1,40}$/), valor: z.string().max(500).optional(), confirmarDivergencia: z.literal(true).optional() }).strict(),
  z.object({ acao: z.literal("cliente"), ...comVersao, decisao: decisaoSchema }).strict(),
  z.object({ acao: z.literal("opcoes-completas"), ...comVersao }).strict(),
  z.object({ acao: z.literal("simular-completa"), ...comVersao, integracao: decisoesSchema }).strict(),
  z.object({ acao: z.literal("preparar"), ...comVersao, integracao: decisoesSchema.optional(), integracaoHash: z.string().regex(/^[0-9a-f]{64}$/).optional(), planoHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  z.object({ acao: z.literal("descartar"), ...comVersao }).strict(),
]);

/** Abertura, revisão e preparação do Human Gate. A confirmação em si vai para /operacoes. */
export async function atenderImportacao(pedido: { lerCorpo(): Promise<unknown>; empresaSolicitada: string | null }, deps: DependenciasImportacao): Promise<RespostaGateway> {
  const rastreio = novoRastreio("inteligencia.documento", deps.requestId());
  rastreio.capacidade = "importar_contrato";
  rastreio.intencao = "UI";
  return responderComRastreio(rastreio, deps, async () => {
    if (!inteligenciaAtiva(deps.env) || !grupoAtivo(deps.env, "CONTRACT_IMPORT")) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;
    exigirPapelDocumento(sessao);
    let entrada: z.infer<typeof pedidoSchema>;
    try {
      entrada = pedidoSchema.parse(await pedido.lerCorpo());
    } catch (error) {
      pedidoInvalido(error);
    }
    const p = deps.importacao;
    if (!p) throw new InteligenciaError("IMPORTACAO_INDISPONIVEL", "A importação não está disponível neste ambiente.", 503);
    return deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant: TenantComprovado) => {
      rastreio.empresaId = tenant.empresaComprovada;
      exigirGrupoNaEmpresa(deps.env, "CONTRACT_IMPORT", tenant);
      if (!await p.disponivel(tx)) throw new InteligenciaError("IMPORTACAO_INDISPONIVEL", "A importação ainda não está disponível neste ambiente.", 503);
      // Sonda da tela: flag, sessão, papel, tenant e tabelas conferidos, sem ler nenhum documento.
      if (entrada.acao === "estado") return { habilitado: true, envioExterno: envioDocumentoExternoAutorizado(deps.env) };
      if (entrada.acao === "abrir") {
        // Documento de outra empresa ou inexistente: mesma resposta.
        const registro = await p.ultimaExtracao(tx, tenant.empresaComprovada, entrada.documentoId);
        const extracao = extracaoGuardada(registro);
        if (!registro || !extracao) throw new InteligenciaError("NAO_ENCONTRADO", "Documento não encontrado.", 404);
        const dados: DadosImportacao = { extracao, revisados: [], decisaoCliente: null };
        let aberta = await p.abrirImportacao(tx, { empresaId: tenant.empresaComprovada, documentoId: entrada.documentoId, extracaoId: registro.extracaoId, usuarioId: sessao.usuario_id, dados: dados as unknown as Record<string, unknown> });
        // 064: importação concluída cujo contrato integrado foi CANCELADO deixa de ocupar o documento (passa a
        // DESCARTADA, resultado preservado em dados) e o mesmo arquivo abre uma nova revisão. Contrato ativo: nada muda.
        if (aberta.status === "IMPORTADA" && p.substituirImportacaoCancelada
          && await p.substituirImportacaoCancelada(tx, tenant.empresaComprovada, aberta, sessao.usuario_id)) {
          aberta = await p.abrirImportacao(tx, { empresaId: tenant.empresaComprovada, documentoId: entrada.documentoId, extracaoId: registro.extracaoId, usuarioId: sessao.usuario_id, dados: dados as unknown as Record<string, unknown> });
        }
        const anterior = dadosDaImportacao(aberta);
        // Recupera só revisão vazia e intocada. Edições, decisões e importações concluídas são preservadas.
        if (aberta.status === "EM_REVISAO" && aberta.extracaoId !== registro.extracaoId && anterior.revisados.length === 0 && anterior.decisaoCliente === null && !extracaoTemDados(anterior.extracao) && extracaoTemDados(extracao)) {
          // A extração faz parte da identidade imutável (055d). Encerra a revisão vazia
          // e abre outra, na mesma transação, em vez de trocar seu vínculo histórico.
          const descartada = { ...aberta, status: "DESCARTADA" as const, versao: aberta.versao + 1 };
          if (!await p.atualizarImportacao(tx, tenant.empresaComprovada, descartada, aberta.versao)) throw new InteligenciaError("IMPORTACAO_DESATUALIZADA", "A revisão mudou em outra aba. Atualize a página.", 409);
          aberta = await p.abrirImportacao(tx, { empresaId: tenant.empresaComprovada, documentoId: entrada.documentoId, extracaoId: registro.extracaoId, usuarioId: sessao.usuario_id, dados: dados as unknown as Record<string, unknown> });
        }
        return { importacao: publico(aberta), plano: aberta.status === "EM_REVISAO" ? planoPublico(await planejar(tx, tenant.empresaComprovada, p, dadosDaImportacao(aberta))) : null };
      }
      if (entrada.acao === "consultar") {
        const existente = await p.importacaoPorDocumento(tx, tenant.empresaComprovada, entrada.documentoId);
        if (existente) return { situacao: SITUACAO[existente.status], importacao: consultaPublica(existente) };
        // Sem importação: a última extração do documento diz se falhou. Outra empresa ou inexistente: 404 igual.
        const extracao = await p.ultimaExtracao(tx, tenant.empresaComprovada, entrada.documentoId);
        if (!extracao) throw new InteligenciaError("NAO_ENCONTRADO", "Documento não encontrado.", 404);
        return { situacao: extracao.status === "FALHOU" ? "FALHOU" : "NAO_INICIADA", importacao: null };
      }
      const atual = await p.lerImportacao(tx, tenant.empresaComprovada, entrada.importacaoId, entrada.acao !== "ler");
      if (!atual) throw new InteligenciaError("NAO_ENCONTRADO", "Importação não encontrada.", 404);
      if (entrada.acao === "ler") {
        return { importacao: publico(atual), plano: atual.status === "EM_REVISAO" ? planoPublico(await planejar(tx, tenant.empresaComprovada, p, dadosDaImportacao(atual))) : null };
      }
      if (atual.status !== "EM_REVISAO") throw new InteligenciaError("IMPORTACAO_ENCERRADA", "Esta importação já foi encerrada.", 409);
      if (atual.versao !== entrada.versao) throw new InteligenciaError("IMPORTACAO_DESATUALIZADA", "A revisão mudou em outra aba. Atualize a página.", 409);
      const dados = dadosDaImportacao(atual);
      const gravar = async (novos: DadosImportacao, status: ImportacaoLida["status"] = "EM_REVISAO") => {
        const proxima: ImportacaoLida = { ...atual, status, versao: atual.versao + 1, dados: novos as unknown as Record<string, unknown> };
        if (!await p.atualizarImportacao(tx, tenant.empresaComprovada, proxima, atual.versao)) throw new InteligenciaError("IMPORTACAO_DESATUALIZADA", "A revisão mudou em outra aba. Atualize a página.", 409);
        return proxima;
      };
      if (entrada.acao === "revisar") {
        const revisado = aplicarRevisao(dados.extracao, dados.revisados, {
          campoId: entrada.campoId,
          ...(entrada.valor !== undefined ? { valor: entrada.valor } : {}),
          ...(entrada.confirmarDivergencia ? { confirmarDivergencia: true } : {}),
        });
        if ("erro" in revisado) throw new InteligenciaError("DADOS_INVALIDOS", revisado.erro, 422);
        const proxima = await gravar({ ...dados, extracao: revisado.extracao, revisados: revisado.revisados });
        return { importacao: publico(proxima), plano: planoPublico(await planejar(tx, tenant.empresaComprovada, p, dadosDaImportacao(proxima))) };
      }
      if (entrada.acao === "cliente") {
        const proxima = await gravar({ ...dados, decisaoCliente: entrada.decisao });
        return { importacao: publico(proxima), plano: planoPublico(await planejar(tx, tenant.empresaComprovada, p, dadosDaImportacao(proxima))) };
      }
      if (entrada.acao === "descartar") {
        const proxima = await gravar(dados, "DESCARTADA");
        return { importacao: publico(proxima), plano: null };
      }
      // preparar: plano sem bloqueio ⇒ abre o Human Gate com preview; com bloqueio ⇒ devolve o que falta.
      const plano = await planejar(tx, tenant.empresaComprovada, p, dados);
      if (!plano.pronto) return { importacao: publico(atual), plano: planoPublico(plano), gate: null };
      if (entrada.acao === 'opcoes-completas') {
        if (!p.completa) throw new InteligenciaError('INTEGRACAO_INDISPONIVEL', 'A conclusão completa ainda não está disponível.', 503);
        return { importacao: publico(atual), plano: planoPublico(plano), opcoes: await p.completa.opcoes(tx, tenant, atual, plano) };
      }
      if (entrada.acao === 'simular-completa') {
        if (!p.completa) throw new InteligenciaError('INTEGRACAO_INDISPONIVEL', 'A conclusão completa ainda não está disponível.', 503);
        const simulacao = await p.completa.simular(tx, tenant, atual, plano, entrada.integracao);
        return { importacao: publico(atual), plano: planoPublico(plano), simulacao: { ...simulacao, planoHash: hashPlano(plano) } };
      }
      if (entrada.acao === 'preparar' && entrada.integracao) {
        if (entrada.planoHash && entrada.planoHash !== hashPlano(plano)) throw new InteligenciaError('RESUMO_DESATUALIZADO', 'O cadastro do cliente ou os dados do contrato mudaram. Confira novamente.', 409);
        if (!p.completa) throw new InteligenciaError('INTEGRACAO_INDISPONIVEL', 'A conclusão completa ainda não está disponível.', 503);
        const sim = await p.completa.simular(tx, tenant, atual, plano, entrada.integracao);
        if (!entrada.integracaoHash || entrada.integracaoHash !== sim.resumoHash) throw new InteligenciaError('RESUMO_DESATUALIZADO', 'A festa, a agenda ou os pagamentos mudaram. Confira novamente.', 409);
      }
      if (!deps.gate || !deps.acao) throw new InteligenciaError("ACOES_INDISPONIVEIS", "As confirmações do Kidmais ainda não estão disponíveis neste ambiente.", 503);
      const ctx: ContextoGate = { tx, tenant, sessao, correlationId: rastreio.requestId };
      const avanco = await iniciarRascunhoComPayload(deps.acao, { importacaoId: atual.id, versaoImportacao: atual.versao, decisaoCliente: dados.decisaoCliente, ...(entrada.acao === "preparar" && entrada.integracao !== undefined ? { integracao: entrada.integracao, integracaoHash: entrada.integracaoHash, planoHash: entrada.planoHash } : {}) }, ctx, deps.gate);
      rastreio.humanGate = avanco.resposta.tipo === "preview" ? "PREVIEW" : "RASCUNHO";
      return { importacao: publico(atual), plano: planoPublico(plano), gate: avanco.resposta as AIResponse };
    });
  });
}
