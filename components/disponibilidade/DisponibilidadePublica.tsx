"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MarcaPublicaCabecalho, useMarcaPublica } from "@/components/fechamento/MarcaPublica";
import PacotesPdf from "@/components/fechamento/PacotesPdf";
import { apiPublica, paginaPublica } from "@/lib/fechamentos/rota-publica";
import FestaDecoracao from "@/components/fechamento/FestaDecoracao";
import { horarioLegadoDoCodigo } from "@/components/fechamento/periodos";
import { ATALHOS_CONVIDADOS, erroConvidadosEmpresa, erroConvidadosFechamento } from "@/lib/fechamentos/convidados";
import { datasProximas, doMes, estadoDoDia, fimDoMesSeguinte, linkContatoBuffet, textoCapacidade, type EstadoDia } from "./convidados-tela";
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



async function buscarDisponibilidadeMes(ano: number, mes: number, empresa: string | null, convidados: number) {
  const inicio = iso(ano, mes, 1);
  // P3-R2 (Astra): até o fim do mês SEGUINTE (no máximo 62 dias, o limite da API), só para as datas próximas sugeridas
  // quando o dia escolhido não tem encaixe; o calendário continua mostrando só o mês visível.
  const { ano: anoFim, mes: mesFim, dia: diaFim } = fimDoMesSeguinte(ano, mes);
  const fim = iso(anoFim, mesFim, diaFim);
  // S-C: com os convidados, o servidor só conta salão que comporta e diz o motivo (só contagens, nunca salões).
  const resposta = await fetch(apiPublica(`/api/disponibilidade?inicio=${inicio}&fim=${fim}&convidados=${convidados}`, empresa), {
    cache: "no-store",
  });

  const json = await resposta.json().catch(() => null);
  // Agenda pública sem contexto configurado no servidor (062): mensagem do servidor, sem horário de ninguém.
  if (!resposta.ok) throw new AgendaPublicaIndisponivel(String(json?.codigo ?? "").startsWith("AGENDA_PUBLICA_") ? String(json.erro) : null);
  return (Array.isArray(json.data) ? json.data : []) as DisponibilidadeDataPublica[];
}

class AgendaPublicaIndisponivel extends Error {
  readonly mensagem: string | null;
  constructor(mensagem: string | null) {
    super("Falha ao consultar disponibilidade");
    this.mensagem = mensagem;
  }
}

