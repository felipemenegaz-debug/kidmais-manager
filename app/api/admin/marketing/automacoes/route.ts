import type { NextRequest } from "next/server";
import { z } from "zod";
import { db, withTransaction } from "@/lib/db/postgres";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirCapacidadeMarketing } from "@/lib/marketing/capacidades";
import { exigirUnidadeDaEmpresa } from "@/lib/marketing/campanhas";
import { MarketingError } from "@/lib/marketing/erros";
import { lerCorpo, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { sugerirDatasVagas } from "@/lib/marketing/sugestoes";
import { hojeSaoPaulo } from "@/lib/marketing/utm";
import { acaoManualExecucao, executarCiclo, simularEmpresa } from "@/lib/marketing/automacoes/motor";
import { alterarPreferencia, destinosDoCadastro, esquemaPreferencia, lerPreferencia } from "@/lib/marketing/automacoes/preferencias";
import {
  CATALOGO_REGRAS, ativarRegra, esquemaSalvarRegra, listarRegras, pararTudo, pausarRegra, regraDaEmpresa, revisarModelo, salvarRegra,
} from "@/lib/marketing/automacoes/regras";
import { automacoesHabilitadas, transporteDoAmbiente } from "@/lib/marketing/automacoes/transporte";
import type { DbExecutor } from "@/lib/db/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const esquemaPainel = z.discriminatedUnion("acao", [
  esquemaSalvarRegra,
  z.object({ acao: z.literal("revisar"), regraId: uuid, versao: z.number().int().min(1) }).strict(),
  z.object({ acao: z.literal("ativar"), regraId: uuid, versao: z.number().int().min(1) }).strict(),
  z.object({ acao: z.literal("pausar"), regraId: uuid }).strict(),
  z.object({ acao: z.literal("parar-tudo") }).strict(),
  z.object({ acao: z.literal("simular"), regraId: uuid }).strict(),
  z.object({ acao: z.literal("processar") }).strict(),
  z.object({ acao: z.literal("execucao"), execucaoId: uuid, operacao: z.enum(["tentar-novamente", "encerrar"]) }).strict(),
  z.object({ acao: z.literal("concluir-tarefa"), tarefaId: uuid, cancelar: z.boolean().optional() }).strict(),
]);
/** "preferencia" tem as próprias operações (autorizar destino, confirmar, revogar, descadastrar, reativar). */
const esquema = {
  parse(corpo: unknown) {
    return (corpo as { acao?: unknown } | null)?.acao === "preferencia" ? esquemaPreferencia.parse(corpo) : esquemaPainel.parse(corpo);
  },
};

async function painel(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  const execucoes = await tx.query<{ id: string; regra_tipo: string; acao: string; estado: string; agendada_para: string; tentativas: number; motivo: string | null;
    cliente_id: string; cliente_nome: string; destinatario_mascarado: string | null; conteudo: string | null; atualizado_em: string }>(
    `SELECT e.id::text, r.tipo AS regra_tipo, e.acao, e.estado, e.agendada_para::text, e.tentativas, e.motivo, e.cliente_id::text, c.nome_completo AS cliente_nome,
            e.destinatario_mascarado, e.conteudo, e.atualizado_em::text
       FROM marketing_automacao_execucoes e JOIN marketing_automacao_regras r ON r.id = e.regra_id AND r.empresa_id = e.empresa_id
       JOIN clientes c ON c.id = e.cliente_id
      WHERE e.empresa_id = $1::uuid AND r.estabelecimento_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY e.atualizado_em DESC LIMIT 100`, [empresaId, unidadeId]);
  const tarefas = await tx.query<{ id: string; titulo: string; descricao: string | null; vencimento: string; status: string; cliente_id: string }>(
    `SELECT t.id::text, t.titulo, t.descricao, t.vencimento::text, t.status, t.cliente_id::text FROM marketing_tarefas t
      WHERE t.empresa_id = $1::uuid AND t.status = 'ABERTA' ORDER BY t.vencimento, t.criado_em LIMIT 100`, [empresaId]);
  const saida = await tx.query<{ id: string; destinatario_mascarado: string; template_provedor: string; texto: string; status: string; aceito_em: string; provedor_mensagem_id: string }>(
    `SELECT id::text, destinatario_mascarado, template_provedor, texto, status, aceito_em::text, provedor_mensagem_id FROM marketing_transporte_simulado
      WHERE empresa_id = $1::uuid ORDER BY aceito_em DESC LIMIT 30`, [empresaId]);
  return {
    regras: await listarRegras(tx, empresaId, unidadeId),
    catalogo: CATALOGO_REGRAS,
    execucoes: execucoes.rows,
    tarefas: tarefas.rows,
    caixaSimulada: saida.rows,
    datasVagas: await sugerirDatasVagas(tx, empresaId, unidadeId, hojeSaoPaulo()),
    ambiente: { processamentoLigado: automacoesHabilitadas(), transporte: "SIMULADO" },
  };
}

