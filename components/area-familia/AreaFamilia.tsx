"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { contagem, dataCurta, dataPorExtenso, reais, ROTULO_ESTADO } from "@/lib/area-familia/formato";
import type { MinhaFesta, ParcelaFamilia } from "@/lib/area-familia/leitura";
import { MarcaPublicaCabecalho, useMarcaPublica } from "@/components/fechamento/MarcaPublica";
import styles from "./AreaFamilia.module.css";

type Sessao = { papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL"; primeiroNome: string } | null;
type Dados = MinhaFesta | null;

async function postar(url: string, corpo: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), credentials: "same-origin" });
  const json = (await r.json().catch(() => null)) as { ok?: boolean; erro?: string; validacaoId?: string; destinoMascarado?: string } | null;
  return { ok: r.ok && json?.ok === true, json };
}

/**
 * Área "Minha festa": entrada por link + documento + código (F1); logado, as abas de leitura Início, Festa, Pagamentos e
 * Documentos (F2), com a marca do buffet. Os dados chegam prontos do servidor (só o mínimo; nada de CPF nem contato).
 * O token do link fica no fragmento (#), que o navegador nunca manda ao servidor nem a terceiros.
 */
export default function AreaFamilia({ empresa, sessao, dados = null }: { empresa: string; sessao: Sessao; dados?: Dados }) {
  const base = `/b/${empresa}/minha-festa`;
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <MarcaPublicaCabecalho subtitle="Minha festa" />
        <section className={styles.cartao}>
          {sessao ? <Logado base={base} sessao={sessao} dados={dados} /> : <Entrada base={base} />}
        </section>
      </div>
    </main>
  );
}

const ABAS = [
  { id: "inicio", rotulo: "Início" },
  { id: "festa", rotulo: "Festa" },
  { id: "pagamentos", rotulo: "Pagamentos" },
  { id: "documentos", rotulo: "Documentos" },
] as const;
type Aba = (typeof ABAS)[number]["id"];

const CLASSE_ESTADO: Record<ParcelaFamilia["estado"], string> = {
  PAGA: styles.estadoPaga, EM_ABERTO: styles.estadoAberto, VENCIDA: styles.estadoVencida, FUTURA: styles.estadoFutura, CANCELADA: styles.estadoCancelada,
};

function Logado({ base, sessao, dados }: { base: string; sessao: NonNullable<Sessao>; dados: Dados }) {
  const marca = useMarcaPublica();
  const [aba, setAba] = useState<Aba>("inicio");
  const [ocupado, setOcupado] = useState(false);
  async function sair(todos: boolean) {
    setOcupado(true);
    await postar(`${base}/api/sair`, { todos });
    window.location.replace(base);
  }
  const whatsapp = marca.contato?.whatsapp ?? null;
  return (
    <>
      <h1 className={styles.titulo}>{sessao.primeiroNome ? `Olá, ${sessao.primeiroNome}!` : "Olá!"}</h1>
      <p className={styles.texto}>Esta é a área da sua festa{marca.kidmais ? "" : ` com ${marca.nome}`}.</p>
      {!dados ? (
        <div className={styles.vazio}>Não conseguimos carregar os dados da festa agora. Tente de novo em alguns minutos.</div>
      ) : (
        <>
          <nav className={styles.abas} aria-label="Seções da festa">
            {ABAS.map((a) => (
              <button key={a.id} type="button" className={aba === a.id ? `${styles.aba} ${styles.abaAtiva}` : styles.aba} aria-pressed={aba === a.id} onClick={() => setAba(a.id)}>
                {a.rotulo}
              </button>
            ))}
          </nav>
          {aba === "inicio" ? <Inicio dados={dados} irPara={setAba} /> : null}
          {aba === "festa" ? <Festa dados={dados} /> : null}
          {aba === "pagamentos" ? <Pagamentos base={base} dados={dados} /> : null}
          {aba === "documentos" ? <Documentos base={base} dados={dados} /> : null}
        </>
      )}
      {whatsapp ? (
        <a className={styles.botaoLink} href={whatsapp.url} target="_blank" rel="noopener noreferrer">Falar com o buffet no WhatsApp</a>
      ) : null}
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => sair(false)}>Sair deste aparelho</button>
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => sair(true)}>Sair de todos os aparelhos</button>
    </>
  );
}

