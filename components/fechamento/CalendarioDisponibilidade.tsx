"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PacoteId,
  StatusDisponibilidade,
} from "./types";
import { candidatosDisponiveis, horarioLegadoDoCodigo, rotuloPeriodo } from "./periodos";
import styles from "./FechamentoWizard.module.css";
import { apiPublica } from "../../lib/fechamentos/rota-publica";
import { useMarcaPublica } from "./MarcaPublica";
import {
  CONFIG_VAZIA,
  DisponibilidadeConfig,
  type RegraPacoteEmpresa,
  statusDataPacote,
  statusLabel,
} from "@/lib/agenda/disponibilidade";
import {
  descontoEfetivo,
  pacoteTemDescontoDiaUtil,
} from "@/lib/comercial/descontos";
import type {
  DisponibilidadeDataPublica,
  HorarioCandidatoPublico,
  PeriodoDisponibilidadePublica,
} from "@/lib/disponibilidade/services/models";

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const DIAS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

function iso(ano: number, mesZero: number, dia: number) {
  return `${ano}-${String(mesZero + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function hojeIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fonte do mês. Padrão: API pública. O painel administrativo passa a agenda da empresa/unidade comprovadas. */
export type ConsultaAgendaMes = (inicio: string, fim: string) => Promise<{
  dias: DisponibilidadeDataPublica[];
  comercial?: Pick<DisponibilidadeConfig, "pacoteOverrides" | "descontos">;
}>;

/** Parecer do Astra (P2-1): com pacote escolhido, o horário livre usa a duração dele (a mesma da revalidação). */
export async function consultaPublica(inicio: string, fim: string, empresa: string | null = null, duracaoMinutos: number | null = null) {
  const duracao = duracaoMinutos ? `&duracao=${duracaoMinutos}` : "";
  const r = await fetch(apiPublica(`/api/disponibilidade?inicio=${inicio}&fim=${fim}${duracao}`, empresa), { cache: "no-store" });
  const json = await r.json().catch(() => null);
  // Agenda pública sem contexto no servidor (062): mostra o motivo do servidor, nunca horários de outra empresa.
  if (!r.ok) throw new Error(String(json?.codigo ?? "").startsWith("AGENDA_PUBLICA_") ? String(json.erro) : "");
  const dias: DisponibilidadeDataPublica[] = Array.isArray(json.data) ? json.data : [json.data];
  return { dias, comercial: json.comercial };
}

export default function CalendarioDisponibilidade({
  pacote,
  configuracaoId,
  dataSelecionada,
  onSelecionar,
  onTrocarHorario,
  onConfigChange,
  consultar,
  empresa = null,
  descontoDiaUtil,
  regrasPacote = null,
  duracaoMinutos = null,
}: {
  pacote: PacoteId;
  /** Horário configurado escolhido (configuracao_agenda.id); "" = o primeiro horário livre de cada dia. */
  configuracaoId: string;
  dataSelecionada: string;
  /** Candidatos livres do horário na data, como a agenda devolveu (o deslocamento vem de cada horário). */
  onSelecionar: (
    data: string,
    status: StatusDisponibilidade,
    candidatos: HorarioCandidatoPublico[],
    periodo: PeriodoDisponibilidadePublica | null,
    /** Todos os horários configurados da data (para escolher outro no mesmo dia). */
    periodosDoDia: PeriodoDisponibilidadePublica[]
  ) => void;
  onTrocarHorario: (configuracaoId: string) => void;
  onConfigChange?: (config: DisponibilidadeConfig) => void;
  consultar?: ConsultaAgendaMes;
  /** Código público da empresa (/b/<código>); ausente = endereço atual. */
  empresa?: string | null;
  /** Regra do selo -15% vinda da tela (regras do servidor); ausente = a da marca. */
  descontoDiaUtil?: boolean;
  /** Regras de disponibilidade da empresa para o pacote (/b/<código>); ausente = regra legada do endereço atual. */
  regrasPacote?: readonly RegraPacoteEmpresa[] | null;
  /** Duração do pacote escolhido (consulta pública); ausente = o servidor usa a do pacote mais curto da empresa. */
  duracaoMinutos?: number | null;
}) {
  const marca = useMarcaPublica();
  const diaUtil = descontoDiaUtil ?? marca.pagamento.descontoDiaUtil;
  const consultarAgenda = useMemo<ConsultaAgendaMes>(() => consultar ?? ((inicio, fim) => consultaPublica(inicio, fim, empresa, duracaoMinutos)), [consultar, empresa, duracaoMinutos]);
  const agora = new Date();
  const [mes, setMes] = useState(agora.getMonth());
  const [ano, setAno] = useState(agora.getFullYear());
  const [config, setConfig] =
    useState<DisponibilidadeConfig>(CONFIG_VAZIA);
  const [operacionalPorData, setOperacionalPorData] = useState<
    Record<string, DisponibilidadeDataPublica>
  >({});
  const [carregando, setCarregando] = useState(true);
  const [aviso, setAviso] = useState<{
    tipo: "erro" | "consulta" | "excecao" | "ok";
    titulo: string;
    texto: string;
    alternativa?: { configuracaoId: string; rotulo: string };
  } | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);

    try {
      const inicio = iso(ano, mes, 1);
      const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
      const fim = iso(ano, mes, ultimoDia);
      const json = await consultarAgenda(inicio, fim);
      const dias = json.dias;
      setOperacionalPorData(
        Object.fromEntries(dias.map((item) => [item.data, item])),
      );

      const novaConfig: DisponibilidadeConfig = {
        agenda: [],
        pacoteOverrides: json.comercial?.pacoteOverrides ?? [],
        descontos: json.comercial?.descontos ?? [],
      };
      setConfig(novaConfig);
      onConfigChange?.(novaConfig);
      setAviso(null);
    } catch (falha) {
      setOperacionalPorData({});
      setConfig(CONFIG_VAZIA);
      onConfigChange?.(CONFIG_VAZIA);
      setAviso({
        tipo: "erro",
        titulo: "Não foi possível consultar a disponibilidade agora.",
        texto: (falha instanceof Error && falha.message) || "Tente novamente antes de selecionar a data.",
      });
    } finally {
      setCarregando(false);
    }
  }, [ano, mes, onConfigChange, consultarAgenda]);

  useEffect(() => {
    const timer = window.setTimeout(() => void carregar(), 0);
    return () => window.clearTimeout(timer);
  }, [carregar, pacote, configuracaoId]);

  const diasMes = useMemo(() => {
    const primeiro = new Date(
      Date.UTC(ano, mes, 1)
    ).getUTCDay();

    const total = new Date(
      Date.UTC(ano, mes + 1, 0)
    ).getUTCDate();

    return { primeiro, total };
  }, [ano, mes]);

  function mudarMes(delta: number) {
    const proximo = new Date(
      Date.UTC(ano, mes + delta, 1)
    );

    setAno(proximo.getUTCFullYear());
    setMes(proximo.getUTCMonth());
    setAviso(null);
  }

  /**
   * Horário da data: o escolhido (por configuracaoId) ou, sem escolha, o primeiro com candidato livre.
   * `undefined` = dia ainda não carregado; `null` = o horário não acontece neste dia.
   */
  function periodoOperacional(data: string, id = configuracaoId) {
    const periodos = operacionalPorData[data]?.periodos;
    if (!periodos) return undefined;
    if (id) return periodos.find((item) => item.configuracaoId === id) ?? null;
    return periodos.find((item) => candidatosDisponiveis(item).length > 0) ?? periodos[0] ?? null;
  }

  /** Outro horário do mesmo dia com candidato livre e pacote não indisponível (sugestão do aviso). */
  function horarioAlternativo(data: string, atualId: string | undefined) {
    const alternativo = (operacionalPorData[data]?.periodos ?? []).find((item) => {
      if (item.configuracaoId === atualId || candidatosDisponiveis(item).length === 0) return false;
      const legadoAlt = horarioLegadoDoCodigo(item.codigo);
      const statusAlt = statusDataPacote(config, pacote, data, legadoAlt, regrasPacote, item.configuracaoId);
      return statusAlt.status !== "indisponivel";
    });
    return alternativo ? { configuracaoId: alternativo.configuracaoId, rotulo: rotuloPeriodo(alternativo) } : undefined;
  }

  function selecionarData(data: string) {
    if (data < hojeIso()) return;

    const turno = periodoOperacional(data);
    if (turno === undefined) {
      setAviso({
        tipo: "erro",
        titulo: "Disponibilidade não carregada.",
        texto: "Atualize o calendário e tente novamente.",
      });
      return;
    }

    const candidatos = candidatosDisponiveis(turno);
    if (!turno || turno.status === "INDISPONIVEL" || candidatos.length === 0) {
      setAviso({
        tipo: "erro",
        titulo: "Esse horário está indisponível.",
        texto: "Escolha outra data ou verifique outro horário deste mesmo dia.",
        alternativa: horarioAlternativo(data, turno?.configuracaoId),
      });
      return;
    }

    // Legado almoco/noite só para TURNO_1/TURNO_2 (regra fixa do endereço atual e ajustes manuais); "" nos demais.
    const legado = horarioLegadoDoCodigo(turno.codigo);
    const atual = statusDataPacote(config, pacote, data, legado, regrasPacote, turno.configuracaoId);

    if (atual.status === "indisponivel") {
      setAviso({
        tipo: "erro",
        titulo: "Este pacote não está disponível neste horário.",
        texto: atual.motivo || "Escolha outra data ou horário para continuar.",
        alternativa: horarioAlternativo(data, turno.configuracaoId),
      });
      return;
    }

    const desconto = descontoEfetivo(
      config,
      pacote,
      data,
      legado,
      diaUtil,
    );

    onSelecionar(
      data,
      atual.status === "excecao" ? "excecao" : atual.status,
      candidatos,
      turno,
      operacionalPorData[data]?.periodos ?? [],
    );

    if (atual.status === "excecao") {
      setAviso({
        tipo: "excecao",
        titulo: "Esta opção é uma exceção.",
        texto:
          (atual.motivo ||
            "Esta combinação não é realizada normalmente.") +
          ` Você pode continuar e solicitar uma análise especial ${marca.da}.`,
      });
      return;
    }

    if (atual.status === "consulta") {
      setAviso({
        tipo: "consulta",
        titulo: `Data sujeita à avaliação ${marca.da}.`,
        texto:
          (atual.motivo ||
            "Você pode continuar. A equipe avaliará essa data antes de liberar o contrato.") +
          (desconto.ativo
            ? ` Se a data for aprovada, será aplicado ${Math.round(
                desconto.percentual * 100
              )}% de desconto no valor do pacote.`
            : ""),
      });
      return;
    }

    setAviso({
      tipo: "ok",
      titulo: desconto.ativo
        ? `Data disponível com ${Math.round(
            desconto.percentual * 100
          )}% de desconto.`
        : "Data disponível para este pacote.",
      texto: desconto.ativo
        ? `${desconto.titulo}. O desconto é aplicado ao valor do pacote; adicionais são calculados separadamente.`
        : "A seleção pode continuar, mas a reserva só será confirmada após contrato e primeiro pagamento.",
    });
  }

  const temAlgumBeneficioPadrao =
    diaUtil && pacoteTemDescontoDiaUtil(pacote);

  return (
    <div className={styles.calendarWrap} data-calendario-disponibilidade>
      <div className={styles.calendarToolbar}>
        <button
          type="button"
          onClick={() => mudarMes(-1)}
          aria-label="Mês anterior"
        >
          ←
        </button>

        <strong>{MESES[mes]} de {ano}</strong>

        <div className={styles.calendarToolbarActions}>
          <button
            type="button"
            onClick={carregar}
            disabled={carregando}
          >
            {carregando ? "Atualizando..." : "Atualizar"}
          </button>

          <button
            type="button"
            onClick={() => mudarMes(1)}
            aria-label="Próximo mês"
          >
            →
          </button>
        </div>
      </div>

      {temAlgumBeneficioPadrao && (
        <div className={styles.weekdayDiscountBanner}>
          <span className={styles.weekdayDiscountIcon}>%</span>
          <div>
            <strong>15% de desconto de segunda a quinta</strong>
            <p>
              Este pacote recebe 15% de desconto no valor do pacote
              quando a festa acontece de segunda a quinta.
            </p>
          </div>
        </div>
      )}

      <div
        className={styles.calendarLegend}
        aria-label="Legenda do calendário"
      >
        <span className={styles.legendAvailable}>
          <i>✓</i> Disponível
        </span>
        <span className={styles.legendConsult}>
          <i>?</i> {marca.kidmais ? "Consultar Kidmais" : "Consultar o buffet"}
        </span>
        <span className={styles.legendException}>
          <i>!</i> Exceção
        </span>
        <span className={styles.legendUnavailable}>
          <i>×</i> Indisponível
        </span>
      </div>

      <div className={styles.weekHeader}>
        {DIAS.map((dia) => (
          <span key={dia}>{dia}</span>
        ))}
      </div>

      <div className={styles.calendarGrid}>
        {Array.from({
          length: diasMes.primeiro,
        }).map((_, i) => (
          <span
            className={styles.calendarEmpty}
            key={`empty-${i}`}
          />
        ))}

        {Array.from({
          length: diasMes.total,
        }).map((_, i) => {
          const dia = i + 1;
          const data = iso(ano, mes, dia);
          const passado = data < hojeIso();

          const turnoOperacional = passado ? undefined : periodoOperacional(data);
          const semDados = !passado && turnoOperacional === undefined;
          const legado = horarioLegadoDoCodigo(turnoOperacional?.codigo);
          const info = passado
            ? {
                status: "indisponivel" as const,
                origem: "regra" as const,
                motivo: "Data passada.",
              }
            : !turnoOperacional
              ? {
                  status: "indisponivel" as const,
                  origem: "agenda" as const,
                  motivo: "Este horário não acontece neste dia.",
                }
              : turnoOperacional.status === "INDISPONIVEL"
                ? {
                    status: "indisponivel" as const,
                    origem: "agenda" as const,
                    motivo: "Este horário não está disponível.",
                  }
                : statusDataPacote(config, pacote, data, legado, regrasPacote, turnoOperacional.configuracaoId);

          const selecionada =
            dataSelecionada === data;

          const desconto =
            !passado &&
            info.status !== "indisponivel"
              ? descontoEfetivo(
                  config,
                  pacote,
                  data,
                  legado,
                  diaUtil,
                )
              : {
                  ativo: false,
                  percentual: 0,
                  origem: "nenhum" as const,
                  titulo: "",
                };

          const classe =
            info.status === "disponivel"
              ? styles.calendarAvailable
              : info.status === "consulta"
                ? styles.calendarConsult
                : info.status === "excecao"
                  ? styles.calendarException
                  : styles.calendarUnavailable;

          const simbolo = semDados
            ? "…"
            : info.status === "disponivel"
              ? "✓"
              : info.status === "consulta"
                ? "?"
                : info.status === "excecao"
                  ? "!"
                  : "×";

          return (
            <button
              type="button"
              key={data}
              className={`${styles.calendarDay} ${classe} ${
                selecionada
                  ? styles.calendarSelected
                  : ""
              } ${
                passado
                  ? styles.calendarPast
                  : ""
              }`}
              onClick={() => selecionarData(data)}
              disabled={passado || semDados}
              aria-label={`${dia} de ${MESES[mes]}: ${
                semDados ? "disponibilidade não carregada" : statusLabel(info.status, marca.kidmais)
              }${
                desconto.ativo
                  ? `, ${Math.round(
                      desconto.percentual * 100
                    )}% de desconto`
                  : ""
              }`}
              title={
                semDados
                  ? "Disponibilidade não carregada."
                  : info.motivo || statusLabel(info.status, marca.kidmais)
              }
            >
              <div className={styles.calendarDayTop}>
                <span>{dia}</span>

                {desconto.ativo && (
                  <em
                    className={
                      styles.calendarDiscountBadge
                    }
                  >
                    -
                    {Math.round(
                      desconto.percentual * 100
                    )}
                    %
                  </em>
                )}
              </div>

              <i>{simbolo}</i>
            </button>
          );
        })}
      </div>

      {aviso && (
        <div
          className={`${styles.calendarMessage} ${
            aviso.tipo === "erro"
              ? styles.calendarMessageError
              : aviso.tipo === "consulta"
                ? styles.calendarMessageConsult
                : aviso.tipo === "excecao"
                  ? styles.calendarMessageException
                  : styles.calendarMessageOk
          }`}
          aria-live="polite"
        >
          <div>
            <strong>{aviso.titulo}</strong>
            <p>{aviso.texto}</p>
          </div>

          {aviso.alternativa && (
            <button
              type="button"
              onClick={() => {
                onSelecionar("", "", [], null, []);
                onTrocarHorario(aviso.alternativa!.configuracaoId);
                setAviso(null);
              }}
            >
              Ver {aviso.alternativa.rotulo}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
