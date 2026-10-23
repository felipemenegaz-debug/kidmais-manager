"use client";
import { adminFetch } from "@/lib/http/admin-fetch";

import { useEffect, useMemo, useState } from "react";
import { PACOTES } from "@/components/fechamento/data";
import { HorarioBase, PacoteId } from "@/components/fechamento/types";
import { horarioLegadoDoCodigo, rotuloPeriodo } from "@/components/fechamento/periodos";
import {
  CONFIG_VAZIA,
  DisponibilidadeConfig,
  type RegraPacoteEmpresa,
  statusDataPacote,
  statusLabel,
} from "@/lib/agenda/disponibilidade";
import {
  descontoEfetivo,
  descontoPersonalizadoDaData,
  pacoteTemDescontoDiaUtil,
} from "@/lib/comercial/descontos";
import type { BloqueioAgendaRecord } from "@/lib/disponibilidade/repositories";
import type { UnidadeAgendaGestao } from "@/lib/disponibilidade/unidades-agenda";
import type {
  DisponibilidadeDataPublica,
  PeriodoDisponibilidadePublica,
} from "@/lib/disponibilidade/services/models";
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
  dias?: DisponibilidadeDataPublica[] | null;
  agendaPorEscopo?: boolean;
  podeResolverLegado?: boolean;
  /** E2: regras e descontos do arquivo da instalação só para a empresa dona da agenda pública. */
  configuracaoComercial?: boolean;
  /** Regras dos pacotes da empresa ativa (id da tela → regras); null/ausente = dona da agenda pública (regra legada). */
  regrasPacotes?: Record<string, RegraPacoteEmpresa[]> | null;
  /** Pacotes que a empresa ativa realmente tem (empresa nova = []); null/ausente = dona da agenda pública (catálogo legado). */
  pacotes?: Array<{ id: string; nome: string }> | null;
  unidades?: Array<{ id: string; nome: string }>;
  unidadeId?: string | null;
};