function Inicio({ dados, irPara }: { dados: MinhaFesta; irPara: (aba: Aba) => void }) {
  const { festa, pagamentos } = dados;
  const proxima = pagamentos.proxima;
  return (
    <div className={styles.secao}>
      <div className={styles.destaque}>
        <strong>{contagem(festa.diasAteFesta)}</strong>
        <span>{dataPorExtenso(festa.data)}{festa.horarioInicio ? `, das ${festa.horarioInicio}${festa.horarioFim ? ` às ${festa.horarioFim}` : ""}` : ""}</span>
        {festa.salao ? <span>{festa.salao}</span> : null}
      </div>
      <dl className={styles.lista}>
        <div><dt>Aniversariante</dt><dd>{festa.aniversariante}</dd></div>
        {festa.tema ? <div><dt>Tema</dt><dd>{festa.tema}</dd></div> : null}
      </dl>
      <h2 className={styles.subtitulo}>Próximo pagamento</h2>
      {proxima ? (
        <button type="button" className={styles.linhaBotao} onClick={() => irPara("pagamentos")}>
          <span>Parcela {proxima.numero} · vence {dataCurta(proxima.vencimento)}</span>
          <strong>{reais(proxima.saldoCentavos)}</strong>
        </button>
      ) : (
        <p className={styles.texto}>{pagamentos.parcelas.length ? "Tudo pago. Obrigado!" : "Nenhuma parcela cadastrada."}</p>
      )}
    </div>
  );
}

function Festa({ dados }: { dados: MinhaFesta }) {
  const { festa } = dados;
  return (
    <div className={styles.secao}>
      <dl className={styles.lista}>
        <div><dt>Data</dt><dd>{dataPorExtenso(festa.data)}</dd></div>
        {festa.horarioInicio ? <div><dt>Horário</dt><dd>{festa.horarioInicio}{festa.horarioFim ? ` às ${festa.horarioFim}` : ""}</dd></div> : null}
        {festa.salao ? <div><dt>Salão</dt><dd>{festa.salao}</dd></div> : null}
        <div><dt>Aniversariante</dt><dd>{festa.aniversariante}</dd></div>
        {festa.tema ? <div><dt>Tema</dt><dd>{festa.tema}</dd></div> : null}
        <div><dt>Pacote</dt><dd>{festa.pacote}</dd></div>
        <div><dt>Convidados</dt><dd>{festa.convidados}</dd></div>
      </dl>
      {festa.adicionais.length ? (
        <>
          <h2 className={styles.subtitulo}>Adicionais</h2>
          <ul className={styles.itens}>
            {festa.adicionais.map((a, i) => <li key={`${a.nome}-${i}`}>{a.quantidade > 1 ? `${a.quantidade} × ` : ""}{a.nome}</li>)}
          </ul>
        </>
      ) : null}
      <h2 className={styles.subtitulo}>Buffet combinado</h2>
      {festa.buffet.length ? (
        <dl className={styles.lista}>
          {festa.buffet.map((b) => <div key={b.campo}><dt>{b.campo}</dt><dd className={styles.textoLivre}>{b.texto}</dd></div>)}
        </dl>
      ) : (
        <p className={styles.texto}>O buffet ainda vai combinar o cardápio com você.</p>
      )}
    </div>
  );
}

type Pix = { copiaECola: string; qrSvg: string; valorCentavos: number; parcela: { numero: number }; recebedor: { nome: string; chaveMascarada: string } };
type PixDaParcela = Pix & { parcelaId: string };

