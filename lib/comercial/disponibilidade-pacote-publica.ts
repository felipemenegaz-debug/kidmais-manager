import type { HorarioBase } from "../../components/fechamento/types.ts";
import type { RegraPacoteEmpresa } from "../agenda/disponibilidade.ts";
import type { DbExecutor } from "../db/contracts.ts";

type Linha = {
  dia_semana: number;
  codigo: string;
  estado: RegraPacoteEmpresa["estado"];
  vigencia_inicio: string;
  vigencia_fim: string | null;
};

const PERIODO: Record<string, HorarioBase> = { TURNO_1: "almoco", TURNO_2: "noite" };

/** Converte as linhas; período desconhecido fica de fora (a tela trata como sem regra = indisponível). */
export function regrasPublicasDoPacote(linhas: readonly Linha[]): RegraPacoteEmpresa[] {
  return linhas.flatMap((linha) => {
    const horario = PERIODO[linha.codigo];
    if (!horario) return [];
    return [{
      dia: Number(linha.dia_semana),
      horario,
      estado: linha.estado,
      vigenciaInicio: linha.vigencia_inicio,
      vigenciaFim: linha.vigencia_fim,
    }];
  });
}

/**
 * Regras semanais ativas do pacote (regras_disponibilidade_pacote), ainda vigentes ou futuras, com a vigência:
 * a tela da empresa escolhe a regra da data como o servidor faz na cotação. Sem dado pessoal; só o pacote pedido.
 */
export async function lerRegrasDisponibilidadePacote(tx: DbExecutor, pacoteId: string): Promise<RegraPacoteEmpresa[]> {
  const r = await tx.query<Linha>(
    `SELECT r.dia_semana, c.codigo, r.estado, r.vigencia_inicio::text AS vigencia_inicio, r.vigencia_fim::text AS vigencia_fim
       FROM regras_disponibilidade_pacote r
       JOIN configuracao_agenda c ON c.id = r.configuracao_agenda_id
      WHERE r.pacote_id = $1::uuid
        AND r.ativo
        AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= CURRENT_DATE)
      ORDER BY r.dia_semana, c.codigo, r.vigencia_inicio`,
    [pacoteId],
  );
  return regrasPublicasDoPacote(r.rows);
}
