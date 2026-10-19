import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo, parametroData, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { detalheContato, esquemaAcaoContato, executarAcaoContato, listarContatos, STATUS_CONTATO, type StatusContato } from "@/lib/marketing/contatos";
import { lerOrigens } from "@/lib/marketing/origens";
import { listarCampanhas } from "@/lib/marketing/campanhas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista (filtros) ou detalhe (?id=). Contatos captados são dados pessoais: só quem vê Marketing nesta empresa. */
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant, capacidades }) => {
    const empresaId = tenant.empresaComprovada;
    const q = request.nextUrl.searchParams;
    const id = parametroUuid(q.get("id"));
    if (id) return { contato: await detalheContato(tx, empresaId, id), origens: await lerOrigens(tx, empresaId), capacidades };
    const status = q.get("status");
    return {
      contatos: await listarContatos(tx, empresaId, {
        de: parametroData(q.get("de")), ate: parametroData(q.get("ate")),
        status: (STATUS_CONTATO as readonly string[]).includes(status ?? "") ? status as StatusContato : null,
        unidadeId: parametroUuid(q.get("unidadeId")), campanhaId: parametroUuid(q.get("campanhaId")),
      }),
      origens: await lerOrigens(tx, empresaId),
      campanhas: (await listarCampanhas(tx, empresaId, { incluirArquivadas: true })).map((c) => ({ id: c.id, nome: c.nome, status: c.status })),
      capacidades,
      gestao: tenant.papelAtual === "REPRESENTANTE_AUTORIZADO",
      unidades: (await tx.query<{ id: string; nome: string }>(
        "SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome", [empresaId])).rows,
    };
  });
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_CAMPANHAS_EDITAR" }, async ({ tx, tenant }) => {
    const acao = esquemaAcaoContato.parse(await lerCorpo(request));
    return executarAcaoContato(tx, tenant.empresaComprovada, tenant.usuarioId, acao);
  });
}
