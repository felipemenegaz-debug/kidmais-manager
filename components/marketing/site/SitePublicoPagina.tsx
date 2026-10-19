/* eslint-disable @next/next/no-img-element -- Imagens do próprio site já reprocessadas (WebP) e servidas com cache; sem otimizador remoto. */
import type { CSSProperties } from 'react';
import type { ConteudoPublicado } from '@/lib/marketing/site/conteudo';
import { temaDoSite } from '@/lib/marketing/site/tema';
import { contatoPublicoDe } from '@/lib/fechamentos/marca-publica';
import FormularioOrcamento, { type CapturaFormulario } from './FormularioOrcamento';
import GaleriaNavegavel from './GaleriaNavegavel';
import BarraAcaoCelular from './BarraAcaoCelular';
import styles from './site-publico.module.css';

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function moeda(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function dataCurta(iso: string) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}
function iniciais(nome: string) {
  return nome.split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÀ-Ú]/.test(p)).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || nome.slice(0, 1).toUpperCase();
}
function horas(minutos: number) {
  const h = Math.round((minutos / 60) * 10) / 10;
  return `${String(h).replace('.', ',')} h de festa`;
}

export type DatasLivresPublicas = Array<{ data: string; diaSemana: number }>;

/** Ícone simples (traço), decorativo. */
function Icone({ tipo }: { tipo: 'ok' | 'pessoas' | 'relogio' | 'local' | 'mensagem' }) {
  const d = {
    ok: 'M5 12.5l4.2 4.2L19 7',
    pessoas: 'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 0a2.5 2.5 0 1 0 0-5M3 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5m1.5-5c2.5 0 5 1.6 5 4.5',
    relogio: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4.5l3 2',
    local: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    mensagem: 'M4 5h16v11H8l-4 4V5z',
  }[tipo];
  return <svg className={styles.icone} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/**
 * Página pública do buffet. Um só renderizador para a página publicada (servidor) e para a prévia do editor (cliente):
 * o que a equipe vê na prévia é o que o visitante vê. Só TEXTO do conteúdo (nada de HTML do usuário). O estilo da
 * unidade (data-estilo) muda composição/tipografia; as cores vêm do tema calculado (contraste garantido).
 * Layout por container queries: a prévia "celular" dentro do editor mostra de fato o layout de celular.
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
  const { estilo, variaveis } = temaDoSite(c);
  const contato = contatoPublicoDe({ telefone: c.contato.telefone, whatsapp: c.contato.whatsapp, email: c.contato.email, instagram: c.contato.instagram });
  const kc = captura.kc ? `?kc=${encodeURIComponent(captura.kc)}` : '';
  const linkWhatsapp = c.contato.botaoWhatsapp && contato?.whatsapp ? (previa ? '#' : `${base}/whatsapp${kc}`) : null;
  const local = c.localizacao;
  const temLocal = local.mostrar && Boolean(local.endereco || local.cidade);
  const cidade = [local.cidade, local.uf].filter(Boolean).join(' - ');
  const capa = c.galeria[0] ?? null;
  const fotosGaleria = c.galeria.slice(capa ? 1 : 0).map((g) => ({ src: urlImagem(g.imagemId), legenda: g.legenda }));
  const paragrafos = c.apresentacao.texto.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const temEstrutura = Boolean(c.estrutura.capacidade || c.estrutura.itens.length > 0);
  const fatos = [
    c.estrutura.capacidade ? { icone: 'pessoas' as const, texto: c.estrutura.capacidade } : null,
    temLocal && (local.bairro || cidade) ? { icone: 'local' as const, texto: [local.bairro, cidade].filter(Boolean).join(', ') } : null,
    c.formulario.ativo ? { icone: 'mensagem' as const, texto: 'Orçamento sem compromisso' } : null,
  ].filter((f): f is { icone: 'pessoas' | 'local' | 'mensagem'; texto: string } => Boolean(f));

  return <div className={styles.casca}>
    <div className={styles.pagina} data-estilo={estilo} style={variaveis as CSSProperties}>
      {c.formulario.ativo && <a className={styles.pularPara} href="#orcamento">Ir para o pedido de orçamento</a>}
      <header className={styles.topo}>
        <a className={styles.marca} href="#inicio" aria-label={`${c.identidade.nome} — início`}>
          {c.identidade.logoImagemId
            ? <img className={styles.logo} src={urlImagem(c.identidade.logoImagemId)} alt="" width={160} height={48} />
            : <span className={styles.monograma} aria-hidden="true">{iniciais(c.identidade.nome)}</span>}
          <span className={styles.marcaNome}>{c.identidade.nome}</span>
        </a>
        <nav aria-label="Seções" className={styles.navegacao}>
          {paragrafos.length > 0 && <a href="#sobre">Sobre</a>}
          {temEstrutura && <a href="#estrutura">Estrutura</a>}
          {fotosGaleria.length > 0 && <a href="#galeria">Fotos</a>}
          {c.pacotes.length > 0 && <a href="#pacotes">Pacotes</a>}
          {temLocal && <a href="#local">Onde estamos</a>}
        </nav>
        {c.formulario.ativo && <a className={`${styles.botaoPrimario} ${styles.botaoTopo}`} href="#orcamento">Pedir orçamento</a>}
      </header>

      <section id="inicio" className={styles.hero} data-capa={capa ? 'sim' : 'nao'} aria-labelledby="titulo-site">
        {capa && <img className={styles.heroImagem} src={urlImagem(capa.imagemId)} alt={capa.legenda || `Espaço do ${c.identidade.nome}`} width={1600} height={1000} fetchPriority="high" />}
        {!capa && <div className={styles.heroDecoracao} aria-hidden="true"><span /><span /><span /></div>}
        <div className={styles.heroConteudo}>
          {c.apresentacao.titulo && c.apresentacao.titulo !== c.identidade.nome && <p className={styles.sobretitulo}>{c.identidade.nome}</p>}
          <h1 id="titulo-site">{c.apresentacao.titulo || c.identidade.nome}</h1>
          {c.identidade.slogan && <p className={styles.heroResumo}>{c.identidade.slogan}</p>}
          <div className={styles.acoes}>
            {c.formulario.ativo && <a className={styles.botaoPrimario} href="#orcamento">Pedir orçamento</a>}
            {linkWhatsapp && <a className={styles.botaoSecundario} href={linkWhatsapp} rel="nofollow noopener">Falar no WhatsApp</a>}
          </div>
          {fatos.length > 0 && <ul className={styles.fatos}>{fatos.map((f) => <li key={f.texto}><Icone tipo={f.icone} /><span>{f.texto}</span></li>)}</ul>}
        </div>
      </section>

      {paragrafos.length > 0 && <section id="sobre" className={styles.secao} aria-labelledby="t-sobre">
        <div className={styles.sobre}>
          <div>
            <p className={styles.rotuloSecao}>Sobre</p>
            <h2 id="t-sobre">Conheça o {c.identidade.nome}</h2>
          </div>
          <div className={styles.texto}>{paragrafos.map((p, i) => <p key={i}>{p}</p>)}</div>
        </div>
      </section>}

      {temEstrutura && <section id="estrutura" className={`${styles.secao} ${styles.secaoAlternada}`} aria-labelledby="t-estrutura">
        <p className={styles.rotuloSecao}>Estrutura</p>
        <h2 id="t-estrutura">O que o espaço oferece</h2>
        <div className={styles.estrutura}>
          {c.estrutura.capacidade && <div className={styles.capacidade}><Icone tipo="pessoas" /><strong>{c.estrutura.capacidade}</strong></div>}
          {c.estrutura.itens.length > 0 && <ul className={styles.itens}>{c.estrutura.itens.map((item, i) => <li key={i}><Icone tipo="ok" /><span>{item}</span></li>)}</ul>}
        </div>
      </section>}

      {fotosGaleria.length > 0 && <section id="galeria" className={styles.secao} aria-labelledby="t-galeria">
        <p className={styles.rotuloSecao}>Fotos</p>
        <h2 id="t-galeria">Por dentro do espaço</h2>
        <GaleriaNavegavel fotos={fotosGaleria} nome={c.identidade.nome} />
      </section>}

      {c.pacotes.length > 0 && <section id="pacotes" className={`${styles.secao} ${styles.secaoAlternada}`} aria-labelledby="t-pacotes">
        <p className={styles.rotuloSecao}>Pacotes</p>
        <h2 id="t-pacotes">Escolha o formato da sua festa</h2>
        <ul className={styles.pacotes} data-quantidade={c.pacotes.length}>
          {c.pacotes.map((p) => <li key={p.codigo} className={styles.pacote}>
            {p.imagemId && <img className={styles.pacoteImagem} src={urlImagem(p.imagemId)} alt={`Pacote ${p.nome}`} loading="lazy" width={640} height={400} />}
            <div className={styles.pacoteCorpo}>
              {p.destaque && <p className={styles.selo}>{p.destaque}</p>}
              <h3>{p.nome}</h3>
              {p.descricao && <p className={styles.pacoteDescricao}>{p.descricao}</p>}
              {(p.convidadosMinimos || p.convidadosMaximos || p.duracaoMinutos) && <ul className={styles.pacoteDetalhes}>
                {p.convidadosMinimos && p.convidadosMaximos ? <li><Icone tipo="pessoas" />{p.convidadosMinimos} a {p.convidadosMaximos} convidados</li>
                  : p.convidadosMaximos ? <li><Icone tipo="pessoas" />até {p.convidadosMaximos} convidados</li> : null}
                {p.duracaoMinutos ? <li><Icone tipo="relogio" />{horas(p.duracaoMinutos)}</li> : null}
              </ul>}
              {p.precoAPartirCentavos !== null && <p className={styles.preco}>a partir de <strong>{moeda(p.precoAPartirCentavos)}</strong></p>}
              {c.formulario.ativo && <a className={styles.botaoSecundario} href="#orcamento">Pedir orçamento</a>}
            </div>
          </li>)}
        </ul>
        {c.pacotes.some((p) => p.precoAPartirCentavos !== null) && <p className={styles.legal}>Valores de referência da tabela vigente quando o site foi publicado. O valor final depende da data, do horário e dos itens escolhidos e é confirmado no orçamento.</p>}
      </section>}

      {temLocal && <section id="local" className={styles.secao} aria-labelledby="t-local">
        <div className={styles.local}>
          <div>
            <p className={styles.rotuloSecao}>Onde estamos</p>
            <h2 id="t-local">Venha conhecer</h2>
          </div>
          <div className={styles.localCartao}>
            <Icone tipo="local" />
            <address className={styles.endereco}>
              {local.endereco && <span>{local.endereco}</span>}
              {(local.bairro || cidade) && <span>{[local.bairro, cidade].filter(Boolean).join(', ')}</span>}
              {local.cep && <span>CEP {local.cep}</span>}
              {local.referencia && <span className={styles.suave}>{local.referencia}</span>}
            </address>
            {local.linkMapa && <a className={styles.botaoSecundario} href={local.linkMapa} rel="nofollow noopener noreferrer" target="_blank">Abrir no mapa</a>}
          </div>
        </div>
      </section>}

      {c.formulario.ativo && <section id="orcamento" className={`${styles.secao} ${styles.secaoOrcamento}`} aria-labelledby="t-orcamento">
        <div className={styles.orcamento}>
          <div className={styles.orcamentoIntro}>
            <p className={styles.rotuloSecao}>Orçamento</p>
            <h2 id="t-orcamento">Peça seu orçamento</h2>
            <p>Conte a data e o número de convidados. A equipe responde pelo telefone ou e-mail informado.</p>
            <ul className={styles.garantias}>
              <li><Icone tipo="ok" />Sem compromisso</li>
              <li><Icone tipo="ok" />A data só fica reservada com contrato</li>
            </ul>
            {datasLivres && datasLivres.length > 0 && <div className={styles.datas}>
              <p>Algumas datas com horários livres no momento:</p>
              <ul>{datasLivres.map((d) => <li key={d.data}>{DIAS[d.diaSemana]}, {dataCurta(d.data)}</li>)}</ul>
              <p className={styles.legal}>Disponibilidade sujeita a confirmação.</p>
            </div>}
          </div>
          <div className={styles.orcamentoFormulario}>
            <FormularioOrcamento acao={acaoFormulario} captura={captura} previa={previa} />
          </div>
        </div>
      </section>}

      <footer className={styles.rodape}>
        <div className={styles.rodapeMarca}>
          <strong>{c.identidade.nome}</strong>
          {c.identidade.slogan && <span>{c.identidade.slogan}</span>}
        </div>
        {contato && <ul className={styles.contatos} aria-label="Contato">
          {contato.whatsapp && linkWhatsapp && <li><a href={linkWhatsapp} rel="nofollow noopener">WhatsApp {contato.whatsapp.texto}</a></li>}
          {contato.telefone && <li><a href={contato.telefone.url}>Telefone {contato.telefone.texto}</a></li>}
          {contato.email && <li><a href={`mailto:${contato.email}`}>{contato.email}</a></li>}
          {contato.instagram && <li><a href={contato.instagram.url} rel="nofollow noopener noreferrer" target="_blank">Instagram {contato.instagram.texto}</a></li>}
        </ul>}
        <p className={styles.creditos}>© {c.identidade.nome} · Site feito com Kidmais Manager</p>
      </footer>

      <BarraAcaoCelular orcamento={c.formulario.ativo} whatsapp={linkWhatsapp} />
    </div>
  </div>;
}
