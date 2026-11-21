"use client";
import { adminFetch } from "@/lib/http/admin-fetch";

import { MOTIVOS_PERDA } from '@/lib/oportunidades/modelo';
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AprovacaoNegociacaoRecord, FechamentoRecord } from "@/lib/fechamentos/repositories/models";
import { calcularCondicaoComercial, centavosComerciais } from "@/lib/comercial/condicao-pagamento";
import { formatarMoeda, formatarCondicaoPix, formatarFormaPagamento } from "@/lib/contratos/documento/formatters";
import { pedidoDaUrl } from "./contrato-url";
import { RevisaoPreReserva } from "./RevisaoPreReserva";
import type { RevisaoPreReserva as DadosPreReserva } from "@/lib/pre-reserva/apresentacao-admin";
import styles from "./RevisaoComercial.module.css";

type Dados = { recusa?: 'SEM_CONTRATO' | 'COM_PREPARACAO' | 'INDISPONIVEL'; fechamento: FechamentoRecord; aprovacoes: AprovacaoNegociacaoRecord[]; preReserva?: DadosPreReserva };
const listaContratos = "/admin/contratos";
const urlFechamento = (id: string) => `/api/admin/fechamentos/${encodeURIComponent(id)}`;

function permiteAtalho(dados: Dados | null) {
  if (!dados) return false;
  const { status } = dados.fechamento;
  if (status === "AGUARDANDO_CONTRATO") return dados.recusa !== "SEM_CONTRATO";
  return ["CONTRATO_ASSINADO", "AGUARDANDO_PAGAMENTO", "CONFIRMADO"].includes(status);
}

function urlDoContrato(id: unknown) {
  if (typeof id !== "string") return listaContratos;
  const params = new URLSearchParams({ contratoId: id });
  const pedido = pedidoDaUrl(params);
  return pedido.tipo === "contrato" ? `${listaContratos}?contratoId=${encodeURIComponent(pedido.contratoId)}` : listaContratos;
}

