"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AjusteHorario,
  HorarioBase,
  PacoteId,
  StatusDisponibilidade,
} from "./types";
import styles from "./FechamentoWizard.module.css";
import {
  CONFIG_VAZIA,
  DisponibilidadeConfig,
  horarioAlternativo,
  statusDataPacote,
  statusLabel,
} from "@/lib/agenda/disponibilidade";
import {
  descontoEfetivo,
  pacoteTemDescontoDiaUtil,
} from "@/lib/comercial/descontos";
import type { DisponibilidadeDataPublica } from "@/lib/disponibilidade/services/models";

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

export default function CalendarioDisponibilidade({
  pacote,
  horario,
  dataSelecionada,
  onSelecionar,
  onTrocarHorario,
  onConfigChange,
}: {
  pacote: PacoteId;
  horario: HorarioBase;
  dataSelecionada: string;
  onSelecionar: (
    data: string,
    status: StatusDisponibilidade,
    ajustesDisponiveis: AjusteHorario[]
  ) => void;
  onTrocarHorario: (horario: HorarioBase) => void;
  onConfigChange?: (config: DisponibilidadeConfig) => void;
}) {
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
    alternativa?: HorarioBase;
  } | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);

    try {
      const inicio = iso(ano, mes, 1);
      const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
      const fim = iso(ano, mes, ultimoDia);
      const r = await fetch(
        `/api/disponibilidade?inicio=${inicio}&fim=${fim}`,
        { cache: "no-store" },
      );

      if (!r.ok) throw new Error();

      const json = await r.json();
      const dias: DisponibilidadeDataPublica[] = Array.isArray(json.data)
        ? json.data
        : [json.data];
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
    } catch {
      setOperacionalPorData({});
      setConfig(CONFIG_VAZIA);
      onConfigChange?.(CONFIG_VAZIA);
      setAviso({
        tipo: "erro",
        titulo: "Não foi possível consultar a disponibilidade agora.",
        texto: "Tente novamente antes de selecionar a data.",
      });
    } finally {
      setCarregando(false);
    }
  }, [ano, mes, onConfigChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => void carregar(), 0);
    return () => window.clearTimeout(timer);
  }, [carregar, pacote, horario]);

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

  function periodoOperacional(data: string, periodo: HorarioBase) {
    const codigo = periodo === "almoco" ? "TURNO_1" : "TURNO_2";
    return operacionalPorData[data]?.periodos.find(
      (item) => item.codigo === codigo,
    );
  }

  function ajustesOperacionaisDisponiveis(
    data: string,
    periodo: HorarioBase,
  ): AjusteHorario[] {
    const turno = periodoOperacional(data, periodo);
    if (!turno) return [];

    return turno.horarios
      .filter((item) => item.status === "DISPONIVEL")
      .map((item) => String(item.ajusteMinutos) as AjusteHorario)
      .filter((item) => item === "-30" || item === "0" || item === "30");
  }

  function selecionarData(data: string) {
    if (data < hojeIso()) return;

    const turno = periodoOperacional(data, horario);
    if (!turno) {
      setAviso({
        tipo: "erro",
        titulo: "Disponibilidade não carregada.",
        texto: "Atualize o calendário e tente novamente.",
      });
      return;
    }

    const ajustesDisponiveis = ajustesOperacionaisDisponiveis(data, horario);
    if (turno.status === "INDISPONIVEL" || ajustesDisponiveis.length === 0) {
      const alt = horarioAlternativo(horario);
      const ajustesAlt = ajustesOperacionaisDisponiveis(data, alt);

      setAviso({
        tipo: "erro",
        titulo: "Esse período está indisponível.",
        texto: "Escolha outra data ou verifique o outro período deste mesmo dia.",
        alternativa: ajustesAlt.length > 0 ? alt : undefined,
      });
      return;
    }

    const atual = statusDataPacote(
      config,
      pacote,
      data,
      horario
    );

    if (atual.status === "indisponivel") {
      const alt = horarioAlternativo(horario);
      const statusAlt = statusDataPacote(config, pacote, data, alt);
      const ajustesAlt = ajustesOperacionaisDisponiveis(data, alt);

      setAviso({
        tipo: "erro",
        titulo: "Este pacote não está disponível neste período.",
        texto: atual.motivo || "Escolha outra data ou período para continuar.",
        alternativa:
          statusAlt.status !== "indisponivel" && ajustesAlt.length > 0
            ? alt
            : undefined,
      });
      return;
    }

    const desconto = descontoEfetivo(
      config,
      pacote,
      data,
      horario
    );

    onSelecionar(
      data,
      atual.status === "excecao" ? "excecao" : atual.status,
      ajustesDisponiveis,
    );

    if (atual.status === "excecao") {
      setAviso({
        tipo: "excecao",
        titulo: "Esta opção é uma exceção.",
        texto:
          (atual.motivo ||
            "Esta combinação não é realizada normalmente.") +
          " Você pode continuar e solicitar uma análise especial da Kidmais.",
      });
      return;
    }

    if (atual.status === "consulta") {
      setAviso({
        tipo: "consulta",
        titulo: "Data sujeita à avaliação da Kidmais.",
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
    pacoteTemDescontoDiaUtil(pacote);

  return (
    <div className={styles.calendarWrap}>
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
          <i>?</i> Consultar Kidmais
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

          const turnoOperacional = periodoOperacional(data, horario);
          const semDados = !passado && !turnoOperacional;
          const info = passado
            ? {
                status: "indisponivel" as const,
                origem: "regra" as const,
                motivo: "Data passada.",
              }
            : turnoOperacional?.status === "INDISPONIVEL"
              ? {
                  status: "indisponivel" as const,
                  origem: "agenda" as const,
                  motivo: "Este período não está disponível.",
                }
              : statusDataPacote(config, pacote, data, horario);

          const selecionada =
            dataSelecionada === data;

          const desconto =
            !passado &&
            info.status !== "indisponivel"
              ? descontoEfetivo(
                  config,
                  pacote,
                  data,
                  horario
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
                semDados ? "disponibilidade não carregada" : statusLabel(info.status)
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
                  : info.motivo || statusLabel(info.status)
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
                onSelecionar("", "", []);
                onTrocarHorario(aviso.alternativa!);
                setAviso(null);
              }}
            >
              Ver{" "}
              {aviso.alternativa === "almoco"
                ? "11h às 15h"
                : "17h às 21h"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
