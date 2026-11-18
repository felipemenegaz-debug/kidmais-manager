import type { DbExecutor } from "../db/contracts.ts";
import { empresaDonaDaConfigLegada } from "../disponibilidade/config-legada.ts";
import { regraPublicaDaLinha, type DescontosEmpresaPublicos } from "./descontos-dia.ts";

/**
 * D4 (18/11/2026): as regras de desconto que a cotação do servidor aplica (`regras_desconto_pacote`, qualquer código,
 * inclusive as por horário), para o calendário, o aviso "Economize" e o selo mostrarem o mesmo que o preço vai cobrar.
 *
 *   - Só pacotes ativos e na revisão vigente (032) da própria empresa; só linhas ativas que ainda valem hoje ou depois (fuso de São Paulo).
 *   - Sai apenas dia, percentual, título, vigência, horário e prioridade: nada de observação interna ou id da regra.
 *   - Kidmais (código 'kidmais' ou dona da agenda legada) devolve `null`: continua pelo caminho atual (15% de segunda a
 *     quinta nos pacotes de sempre), sem mudança nenhuma.
 */
export async function descontosPublicosDaEmpresa(tx: DbExecutor, empresaId: string): Promise<DescontosEmpresaPublicos | null> {
  const codigo = (await tx.query<{ codigo: string }>("SELECT codigo FROM public.empresas WHERE id = $1::uuid", [empresaId])).rows[0]?.codigo;
  if (codigo === undefined || codigo === "kidmais" || (await empresaDonaDaConfigLegada(tx)) === empresaId) return null;
  const linhas = (await tx.query<{ pacote: string; dia_semana: number; percentual: string; titulo: string | null; vigencia_inicio: string; vigencia_fim: string | null; configuracao_agenda_id: string | null; prioridade: number }>(
    `SELECT p.codigo AS pacote, r.dia_semana, r.percentual::text AS percentual, r.titulo,
            r.vigencia_inicio::text AS vigencia_inicio, r.vigencia_fim::text AS vigencia_fim,
            r.configuracao_agenda_id::text AS configuracao_agenda_id, r.prioridade
       FROM public.regras_desconto_pacote r JOIN public.pacotes p ON p.id = r.pacote_id
      WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND r.ativo AND r.percentual > 0
        AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)
      ORDER BY p.codigo, r.dia_semana, r.vigencia_inicio, r.prioridade`,
    [empresaId])).rows;
  const porPacote: DescontosEmpresaPublicos = {};
  for (const l of linhas) (porPacote[l.pacote] ??= []).push(regraPublicaDaLinha(l));
  return porPacote;
}
