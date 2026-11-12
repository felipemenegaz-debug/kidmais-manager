"use client";

import Image from "next/image";
import type { MarcaContrato } from "@/lib/contratos/marca-contrato";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./ContratoPublico.module.css";
import { rotuloCanal, textoEnvioCodigo, useReservaEmailLiberada, type EnvioCodigoPublico } from "@/components/identidade/reserva-email";

type Canal = {
  canal: "WHATSAPP" | "SMS" | "EMAIL";
  destinoMascarado: string;
};

type ContextoContrato = {
  comprovantes?: Array<{id:string;parte:string;nome:string;assinado_em:string}>;
  contrato: {
    id: string;
    status: "AGUARDANDO_ASSINATURA" | "ASSINADO" | "CANCELADO";
    assinadoEm: string | null;
  };
  versao: {
    id: string;
    numero: number;
    status: "ATIVA" | "ASSINADA" | "SUBSTITUIDA" | "CANCELADA";
    snapshotHash: string;
    resumo: {
      templateVersao: number;
      pdfHash: string;
    };
    contratoOficial: {
      disponivel: boolean;
      modeloCodigo: string | null;
      templateVersao: number | null;
      pdfHash: string | null;
      homologadoParaProducao: boolean;
    };
    documentoTemplateVersao: number | null;
    documentoPdfHash: string | null;
    documentoHomologadoParaProducao: boolean;
    assinadoEm: string | null;
  };
  evento: {
    data: string;
    horarioInicio: string;
    horarioFim: string;
    pacote: string;
    pacoteCodigo: string;
    aniversariante: string;
    valorFinalContrato: number;
    /** S-E: nome do salão fixado no contrato; nulo sem salão. */
    salao?: string | null;
  };
  /** PAPEL: contrato histórico assinado em papel — sem aceite eletrônico, sem documento e sem comprovante. */
  assinatura?: { tipo: "PAPEL" | "ELETRONICA"; texto: string | null };
  /** Só existe depois da prova de identidade. */
  marca?: MarcaContrato;
  aceitePermitido: boolean;
};

type ApiError = {
  ok?: false;
  erro?: string;
  codigo?: string;
};

function mensagemErro(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "erro" in payload) {
    const erro = (payload as ApiError).erro;
    if (typeof erro === "string" && erro.trim()) return erro;
  }
  return fallback;
}

/** O servidor recusou a prova ou o acesso (expirados, revogados): a tela não pode continuar mostrando o que eles liberaram. */
class ProvaRecusada extends Error {}

/** A versão exibida foi encerrada ou substituída: os documentos dela saem da tela e a leitura recomeça pela identificação. */
class VersaoEncerrada extends Error {}

/** Resposta de uma leitura já descartada (tela limpa ou outra leitura em curso): não pode tocar no estado. */
class LeituraDescartada extends Error {}

const CODIGOS_PROVA_RECUSADA = new Set(["CONTRATO_ACESSO_NAO_AUTORIZADO", "PROVA_INVALIDA_OU_EXPIRADA"]);

function erroDaResposta(payload: unknown, fallback: string) {
  const mensagem = mensagemErro(payload, fallback);
  const codigo = payload && typeof payload === "object" ? (payload as ApiError).codigo : undefined;
  if (codigo && CODIGOS_PROVA_RECUSADA.has(codigo)) return new ProvaRecusada(mensagem);
  if (codigo === "VERSAO_CONTRATO_DIVERGENTE") return new VersaoEncerrada(mensagem);
  return new Error(mensagem);
}

const AVISO_VALIDACAO_EXPIRADA = "Sua validação expirou. Confirme seus dados para abrir os documentos novamente.";
const AVISO_ACEITE_REGISTRADO = "Seu aceite foi registrado. Para ver os documentos de novo, confirme seus dados.";

