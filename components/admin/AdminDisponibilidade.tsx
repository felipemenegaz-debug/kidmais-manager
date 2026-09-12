"use client";
import { adminFetch } from "@/lib/http/admin-fetch";

import { useEffect, useMemo, useState } from "react";
import { PACOTES } from "@/components/fechamento/data";
import { HorarioBase, PacoteId } from "@/components/fechamento/types";
import {
  CONFIG_VAZIA,
  DisponibilidadeConfig,
  statusDataPacote,
  statusLabel,
} from "@/lib/agenda/disponibilidade";
import {
  descontoEfetivo,
  descontoPersonalizadoDaData,
  pacoteTemDescontoDiaUtil,
} from "@/lib/comercial/descontos";
import type { BloqueioAgendaRecord } from "@/lib/disponibilidade/repositories";
import type {
  DisponibilidadeDataPublica,
  PeriodoDisponibilidadePublica,
} from "@/lib/disponibilidade/services/models";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import styles from "./AdminDisponibilidade.module.css";

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const DIAS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

function iso(ano: number, mesZero: number, dia: number) {
  return `${ano}-${String(mesZero + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function horaCurta(hora: string | null) {
  return hora ? hora.slice(0, 5) : "";
}

function horaParaMinutos(hora: string) {
  const [h, m] = hora.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function intervalosSobrepoem(
  inicioA: string,
  fimA: string,
  inicioB: string,
  fimB: string,
) {
  return (
    horaParaMinutos(inicioA) < horaParaMinutos(fimB) &&
    horaParaMinutos(fimA) > horaParaMinutos(inicioB)
  );
}

type AdminPayload = DisponibilidadeConfig & {
  bloqueios?: BloqueioAgendaRecord[];
};

export default function AdminDisponibilidade() {
  const hoje = new Date();
  const [pacote, setPacote] = useState<PacoteId>("pocket");
  const [horario, setHorario] = useState<HorarioBase>("almoco");
  const [mes, setMes] = useState(hoje.getMonth());
  const [ano, setAno] = useState(hoje.getFullYear());
  const [config, setConfig] = useState<DisponibilidadeConfig>(CONFIG_VAZIA);
  const [bloqueios, setBloqueios] = useState<BloqueioAgendaRecord[]>([]);
  const [operacionalPorData, setOperacionalPorData] = useState<
    Record<string, DisponibilidadeDataPublica>
  >({});
  const [carregando, setCarregando] = useState(true);
  const [selecionada, setSelecionada] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [descontoPercentual, setDescontoPercentual] = useState("");
  const [descontoTitulo, setDescontoTitulo] = useState("");
  const [escopoBloqueio, setEscopoBloqueio] = useState<
    "dia_inteiro" | "turno_1" | "turno_2" | "personalizado"
  >("turno_1");
  const [inicioBloqueio, setInicioBloqueio] = useState("15:00");
  const [fimBloqueio, setFimBloqueio] = useState("16:00");
  const [motivoBloqueio, setMotivoBloqueio] = useState("");
  const [observacoesBloqueio, setObservacoesBloqueio] = useState("");

  async function buscarDadosMes(anoAlvo: number, mesAlvo: number) {
    const inicio = iso(anoAlvo, mesAlvo, 1);
    const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo + 1, 0)).getUTCDate();
    const fim = iso(anoAlvo, mesAlvo, ultimoDia);

    const [adminResponse, operacionalResponse] = await Promise.all([
      adminFetch("/api/admin/disponibilidade", { cache: "no-store" }),
      fetch(`/api/disponibilidade?inicio=${inicio}&fim=${fim}`, {
        cache: "no-store",
      }),
    ]);

    if (!adminResponse.ok || !operacionalResponse.ok) {
      throw new Error("Falha ao carregar disponibilidade.");
    }

    const admin = (await adminResponse.json()) as AdminPayload;
    const operacional = await operacionalResponse.json();
    const dias: DisponibilidadeDataPublica[] = Array.isArray(operacional.data)
      ? operacional.data
      : [operacional.data];

    return {
      config: {
        agenda: [],
        pacoteOverrides: admin.pacoteOverrides ?? [],
        descontos: admin.descontos ?? [],
      } satisfies DisponibilidadeConfig,
      bloqueios: admin.bloqueios ?? [],
      operacionalPorData: Object.fromEntries(
        dias.map((item) => [item.data, item]),
      ) as Record<string, DisponibilidadeDataPublica>,
    };
  }

  function sincronizarDescontoFormulario(
    configAlvo: DisponibilidadeConfig,
    pacoteAlvo: PacoteId,
    dataAlvo: string,
    horarioAlvo: HorarioBase,
  ) {
    if (!dataAlvo) {
      setDescontoPercentual("");
      setDescontoTitulo("");
      return;
    }

    const manual = descontoPersonalizadoDaData(
      configAlvo,
      pacoteAlvo,
      dataAlvo,
      horarioAlvo,
    );
    setDescontoPercentual(manual ? String(manual.percentual) : "");
    setDescontoTitulo(manual?.titulo || "");
  }

  async function carregar() {
    setCarregando(true);
    try {
      const dados = await buscarDadosMes(ano, mes);
      setConfig(dados.config);
      setBloqueios(dados.bloqueios);
      setOperacionalPorData(dados.operacionalPorData);
      sincronizarDescontoFormulario(
        dados.config,
        pacote,
        selecionada,
        horario,
      );
    } catch {
      setConfig(CONFIG_VAZIA);
      setBloqueios([]);
      setOperacionalPorData({});
      setMensagem("Não foi possível carregar a disponibilidade agora.");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    let cancelado = false;

    void (async () => {
      try {
        const dados = await buscarDadosMes(ano, mes);
        if (cancelado) return;
        setConfig(dados.config);
        setBloqueios(dados.bloqueios);
        setOperacionalPorData(dados.operacionalPorData);
      } catch {
        if (cancelado) return;
        setConfig(CONFIG_VAZIA);
        setBloqueios([]);
        setOperacionalPorData({});
        setMensagem("Não foi possível carregar a disponibilidade agora.");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [mes, ano]);

  const diasMes = useMemo(() => {
    const primeiro = new Date(Date.UTC(ano, mes, 1)).getUTCDay();
    const total = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return { primeiro, total };
  }, [ano, mes]);

  function mudarMes(delta: number) {
    const d = new Date(Date.UTC(ano, mes + delta, 1));
    setAno(d.getUTCFullYear());
    setMes(d.getUTCMonth());
    setSelecionada("");
    setMensagem("");
  }

  function periodoOperacional(
    data: string,
    periodo: HorarioBase,
  ): PeriodoDisponibilidadePublica | undefined {
    const codigo = periodo === "almoco" ? "TURNO_1" : "TURNO_2";
    return operacionalPorData[data]?.periodos.find(
      (item) => item.codigo === codigo,
    );
  }

  function horarioPadraoOperacional(data: string, periodo: HorarioBase) {
    return periodoOperacional(data, periodo)?.horarios.find(
      (item) => item.ajusteMinutos === 0,
    );
  }

  function bloqueiosDoTurno(data: string, periodo: HorarioBase) {
    const turno = periodoOperacional(data, periodo);
    if (!turno) return [];

    return bloqueios.filter((bloqueio) => {
      if (bloqueio.data !== data) return false;
      if (bloqueio.diaInteiro) return true;
      if (!bloqueio.horarioInicio || !bloqueio.horarioFim) return true;

      return turno.horarios.some((candidato) =>
        intervalosSobrepoem(
          candidato.inicio,
          candidato.fim,
          bloqueio.horarioInicio!,
          bloqueio.horarioFim!,
        ),
      );
    });
  }

  async function enviar(payload: unknown): Promise<boolean> {
    if (!selecionada) return false;
    setSalvando(true);
    setMensagem("");

    try {
      const r = await adminFetch("/api/admin/disponibilidade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        const json = await r.json().catch(() => null);
        setMensagem(json?.erro || "Não foi possível salvar.");
        return false;
      }

      await carregar();
      setMensagem("Alteração salva.");
      return true;
    } catch {
      setMensagem("Não foi possível salvar.");
      return false;
    } finally {
      setSalvando(false);
    }
  }

  async function criarBloqueioFisico() {
    if (!selecionada) return;

    const motivoLimpo = motivoBloqueio.trim();
    if (!motivoLimpo) {
      setMensagem("Informe o motivo do bloqueio físico.");
      return;
    }

    if (escopoBloqueio === "personalizado") {
      if (!inicioBloqueio || !fimBloqueio) {
        setMensagem("Informe o horário inicial e final do bloqueio.");
        return;
      }

      if (horaParaMinutos(fimBloqueio) <= horaParaMinutos(inicioBloqueio)) {
        setMensagem("O horário final deve ser posterior ao horário inicial.");
        return;
      }
    }

    const salvo = await enviar({
      tipo: "criar_bloqueio",
      data: selecionada,
      escopo: escopoBloqueio,
      horarioInicio: escopoBloqueio === "personalizado" ? inicioBloqueio : undefined,
      horarioFim: escopoBloqueio === "personalizado" ? fimBloqueio : undefined,
      motivo: motivoLimpo,
      observacoes: observacoesBloqueio.trim() || undefined,
    });

    if (salvo) {
      setMotivoBloqueio("");
      setObservacoesBloqueio("");
    }
  }

  const infoComercialSelecionada = selecionada
    ? statusDataPacote(config, pacote, selecionada, horario)
    : null;

  const turnoSelecionado = selecionada
    ? periodoOperacional(selecionada, horario)
    : undefined;

  const horarioPadraoSelecionado = selecionada
    ? horarioPadraoOperacional(selecionada, horario)
    : undefined;

  const bloqueiosSelecionados = selecionada
    ? bloqueiosDoTurno(selecionada, horario)
    : [];

  const descontoSelecionado = selecionada
    ? descontoEfetivo(config, pacote, selecionada, horario)
    : null;

  const descontoManualSelecionado = selecionada
    ? descontoPersonalizadoDaData(
        config,
        pacote,
        selecionada,
        horario,
      )
    : null;

  const turno1DaData = selecionada
    ? periodoOperacional(selecionada, "almoco")
    : undefined;
  const turno2DaData = selecionada
    ? periodoOperacional(selecionada, "noite")
    : undefined;

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <KidmaisBrand compact context="manager" href="/clientes" />
            <h1>Disponibilidade e regras comerciais</h1>
            <span>
              Consulte a ocupação física da agenda e gerencie, separadamente,
              as regras comerciais de cada pacote.
            </span>
          </div>
          <a href="/disponibilidade">Ver tela do cliente →</a>
        </header>

        <div className={styles.securityNotice}>
          <strong>Configuração da agenda</strong>
          <span>
            O acesso administrativo é protegido. Bloqueios físicos usam PostgreSQL;
            regras e descontos desta tela usam o arquivo data/disponibilidade.json,
            que precisa de volume persistente e backup na implantação.
          </span>
        </div>

        <section className={styles.filters}>
          <label>
            <span>Pacote</span>
            <select
              value={pacote}
              onChange={(e) => {
                const novoPacote = e.target.value as PacoteId;
                setPacote(novoPacote);
                sincronizarDescontoFormulario(config, novoPacote, selecionada, horario);
              }}
            >
              {PACOTES.map((p) => <option value={p.id} key={p.id}>{p.nome}</option>)}
            </select>
          </label>

          <label>
            <span>Horário padrão</span>
            <select
              value={horario}
              onChange={(e) => {
                const novoHorario = e.target.value as HorarioBase;
                setHorario(novoHorario);
                sincronizarDescontoFormulario(config, pacote, selecionada, novoHorario);
              }}
            >
              <option value="almoco">11h às 15h</option>
              <option value="noite">17h às 21h</option>
            </select>
          </label>
        </section>

        <section className={styles.layout}>
          <div className={styles.calendarPanel}>
            <div className={styles.toolbar}>
              <button type="button" onClick={() => mudarMes(-1)}>←</button>
              <strong>{MESES[mes]} de {ano}</strong>
              <div className={styles.toolbarActions}>
                <button type="button" onClick={carregar} disabled={carregando}>
                  {carregando ? "…" : "↻"}
                </button>
                <button type="button" onClick={() => mudarMes(1)}>→</button>
              </div>
            </div>

            <div className={styles.legend}>
              <span className={styles.green}>✓ Disponível</span>
              <span className={styles.blue}>? Consulta</span>
              <span className={styles.purple}>! Exceção</span>
              <span className={styles.red}>× Indisponível</span>
              {pacoteTemDescontoDiaUtil(pacote) && (
                <span className={styles.orange}>-15% Dia útil</span>
              )}
            </div>

            <div className={styles.week}>
              {DIAS.map((d) => <span key={d}>{d}</span>)}
            </div>

            <div className={styles.grid}>
              {Array.from({ length: diasMes.primeiro }).map((_, i) => (
                <span key={`e-${i}`} />
              ))}
              {Array.from({ length: diasMes.total }).map((_, i) => {
                const data = iso(ano, mes, i + 1);
                const padrao = horarioPadraoOperacional(data, horario);
                const semDados = !padrao;
                const comercial = statusDataPacote(config, pacote, data, horario);
                const info = padrao?.status === "INDISPONIVEL"
                  ? {
                      status: "indisponivel" as const,
                      origem: "agenda" as const,
                      motivo: "O horário padrão está fisicamente indisponível.",
                    }
                  : comercial;

                const desconto =
                  !semDados && info.status !== "indisponivel"
                    ? descontoEfetivo(config, pacote, data, horario)
                    : {
                        ativo: false,
                        percentual: 0,
                        origem: "nenhum" as const,
                        titulo: "",
                      };

                const cls = semDados
                  ? styles.loadingDay
                  : info.status === "disponivel"
                    ? styles.available
                    : info.status === "consulta"
                      ? styles.consult
                      : info.status === "excecao"
                        ? styles.exception
                        : styles.unavailable;

                return (
                  <button
                    type="button"
                    key={data}
                    className={`${styles.day} ${cls} ${
                      selecionada === data ? styles.selected : ""
                    }`}
                    onClick={() => {
                      setSelecionada(data);
                      sincronizarDescontoFormulario(config, pacote, data, horario);
                      setMensagem("");
                    }}
                    disabled={semDados}
                  >
                    <div className={styles.dayTop}>
                      <span>{i + 1}</span>
                      {desconto.ativo && (
                        <em>-{Math.round(desconto.percentual * 100)}%</em>
                      )}
                    </div>
                    <small>
                      {semDados
                        ? "…"
                        : info.status === "disponivel"
                          ? "✓"
                          : info.status === "consulta"
                            ? "?"
                            : info.status === "excecao"
                              ? "!"
                              : "×"}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>

          <aside className={styles.editor}>
            {!selecionada ? (
              <div className={styles.empty}>
                <strong>Selecione uma data</strong>
                <p>Você verá separadamente a agenda física e a regra comercial do pacote.</p>
              </div>
            ) : (
              <>
                <p className={styles.kicker}>Data selecionada</p>
                <h2>{new Date(`${selecionada}T12:00:00`).toLocaleDateString("pt-BR")}</h2>

                <section className={styles.physicalSection}>
                  <div className={`${styles.physicalStatus} ${
                    horarioPadraoSelecionado?.status === "DISPONIVEL"
                      ? styles.physicalAvailable
                      : styles.physicalUnavailable
                  }`}>
                    <span>Disponibilidade física</span>
                    <strong>
                      {!horarioPadraoSelecionado
                        ? "Não carregada"
                        : horarioPadraoSelecionado.status === "DISPONIVEL"
                          ? "Disponível"
                          : "Indisponível"}
                    </strong>
                    <small>
                      Horário padrão: {horarioPadraoSelecionado
                        ? `${horarioPadraoSelecionado.inicio}–${horarioPadraoSelecionado.fim}`
                        : horario === "almoco" ? "11:00–15:00" : "17:00–21:00"}
                    </small>
                  </div>

                  {turnoSelecionado && (
                    <div className={styles.candidatePanel}>
                      <h3>Alternativas deste período</h3>
                      <div className={styles.candidateList}>
                        {turnoSelecionado.horarios.map((candidato) => (
                          <div
                            key={`${candidato.inicio}-${candidato.fim}`}
                            className={candidato.status === "DISPONIVEL"
                              ? styles.candidateAvailable
                              : styles.candidateUnavailable}
                          >
                            <span>{candidato.inicio}–{candidato.fim}</span>
                            <b>{candidato.status === "DISPONIVEL" ? "✓ Disponível" : "× Indisponível"}</b>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {bloqueiosSelecionados.length > 0 && (
                    <div className={styles.blockList}>
                      <h3>Bloqueios físicos que afetam este período</h3>
                      {bloqueiosSelecionados.map((bloqueio) => (
                        <div className={styles.blockItem} key={bloqueio.id}>
                          <div>
                            <strong>
                              {bloqueio.diaInteiro
                                ? "Dia inteiro"
                                : `${horaCurta(bloqueio.horarioInicio)}–${horaCurta(bloqueio.horarioFim)}`}
                            </strong>
                            <span>{bloqueio.motivo}</span>
                            {bloqueio.observacoes && <small>{bloqueio.observacoes}</small>}
                          </div>
                          <button
                            type="button"
                            disabled={salvando}
                            onClick={() => enviar({
                              tipo: "desativar_bloqueio",
                              bloqueioId: bloqueio.id,
                            })}
                          >
                            Desativar
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <div className={`${styles.actionGroup} ${styles.physicalBlockForm}`}>
                  <h3>Criar bloqueio físico</h3>
                  <p className={styles.helpText}>
                    O bloqueio vale para toda a agenda, independentemente do pacote.
                    O motivo é obrigatório e fica visível apenas para a equipe.
                  </p>

                  <label className={styles.blockField}>
                    <span>Tipo de bloqueio</span>
                    <select
                      value={escopoBloqueio}
                      onChange={(e) =>
                        setEscopoBloqueio(
                          e.target.value as
                            | "dia_inteiro"
                            | "turno_1"
                            | "turno_2"
                            | "personalizado",
                        )
                      }
                    >
                      <option value="dia_inteiro">Dia inteiro</option>
                      <option value="turno_1">
                        Primeiro período
                        {turno1DaData
                          ? ` (${turno1DaData.horarioInicioPadrao}–${turno1DaData.horarioFimPadrao})`
                          : ""}
                      </option>
                      <option value="turno_2">
                        Segundo período
                        {turno2DaData
                          ? ` (${turno2DaData.horarioInicioPadrao}–${turno2DaData.horarioFimPadrao})`
                          : ""}
                      </option>
                      <option value="personalizado">Intervalo personalizado</option>
                    </select>
                  </label>

                  {escopoBloqueio === "personalizado" && (
                    <div className={styles.blockTimeGrid}>
                      <label className={styles.blockField}>
                        <span>Início</span>
                        <input
                          type="time"
                          value={inicioBloqueio}
                          onChange={(e) => setInicioBloqueio(e.target.value)}
                        />
                      </label>
                      <label className={styles.blockField}>
                        <span>Fim</span>
                        <input
                          type="time"
                          value={fimBloqueio}
                          onChange={(e) => setFimBloqueio(e.target.value)}
                        />
                      </label>
                    </div>
                  )}

                  <label className={styles.blockField}>
                    <span>Motivo obrigatório</span>
                    <input
                      value={motivoBloqueio}
                      onChange={(e) => setMotivoBloqueio(e.target.value)}
                      maxLength={200}
                      placeholder="Ex.: manutenção, evento interno, casa indisponível"
                    />
                  </label>

                  <label className={styles.blockField}>
                    <span>Observação interna opcional</span>
                    <textarea
                      value={observacoesBloqueio}
                      onChange={(e) => setObservacoesBloqueio(e.target.value)}
                      maxLength={500}
                      rows={3}
                      placeholder="Detalhes úteis para a equipe"
                    />
                  </label>

                  <button
                    className={styles.danger}
                    disabled={salvando || !motivoBloqueio.trim()}
                    onClick={() => void criarBloqueioFisico()}
                  >
                    Criar bloqueio físico
                  </button>
                </div>

                {descontoSelecionado?.ativo && (
                  <div className={styles.discountAdminNotice}>
                    <strong>
                      {Math.round(descontoSelecionado.percentual * 100)}% de
                      desconto nesta data
                    </strong>
                    <span>
                      {descontoSelecionado.titulo}
                      {descontoSelecionado.origem === "personalizado"
                        ? " • desconto personalizado"
                        : " • regra automática de segunda a quinta"}
                    </span>
                  </div>
                )}

                <div className={styles.currentStatus}>
                  <span>Status comercial do pacote</span>
                  <strong>{infoComercialSelecionada ? statusLabel(infoComercialSelecionada.status) : "-"}</strong>
                  <small>
                    {infoComercialSelecionada?.origem === "override"
                      ? "Definido manualmente para este pacote"
                      : "Regra padrão do pacote"}
                  </small>
                </div>

                <label className={styles.motivo}>
                  <span>Observação interna opcional</span>
                  <input
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Ex.: liberar para preencher data fraca"
                  />
                </label>

                <div className={styles.actionGroup}>
                  <h3>Disponibilidade comercial do pacote</h3>
                  <p className={styles.helpText}>
                    Estas ações alteram apenas a regra comercial. Elas nunca removem
                    nem ignoram um bloqueio físico da agenda.
                  </p>
                  <button disabled={salvando} onClick={() => enviar({
                    tipo: "pacote", data: selecionada, horario, pacote, status: "liberado", motivo
                  })}>✓ Liberar para este pacote</button>
                  <button disabled={salvando} onClick={() => enviar({
                    tipo: "pacote", data: selecionada, horario, pacote, status: "consulta", motivo
                  })}>? Deixar para consulta</button>
                  <button disabled={salvando} onClick={() => enviar({
                    tipo: "pacote", data: selecionada, horario, pacote, status: "excecao", motivo
                  })}>! Marcar como exceção</button>
                  <button disabled={salvando} onClick={() => enviar({
                    tipo: "pacote", data: selecionada, horario, pacote, status: "bloqueado", motivo
                  })}>× Bloquear para este pacote</button>
                  <button className={styles.ghost} disabled={salvando} onClick={() => enviar({
                    tipo: "pacote", data: selecionada, horario, pacote, status: "padrao"
                  })}>Usar regra padrão</button>
                </div>

                <div className={styles.actionGroup}>
                  <h3>Desconto especial desta data</h3>

                  <label className={styles.discountField}>
                    <span>Percentual de desconto</span>
                    <div>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={descontoPercentual}
                        onChange={(e) => setDescontoPercentual(e.target.value)}
                        placeholder="Ex.: 10"
                      />
                      <b>%</b>
                    </div>
                  </label>

                  <label className={styles.motivo}>
                    <span>Título opcional para o cliente</span>
                    <input
                      value={descontoTitulo}
                      onChange={(e) => setDescontoTitulo(e.target.value)}
                      placeholder="Ex.: Sexta especial Kidmais"
                    />
                  </label>

                  <button
                    disabled={
                      salvando ||
                      descontoPercentual === "" ||
                      Number(descontoPercentual) < 0 ||
                      Number(descontoPercentual) > 100
                    }
                    onClick={() =>
                      enviar({
                        tipo: "desconto",
                        data: selecionada,
                        horario,
                        pacote,
                        percentual: Number(descontoPercentual),
                        titulo: descontoTitulo,
                      })
                    }
                  >
                    % Salvar desconto personalizado
                  </button>

                  {descontoManualSelecionado && (
                    <button
                      className={styles.ghost}
                      disabled={salvando}
                      onClick={() =>
                        enviar({
                          tipo: "remover_desconto",
                          data: selecionada,
                          horario,
                          pacote,
                        })
                      }
                    >
                      Remover desconto personalizado
                    </button>
                  )}

                  <p className={styles.helpText}>
                    O desconto manual substitui o desconto automático de 15%
                    naquela combinação de pacote, data e horário. Ao remover,
                    a regra automática volta a valer.
                  </p>
                </div>

                {mensagem && <p className={styles.message}>{mensagem}</p>}
              </>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
