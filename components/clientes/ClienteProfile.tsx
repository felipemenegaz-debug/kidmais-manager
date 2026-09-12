"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { obterClienteApi, type ClienteDetalheApi } from "@/lib/clientes/api-client";
import {
  calcularIdade,
  formatCpf,
  formatData,
  formatTelefone,
} from "@/lib/clientes/utils";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import styles from "./Clientes.module.css";

type Tab = "resumo" | "aniversariantes" | "eventos" | "responsaveis";

export default function ClienteProfile({ clienteId }: { clienteId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: Tab = ["resumo", "aniversariantes", "eventos", "responsaveis"].includes(tabParam ?? "")
    ? (tabParam as Tab)
    : "resumo";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [detalhe, setDetalhe] = useState<ClienteDetalheApi | null>(null);
  const [mostrarFaltantes, setMostrarFaltantes] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    Promise.resolve().then(() => {
      if (ativo) { setCarregando(true); setErro(""); }
      return obterClienteApi(clienteId);
    })
      .then((data) => {
        if (ativo) setDetalhe(data);
      })
      .catch((error) => {
        if (ativo) {
          setDetalhe(null);
          setErro(error instanceof Error ? error.message : "Não foi possível carregar o Cliente.");
        }
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });
    return () => { ativo = false; };
  }, [clienteId]);

  function changeTab(nextTab: Tab) {
    setTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "resumo") params.delete("tab");
    else params.set("tab", nextTab);
    const query = params.toString();
    router.replace(`/clientes/${clienteId}${query ? `?${query}` : ""}`, { scroll: false });
  }

  if (carregando) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.loadingState}>Carregando perfil do cliente...</section>
        </div>
      </main>
    );
  }

  if (!detalhe) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.emptyState}>
            <h1>Cliente não encontrado</h1>
            {erro && <p>{erro}</p>}
            <Link className={styles.primaryButton} href="/clientes">Voltar para clientes</Link>
          </section>
        </div>
      </main>
    );
  }

  const { cliente, aniversariantes, responsaveis, cadastro } = detalhe;
  const completo = cadastro.completoParaContrato;
  const camposFaltantes = cadastro.camposFaltantes;

  return (
    <main className={styles.page}>
      <div className={styles.decoracaoUm} />
      <div className={styles.decoracaoDois} />
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <KidmaisBrand compact context="manager" href="/clientes" />
          <Link className={styles.backLink} href="/clientes">← Clientes</Link>
        </header>

        <section className={styles.profileHeader}>
          <div>
            <p className={styles.eyebrow}>Perfil do cliente</p>
            <h1>{cliente.nomeCompleto}</h1>
            <div className={styles.profileMeta}>
              <span>CPF: {formatCpf(cliente.cpf, true)}</span>
              <span>WhatsApp: {formatTelefone(cliente.whatsapp)}</span>
              {completo ? (
                <b className={styles.completeBadge}>Cadastro completo ✓</b>
              ) : (
                <button
                  type="button"
                  className={`${styles.incompleteBadge} ${styles.statusButton}`}
                  onClick={() => setMostrarFaltantes((valor) => !valor)}
                  aria-expanded={mostrarFaltantes}
                >
                  Cadastro incompleto
                </button>
              )}
            </div>
            {!completo && mostrarFaltantes && (
              <div className={styles.incompletePanel}>
                <div>
                  <strong>Faltam {camposFaltantes.length} {camposFaltantes.length === 1 ? "dado" : "dados"} para completar o cadastro:</strong>
                  <span>{camposFaltantes.map((item) => item.label).join(" • ")}</span>
                </div>
                <Link className={styles.secondaryButton} href={`/clientes/${cliente.id}/editar`}>Completar cadastro</Link>
              </div>
            )}
          </div>
          <div className={styles.headerActions}>
            <Link className={styles.secondaryButton} href={`/clientes/${cliente.id}/editar`}>Editar cliente</Link>
            <Link className={styles.primaryButton} href="/fechamento?origem=ATENDIMENTO_KIDMAIS&contexto=ADMIN">+ Iniciar fechamento</Link>
          </div>
        </section>

        {detalhe.redirecionadoDeClienteMesclado && (
          <div className={styles.integrationNotice}>
            <strong>Cadastro mesclado.</strong>
            <span>O ID acessado pertence a um cadastro secundário e o sistema carregou automaticamente o Cliente principal.</span>
          </div>
        )}

        <nav className={styles.tabs}>
          {([
            ["resumo", "Resumo"],
            ["aniversariantes", "Aniversariantes"],
            ["eventos", "Festas e fechamentos"],
            ["responsaveis", "Responsáveis"],
          ] as [Tab, string][]).map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? styles.tabActive : styles.tabButton} onClick={() => changeTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "resumo" && (
          <section className={styles.summaryLayout}>
            <article className={`${styles.profileCard} ${styles.eventCard}`}>
              <div className={styles.cardLabel}>Próximo evento</div>
              <div className={styles.cardEmpty}>
                <h2>Festas do cliente</h2>
                <p>Consulte as festas reais vinculadas às contratações deste cliente.</p>
                <Link className={styles.cardLink} href={`/admin/festas?clienteId=${encodeURIComponent(cliente.id)}`}>Ver festas →</Link>
              </div>
            </article>

            <article className={styles.profileCard}>
              <div className={styles.cardLabel}>Contato</div>
              <dl className={styles.detailList}>
                <div><dt>WhatsApp</dt><dd>{formatTelefone(cliente.whatsapp)}</dd></div>
                <div><dt>Telefone</dt><dd>{formatTelefone(cliente.telefone)}</dd></div>
                <div><dt>E-mail</dt><dd>{cliente.email ?? "Não informado"}</dd></div>
              </dl>
            </article>

            <article className={styles.profileCard}>
              <div className={styles.cardLabel}>Aniversariantes</div>
              <div className={styles.peopleMiniList}>
                {aniversariantes.map((item) => (
                  <div key={item.id}>
                    <strong>{item.nome}</strong>
                    <span>{item.dataNascimento ? `${calcularIdade(item.dataNascimento)} anos` : "Nascimento não informado"}</span>
                  </div>
                ))}
                {!aniversariantes.length && <p>Nenhum aniversariante cadastrado.</p>}
              </div>
              <button className={styles.textButton} type="button" onClick={() => changeTab("aniversariantes")}>Ver todos →</button>
            </article>

            <article className={styles.profileCard}>
              <div className={styles.cardLabel}>Endereço</div>
              <p className={styles.addressText}>
                {cliente.logradouro ? `${cliente.logradouro}${cliente.numero ? `, ${cliente.numero}` : ""}` : "Endereço não informado"}
                {cliente.complemento && <><br />{cliente.complemento}</>}
                {(cliente.bairro || cliente.cidade) && <><br />{[cliente.bairro, cliente.cidade, cliente.uf].filter(Boolean).join(" • ")}</>}
              </p>
            </article>

            <article className={`${styles.profileCard} ${styles.fullWidth}`}>
              <div className={styles.cardLabel}>Observações</div>
              <p>{cliente.observacoes ?? "Nenhuma observação cadastrada."}</p>
            </article>
          </section>
        )}

        {tab === "aniversariantes" && (
          <section>
            <div className={styles.sectionHeader}>
              <div><h2>Aniversariantes</h2><p>Crianças vinculadas a este cliente.</p></div>
            </div>
            <div className={styles.cardGrid}>
              {aniversariantes.map((item) => (
                <article className={styles.personCard} key={item.id}>
                  <div className={styles.avatar}>{item.nome.slice(0, 1)}</div>
                  <h3>{item.nome}</h3>
                  <p>Nascimento: {item.dataNascimento ? formatData(item.dataNascimento) : "Não informado"}</p>
                  <p>Idade atual: {item.dataNascimento ? `${calcularIdade(item.dataNascimento)} anos` : "—"}</p>
                  <p>Tema preferido: {item.temaPadrao ?? "Não informado"}</p>
                  <div className={styles.personActions}><Link href={`/admin/festas?clienteId=${encodeURIComponent(cliente.id)}`}>Ver festas</Link></div>
                </article>
              ))}
              {!aniversariantes.length && <div className={styles.inlineEmpty}>Nenhum aniversariante cadastrado.</div>}
            </div>
          </section>
        )}

        {tab === "eventos" && (
          <section className={styles.eventsSection}>
            <div className={styles.sectionHeader}>
              <div><h2>Festas e fechamentos</h2><p>Acompanhe processos em andamento e histórico da família.</p></div>
              <Link className={styles.primaryButton} href="/fechamento?origem=ATENDIMENTO_KIDMAIS&contexto=ADMIN">+ Iniciar fechamento</Link>
            </div>
            <div className={styles.integrationNotice}>
              <strong>Festas vinculadas</strong>
              <Link href={`/admin/festas?clienteId=${encodeURIComponent(cliente.id)}`}>Ver festas reais deste cliente</Link>
            </div>
          </section>
        )}

        {tab === "responsaveis" && (
          <section>
            <div className={styles.sectionHeader}>
              <div><h2>Responsáveis</h2><p>Contratante principal e contatos adicionais.</p></div>
            </div>

            <article className={styles.responsiblePrimary}>
              <div className={styles.cardLabel}>Contratante principal</div>
              <h3>{cliente.nomeCompleto}</h3>
              <p>CPF: {formatCpf(cliente.cpf)}</p>
              <p>WhatsApp: {formatTelefone(cliente.whatsapp)}</p>
              <p>E-mail: {cliente.email ?? "Não informado"}</p>
            </article>

            <div className={styles.cardGrid}>
              {responsaveis.map((item) => (
                <article className={styles.personCard} key={item.id}>
                  <div className={styles.avatar}>{item.nome.slice(0, 1)}</div>
                  <h3>{item.nome}</h3>
                  <p>{item.relacao ?? "Relação não informada"}</p>
                  <p>{formatTelefone(item.whatsapp ?? item.telefone)}</p>
                  <p>{item.email ?? "E-mail não informado"}</p>
                </article>
              ))}
              {!responsaveis.length && <div className={styles.inlineEmpty}>Nenhum responsável adicional cadastrado.</div>}
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
