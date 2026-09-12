"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { listarClientesApi, type ClienteListaApiItem } from "@/lib/clientes/api-client";
import { formatTelefone } from "@/lib/clientes/utils";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import styles from "./Clientes.module.css";

export default function ClientesPage() {
  const [busca, setBusca] = useState("");
  const [clientes, setClientes] = useState<ClienteListaApiItem[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    const timer = window.setTimeout(async () => {
      setCarregando(true);
      setErro("");
      try {
        const data = await listarClientesApi({ q: busca, limit: 100 });
        if (ativo) setClientes(data);
      } catch (error) {
        if (ativo) {
          setClientes([]);
          setErro(error instanceof Error ? error.message : "Não foi possível carregar os clientes.");
        }
      } finally {
        if (ativo) setCarregando(false);
      }
    }, busca.trim() ? 300 : 0);

    return () => {
      ativo = false;
      window.clearTimeout(timer);
    };
  }, [busca]);

  const resultados = useMemo(() => clientes, [clientes]);

  return (
    <main className={styles.page}>
      <div className={styles.decoracaoUm} />
      <div className={styles.decoracaoDois} />
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <KidmaisBrand context="manager" href="/clientes" subtitle="Gestão de clientes e festas" />
          <Link className={styles.topLink} href="/fechamento?origem=ATENDIMENTO_KIDMAIS&contexto=ADMIN">Fechamento</Link>
        </header>

        <section className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Relacionamento</p>
            <h1>Clientes</h1>
            <p>Encontre famílias, acompanhe festas e inicie novos fechamentos.</p>
          </div>
          <div className={styles.headerActions}>
            <Link className={styles.primaryButton} href="/clientes/novo">+ Novo cliente</Link>
          </div>
        </section>

        <section className={styles.toolbarCard}>
          <label className={styles.searchBox}>
            <span>⌕</span>
            <input
              value={busca}
              onChange={(event) => setBusca(event.target.value)}
              placeholder="Buscar nome, CPF, telefone, WhatsApp ou e-mail..."
            />
          </label>
        </section>

        {erro && (
          <section className={styles.apiErrorBox}>
            <strong>Não foi possível carregar o CRM.</strong>
            <span>{erro}</span>
            <small>Entre com sua conta administrativa. Se o erro persistir, solicite ao operador a conferência do PostgreSQL.</small>
          </section>
        )}

        <div className={styles.resultsMeta}>
          {carregando ? <span>Carregando clientes...</span> : <><strong>{resultados.length}</strong> {resultados.length === 1 ? "cliente" : "clientes"}</>}
        </div>

        {!carregando && !erro && resultados.length === 0 ? (
          <section className={styles.emptyState}>
            <div className={styles.emptyIcon}>👥</div>
            <h2>Nenhum cliente encontrado</h2>
            <p>Revise a busca ou cadastre uma nova família.</p>
            <Link className={styles.primaryButton} href="/clientes/novo">+ Cadastrar novo cliente</Link>
          </section>
        ) : !erro && (
          <>
            <section className={styles.tableCard}>
              <div className={styles.tableHeader}>
                <span>Cliente</span>
                <span>Contato</span>
                <span>Situação</span>
                <span />
              </div>
              {resultados.map(({ cliente, cadastroCompleto }) => (
                <Link className={styles.tableRow} key={cliente.id} href={`/clientes/${cliente.id}`}>
                  <span className={styles.clientCell}>
                    <strong>{cliente.nomeCompleto}</strong>
                    {!cadastroCompleto && <small>Cadastro incompleto</small>}
                  </span>
                  <span>{formatTelefone(cliente.whatsapp ?? cliente.telefone)}</span>
                  <span><b className={`${styles.statusBadge} ${styles.statusNeutral}`}>Cliente {cliente.status === "ATIVO" ? "ativo" : "inativo"}</b></span>
                  <span className={styles.chevron}>›</span>
                </Link>
              ))}
            </section>

            <section className={styles.mobileList}>
              {resultados.map(({ cliente, cadastroCompleto }) => (
                <Link className={styles.mobileCard} key={cliente.id} href={`/clientes/${cliente.id}`}>
                  <div className={styles.mobileCardTop}>
                    <div>
                      <strong>{cliente.nomeCompleto}</strong>
                      {!cadastroCompleto && <small>Cadastro incompleto</small>}
                    </div>
                    <span>›</span>
                  </div>
                  <p>📱 {formatTelefone(cliente.whatsapp ?? cliente.telefone)}</p>
                </Link>
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
