import type { HorarioBase } from "../../components/fechamento/types.ts";
import type { RegraPacoteEmpresa } from "../agenda/disponibilidade.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";

type Linha = {
  dia_semana: number;
  codigo: string;
  configuracao_id?: string;
  estado: RegraPacoteEmpresa["estado"];
  vigencia_inicio: string;
  vigencia_fim: string | null;
};

const PERIODO: Record<string, HorarioBase> = { TURNO_1: "almoco", TURNO_2: "noite" };

/**
 * Converte as linhas. Com o id do horário configurado, qualquer código vale (TURNO_1/TURNO_2/HORARIO_n) e a tela
 * casa pelo `configuracaoId`; sem id, só TURNO_1/TURNO_2 (legado almoco/noite) — o resto fica de fora (sem regra =
 * indisponível).
 */
export function regrasPublicasDoPacote(linhas: readonly Linha[]): RegraPacoteEmpresa[] {
  return linhas.flatMap((linha) => {
    const horario = PERIODO[linha.codigo] ?? "";
    if (!horario && !linha.configuracao_id) return [];
    return [{
      dia: Number(linha.dia_semana),
      horario,
      ...(linha.configuracao_id ? { configuracaoId: linha.configuracao_id } : {}),
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
    `SELECT r.dia_semana, c.codigo, c.id::text AS configuracao_id, r.estado, r.vigencia_inicio::text AS vigencia_inicio, r.vigencia_fim::text AS vigencia_fim
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

/** Busca do pacote vigente da empresa por código — a mesma da cotação pública e do servidor (injetada para teste). */
export type BuscarPacoteDaEmpresa = (empresaId: string, codigo: string, tx: DbExecutor) => Promise<{ id: string; nome?: string } | null>;

export type PacotesDaAgendaDaEmpresa = {
  /** Só os pacotes que a empresa realmente tem (vigentes e ativos), na ordem da tela; empresa nova = []. */
  pacotes: Array<{ id: string; nome: string }>;
  regras: Record<string, RegraPacoteEmpresa[]>;
};

/**
 * Pacotes contratáveis da empresa e as regras de disponibilidade de cada um, por id da tela (pocket, mini, …), com a
 * mesma leitura usada por `/api/fechamentos/pacotes?empresa=` — administração e cotação pública decidem com os mesmos
 * dados. Pacote que a empresa não oferece fica fora de `pacotes` e tem regras [] (nada disponível pela regra).
 * Só a empresa informada (comprovada pela sessão).
 */
export async function pacotesDaAgendaDaEmpresa(
  tx: DbExecutor,
  empresaId: string,
  buscarPacote: BuscarPacoteDaEmpresa,
): Promise<PacotesDaAgendaDaEmpresa> {
  const pacotes: PacotesDaAgendaDaEmpresa["pacotes"] = [];
  const regras: Record<string, RegraPacoteEmpresa[]> = {};
  for (const { id, codigo } of PACOTES_CONTRATAVEIS_V1) {
    const pacote = await buscarPacote(empresaId, codigo, tx);
    regras[id] = pacote ? await lerRegrasDisponibilidadePacote(tx, pacote.id) : [];
    if (pacote) pacotes.push({ id, nome: pacote.nome?.trim() || codigo });
  }
  return { pacotes, regras };
}

/** Regras de disponibilidade de TODOS os pacotes contratáveis da empresa (ver `pacotesDaAgendaDaEmpresa`). */
export async function regrasDosPacotesDaEmpresa(
  tx: DbExecutor,
  empresaId: string,
  buscarPacote: BuscarPacoteDaEmpresa,
): Promise<Record<string, RegraPacoteEmpresa[]>> {
  return (await pacotesDaAgendaDaEmpresa(tx, empresaId, buscarPacote)).regras;
}
