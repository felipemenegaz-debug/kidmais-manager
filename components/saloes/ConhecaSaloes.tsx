"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import FestaDecoracao from "@/components/fechamento/FestaDecoracao";
import { MarcaPublicaCabecalho, useMarcaPublica } from "@/components/fechamento/MarcaPublica";
import { apiPublica, paginaPublica } from "@/lib/fechamentos/rota-publica";
import type { SalaoPublico } from "@/lib/agenda/salao-publico";
import { linkContatoBuffet } from "@/components/disponibilidade/convidados-tela";
import { diferencas, linhaNumeros, mesPorExtenso, organizar, selecaoInicial, seguirSemEtapa, textoSituacao, type ListaPublica } from "./saloes-tela";
import styles from "./ConhecaSaloes.module.css";

/** Parâmetros que a disponibilidade passa adiante (o mesmo horário segue para o /fechamento). */
const PARAMETROS = ["data", "codigoPeriodo", "configuracaoId", "inicio", "fim", "ajuste", "periodo", "convidados"] as const;

function Galeria({ salao, empresa }: { salao: SalaoPublico; empresa: string }) {
  const [atual, setAtual] = useState(0);
  const foto = salao.fotos[atual];
  const src = (id: string) => apiPublica(`/api/publico/saloes/${salao.id}/fotos/${id}`, empresa);
  if (!foto) return null;
  return (
    <div className={styles.galeria}>
      <figure className={styles.fotoPrincipal}>
        {/* eslint-disable-next-line @next/next/no-img-element -- foto pública revalidada pela rota própria (ETag) */}
        <img src={src(foto.id)} alt={foto.legenda} width={foto.largura} height={foto.altura} />
        <figcaption>{foto.legenda}</figcaption>
        <span className={styles.contador}>{atual + 1}/{salao.fotos.length}</span>
      </figure>
      <div className={styles.miniaturas} aria-label={`Fotos do ${salao.nome}`}>
        {salao.fotos.map((f, i) => (
          <button type="button" key={f.id} aria-label={f.legenda} aria-pressed={i === atual} onClick={() => setAtual(i)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- miniatura da mesma foto pública */}
            <img src={src(f.id)} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Cartao({ salao, empresa, recomendado, motivo, selecionado, onEscolher, visita }: {
  salao: SalaoPublico; empresa: string; recomendado: boolean; motivo: string | null; selecionado: boolean;
  onEscolher: () => void; visita: string | null;
}) {
  return (
    <article className={`${styles.cartao} ${selecionado ? styles.cartaoSelecionado : ""}`} aria-label={salao.nome}>
      {recomendado ? <span className={styles.selo}>Recomendado{motivo ? ` · ${motivo}` : ""}</span> : null}
      <Galeria salao={salao} empresa={empresa} />
      <div className={styles.corpo}>
        <h2>{salao.nome}</h2>
        <p className={styles.numeros}>{linhaNumeros(salao)}</p>
        {salao.frase ? <p className={styles.frase}>{salao.frase}</p> : null}
        {salao.destaques.length ? (
          <ul className={styles.destaques}>{salao.destaques.map((d) => <li key={d}>{d}</li>)}</ul>
        ) : null}
        {salao.convivencia ? <p className={styles.factual}>{salao.convivencia}</p> : null}
        {salao.emTodosOsPacotes.length ? (
          <p className={styles.emTodos}><strong>Em todos os pacotes deste salão:</strong> {salao.emTodosOsPacotes.join(", ")}.</p>
        ) : null}
        {salao.grupos.length ? (
          <details className={styles.tudo}>
            <summary>Ver tudo o que o salão tem</summary>
            {salao.grupos.map((g) => (
              <div key={g.grupo}><strong>{g.nome}</strong><p>{g.itens.join(", ")}</p></div>
            ))}
          </details>
        ) : null}
        <div className={styles.acoes}>
          <button type="button" className={styles.escolher} aria-pressed={selecionado} onClick={onEscolher}>
            {selecionado ? "Salão escolhido ✓" : "Escolher este salão"}
          </button>
          {visita ? <a className={styles.visita} href={visita} target="_blank" rel="noreferrer">Agendar visita</a> : null}
        </div>
      </div>
    </article>
  );
}

export default function ConhecaSaloes({ empresa }: { empresa: string }) {
  const marca = useMarcaPublica();
  const router = useRouter();
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [lista, setLista] = useState<ListaPublica | null>(null);
  const [erro, setErro] = useState("");
  const [selecionado, setSelecionado] = useState<string | null>(null);
  // P2-1: a etapa saiu do ar com um salão já escolhido — o cliente decide, nada segue sozinho.
  const [semEtapa, setSemEtapa] = useState<(() => void) | null>(null);
  const contato = marca.kidmais ? null : linkContatoBuffet(marca.contato);
  const convidados = Number(params?.get("convidados") ?? 0);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      const atuais = new URLSearchParams(window.location.search);
      const consulta = new URLSearchParams(Object.fromEntries(
        ["data", "configuracaoId", "inicio", "fim", "convidados"].map((k) => [k, atuais.get(k) ?? ""])));
      const seguir = () => {
        const p = new URLSearchParams({ origem: "DISPONIBILIDADE" });
        for (const k of PARAMETROS) { const v = atuais.get(k); if (v) p.set(k, v); }
        router.replace(`${paginaPublica("/fechamento", empresa)}?${p}`);
      };
      try {
        const r = await fetch(apiPublica(`/api/publico/saloes?${consulta}`, empresa), { cache: "no-store" });
        if (cancelado) return;
        // Sem a etapa (flag, menos de 2 salões prontos, agenda por horário): o fluxo segue como depois da S-C.
        if (r.status === 404) {
          if (seguirSemEtapa(atuais)) seguir();
          else { setParams(atuais); setSemEtapa(() => seguir); }
          return;
        }
        const corpo = await r.json().catch(() => null) as { ok?: boolean; data?: ListaPublica } | null;
        if (!r.ok || !corpo?.data) throw new Error();
        setParams(atuais);
        setLista(corpo.data);
        const preferido = atuais.get("salao");
        setSelecionado(corpo.data.saloes.some((s) => s.id === preferido && s.situacao === "livre") ? preferido : selecaoInicial(corpo.data));
        if (atuais.get("aviso") === "salao") setErro("O salão escolhido não está mais disponível para a sua festa. Escolha outro salão.");
      } catch {
        if (!cancelado) setErro("Não foi possível carregar os salões agora. Tente novamente.");
      }
    })();
    return () => { cancelado = true; };
  }, [empresa, router]);

  const organizados = useMemo(() => (lista ? organizar(lista) : null), [lista]);
  const comparacao = useMemo(() => (organizados && organizados.principais.length > 1 ? diferencas(organizados.principais) : []), [organizados]);
  const escolhido = organizados?.principais.find((s) => s.id === selecionado) ?? null;
  const mesFotos = mesPorExtenso(lista?.saloes.find((s) => s.mesDasFotos)?.mesDasFotos ?? null);

  function continuar() {
    if (!params || !escolhido) return;
    const p = new URLSearchParams({ origem: "DISPONIBILIDADE" });
    for (const k of PARAMETROS) { const v = params.get(k); if (v) p.set(k, v); }
    p.set("salao", escolhido.id);
    router.push(`${paginaPublica("/fechamento", empresa)}?${p}`);
  }

  const voltar = `${paginaPublica("/disponibilidade", empresa)}`;

  return (
    <main className={styles.page}>
      <FestaDecoracao />
      <div className={styles.shell}>
        <header className={styles.header}>
          <MarcaPublicaCabecalho subtitle="Conheça os salões" />
          <a className={styles.voltar} href={voltar}>← Trocar data</a>
        </header>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Escolha o espaço</p>
          <h1>Conheça os salões</h1>
          {convidados ? <p>Para {convidados} convidados pagantes, no horário que você escolheu.</p> : null}
        </section>

        {erro ? <div className={styles.aviso} role="alert">{erro}</div> : null}
        {semEtapa ? (
          <div className={styles.semOpcao} role="alert">
            <strong>A escolha de salão não está mais disponível para esta data. O salão que você escolheu não será enviado.</strong>
            <a href={voltar}>Voltar e escolher outra data</a>
            <button type="button" className={styles.semPreferencia} onClick={semEtapa}>Continuar sem salão de preferência</button>
          </div>
        ) : null}
        {!lista && !erro && !semEtapa ? <p className={styles.carregando} role="status">Carregando os salões…</p> : null}

        {organizados && organizados.principais.length === 0 ? (
          <div className={styles.semOpcao} role="status">
            <strong>Nenhum salão livre comporta {convidados} convidados neste horário.</strong>
            <a href={voltar}>Escolher outra data</a>
            {contato ? <a href={contato} target="_blank" rel="noreferrer">Falar com o buffet</a> : null}
          </div>
        ) : null}

        {organizados ? (
          <div className={styles.lista}>
            {organizados.principais.map((s) => (
              <Cartao key={s.id} salao={s} empresa={empresa} recomendado={s.id === lista?.recomendado?.id}
                motivo={s.id === lista?.recomendado?.id ? lista?.recomendado?.motivo ?? null : null}
                selecionado={s.id === selecionado} onEscolher={() => setSelecionado(s.id)} visita={contato} />
            ))}
          </div>
        ) : null}

        {comparacao.length ? (
          <details className={styles.comparar}>
            <summary>Comparar em detalhes</summary>
            <table>
              <thead><tr><th scope="col" />{organizados!.principais.map((s) => <th key={s.id} scope="col">{s.nome}</th>)}</tr></thead>
              <tbody>{comparacao.map((l) => (
                <tr key={l.rotulo}><th scope="row">{l.rotulo}</th>{l.valores.map((v, i) => <td key={i}>{v}</td>)}</tr>
              ))}</tbody>
            </table>
          </details>
        ) : null}

        {organizados?.indisponiveis.length ? (
          <details className={styles.indisponiveis}>
            <summary>{organizados.indisponiveis.length === 1 ? "1 salão não serve para a sua festa" : `${organizados.indisponiveis.length} salões não servem para a sua festa`}</summary>
            <ul>{organizados.indisponiveis.map((s) => <li key={s.id}><strong>{s.nome}:</strong> {textoSituacao(s, convidados)}</li>)}</ul>
          </details>
        ) : null}

        {lista ? (
          <footer className={styles.rodape}>
            {mesFotos ? <p>Fotos de {mesFotos}.</p> : null}
            <p>O salão entra no contrato e só muda com o seu aceite. Emitir o contrato não reserva o salão; a reserva acontece quando você assina.</p>
            <p>A decoração varia conforme o pacote.</p>
          </footer>
        ) : null}
      </div>

      {escolhido ? (
        <div className={styles.barra}>
          <span>Salão de preferência: <strong>{escolhido.nome}</strong></span>
          <button type="button" onClick={continuar}>Continuar com {escolhido.nome} →</button>
        </div>
      ) : null}
    </main>
  );
}
