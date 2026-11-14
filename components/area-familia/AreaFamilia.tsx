"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MarcaPublicaCabecalho, useMarcaPublica } from "@/components/fechamento/MarcaPublica";
import styles from "./AreaFamilia.module.css";

type Sessao = { papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL"; primeiroNome: string } | null;

async function postar(url: string, corpo: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), credentials: "same-origin" });
  const json = (await r.json().catch(() => null)) as { ok?: boolean; erro?: string; validacaoId?: string; destinoMascarado?: string } | null;
  return { ok: r.ok && json?.ok === true, json };
}

/**
 * Área "Minha festa" (F1): entrada por link + documento + código; logado, uma tela vazia com a marca do buffet.
 * O token do link fica no fragmento (#), que o navegador nunca manda ao servidor nem a terceiros.
 */
export default function AreaFamilia({ empresa, sessao }: { empresa: string; sessao: Sessao }) {
  const base = `/b/${empresa}/minha-festa`;
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <MarcaPublicaCabecalho subtitle="Minha festa" />
        <section className={styles.cartao}>
          {sessao ? <Logado base={base} sessao={sessao} /> : <Entrada base={base} />}
        </section>
      </div>
    </main>
  );
}

function Logado({ base, sessao }: { base: string; sessao: NonNullable<Sessao> }) {
  const marca = useMarcaPublica();
  const [ocupado, setOcupado] = useState(false);
  async function sair(todos: boolean) {
    setOcupado(true);
    await postar(`${base}/api/sair`, { todos });
    window.location.replace(base);
  }
  return (
    <>
      <h1 className={styles.titulo}>{sessao.primeiroNome ? `Olá, ${sessao.primeiroNome}!` : "Olá!"}</h1>
      <p className={styles.texto}>Esta é a área da sua festa{marca.kidmais ? "" : ` com ${marca.nome}`}.</p>
      <div className={styles.vazio}>Em breve você vai acompanhar tudo da festa por aqui.</div>
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => sair(false)}>Sair deste aparelho</button>
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => sair(true)}>Sair de todos os aparelhos</button>
    </>
  );
}

function Entrada({ base }: { base: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [documento, setDocumento] = useState("");
  const [validacao, setValidacao] = useState<{ id: string; destino: string } | null>(null);
  const [codigo, setCodigo] = useState("");
  const [lembrar, setLembrar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "");
    // Leitura do fragmento só existe no navegador: o estado nasce depois da montagem.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(/^[A-Za-z0-9_-]{43}$/.test(t) ? t : "");
  }, []);

  async function pedirCodigo(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setErro(null);
    const r = await postar(`${base}/api/iniciar`, { token, documento: documento || null });
    setOcupado(false);
    if (!r.ok || !r.json?.validacaoId) { setErro(r.json?.erro ?? "Não foi possível continuar."); return; }
    setValidacao({ id: r.json.validacaoId, destino: r.json.destinoMascarado ?? "" });
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    if (!validacao) return;
    setOcupado(true); setErro(null);
    const r = await postar(`${base}/api/confirmar`, { validacaoId: validacao.id, codigo: codigo.trim(), lembrar });
    if (!r.ok) { setOcupado(false); setErro(r.json?.erro ?? "Não foi possível entrar."); return; }
    window.location.replace(base);
  }

  if (token === null) return null;
  if (!token) {
    return (
      <>
        <h1 className={styles.titulo}>Minha festa</h1>
        <p className={styles.texto}>Para entrar, abra o link que o buffet enviou para você pelo WhatsApp.</p>
      </>
    );
  }
  if (!validacao) {
    return (
      <form onSubmit={pedirCodigo}>
        <h1 className={styles.titulo}>Entrar na área da festa</h1>
        <p className={styles.texto}>Confirme seus dados e enviaremos um código para o seu WhatsApp.</p>
        {erro ? <p className={styles.erro} role="alert">{erro}</p> : null}
        <label className={styles.campo}>
          CPF ou CNPJ
          <input inputMode="numeric" autoComplete="off" value={documento} maxLength={20} onChange={(e) => setDocumento(e.target.value)} />
          <span className={styles.ajuda}>Quem contratou a festa informa o documento do contrato. Se o buffet não cadastrou seu CPF, deixe em branco.</span>
        </label>
        <button className={styles.botao} type="submit" disabled={ocupado}>Receber código</button>
      </form>
    );
  }
  return (
    <form onSubmit={confirmar}>
      <h1 className={styles.titulo}>Digite o código</h1>
      <p className={styles.texto}>Enviamos um código de 6 números para o WhatsApp {validacao.destino}.</p>
      {erro ? <p className={styles.erro} role="alert">{erro}</p> : null}
      <label className={styles.campo}>
        Código
        <input inputMode="numeric" autoComplete="one-time-code" value={codigo} maxLength={6} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
      </label>
      <label className={styles.lembrar}>
        <input type="checkbox" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} />
        Lembrar neste aparelho por 30 dias
      </label>
      <button className={styles.botao} type="submit" disabled={ocupado || codigo.length !== 6}>Entrar</button>
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => { setValidacao(null); setCodigo(""); setErro(null); }}>Pedir outro código</button>
    </form>
  );
}