export default function RevisaoComercial({ fechamentoId }: { fechamentoId: string }) {
  const [dadosLidos, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [base, setBase] = useState("");
  const [entrada, setEntrada] = useState("");
  const [parcela, setParcela] = useState("");
  const [quantidade, setQuantidade] = useState("");
  const [motivo, setMotivo] = useState("");
  const [conferido, setConferido] = useState(false);
  const [atalhoContrato, setAtalhoContrato] = useState<{ fechamentoId: string; href: string } | null>(null);
  const idNaUrl = encodeURIComponent(fechamentoId);
  const chave = fechamentoId.toLowerCase();
  const pedidoVisivel = useRef<{ chave: string; id: string } | null>(null);
  const geracaoRevisao = useRef(0);
  // Uma entrada nula representa uma consulta de contrato em andamento.
  const atalhos = useRef(new Map<string, string | null>());
  const atualizar = useCallback(async (cargaInicial = false) => {
    const alvo = pedidoVisivel.current;
    if (!alvo) return;
    const { chave, id } = alvo;
    const geracao = ++geracaoRevisao.current;
    const vigente = () => pedidoVisivel.current?.chave === chave && geracaoRevisao.current === geracao;
    let revisao: Dados;
    try {
      const r = await adminFetch(`${urlFechamento(id)}/revisao`, { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.erro);
      revisao = body.data;
    } catch (e) {
      if (!vigente()) return;
      if (!cargaInicial) throw e;
      setErro(e instanceof Error ? e.message : "Falha ao carregar a revisão.");
      return;
    }
    if (!vigente()) return;
    setDados(revisao);

    if (permiteAtalho(revisao)) {
      const conhecido = atalhos.current.get(chave);
      if (conhecido) setAtalhoContrato({ fechamentoId: chave, href: conhecido });
      if (conhecido !== undefined) return revisao.preReserva;
      atalhos.current.set(chave, null);
      const { status } = revisao.fechamento;
      void (async () => {
        let href = revisao.recusa === "COM_PREPARACAO" || status !== "AGUARDANDO_CONTRATO" ? listaContratos : null;
        try {
          const resposta = await adminFetch(`/api/admin/contratos?fechamentoId=${encodeURIComponent(id)}`, { cache: "no-store" });
          if (resposta.ok) {
            const contrato = await resposta.json();
            href = urlDoContrato(contrato.data?.versao?.contratoId);
          }
        } catch { /* A consulta do atalho é opcional para a revisão. */ }
        if (atalhos.current.get(chave) !== null) return;
        if (pedidoVisivel.current?.chave === chave && href !== null) {
          atalhos.current.set(chave, href);
          setAtalhoContrato({ fechamentoId: chave, href });
        } else {
          atalhos.current.delete(chave);
        }
      })();
    }
    return revisao.preReserva;
  }, []);
  useLayoutEffect(() => {
    pedidoVisivel.current = { chave, id: fechamentoId };
    void atualizar(true);
    return () => {
      pedidoVisivel.current = null;
    };
  }, [atualizar, chave, fechamentoId]);
  const dados = dadosLidos?.fechamento.id.toLowerCase() === chave ? dadosLidos : null;
  const f = dados?.fechamento;
  const dialogo = useRef<HTMLDialogElement>(null);
  const [motivoPerda, setMotivoPerda] = useState('');
  const [observacao, setObservacao] = useState('');
  const enviando = useRef(false);
  async function recusar() {
    if (!f || enviando.current || !motivoPerda || (motivoPerda === 'Outro' && !observacao.trim())) return;
    enviando.current = true;
    setOcupado(true);
    setErro('');
    try {
      const r = await adminFetch(`${urlFechamento(f.id)}/recusar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: motivoPerda, observacao: observacao.trim() }),
      });
      const body = await r.json();
      dialogo.current?.close();
      if (!r.ok) {
        if ([403, 409, 503].includes(r.status)) await atualizar();
        throw new Error(body.erro);
      }
      if (pedidoVisivel.current?.chave === chave) {
        setDados(null);
        setMensagem('Pedido recusado.');
      }
      await atualizar();
    } catch (e) {
      dialogo.current?.close();
      setErro(e instanceof Error ? e.message : 'Falha ao recusar o pedido.');
    } finally {
      setOcupado(false);
      enviando.current = false;
    }
  }
  const hrefContrato = atalhoContrato?.fechamentoId === chave && permiteAtalho(dados) ? atalhoContrato.href : null;
  const podeRecusar = dados?.recusa === 'SEM_CONTRATO' || dados?.recusa === 'COM_PREPARACAO';
  const condicao = f?.condicaoPagamento;
  const pendente = dados?.aprovacoes.find((a) => a.status === "PENDENTE" && a.condicaoPagamento);
  let previa = null;
  if (f && condicao) {
    try { previa = calcularCondicaoComercial(base ? centavosComerciais(base.replace(",", ".")) / 100 : f.valorAprovado ?? f.valorTabela, condicao.forma, condicao.descontoPercentual); }
    catch { /* Entrada parcial durante digitação. */ }
  }
  async function decidir(decisao: "APROVAR" | "RECUSAR") {
    if (!pendente || !f) return;
    setOcupado(true); setErro(""); setMensagem("");
    try {
      if (!motivo.trim() || !conferido) throw new Error("Informe o motivo e confirme a conferência comercial.");
      const r = await adminFetch(`${urlFechamento(f.id)}/revisao`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        solicitacaoId: pendente.id, decisao, motivo,
        ...(decisao === "APROVAR" ? {
          ...(base ? { valorBaseAprovado: base.replace(",", ".") } : {}),
          condicaoAprovada: condicao?.forma === "PIX_PARCELADO" ? {
            entrada: entrada ? entrada.replace(",", ".") : null,
            valorParcela: parcela ? parcela.replace(",", ".") : null,
            quantidadeParcelas: quantidade ? Number(quantidade) : null,
          } : null,
        } : {}),
      }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.erro);
      await atualizar();
      setMensagem("Decisão registrada. Nenhum pagamento foi criado.");
    } catch (e) { setErro(e instanceof Error ? e.message : "Falha na revisão."); }
    finally { setOcupado(false); }
  }
  async function gerarContrato() {
    if (!f) return;
    setOcupado(true); setErro("");
    try {
      const r = await adminFetch("/api/admin/contratos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fechamentoId: f.id }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.erro);
      const href = urlDoContrato(body.data?.versao?.contratoId);
      atalhos.current.set(chave, href);
      if (pedidoVisivel.current?.chave === chave) setAtalhoContrato({ fechamentoId: chave, href });
      await atualizar();
      setMensagem(`Contrato gerado com valor final de ${formatarMoeda(body.data.versao.snapshot.comercial.valorFinalContrato)}.`);
    } catch (e) { setErro(e instanceof Error ? e.message : "Falha ao gerar contrato."); }
    finally { setOcupado(false); }
  }
  return <main className={styles.page}>
    <h1>Revisar condição comercial</h1>
    <p>Confira a proposta e registre a decisão antes de gerar o contrato.</p>
    {erro && <p role="alert" className={styles.error}>{erro}</p>}
    {mensagem && <p role="status">{mensagem}</p>}
    {hrefContrato && <div className={styles.actions}>
      <a className={styles.atalhoContrato} href={hrefContrato}>Abrir contrato para assinar</a>
      <a href={`/api/admin/contratos/resumo?fechamentoId=${idNaUrl}`} target="_blank" rel="noreferrer">Abrir Resumo da Contratação</a>
    </div>}
    {!f && !erro && <p>Carregando fechamento…</p>}
    {f && <>
      {dados.preReserva && <RevisaoPreReserva key={chave}
        dados={dados.preReserva} fechamentoId={f.id} atualizar={atualizar} />}
      <section className={styles.card}><h2>Cliente e festa</h2>{f.clienteId && <a href={`/clientes/${encodeURIComponent(f.clienteId)}`}>Conferir cadastro do cliente</a>}<p>{f.dataEvento.split('-').reverse().join('/')} · {f.horarioInicio.slice(0,5)}–{f.horarioFim.slice(0,5)} · {f.convidados} convidados</p>{f.temaFesta && <p>Tema: {f.temaFesta}</p>}</section>
      <section className={styles.card}>
        <h2>Condições comerciais e pagamento</h2><p>{formatarFormaPagamento(f.formaPagamentoPretendida)}</p>
        <p>Estado: {f.status}</p>
        <p>Valor de tabela: <strong>{formatarMoeda(f.valorTabela)}</strong></p>
        {f.valorNegociado !== null && <p>Base negociada proposta: {formatarMoeda(f.valorNegociado)}</p>}
        <h3>Condição pretendida pelo cliente</h3>
        <p>{formatarCondicaoPix(condicao?.pretendida ?? null)}</p>
        {previa && <p>Base comercial {formatarMoeda(previa.valorBaseComercial)} · desconto {previa.descontoFormaPagamentoPercentual}% · <strong>Contrato {formatarMoeda(previa.valorFinalContrato)}</strong></p>}
      </section>
      {condicao?.revisaoStatus === "PENDENTE" && f.status === "AGUARDANDO_APROVACAO" && <section className={styles.card}>
        <h2>Decisão do buffet</h2>
        {f.valorNegociado !== null && <label>Base comercial aprovada, antes do desconto (R$)<input inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} /></label>}
        {condicao.forma === "PIX_PARCELADO" && <fieldset>
          <legend>Condição aprovada</legend>
          <p>Preencha o que foi acordado. Os campos não são copiados automaticamente da proposta.</p>
          <div className={styles.grid}>
            <label>Entrada (R$)<input inputMode="decimal" value={entrada} onChange={(e) => setEntrada(e.target.value)} /></label>
            <label>Valor da parcela (R$)<input inputMode="decimal" value={parcela} onChange={(e) => setParcela(e.target.value)} /></label>
            <label>Quantidade de parcelas<input type="number" min="1" step="1" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} /></label>
          </div>
        </fieldset>}
        <label>Motivo da decisão<textarea maxLength={1000} value={motivo} onChange={(e) => setMotivo(e.target.value)} />{!motivo.trim() && <small>Informe o motivo para registrar a decisão.</small>}</label>
        <label className={styles.check}><input type="checkbox" checked={conferido} onChange={(e) => setConferido(e.target.checked)} />Conferi o valor e as condições com o cliente.</label>
        <div className={styles.actions}>
          <button disabled={ocupado} onClick={() => decidir("APROVAR")}>Aprovar condição</button>
          <button disabled={ocupado} onClick={() => decidir("RECUSAR")}>Recusar</button>
        </div>
      </section>}
      {condicao?.revisaoStatus === "APROVADA" && <section className={styles.card}>
        <h2>Condição aprovada pelo buffet</h2><p>{formatarCondicaoPix(condicao.aprovada)}</p>
      </section>}
      {f.status === "AGUARDANDO_CONTRATO" && (condicao || podeRecusar) && <div className={styles.actions}>
        {condicao && <button disabled={ocupado} onClick={gerarContrato}>Gerar contrato</button>}
        {podeRecusar && <button className={styles.secundario} type="button" disabled={ocupado} onClick={() => {
          setMotivoPerda(''); setObservacao(''); dialogo.current?.showModal();
        }}>Recusar pedido</button>}
      </div>}
      {podeRecusar &&
        <dialog ref={dialogo} className={styles.dialogo} aria-labelledby="titulo-recusa" onCancel={e => { if (ocupado) e.preventDefault(); }}>
          <form onSubmit={e => { e.preventDefault(); void recusar(); }}>
            <h2 id="titulo-recusa">Recusar pedido?</h2>
            <p>A recusa é definitiva. O pedido sairá da fila de contratações.</p>
            <p>{dados.recusa === 'COM_PREPARACAO'
              ? 'O contrato em preparação será cancelado junto com o pedido.'
              : 'Se um contrato entrar em preparação antes da confirmação, ele também poderá ser cancelado.'}</p>
            <label>Motivo da perda<select required value={motivoPerda} disabled={ocupado} onChange={e => setMotivoPerda(e.target.value)}>
              <option value="">Selecione o motivo</option>
              {MOTIVOS_PERDA.map(m => <option key={m}>{m}</option>)}
            </select></label>
            <label>{motivoPerda === 'Outro' ? 'Explique o motivo' : 'Observação (opcional)'}
              <textarea maxLength={1000} required={motivoPerda === 'Outro'} value={observacao} disabled={ocupado} onChange={e => setObservacao(e.target.value)} />
            </label>
            <div className={styles.actions}>
              <button type="button" disabled={ocupado} onClick={() => dialogo.current?.close()}>Voltar</button>
              <button disabled={ocupado || !motivoPerda || (motivoPerda === 'Outro' && !observacao.trim())}>Confirmar recusa</button>
            </div>
          </form>
        </dialog>}
      {dados.recusa === 'INDISPONIVEL' && <p>Recusa temporariamente indisponível.</p>}
      {!condicao && <p>Registro anterior ao novo fluxo. Esta revisão não altera condições legadas.</p>}
    </>}
  </main>;
}
