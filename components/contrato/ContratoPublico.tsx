"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import styles from "./ContratoPublico.module.css";

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
  };
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
  const [contexto, setContexto] = useState<ContextoContrato | null>(null);
  const [resumoPdfUrl, setResumoPdfUrl] = useState<string | null>(null);
  const [contratoPdfUrl, setContratoPdfUrl] = useState<string | null>(null);
  const [documentoAtivo, setDocumentoAtivo] = useState<"RESUMO" | "CONTRATO">("RESUMO");
  const [contratoOficialVisualizado, setContratoOficialVisualizado] = useState(false);
  const [aceiteMarcado, setAceiteMarcado] = useState(false);
  const [assinaturaConcluida, setAssinaturaConcluida] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    return () => {
      if (resumoPdfUrl) URL.revokeObjectURL(resumoPdfUrl);
      if (contratoPdfUrl) URL.revokeObjectURL(contratoPdfUrl);
    };
  }, [resumoPdfUrl, contratoPdfUrl]);

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
        body: JSON.stringify({ cpf }),
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
        body: JSON.stringify({ cpf, canal }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Não foi possível enviar o código."));
      setValidacaoId(payload.data.validacaoId);
      setAcessoToken(payload.data.acessoToken);
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível enviar o código.");
    } finally {
      setCarregando(false);
    }
  }

  async function carregarDocumento(token: string, acesso: string) {
    const contextoResponse = await fetch(`/api/contratos/${contratoId}/contexto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provaToken: token, acessoToken: acesso }),
    });
    const contextoPayload = await contextoResponse.json();
    if (!contextoResponse.ok) {
      throw new Error(mensagemErro(contextoPayload, "Não foi possível carregar os documentos da contratação."));
    }

    const contextoCarregado = contextoPayload.data as ContextoContrato;

    const resumoResponse = await fetch(`/api/contratos/${contratoId}/resumo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provaToken: token, acessoToken: acesso }),
    });
    if (!resumoResponse.ok) {
      let payload: unknown = null;
      try { payload = await resumoResponse.json(); } catch {}
      throw new Error(mensagemErro(payload, "Não foi possível gerar o Resumo da Contratação."));
    }

    const resumoBlob = await resumoResponse.blob();
    const novaUrlResumo = URL.createObjectURL(resumoBlob);
    setResumoPdfUrl((anterior) => {
      if (anterior) URL.revokeObjectURL(anterior);
      return novaUrlResumo;
    });

    if (contextoCarregado.versao.contratoOficial.disponivel) {
      const contratoResponse = await fetch(`/api/contratos/${contratoId}/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provaToken: token, acessoToken: acesso }),
      });
      if (!contratoResponse.ok) {
        let payload: unknown = null;
        try { payload = await contratoResponse.json(); } catch {}
        throw new Error(mensagemErro(payload, "Não foi possível gerar o Contrato Oficial."));
      }
      const contratoBlob = await contratoResponse.blob();
      const novaUrlContrato = URL.createObjectURL(contratoBlob);
      setContratoPdfUrl((anterior) => {
        if (anterior) URL.revokeObjectURL(anterior);
        return novaUrlContrato;
      });
    } else {
      setContratoPdfUrl(null);
    }

    setDocumentoAtivo("RESUMO");
    setContratoOficialVisualizado(false);
    setContexto(contextoCarregado);
  }

  async function confirmarCodigo() {
    if (!validacaoId) return;
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch("/api/identidade/confirmar-codigo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validacaoId, codigo }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Código inválido."));
      const token = payload.provaToken as string;
      setProvaToken(token);
      if (!acessoToken) throw new Error("Sessão de acesso ao Contrato inválida. Solicite um novo código.");
      await carregarDocumento(token, acessoToken);
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível confirmar o código.");
    } finally {
      setCarregando(false);
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
    setErro(null);
    setCarregando(true);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/aceite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provaToken,
          acessoToken,
          versaoId: contexto.versao.id,
          snapshotHash: contexto.versao.snapshotHash,
          documentoPdfHash: contexto.versao.documentoPdfHash,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(mensagemErro(payload, "Não foi possível concluir o aceite."));
      setAssinaturaConcluida(true);
      await carregarDocumento(provaToken, acessoToken);
      setContexto((atual) => atual ? {
        ...atual,
        contrato: { ...atual.contrato, status: "ASSINADO" },
        versao: { ...atual.versao, status: "ASSINADA" },
        aceitePermitido: false,
      } : atual);
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível concluir o aceite.");
    } finally {
      setCarregando(false);
    }
  }

  async function abrirComprovante(documentoId: string) {
    setErro(null);
    try {
      const response = await fetch(`/api/contratos/${contratoId}/comprovante`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provaToken, acessoToken, documentoId }),
      });
      if (!response.ok) throw new Error(mensagemErro(await response.json(), "Não foi possível abrir o comprovante."));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `comprovante-${documentoId}.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { setErro(error instanceof Error ? error.message : "Falha ao abrir comprovante."); }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Image
            src="/assets/kidmais-logo-horizontal.png"
            alt="Kidmais"
            width={174}
            height={75}
            className={styles.logo}
            priority
          />
          <div className={styles.secureBadge}>🔒 Validação de identidade</div>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Documentos Kidmais</p>
          <h1>Confira sua contratação e o Contrato Oficial</h1>
          <p>Primeiro confira o resumo comercial. Depois leia o Contrato Oficial específico do seu pacote antes do aceite eletrônico.</p>
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
                <h2>1. Confirme seu CPF</h2>
                <p>O CPF é usado somente para localizar o Contrato correto e liberar os canais cadastrados.</p>
                <label className={styles.field}>
                  <span>CPF do contratante</span>
                  <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" autoComplete="off" />
                </label>
                <button className={styles.primary} disabled={carregando || !cpf.trim()} onClick={consultarCpf}>
                  {carregando ? "Validando..." : "Continuar"}
                </button>
              </>
            )}

            {etapa === 2 && (
              <>
                <h2>2. Receba o código</h2>
                <p>O código será enviado pelo WhatsApp transacional oficial. O número cadastrado permanece mascarado nesta tela.</p>
                <div className={styles.channelGrid}>
                  {canais.map((item) => (
                    <button
                      key={`${item.canal}-${item.destinoMascarado}`}
                      className={canal === item.canal ? styles.channelSelected : styles.channel}
                      onClick={() => setCanal(item.canal)}
                    >
                      <strong>WhatsApp</strong>
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
                <p>Informe o código de 6 dígitos enviado pelo WhatsApp.</p>
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
              <div><span>Valor</span><strong>{moeda(contexto.evento.valorFinalContrato)}</strong></div>
              <div><span>Versão</span><strong>V{contexto.versao.numero}</strong></div>
              <div><span>Status</span><strong>{contexto.contrato.status === "ASSINADO" ? "Assinado" : "Aguardando assinatura"}</strong></div>
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
                  <span>{contexto.versao.contratoOficial.disponivel ? contexto.evento.pacote : "Modelo ainda não cadastrado"}</span>
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
                resumoPdfUrl ? <iframe title="Resumo da Contratação Kidmais" src={resumoPdfUrl} className={styles.pdfFrame} /> : <div className={styles.pdfLoading}>Carregando resumo...</div>
              ) : contratoPdfUrl ? (
                <iframe title="Contrato Oficial Kidmais" src={contratoPdfUrl} className={styles.pdfFrame} />
              ) : (
                <div className={styles.pdfLoading}>O Contrato Oficial deste pacote ainda não está cadastrado.</div>
              )}
            </section>

            {assinaturaConcluida ? (
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
                Baixar comprovante — {item.parte === "KIDMAIS" ? "Kidmais" : "Cliente"}
              </button>
            ))}
          </>
        )}

        <footer className={styles.footer}>
          <span>Kidmais Manager</span>
          <span>O token de identidade não é incluído no endereço da página.</span>
        </footer>
      </div>
    </main>
  );
}
