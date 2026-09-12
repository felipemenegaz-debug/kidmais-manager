"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ATALHOS_CONVIDADOS } from '@/lib/fechamentos/convidados';
import { centavosComerciais, validarPretensaoPix } from "@/lib/comercial/condicao-pagamento";
import CalendarioDisponibilidade from "./CalendarioDisponibilidade";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import styles from "./FechamentoWizard.module.css";
import {
  ADICIONAIS,
  CONTATO_KIDMAIS,
  PACOTES_FECHAMENTO_V1,
  precoAdicional,
} from "./data";
import {
  calcularTotalPagamento,
  formatarMoedaDigitada,
  horarioExibicao,
  intervaloHorario,
  moedaParaNumero,
  numeroParaMoeda,
  precoReferenciaPacote,
} from "./calculos";
import {
  AjusteHorario,
  FechamentoForm,
  PacoteId,
} from "./types";
import {
  aplicarDesconto,
  descontoEfetivo,
  pacoteTemDescontoDiaUtil,
} from "@/lib/comercial/descontos";
import {
  CONFIG_VAZIA,
  DisponibilidadeConfig,
  statusDataPacote,
} from "@/lib/agenda/disponibilidade";
import { calcularIdade, cpfValido } from "@/lib/clientes/utils";

const ETAPAS = [
  "Pacote",
  "Data e horário",
  "Convidados",
  "Buffet",
  "Personalização",
  "Valor",
  "Seus dados",
  "Resumo",
  "Pagamento",
] as const;

type IdentificacaoClienteStatus =
  | "AGUARDANDO_CPF"
  | "CLIENTE_ENCONTRADO"
  | "CODIGO_ENVIADO"
  | "VERIFICADO"
  | "NOVO_CLIENTE"
  | "RECUPERACAO";

type CanalIdentidadePublico = {
  canal: "WHATSAPP" | "SMS" | "EMAIL";
  destinoMascarado: string;
};

