"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminFetch } from "@/lib/http/admin-fetch";
import { AdminPrimaryButton } from "./AdminPrimaryButton";
import styles from "./workspace.module.css";

type Opcao = { id: string; nome: string; livre: boolean; permitido: boolean };
type Salao = { id: string; nome: string };
type Dados = {
  salaoAtual: Salao | null; opcoes: Opcao[]; confirmada?: boolean;
  /** S-E: salão fixado pelo contrato assinado e troca em andamento na revisão aberta. */
  contratoFixa?: Salao | null;
  trocaEmAndamento?: {
    revisaoId: string; estado: string; salao: Salao | null;
    /** S-E restante: o que o card leu, devolvido no cancelamento condicionado ("Desistir da troca"). */
    contratoId?: string; versaoId?: string; revisaoEdicao?: number | null; revisaoOperacional?: number;
  } | null;
};

/** O cancelamento cancela a revisão inteira; o contrato assinado continua valendo no salão fixado. */
export const AVISO_DESISTIR = (fixa: string) => `Cancela a revisão inteira, inclusive outras alterações dela; o contrato assinado continua valendo no salão ${fixa}.`;

const URL_SALAO = "/api/admin/agenda/salao";

/** Decisão de Felipe (23/10/2026): a festa confirmada sem salão ocupa todos os salões no horário dela até ter um. */
export const AVISO_FESTA_SEM_SALAO = "Ainda sem salão. Enquanto isso, esta festa ocupa todos os salões no horário dela (e no intervalo mínimo). Escolha um salão livre abaixo para liberar os demais.";

