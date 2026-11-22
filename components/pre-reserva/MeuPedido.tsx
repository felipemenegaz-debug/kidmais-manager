"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { dialogo } from "@/components/JanelaConfirmacao";
import { useMarcaPublica } from "@/components/fechamento/MarcaPublica";
import FundoFesta from "@/components/site/FundoFesta";
import { fonteTexto, fonteTitulo } from "@/components/site/fonte";
import { PausaGlobal } from "@/components/site/PausaGlobal";
import { dataPorExtenso, reais } from "@/lib/area-familia/formato";
import { apiPublica } from "@/lib/fechamentos/rota-publica";
import { TEXTO_CONFERENCIA_PIX } from "@/lib/pre-reserva/termos";
import {
  acoesDoPedido, CODIGO_VENCIDO, corpoAceite, corpoCodigo, corpoDesistencia, corpoEntrada,
  formatarValidade, iniciarLeitura, MOTIVOS_OFERTA, PEDIDO_COMUM, relogioDoServidor, rotuloDinheiro, rotuloErro,
  rotuloGarantia, rotuloPedido, SESSAO_ENCERRADA, termosDaOferta, vencimentoDaGarantia,
  type CanalEntrada, type Desafio, type Oferta, type Pedido, type PedidosDaSessao, type Pix,
} from "./meu-pedido";
import familia from "../area-familia/AreaFamilia.module.css";
import styles from "./MeuPedido.module.css";

const BASE = "/api/meu-pedido";
const MENSAGEM_CODIGO = "Se for possível enviar o código para este CPF, ele chegará pelo canal escolhido. Se o envio pelo WhatsApp falhar, o código poderá chegar por e-mail.";

type Relogio = ReturnType<typeof relogioDoServidor>;
type Resposta<T> = ({ ok: true; data: T } | { ok: false; codigo: string; status: number }) & { relogio: Relogio };
type Sessao = { dados: PedidosDaSessao; relogio: NonNullable<Relogio> };
type Acao = { tipo: "aceite"; oferta: Oferta } | { tipo: "desistencia"; confirmado: boolean };
type PixDoPedido = { pedidoId: string; dados: Pix | null };

async function requisitar<T>(url: string, corpo?: object): Promise<Resposta<T>> {
  const resposta = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    // Com no-referrer, o navegador pode enviar Origin: null e o servidor recusa o POST.
    ...(corpo && { method: "POST", referrerPolicy: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }),
  }).catch(() => null);
  const relogio = relogioDoServidor(resposta?.headers.get("Date") ?? null);
  const json = await resposta?.json().catch(() => null) as { ok?: boolean; data: T; codigo?: string } | null;
  if (resposta?.ok && json?.ok) return { ok: true, data: json.data, relogio };
  return { ok: false, codigo: json?.codigo ?? "", status: resposta?.status ?? 0, relogio };
}

