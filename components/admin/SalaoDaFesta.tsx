"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/http/admin-fetch";
import { AdminPrimaryButton } from "./AdminPrimaryButton";
import styles from "./workspace.module.css";

type Opcao = { id: string; nome: string; livre: boolean; permitido: boolean };
type Dados = { salaoAtual: { id: string; nome: string } | null; opcoes: Opcao[]; confirmada?: boolean };

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
          setEscolha(j.data?.salaoAtual?.id ?? "");
        } else setErro(j?.erro || "Não foi possível carregar o salão da festa.");
      })
      .catch(() => { if (ativo) setErro("Não foi possível carregar o salão da festa."); });
    return () => { ativo = false; };
  }, [fechamentoId]);

  if (!dados) return erro ? <p className={styles.error} role="alert">{erro}</p> : null;
  const atualId = dados.salaoAtual?.id ?? "";

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
      if (j.data) { setDados(j.data); setEscolha(j.data.salaoAtual?.id ?? ""); }
      setAviso("Salão trocado.");
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
      {dados.opcoes.length > 0 && (
        <>
          <label>
            Trocar para
            <select value={escolha} onChange={(e) => setEscolha(e.target.value)} disabled={busy}>
              {!atualId && <option value="">Escolha um salão</option>}
              {dados.opcoes.map((o) => {
                const atual = o.id === atualId;
                const sufixo = !o.permitido ? " (não permitido)" : !o.livre && !atual ? " (ocupado)" : atual ? " (atual)" : "";
                return <option key={o.id} value={o.id} disabled={!o.permitido || (!o.livre && !atual)}>{o.nome}{sufixo}</option>;
              })}
            </select>
          </label>
          <AdminPrimaryButton carregando={busy} disabled={!escolha || escolha === atualId} onClick={() => void trocar()}>Trocar salão</AdminPrimaryButton>
        </>
      )}
      {aviso && <p className={styles.notice} role="status">{aviso}</p>}
      {erro && <p className={styles.error} role="alert">{erro}</p>}
    </section>
  );
}
