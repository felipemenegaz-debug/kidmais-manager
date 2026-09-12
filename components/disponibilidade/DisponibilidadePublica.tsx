"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import type {
  DisponibilidadeDataPublica,
  HorarioCandidatoPublico,
  PeriodoDisponibilidadePublica,
} from "@/lib/disponibilidade/services/models";
import styles from "./DisponibilidadePublica.module.css";

const MESES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const DIAS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

function iso(ano: number, mesZero: number, dia: number) {
  return `${ano}-${String(mesZero + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function hojeIso() {
  const hoje = new Date();
  return iso(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
}

function formatarData(dataIso: string) {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(ano, mes - 1, dia)));
}

function basePeriodo(codigo: string) {
  return codigo === "TURNO_1" ? "almoco" : "noite";
}

async function buscarDisponibilidadeMes(ano: number, mes: number) {
  const inicio = iso(ano, mes, 1);
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const fim = iso(ano, mes, ultimo);
  const resposta = await fetch(`/api/disponibilidade?inicio=${inicio}&fim=${fim}`, {
    cache: "no-store",
  });

  if (!resposta.ok) throw new Error("Falha ao consultar disponibilidade");
  const json = await resposta.json();
  return (Array.isArray(json.data) ? json.data : []) as DisponibilidadeDataPublica[];
}

export default function DisponibilidadePublica() {
  const router = useRouter();
  const agora = new Date();
  const [mes, setMes] = useState(agora.getMonth());
  const [ano, setAno] = useState(agora.getFullYear());
  const [porData, setPorData] = useState<Record<string, DisponibilidadeDataPublica>>({});
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [dataSelecionada, setDataSelecionada] = useState("");
  const [periodoCodigo, setPeriodoCodigo] = useState("");
  const [horarioSelecionado, setHorarioSelecionado] = useState<HorarioCandidatoPublico | null>(null);

  const diasMes = useMemo(() => {
    const primeiro = new Date(Date.UTC(ano, mes, 1)).getUTCDay();
    const total = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return { primeiro, total };
  }, [ano, mes]);

  useEffect(() => {
    let cancelado = false;

    void (async () => {
      try {
        const dias = await buscarDisponibilidadeMes(ano, mes);
        if (cancelado) return;
        setPorData(Object.fromEntries(dias.map((item) => [item.data, item])));
        setErro("");
      } catch {
        if (cancelado) return;
        setPorData({});
        setErro("Não foi possível consultar a disponibilidade agora. Tente novamente.");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [ano, mes]);

  function mudarMes(delta: number) {
    setCarregando(true);
    setErro("");
    const proximo = new Date(Date.UTC(ano, mes + delta, 1));
    setAno(proximo.getUTCFullYear());
    setMes(proximo.getUTCMonth());
    setDataSelecionada("");
    setPeriodoCodigo("");
    setHorarioSelecionado(null);
  }

  function selecionarData(data: string) {
    if (data < hojeIso()) return;
    setDataSelecionada(data);
    setPeriodoCodigo("");
    setHorarioSelecionado(null);
  }

  const dataInfo = dataSelecionada ? porData[dataSelecionada] : undefined;
  const periodoSelecionado = dataInfo?.periodos.find((item) => item.codigo === periodoCodigo);

  function selecionarPeriodo(periodo: PeriodoDisponibilidadePublica) {
    if (periodo.status !== "DISPONIVEL") return;
    setPeriodoCodigo(periodo.codigo);
    setHorarioSelecionado(null);
  }

  function continuar() {
    if (!dataSelecionada || !periodoSelecionado || !horarioSelecionado) return;

    const params = new URLSearchParams({
      origem: "DISPONIBILIDADE",
      data: dataSelecionada,
      periodo: basePeriodo(periodoSelecionado.codigo),
      codigoPeriodo: periodoSelecionado.codigo,
      configuracaoId: periodoSelecionado.configuracaoId,
      inicio: horarioSelecionado.inicio,
      fim: horarioSelecionado.fim,
      ajuste: String(horarioSelecionado.ajusteMinutos),
    });

    router.push(`/fechamento?${params.toString()}`);
  }

  return (
    <main className={styles.page}>
      <div className={styles.decoracaoUm} />
      <div className={styles.decoracaoDois} />

      <div className={styles.shell}>
        <header className={styles.header}>
          <KidmaisBrand context="customer" subtitle="Consulte sua data" />
          <span className={styles.publicBadge}>Consulta de disponibilidade</span>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Planeje sua comemoração</p>
          <h1>Escolha a melhor data e horário para sua festa.</h1>
          <p>
            Consulte a agenda da Kidmais em tempo real. Primeiro escolha a data,
            depois o período e o horário exato de início.
          </p>
        </section>

        <section className={styles.card}>
          <div className={styles.calendarColumn}>
            <div className={styles.calendarToolbar}>
              <button type="button" onClick={() => mudarMes(-1)} aria-label="Mês anterior">←</button>
              <strong>{MESES[mes]} de {ano}</strong>
              <div className={styles.toolbarActions}>
                <button type="button" onClick={() => {
                  setCarregando(true);
                  setErro("");
                  const hoje = new Date();
                  setAno(hoje.getFullYear());
                  setMes(hoje.getMonth());
                  setDataSelecionada("");
                  setPeriodoCodigo("");
                  setHorarioSelecionado(null);
                }} aria-label="Voltar ao mês atual">↻</button>
                <button type="button" onClick={() => mudarMes(1)} aria-label="Próximo mês">→</button>
              </div>
            </div>

            <div className={styles.legend}>
              <span><i className={styles.legendAvailable} /> Disponível</span>
              <span><i className={styles.legendPartial} /> Parcial</span>
              <span><i className={styles.legendUnavailable} /> Sem horários</span>
            </div>

            {erro ? <div className={styles.errorBox}>{erro}</div> : null}

            <div className={styles.weekHeader}>
              {DIAS.map((dia) => <span key={dia}>{dia}</span>)}
            </div>

            <div className={styles.calendarGrid} aria-busy={carregando}>
              {Array.from({ length: diasMes.primeiro }).map((_, index) => (
                <span className={styles.emptyDay} key={`empty-${index}`} />
              ))}

              {Array.from({ length: diasMes.total }, (_, index) => index + 1).map((dia) => {
                const data = iso(ano, mes, dia);
                const info = porData[data];
                const passado = data < hojeIso();
                const disponiveis = info?.periodos.filter((periodo) => periodo.status === "DISPONIVEL").length ?? 0;
                const totalPeriodos = info?.periodos.length ?? 0;
                const classeStatus = !info
                  ? styles.dayNeutral
                  : disponiveis === 0
                    ? styles.dayUnavailable
                    : disponiveis < totalPeriodos
                      ? styles.dayPartial
                      : styles.dayAvailable;

                return (
                  <button
                    key={data}
                    type="button"
                    disabled={passado || carregando || !info}
                    onClick={() => selecionarData(data)}
                    className={`${styles.day} ${classeStatus} ${passado ? styles.dayPast : ""} ${dataSelecionada === data ? styles.daySelected : ""}`}
                  >
                    <strong>{dia}</strong>
                    {!passado && info ? (
                      <small>
                        {disponiveis === 0 ? "×" : disponiveis < totalPeriodos ? "◐" : "✓"}
                      </small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <aside className={styles.selectionPanel}>
            {!dataSelecionada ? (
              <div className={styles.emptySelection}>
                <span>1</span>
                <h2>Escolha uma data</h2>
                <p>Depois você verá os períodos disponíveis para esse dia.</p>
              </div>
            ) : (
              <>
                <div className={styles.selectedDate}>
                  <span>Data selecionada</span>
                  <strong>{formatarData(dataSelecionada)}</strong>
                </div>

                <section className={styles.selectionStep}>
                  <div className={styles.stepHeading}>
                    <span>2</span>
                    <div>
                      <strong>Escolha o período</strong>
                      <small>Os períodos indisponíveis ficam bloqueados.</small>
                    </div>
                  </div>

                  <div className={styles.periodGrid}>
                    {(dataInfo?.periodos ?? []).map((periodo) => (
                      <button
                        type="button"
                        key={periodo.codigo}
                        disabled={periodo.status !== "DISPONIVEL"}
                        onClick={() => selecionarPeriodo(periodo)}
                        className={`${styles.periodCard} ${periodoCodigo === periodo.codigo ? styles.periodSelected : ""}`}
                      >
                        <span>{periodo.codigo === "TURNO_1" ? "☀" : "✦"}</span>
                        <div>
                          <strong>{periodo.nome}</strong>
                          <small>{periodo.horarioInicioPadrao}–{periodo.horarioFimPadrao}</small>
                          <b>{periodo.status === "DISPONIVEL" ? "Disponível" : "Indisponível"}</b>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>

                {periodoSelecionado ? (
                  <section className={styles.selectionStep}>
                    <div className={styles.stepHeading}>
                      <span>3</span>
                      <div>
                        <strong>Escolha o horário exato</strong>
                        <small>O horário padrão aparece no centro das opções.</small>
                      </div>
                    </div>

                    <div className={styles.timeList}>
                      {periodoSelecionado.horarios.map((horario) => {
                        const indisponivel = horario.status !== "DISPONIVEL";
                        const selecionado = horarioSelecionado?.inicio === horario.inicio && horarioSelecionado?.fim === horario.fim;
                        return (
                          <button
                            type="button"
                            key={`${horario.inicio}-${horario.fim}`}
                            disabled={indisponivel}
                            onClick={() => setHorarioSelecionado(horario)}
                            className={`${styles.timeButton} ${selecionado ? styles.timeSelected : ""}`}
                          >
                            <span>
                              <strong>{horario.inicio}–{horario.fim}</strong>
                              {horario.ajusteMinutos === 0 ? <small>Horário padrão</small> : null}
                            </span>
                            <b>{indisponivel ? "Indisponível" : selecionado ? "Selecionado" : "Escolher"}</b>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                {horarioSelecionado && periodoSelecionado ? (
                  <div className={styles.summary}>
                    <span>Seu horário</span>
                    <strong>{horarioSelecionado.inicio} às {horarioSelecionado.fim}</strong>
                    <small>{formatarData(dataSelecionada)}</small>
                  </div>
                ) : null}

                <button
                  type="button"
                  className={styles.continueButton}
                  disabled={!horarioSelecionado}
                  onClick={continuar}
                >
                  Continuar para escolher o pacote →
                </button>

                <p className={styles.reservationNote}>
                  A escolha deste horário não garante a reserva da data. A confirmação
                  acontece somente durante a contratação, após as etapas previstas pela Kidmais.
                </p>
              </>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