export default function DisponibilidadePublica({ empresa = null }: { empresa?: string | null } = {}) {
  const marca = useMarcaPublica();
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
  // S-C: convidados primeiro — o calendário só aparece depois do número (vale também para um salão: filtra os pacotes).
  const [convidados, setConvidados] = useState<number | null>(null);
  const [convidadosTexto, setConvidadosTexto] = useState("");
  const [erroConvidados, setErroConvidados] = useState("");
  const contatoBuffet = marca.kidmais ? null : linkContatoBuffet(marca.contato);

  const diasMes = useMemo(() => {
    const primeiro = new Date(Date.UTC(ano, mes, 1)).getUTCDay();
    const total = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return { primeiro, total };
  }, [ano, mes]);

  useEffect(() => {
    if (!convidados) return;
    let cancelado = false;

    void (async () => {
      try {
        const dias = await buscarDisponibilidadeMes(ano, mes, empresa, convidados);
        if (cancelado) return;
        setPorData(Object.fromEntries(dias.map((item) => [item.data, item])));
        setErro("");
      } catch (falha) {
        if (cancelado) return;
        setPorData({});
        setErro((falha instanceof AgendaPublicaIndisponivel && falha.mensagem) || "Não foi possível consultar a disponibilidade agora. Tente novamente.");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [ano, mes, empresa, convidados]);

  function confirmarConvidados(quantidade: number) {
    const mensagem = marca.kidmais ? erroConvidadosFechamento(quantidade) : erroConvidadosEmpresa(quantidade);
    if (mensagem) {
      setErroConvidados(mensagem);
      return;
    }
    setErroConvidados("");
    setConvidadosTexto(String(quantidade));
    if (quantidade === convidados) return;
    setCarregando(true);
    setErro("");
    setPeriodoCodigo("");
    setHorarioSelecionado(null);
    setConvidados(quantidade);
  }

  function alterarConvidados() {
    setConvidadosTexto(convidados ? String(convidados) : "");
    setConvidados(null);
    setPorData({});
    setDataSelecionada("");
    setPeriodoCodigo("");
    setHorarioSelecionado(null);
  }

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
  // S-C: dia sem encaixe — datas próximas já carregadas e o contato do buffet.
  const semEncaixe = Boolean(dataInfo && !dataInfo.periodos.some((p) => p.status === "DISPONIVEL"));
  const proximas = semEncaixe && dataSelecionada ? datasProximas(porData, dataSelecionada, hojeIso()) : [];
  const algumSemSalao = doMes(porData, ano, mes).some((d) => estadoDoDia(d) === "SEM_SALAO");
  const classeDoDia: Record<EstadoDia, string> = {
    NEUTRO: styles.dayNeutral,
    DISPONIVEL: styles.dayAvailable,
    PARCIAL: styles.dayPartial,
    INDISPONIVEL: styles.dayUnavailable,
    SEM_SALAO: styles.dayNoRoom,
  };

  function selecionarPeriodo(periodo: PeriodoDisponibilidadePublica) {
    if (periodo.status !== "DISPONIVEL") return;
    setPeriodoCodigo(periodo.codigo);
    setHorarioSelecionado(null);
  }

  async function continuar() {
    if (!dataSelecionada || !periodoSelecionado || !horarioSelecionado) return;

    const params = new URLSearchParams({
      origem: "DISPONIBILIDADE",
      ...(convidados ? { convidados: String(convidados) } : {}),
      data: dataSelecionada,
      codigoPeriodo: periodoSelecionado.codigo,
      configuracaoId: periodoSelecionado.configuracaoId,
      inicio: horarioSelecionado.inicio,
      fim: horarioSelecionado.fim,
      ajuste: String(horarioSelecionado.ajusteMinutos),
    });
    // Legado almoco/noite só existe para TURNO_1/TURNO_2; os demais horários seguem só pelo configuracaoId.
    const legado = horarioLegadoDoCodigo(periodoSelecionado.codigo);
    if (legado) params.set("periodo", legado);

    // S-D: com a etapa publicada (flag, agenda por salão, 2 ou mais salões prontos), o cliente conhece os salões antes
    // do pacote; sem ela (404 igual) ou em falha, segue direto para o fechamento, como depois da S-C.
    if (empresa && convidados) {
      const consulta = new URLSearchParams({ data: dataSelecionada, configuracaoId: periodoSelecionado.configuracaoId,
        inicio: horarioSelecionado.inicio, fim: horarioSelecionado.fim, convidados: String(convidados) });
      const temSaloes = await fetch(apiPublica(`/api/publico/saloes?${consulta}`, empresa), { cache: "no-store" })
        .then((r) => r.ok).catch(() => false);
      if (temSaloes) {
        router.push(`${paginaPublica("/saloes", empresa)}?${params.toString()}`);
        return;
      }
    }
    router.push(`${paginaPublica("/fechamento", empresa)}?${params.toString()}`);
  }

  return (
    <main className={styles.page}>
      <FestaDecoracao />

      <div className={styles.shell}>
        <header className={styles.header}>
          <MarcaPublicaCabecalho subtitle="Consulte sua data" />
          <span className={styles.publicBadge}>Consulta de disponibilidade</span>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Planeje sua comemoração</p>
          <h1>Escolha a melhor data e horário para sua festa.</h1>
          <p>
            Consulte a agenda {marca.da} em tempo real. Primeiro diga quantos convidados,
            depois escolha a data, o período e o horário exato de início.
          </p>
        </section>

        <section className={styles.guestCard} aria-labelledby="convidados-titulo">
          {convidados ? (
            <div className={styles.guestSummary}>
              <span>Convidados</span>
              <strong>{convidados} convidados pagantes</strong>
              <button type="button" onClick={alterarConvidados}>Alterar</button>
            </div>
          ) : (
            <form
              className={styles.guestForm}
              onSubmit={(evento) => { evento.preventDefault(); confirmarConvidados(Number(convidadosTexto)); }}
            >
              <div className={styles.stepHeading}>
                <span>1</span>
                <div>
                  <strong id="convidados-titulo">Quantos convidados pagantes?</strong>
                  <small>Crianças e adultos. Mostramos só as datas e os pacotes que comportam a sua festa.</small>
                </div>
              </div>
              <div className={styles.guestShortcuts}>
                {ATALHOS_CONVIDADOS.map((qtd) => (
                  <button type="button" key={qtd} onClick={() => confirmarConvidados(qtd)}>{qtd}</button>
                ))}
              </div>
              <div className={styles.guestInputRow}>
                <input
                  type="number"
                  min={1}
                  max={150}
                  inputMode="numeric"
                  placeholder="Ou digite, ex.: 75"
                  aria-label="Quantidade de convidados pagantes"
                  value={convidadosTexto}
                  onChange={(e) => { setConvidadosTexto(e.target.value); setErroConvidados(""); }}
                  aria-invalid={Boolean(erroConvidados)}
                />
                <button type="submit" className={styles.continueButton}>Ver datas →</button>
              </div>
              {erroConvidados ? (
                <div className={styles.errorBox} role="alert">
                  {erroConvidados}
                  {contatoBuffet ? <> <a href={contatoBuffet} target="_blank" rel="noreferrer">Falar com o buffet</a></> : null}
                </div>
              ) : null}
            </form>
          )}
        </section>

        {convidados ? (
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
              {algumSemSalao ? <span><i className={styles.legendNoRoom} /> Sem salão para {convidados}</span> : null}
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
                const estado = estadoDoDia(info);
                const classeStatus = classeDoDia[estado];

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
                      <small aria-label={estado === "SEM_SALAO" ? `Sem salão para ${convidados}` : undefined}>
                        {estado === "SEM_SALAO" ? "↔" : estado === "INDISPONIVEL" ? "×" : estado === "PARCIAL" ? "◐" : "✓"}
                      </small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.sideColumn}>
          <aside className={styles.selectionPanel}>
            {!dataSelecionada ? (
              <div className={styles.emptySelection}>
                <span>2</span>
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
                    <span>3</span>
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
                          {/* 2d: horário livre — o cliente escolhe a hora de início (sem faixa fixa). */}
                          <small>{periodo.codigo === "HORARIO_LIVRE" ? "Você escolhe a hora de início" : `${periodo.horarioInicioPadrao}–${periodo.horarioFimPadrao}`}</small>
                          <b>{textoCapacidade(periodo.capacidade, convidados) ?? (periodo.status === "DISPONIVEL" ? "Disponível" : "Indisponível")}</b>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>

                {semEncaixe ? (
                  <div className={styles.noFit} role="status">
                    <strong>
                      {dataInfo?.motivoDia?.motivo === "CAPACIDADE"
                        ? `Nenhum salão livre comporta ${convidados} convidados nesta data.`
                        : "Esta data não tem horários livres."}
                    </strong>
                    {proximas.length ? (
                      <>
                        <span>Datas próximas com espaço para {convidados}:</span>
                        <div className={styles.noFitDates}>
                          {proximas.map((data) => (
                            <button type="button" key={data} onClick={() => selecionarData(data)}>{formatarData(data)}</button>
                          ))}
                        </div>
                      </>
                    ) : <span>Não há datas livres até o fim do mês seguinte. Veja outros meses no calendário.</span>}
                    {contatoBuffet ? <a href={contatoBuffet} target="_blank" rel="noreferrer">Falar com o buffet</a> : null}
                  </div>
                ) : null}

                {periodoSelecionado ? (
                  <section className={styles.selectionStep}>
                    <div className={styles.stepHeading}>
                      <span>4</span>
                      <div>
                        <strong>{periodoSelecionado.codigo === "HORARIO_LIVRE" ? "Escolha a hora de início" : "Escolha o horário exato"}</strong>
                        <small>{periodoSelecionado.codigo === "HORARIO_LIVRE" ? "Aparecem só os inícios livres nesse dia." : "O horário padrão aparece no centro das opções."}</small>
                      </div>
                    </div>

                    <div className={styles.timeList}>
                      {periodoSelecionado.horarios
                        .filter((horario) => periodoSelecionado.codigo !== "HORARIO_LIVRE" || horario.status === "DISPONIVEL")
                        .map((horario) => {
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
                            <b>{indisponivel ? (horario.capacidade?.motivo === "CAPACIDADE" ? `Sem salão para ${convidados}` : "Indisponível") : selecionado ? "Selecionado" : "Escolher"}</b>
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
                  onClick={() => { void continuar(); }}
                >
                  Continuar para escolher o pacote →
                </button>

                <p className={styles.reservationNote}>
                  A escolha deste horário não garante a reserva da data. A confirmação
                  acontece somente durante a contratação, após as etapas previstas {marca.pela}.
                </p>
              </>
            )}
          </aside>
          {!empresa && <PacotesPdf />}
          </div>
        </section>
        ) : null}
      </div>
    </main>
  );
}