type ClienteContextoValidado = {
  cliente: {
    nomeCompleto: string;
    cpf: string | null;
    rg: string | null;
    telefone: string | null;
    whatsapp: string | null;
    email: string | null;
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
  aniversariantes: Array<{
    id: string;
    nome: string;
    dataNascimento: string | null;
    temaPadrao: string | null;
  }>;
  cadastro: {
    completoParaContrato: boolean;
    camposFaltantes: Array<{ campo: string; label: string }>;
  };
};

const FORM_INICIAL: FechamentoForm = {
  dataFesta: "",
  horarioBase: "",
  ajusteHorario: "0",
  statusDisponibilidade: "",

  pacote: "",
  convidadosPagantes: "",

  buffetDefinicao: "depois",
  buffetSalgados: "",
  buffetBebidas: "",
  buffetDoces: "",
  buffetBolo: "",
  buffetOutros: "",
  buffetLembrancinha: "",
  buffetEmpratado: "",
  buffetBombom: "",

  adicionaisSelecionados: [],
  alteracoesPacote: "",
  observacoesCliente: "",

  valorCombinado: "",

  nomeCliente: "",
  cpf: "",
  rg: "",
  email: "",
  telefone: "",
  whatsapp: "",

  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "DF",

  outroResponsavel: "",

  nomeAniversariante: "",
  idadeAniversariante: "",
  temaFesta: "",

  formaPagamento: "",
  pixEntrada: "",
  pixParcela: "",
  pixQuantidade: "",
};

function somenteDigitos(valor: string) {
  return valor.replace(/\D/g, "");
}

function formatarCPF(valor: string) {
  return somenteDigitos(valor)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function formatarTelefone(valor: string) {
  const digitos = somenteDigitos(valor).slice(0, 11);
  if (digitos.length <= 10) {
    return digitos
      .replace(/(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }
  return digitos
    .replace(/(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2");
}

function formatarCEP(valor: string) {
  return somenteDigitos(valor)
    .slice(0, 8)
    .replace(/(\d{5})(\d)/, "$1-$2");
}

function clienteParaForm(clienteDetalhe: ClienteContextoValidado) {
  const { cliente } = clienteDetalhe;
  return {
    nomeCliente: cliente.nomeCompleto,
    cpf: formatarCPF(cliente.cpf ?? ""),
    rg: cliente.rg ?? "",
    email: cliente.email ?? "",
    telefone: formatarTelefone(cliente.telefone ?? ""),
    whatsapp: formatarTelefone(cliente.whatsapp ?? ""),
    cep: formatarCEP(cliente.cep ?? ""),
    logradouro: cliente.logradouro ?? "",
    numero: cliente.numero ?? "",
    complemento: cliente.complemento ?? "",
    bairro: cliente.bairro ?? "",
    cidade: cliente.cidade ?? "",
    uf: cliente.uf ?? "DF",
    outroResponsavel: "",
  };
}

async function lerErroApi(resposta: Response, fallback: string) {
  const body = await resposta.json().catch(() => null);
  return body?.erro || fallback;
}


export default function FechamentoWizard() {
  const router = useRouter();
  const [etapa, setEtapa] = useState(0);
  const [form, setForm] = useState<FechamentoForm>(FORM_INICIAL);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [concluido, setConcluido] = useState(false);
  const [configDisponibilidade, setConfigDisponibilidade] =
    useState<DisponibilidadeConfig>(CONFIG_VAZIA);
  const [ajustesDisponiveis, setAjustesDisponiveis] =
    useState<AjusteHorario[]>([]);
  const [origemInterna, setOrigemInterna] = useState(false);
  const [preselecaoDisponibilidade, setPreselecaoDisponibilidade] = useState(false);
  const [entradaResolvida, setEntradaResolvida] = useState(false);
  const [entradaPublicaInvalida, setEntradaPublicaInvalida] = useState(false);
  const [validandoDisponibilidade, setValidandoDisponibilidade] = useState(false);
  const [identificacaoStatus, setIdentificacaoStatus] =
    useState<IdentificacaoClienteStatus>("AGUARDANDO_CPF");
  const [cpfIdentificacao, setCpfIdentificacao] = useState("");
  const [clienteEncontrado, setClienteEncontrado] =
    useState<ClienteContextoValidado | null>(null);
  const [canaisIdentidade, setCanaisIdentidade] =
    useState<CanalIdentidadePublico[]>([]);
  const [canalSelecionado, setCanalSelecionado] =
    useState<CanalIdentidadePublico["canal"] | "">("");
  const [validacaoId, setValidacaoId] = useState<string | null>(null);
  const [provaIdentidade, setProvaIdentidade] = useState<string | null>(null);
  const [codigoValidacao, setCodigoValidacao] = useState("");
  const [erroIdentificacao, setErroIdentificacao] = useState("");
  const [processandoIdentidade, setProcessandoIdentidade] = useState(false);
  const [aniversarianteSelecionadoId, setAniversarianteSelecionadoId] = useState("");
  const [solicitarAtualizacaoCadastro, setSolicitarAtualizacaoCadastro] =
    useState<boolean | null>(null);
  const [recuperacaoCadastralPendente, setRecuperacaoCadastralPendente] = useState(false);
  const [consultandoCep, setConsultandoCep] = useState(false);
  const [erroCep, setErroCep] = useState("");
  const cepConsultaSeq = useRef(0);

  const pacote = PACOTES_FECHAMENTO_V1.find((item) => item.id === form.pacote);
  const convidados = Number(form.convidadosPagantes || 0);

  const dadosCadastraisAlterados = useMemo(() => {
    if (!clienteEncontrado || identificacaoStatus !== "VERIFICADO") return false;
    const base = clienteParaForm(clienteEncontrado);
    return (
      form.nomeCliente.trim() !== base.nomeCliente.trim() ||
      somenteDigitos(form.cpf) !== somenteDigitos(base.cpf) ||
      form.rg.trim() !== base.rg.trim() ||
      form.email.trim().toLowerCase() !== base.email.trim().toLowerCase() ||
      somenteDigitos(form.telefone) !== somenteDigitos(base.telefone) ||
      somenteDigitos(form.whatsapp) !== somenteDigitos(base.whatsapp) ||
      somenteDigitos(form.cep) !== somenteDigitos(base.cep) ||
      form.logradouro.trim() !== base.logradouro.trim() ||
      form.numero.trim() !== base.numero.trim() ||
      form.complemento.trim() !== base.complemento.trim() ||
      form.bairro.trim() !== base.bairro.trim() ||
      form.cidade.trim() !== base.cidade.trim() ||
      form.uf.trim().toUpperCase() !== base.uf.trim().toUpperCase()
    );
  }, [clienteEncontrado, form, identificacaoStatus]);

  useEffect(() => {
    let cancelado = false;

    void (async () => {
      await Promise.resolve();
      if (cancelado) return;

      const params = new URLSearchParams(window.location.search);
      const interna =
        params.get("contexto") === "ADMIN" ||
        params.get("origem") === "ATENDIMENTO_KIDMAIS";
      setOrigemInterna(interna);

      const origemDisponibilidade = params.get("origem") === "DISPONIBILIDADE";
      const dataPreselecionada = params.get("data") ?? "";
      const periodoParam = params.get("periodo");
      const ajusteParam = params.get("ajuste");
      const inicioParam = params.get("inicio");
      const fimParam = params.get("fim");
      const horarioBasePreselecionado =
        periodoParam === "almoco" || periodoParam === "noite"
          ? periodoParam
          : null;
      const ajustePreselecionado =
        ajusteParam === "-30" || ajusteParam === "0" || ajusteParam === "30"
          ? ajusteParam
          : null;
      const parametrosDisponibilidadeValidos =
        /^\d{4}-\d{2}-\d{2}$/.test(dataPreselecionada) &&
        Boolean(horarioBasePreselecionado) &&
        Boolean(ajustePreselecionado) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(inicioParam ?? "") &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(fimParam ?? "");

      // O fluxo público oficial sempre começa em Disponibilidade.
      if (!interna && !origemDisponibilidade) {
        router.replace("/disponibilidade");
        return;
      }

      if (origemDisponibilidade && !parametrosDisponibilidadeValidos) {
        router.replace("/disponibilidade");
        return;
      }

      if (
        origemDisponibilidade &&
        horarioBasePreselecionado &&
        ajustePreselecionado &&
        inicioParam &&
        fimParam
      ) {
        try {
          const resposta = await fetch(
            `/api/disponibilidade?data=${encodeURIComponent(dataPreselecionada)}`,
            { cache: "no-store" },
          );
          if (!resposta.ok) throw new Error();
          const json = await resposta.json();
          const codigo = horarioBasePreselecionado === "almoco" ? "TURNO_1" : "TURNO_2";
          const periodo = json.data?.periodos?.find(
            (item: { codigo?: string }) => item.codigo === codigo,
          );
          const candidato = periodo?.horarios?.find(
            (item: { inicio?: string; fim?: string; ajusteMinutos?: number; status?: string }) =>
              item.ajusteMinutos === Number(ajustePreselecionado) &&
              item.inicio === inicioParam &&
              item.fim === fimParam,
          );

          if (cancelado) return;

          if (!candidato || candidato.status !== "DISPONIVEL") {
            setErro(
              "O horário escolhido não está mais disponível. Volte à disponibilidade e escolha uma nova opção.",
            );
            setEntradaPublicaInvalida(true);
            setEntradaResolvida(true);
            return;
          }

          const ajustes = (periodo.horarios ?? [])
            .filter((item: { status?: string }) => item.status === "DISPONIVEL")
            .map((item: { ajusteMinutos?: number }) => String(item.ajusteMinutos))
            .filter((item: string): item is AjusteHorario =>
              item === "-30" || item === "0" || item === "30",
            );

          setConfigDisponibilidade({
            agenda: [],
            pacoteOverrides: json.comercial?.pacoteOverrides ?? [],
            descontos: json.comercial?.descontos ?? [],
          });
          setAjustesDisponiveis(ajustes);
          setForm((anterior) => ({
            ...anterior,
            dataFesta: dataPreselecionada,
            horarioBase: horarioBasePreselecionado,
            ajusteHorario: ajustePreselecionado,
            statusDisponibilidade: "disponivel",
          }));
          setPreselecaoDisponibilidade(true);
        } catch {
          if (!cancelado) {
            setErro(
              "Não foi possível revalidar o horário escolhido. Volte à disponibilidade e tente novamente.",
            );
            setEntradaPublicaInvalida(true);
            setEntradaResolvida(true);
          }
          return;
        }
      }

      if (!interna || cancelado) {
        if (!cancelado) setEntradaResolvida(true);
        return;
      }

      // O fluxo interno não pode confiar em query string para cliente/origem.
      // Ele será ativado quando houver sessão/permissão autenticada da equipe.
      setErro(
        "O Fechamento iniciado pelo CRM interno aguarda a camada de autenticação da equipe. Use o fluxo público para testes por enquanto.",
      );
      setEntradaResolvida(true);
    })();

    return () => {
      cancelado = true;
    };
  }, [router]);

  const horario = useMemo(
    () => horarioExibicao(form.horarioBase, form.ajusteHorario),
    [form.horarioBase, form.ajusteHorario]
  );

  const intervaloSelecionado = useMemo(
    () => intervaloHorario(form.horarioBase, form.ajusteHorario),
    [form.horarioBase, form.ajusteHorario],
  );

  const indicesEtapasVisiveis = preselecaoDisponibilidade
    ? [0, 2, 3, 4, 5, 6, 7, 8]
    : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const etapasVisiveis = indicesEtapasVisiveis.map((indice) => ETAPAS[indice]);
  const etapaVisualAtual = Math.max(0, indicesEtapasVisiveis.indexOf(etapa));
  const numeroEtapaVisivel = (indiceReal: number) =>
    String(Math.max(0, indicesEtapasVisiveis.indexOf(indiceReal)) + 1);

  const referenciaTabela = useMemo(
    () =>
      precoReferenciaPacote(
        form.pacote,
        convidados,
        form.dataFesta,
        form.horarioBase,
      ),
    [form.pacote, convidados, form.dataFesta, form.horarioBase],
  );

  const adicionaisValor = useMemo(
    () =>
      form.adicionaisSelecionados.reduce((total, id) => {
        const adicional = ADICIONAIS.find((item) => item.id === id);
        return total + (adicional ? precoAdicional(adicional, convidados || 1) : 0);
      }, 0),
    [form.adicionaisSelecionados, convidados]
  );

  const descontoAtual = descontoEfetivo(
    configDisponibilidade,
    form.pacote,
    form.dataFesta,
    form.horarioBase
  );

  const calculoDesconto =
    referenciaTabela != null
      ? aplicarDesconto(
          referenciaTabela,
          descontoAtual.percentual
        )
      : {
          percentual: 0,
          valorDesconto: 0,
          valorPacoteComDesconto: 0,
        };

  const valorPacoteConsiderado =
    referenciaTabela != null
      ? calculoDesconto.valorPacoteComDesconto
      : null;

  const totalCalculado =
    valorPacoteConsiderado != null
      ? valorPacoteConsiderado + adicionaisValor
      : null;

  const precoInicialComDesconto =
    pacote && descontoAtual.ativo
      ? aplicarDesconto(
          pacote.precoInicial,
          descontoAtual.percentual
        )
      : null;

  const valorInformado = moedaParaNumero(form.valorCombinado);

  function atualizar<K extends keyof FechamentoForm>(
    campo: K,
    valor: FechamentoForm[K]
  ) {
    setForm((anterior) => ({ ...anterior, [campo]: valor }));
    setErro("");
  }

  async function buscarEnderecoPorCep(cepInformado: string, sequencia: number) {
    const cep = somenteDigitos(cepInformado);
    if (cep.length !== 8) return;

    setConsultandoCep(true);
    setErroCep("");

    try {
      const resposta = await fetch("/api/endereco/consultar-cep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cep }),
      });

      if (!resposta.ok) {
        throw new Error(
          await lerErroApi(
            resposta,
            "Não foi possível localizar esse CEP. Preencha o endereço manualmente.",
          ),
        );
      }

      const json = await resposta.json();
      if (sequencia !== cepConsultaSeq.current) return;

      setForm((anterior) => ({
        ...anterior,
        cep: formatarCEP(json.cep ?? cep),
        logradouro: json.logradouro ?? "",
        bairro: json.bairro ?? "",
        cidade: json.cidade ?? "",
        uf: String(json.uf ?? "").toUpperCase(),
      }));
      setErroCep("");
      setErro("");
    } catch (error) {
      if (sequencia !== cepConsultaSeq.current) return;
      setErroCep(
        error instanceof Error
          ? error.message
          : "Não foi possível localizar esse CEP. Preencha o endereço manualmente.",
      );
    } finally {
      if (sequencia === cepConsultaSeq.current) {
        setConsultandoCep(false);
      }
    }
  }

  function atualizarCep(valor: string) {
    const cepFormatado = formatarCEP(valor);
    const cep = somenteDigitos(cepFormatado);
    const sequencia = ++cepConsultaSeq.current;

    setForm((anterior) => ({ ...anterior, cep: cepFormatado }));
    setErro("");
    setErroCep("");
    setConsultandoCep(false);

    if (cep.length === 8) {
      void buscarEnderecoPorCep(cep, sequencia);
    }
  }

  async function buscarClientePorCpf() {
    const cpf = somenteDigitos(cpfIdentificacao);
    setErroIdentificacao("");

    if (cpf.length !== 11 || !cpfValido(cpf)) {
      setErroIdentificacao("Informe um CPF válido para continuar.");
      return;
    }

    setProcessandoIdentidade(true);
    try {
      const resposta = await fetch("/api/identidade/consultar-cpf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpf }),
      });

      if (!resposta.ok) {
        throw new Error(
          await lerErroApi(resposta, "Não foi possível consultar o CPF agora."),
        );
      }

      const json = await resposta.json();
      setClienteEncontrado(null);
      setProvaIdentidade(null);
      setValidacaoId(null);
      setCodigoValidacao("");
      setAniversarianteSelecionadoId("");
      setSolicitarAtualizacaoCadastro(null);
      setRecuperacaoCadastralPendente(false);
      setForm((anterior) => ({ ...anterior, cpf: formatarCPF(cpf) }));

      if (json.situacao === "NOVO_CLIENTE") {
        setCanaisIdentidade([]);
        setCanalSelecionado("");
        setIdentificacaoStatus("NOVO_CLIENTE");
        return;
      }

      const canais = (json.canais ?? []) as CanalIdentidadePublico[];
      setCanaisIdentidade(canais);
      setCanalSelecionado(canais[0]?.canal ?? "");
      setIdentificacaoStatus("CLIENTE_ENCONTRADO");
    } catch (error) {
      setErroIdentificacao(
        error instanceof Error
          ? error.message
          : "Não foi possível consultar o CPF agora.",
      );
    } finally {
      setProcessandoIdentidade(false);
    }
  }

  async function enviarCodigoValidacao() {
    const cpf = somenteDigitos(cpfIdentificacao);
    const canal = canalSelecionado || canaisIdentidade[0]?.canal;
    if (!canal) {
      setErroIdentificacao(
        "Este cadastro não possui um contato disponível para validação.",
      );
      return;
    }

    setProcessandoIdentidade(true);
    setCodigoValidacao("");
    setErroIdentificacao("");

    try {
      const resposta = await fetch("/api/identidade/iniciar-desafio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpf, canal }),
      });
      if (!resposta.ok) {
        throw new Error(
          await lerErroApi(resposta, "Não foi possível enviar o código agora."),
        );
      }

      const json = await resposta.json();
      setValidacaoId(json.validacaoId);
      setCanalSelecionado(json.canal);
      setCanaisIdentidade((atuais) =>
        atuais.map((item) =>
          item.canal === json.canal
            ? { ...item, destinoMascarado: json.destinoMascarado }
            : item,
        ),
      );
      setIdentificacaoStatus("CODIGO_ENVIADO");
    } catch (error) {
      setErroIdentificacao(
        error instanceof Error ? error.message : "Não foi possível enviar o código agora.",
      );
    } finally {
      setProcessandoIdentidade(false);
    }
  }

  async function confirmarCodigoValidacao() {
    if (!validacaoId || somenteDigitos(codigoValidacao).length !== 6) {
      setErroIdentificacao("Informe o código de 6 dígitos.");
      return;
    }

    setProcessandoIdentidade(true);
    setErroIdentificacao("");

    try {
      const confirmacao = await fetch("/api/identidade/confirmar-codigo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validacaoId,
          codigo: somenteDigitos(codigoValidacao),
        }),
      });
      if (!confirmacao.ok) {
        throw new Error(
          await lerErroApi(confirmacao, "Código inválido ou expirado."),
        );
      }

      const prova = await confirmacao.json();
      const contextoResposta = await fetch("/api/identidade/contexto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provaToken: prova.provaToken }),
      });
      if (!contextoResposta.ok) {
        throw new Error(
          await lerErroApi(
            contextoResposta,
            "A identidade foi confirmada, mas não foi possível carregar o cadastro.",
          ),
        );
      }

      const contextoJson = await contextoResposta.json();
      const contexto: ClienteContextoValidado = {
        cliente: contextoJson.cliente,
        aniversariantes: contextoJson.aniversariantes ?? [],
        cadastro: contextoJson.cadastro,
      };

      setProvaIdentidade(prova.provaToken);
      setClienteEncontrado(contexto);
      setForm((anterior) => ({ ...anterior, ...clienteParaForm(contexto) }));
      setIdentificacaoStatus("VERIFICADO");
      setRecuperacaoCadastralPendente(false);
      setSolicitarAtualizacaoCadastro(null);
      setAniversarianteSelecionadoId("");
      setErroIdentificacao("");
    } catch (error) {
      setErroIdentificacao(
        error instanceof Error ? error.message : "Não foi possível confirmar o código.",
      );
    } finally {
      setProcessandoIdentidade(false);
    }
  }

  async function iniciarRecuperacaoCadastral() {
    const cpf = somenteDigitos(cpfIdentificacao);
    setProcessandoIdentidade(true);
    setErroIdentificacao("");

    try {
      const resposta = await fetch("/api/identidade/solicitar-recuperacao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpf }),
      });
      if (!resposta.ok) {
        throw new Error(
          await lerErroApi(
            resposta,
            "Não foi possível registrar a validação cadastral pendente.",
          ),
        );
      }

      setClienteEncontrado(null);
      setProvaIdentidade(null);
      setIdentificacaoStatus("RECUPERACAO");
      setRecuperacaoCadastralPendente(true);
      setErroIdentificacao("");
    } catch (error) {
      setErroIdentificacao(
        error instanceof Error
          ? error.message
          : "Não foi possível registrar a validação cadastral pendente.",
      );
    } finally {
      setProcessandoIdentidade(false);
    }
  }

  function selecionarAniversariante(id: string) {
    setAniversarianteSelecionadoId(id);
    if (id === "NOVO") {
      setForm((anterior) => ({
        ...anterior,
        nomeAniversariante: "",
        idadeAniversariante: "",
        temaFesta: "",
      }));
      return;
    }

    const aniversariante = clienteEncontrado?.aniversariantes.find(
      (item) => item.id === id,
    );
    if (!aniversariante) return;

    const referencia = form.dataFesta
      ? new Date(`${form.dataFesta}T12:00:00`)
      : new Date();

    setForm((anterior) => ({
      ...anterior,
      nomeAniversariante: aniversariante.nome,
      idadeAniversariante: aniversariante.dataNascimento
        ? calcularIdade(aniversariante.dataNascimento, referencia)
        : "",
      temaFesta: aniversariante.temaPadrao ?? "",
    }));
  }

  function alternarAdicional(id: string) {
    setForm((anterior) => ({
      ...anterior,
      adicionaisSelecionados: anterior.adicionaisSelecionados.includes(id)
        ? anterior.adicionaisSelecionados.filter((item) => item !== id)
        : [...anterior.adicionaisSelecionados, id],
    }));
  }

  async function revalidarHorarioAtual() {
    if (!form.dataFesta || !form.horarioBase || !intervaloSelecionado) {
      setErro("Escolha uma data e um horário válidos para continuar.");
      return false;
    }

    setValidandoDisponibilidade(true);
    try {
      const resposta = await fetch(
        `/api/disponibilidade?data=${encodeURIComponent(form.dataFesta)}`,
        { cache: "no-store" },
      );
      if (!resposta.ok) throw new Error();

      const json = await resposta.json();
      const codigo = form.horarioBase === "almoco" ? "TURNO_1" : "TURNO_2";
      const periodo = json.data?.periodos?.find(
        (item: { codigo?: string }) => item.codigo === codigo,
      );
      const candidato = periodo?.horarios?.find(
        (item: { inicio?: string; fim?: string; ajusteMinutos?: number; status?: string }) =>
          item.inicio === intervaloSelecionado.inicio &&
          item.fim === intervaloSelecionado.fim &&
          item.ajusteMinutos === Number(form.ajusteHorario),
      );

      if (!candidato || candidato.status !== "DISPONIVEL") {
        setErro(
          "Este horário não está mais disponível. Volte à disponibilidade e escolha uma nova opção.",
        );
        return false;
      }

      const ajustes = (periodo.horarios ?? [])
        .filter((item: { status?: string }) => item.status === "DISPONIVEL")
        .map((item: { ajusteMinutos?: number }) => String(item.ajusteMinutos))
        .filter((item: string): item is AjusteHorario =>
          item === "-30" || item === "0" || item === "30",
        );
      setAjustesDisponiveis(ajustes);
      setConfigDisponibilidade({
        agenda: [],
        pacoteOverrides: json.comercial?.pacoteOverrides ?? [],
        descontos: json.comercial?.descontos ?? [],
      });
      return true;
    } catch {
      setErro(
        "Não foi possível revalidar a disponibilidade agora. Tente novamente.",
      );
      return false;
    } finally {
      setValidandoDisponibilidade(false);
    }
  }

  function validarEtapaAtual() {
    if (etapa === 0 && !form.pacote) {
      setErro("Escolha um pacote para continuar.");
      return false;
    }

    if (
      etapa === 0 &&
      preselecaoDisponibilidade &&
      form.pacote &&
      form.dataFesta &&
      form.horarioBase
    ) {
      const comercial = statusDataPacote(
        configDisponibilidade,
        form.pacote,
        form.dataFesta,
        form.horarioBase,
      );
      if (comercial.status === "indisponivel") {
        setErro(
          comercial.motivo ||
            "Este pacote não está disponível para a data e período escolhidos.",
        );
        return false;
      }
    }

    if (
      etapa === 1 &&
      (!form.dataFesta || !form.horarioBase || !form.statusDisponibilidade)
    ) {
      setErro("Escolha o horário e uma data no calendário.");
      return false;
    }

    if (etapa === 2) {
      if (!form.convidadosPagantes) {
        setErro("Informe a quantidade de convidados pagantes.");
        return false;
      }
      if (convidados > 150) {
        setErro("A Kidmais atende no máximo 150 convidados neste fechamento.");
        return false;
      }
      if (pacote && convidados > pacote.maxPagantes) {
        setErro(
          `${pacote.nome} atende até ${pacote.maxPagantes} convidados neste pacote.`
        );
        return false;
      }
      if (pacote && convidados < pacote.minPagantes) {
        setErro(
          `${pacote.nome} possui mínimo de ${pacote.minPagantes} pagantes.`
        );
        return false;
      }
    }

    if (etapa === 5) {
      try { centavosComerciais(valorInformado); }
      catch {
        setErro("Informe um valor combinado válido, dentro do limite monetário e com precisão de centavos.");
        return false;
      }
    }

    if (etapa === 6) {
      if (origemInterna) {
        setErro(
          "O fluxo interno será liberado quando a autenticação da equipe estiver pronta. Não é seguro confiar em IDs enviados pelo navegador.",
        );
        return false;
      }

      if (identificacaoStatus === "RECUPERACAO") {
        setErro(
          "A validação cadastral ficou pendente. A equipe Kidmais precisa confirmar sua identidade antes de continuar online.",
        );
        return false;
      }

      if (!["VERIFICADO", "NOVO_CLIENTE"].includes(identificacaoStatus)) {
        setErro("Identifique o contratante para continuar.");
        return false;
      }

      const temContato =
        somenteDigitos(form.whatsapp).length >= 10 ||
        somenteDigitos(form.telefone).length >= 10;

      if (
        !form.nomeCliente ||
        somenteDigitos(form.cpf).length !== 11 ||
        !cpfValido(form.cpf) ||
        !form.email ||
        !temContato ||
        somenteDigitos(form.cep).length !== 8 ||
        !form.logradouro ||
        !form.numero ||
        !form.bairro ||
        !form.cidade ||
        form.uf.length !== 2 ||
        !form.nomeAniversariante
      ) {
        setErro("Preencha os dados obrigatórios para o fechamento.");
        return false;
      }

      if (identificacaoStatus === "VERIFICADO" && !provaIdentidade) {
        setErro("Sua validação de identidade expirou. Confirme o CPF novamente.");
        return false;
      }

      if (dadosCadastraisAlterados && solicitarAtualizacaoCadastro === null) {
        setErro("Escolha se deseja atualizar o cadastro da Kidmais com os dados revisados.");
        return false;
      }
    }

    if (etapa === 8 && !form.formaPagamento) {
      setErro("Escolha a preferência de pagamento.");
      return false;
    }
    if (etapa === 8 && form.formaPagamento === "pix_parcelado") {
      try {
        validarPretensaoPix({ entrada: form.pixEntrada ? form.pixEntrada.replace(",", ".") : null,
          valorParcela: form.pixParcela ? form.pixParcela.replace(",", ".") : null,
          quantidadeParcelas: form.pixQuantidade ? Number(form.pixQuantidade) : null });
      } catch (error) {
        setErro(error instanceof Error ? error.message : "Confira a condição pretendida.");
        return false;
      }
    }

    return true;
  }

  async function continuar() {
    if (!validarEtapaAtual()) return;

    if (etapa === 0 && preselecaoDisponibilidade) {
      const aindaDisponivel = await revalidarHorarioAtual();
      if (!aindaDisponivel) return;
      setEtapa(2);
    } else {
      setEtapa((atual) => Math.min(atual + 1, ETAPAS.length - 1));
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function voltar() {
    setErro("");
    setEtapa((atual) =>
      preselecaoDisponibilidade && atual === 2 ? 0 : Math.max(atual - 1, 0),
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function finalizar(event: FormEvent) {
    event.preventDefault();
    if (!validarEtapaAtual()) return;

    const aindaDisponivel = await revalidarHorarioAtual();
    if (!aindaDisponivel || !intervaloSelecionado || !form.horarioBase) return;

    setEnviando(true);
    setErro("");

    try {
      const resposta = await fetch("/api/fechamentos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identidadeTipo:
            identificacaoStatus === "VERIFICADO"
              ? "CLIENTE_EXISTENTE"
              : "NOVO_CLIENTE",
          provaIdentidade:
            identificacaoStatus === "VERIFICADO" ? provaIdentidade : null,
          solicitarAtualizacaoCadastro:
            identificacaoStatus === "VERIFICADO" && dadosCadastraisAlterados
              ? Boolean(solicitarAtualizacaoCadastro)
              : false,
          aniversarianteIdExistente:
            identificacaoStatus === "VERIFICADO" &&
            aniversarianteSelecionadoId &&
            aniversarianteSelecionadoId !== "NOVO"
              ? aniversarianteSelecionadoId
              : null,
          ...form,
          condicaoPixPretendida: form.formaPagamento === "pix_parcelado" ? {
            entrada: form.pixEntrada ? form.pixEntrada.replace(",", ".") : null,
            valorParcela: form.pixParcela ? form.pixParcela.replace(",", ".") : null,
            quantidadeParcelas: form.pixQuantidade ? Number(form.pixQuantidade) : null,
          } : null,
          horarioInicio: intervaloSelecionado.inicio,
          horarioFim: intervaloSelecionado.fim,
          horarioExibicao: horario,
          referenciaTabela,
          descontoDiaUtilAtivo:
            descontoAtual.origem === "dia_util",
          percentualDescontoDiaUtil:
            descontoAtual.percentual,
          valorDescontoDiaUtil:
            calculoDesconto.valorDesconto,
          origemDesconto:
            descontoAtual.origem,
          tituloDesconto:
            descontoAtual.titulo,
          valorPacoteConsiderado,
          adicionaisValor,
          totalCalculado,
          valorInformado,
          status: "AGUARDANDO_APROVACAO",
        }),
      });

      if (!resposta.ok) {
        const falha = await resposta.json().catch(() => null);
        throw new Error(
          falha?.erro || "Não foi possível enviar o fechamento para conferência.",
        );
      }
      setConcluido(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível enviar agora. Seus dados continuam nesta tela; tente novamente.",
      );
    } finally {
      setEnviando(false);
    }
  }

  if (!entradaResolvida) {
    return (
      <main className={styles.page}>
        <section className={styles.successCard}>
          <p className={styles.eyebrow}>Validando disponibilidade</p>
          <h1>Confirmando sua data e horário.</h1>
          <p className={styles.successText}>
            Aguarde um instante enquanto conferimos a agenda da Kidmais.
          </p>
        </section>
      </main>
    );
  }

  if (entradaPublicaInvalida && !origemInterna) {
    return (
      <main className={styles.page}>
        <section className={styles.successCard}>
          <p className={styles.eyebrow}>Disponibilidade alterada</p>
          <h1>Precisamos escolher outro horário.</h1>
          <p className={styles.successText}>
            {erro || "O horário selecionado não está mais disponível."}
          </p>
          <a className={styles.primaryButton} href="/disponibilidade">
            Voltar para disponibilidade
          </a>
        </section>
      </main>
    );
  }

  if (concluido) {
    return (
      <main className={styles.page}>
        <section className={styles.successCard}>
          <div className={styles.successIcon}>✓</div>
          <p className={styles.eyebrow}>Solicitação recebida</p>
          <h1>Agora a Kidmais confere os últimos detalhes.</h1>
          <p className={styles.successText}>
            A equipe vai revalidar a disponibilidade da agenda, o pacote,
            adicionais e o valor informado. Depois da aprovação, o contrato
            será disponibilizado para aceite e o pagamento poderá ser liberado.
          </p>

          <div className={styles.successSummary}>
            <div>
              <span>Pacote</span>
              <strong>{pacote?.nome}</strong>
            </div>
            <div>
              <span>Convidados pagantes</span>
              <strong>{convidados}</strong>
            </div>
            <div>
              <span>Data</span>
              <strong>
                {new Date(`${form.dataFesta}T12:00:00`).toLocaleDateString("pt-BR")}
              </strong>
            </div>
          </div>

          <div className={styles.warningBox}>
            <strong>A data ainda não está reservada.</strong>
            <p>
              Conforme a regra comercial da Kidmais, o envio das informações
              não garante reserva. A confirmação depende de disponibilidade,
              contrato e primeiro pagamento.
            </p>
          </div>

          <a
            className={styles.primaryButton}
            href={CONTATO_KIDMAIS.whatsappUrl}
            target="_blank"
            rel="noreferrer"
          >
            Falar com a Kidmais no WhatsApp
          </a>

          <p className={styles.smallMuted}>
            WhatsApp Kidmais: {CONTATO_KIDMAIS.whatsapp}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.decoracaoUm} />
      <div className={styles.decoracaoDois} />

      <div className={styles.shell}>
        <header className={styles.header}>
          <KidmaisBrand context="customer" subtitle="Fechamento da sua festa" />

          <div className={styles.secureBadge}>
            <span>●</span> Ambiente seguro
          </div>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Vamos finalizar sua comemoração</p>
          <h1>Sua festa, organizada de um jeito simples.</h1>
          <p>
            Confirme os detalhes abaixo. Você poderá revisar tudo antes de
            enviar para conferência da equipe Kidmais.
          </p>
        </section>

        <nav className={styles.progress}>
          <div className={styles.progressTop}>
            <span>Etapa {etapaVisualAtual + 1} de {etapasVisiveis.length}</span>
            <strong>{etapasVisiveis[etapaVisualAtual]}</strong>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${((etapaVisualAtual + 1) / etapasVisiveis.length) * 100}%` }}
            />
          </div>
        </nav>

        <form className={styles.card} onSubmit={finalizar}>
          {etapa === 0 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(0)} titulo="Escolha o pacote">
                {preselecaoDisponibilidade
                  ? `Seu horário ${horario} em ${form.dataFesta.split("-").reverse().join("/")} já foi revalidado. Agora escolha o pacote para continuar.`
                  : "Primeiro selecione o tipo de festa. Na próxima etapa o calendário será ajustado às regras e às datas previamente liberadas para esse pacote."}
              </StepTitle>

              {preselecaoDisponibilidade && form.dataFesta && intervaloSelecionado ? (
                <div className={styles.infoBox}>
                  <strong>Data e horário já escolhidos</strong>
                  <p>
                    {form.dataFesta.split("-").reverse().join("/")} · {intervaloSelecionado.inicio}–{intervaloSelecionado.fim}.
                    Esta consulta não reserva a data.
                  </p>
                  <a className={styles.secondaryButton} href="/disponibilidade">
                    Alterar data ou horário
                  </a>
                </div>
              ) : null}

              <div className={styles.packageGrid}>
                {PACOTES_FECHAMENTO_V1.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.packageCard} ${
                      form.pacote === item.id ? styles.packageSelected : ""
                    }`}
                    onClick={() => {
                      const novoPacote = item.id as PacoteId;
                      atualizar("pacote", novoPacote);

                      if (
                        preselecaoDisponibilidade &&
                        form.dataFesta &&
                        form.horarioBase
                      ) {
                        const comercial = statusDataPacote(
                          configDisponibilidade,
                          novoPacote,
                          form.dataFesta,
                          form.horarioBase,
                        );
                        atualizar(
                          "statusDisponibilidade",
                          comercial.status === "indisponivel"
                            ? ""
                            : comercial.status === "excecao"
                              ? "excecao"
                              : comercial.status === "consulta"
                                ? "consulta"
                                : "disponivel",
                        );
                        return;
                      }

                      atualizar("dataFesta", "");
                      atualizar("horarioBase", "");
                      atualizar("statusDisponibilidade", "");
                      setAjustesDisponiveis([]);
                    }}
                  >
                    {item.destaque && (
                      <span className={styles.packageBadge}>{item.destaque}</span>
                    )}
                    <span className={styles.radioVisual}>
                      {form.pacote === item.id ? "✓" : ""}
                    </span>
                    <strong>{item.nome}</strong>
                    <b>A partir de {numeroParaMoeda(item.precoInicial)}</b>
                    <p>{item.descricao}</p>
                    <small>{item.disponibilidade}</small>
                    <span className={styles.selectText}>
                      {form.pacote === item.id ? "Selecionado" : "Selecionar"}
                    </span>
                  </button>
                ))}
              </div>

              {pacote && (
                <div className={styles.packageDetails}>
                  <div>
                    <span>Mínimo</span>
                    <strong>{pacote.minPagantes} pagantes</strong>
                  </div>
                  <div>
                    <span>Limite do pacote</span>
                    <strong>{pacote.maxPagantes} convidados</strong>
                  </div>
                  <div className={styles.detailWide}>
                    <span>Buffet</span>
                    <p>{pacote.buffet}</p>
                  </div>
                  <div className={styles.detailWide}>
                    <span>Duração</span>
                    <p>{pacote.duracao}</p>
                  </div>
                  {pacote.observacao && (
                    <div className={styles.detailWide}>
                      <span>Observação</span>
                      <p>{pacote.observacao}</p>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {etapa === 1 && pacote && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(1)} titulo="Confirme a data e o horário">
                {preselecaoDisponibilidade
                  ? "A seleção feita na tela de disponibilidade foi preservada. Você pode mantê-la ou alterar abaixo."
                  : "O horário funciona como filtro do calendário. Assim cada dia mostra um único status, sem misturar disponibilidade da manhã e da noite."}
              </StepTitle>

              {preselecaoDisponibilidade && form.dataFesta && form.horarioBase ? (
                <div className={styles.infoBox}>
                  <strong>Data e horário selecionados antes do fechamento</strong>
                  <p>
                    {form.dataFesta.split("-").reverse().join("/")} · {horario}.
                    A consulta não reservou a data e o horário será revalidado novamente antes da confirmação.
                  </p>
                  <a className={styles.secondaryButton} href="/disponibilidade">
                    Alterar data ou horário
                  </a>
                </div>
              ) : null}

              <div className={styles.datePricePreview}>
                <div>
                  <span>Valor de tabela</span>
                  <strong>
                    A partir de {numeroParaMoeda(pacote.precoInicial)}
                  </strong>
                </div>

                {form.dataFesta && descontoAtual.ativo ? (
                  <>
                    <div className={styles.dateDiscountLine}>
                      <span>Desconto da data</span>
                      <strong>
                        -{Math.round(descontoAtual.percentual * 100)}%
                      </strong>
                      <small>{descontoAtual.titulo}</small>
                    </div>

                    <div className={styles.datePriceFinal}>
                      <span>Valor com desconto</span>
                      <strong>
                        A partir de{" "}
                        {numeroParaMoeda(
                          precoInicialComDesconto?.valorPacoteComDesconto ??
                            pacote.precoInicial
                        )}
                      </strong>
                    </div>
                  </>
                ) : (
                  <div className={styles.datePriceNeutral}>
                    <span>Valor para a data selecionada</span>
                    <strong>
                      {form.dataFesta
                        ? `A partir de ${numeroParaMoeda(pacote.precoInicial)}`
                        : "Selecione uma data para calcular"}
                    </strong>
                  </div>
                )}

                <small className={styles.datePriceFootnote}>
                  O valor exato é recalculado após informar a quantidade de
                  convidados. Descontos especiais da data aparecem aqui
                  automaticamente.
                </small>
              </div>

              <div className={styles.fieldGroup}>
                <span className={styles.groupLabel}>1. Escolha o período</span>
                <div className={styles.optionGridTwo}>
                  <ChoiceCard
                    selected={form.horarioBase === "almoco"}
                    icon="☀"
                    title="11h às 15h"
                    text="Ver disponibilidade deste horário"
                    onClick={() => {
                      setPreselecaoDisponibilidade(false);
                      atualizar("horarioBase", "almoco");
                      atualizar("dataFesta", "");
                      atualizar("statusDisponibilidade", "");
                      atualizar("ajusteHorario", "0");
                      setAjustesDisponiveis([]);
                    }}
                  />
                  <ChoiceCard
                    selected={form.horarioBase === "noite"}
                    icon="✦"
                    title="17h às 21h"
                    text="Ver disponibilidade deste horário"
                    onClick={() => {
                      setPreselecaoDisponibilidade(false);
                      atualizar("horarioBase", "noite");
                      atualizar("dataFesta", "");
                      atualizar("statusDisponibilidade", "");
                      atualizar("ajusteHorario", "0");
                      setAjustesDisponiveis([]);
                    }}
                  />
                </div>
              </div>

              {form.horarioBase ? (
                <>
                  <span className={styles.calendarSectionLabel}>2. Escolha a data</span>

                  {pacoteTemDescontoDiaUtil(form.pacote) && (
                    <div className={styles.discountCallout}>
                      <strong>
                        Economize 15% escolhendo de segunda a quinta.
                      </strong>
                      <p>
                        As datas elegíveis recebem o selo <b>-15%</b>.
                        A Kidmais também pode liberar promoções especiais em
                        outras datas, que aparecem com o percentual definido
                        no calendário.
                      </p>
                    </div>
                  )}

                  <CalendarioDisponibilidade
                    pacote={form.pacote as PacoteId}
                    horario={form.horarioBase}
                    dataSelecionada={form.dataFesta}
                    onSelecionar={(data, status, ajustes) => {
                      setPreselecaoDisponibilidade(false);
                      atualizar("dataFesta", data);
                      atualizar("statusDisponibilidade", status);
                      setAjustesDisponiveis(ajustes);

                      if (data) {
                        const preferido: AjusteHorario = ajustes.includes("0")
                          ? "0"
                          : ajustes[0] ?? "0";
                        atualizar("ajusteHorario", preferido);
                      }
                    }}
                    onTrocarHorario={(novoHorario) => {
                      setPreselecaoDisponibilidade(false);
                      atualizar("horarioBase", novoHorario);
                      atualizar("dataFesta", "");
                      atualizar("statusDisponibilidade", "");
                      atualizar("ajusteHorario", "0");
                      setAjustesDisponiveis([]);
                    }}
                    onConfigChange={setConfigDisponibilidade}
                  />


                </>
              ) : (
                <div className={styles.infoBox}>
                  <strong>Escolha um horário para visualizar o calendário.</strong>
                  <p>
                    As cores são calculadas separadamente para 11h–15h e 17h–21h.
                  </p>
                </div>
              )}

              {form.dataFesta && (
                <>
                  <label className={styles.field}>
                    <span>Ajuste do início</span>
                    <select
                      value={form.ajusteHorario}
                      onChange={(e) =>
                        atualizar(
                          "ajusteHorario",
                          e.target.value as "-30" | "0" | "30"
                        )
                      }
                    >
                      <option value="-30" disabled={!ajustesDisponiveis.includes("-30")}>30 minutos antes</option>
                      <option value="0" disabled={!ajustesDisponiveis.includes("0")}>Horário-base</option>
                      <option value="30" disabled={!ajustesDisponiveis.includes("30")}>30 minutos depois</option>
                    </select>
                    <small>
                      Apenas os inícios realmente livres para esta data ficam habilitados.
                    </small>
                    <small>
                      Horário desejado: {horario}. O ajuste de ±30 minutos será
                      revalidado pela equipe antes da confirmação.
                    </small>
                  </label>

                  {form.statusDisponibilidade === "consulta" && (
                    <div className={styles.consultNotice}>
                      <strong>Esta data será enviada para avaliação.</strong>
                      <p>
                        Você pode continuar o fechamento normalmente. A Kidmais
                        decidirá se abre exceção para este pacote e horário.
                      </p>
                    </div>
                  )}
                </>
              )}

              <div className={styles.infoBox}>
                <strong>Como ler o calendário?</strong>
                <p>
                  Verde = disponível; azul = pode ser solicitado para análise;
                  vermelho = horário ocupado ou bloqueado. A cor vale apenas
                  para o horário selecionado acima.
                </p>
              </div>
            </section>
          )}

          {etapa === 2 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(2)} titulo="Quantos convidados pagantes?">
                A Kidmais atende até 150 pessoas; alguns pacotes possuem limite menor.
              </StepTitle>

              <label className={styles.field}>
                <span>Quantidade de convidados pagantes</span>
                <input
                  type="number"
                  min={pacote?.minPagantes ?? 1}
                  max={pacote?.maxPagantes ?? 150}
                  inputMode="numeric"
                  placeholder="Ex.: 50"
                  value={form.convidadosPagantes}
                  onChange={(e) =>
                    atualizar(
                      "convidadosPagantes",
                      e.target.value ? Number(e.target.value) : ""
                    )
                  }
                />
                {pacote && (
                  <small>
                    Mínimo do {pacote.nome}: {pacote.minPagantes}. Máximo: {pacote.maxPagantes}.
                  </small>
                )}
              </label>

              <div className={styles.quickChoices}>
                {ATALHOS_CONVIDADOS
                  .filter(
                    (qtd) =>
                      !pacote ||
                      (qtd >= pacote.minPagantes && qtd <= pacote.maxPagantes)
                  )
                  .map((qtd) => (
                    <button
                      type="button"
                      key={qtd}
                      onClick={() => atualizar("convidadosPagantes", qtd)}
                    >
                      {qtd}
                    </button>
                  ))}
              </div>

              {referenciaTabela != null && (
                <div className={styles.priceReference}>
                  <span>Referência encontrada na tabela</span>

                  {descontoAtual.ativo ? (
                    <>
                      <div className={styles.discountPriceLine}>
                        <del>{numeroParaMoeda(referenciaTabela)}</del>
                        <span>-15% de segunda a quinta</span>
                      </div>
                      <strong>
                        {numeroParaMoeda(calculoDesconto.valorPacoteComDesconto)}
                      </strong>
                      <small>
                        Você economiza {numeroParaMoeda(calculoDesconto.valorDesconto)}
                        no valor do pacote nesta data. Adicionais não entram
                        neste desconto.
                      </small>
                    </>
                  ) : (
                    <>
                      <strong>{numeroParaMoeda(referenciaTabela)}</strong>
                      <small>
                        Valor de referência. O preço final será conferido pela
                        Kidmais conforme data, pacote e condições negociadas.
                      </small>
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {etapa === 3 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(3)} titulo="Preferências do buffet">
                Você pode informar suas preferências agora ou deixar essa
                definição para depois. Esta etapa não é obrigatória.
              </StepTitle>

              <div className={styles.buffetDecisionGrid}>
                <button
                  type="button"
                  className={`${styles.buffetDecisionCard} ${
                    form.buffetDefinicao === "agora"
                      ? styles.buffetDecisionSelected
                      : ""
                  }`}
                  onClick={() => atualizar("buffetDefinicao", "agora")}
                >
                  <span className={styles.radioVisual}>
                    {form.buffetDefinicao === "agora" ? "✓" : ""}
                  </span>
                  <strong>Quero informar agora</strong>
                  <p>
                    Registre suas preferências de salgados, bebidas, doces,
                    bolo e outros itens.
                  </p>
                </button>

                <button
                  type="button"
                  className={`${styles.buffetDecisionCard} ${
                    form.buffetDefinicao === "depois"
                      ? styles.buffetDecisionSelected
                      : ""
                  }`}
                  onClick={() => atualizar("buffetDefinicao", "depois")}
                >
                  <span className={styles.radioVisual}>
                    {form.buffetDefinicao === "depois" ? "✓" : ""}
                  </span>
                  <strong>Prefiro definir depois</strong>
                  <p>
                    Você continua o fechamento normalmente e combina o buffet
                    posteriormente com a equipe Kidmais.
                  </p>
                </button>
              </div>

              {form.buffetDefinicao === "agora" && (
                <>
                  <div className={styles.buffetInfoBox}>
                    <strong>Preferências preliminares</strong>
                    <p>
                      Informe o que já deseja definir. A equipe confirmará as
                      opções disponíveis dentro do pacote escolhido. Quando a
                      lista completa de itens estiver cadastrada no sistema,
                      estes campos serão substituídos por escolhas clicáveis.
                    </p>
                  </div>

                  <div className={styles.buffetFormGrid}>
                    <label className={styles.field}>
                      <span>Salgados</span>
                      <textarea
                        rows={3}
                        placeholder="Ex.: preferências de salgados..."
                        value={form.buffetSalgados}
                        onChange={(e) =>
                          atualizar("buffetSalgados", e.target.value)
                        }
                      />
                    </label>

                    <label className={styles.field}>
                      <span>Bebidas e sucos</span>
                      <textarea
                        rows={3}
                        placeholder="Ex.: sabores de suco, bebidas..."
                        value={form.buffetBebidas}
                        onChange={(e) =>
                          atualizar("buffetBebidas", e.target.value)
                        }
                      />
                    </label>

                    <label className={styles.field}>
                      <span>Doces</span>
                      <textarea
                        rows={3}
                        placeholder="Ex.: preferências de doces..."
                        value={form.buffetDoces}
                        onChange={(e) =>
                          atualizar("buffetDoces", e.target.value)
                        }
                      />
                    </label>

                    <label className={styles.field}>
                      <span>Bolo</span>
                      <textarea
                        rows={3}
                        placeholder="Ex.: sabor, recheio ou observações..."
                        value={form.buffetBolo}
                        onChange={(e) =>
                          atualizar("buffetBolo", e.target.value)
                        }
                      />
                    </label>

                    {(['buffetLembrancinha','buffetEmpratado','buffetBombom'] as const).map((key,i)=>(i===0 ? ['mini','completa','premium'].includes(form.pacote)||form.adicionaisSelecionados.some(a=>a.startsWith('lembrancinha')) : form.pacote==='premium'||form.adicionaisSelecionados.includes(i===1?'empratado':'bombom'))&&<label className={styles.field} key={key}><span>{['Lembrancinha','Empratado','Bombom'][i]}</span><textarea rows={2} maxLength={2000} value={form[key]} onChange={e=>atualizar(key,e.target.value)} placeholder="Não definido"/></label>)}
                    <label className={`${styles.field} ${styles.spanTwo}`}>
                      <span>Outras preferências do buffet</span>
                      <textarea
                        rows={3}
                        placeholder="Outros itens ou observações sobre o buffet."
                        value={form.buffetOutros}
                        onChange={(e) =>
                          atualizar("buffetOutros", e.target.value)
                        }
                      />
                    </label>
                  </div>
                </>
              )}

              {form.buffetDefinicao === "depois" && (
                <div className={styles.infoBox}>
                  <strong>Sem problema.</strong>
                  <p>
                    O buffet ficará marcado como “a definir” e poderá ser
                    escolhido posteriormente, sem impedir o fechamento.
                  </p>
                </div>
              )}
            </section>
          )}

          {etapa === 4 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(4)} titulo="Quer adicionar algo à festa?">
                Selecione apenas o que foi solicitado. O valor será conferido
                pela equipe antes do contrato.
              </StepTitle>

              {(["buffet", "mesa", "decoracao", "extra"] as const).map(
                (categoria) => (
                  <div className={styles.additionalSection} key={categoria}>
                    <h3>
                      {categoria === "buffet" && "Adicionais de buffet"}
                      {categoria === "mesa" && "Mesas especiais"}
                      {categoria === "decoracao" && "Decoração e extras"}
                      {categoria === "extra" && "Outros adicionais"}
                    </h3>
                    <div className={styles.additionalGrid}>
                      {ADICIONAIS.filter(
                        (item) => item.categoria === categoria
                      ).map((item) => {
                        const preco = precoAdicional(item, convidados || 1);
                        const selected =
                          form.adicionaisSelecionados.includes(item.id);

                        return (
                          <button
                            type="button"
                            key={item.id}
                            className={`${styles.additionalCard} ${
                              selected ? styles.additionalSelected : ""
                            }`}
                            onClick={() => alternarAdicional(item.id)}
                          >
                            <span className={styles.checkBox}>
                              {selected ? "✓" : ""}
                            </span>
                            <strong>{item.nome}</strong>
                            <b>{numeroParaMoeda(preco)}</b>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )
              )}

              <div className={styles.liveTotals}>
                <div>
                  <span>Pacote</span>
                  <strong>
                    {valorPacoteConsiderado != null
                      ? numeroParaMoeda(valorPacoteConsiderado)
                      : "A confirmar"}
                  </strong>
                  {descontoAtual.ativo && (
                    <small>
                      Desconto aplicado: -
                      {numeroParaMoeda(calculoDesconto.valorDesconto)}
                    </small>
                  )}
                </div>

                <div>
                  <span>Adicionais selecionados</span>
                  <strong>{numeroParaMoeda(adicionaisValor)}</strong>
                  <small>
                    {form.adicionaisSelecionados.length}{" "}
                    {form.adicionaisSelecionados.length === 1
                      ? "item selecionado"
                      : "itens selecionados"}
                  </small>
                </div>

                <div className={styles.liveTotalGrand}>
                  <span>Valor total da festa</span>
                  <strong>
                    {totalCalculado != null
                      ? numeroParaMoeda(totalCalculado)
                      : "A confirmar"}
                  </strong>
                  <small>
                    Atualiza instantaneamente conforme você adiciona ou remove itens.
                  </small>
                </div>
              </div>

              <div className={styles.infoBox}>
                <strong>Referência de tamanho das mesas</strong>
                <p>
                  Pequena: até 50 pessoas. Média: 60 a 100. Grande: 110 a 150.
                </p>
              </div>

              <label className={styles.field}>
                <span>Alterações combinadas no pacote</span>
                <textarea
                  rows={4}
                  placeholder="Ex.: retirar item, substituir opção, condição negociada..."
                  value={form.alteracoesPacote}
                  onChange={(e) => atualizar("alteracoesPacote", e.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span>Observações para a equipe Kidmais</span>
                <textarea
                  rows={4}
                  placeholder="Inclua qualquer informação importante para o fechamento."
                  value={form.observacoesCliente}
                  onChange={(e) =>
                    atualizar("observacoesCliente", e.target.value)
                  }
                />
              </label>
            </section>
          )}

          {etapa === 5 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(5)} titulo="Confirme o valor combinado">
                O sistema mostra referências da tabela, mas a Kidmais continua
                responsável pela aprovação do valor final.
              </StepTitle>

              <div className={styles.valueCards}>
                <div>
                  <span>Pacote • referência</span>
                  <strong>
                    {referenciaTabela != null
                      ? numeroParaMoeda(referenciaTabela)
                      : "A confirmar"}
                  </strong>
                </div>

                {descontoAtual.ativo && (
                  <div className={styles.discountValueCard}>
                    <span>Desconto da data</span>
                    <strong>
                      -{numeroParaMoeda(calculoDesconto.valorDesconto)}
                    </strong>
                    <small>{Math.round(descontoAtual.percentual * 100)}% sobre o valor do pacote</small>
                  </div>
                )}

                {descontoAtual.ativo && (
                  <div>
                    <span>Pacote após desconto</span>
                    <strong>
                      {numeroParaMoeda(
                        calculoDesconto.valorPacoteComDesconto
                      )}
                    </strong>
                  </div>
                )}

                <div>
                  <span>Valor dos adicionais</span>
                  <strong>{numeroParaMoeda(adicionaisValor)}</strong>
                </div>

                <div className={styles.totalValueCard}>
                  <span>Valor total calculado</span>
                  <strong>
                    {totalCalculado != null
                      ? numeroParaMoeda(totalCalculado)
                      : "A confirmar"}
                  </strong>
                </div>

                <div>
                  <span>Valor combinado</span>
                  <strong>
                    {valorInformado > 0
                      ? numeroParaMoeda(valorInformado)
                      : "Digite abaixo"}
                  </strong>
                </div>
              </div>

              <label className={styles.field}>
                <span>Valor total combinado no atendimento</span>
                <input
                  className={styles.moneyInput}
                  type="text"
                  inputMode="numeric"
                  placeholder="R$ 0,00"
                  value={form.valorCombinado}
                  onChange={(e) => {
                    const digitos = e.target.value.replace(/\D/g, "");
                    atualizar(
                      "valorCombinado",
                      digitos ? formatarMoedaDigitada(digitos) : ""
                    );
                  }}
                />
              </label>

              {totalCalculado != null && (
                <button
                  type="button"
                  className={styles.useCalculatedButton}
                  onClick={() =>
                    atualizar(
                      "valorCombinado",
                      formatarMoedaDigitada(String(Math.round(totalCalculado * 100)))
                    )
                  }
                >
                  Usar valor calculado ({numeroParaMoeda(totalCalculado)})
                </button>
              )}

              {descontoAtual.ativo && (
                <div className={styles.discountAppliedNotice}>
                  <strong>Desconto comercial aplicado</strong>
                  <p>
                    Esta data possui {Math.round(descontoAtual.percentual * 100)}% de
                    desconto sobre o valor do pacote. Os adicionais permanecem
                    com seus valores normais.
                  </p>
                </div>
              )}

              <div className={styles.infoBox}>
                <strong>Pagamento</strong>
                <p>
                  Após aprovação: PIX à vista tem 10% de desconto. PIX parcelado
                  tem 3% de desconto; as condições são confirmadas
                  pela equipe Kidmais. Cartão é processado pela Cielo.
                </p>
              </div>
            </section>
          )}

          {etapa === 6 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(6)} titulo="Dados para o fechamento">
                {origemInterna
                  ? "Confira os dados do contratante antes de continuar."
                  : "Use seu CPF para localizar um cadastro existente ou continuar com um novo cadastro."}
              </StepTitle>

              {!origemInterna && identificacaoStatus === "AGUARDANDO_CPF" && (
                <div className={styles.identificationPanel}>
                  <div className={styles.identificationIntro}>
                    <strong>Já fez festa com a Kidmais?</strong>
                    <p>
                      Não precisa lembrar. Informe seu CPF e o sistema verifica
                      automaticamente se já existe um cadastro.
                    </p>
                  </div>
                  <label className={styles.field}>
                    <span>CPF do contratante *</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="000.000.000-00"
                      value={cpfIdentificacao}
                      onChange={(e) => {
                        setCpfIdentificacao(formatarCPF(e.target.value));
                        setErroIdentificacao("");
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={buscarClientePorCpf}
                  >
                    Continuar
                  </button>
                </div>
              )}

              {!origemInterna && identificacaoStatus === "CLIENTE_ENCONTRADO" && (
                <div className={styles.identificationPanel}>
                  <span className={styles.foundBadge}>Cadastro encontrado</span>
                  <h3>Encontramos um cadastro para este CPF.</h3>
                  <p className={styles.identificationText}>
                    Para proteger seus dados, nenhuma informação pessoal é exibida antes da validação.
                    O código será enviado pelo WhatsApp transacional oficial para o número cadastrado.
                  </p>

                  {canaisIdentidade.length > 0 ? (
                    <div className={styles.birthdayGrid}>
                      {canaisIdentidade.map((item) => (
                        <button
                          key={item.canal}
                          type="button"
                          className={`${styles.birthdayCard} ${
                            canalSelecionado === item.canal ? styles.birthdaySelected : ""
                          }`}
                          onClick={() => setCanalSelecionado(item.canal)}
                        >
                          <strong>
                            WhatsApp
                          </strong>
                          <span>{item.destinoMascarado}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.warningBox}>
                      <strong>Não há contato disponível para envio automático.</strong>
                      <p>A equipe Kidmais precisará validar seu cadastro manualmente.</p>
                    </div>
                  )}

                  <div className={styles.identificationActions}>
                    {canaisIdentidade.length > 0 && (
                      <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={enviarCodigoValidacao}
                        disabled={processandoIdentidade}
                      >
                        {processandoIdentidade ? "Enviando..." : "Enviar código"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={iniciarRecuperacaoCadastral}
                      disabled={processandoIdentidade}
                    >
                      Não tenho acesso aos contatos cadastrados
                    </button>
                  </div>
                </div>
              )}

              {!origemInterna && identificacaoStatus === "CODIGO_ENVIADO" && (
                <div className={styles.identificationPanel}>
                  <span className={styles.foundBadge}>Código enviado</span>
                  <h3>Digite o código recebido.</h3>
                  <p className={styles.identificationText}>
                    O código foi enviado para {
                      canaisIdentidade.find((item) => item.canal === canalSelecionado)?.destinoMascarado ??
                      "o contato selecionado"
                    }.
                  </p>
                  <label className={styles.field}>
                    <span>Código de 6 dígitos</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="000000"
                      value={codigoValidacao}
                      onChange={(e) => {
                        setCodigoValidacao(somenteDigitos(e.target.value).slice(0, 6));
                        setErroIdentificacao("");
                      }}
                    />
                  </label>
                  <div className={styles.identificationActions}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={confirmarCodigoValidacao}
                      disabled={processandoIdentidade}
                    >
                      {processandoIdentidade ? "Confirmando..." : "Confirmar código"}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={enviarCodigoValidacao}
                      disabled={processandoIdentidade}
                    >
                      Enviar novo código
                    </button>
                  </div>
                </div>
              )}

              {erroIdentificacao && (
                <div className={styles.inlineError} role="alert">{erroIdentificacao}</div>
              )}

              {identificacaoStatus === "NOVO_CLIENTE" && !origemInterna && (
                <div className={styles.infoBox}>
                  <strong>Nenhum cadastro encontrado.</strong>
                  <p>
                    Vamos criar seu cadastro durante este fechamento. Você não
                    precisará fazer nenhum cadastro separado.
                  </p>
                </div>
              )}

              {identificacaoStatus === "RECUPERACAO" && !origemInterna && (
                <div className={styles.warningBox}>
                  <strong>Validação de identidade pendente</strong>
                  <p>
                    Sua solicitação foi registrada. Para proteger seus dados, o fechamento online
                    ficará pausado até a confirmação da equipe Kidmais. Nenhum dado cadastral antigo
                    foi revelado e nenhum novo Cliente foi criado.
                  </p>
                  <div className={styles.identificationActions}>
                    <a
                      className={styles.primaryButton}
                      href={CONTATO_KIDMAIS.whatsappUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Falar com a Kidmais no WhatsApp
                    </a>
                  </div>
                </div>
              )}

              {["VERIFICADO", "NOVO_CLIENTE"].includes(identificacaoStatus) && (
                <>
                  {clienteEncontrado && identificacaoStatus === "VERIFICADO" && (
                    <div className={styles.existingClientHeader}>
                      <div>
                        <span className={styles.foundBadge}>Identidade confirmada</span>
                        <strong>{clienteEncontrado.cliente.nomeCompleto}</strong>
                        <small>Cadastro existente carregado para conferência.</small>
                      </div>
                    </div>
                  )}

                  <div className={styles.formGrid}>
                    <Field label="Nome completo *" wide>
                      <input
                        type="text"
                        autoComplete="name"
                        value={form.nomeCliente}
                        onChange={(e) => atualizar("nomeCliente", e.target.value)}
                      />
                    </Field>

                    <Field label="CPF *">
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="000.000.000-00"
                        value={form.cpf}
                        readOnly={identificacaoStatus === "VERIFICADO"}
                        onChange={(e) => atualizar("cpf", formatarCPF(e.target.value))}
                      />
                    </Field>

                    <Field label="RG">
                      <input
                        type="text"
                        value={form.rg}
                        onChange={(e) => atualizar("rg", e.target.value)}
                      />
                    </Field>

                    <Field label="WhatsApp">
                      <input
                        type="tel"
                        autoComplete="tel"
                        placeholder="(61) 99999-9999"
                        value={form.whatsapp}
                        onChange={(e) =>
                          atualizar("whatsapp", formatarTelefone(e.target.value))
                        }
                      />
                    </Field>

                    <Field label="Telefone">
                      <input
                        type="tel"
                        placeholder="(61) 3333-3333"
                        value={form.telefone}
                        onChange={(e) =>
                          atualizar("telefone", formatarTelefone(e.target.value))
                        }
                      />
                      <small>Informe WhatsApp ou telefone. O segundo contato é opcional.</small>
                    </Field>

                    <Field label="E-mail *">
                      <input
                        type="email"
                        autoComplete="email"
                        value={form.email}
                        onChange={(e) => atualizar("email", e.target.value)}
                      />
                    </Field>

                    <Field label="CEP *">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="postal-code"
                        placeholder="00000-000"
                        value={form.cep}
                        onChange={(e) => atualizarCep(e.target.value)}
                      />
                      {consultandoCep && <small>Buscando endereço...</small>}
                      {!consultandoCep && erroCep && (
                        <small role="alert">{erroCep}</small>
                      )}
                      {!consultandoCep && !erroCep && (
                        <small>Ao informar os 8 dígitos, o endereço é preenchido automaticamente.</small>
                      )}
                    </Field>

                    <Field label="Endereço *" wide>
                      <input
                        type="text"
                        value={form.logradouro}
                        onChange={(e) => atualizar("logradouro", e.target.value)}
                      />
                    </Field>

                    <Field label="Número *">
                      <input
                        type="text"
                        value={form.numero}
                        onChange={(e) => atualizar("numero", e.target.value)}
                      />
                    </Field>

                    <Field label="Complemento">
                      <input
                        type="text"
                        value={form.complemento}
                        onChange={(e) => atualizar("complemento", e.target.value)}
                      />
                    </Field>

                    <Field label="Bairro *">
                      <input
                        type="text"
                        value={form.bairro}
                        onChange={(e) => atualizar("bairro", e.target.value)}
                      />
                    </Field>

                    <Field label="Cidade *">
                      <input
                        type="text"
                        value={form.cidade}
                        onChange={(e) => atualizar("cidade", e.target.value)}
                      />
                    </Field>

                    <Field label="UF *">
                      <input
                        type="text"
                        maxLength={2}
                        value={form.uf}
                        onChange={(e) => atualizar("uf", e.target.value.toUpperCase())}
                      />
                    </Field>

                    <Field label="Outro responsável" wide>
                      <input
                        type="text"
                        placeholder="Opcional"
                        value={form.outroResponsavel}
                        onChange={(e) =>
                          atualizar("outroResponsavel", e.target.value)
                        }
                      />
                    </Field>
                  </div>

                  {clienteEncontrado && identificacaoStatus === "VERIFICADO" && dadosCadastraisAlterados && (
                    <div className={styles.updateDecision}>
                      <strong>Você alterou dados do cadastro.</strong>
                      <p>
                        Escolha explicitamente se deseja gravar essas alterações no cadastro principal da Kidmais.
                        Sem autorização, o CRM permanecerá como está.
                      </p>
                      <div className={styles.optionGridTwo}>
                        <button
                          type="button"
                          className={`${styles.choiceCard} ${
                            solicitarAtualizacaoCadastro === false ? styles.choiceSelected : ""
                          }`}
                          onClick={() => setSolicitarAtualizacaoCadastro(false)}
                        >
                          <strong>Manter cadastro atual</strong>
                          <small>Não gravar as alterações no cadastro principal.</small>
                        </button>
                        <button
                          type="button"
                          className={`${styles.choiceCard} ${
                            solicitarAtualizacaoCadastro === true ? styles.choiceSelected : ""
                          }`}
                          onClick={() => setSolicitarAtualizacaoCadastro(true)}
                        >
                          <strong>Atualizar cadastro</strong>
                          <small>Solicitar atualização com os dados revisados.</small>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className={styles.sectionDivider} />

                  <h3 className={styles.subTitle}>Aniversariante</h3>

                  {clienteEncontrado && identificacaoStatus === "VERIFICADO" && (
                    <div className={styles.birthdaySelector}>
                      <p>Para quem será a festa?</p>
                      <div className={styles.birthdayGrid}>
                        {clienteEncontrado.aniversariantes.map((item) => {
                          const referencia = form.dataFesta
                            ? new Date(`${form.dataFesta}T12:00:00`)
                            : new Date();
                          const idade = item.dataNascimento
                            ? calcularIdade(item.dataNascimento, referencia)
                            : null;
                          return (
                            <button
                              type="button"
                              key={item.id}
                              className={`${styles.birthdayCard} ${
                                aniversarianteSelecionadoId === item.id ? styles.birthdaySelected : ""
                              }`}
                              onClick={() => selecionarAniversariante(item.id)}
                            >
                              <strong>{item.nome}</strong>
                              <span>{idade == null ? "Data de nascimento não informada" : `${idade} anos na data da festa`}</span>
                              {item.temaPadrao && <small>Tema anterior/preferido: {item.temaPadrao}</small>}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className={`${styles.birthdayCard} ${
                            aniversarianteSelecionadoId === "NOVO" ? styles.birthdaySelected : ""
                          }`}
                          onClick={() => selecionarAniversariante("NOVO")}
                        >
                          <strong>+ Outro aniversariante</strong>
                          <span>Adicionar ao mesmo cadastro da família</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {(!clienteEncontrado || identificacaoStatus !== "VERIFICADO" || aniversarianteSelecionadoId) && (
                    <div className={styles.formGrid}>
                      <Field label="Nome do aniversariante *" wide>
                        <input
                          type="text"
                          value={form.nomeAniversariante}
                          readOnly={Boolean(
                            clienteEncontrado &&
                            identificacaoStatus === "VERIFICADO" &&
                            aniversarianteSelecionadoId &&
                            aniversarianteSelecionadoId !== "NOVO"
                          )}
                          onChange={(e) =>
                            atualizar("nomeAniversariante", e.target.value)
                          }
                        />
                      </Field>

                      <Field label="Idade que vai fazer">
                        <input
                          type="number"
                          min="0"
                          max="18"
                          value={form.idadeAniversariante}
                          readOnly={Boolean(
                            clienteEncontrado &&
                            identificacaoStatus === "VERIFICADO" &&
                            aniversarianteSelecionadoId &&
                            aniversarianteSelecionadoId !== "NOVO"
                          )}
                          onChange={(e) =>
                            atualizar(
                              "idadeAniversariante",
                              e.target.value ? Number(e.target.value) : ""
                            )
                          }
                        />
                      </Field>

                      <Field label="Tema da festa">
                        <input
                          type="text"
                          placeholder="Ex.: Carros"
                          value={form.temaFesta}
                          readOnly={Boolean(
                            clienteEncontrado &&
                            identificacaoStatus === "VERIFICADO" &&
                            aniversarianteSelecionadoId &&
                            aniversarianteSelecionadoId !== "NOVO"
                          )}
                          onChange={(e) => atualizar("temaFesta", e.target.value)}
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {etapa === 7 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(7)} titulo="Revise os detalhes">
                Confira as informações antes de enviar para a Kidmais.
              </StepTitle>

              <div className={styles.summaryGrid}>
                <Summary
                  label="Cadastro do contratante"
                  value={
                    recuperacaoCadastralPendente
                      ? "Existente • atualização pendente"
                      : identificacaoStatus === "VERIFICADO"
                        ? "Cliente existente • identidade confirmada"
                        : "Novo cliente"
                  }
                />
                <Summary
                  label="Origem do fechamento"
                  value={origemInterna ? "Atendimento Kidmais" : "Cliente"}
                />
                <Summary label="Pacote" value={pacote?.nome || "-"} />
                <Summary
                  label="Convidados pagantes"
                  value={String(form.convidadosPagantes || "-")}
                />
                <Summary
                  label="Data"
                  value={
                    form.dataFesta
                      ? new Date(`${form.dataFesta}T12:00:00`).toLocaleDateString(
                          "pt-BR"
                        )
                      : "-"
                  }
                />
                <Summary label="Horário desejado" value={horario || "-"} />
                <Summary
                  label="Disponibilidade"
                  value={
                    form.statusDisponibilidade === "disponivel"
                      ? "Disponível"
                      : form.statusDisponibilidade === "consulta"
                        ? "Sujeita à avaliação"
                        : form.statusDisponibilidade === "excecao"
                          ? "Exceção — requer aprovação"
                          : "-"
                  }
                />
                <Summary
                  label="Pacote • referência"
                  value={
                    referenciaTabela != null
                      ? numeroParaMoeda(referenciaTabela)
                      : "A confirmar"
                  }
                />
                <Summary
                  label="Adicionais"
                  value={numeroParaMoeda(adicionaisValor)}
                />
                <Summary
                  label="Total calculado"
                  value={
                    totalCalculado != null
                      ? numeroParaMoeda(totalCalculado)
                      : "A confirmar"
                  }
                />
                {descontoAtual.ativo && (
                  <Summary
                    label="Desconto dia útil"
                    value={`${Math.round(descontoAtual.percentual * 100)}% • -${numeroParaMoeda(
                      calculoDesconto.valorDesconto
                    )}`}
                  />
                )}

                <Summary
                  label="Total calculado"
                  value={
                    totalCalculado != null
                      ? numeroParaMoeda(totalCalculado)
                      : "A confirmar"
                  }
                />

                <Summary
                  label="Valor combinado"
                  value={
                    valorInformado
                      ? numeroParaMoeda(valorInformado)
                      : "Não informado"
                  }
                />
                <Summary
                  label="Buffet"
                  value={
                    form.buffetDefinicao === "depois"
                      ? "A definir depois"
                      : "Preferências informadas"
                  }
                />

                <Summary
                  label="Aniversariante"
                  value={form.nomeAniversariante || "-"}
                />
              </div>

              {form.buffetDefinicao === "agora" && (
                <div className={styles.buffetSummaryBox}>
                  <strong>Preferências de buffet</strong>

                  {form.buffetSalgados && (
                    <p><b>Salgados:</b> {form.buffetSalgados}</p>
                  )}
                  {form.buffetBebidas && (
                    <p><b>Bebidas e sucos:</b> {form.buffetBebidas}</p>
                  )}
                  {form.buffetDoces && (
                    <p><b>Doces:</b> {form.buffetDoces}</p>
                  )}
                  {form.buffetBolo && (
                    <p><b>Bolo:</b> {form.buffetBolo}</p>
                  )}
                  {form.buffetOutros && (
                    <p><b>Outros:</b> {form.buffetOutros}</p>
                  )}

                  {(['buffetLembrancinha','buffetEmpratado','buffetBombom'] as const).map((k,i)=>form[k]&&<p key={k}><b>{['Lembrancinha','Empratado','Bombom'][i]}:</b> {form[k]}</p>)}
                  {!form.buffetLembrancinha && !form.buffetEmpratado && !form.buffetBombom && !form.buffetSalgados &&
                    !form.buffetBebidas &&
                    !form.buffetDoces &&
                    !form.buffetBolo &&
                    !form.buffetOutros && (
                      <p>
                        O cliente optou por definir agora, mas ainda não
                        registrou preferências.
                      </p>
                    )}
                </div>
              )}

              <div className={styles.warningBox}>
                <strong>Importante sobre a reserva</strong>
                <p>
                  O envio deste fechamento não garante a reserva da data. A
                  confirmação ocorre após conferência da disponibilidade,
                  contrato e primeiro pagamento.
                </p>
              </div>
            </section>
          )}

          {etapa === 8 && (
            <section className={styles.step}>
              <StepTitle numero={numeroEtapaVisivel(8)} titulo="Como pretende pagar?">
                Esta é apenas a preferência. O pagamento será liberado depois
                que a Kidmais aprovar o fechamento e disponibilizar o contrato.
              </StepTitle>

              <div className={styles.paymentGrid}>
                <PaymentCard
                  title="PIX à vista"
                  subtitle="10% de desconto"
                  selected={form.formaPagamento === "pix_avista"}
                  total={
                    valorInformado
                      ? numeroParaMoeda(
                          calcularTotalPagamento(valorInformado, "pix_avista")
                            .total
                        )
                      : undefined
                  }
                  onClick={() => atualizar("formaPagamento", "pix_avista")}
                />
                <PaymentCard
                  title="PIX parcelado"
                  subtitle="3% de desconto"
                  detail="Parcelas e condições são confirmadas diretamente com a Kidmais."
                  selected={form.formaPagamento === "pix_parcelado"}
                  total={
                    valorInformado
                      ? numeroParaMoeda(
                          calcularTotalPagamento(
                            valorInformado,
                            "pix_parcelado"
                          ).total
                        )
                      : undefined
                  }
                  onClick={() => atualizar("formaPagamento", "pix_parcelado")}
                />
                <PaymentCard
                  title="Cartão"
                  subtitle="Cielo"
                  detail="Condições liberadas depois da aprovação."
                  selected={form.formaPagamento === "cartao_cielo"}
                  total={
                    valorInformado ? numeroParaMoeda(valorInformado) : undefined
                  }
                  onClick={() => atualizar("formaPagamento", "cartao_cielo")}
                />
              </div>

              {form.formaPagamento === "pix_parcelado" && (
                <fieldset className={styles.warningBox}>
                  <legend>Condição pretendida</legend>
                  <p>Informe como gostaria de parcelar. A condição será conferida e aprovada pela Kidmais antes da liberação do contrato.</p>
                  <div className={styles.paymentGrid}>
                    <label className={styles.field}>Entrada (R$)
                      <input inputMode="decimal" placeholder="Opcional, ex.: 1000,00" value={form.pixEntrada}
                        onChange={(event) => atualizar("pixEntrada", event.target.value)} />
                    </label>
                    <label className={styles.field}>Valor da parcela (R$)
                      <input inputMode="decimal" placeholder="Opcional, ex.: 500,00" value={form.pixParcela}
                        onChange={(event) => atualizar("pixParcela", event.target.value)} />
                    </label>
                    <label className={styles.field}>Quantidade de parcelas
                      <input type="number" min="1" step="1" placeholder="Opcional" value={form.pixQuantidade}
                        onChange={(event) => atualizar("pixQuantidade", event.target.value)} />
                    </label>
                  </div>
                  <p>Esta proposta não cria parcelas financeiras nem confirma a reserva.</p>
                </fieldset>
              )}

              <div className={styles.contractNotice}>
                <div>1</div>
                <span>
                  <strong>Kidmais confere e aprova</strong>
                  <small>Agenda, valor e condições são revalidados.</small>
                </span>
                <div>2</div>
                <span>
                  <strong>Contrato é disponibilizado</strong>
                  <small>O cliente visualiza e aceita o documento.</small>
                </span>
                <div>3</div>
                <span>
                  <strong>Primeiro pagamento</strong>
                  <small>A reserva depende da parcela inicial confirmada e da disponibilidade.</small>
                </span>
              </div>
            </section>
          )}

          {erro && (
            <div className={styles.errorBox} role="alert">
              {erro}
            </div>
          )}

          <footer className={styles.actions}>
            {etapa > 0 ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={voltar}
              >
                Voltar
              </button>
            ) : (
              <span />
            )}

            {etapa < ETAPAS.length - 1 ? (
              etapa === 6 && identificacaoStatus === "RECUPERACAO" && !origemInterna ? (
                <span />
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={continuar}
                  disabled={validandoDisponibilidade}
                >
                  {validandoDisponibilidade ? "Revalidando horário..." : "Continuar"}
                  {!validandoDisponibilidade && <span>→</span>}
                </button>
              )
            ) : (
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={enviando || validandoDisponibilidade}
              >
                {validandoDisponibilidade
                  ? "Revalidando horário..."
                  : enviando
                    ? "Enviando..."
                    : "Enviar para conferência"}
                {!enviando && !validandoDisponibilidade && <span>→</span>}
              </button>
            )}
          </footer>
        </form>

        <footer className={styles.pageFooter}>
          <span>Kidmais • {CONTATO_KIDMAIS.whatsapp}</span>
          <span>{CONTATO_KIDMAIS.site}</span>
        </footer>
      </div>
    </main>
  );
}

function StepTitle({
  numero,
  titulo,
  children,
}: {
  numero: string;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.stepTitle}>
      <span className={styles.stepNumber}>{numero}</span>
      <div>
        <h2>{titulo}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function ChoiceCard({
  selected,
  icon,
  title,
  text,
  onClick,
}: {
  selected: boolean;
  icon: string;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.choiceCard} ${
        selected ? styles.choiceSelected : ""
      }`}
      onClick={onClick}
    >
      <span className={styles.choiceIcon}>{icon}</span>
      <strong>{title}</strong>
      <small>{text}</small>
    </button>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`${styles.field} ${wide ? styles.spanTwo : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <article className={styles.summaryCard}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function PaymentCard({
  title,
  subtitle,
  detail,
  selected,
  total,
  onClick,
}: {
  title: string;
  subtitle: string;
  detail?: string;
  selected: boolean;
  total?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.paymentCard} ${
        selected ? styles.paymentSelected : ""
      }`}
      onClick={onClick}
    >
      <span className={styles.radioVisual}>{selected ? "✓" : ""}</span>
      <strong>{title}</strong>
      <span className={styles.paymentSubtitle}>{subtitle}</span>
      {total && <b>{total}</b>}
      {detail && <small>{detail}</small>}
    </button>
  );
}
