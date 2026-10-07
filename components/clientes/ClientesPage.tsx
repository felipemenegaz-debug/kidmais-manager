"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { listarClientesApi, type ClienteListaApiItem } from "@/lib/clientes/api-client";
import { formatTelefone } from "@/lib/clientes/utils";
import styles from "./Clientes.module.css";

export default function ClientesPage({ selecionarParaFechamento = false }: { selecionarParaFechamento?: boolean }) {
  const [incluirInativos,setIncluirInativos]=useState(false);
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
        const data = await listarClientesApi({ q: busca, limit: 100, incluirInativos });
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
  }, [busca,incluirInativos]);

  const resultados = useMemo(() => clientes, [clientes]);
  const destinoCliente = (id: string) => selecionarParaFechamento
    ? `/admin/clientes/${encodeURIComponent(id)}/fechamento`
    : `/clientes/${encodeURIComponent(id)}`;

  return (
    <main className={styles.page}>
      <div className={styles.decoracaoUm} />
      <div className={styles.decoracaoDois} />
      <div className={styles.shell}>
        <section className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Relacionamento</p>
            <h1>{selecionarParaFechamento ? "Selecione o cliente para o fechamento" : "Clientes"}</h1>
            <p>{selecionarParaFechamento ? "Busque e selecione a família para iniciar o fechamento. Se ainda não estiver cadastrada, cadastre um novo cliente." : "Encontre famílias, acompanhe festas e inicie novos fechamentos."}</p>
          </div>
          <div className={styles.headerActions}>
            <Link className={styles.secondaryButton} href={selecionarParaFechamento ? "/clientes" : "/clientes?acao=fechamento"}>{selecionarParaFechamento ? "Voltar aos clientes" : "Fechamento"}</Link>
            <Link className={styles.secondaryButton} href="/clientes/lixeira">Lixeira / Arquivados</Link>
            <Link className={styles.cta} href="/clientes/novo">+ Novo cliente</Link>
          </div>
        </section>

        <section className={styles.toolbarCard}>
          <label><input type="checkbox" checked={incluirInativos} onChange={e=>setIncluirInativos(e.target.checked)}/> Incluir arquivados/excluídos</label>
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
            <Link className={styles.cta} href="/clientes/novo">+ Cadastrar novo cliente</Link>
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
                <Link className={styles.tableRow} key={cliente.id} href={destinoCliente(cliente.id)}>
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
                <Link className={styles.mobileCard} key={cliente.id} href={destinoCliente(cliente.id)}>
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
