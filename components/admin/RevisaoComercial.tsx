"use client";
import { adminFetch } from "@/lib/http/admin-fetch";

import { useEffect, useState } from "react";
import type { AprovacaoNegociacaoRecord, FechamentoRecord } from "@/lib/fechamentos/repositories/models";
import { calcularCondicaoComercial, centavosComerciais } from "@/lib/comercial/condicao-pagamento";
import { formatarMoeda, formatarCondicaoPix, formatarFormaPagamento } from "@/lib/contratos/documento/formatters";
import styles from "./RevisaoComercial.module.css";

type Dados = { fechamento: FechamentoRecord; aprovacoes: AprovacaoNegociacaoRecord[] };
export default function RevisaoComercial({ fechamentoId }: { fechamentoId: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [base, setBase] = useState("");
  const [entrada, setEntrada] = useState("");
  const [parcela, setParcela] = useState("");
  const [quantidade, setQuantidade] = useState("");
  const [motivo, setMotivo] = useState("");
  const [conferido, setConferido] = useState(false);
  const [contratoGerado, setContratoGerado] = useState(false);
  const url = `/api/admin/fechamentos/${encodeURIComponent(fechamentoId)}/revisao`;
  useEffect(() => {
    let ativo = true;
    adminFetch(url, { cache: "no-store" }).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.erro);
      if (ativo) setDados(body.data);
    }).catch((e) => { if (ativo) setErro(e.message); });
    return () => { ativo = false; };
  }, [url]);
  const f = dados?.fechamento;
  const condicao = f?.condicaoPagamento;
  const pendente = dados?.aprovacoes.find((a) => a.status === "PENDENTE" && a.condicaoPagamento);
  let previa = null;
  if (f && condicao) {
    try { previa = calcularCondicaoComercial(base ? centavosComerciais(base.replace(",", ".")) / 100 : f.valorAprovado ?? f.valorTabela, condicao.forma); }
    catch { /* Entrada parcial durante digitação. */ }
  }
  async function decidir(decisao: "APROVAR" | "RECUSAR") {
    if (!pendente || !f) return;
    setOcupado(true); setErro(""); setMensagem("");
    try {
      if (!motivo.trim() || !conferido) throw new Error("Informe o motivo e confirme a conferência comercial.");
      const r = await adminFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
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
      const atual = await adminFetch(url, { cache: "no-store" });
      const atualizado = await atual.json(); if (!atual.ok) throw new Error(atualizado.erro);
      setDados(atualizado.data); setMensagem("Decisão registrada. Nenhum pagamento foi criado.");
    } catch (e) { setErro(e instanceof Error ? e.message : "Falha na revisão."); }
    finally { setOcupado(false); }
  }
  async function gerarContrato() {
    setOcupado(true); setErro("");
    try {
      const r = await adminFetch("/api/admin/contratos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fechamentoId }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.erro);
      setContratoGerado(true);
      setMensagem(`Contrato gerado com valor final de ${formatarMoeda(body.data.versao.snapshot.comercial.valorFinalContrato)}.`);
    } catch (e) { setErro(e instanceof Error ? e.message : "Falha ao gerar contrato."); }
    finally { setOcupado(false); }
  }
  return <main className={styles.page}>
    <p className={styles.brand}>KIDMAIS MANAGER · COMERCIAL</p>
    <h1>Revisão do fechamento</h1>
    <p>A proposta do cliente e a condição aprovada ficam registradas separadamente.</p>
    {erro && <p role="alert" className={styles.error}>{erro}</p>}
    {mensagem && <p role="status">{mensagem}</p>}
    {contratoGerado && <a href={`/api/admin/contratos/resumo?fechamentoId=${encodeURIComponent(fechamentoId)}`} target="_blank" rel="noreferrer">Abrir Resumo da Contratação</a>}
    {contratoGerado && <p><a href="/admin/contratos">Abrir revisão e assinatura administrativa do Contrato</a></p>}
    {!f && !erro && <p>Carregando fechamento…</p>}
    {f && <>
      <section className={styles.card}>
        <h2>{formatarFormaPagamento(f.formaPagamentoPretendida)}</h2>
        <p>Estado: {f.status}</p>
        <p>Valor de tabela: <strong>{formatarMoeda(f.valorTabela)}</strong></p>
        {f.valorNegociado !== null && <p>Base negociada proposta: {formatarMoeda(f.valorNegociado)}</p>}
        <h3>Condição pretendida pelo cliente</h3>
        <p>{formatarCondicaoPix(condicao?.pretendida ?? null)}</p>
        {previa && <p>Base comercial {formatarMoeda(previa.valorBaseComercial)} · desconto {previa.descontoFormaPagamentoPercentual}% · <strong>Contrato {formatarMoeda(previa.valorFinalContrato)}</strong></p>}
      </section>
      {condicao?.revisaoStatus === "PENDENTE" && f.status === "AGUARDANDO_APROVACAO" && <section className={styles.card}>
        <h2>Decisão da Kidmais</h2>
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
        <label>Motivo da decisão<textarea maxLength={1000} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={conferido} onChange={(e) => setConferido(e.target.checked)} />Conferi o valor e as condições com o cliente.</label>
        <div className={styles.actions}>
          <button disabled={ocupado} onClick={() => decidir("APROVAR")}>Aprovar condição</button>
          <button disabled={ocupado} onClick={() => decidir("RECUSAR")}>Recusar</button>
        </div>
      </section>}
      {condicao?.revisaoStatus === "APROVADA" && <section className={styles.card}>
        <h2>Condição aprovada pela Kidmais</h2><p>{formatarCondicaoPix(condicao.aprovada)}</p>
      </section>}
      {condicao && f.status === "AGUARDANDO_CONTRATO" && <button disabled={ocupado} onClick={gerarContrato}>Gerar contrato</button>}
      {!condicao && <p>Registro anterior ao novo fluxo. Esta revisão não altera condições legadas.</p>}
    </>}
  </main>;
}
