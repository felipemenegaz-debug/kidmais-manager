/* eslint-disable @next/next/no-img-element -- Imagens do próprio site já reprocessadas (WebP) e servidas com cache; sem otimizador remoto. */
import type { CSSProperties } from 'react';
import type { ConteudoPublicado } from '@/lib/marketing/site/conteudo';
import { contatoPublicoDe } from '@/lib/fechamentos/marca-publica';
import FormularioOrcamento, { type CapturaFormulario } from './FormularioOrcamento';
import styles from './site-publico.module.css';

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function moeda(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function dataCurta(iso: string) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

export type DatasLivresPublicas = Array<{ data: string; diaSemana: number }>;

/**
 * Página pública do buffet (modelo único, responsivo). Só TEXTO do conteúdo publicado; nada de HTML do usuário.
 * Usada pela página pública (servidor) e pela prévia administrativa (cliente) com a mesma marcação.
 */
export default function SitePublicoPagina({ conteudo, urlImagem, base, acaoFormulario, captura, datasLivres, previa = false }: {
  conteudo: ConteudoPublicado;
  urlImagem: (id: string) => string;
  base: string;
  acaoFormulario: string;
  captura: CapturaFormulario;
  datasLivres: DatasLivresPublicas | null;
  previa?: boolean;
}) {
  const c = conteudo;
  const contato = contatoPublicoDe({ telefone: c.contato.telefone, whatsapp: c.contato.whatsapp, email: c.contato.email, instagram: c.contato.instagram });
  const kc = captura.kc ? `?kc=${encodeURIComponent(captura.kc)}` : '';
  const linkWhatsapp = c.contato.botaoWhatsapp && contato?.whatsapp ? (previa ? '#' : `${base}/whatsapp${kc}`) : null;
  const cores = { '--cor-primaria': c.identidade.corPrimaria, '--cor-secundaria': c.identidade.corSecundaria } as CSSProperties;
  const local = c.localizacao;
  const temLocal = local.mostrar && (local.endereco || local.cidade);
  return <div className={styles.pagina} style={cores}>
    <header className={styles.topo}>
      <div className={styles.marca}>
        {c.identidade.logoImagemId && <img className={styles.logo} src={urlImagem(c.identidade.logoImagemId)} alt={`Logo ${c.identidade.nome}`} />}
        <span>{c.identidade.nome}</span>
      </div>
      <nav aria-label="Seções" className={styles.navegacao}>
        {c.apresentacao.texto && <a href="#sobre">Sobre</a>}
        {c.pacotes.length > 0 && <a href="#pacotes">Pacotes</a>}
        {temLocal && <a href="#local">Onde estamos</a>}
        {c.formulario.ativo && <a className={styles.botaoTopo} href="#orcamento">Pedir orçamento</a>}
      </nav>
    </header>

    <section className={styles.hero} aria-labelledby="titulo-site">
      <div className={styles.heroTexto}>
        <h1 id="titulo-site">{c.apresentacao.titulo || c.identidade.nome}</h1>
        {c.identidade.slogan && <p className={styles.slogan}>{c.identidade.slogan}</p>}
        <div className={styles.acoes}>
          {c.formulario.ativo && <a className={styles.botaoPrimario} href="#orcamento">Pedir orçamento</a>}
          {linkWhatsapp && <a className={styles.botaoSecundario} href={linkWhatsapp} rel="nofollow noopener">Falar no WhatsApp</a>}
        </div>
      </div>
      {c.galeria[0] && <img className={styles.heroImagem} src={urlImagem(c.galeria[0].imagemId)} alt={c.galeria[0].legenda || `Espaço do ${c.identidade.nome}`} />}
    </section>

    {c.apresentacao.texto && <section id="sobre" className={styles.secao} aria-labelledby="t-sobre">
      <h2 id="t-sobre">Sobre o buffet</h2>
      {c.apresentacao.texto.split(/\n{2,}/).map((p, i) => <p key={i} className={styles.paragrafo}>{p}</p>)}
    </section>}

    {c.galeria.length > 1 && <section className={styles.secao} aria-labelledby="t-galeria">
      <h2 id="t-galeria">Galeria</h2>
      <ul className={styles.galeria}>
        {c.galeria.slice(1).map((g) => <li key={g.imagemId}><figure><img src={urlImagem(g.imagemId)} alt={g.legenda || `Foto do ${c.identidade.nome}`} loading="lazy" />{g.legenda && <figcaption>{g.legenda}</figcaption>}</figure></li>)}
      </ul>
    </section>}

    {(c.estrutura.capacidade || c.estrutura.itens.length > 0) && <section className={styles.secao} aria-labelledby="t-estrutura">
      <h2 id="t-estrutura">Estrutura</h2>
      {c.estrutura.capacidade && <p className={styles.destaque}>{c.estrutura.capacidade}</p>}
      {c.estrutura.itens.length > 0 && <ul className={styles.lista}>{c.estrutura.itens.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    </section>}

    {c.pacotes.length > 0 && <section id="pacotes" className={styles.secao} aria-labelledby="t-pacotes">
      <h2 id="t-pacotes">Pacotes</h2>
      <ul className={styles.pacotes}>
        {c.pacotes.map((p) => <li key={p.codigo} className={styles.pacote}>
          <h3>{p.nome}</h3>
          {p.destaque && <p className={styles.destaque}>{p.destaque}</p>}
          {p.descricao && <p>{p.descricao}</p>}
          <p className={styles.detalhes}>
            {p.convidadosMinimos && p.convidadosMaximos ? <span>{p.convidadosMinimos} a {p.convidadosMaximos} convidados</span> : null}
            {p.duracaoMinutos ? <span>{Math.round(p.duracaoMinutos / 60 * 10) / 10} h de festa</span> : null}
          </p>
          {p.precoAPartirCentavos !== null && <p className={styles.preco}>a partir de <strong>{moeda(p.precoAPartirCentavos)}</strong></p>}
        </li>)}
      </ul>
      {c.pacotes.some((p) => p.precoAPartirCentavos !== null) && <p className={styles.legal}>Valores de referência da tabela vigente quando o site foi publicado. O valor final depende da data, do horário e dos itens escolhidos e é confirmado no orçamento.</p>}
    </section>}

    {temLocal && <section id="local" className={styles.secao} aria-labelledby="t-local">
      <h2 id="t-local">Onde estamos</h2>
      <address className={styles.endereco}>
        {local.endereco && <span>{local.endereco}</span>}
        {(local.bairro || local.cidade) && <span>{[local.bairro, [local.cidade, local.uf].filter(Boolean).join(' - ')].filter(Boolean).join(', ')}</span>}
        {local.cep && <span>CEP {local.cep}</span>}
        {local.referencia && <span>{local.referencia}</span>}
      </address>
      {local.linkMapa && <a className={styles.botaoSecundario} href={local.linkMapa} rel="nofollow noopener noreferrer" target="_blank">Abrir no mapa</a>}
    </section>}

    {c.formulario.ativo && <section id="orcamento" className={`${styles.secao} ${styles.secaoOrcamento}`} aria-labelledby="t-orcamento">
      <h2 id="t-orcamento">Peça seu orçamento</h2>
      {datasLivres && datasLivres.length > 0 && <div className={styles.datas}>
        <p>Algumas datas com horários livres no momento:</p>
        <ul>{datasLivres.map((d) => <li key={d.data}>{DIAS[d.diaSemana]}, {dataCurta(d.data)}</li>)}</ul>
        <p className={styles.legal}>Disponibilidade sujeita a confirmação; a data só é reservada com contrato.</p>
      </div>}
      <FormularioOrcamento acao={acaoFormulario} captura={captura} previa={previa} />
    </section>}

    {contato && <section className={styles.secao} aria-labelledby="t-contato">
      <h2 id="t-contato">Contato</h2>
      <ul className={styles.contatos}>
        {contato.whatsapp && linkWhatsapp && <li><a href={linkWhatsapp} rel="nofollow noopener">WhatsApp {contato.whatsapp.texto}</a></li>}
        {contato.telefone && <li><a href={contato.telefone.url}>Telefone {contato.telefone.texto}</a></li>}
        {contato.email && <li><a href={`mailto:${contato.email}`}>{contato.email}</a></li>}
        {contato.instagram && <li><a href={contato.instagram.url} rel="nofollow noopener noreferrer" target="_blank">Instagram {contato.instagram.texto}</a></li>}
      </ul>
    </section>}

    <footer className={styles.rodape}><span>© {c.identidade.nome}</span><span>Site feito com Kidmais Manager</span></footer>
  </div>;
}
