"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { lerFragmento } from "@/lib/satisfacao/fragmento";
import s from "./satisfacao.module.css";

/**
 * Pesquisa pública pós-festa (`/p/satisfacao#<token>`). A página é estática: os dados vêm de POST /api/satisfacao/abrir
 * com o token lido do FRAGMENTO (que não chega ao servidor, ao log HTTP nem ao Referer). A nota pré-marcada do e-mail
 * (`.n0`–`.n10`) só pré-seleciona: nada é gravado até "Enviar resposta". O fragmento sai da barra de endereço.
 */
type Abertura =
  | { situacao: "ABERTA"; primeiroNome: string; buffet: string; unidade: string | null; dataFesta: string }
  | { situacao: "RESPONDIDA"; buffet: string };
type Estado =
  | { fase: "carregando" }
  | { fase: "indisponivel"; mensagem: string }
  | { fase: "aberta"; dados: Extract<Abertura, { situacao: "ABERTA" }> }
  | { fase: "respondida"; buffet: string; nome: string | null; notaBaixa: boolean }
  | { fase: "saiu" };

let lido: { token: string | null; preMarcada: number | null } | undefined;
function lerUmaVez() {
  if (lido !== undefined) return lido;
  lido = lerFragmento(window.location.hash);
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return lido;
}
const semInscricao = () => () => undefined;

async function postar<T>(url: string, corpo: unknown): Promise<{ ok: true; data: T } | { ok: false; erro: string; status: number }> {
  try {
    // same-origin, não no-referrer: com no-referrer o navegador manda `Origin: null` e a conferência de origem recusa o
    // POST (achado do E2E). O Referer nunca leva o fragmento (onde está o link), e o documento segue no-referrer.
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), cache: "no-store", referrerPolicy: "same-origin" });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; erro?: string } | null;
    if (res.ok && json?.ok) return { ok: true, data: json.data as T };
    return { ok: false, erro: json?.erro ?? "Não foi possível concluir agora.", status: res.status };
  } catch {
    return { ok: false, erro: "Falha de conexão. Tente de novo.", status: 0 };
  }
}

const ASPECTOS = [
  { campo: "notaComida", rotulo: "Comida e bebida" },
  { campo: "notaEquipe", rotulo: "Equipe e atendimento" },
  { campo: "notaEspaco", rotulo: "Espaço e decoração" },
] as const;
type Aspecto = (typeof ASPECTOS)[number]["campo"];

