import type { DbExecutor } from "../db/contracts.ts";

/**
 * Leitura somente da agenda de festas da empresa comprovada.
 *
 * Mesmo predicado de tenant do Dashboard (`painelGeral`): festa → contrato → fechamento → pacote da
 * empresa. Existe separada porque `painelGeral` também passa por `listarContasPagar`, que grava
 * categorias padrão; uma consulta da IA não pode escrever.
 * Não devolve CPF, telefone, e-mail nem endereço.
 */
export type FestaAgenda = {
  festaId: string;
  data: string;
  horaInicio: string;
  horaFim: string | null;
  cliente: string;
  pacote: string;
  convidados: number;
  contratoStatus: string;
};

export async function agendaDoTenant(
  tx: DbExecutor,
  empresaId: string,
  inicio: string,
  fim: string,
  limite = 50,
): Promise<FestaAgenda[]> {
  const resultado = await tx.query<{
    id: string; data: string; hora: string; hora_fim: string | null; cliente: string; pacote: string; convidados: number; status: string;
  }>(
    `SELECT festa.id::text AS id, fech.data_evento::text AS data, fech.horario_inicio::text AS hora,
            fech.horario_fim::text AS hora_fim, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            pac.nome AS pacote, fech.convidados, contrato.status AS status
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento BETWEEN $2::date AND $3::date
      ORDER BY fech.data_evento, fech.horario_inicio
      LIMIT $4`,
    [empresaId, inicio, fim, Math.max(1, Math.min(limite, 200))],
  );
  return resultado.rows.map((linha) => ({
    festaId: linha.id,
    data: linha.data,
    horaInicio: String(linha.hora ?? "").slice(0, 5),
    horaFim: linha.hora_fim ? String(linha.hora_fim).slice(0, 5) : null,
    cliente: linha.cliente,
    pacote: linha.pacote,
    convidados: Number(linha.convidados),
    contratoStatus: linha.status,
  }));
}
