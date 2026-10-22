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

/** Lista dos pacotes contratáveis da empresa — a mesma da cotação pública e do servidor (injetada para teste). */
export type ListarPacotesDaEmpresa = (empresaId: string, tx: DbExecutor) => Promise<Array<{
  id: string; codigo: string; nome?: string; convidadosMinimos?: number | null; convidadosMaximos?: number | null;
}>>;

export type PacotesDaAgendaDaEmpresa = {
  /** Só os pacotes que a empresa realmente tem (vigentes e ativos), na ordem da tela de Pacotes; empresa nova = []. */
  pacotes: Array<{ id: string; nome: string; convidadosMinimos: number | null; convidadosMaximos: number | null }>;
  regras: Record<string, RegraPacoteEmpresa[]>;
};

/**
 * Pacotes contratáveis da empresa e as regras de disponibilidade de cada um, pelo CÓDIGO do pacote no banco (POCKET,
 * P_9F…), que é o id da tela fora da dona da agenda pública — inclusive os criados por "Novo pacote". Mesma leitura
 * de `/api/fechamentos/pacotes?empresa=`: administração e cotação pública decidem com os mesmos dados.
 * Só a empresa informada (comprovada pela sessão).
 */
export async function pacotesDaAgendaDaEmpresa(
  tx: DbExecutor,
  empresaId: string,
  listarPacotes: ListarPacotesDaEmpresa,
): Promise<PacotesDaAgendaDaEmpresa> {
  const pacotes: PacotesDaAgendaDaEmpresa["pacotes"] = [];
  const regras: Record<string, RegraPacoteEmpresa[]> = {};
  for (const pacote of await listarPacotes(empresaId, tx)) {
    regras[pacote.codigo] = await lerRegrasDisponibilidadePacote(tx, pacote.id);
    pacotes.push({
      id: pacote.codigo, nome: pacote.nome?.trim() || pacote.codigo,
      convidadosMinimos: pacote.convidadosMinimos ?? null, convidadosMaximos: pacote.convidadosMaximos ?? null,
    });
  }
  return { pacotes, regras };
}

/** Regras de disponibilidade de TODOS os pacotes contratáveis da empresa, por código (ver `pacotesDaAgendaDaEmpresa`). */
export async function regrasDosPacotesDaEmpresa(
  tx: DbExecutor,
  empresaId: string,
  listarPacotes: ListarPacotesDaEmpresa,
): Promise<Record<string, RegraPacoteEmpresa[]>> {
  return (await pacotesDaAgendaDaEmpresa(tx, empresaId, listarPacotes)).regras;
}