/** 094: salão da festa escolhido pelo sistema; a equipe pode trocar por outro livre e permitido. */
export function SalaoDaFesta({ fechamentoId }: { fechamentoId: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [escolha, setEscolha] = useState("");
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState("");
  const [erro, setErro] = useState("");
  // S-E restante ("Desistir da troca"): formulário no próprio card (sem prompt/confirm).
  const [desistindo, setDesistindo] = useState(false);
  const [motivo, setMotivo] = useState("");
  /** Depois de 409 ou falha de rede: "Confirmar desistência" só volta após uma releitura BEM-SUCEDIDA (nova conferência). */
  const [exigeReleitura, setExigeReleitura] = useState(false);

  /** Lê o card; devolve se a leitura deu certo. */
  const ler = useCallback(async () => {
    try {
      const j = await (await adminFetch(`${URL_SALAO}?fechamentoId=${encodeURIComponent(fechamentoId)}`)).json();
      if (j?.ok) {
        setDados(j.data ?? null);
        setEscolha(j.data?.trocaEmAndamento?.salao?.id ?? j.data?.salaoAtual?.id ?? "");
        return true;
      }
      setErro(j?.erro || "Não foi possível carregar o salão da festa.");
    } catch {
      setErro("Não foi possível carregar o salão da festa.");
    }
    return false;
  }, [fechamentoId]);

  // Carga inicial: o estado só muda na resposta (as releituras depois de uma ação usam ler()).
  useEffect(() => {
    let ativo = true;
    adminFetch(`${URL_SALAO}?fechamentoId=${encodeURIComponent(fechamentoId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!ativo) return;
        if (j?.ok) {
          setDados(j.data ?? null);
          setEscolha(j.data?.trocaEmAndamento?.salao?.id ?? j.data?.salaoAtual?.id ?? "");
        } else setErro(j?.erro || "Não foi possível carregar o salão da festa.");
      })
      .catch(() => { if (ativo) setErro("Não foi possível carregar o salão da festa."); });
    return () => { ativo = false; };
  }, [fechamentoId]);

  if (!dados) return erro ? <p className={styles.error} role="alert">{erro}</p> : null;
  // S-E (R-E3/R3-E1): com contrato assinado que fixa o salão, a troca é o destino da revisão aberta; o atual vale até a
  // nova versão ser assinada. Sem revisão em elaboração, não há troca nesta tela.
  const fixa = dados.contratoFixa ?? null;
  const troca = dados.trocaEmAndamento ?? null;
  const pelaRevisao = !!fixa;
  const podeTrocar = !pelaRevisao || troca?.estado === "EM_ELABORACAO";
  const atualId = (pelaRevisao ? troca?.salao?.id : dados.salaoAtual?.id) ?? "";
  // Troca = contrato fixa um salão e o destino da revisão é OUTRO salão (destino nulo ou igual não é troca; o servidor confere de novo).
  const eTroca = !!fixa && !!troca?.salao && troca.salao.id !== fixa.id;
  const podeDesistir = eTroca && !!troca?.versaoId && typeof troca?.revisaoEdicao === "number" && typeof troca?.revisaoOperacional === "number";

  async function desistir() {
    if (!podeDesistir || !troca || !troca.salao || exigeReleitura || busy) return;
    setBusy(true);
    setAviso("");
    setErro("");
    let releitura = false;
    try {
      const r = await adminFetch(`/api/admin/contratos/versoes/${encodeURIComponent(troca.versaoId!)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acao: "cancelar_revisao", revisao: troca.revisaoEdicao, motivo: motivo.trim(),
          esperado: { revisaoId: troca.revisaoId, revisaoOperacional: troca.revisaoOperacional, estado: troca.estado, salaoDestinoId: troca.salao.id },
        }),
      });
      const j = await r.json();
      if (j?.ok) {
        setDesistindo(false);
        setMotivo("");
        setAviso(`Troca desistida: a revisão foi cancelada e o contrato assinado continua valendo no salão ${fixa!.nome}.`);
        await ler();
        return;
      }
      setErro(j?.erro || "Não foi possível desistir da troca.");
      releitura = r.status === 409;
    } catch {
      setErro("Não foi possível confirmar a desistência. Confira o salão da festa de novo antes de tentar outra vez.");
      releitura = true;
    } finally {
      setBusy(false);
    }
    if (releitura) {
      // A revisão mudou (ou o resultado é incerto): nova conferência obrigatória antes de qualquer nova tentativa.
      setExigeReleitura(true);
      setMotivo("");
      if (await ler()) { setExigeReleitura(false); setDesistindo(false); }
    }
  }

  async function trocar() {
    setBusy(true);
    setAviso("");
    setErro("");
    try {
      const j = await (await adminFetch(URL_SALAO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fechamentoId, salaoId: escolha }),
      })).json();
      if (!j?.ok) { setErro(j?.erro || "Não foi possível trocar o salão."); return; }
      if (j.data) { setDados(j.data); setEscolha(j.data.trocaEmAndamento?.salao?.id ?? j.data.salaoAtual?.id ?? ""); }
      setAviso(pelaRevisao ? "Salão da nova versão definido. Salve a revisão do contrato para atualizar o documento." : "Salão trocado.");
    } catch {
      setErro("Não foi possível confirmar a troca. Atualize a página antes de tentar de novo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="salao-da-festa-titulo">
      <h2 id="salao-da-festa-titulo">Salão da festa</h2>
      <p className={styles.intro}>{dados.salaoAtual ? `Salão atual: ${dados.salaoAtual.nome}` : dados.confirmada ? AVISO_FESTA_SEM_SALAO : "Ainda sem salão. O sistema escolhe na confirmação."}</p>
      {fixa && <p className={styles.intro} data-salao-contrato>{`O contrato assinado fixa o salão ${fixa.nome}.`}{" "}
        {eTroca
          ? `Troca para ${troca!.salao!.nome} em andamento: vale quando o cliente assinar a nova versão.`
          : troca?.estado === "EM_ELABORACAO" ? "Escolha abaixo o salão da nova versão." : troca ? "A nova versão já foi assinada pelo buffet; para mudar o salão, cancele-a e crie outra." : "Para trocar, abra uma nova versão do contrato."}</p>}
      {podeTrocar && dados.opcoes.length > 0 && (
        <>
          <label>
            Trocar para
            <select value={escolha} onChange={(e) => setEscolha(e.target.value)} disabled={busy}>
              {!atualId && <option value="">Escolha um salão</option>}
              {dados.opcoes.map((o) => {
                const atual = o.id === atualId;
                // Pela revisão, as opções são as do destino e "permitido" inclui comportar os convidados.
                const sufixo = !o.permitido ? (pelaRevisao ? " (não serve no destino)" : " (não permitido)") :!o.livre && !atual ? " (ocupado)" : atual ? " (atual)" : "";
                return <option key={o.id} value={o.id} disabled={!o.permitido || (!o.livre && !atual)}>{o.nome}{sufixo}</option>;
              })}
            </select>
          </label>
          <AdminPrimaryButton carregando={busy} disabled={!escolha || escolha === atualId} onClick={() => void trocar()}>{pelaRevisao ? "Usar na nova versão" : "Trocar salão"}</AdminPrimaryButton>
        </>
      )}
      {eTroca && (
        <div data-desistir-troca>
          {!desistindo && <>
            {podeDesistir && <button type="button" className={styles.textButton} disabled={busy || exigeReleitura} onClick={() => { setDesistindo(true); setAviso(""); setErro(""); }}>Desistir da troca</button>}{" "}
            <Link href={`/admin/contratos?contratoId=${encodeURIComponent(troca!.contratoId ?? "")}#alteracoes`}>Abrir revisão</Link>
          </>}
          {desistindo && <>
            <label>
              Motivo
              <textarea value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} disabled={busy} />
            </label>
            <p className={styles.intro}>{AVISO_DESISTIR(fixa!.nome)}</p>
            <AdminPrimaryButton carregando={busy} disabled={exigeReleitura || motivo.trim().length < 3} onClick={() => void desistir()}>Confirmar desistência</AdminPrimaryButton>{" "}
            <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setDesistindo(false); setMotivo(""); }}>Voltar</button>
          </>}
          {exigeReleitura && <p className={styles.error} role="alert">A revisão mudou ou não foi possível confirmar. Releia o salão da festa antes de tentar de novo.{" "}
            <button type="button" className={styles.textButton} disabled={busy} onClick={() => void ler().then((ok) => { if (ok) { setExigeReleitura(false); setDesistindo(false); } })}>Reler</button></p>}
        </div>
      )}
      {aviso && <p className={styles.notice} role="status">{aviso}</p>}
      {erro && <p className={styles.error} role="alert">{erro}</p>}
    </section>
  );
}