/** `aceiteGravado`: o aceite desta sessão já foi confirmado pelo servidor; qualquer recusa depois disso avisa que ele valeu. */
/** `blobs`: URLs criadas pela sessão, publicadas ou não no estado; todas são revogadas quando a sessão termina. */
type SessaoLeitura = { id: number; controle: AbortController | null; aceiteGravado: boolean; blobs: string[] };

function dataBr(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

function hora(value: string) {
  const m = /^(\d{2}):(\d{2})/.exec(value);
  return m ? `${m[1]}:${m[2]}` : value;
}

function moeda(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

export default function ContratoPublico({ contratoId }: { contratoId: string }) {
  const [cpf, setCpf] = useState("");
  const [canais, setCanais] = useState<Canal[]>([]);
  const [canal, setCanal] = useState<Canal["canal"] | null>(null);
  const [validacaoId, setValidacaoId] = useState<string | null>(null);
  const [codigo, setCodigo] = useState("");
  const [provaToken, setProvaToken] = useState<string | null>(null);
  const [acessoToken, setAcessoToken] = useState<string | null>(null);
  const [envio, setEnvio] = useState<EnvioCodigoPublico | null>(null);
  const reservaLiberada = useReservaEmailLiberada(envio?.canal === "WHATSAPP" ? envio.reservaEmail?.liberaEm : null);
  const [contexto, setContexto] = useState<ContextoContrato | null>(null);
  const [resumoPdfUrl, setResumoPdfUrl] = useState<string | null>(null);
  const [contratoPdfUrl, setContratoPdfUrl] = useState<string | null>(null);
  const [documentoAtivo, setDocumentoAtivo] = useState<"RESUMO" | "CONTRATO">("RESUMO");
  const [contratoOficialVisualizado, setContratoOficialVisualizado] = useState(false);
  const [aceiteMarcado, setAceiteMarcado] = useState(false);
  const [assinaturaConcluida, setAssinaturaConcluida] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  /**
   * Sessão de leitura: começa ao enviar o código. Limpar a tela, trocar de contrato ou sair encerra a sessão,
   * cancela as requisições dela e faz as respostas que ainda chegarem serem descartadas antes de tocar no estado.
   */
  const sessaoLeitura = useRef<SessaoLeitura>({ id: 0, controle: null, aceiteGravado: false, blobs: [] });

  function encerrarSessaoLeitura(nova: boolean) {
    const anterior = sessaoLeitura.current;
    anterior.controle?.abort();
    // Inclui URLs criadas que ainda não chegaram ao estado publicado (encerramento antes do commit do React).
    for (const url of anterior.blobs.splice(0)) URL.revokeObjectURL(url);
    sessaoLeitura.current = { id: anterior.id + 1, controle: nova ? new AbortController() : null, aceiteGravado: false, blobs: [] };
    return sessaoLeitura.current;
  }

  function sessaoViva(sessao: SessaoLeitura) {
    return sessao.controle !== null && sessaoLeitura.current === sessao && !sessao.controle.signal.aborted;
  }

  function exigirSessaoViva(sessao: SessaoLeitura) {
    if (!sessaoViva(sessao)) throw new LeituraDescartada();
  }

  useEffect(() => () => { encerrarSessaoLeitura(false); }, [contratoId]);

  useEffect(() => {
    return () => {
      if (resumoPdfUrl) URL.revokeObjectURL(resumoPdfUrl);
      if (contratoPdfUrl) URL.revokeObjectURL(contratoPdfUrl);
    };
  }, [resumoPdfUrl, contratoPdfUrl]);

  function voltarParaIdentificacao(mensagem = AVISO_VALIDACAO_EXPIRADA) {
    // Aceite já confirmado nesta sessão: o aviso dele prevalece sobre qualquer recusa posterior (aceite, PDF ou comprovante).
    const aviso = sessaoLeitura.current.aceiteGravado ? AVISO_ACEITE_REGISTRADO : mensagem;
    encerrarSessaoLeitura(false); // revoga todas as URLs da sessão, publicadas ou não
    setResumoPdfUrl(null);
    setContratoPdfUrl(null);
    setContexto(null);
    setProvaToken(null);
    setAcessoToken(null);
    setValidacaoId(null);
    setEnvio(null);
    setCodigo("");
    setCanais([]);
    setCanal(null);
    setCpf("");
    setDocumentoAtivo("RESUMO");
    setContratoOficialVisualizado(false);
    setAceiteMarcado(false);
    setAssinaturaConcluida(false);
    setCarregando(false);
    setErro(aviso);
  }

  const etapa = useMemo(() => {
    if (contexto) return 4;
    if (validacaoId) return 3;
    if (canais.length) return 2;
    return 1;
  }, [canais.length, contexto, validacaoId]);

  async function consultarCpf() {
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/acesso`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documento: cpf }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Não foi possível validar o acesso."));
      const novosCanais = payload.data.canais as Canal[];
      setCanais(novosCanais);
      setCanal(novosCanais[0]?.canal ?? null);
      if (!novosCanais.length) {
        setErro("O cadastro não possui um contato disponível para receber o código de validação.");
      }
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível validar o acesso.");
    } finally {
      setCarregando(false);
    }
  }

  async function enviarCodigo() {
    if (!canal) return;
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/identidade/iniciar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documento: cpf, canal }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Não foi possível enviar o código."));
      setValidacaoId(payload.data.validacaoId);
      setAcessoToken(payload.data.acessoToken);
      setEnvio(payload.data as EnvioCodigoPublico);
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível enviar o código.");
    } finally {
      setCarregando(false);
    }
  }

  /** "Não recebeu? Receber por e-mail": o código do WhatsApp deixa de valer e um novo vai para o e-mail do cadastro. */
  async function receberPorEmail() {
    if (!acessoToken) return;
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/identidade/receber-por-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acessoToken }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Não foi possível enviar o código por e-mail."));
      setValidacaoId(payload.data.validacaoId);
      setAcessoToken(payload.data.acessoToken);
      setEnvio(payload.data as EnvioCodigoPublico);
      setCodigo("");
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível enviar o código por e-mail.");
    } finally {
      setCarregando(false);
    }
  }

  async function carregarDocumento(token: string, acesso: string, sessao: SessaoLeitura) {
    const signal = sessao.controle?.signal;
    const pedir = (rota: string) => fetch(`/api/contratos/${contratoId}/${rota}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provaToken: token, acessoToken: acesso }),
      signal,
    });
    const falha = async (response: Response, fallback: string) => {
      let payload: unknown = null;
      try { payload = await response.json(); } catch {}
      exigirSessaoViva(sessao);
      return erroDaResposta(payload, fallback);
    };

    exigirSessaoViva(sessao);
    const contextoResponse = await pedir("contexto");
    exigirSessaoViva(sessao);
    if (!contextoResponse.ok) throw await falha(contextoResponse, "Não foi possível carregar os documentos da contratação.");
    const contextoPayload = await contextoResponse.json();
    exigirSessaoViva(sessao);
    const contextoCarregado = contextoPayload.data as ContextoContrato;

    const resumoResponse = await pedir("resumo");
    exigirSessaoViva(sessao);
    if (!resumoResponse.ok) throw await falha(resumoResponse, "Não foi possível gerar o Resumo da Contratação.");
    const resumoBlob = await resumoResponse.blob();
    exigirSessaoViva(sessao);

    let contratoBlob: Blob | null = null;
    if (contextoCarregado.versao.contratoOficial.disponivel) {
      const contratoResponse = await pedir("pdf");
      exigirSessaoViva(sessao);
      if (!contratoResponse.ok) throw await falha(contratoResponse, "Não foi possível gerar o Contrato Oficial.");
      contratoBlob = await contratoResponse.blob();
      exigirSessaoViva(sessao);
    }

    // Só com tudo em mãos e a sessão ainda viva: cria os blobs e troca a tela de uma vez.
    const novaUrlResumo = URL.createObjectURL(resumoBlob);
    const novaUrlContrato = contratoBlob ? URL.createObjectURL(contratoBlob) : null;
    sessao.blobs.push(novaUrlResumo, ...(novaUrlContrato ? [novaUrlContrato] : []));
    setResumoPdfUrl((anterior) => {
      if (anterior) URL.revokeObjectURL(anterior);
      return novaUrlResumo;
    });
    setContratoPdfUrl((anterior) => {
      if (anterior) URL.revokeObjectURL(anterior);
      return novaUrlContrato;
    });
    setDocumentoAtivo("RESUMO");
    setContratoOficialVisualizado(false);
    setContexto(contextoCarregado);
  }

  async function confirmarCodigo() {
    if (!validacaoId) return;
    setErro(null);
    setCarregando(true);
    // A sessão começa antes do envio: troca de contrato ou saída com o código em voo cancela a confirmação e a leitura.
    const sessao = encerrarSessaoLeitura(true);
    try {
      if (!acessoToken) throw new Error("Sessão de acesso ao Contrato inválida. Solicite um novo código.");
      const response = await fetch("/api/identidade/confirmar-codigo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validacaoId, codigo }),
        signal: sessao.controle?.signal,
      });
      exigirSessaoViva(sessao);
      const payload = await response.json();
      exigirSessaoViva(sessao);
      if (!response.ok) throw new Error(mensagemErro(payload, "Código inválido."));
      const token = payload.provaToken as string;
      setProvaToken(token);
      await carregarDocumento(token, acessoToken, sessao);
    } catch (error) {
      // Código errado (Error comum) mantém a etapa do código; prova ou versão recusadas limpam tudo.
      if (error instanceof LeituraDescartada || !sessaoViva(sessao)) return;
      if (error instanceof ProvaRecusada) return voltarParaIdentificacao();
      if (error instanceof VersaoEncerrada) return voltarParaIdentificacao(error.message);
      setErro(error instanceof Error ? error.message : "Não foi possível confirmar o código.");
    } finally {
      if (sessaoViva(sessao)) setCarregando(false);
    }
  }

  async function aceitarContrato() {
    if (
      !provaToken ||
      !acessoToken ||
      !contexto ||
      !aceiteMarcado ||
      !contratoOficialVisualizado ||
      !contexto.versao.documentoPdfHash
    ) return;
    const sessao = sessaoLeitura.current;
    if (!sessaoViva(sessao)) return;
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/aceite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: sessao.controle?.signal,
        body: JSON.stringify({
          provaToken,
          acessoToken,
          versaoId: contexto.versao.id,
          snapshotHash: contexto.versao.snapshotHash,
          documentoPdfHash: contexto.versao.documentoPdfHash,
        }),
      });
      const payload = await response.json();
      exigirSessaoViva(sessao);
      if (!response.ok) throw erroDaResposta(payload, "Não foi possível concluir o aceite.");
      sessao.aceiteGravado = true;
      setAssinaturaConcluida(true);
      await carregarDocumento(provaToken, acessoToken, sessao);
      exigirSessaoViva(sessao);
      setContexto((atual) => atual ? {
        ...atual,
        contrato: { ...atual.contrato, status: "ASSINADO" },
        versao: { ...atual.versao, status: "ASSINADA" },
        aceitePermitido: false,
      } : atual);
    } catch (error) {
      if (error instanceof LeituraDescartada || !sessaoViva(sessao)) return;
      // O aceite já gravado é comunicado à parte quando a nova leitura exige outra prova.
      if (error instanceof ProvaRecusada || error instanceof VersaoEncerrada) {
        return voltarParaIdentificacao(error instanceof VersaoEncerrada ? error.message : AVISO_VALIDACAO_EXPIRADA);
      }
      const mensagem = error instanceof Error ? error.message : "Não foi possível concluir o aceite.";
      setErro(sessao.aceiteGravado ? `Seu aceite foi registrado, mas os documentos não foram atualizados: ${mensagem}` : mensagem);
    } finally {
      if (sessaoViva(sessao)) setCarregando(false);
    }
  }

  async function abrirComprovante(documentoId: string) {
    const sessao = sessaoLeitura.current;
    if (!sessaoViva(sessao)) return;
    setErro(null);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/comprovante`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provaToken, acessoToken, documentoId }),
        signal: sessao.controle?.signal,
      });
      exigirSessaoViva(sessao);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        exigirSessaoViva(sessao);
        throw erroDaResposta(payload, "Não foi possível abrir o comprovante.");
      }
      const blob = await response.blob();
      exigirSessaoViva(sessao);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `comprovante-${documentoId}.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (error instanceof LeituraDescartada || !sessaoViva(sessao)) return;
      if (error instanceof ProvaRecusada) return voltarParaIdentificacao();
      if (error instanceof VersaoEncerrada) return voltarParaIdentificacao(error.message);
      // Comprovante indisponível (COMPROVANTE_NAO_ENCONTRADO) ou falha comum: a leitura continua.
      setErro(error instanceof Error ? error.message : "Falha ao abrir comprovante.");
    }
  }

  // Antes da prova de identidade: neutro, sem dizer se o contrato existe nem de qual buffet é.
  const marca: MarcaContrato = contexto?.marca ?? { kidmais: false, nome: null };

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          {marca.kidmais ? (
            <Image
              src="/assets/kidmais-logo-horizontal.png"
              alt="Kidmais"
              width={174}
              height={75}
              className={styles.logo}
              priority
            />
          ) : marca.nome ? <strong className={styles.nomeBuffet}>{marca.nome}</strong> : <span aria-hidden="true" />}
          <div className={styles.secureBadge}>🔒 Validação de identidade</div>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>{marca.nome ? `Documentos de ${marca.nome}` : "Documentos do buffet"}</p>
          <h1>Confira sua contratação e o Contrato Oficial</h1>
          {contexto?.assinatura?.tipo === "PAPEL"
            ? <p>Confira o resumo da sua contratação. Este contrato foi assinado em papel; não há aceite eletrônico.</p>
            : <p>Primeiro confira o resumo comercial. Depois leia o Contrato Oficial específico do seu pacote antes do aceite eletrônico.</p>}
        </section>

        <div className={styles.progress}>
          <span>Etapa {etapa} de 4</span>
          <div><i style={{ width: `${etapa * 25}%` }} /></div>
        </div>

        {erro && <div className={styles.errorBox}>{erro}</div>}

        {!contexto && (
          <section className={styles.card}>
            {etapa === 1 && (
              <>
                <h2>1. Confirme seu CPF ou CNPJ</h2>
                <p>O CPF (ou o CNPJ, se o contrato está em nome de uma empresa) é usado somente para localizar o Contrato correto e liberar os canais cadastrados.</p>
                <label className={styles.field}>
                  <span>CPF ou CNPJ do contratante</span>
                  <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF ou CNPJ" autoComplete="off" />
                </label>
                <button className={styles.primary} disabled={carregando || !cpf.trim()} onClick={consultarCpf}>
                  {carregando ? "Validando..." : "Continuar"}
                </button>
              </>
            )}

            {etapa === 2 && (
              <>
                <h2>2. Receba o código</h2>
                <p>{canais.every((item) => item.canal === "EMAIL")
                  ? "O código será enviado para o e-mail cadastrado. O endereço permanece mascarado nesta tela."
                  : "O código será enviado pelo WhatsApp transacional oficial. O número cadastrado permanece mascarado nesta tela."}</p>
                <div className={styles.channelGrid}>
                  {canais.map((item) => (
                    <button
                      key={`${item.canal}-${item.destinoMascarado}`}
                      className={canal === item.canal ? styles.channelSelected : styles.channel}
                      onClick={() => setCanal(item.canal)}
                    >
                      <strong>{rotuloCanal(item.canal)}</strong>
                      <span>{item.destinoMascarado}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.actions}>
                  <button className={styles.secondary} onClick={() => { setCanais([]); setCanal(null); setAcessoToken(null); }}>Voltar</button>
                  <button className={styles.primary} disabled={carregando || !canal} onClick={enviarCodigo}>
                    {carregando ? "Enviando..." : "Enviar código"}
                  </button>
                </div>
              </>
            )}

            {etapa === 3 && (
              <>
                <h2>3. Digite o código</h2>
                <p>{textoEnvioCodigo(envio)}</p>
                <label className={styles.field}>
                  <span>Código de validação</span>
                  <input
                    value={codigo}
                    onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    placeholder="000000"
                    className={styles.otp}
                  />
                </label>
                <button className={styles.primary} disabled={carregando || codigo.length !== 6} onClick={confirmarCodigo}>
                  {carregando ? "Confirmando..." : "Abrir documentos"}
                </button>
                {envio?.canal === "WHATSAPP" && envio.reservaEmail && (
                  <div className={styles.actions}>
                    <button className={styles.secondary} disabled={carregando || !reservaLiberada} onClick={receberPorEmail}>
                      {reservaLiberada
                        ? `Não recebeu? Receber por e-mail (${envio.reservaEmail.destinoMascarado})`
                        : "Não recebeu? Em instantes você poderá receber por e-mail"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {contexto && (
          <>
            <section className={styles.summaryCard}>
              <div><span>Festa</span><strong>{contexto.evento.aniversariante}</strong></div>
              <div><span>Data</span><strong>{dataBr(contexto.evento.data)} · {hora(contexto.evento.horarioInicio)}</strong></div>
              <div><span>Pacote</span><strong>{contexto.evento.pacote}</strong></div>
              {contexto.evento.salao && <div><span>Salão</span><strong>{contexto.evento.salao}</strong></div>}
              <div><span>Valor</span><strong>{moeda(contexto.evento.valorFinalContrato)}</strong></div>
              <div><span>Versão</span><strong>V{contexto.versao.numero}</strong></div>
              <div><span>Status</span><strong>{contexto.assinatura?.tipo === "PAPEL" ? "Assinado em papel" : contexto.contrato.status === "ASSINADO" ? "Assinado" : "Aguardando assinatura"}</strong></div>
            </section>

            {contexto.versao.contratoOficial.disponivel && !contexto.versao.contratoOficial.homologadoParaProducao && (
              <div className={styles.devWarning}>
                <strong>Contrato Oficial em homologação jurídica</strong>
                <span>O modelo da Festa Completa foi estruturado a partir do contrato oficial da antiga Festa Standard. Algumas regras e redações legadas ainda precisam de validação final antes de produção.</span>
              </div>
            )}

            <section className={styles.pdfCard}>
              <div className={styles.documentTabs}>
                <button
                  type="button"
                  className={documentoAtivo === "RESUMO" ? styles.documentTabActive : styles.documentTab}
                  onClick={() => setDocumentoAtivo("RESUMO")}
                >
                  <strong>1. Resumo da Contratação</strong>
                  <span>Conferência comercial</span>
                </button>
                <button
                  type="button"
                  disabled={!contexto.versao.contratoOficial.disponivel}
                  className={documentoAtivo === "CONTRATO" ? styles.documentTabActive : styles.documentTab}
                  onClick={() => {
                    setDocumentoAtivo("CONTRATO");
                    setContratoOficialVisualizado(true);
                  }}
                >
                  <strong>2. Contrato Oficial</strong>
                  <span>{contexto.assinatura?.tipo === "PAPEL" ? "Assinado em papel" : contexto.versao.contratoOficial.disponivel ? contexto.evento.pacote : "Modelo ainda não cadastrado"}</span>
                </button>
              </div>

              <div className={styles.pdfHeader}>
                <div>
                  <span>{documentoAtivo === "RESUMO" ? "Documento informativo" : "Documento jurídico para aceite"}</span>
                  <strong>{documentoAtivo === "RESUMO" ? "Resumo da Contratação" : "Contrato Oficial"} · V{contexto.versao.numero}</strong>
                </div>
                {(documentoAtivo === "RESUMO" ? resumoPdfUrl : contratoPdfUrl) && (
                  <a href={(documentoAtivo === "RESUMO" ? resumoPdfUrl : contratoPdfUrl) ?? undefined} target="_blank" rel="noreferrer">Abrir em nova aba</a>
                )}
              </div>

              {documentoAtivo === "RESUMO" ? (
                resumoPdfUrl ? <iframe title="Resumo da Contratação" src={resumoPdfUrl} className={styles.pdfFrame} /> : <div className={styles.pdfLoading}>Carregando resumo...</div>
              ) : contratoPdfUrl ? (
                <iframe title="Contrato Oficial" src={contratoPdfUrl} className={styles.pdfFrame} />
              ) : (
                <div className={styles.pdfLoading}>{contexto.assinatura?.tipo === "PAPEL" ? "Este contrato foi assinado em papel; o original fica com o buffet." : "O Contrato Oficial deste pacote ainda não está cadastrado."}</div>
              )}
            </section>

            {contexto.assinatura?.tipo === "PAPEL" ? (
              <section className={styles.successBox}>
                <strong>Contrato assinado em papel</strong>
                <span>{contexto.assinatura.texto}</span>
                <span>Para obter uma cópia do documento original, solicite ao buffet pelos canais de atendimento.</span>
              </section>
            ) : assinaturaConcluida ? (
              <section className={styles.successBox}>
                <strong>✓ Aceite registrado com sucesso</strong>
                <span>Seu aceite da versão V{contexto.versao.numero} foi registrado. O documento e os comprovantes desta versão estão preservados.</span>
              </section>
            ) : contexto.versao.status === "ASSINADA" ? (
              <section className={styles.successBox}>
                <strong>✓ Este Contrato já está assinado</strong>
                <span>Você está visualizando a versão preservada como assinada.</span>
              </section>
            ) : (
              <section className={styles.acceptCard}>
                <label className={styles.checkboxRow}>
                  <input type="checkbox" checked={aceiteMarcado} onChange={(e) => setAceiteMarcado(e.target.checked)} />
                  <span>Li o Contrato Oficial desta contratação e aceito os termos da exata versão exibida.</span>
                </label>
                <button
                  className={styles.primary}
                  disabled={!contexto.aceitePermitido || !aceiteMarcado || !contratoOficialVisualizado || carregando}
                  onClick={aceitarContrato}
                >
                  {carregando ? "Registrando aceite..." : "Aceitar e assinar eletronicamente"}
                </button>
                {!contexto.versao.contratoOficial.disponivel ? (
                  <small>O Contrato Oficial deste pacote ainda não foi cadastrado. O aceite permanece bloqueado.</small>
                ) : !contratoOficialVisualizado ? (
                  <small>Abra a aba “Contrato Oficial” antes de liberar o aceite.</small>
                ) : !contexto.aceitePermitido ? (
                  <small>O aceite está bloqueado neste ambiente até a liberação explícita do modelo jurídico.</small>
                ) : null}
              </section>
            )}
            {contexto.comprovantes?.map((item) => (
              <button key={item.id} className={styles.secondary} onClick={() => abrirComprovante(item.id)}>
                Baixar comprovante — {item.parte === "KIDMAIS" ? "Buffet" : "Cliente"}
              </button>
            ))}
          </>
        )}

        <footer className={styles.footer}>
          <span>iA.Fest</span>
          <span>O token de identidade não é incluído no endereço da página.</span>
        </footer>
      </div>
    </main>
  );
}
