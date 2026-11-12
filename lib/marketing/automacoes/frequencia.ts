import type { DbExecutor } from "../../db/contracts.ts";
import { pesquisaInstalada } from "../../satisfacao/supressao.ts";

/**
 * Contato recente do cliente: Mensagem simples em ENVIANDO/ACEITA/ENTREGUE/INCERTA no limite e, com a 110, pesquisa de
 * satisfação com a reserva viva (plano da pesquisa M2/L2): sem marco e com entrega INICIAL ainda PENDENTE ou ENVIANDO
 * (conta como contato AGORA), ou com o marco contato_em dentro do limite. `excetoEnvioId`: o despacho da própria
 * pesquisa (segundo canal, nova tentativa) não se bloqueia; o lembrete nem passa por aqui.
 * Fica fora do motor para o despacho das entregas (lib/satisfacao/despacho.ts) usar sem ciclo de importação.
 */
export async function frequenciaExcedida(tx: DbExecutor, empresaId: string, clienteId: string, dias: number, excetoId: string | null, excetoEnvioId: string | null = null) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT true AS ok FROM marketing_automacao_execucoes
      WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND acao = 'MENSAGEM_WHATSAPP' AND estado IN ('ENVIANDO', 'ACEITA', 'ENTREGUE', 'INCERTA')
        AND atualizado_em > clock_timestamp() - make_interval(days => $3::int) AND ($4::uuid IS NULL OR id <> $4::uuid) LIMIT 1`,
    [empresaId, clienteId, dias, excetoId]);
  if (r.rows.length > 0) return true;
  if (!(await pesquisaInstalada(tx))) return false;
  const p = await tx.query<{ ok: boolean }>(
    `SELECT true AS ok FROM satisfacao_envios s
      WHERE s.empresa_id = $1::uuid AND s.cliente_id = $2::uuid AND ($4::uuid IS NULL OR s.id <> $4::uuid)
        AND ((s.contato_em IS NULL AND EXISTS (SELECT 1 FROM satisfacao_entregas d WHERE d.envio_id = s.id AND d.etapa = 'INICIAL' AND d.estado IN ('PENDENTE', 'ENVIANDO')))
          OR s.contato_em > clock_timestamp() - make_interval(days => $3::int)) LIMIT 1`,
    [empresaId, clienteId, dias, excetoEnvioId]);
  return p.rows.length > 0;
}
