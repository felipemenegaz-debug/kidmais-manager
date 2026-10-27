"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/http/admin-fetch";
import { AdminPrimaryButton } from "./AdminPrimaryButton";
import styles from "./workspace.module.css";

type Opcao = { id: string; nome: string; livre: boolean; permitido: boolean };
type Salao = { id: string; nome: string };
type Dados = {
  salaoAtual: Salao | null; opcoes: Opcao[]; confirmada?: boolean;
  /** S-E: salão fixado pelo contrato assinado e troca em andamento na revisão aberta. */
  contratoFixa?: Salao | null;
  trocaEmAndamento?: { revisaoId: string; estado: string; salao: Salao | null } | null;
};

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
        {troca?.salao && troca.salao.id !== fixa.id
          ? `Troca para ${troca.salao.nome} em andamento: vale quando o cliente assinar a nova versão. Para desistir, cancele a revisão no contrato.`
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
      {aviso && <p className={styles.notice} role="status">{aviso}</p>}
      {erro && <p className={styles.error} role="alert">{erro}</p>}
    </section>
  );
}