export default function MeuPedido({ empresa, logo }: { empresa: string | null; logo?: string | null }) {
  const marca = useMarcaPublica();
  const imagem = logo ?? (marca.kidmais ? "/assets/kidmais-logo-horizontal.png" : null);
  const leitura = useRef(0);
  const lendoPedidos = useRef(false);
  const gravando = useRef(false);
  const sessaoAtiva = useRef(false);
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [agoraExibido, setAgoraExibido] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [avisoEntrada, setAvisoEntrada] = useState("");
  const [erroLeitura, setErroLeitura] = useState("");
  const [erroAcao, setErroAcao] = useState<{ pedidoId: string; mensagem: string } | null>(null);
  const [pix, setPix] = useState<PixDoPedido | null>(null);
  const dados = sessao?.dados;

  const encerrarSessao = useCallback((avisar: boolean) => {
    iniciarLeitura(leitura);
    lendoPedidos.current = false;
    sessaoAtiva.current = false;
    setSessao(null);
    setPix(null);
    setErroAcao(null);
    setCarregando(false);
    if (avisar) setAvisoEntrada(SESSAO_ENCERRADA);
  }, []);

  const carregar = useCallback(async (aposEntrada = false) => {
    const atual = iniciarLeitura(leitura);
    lendoPedidos.current = true;
    setCarregando(true);
    setErroLeitura("");
    setPix(null);
    const resposta = await requisitar<PedidosDaSessao>(apiPublica(BASE, empresa));
    if (!atual()) return;
    lendoPedidos.current = false;
    setCarregando(false);
    if (resposta.ok && resposta.relogio) {
      sessaoAtiva.current = true;
      setSessao({ dados: resposta.data, relogio: resposta.relogio });
      setAgoraExibido(resposta.relogio());
      setAvisoEntrada("");
    } else if (!resposta.ok && resposta.codigo === "SESSAO_ENCERRADA") {
      encerrarSessao(aposEntrada || sessaoAtiva.current);
    } else {
      // Sem uma referência do servidor, não há como limitar a exibição à vigência da sessão.
      setSessao(null);
      setErroLeitura(rotuloErro(resposta.ok ? "" : resposta.codigo));
    }
  }, [empresa, encerrarSessao]);

  useEffect(() => {
    // O cookie é restrito à API, inclusive na primeira visita.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar();
    return () => { iniciarLeitura(leitura); };
  }, [carregar]);

  useEffect(() => {
    if (!sessao) return;
    const { dados, relogio } = sessao;
    const expiraEm = Date.parse(dados.expiraEm);
    const proximaGarantia = dados.pedidos.reduce((maisProxima, pedido) =>
      Math.min(maisProxima, vencimentoDaGarantia(pedido) ?? Infinity), Infinity);
    const agendar = (prazo: number, atualizar: () => void) =>
      setTimeout(atualizar, Math.max(0, Math.ceil(prazo - relogio())));
    const sessaoTimer = agendar(expiraEm, () => {
      encerrarSessao(true);
      void carregar(true);
    });
    const garantiaTimer = proximaGarantia < expiraEm ? agendar(proximaGarantia, () => {
      setAgoraExibido(Math.max(proximaGarantia, relogio()));
      void carregar();
    }) : undefined;
    return () => {
      clearTimeout(sessaoTimer);
      clearTimeout(garantiaTimer);
    };
  }, [sessao, carregar, encerrarSessao]);

  function agoraParaAgir() {
    if (!sessao || !sessaoAtiva.current || lendoPedidos.current || gravando.current) return null;
    const agora = sessao.relogio();
    return agora < Date.parse(sessao.dados.expiraEm) ? agora : null;
  }

  async function gravar(pedido: Pedido, acao: Acao) {
    const corpo = acao.tipo === "aceite" ? corpoAceite(acao.oferta) : corpoDesistencia(acao.confirmado);
    const agora = agoraParaAgir();
    if (!corpo || agora === null || (acao.tipo === "desistencia" && !acoesDoPedido(pedido, agora).desistir)) return;
    iniciarLeitura(leitura);
    gravando.current = true;
    setOcupado(true);
    setPix(null);
    setErroAcao(null);
    try {
      const resposta = await requisitar(apiPublica(`${BASE}/${encodeURIComponent(pedido.id)}/${acao.tipo}`, empresa), corpo);
      if (!resposta.ok && resposta.codigo === "SESSAO_ENCERRADA") {
        encerrarSessao(true);
      } else if (!resposta.ok && sessaoAtiva.current) {
        setErroAcao({ pedidoId: pedido.id, mensagem: rotuloErro(resposta.codigo) });
      }
    } finally {
      // O estado depois de qualquer tentativa de gravação sempre vem de uma nova leitura.
      await carregar();
      gravando.current = false;
      setOcupado(false);
    }
  }

  async function verPix(pedido: Pedido) {
    const aceite = pedido.preReserva.aceite;
    if (!aceite || agoraParaAgir() === null) return;
    const atual = iniciarLeitura(leitura);
    setErroAcao(null);
    setPix({ pedidoId: pedido.id, dados: null });
    const resposta = await requisitar<Pix>(apiPublica(`${BASE}/${encodeURIComponent(pedido.id)}/pix`, empresa));
    if (!atual()) return;
    if (resposta.ok && resposta.data.aceiteSequencia === aceite.sequencia) {
      setPix({ pedidoId: pedido.id, dados: resposta.data });
      return;
    }
    setPix(null);
    if (!resposta.ok && resposta.codigo === "SESSAO_ENCERRADA") return encerrarSessao(true);
    const mensagem = resposta.ok ? "O aceite do Pix mudou. Confira o estado atualizado do pedido." : rotuloErro(resposta.codigo);
    setErroAcao({ pedidoId: pedido.id, mensagem });
    if (resposta.ok || resposta.status === 409) await carregar();
  }

  return (
    <main className={`${familia.page} ${styles.page} ${fonteTitulo.variable} ${fonteTexto.variable}`} data-site-venda>
      <FundoFesta />
      <header className={familia.topo}>
        <div className={familia.topoInterno}>
          <div className={familia.buffet}>
            {/* Mesmo logo público do cabeçalho do buffet na área da família. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {imagem ? <img className={familia.logo} src={imagem} alt="" /> : null}
            <strong className={styles.nome}>{marca.nome}</strong>
          </div>
          <PausaGlobal classe={familia.pausa} classeTexto={familia.pausaTexto} />
        </div>
      </header>
      <div className={dados ? familia.shell : `${familia.shell} ${familia.shellEstreito}`}>
        <section className={familia.cartao} aria-labelledby="titulo-meu-pedido">
          <h1 id="titulo-meu-pedido" className={familia.titulo}>{dados ? "Meus pedidos" : "Meu pedido"}</h1>
          {carregando && <p className={familia.texto} role="status">Carregando pedidos…</p>}
          {erroAcao && !dados?.pedidos.some(pedido => pedido.id === erroAcao.pedidoId)
            ? <p className={familia.erro} role="alert">{erroAcao.mensagem}</p> : null}
          {erroLeitura && (
            <>
              <p className={familia.erro} role="alert">{erroLeitura}</p>
              <button type="button" className={familia.secundario} disabled={ocupado} onClick={() => void carregar()}>Tentar novamente</button>
            </>
          )}
          {!carregando && !dados && !erroLeitura && (
            <Entrada empresa={empresa} aviso={avisoEntrada} aoEntrar={() => carregar(true)} />
          )}
          {dados && (
            <>
              <p className={familia.texto}>{PEDIDO_COMUM}</p>
              {dados.pedidos.length === 0
                ? <p className={familia.vazio}>Você ainda não tem pedidos para acompanhar neste buffet.</p>
                : <ul className={familia.parcelas}>
                  {dados.pedidos.map(pedido => (
                    <li key={pedido.id} className={familia.parcela}>
                      <CartaoPedido
                        pedido={pedido}
                        agora={agoraExibido}
                        ocupado={carregando || ocupado}
                        erro={erroAcao?.pedidoId === pedido.id ? erroAcao.mensagem : ""}
                        pix={pix?.pedidoId === pedido.id ? pix : null}
                        gravar={(acao) => gravar(pedido, acao)}
                        verPix={() => verPix(pedido)}
                      />
                    </li>
                  ))}
                </ul>}
              <button type="button" className={familia.secundario} disabled={carregando || ocupado} onClick={() => {
                setErroAcao(null);
                void carregar();
              }}>Atualizar pedidos</button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export function Entrada({ empresa, aviso, aoEntrar }: { empresa: string | null; aviso: string; aoEntrar: () => Promise<void> }) {
  const campoErro = useId();
  const enviando = useRef(false);
  const [cpf, setCpf] = useState("");
  const [canal, setCanal] = useState<CanalEntrada | "">("");
  const [desafio, setDesafio] = useState<Desafio | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (enviando.current) return;
    enviando.current = true;
    setOcupado(true);
    setErro("");
    try {
      if (desafio) {
        const resposta = await requisitar(apiPublica(`${BASE}/entrada/confirmar`, empresa), corpoCodigo(desafio.desafio, codigo));
        if (resposta.ok) await aoEntrar();
        else if (resposta.codigo === "CODIGO_NAO_CONFIRMADO" && resposta.relogio && Date.parse(desafio.expiraEm) <= resposta.relogio()) setErro(CODIGO_VENCIDO);
        else setErro(rotuloErro(resposta.codigo));
      } else if (canal) {
        const resposta = await requisitar<Desafio>(apiPublica(`${BASE}/entrada/iniciar`, empresa), corpoEntrada(cpf, canal));
        if (resposta.ok) setDesafio(resposta.data);
        else setErro(resposta.codigo === "DADOS_INVALIDOS" ? "Confira se o CPF está correto." : rotuloErro(resposta.codigo));
      }
    } finally {
      enviando.current = false;
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={enviar}>
      {aviso && <p className={familia.erro} role="status">{aviso}</p>}
      <p className={familia.texto} role={desafio ? "status" : undefined}>
        {desafio ? MENSAGEM_CODIGO : "Informe seu CPF para acompanhar seus pedidos."}
      </p>
      {desafio ? (
        <label key="codigo" className={familia.campo}>
          Código de seis números
          <input inputMode="numeric" autoComplete="one-time-code" value={codigo} maxLength={6}
            required pattern="[0-9]{6}" disabled={ocupado} aria-invalid={Boolean(erro)} aria-describedby={erro ? campoErro : undefined}
            onChange={e => setCodigo(e.target.value.replace(/\D/g, ""))} />
        </label>
      ) : (
        <>
          <label key="cpf" className={familia.campo}>
            CPF
            <input inputMode="numeric" autoComplete="off" value={cpf} maxLength={14} required disabled={ocupado}
              aria-invalid={Boolean(erro)} aria-describedby={erro ? campoErro : undefined}
              onChange={e => setCpf(e.target.value)} />
          </label>
          <label className={familia.campo}>
            Como você quer receber o código?
            <select className={styles.canal} value={canal} required disabled={ocupado} onChange={e => {
              const valor = e.target.value;
              setCanal(valor === "WHATSAPP" || valor === "EMAIL" ? valor : "");
            }}>
              <option value="" disabled>Escolha um canal</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">E-mail</option>
            </select>
          </label>
        </>
      )}
      {erro && <p id={campoErro} className={familia.erro} role="alert">{erro}</p>}
      <button className={familia.botao} type="submit" disabled={ocupado || (desafio ? codigo.length !== 6 : !cpf.trim() || !canal)}>
        {desafio ? "Entrar" : "Receber código"}
      </button>
      {desafio && <button className={familia.secundario} type="button" disabled={ocupado} onClick={() => {
        setDesafio(null);
        setCodigo("");
        setErro("");
      }}>Pedir outro código</button>}
    </form>
  );
}

export function CartaoPedido({ pedido, agora, ocupado, erro, pix, gravar, verPix }: {
  pedido: Pedido;
  agora: number;
  ocupado: boolean;
  erro: string;
  pix: PixDoPedido | null;
  gravar: (acao: Acao) => Promise<void>;
  verPix: () => Promise<void>;
}) {
  const { oferta, preReserva } = pedido;
  const { aceite, garantia, dinheiro, aguardandoConferencia, novoAceiteNecessario } = preReserva;
  const acoes = acoesDoPedido(pedido, agora);
  const vencimento = vencimentoDaGarantia(pedido);
  const atualizandoGarantia = vencimento !== null && vencimento <= agora;
  const sinais = atualizandoGarantia ? dinheiro.filter(sinal => sinal.situacao !== "EM_GARANTIA") : dinheiro;
  const validade = garantia?.ate ? formatarValidade(garantia.ate) : null;
  const erroId = useId();

  async function desistir(gatilho: HTMLButtonElement) {
    const confirmado = await dialogo.confirmar("Confirmar desistência da garantia",
      "O horário será liberado e o sinal ficará a devolver. Seu pedido pode seguir em negociação.", undefined, gatilho);
    if (confirmado) await gravar({ tipo: "desistencia", confirmado });
  }

  return (
    <>
      <h2 className={styles.protocolo}>{pedido.protocolo}</h2>
      <dl className={familia.lista}>
        <div><dt>Data</dt><dd>{dataPorExtenso(pedido.data)}</dd></div>
        <div><dt>Horário</dt><dd>{pedido.inicio.slice(0, 5)} às {pedido.fim.slice(0, 5)}</dd></div>
        <div><dt>Unidade</dt><dd>{pedido.unidade ?? "A definir"}</dd></div>
        <div><dt>Salão</dt><dd>{pedido.salao ?? "A definir"}</dd></div>
        <div><dt>Situação do pedido</dt><dd>{rotuloPedido(pedido.status)}</dd></div>
      </dl>
      <h3 className={familia.subtitulo}>Pré-reserva</h3>
      {erro && <p id={erroId} className={familia.erro} role="alert">{erro}</p>}
      {atualizandoGarantia ? <p className={familia.texto} role="status">Atualizando a situação da garantia…</p> : garantia && (
        <p className={familia.texto}>
          <strong>{rotuloGarantia(garantia.situacao)}</strong>
          {garantia.situacao === "ATIVA" && validade ? <> até <time dateTime={garantia.ate ?? undefined}>{validade}</time> (horário de Brasília).</> : null}
        </p>
      )}
      {sinais.length > 0 && (
        <dl className={familia.lista}>
          {sinais.map((sinal, indice) => (
            <div key={indice}><dt>{rotuloDinheiro(sinal.situacao)}</dt><dd>{reais(sinal.valorCentavos)}</dd></div>
          ))}
        </dl>
      )}
      {!oferta.disponivel && (oferta.motivo !== "GARANTIA_EXISTENTE" || !garantia) && (
        <p className={familia.texto}>{MOTIVOS_OFERTA[oferta.motivo]}</p>
      )}
      {novoAceiteNecessario && (
        <p className={familia.texto}>A oferta mudou ou foi reaberta. O QR Code só fica disponível após o novo aceite.</p>
      )}
      {acoes.aceitar && oferta.disponivel && (
        <AceitarOferta key={oferta.versaoOferta} oferta={oferta} ocupado={ocupado} erroId={erro ? erroId : undefined}
          aceitar={() => gravar({ tipo: "aceite", oferta })} />
      )}
      {aguardandoConferencia && aceite && (
        <div className={familia.pix}>
          <h4 className={styles.protocolo}>Aceite registrado. Aguardando conferência do sinal.</h4>
          {!pix?.dados && <p className={familia.texto}>{reais(aceite.sinalCentavos)} · {TEXTO_CONFERENCIA_PIX}</p>}
          {acoes.pix ? (
            pix ? pix.dados ? <PixDoSinal dados={pix.dados} /> : <p role="status">Montando o Pix…</p>
              : <button type="button" className={familia.botao} disabled={ocupado} onClick={() => void verPix()}>Ver Pix do sinal</button>
          ) : <p className={familia.texto}>{rotuloErro("PIX_INDISPONIVEL")}</p>}
        </div>
      )}
      {acoes.desistir && (
        <button type="button" className={familia.secundario} disabled={ocupado} onClick={e => void desistir(e.currentTarget)}>
          Desistir da garantia
        </button>
      )}
    </>
  );
}

export function AceitarOferta({ oferta, ocupado, erroId, aceitar }: {
  oferta: Oferta; ocupado: boolean; erroId?: string; aceitar: () => Promise<void>;
}) {
  const [aceitou, setAceitou] = useState(false);
  return (
    <form onSubmit={evento => {
      evento.preventDefault();
      if (!aceitou || ocupado) return;
      setAceitou(false);
      void aceitar();
    }}>
      <h4 className={styles.protocolo}>Oferta de pré-reserva disponível</h4>
      <dl className={familia.lista}>
        <div><dt>Valor do sinal</dt><dd>{reais(oferta.sinalCentavos)}</dd></div>
        <div><dt>Quem recebe</dt><dd>{oferta.recebedor.nome} · {oferta.recebedor.cidade}</dd></div>
      </dl>
      <h4 className={styles.protocolo}>Termos da pré-reserva</h4>
      <p className={`${familia.texto} ${familia.textoLivre}`}>{termosDaOferta(oferta)}</p>
      <label className={`${familia.lembrar} ${styles.aceite}`}>
        <input type="checkbox" checked={aceitou} required disabled={ocupado} aria-describedby={erroId} onChange={e => setAceitou(e.target.checked)} />
        Li e aceito os termos da pré-reserva
      </label>
      <button type="submit" className={familia.botao} disabled={!aceitou || ocupado}>Aceitar pré-reserva</button>
      <p className={styles.semSinal}>Você pode seguir sem pré-reserva e sem pagar o sinal.</p>
    </form>
  );
}

export function PixDoSinal({ dados }: { dados: Pix }) {
  const [aviso, setAviso] = useState("");
  async function copiar() {
    try {
      await navigator.clipboard.writeText(dados.copiaECola);
      setAviso("Pix copia e cola copiado.");
    } catch {
      setAviso("A cópia automática falhou. Selecione e copie o código no campo.");
    }
  }
  return (
    <>
      {/* SVG gerado no servidor por qrSvg (lib/pagamentos/pix/brcode.ts), só retângulos: sem texto do usuário. */}
      <div className={familia.qr} role="img" aria-label="QR Code do Pix" dangerouslySetInnerHTML={{ __html: dados.qrSvg }} />
      <label className={familia.campo}>
        Pix copia e cola
        <textarea className={styles.codigoPix} value={dados.copiaECola} readOnly rows={3} />
      </label>
      <button type="button" className={familia.botao} onClick={() => void copiar()}>Copiar Pix copia e cola</button>
      {aviso && <p role="status" className={familia.ajuda}>{aviso}</p>}
      <p className={styles.semSinal}>{reais(dados.valorCentavos)} · {TEXTO_CONFERENCIA_PIX}</p>
    </>
  );
}