export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant, capacidades }) => {
    const empresaId = tenant.empresaComprovada;
    const clienteId = parametroUuid(request.nextUrl.searchParams.get("clienteId"));
    if (clienteId) {
      const c = await tx.query<{ nome: string; whatsapp: string | null; telefone: string | null }>(
        "SELECT nome_completo AS nome, whatsapp, telefone FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid", [clienteId, empresaId]);
      if (!c.rows[0]) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Cliente não encontrado nesta empresa.", 404);
      return {
        cliente: { id: clienteId, nome: c.rows[0].nome, destinos: destinosDoCadastro(c.rows[0]) },
        preferencia: await lerPreferencia(tx, empresaId, clienteId),
      };
    }
    const unidadeId = await exigirUnidadeDaEmpresa(tx, empresaId, parametroUuid(request.nextUrl.searchParams.get("unidadeId")));
    const unidades = (await tx.query<{ id: string; nome: string }>(
      "SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome", [empresaId])).rows;
    return { ...(await painel(tx, empresaId, unidadeId)), unidades, capacidades };
  });
}

export async function POST(request: NextRequest) {
  let processar = false;
  const resposta = await rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant }) => {
    await exigirCapacidadeMarketing(tx, tenant, "MARKETING_AUTOMACOES_GERIR");
    const acao = esquema.parse(await lerCorpo(request));
    const empresaId = tenant.empresaComprovada;
    const usuarioId = tenant.usuarioId;
    switch (acao.acao) {
      case "salvar-regra": return { regra: await salvarRegra(tx, empresaId, usuarioId, acao) };
      case "revisar": return { regra: await revisarModelo(tx, empresaId, usuarioId, acao.regraId, acao.versao) };
      case "ativar": return { regra: await ativarRegra(tx, empresaId, usuarioId, acao.regraId, acao.versao) };
      case "pausar": return await pausarRegra(tx, empresaId, usuarioId, acao.regraId);
      case "parar-tudo": return await pararTudo(tx, empresaId, usuarioId);
      case "simular": return { simulacao: await simularEmpresa(tx, empresaId, await regraDaEmpresa(tx, empresaId, acao.regraId), new Date()) };
      case "execucao": {
        const estado = await acaoManualExecucao(tx, empresaId, acao.execucaoId, acao.operacao, new Date());
        if (estado === null) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Execução não encontrada nesta empresa.", 404);
        return { estado };
      }
      case "concluir-tarefa": {
        const r = await tx.query<{ id: string }>(`UPDATE marketing_tarefas SET status = $3, concluida_em = clock_timestamp(), concluida_por = $4::uuid
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'ABERTA' RETURNING id::text`, [acao.tarefaId, empresaId, acao.cancelar ? "CANCELADA" : "CONCLUIDA", usuarioId]);
        if (!r.rows[0]) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Tarefa não encontrada ou já concluída.", 404);
        return { id: r.rows[0].id };
      }
      case "preferencia": return await alterarPreferencia(tx, empresaId, usuarioId, acao);
      case "processar":
        if (!automacoesHabilitadas()) throw new MarketingError("MARKETING_AUTOMACOES_DESLIGADAS", "O processamento de automações está desligado neste servidor (MARKETING_AUTOMACOES_ENABLED).", 409);
        processar = true;
        return { empresaId };
    }
  });
  if (!processar || resposta.status !== 200) return resposta;
  // Processamento local da empresa comprovada: fora da transação da tela (cada execução tem as suas), transporte simulado.
  const { data } = await resposta.json() as { data: { empresaId: string } };
  try {
    const resultado = await executarCiclo({ transacao: withTransaction }, transporteDoAmbiente(db), new Date(), { empresaId: data.empresaId });
    return jsonNoStore({ ok: true, data: resultado });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