function Pagamentos({ base, dados }: { base: string; dados: MinhaFesta }) {
  const { pagamentos } = dados;
  const [aberto, setAberto] = useState<string | null>(null);
  const [pix, setPix] = useState<PixDaParcela | null>(null);
  const pedidoAtual = useRef(0);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  async function verPix(parcelaId: string, numero: number) {
    // Cada clique invalida o anterior: resposta que chega depois de outro clique é descartada, e o Pix guardado fica
    // preso à parcela pedida (e confere o número devolvido), para nunca aparecer o QR de uma parcela sob outra.
    const pedido = ++pedidoAtual.current;
    setAberto(parcelaId); setPix(null); setErro(null); setCopiado(false);
    const r = await fetch(`${base}/api/pix?parcela=${encodeURIComponent(parcelaId)}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    const json = r ? (await r.json().catch(() => null)) as ({ ok?: boolean; erro?: string } & Partial<Pix>) | null : null;
    if (pedido !== pedidoAtual.current) return;
    if (!r?.ok || !json?.ok || !json.copiaECola || json.parcela?.numero !== numero) { setErro(json?.erro ?? "Não foi possível montar o Pix."); return; }
    setPix({ ...(json as Pix), parcelaId });
  }
  async function copiar() {
    if (!pix) return;
    try { await navigator.clipboard.writeText(pix.copiaECola); setCopiado(true); } catch { setCopiado(false); }
  }
  return (
    <div className={styles.secao}>
      <dl className={styles.lista}>
        <div><dt>Total</dt><dd>{reais(pagamentos.totalCentavos)}</dd></div>
        <div><dt>Já pago</dt><dd>{reais(pagamentos.pagoCentavos)}</dd></div>
        <div><dt>Falta pagar</dt><dd>{reais(pagamentos.saldoCentavos)}</dd></div>
      </dl>
      {pagamentos.parcelas.length === 0 ? <p className={styles.texto}>Nenhuma parcela cadastrada.</p> : null}
      <ul className={styles.parcelas}>
        {pagamentos.parcelas.map((p) => (
          <li key={p.id} className={styles.parcela}>
            <div className={styles.parcelaLinha}>
              <span>Parcela {p.numero} · {dataCurta(p.vencimento)}</span>
              <span className={`${styles.estado} ${CLASSE_ESTADO[p.estado]}`}>{ROTULO_ESTADO[p.estado]}</span>
            </div>
            <div className={styles.parcelaLinha}>
              <strong>{reais(p.estado === "PAGA" ? p.valorCentavos : p.saldoCentavos)}</strong>
              {p.pix ? <button type="button" className={styles.pequeno} onClick={() => verPix(p.id, p.numero)}>Pagar com Pix</button> : null}
            </div>
            {aberto === p.id ? (
              <div className={styles.pix}>
                {erro ? <p className={styles.erro} role="alert">{erro}</p> : null}
                {!erro && pix?.parcelaId !== p.id ? <p className={styles.texto}>Montando o Pix…</p> : null}
                {pix?.parcelaId === p.id ? (
                  <>
                    {/* SVG gerado no servidor por qrSvg (lib/pagamentos/pix/brcode.ts), só retângulos: sem texto do usuário. */}
                    <div className={styles.qr} role="img" aria-label="QR Code do Pix" dangerouslySetInnerHTML={{ __html: pix.qrSvg }} />
                    <p className={styles.texto}>{reais(pix.valorCentavos)} para {pix.recebedor.nome} (chave {pix.recebedor.chaveMascarada}).</p>
                    <button type="button" className={styles.botao} onClick={copiar}>{copiado ? "Copiado!" : "Copiar Pix copia e cola"}</button>
                    <p className={styles.ajuda}>Depois de pagar, avise o buffet. A baixa da parcela é feita pela equipe.</p>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Documentos({ base, dados }: { base: string; dados: MinhaFesta }) {
  const url = (d: MinhaFesta["documentos"][number]) =>
    d.tipo === "comprovante" ? `${base}/api/documento?tipo=comprovante&id=${encodeURIComponent(d.id)}` : `${base}/api/documento?tipo=${d.tipo}`;
  return (
    <div className={styles.secao}>
      {dados.assinadoEmPapel ? <p className={styles.texto}>Seu contrato foi assinado em papel. O original fica com você e com o buffet.</p> : null}
      <ul className={styles.parcelas}>
        {dados.documentos.map((d) => (
          <li key={d.tipo === "comprovante" ? d.id : d.tipo}>
            <a className={styles.linhaBotao} href={url(d)} target="_blank" rel="noopener">
              <span>{d.titulo}</span>
              <strong>Abrir PDF</strong>
            </a>
          </li>
        ))}
      </ul>
    </div>
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