export default function AdminDisponibilidade() {
  const hoje = new Date();
  const [pacote, setPacote] = useState<PacoteId>("pocket");
  // Horário configurado em foco (configuracao_agenda.id); "" = o primeiro horário da agenda carregada.
  const [configuracaoId, setConfiguracaoId] = useState("");
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
  // "dia_inteiro", "personalizado" ou o configuracaoId de um horário da data; "" = o horário em foco.
  const [escopoBloqueio, setEscopoBloqueio] = useState("");
  const [inicioBloqueio, setInicioBloqueio] = useState("15:00");
  const [fimBloqueio, setFimBloqueio] = useState("16:00");
  const [motivoBloqueio, setMotivoBloqueio] = useState("");
  const [observacoesBloqueio, setObservacoesBloqueio] = useState("");
  // Agenda por empresa/unidade (062): a unidade escolhida é o recurso consultado; "" = a única ou a empresa inteira.
  const [unidadeId, setUnidadeId] = useState("");
  const [unidades, setUnidades] = useState<Array<{ id: string; nome: string }>>([]);
  const [agendaPorEscopo, setAgendaPorEscopo] = useState(false);
  const [podeResolverLegado, setPodeResolverLegado] = useState(false);
  const [configuracaoComercial, setConfiguracaoComercial] = useState(true);
  const [regrasPacotes, setRegrasPacotes] = useState<Record<string, RegraPacoteEmpresa[]> | null>(null);
  const [pacotesEmpresa, setPacotesEmpresa] = useState<Array<{ id: string; nome: string }> | null>(null);
  // D6 (opção A): unidades da empresa e a habilitação explícita para agenda (Representante autorizado, com motivo).
  const [gestaoUnidades, setGestaoUnidades] = useState<UnidadeAgendaGestao[]>([]);
  const [motivoUnidade, setMotivoUnidade] = useState("");
  const [mensagemUnidade, setMensagemUnidade] = useState("");

  // Horários configurados que aparecem na agenda carregada (qualquer quantidade), sem repetir.
  const periodosDoMes = useMemo(() => {
    const vistos = new Map<string, PeriodoDisponibilidadePublica>();
    for (const dia of Object.values(operacionalPorData)) {
      for (const periodo of dia.periodos) {
        if (!vistos.has(periodo.configuracaoId)) vistos.set(periodo.configuracaoId, periodo);
      }
    }
    return [...vistos.values()];
  }, [operacionalPorData]);
  const idHorario = periodosDoMes.some((p) => p.configuracaoId === configuracaoId)
    ? configuracaoId
    : (periodosDoMes[0]?.configuracaoId ?? "");
  const periodoEmFoco = periodosDoMes.find((p) => p.configuracaoId === idHorario);
  // Legado almoco/noite (regras manuais e descontos por data em JSON): só TURNO_1/TURNO_2; "" nos demais horários.
  const horario: HorarioBase | "" = horarioLegadoDoCodigo(periodoEmFoco?.codigo);

  async function carregarGestaoUnidades() {
    const r = await adminFetch("/api/admin/disponibilidade/unidades", { cache: "no-store" });
    const json = await r.json().catch(() => null);
    setGestaoUnidades(r.ok && Array.isArray(json?.unidades) ? json.unidades : []);
  }

  async function decidirUnidade(acao: "habilitar" | "revogar", unidade: UnidadeAgendaGestao) {
    setMensagemUnidade("");
    if (motivoUnidade.trim().length < 5) {
      setMensagemUnidade("Informe o motivo (pelo menos 5 caracteres).");
      return;
    }
    setSalvando(true);
    try {
      const r = await adminFetch("/api/admin/disponibilidade/unidades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao, unidadeId: unidade.id, motivo: motivoUnidade.trim() }),
      });
      const json = await r.json().catch(() => null);
      if (!r.ok) {
        setMensagemUnidade(json?.erro || "Não foi possível salvar.");
        return;
      }
      setMotivoUnidade("");
      setMensagemUnidade(acao === "habilitar"
        ? `${unidade.nome} habilitada para a agenda.`
        : `${unidade.nome} revogada. ${json?.data?.reservasFuturasPreservadas ?? 0} reserva(s) futura(s) mantida(s); novas contratações e remarcações nela ficam bloqueadas.`);
      await Promise.all([carregarGestaoUnidades(), carregar()]);
    } catch {
      setMensagemUnidade("Não foi possível salvar.");
    } finally {
      setSalvando(false);
    }
  }

  async function buscarDadosMes(anoAlvo: number, mesAlvo: number, unidadeAlvo = unidadeId) {
    const inicio = iso(anoAlvo, mesAlvo, 1);
    const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo + 1, 0)).getUTCDate();
    const fim = iso(anoAlvo, mesAlvo, ultimoDia);
    const parametros = new URLSearchParams({ inicio, fim });
    if (unidadeAlvo) parametros.set("unidadeId", unidadeAlvo);

    // Agenda da empresa comprovada pela sessão (não a API pública, que não conhece o tenant).
    const adminResponse = await adminFetch(`/api/admin/disponibilidade?${parametros}`, { cache: "no-store" });
    if (!adminResponse.ok) {
      throw new Error("Falha ao carregar disponibilidade.");
    }

    const admin = (await adminResponse.json()) as AdminPayload;
    const dias: DisponibilidadeDataPublica[] = admin.dias ?? [];

    return {
      unidades: admin.unidades ?? [],
      agendaPorEscopo: admin.agendaPorEscopo === true,
      podeResolverLegado: admin.podeResolverLegado === true,
      configuracaoComercial: admin.configuracaoComercial !== false,
      regrasPacotes: admin.regrasPacotes ?? null,
      pacotes: admin.regrasPacotes ? (admin.pacotes ?? []) : null,
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
    horarioAlvo: HorarioBase | "",
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

  // Empresa que não é a dona da agenda pública vê só os pacotes que criou; se o escolhido não existe nela, vai para o primeiro.
  function aplicarPacotesEmpresa(lista: Array<{ id: string; nome: string }> | null) {
    setPacotesEmpresa(lista);
    if (lista && lista.length > 0) {
      setPacote((atual) => (lista.some((p) => p.id === atual) ? atual : (lista[0].id as PacoteId)));
    }
  }

  async function carregar() {
    setCarregando(true);
    try {
      const dados = await buscarDadosMes(ano, mes);
      setConfig(dados.config);
      setBloqueios(dados.bloqueios);
      setOperacionalPorData(dados.operacionalPorData);
      setUnidades(dados.unidades);
      setAgendaPorEscopo(dados.agendaPorEscopo);
      setPodeResolverLegado(dados.podeResolverLegado);
      setConfiguracaoComercial(dados.configuracaoComercial);
      setRegrasPacotes(dados.regrasPacotes);
      aplicarPacotesEmpresa(dados.pacotes);
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
        setUnidades(dados.unidades);
        setAgendaPorEscopo(dados.agendaPorEscopo);
        setPodeResolverLegado(dados.podeResolverLegado);
        setConfiguracaoComercial(dados.configuracaoComercial);
        setRegrasPacotes(dados.regrasPacotes);
        aplicarPacotesEmpresa(dados.pacotes);
        if (dados.agendaPorEscopo) void carregarGestaoUnidades().catch(() => setGestaoUnidades([]));
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
    // buscarDadosMes lê a unidade do estado; a dependência explícita é unidadeId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mes, ano, unidadeId]);

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
    id: string = idHorario,
  ): PeriodoDisponibilidadePublica | undefined {
    return operacionalPorData[data]?.periodos.find(
      (item) => item.configuracaoId === id,
    );
  }

  function horarioPadraoOperacional(data: string) {
    return periodoOperacional(data)?.horarios.find(
      (item) => item.ajusteMinutos === 0,
    );
  }

  function bloqueiosDoTurno(data: string) {
    const turno = periodoOperacional(data);
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
        body: JSON.stringify(unidadeId ? { ...(payload as object), unidadeId } : payload),
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

    if (escopoBloqueioEfetivo === "personalizado") {
      if (!inicioBloqueio || !fimBloqueio) {
        setMensagem("Informe o horário inicial e final do bloqueio.");
        return;
      }

      if (horaParaMinutos(fimBloqueio) <= horaParaMinutos(inicioBloqueio)) {
        setMensagem("O horário final deve ser posterior ao horário inicial.");
        return;
      }
    }

    // Um horário configurado vai como escopo "horario" + configuracaoId (qualquer código, não só TURNO_1/TURNO_2).
    const porHorario = escopoBloqueioEfetivo !== "dia_inteiro" && escopoBloqueioEfetivo !== "personalizado";
    const salvo = await enviar({
      tipo: "criar_bloqueio",
      data: selecionada,
      escopo: porHorario ? "horario" : escopoBloqueioEfetivo,
      configuracaoId: porHorario ? escopoBloqueioEfetivo : undefined,
      horarioInicio: escopoBloqueioEfetivo === "personalizado" ? inicioBloqueio : undefined,
      horarioFim: escopoBloqueioEfetivo === "personalizado" ? fimBloqueio : undefined,
      motivo: motivoLimpo,
      observacoes: observacoesBloqueio.trim() || undefined,
    });

    if (salvo) {
      setMotivoBloqueio("");
      setObservacoesBloqueio("");
    }
  }

  // Empresa ativa que não é a dona da agenda pública: as regras do pacote configuradas por ela (mesma decisão da
  // cotação em /b/<código>); dona: regra legada (null).
  const regrasDoPacote = regrasPacotes ? (regrasPacotes[pacote] ?? []) : null;
  const opcoesPacote = pacotesEmpresa ?? PACOTES;
  // Buffet novo, sem pacote criado: nada comercial para mostrar; o calendário fica só com a ocupação física.
  const semPacotes = opcoesPacote.length === 0;
  const infoComercialSelecionada = selecionada && !semPacotes
    ? statusDataPacote(config, pacote, selecionada, horario, regrasDoPacote, idHorario)
    : null;

  const turnoSelecionado = selecionada
    ? periodoOperacional(selecionada)
    : undefined;

  const horarioPadraoSelecionado = selecionada
    ? horarioPadraoOperacional(selecionada)
    : undefined;

  const bloqueiosSelecionados = selecionada
    ? bloqueiosDoTurno(selecionada)
    : [];

  const descontoSelecionado = selecionada && !semPacotes
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

  // Horários configurados da data selecionada (ou, sem data, os da agenda carregada).
  const periodosDaData = selecionada && operacionalPorData[selecionada]
    ? operacionalPorData[selecionada].periodos
    : periodosDoMes;
  const escopoBloqueioEfetivo = escopoBloqueio || idHorario || "dia_inteiro";

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <h1>Disponibilidade e regras comerciais</h1>
            <span>
              Consulte a ocupação física da agenda e gerencie, separadamente,
              as regras comerciais de cada pacote.
            </span>
          </div>
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
              value={semPacotes ? "" : pacote}
              disabled={semPacotes}
              onChange={(e) => {
                const novoPacote = e.target.value as PacoteId;
                setPacote(novoPacote);
                sincronizarDescontoFormulario(config, novoPacote, selecionada, horario);
              }}
            >
              {semPacotes
                ? <option value="">Nenhum pacote criado</option>
                : opcoesPacote.map((p) => <option value={p.id} key={p.id}>{p.nome}</option>)}
            </select>
          </label>

          <label>
            <span>Horário padrão</span>
            <select
              value={idHorario}
              disabled={periodosDaData.length === 0}
              onChange={(e) => {
                const novo = periodosDoMes.find((p) => p.configuracaoId === e.target.value);
                setConfiguracaoId(e.target.value);
                setEscopoBloqueio("");
                sincronizarDescontoFormulario(config, pacote, selecionada, horarioLegadoDoCodigo(novo?.codigo));
              }}
            >
              {periodosDaData.length === 0 && <option value="">Nenhum horário configurado</option>}
              {periodosDaData.map((p) => (
                <option value={p.configuracaoId} key={p.configuracaoId}>{rotuloPeriodo(p)}</option>
              ))}
            </select>
          </label>

          {unidades.length > 1 && (
            <label>
              <span>Unidade</span>
              <select
                value={unidadeId}
                onChange={(e) => {
                  setUnidadeId(e.target.value);
                  setSelecionada("");
                  setMensagem("");
                }}
              >
                <option value="">Todas as unidades da empresa</option>
                {unidades.map((u) => <option value={u.id} key={u.id}>{u.nome}</option>)}
              </select>
            </label>
          )}
        </section>

        {agendaPorEscopo && gestaoUnidades.length > 0 && (
          <section className={styles.blockList}>
            <h3>Unidades na agenda</h3>
            <p className={styles.helpText}>
              Só unidades habilitadas recebem contratações próprias. Revogar mantém as reservas já feitas e bloqueia novas
              contratações e remarcações na unidade. Somente o representante autorizado pode alterar.
            </p>
            <label className={styles.blockField}>
              <span>Motivo</span>
              <input value={motivoUnidade} maxLength={1000} onChange={(e) => setMotivoUnidade(e.target.value)} />
            </label>
            {gestaoUnidades.map((unidade) => (
              <div className={styles.blockItem} key={unidade.id}>
                <div>
                  <strong>{unidade.nome}</strong>
                  <span>{unidade.habilitada ? "Habilitada" : "Não habilitada"}</span>
                  {unidade.reservasFuturas > 0 && <small>{unidade.reservasFuturas} reserva(s) futura(s)</small>}
                </div>
                <button type="button" disabled={salvando} onClick={() => decidirUnidade(unidade.habilitada ? "revogar" : "habilitar", unidade)}>
                  {unidade.habilitada ? "Revogar" : "Habilitar"}
                </button>
              </div>
            ))}
            {mensagemUnidade && <small>{mensagemUnidade}</small>}
          </section>
        )}

        {semPacotes && (
          <p className={styles.helpText}>
            Nenhum pacote criado ainda. Cadastre seus pacotes em{" "}
            <a href="/admin/configuracoes/pacotes">Configurações → Pacotes</a> para ver e ajustar a disponibilidade de cada um.
            O calendário abaixo mostra só a ocupação física da agenda.
          </p>
        )}

        <div className={styles.contentActions}><a className={styles.clientView} href="/disponibilidade">Ver tela do cliente →</a></div>

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
              {!semPacotes && pacoteTemDescontoDiaUtil(pacote) && (
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
                const padrao = horarioPadraoOperacional(data);
                // Sem dados = dia não carregado; horário que não acontece neste dia aparece como indisponível.
                const semDados = !operacionalPorData[data] || !idHorario;
                const comercial = semPacotes
                  ? { status: "disponivel" as const, origem: "agenda" as const }
                  : statusDataPacote(config, pacote, data, horario, regrasDoPacote, idHorario);
                const info = !padrao
                  ? {
                      status: "indisponivel" as const,
                      origem: "agenda" as const,
                      motivo: "Este horário não acontece neste dia.",
                    }
                  : padrao.status === "INDISPONIVEL"
                    ? {
                        status: "indisponivel" as const,
                        origem: "agenda" as const,
                        motivo: "O horário padrão está fisicamente indisponível.",
                      }
                    : comercial;

                const desconto =
                  !semDados && !semPacotes && info.status !== "indisponivel"
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
                        : periodoEmFoco
                          ? `${periodoEmFoco.horarioInicioPadrao}–${periodoEmFoco.horarioFimPadrao} (não acontece neste dia)`
                          : "-"}
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
                            {agendaPorEscopo && bloqueio.alcance === "GLOBAL" && (
                              <small>Bloqueio anterior à separação da agenda por empresa. Ao liberar, ele passa a pertencer a esta empresa e fica inativo; o registro e o motivo são preservados.</small>
                            )}
                          </div>
                          {agendaPorEscopo && bloqueio.alcance === "GLOBAL" && (
                            <button type="button" disabled={salvando} onClick={() => {
                              const justificativa = window.prompt(
                                "Motivo da liberação deste horário (mínimo 5 caracteres):",
                                "Liberado pela empresa no painel da agenda.",
                              );
                              if (justificativa === null) return;
                              if (justificativa.trim().length < 5) {
                                setMensagem("Informe o motivo da liberação (mínimo 5 caracteres).");
                                return;
                              }
                              if (!window.confirm("Liberar este horário? O bloqueio antigo passa a pertencer a esta empresa e fica inativo. Reservas de contratos não são afetadas.")) return;
                              void enviar({ tipo: "desativar_bloqueio", bloqueioId: bloqueio.id, motivo: justificativa.trim() });
                            }}>Liberar horário</button>
                          )}
                          {agendaPorEscopo && bloqueio.alcance === "GLOBAL" && podeResolverLegado && (
                            <button type="button" disabled={salvando} onClick={() => {
                              const justificativa = window.prompt("Confirme que este bloqueio pertence à empresa e unidade selecionadas. Informe o motivo da atribuição e desativação (mínimo 5 caracteres):");
                              if (!justificativa) return;
                              if (!window.confirm("Atribuir este bloqueio antigo à empresa/unidade selecionadas e desativá-lo? A data poderá ficar disponível. O registro e o motivo serão preservados.")) return;
                              void enviar({ tipo: "resolver_bloqueio_legado", bloqueioId: bloqueio.id, motivo: justificativa });
                            }}>Atribuir pela plataforma</button>
                          )}
                          {!(agendaPorEscopo && bloqueio.alcance === "GLOBAL") && (
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
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <div className={`${styles.actionGroup} ${styles.physicalBlockForm}`}>
                  <h3>Criar bloqueio físico</h3>
                  <p className={styles.helpText}>
                    {agendaPorEscopo
                      ? unidadeId || unidades.length <= 1
                        ? "O bloqueio vale para esta unidade, independentemente do pacote."
                        : "Sem unidade escolhida, o bloqueio vale para todas as unidades da empresa."
                      : "O bloqueio vale para toda a agenda, independentemente do pacote."}
                    O motivo é obrigatório e fica visível apenas para a equipe.
                  </p>

                  <label className={styles.blockField}>
                    <span>Tipo de bloqueio</span>
                    <select
                      value={escopoBloqueioEfetivo}
                      onChange={(e) => setEscopoBloqueio(e.target.value)}
                    >
                      <option value="dia_inteiro">Dia inteiro</option>
                      {periodosDaData.map((p) => (
                        <option value={p.configuracaoId} key={p.configuracaoId}>{rotuloPeriodo(p)}</option>
                      ))}
                      <option value="personalizado">Intervalo personalizado</option>
                    </select>
                  </label>

                  {escopoBloqueioEfetivo === "personalizado" && (
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

                {!semPacotes && (<div className={styles.currentStatus}>
                  <span>Status comercial do pacote</span>
                  <strong>{infoComercialSelecionada ? statusLabel(infoComercialSelecionada.status, regrasDoPacote === null) : "-"}</strong>
                  <small>
                    {infoComercialSelecionada?.origem === "override"
                      ? "Definido manualmente para este pacote"
                      : regrasDoPacote
                        ? "Dias e períodos configurados no pacote"
                        : "Regra padrão do pacote"}
                  </small>
                </div>)}

                {configuracaoComercial ? (<>
                {!horario ? (
                  <p className={styles.helpText}>
                    Regras comerciais e descontos manuais por data existem só para o primeiro e o segundo
                    horário (legado). Para este horário, use os dias e horários configurados no pacote.
                  </p>
                ) : (<>
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
                </>)}

                </>) : (
                  <p className={styles.helpText}>
                    Regras comerciais e descontos por data desta agenda valem para a agenda pública da instalação
                    e não estão disponíveis para esta empresa. Os bloqueios físicos continuam funcionando.
                  </p>
                )}
                {mensagem && <p className={styles.message}>{mensagem}</p>}
              </>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