function dataPorExtenso(iso: string) {
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) return "";
  const data = new Date(Date.UTC(a, m - 1, d, 12));
  const semana = data.toLocaleDateString("pt-BR", { weekday: "long", timeZone: "UTC" });
  return `${semana.charAt(0).toUpperCase()}${semana.slice(1)}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function iniciais(nome: string) {
  return nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "K";
}

function Estrela({ cheia }: { cheia: boolean }) {
  return <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z" fill={cheia ? "#C9B6FF" : "none"} stroke="#C9B6FF" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>;
}

export default function PesquisaSatisfacao() {
  const fragmento = useSyncExternalStore(semInscricao, lerUmaVez, () => undefined);
  const [estadoAtual, setEstado] = useState<Estado>({ fase: "carregando" });
  const [notaEscolhida, setNota] = useState<number | null>(null);
  // Derivados na renderização (sem setState síncrono no efeito): link sem token e a nota pré-marcada do e-mail.
  const estado: Estado = fragmento && !fragmento.token ? { fase: "indisponivel", mensagem: "Este link de pesquisa não está mais disponível." } : estadoAtual;
  const nota = notaEscolhida ?? fragmento?.preMarcada ?? null;
  const [aspectos, setAspectos] = useState<Record<Aspecto, number | null>>({ notaComida: null, notaEquipe: null, notaEspaco: null });
  const [comentario, setComentario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmarSaida, setConfirmarSaida] = useState(false);

  useEffect(() => {
    if (!fragmento?.token) return;
    let vivo = true;
    postar<Abertura>("/api/satisfacao/abrir", { token: fragmento.token }).then((r) => {
      if (!vivo) return;
      if (!r.ok) setEstado({ fase: "indisponivel", mensagem: r.erro });
      else if (r.data.situacao === "RESPONDIDA") setEstado({ fase: "respondida", buffet: r.data.buffet, nome: null, notaBaixa: false });
      else setEstado({ fase: "aberta", dados: r.data });
    });
    return () => { vivo = false; };
  }, [fragmento]);

  async function enviar() {
    if (estado.fase !== "aberta" || !fragmento?.token) return;
    if (nota === null) { setErro("Escolha uma nota de 0 a 10."); return; }
    setEnviando(true);
    setErro(null);
    const r = await postar<{ gravada: true }>("/api/satisfacao/responder", { token: fragmento.token, notaIndicacao: nota, ...aspectos, comentario: comentario.trim() || null });
    setEnviando(false);
    if (r.ok || r.status === 409) setEstado({ fase: "respondida", buffet: estado.dados.buffet, nome: r.ok ? estado.dados.primeiroNome : null, notaBaixa: r.ok && nota <= 6 });
    else if (r.status === 404) setEstado({ fase: "indisponivel", mensagem: r.erro });
    else setErro(r.erro);
  }

  async function sair() {
    if (!fragmento?.token) return;
    setEnviando(true);
    const r = await postar<{ saiu: true }>("/api/satisfacao/sair", { token: fragmento.token, origem: "PAGINA" });
    setEnviando(false);
    if (r.ok) setEstado({ fase: "saiu" });
    else setErro(r.erro);
  }

  if (estado.fase === "carregando") {
    return <main className={s.pagina}><div className={s.coluna}><p className={s.aviso} aria-live="polite">Carregando a pesquisa…</p></div></main>;
  }
  if (estado.fase === "indisponivel" || estado.fase === "saiu") {
    return <main className={s.pagina}><div className={`${s.coluna} ${s.centro}`}>
      <h1 className={s.titulo}>{estado.fase === "saiu" ? "Pronto" : "Pesquisa indisponível"}</h1>
      <p className={s.texto} role={estado.fase === "saiu" ? "status" : "alert"}>
        {estado.fase === "saiu" ? "Você não vai mais receber pesquisas de satisfação deste buffet." : estado.mensagem}
      </p>
    </div></main>;
  }
  if (estado.fase === "respondida") {
    return <main className={s.pagina}><div className={`${s.coluna} ${s.centro}`}>
      <div className={s.check}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </div>
      <h1 className={s.titulo}>{estado.nome ? `Obrigado, ${estado.nome}!` : "Obrigado!"}</h1>
      <p className={s.texto} role="status">
        {estado.nome ? `Sua opinião chegou para a equipe do ${estado.buffet} e ajuda a melhorar as próximas festas.` : "Esta pesquisa já foi respondida."}
      </p>
      {estado.notaBaixa && <div className={s.cartaoAlerta}>
        <p className={s.textoCartao}>Sentimos muito que algo não saiu como esperado. A gerência da unidade vai entrar em contato com você.</p>
      </div>}
    </div></main>;
  }

  const { dados } = estado;
  return <main className={s.pagina}><div className={s.coluna}>
    <header className={s.cabecalho}>
      <div className={s.selo} aria-hidden="true">{iniciais(dados.buffet)}</div>
      <span className={s.sub}>{dados.unidade ? `${dados.buffet} · ${dados.unidade}` : dados.buffet}</span>
      <h1 className={s.titulo}>Como foi a sua festa, {dados.primeiroNome}?</h1>
      <span className={s.data}>{dataPorExtenso(dados.dataFesta)}{dados.dataFesta ? " · " : ""}leva 1 minuto</span>
    </header>

    <fieldset className={s.cartao}>
      <legend className={s.pergunta}>De 0 a 10, quanto você indicaria o {dados.buffet} a um amigo?</legend>
      <div className={s.notas}>
        {Array.from({ length: 11 }, (_, v) => <button key={v} type="button" className={s.nota} aria-pressed={nota === v} onClick={() => { setNota(v); setErro(null); }}>{v}</button>)}
      </div>
      <div className={s.escala} aria-hidden="true"><span>0 = nada provável</span><span>10 = com certeza</span></div>
    </fieldset>

    {ASPECTOS.map((a) => <fieldset key={a.campo} className={s.cartao}>
      <legend className={s.pergunta}>{a.rotulo} <span className={s.opcional}>(opcional)</span></legend>
      <div className={s.estrelas}>
        {[1, 2, 3, 4, 5].map((k) => <button key={k} type="button" className={s.estrela} aria-pressed={aspectos[a.campo] === k}
          aria-label={`${a.rotulo}: ${k} ${k === 1 ? "estrela" : "estrelas"}`}
          onClick={() => setAspectos((atual) => ({ ...atual, [a.campo]: atual[a.campo] === k ? null : k }))}>
          <Estrela cheia={(aspectos[a.campo] ?? 0) >= k} />
        </button>)}
      </div>
    </fieldset>)}

    <section className={s.cartao}>
      <label htmlFor="comentario" className={s.pergunta}>Quer contar mais alguma coisa? <span className={s.opcional}>(opcional)</span></label>
      <textarea id="comentario" className={s.comentario} rows={4} maxLength={2000} value={comentario} onChange={(e) => setComentario(e.target.value)}
        placeholder="Elogios, sugestões ou algo que não saiu como esperado" />
      <span className={s.contador} aria-hidden="true">{comentario.length}/2000</span>
    </section>

    {erro && <p className={s.erro} role="alert">{erro}</p>}
    <button type="button" className={s.botao} onClick={enviar} disabled={enviando}>{enviando ? "Enviando…" : "Enviar resposta"}</button>
    <p className={s.aviso}>Sua resposta fica ligada à sua festa para o buffet poder retornar, se precisar.</p>
    {!confirmarSaida
      ? <p className={s.aviso}><button type="button" className={s.link} onClick={() => setConfirmarSaida(true)}>Não quero receber pesquisas</button></p>
      : <section className={s.cartao} aria-label="Sair das pesquisas">
        <p className={s.textoCartao}>Você deixa de receber pesquisas de satisfação deste buffet, pelo WhatsApp e pelo e-mail.</p>
        <button type="button" className={s.botaoSecundario} onClick={sair} disabled={enviando}>Confirmar: não quero receber pesquisas</button>
      </section>}
  </div></main>;
}
