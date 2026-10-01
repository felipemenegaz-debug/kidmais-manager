'use client';
import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import KidmaisBrand from '@/components/layout/KidmaisBrand';
import { carregarResumo, type montarResumo } from './resumo-contratacao';
import { criarPdfResumo, dimensoesJpeg, nomeArquivoResumo, type LogoJpeg } from './resumo-pdf';
import styles from './resumo-contratacao.module.css';

type Resumo = ReturnType<typeof montarResumo>;
export function DocumentoResumo({ resumo }: { resumo: Resumo }) {
  return <article className={styles.sheet} aria-label="Resumo da contratação">
    <header className={styles.heading}><KidmaisBrand context="customer" subtitle="Resumo da contratação" /><p className={styles.badge}>V{resumo.numeroVersao} · {resumo.classificacao}</p></header>
    <h1>Resumo da Contratação</h1>
    <p className={styles.notice}>Documento operacional e comercial. Não substitui o contrato jurídico nem seus comprovantes de assinatura.</p>
    {resumo.secoes.map(secao => <section key={secao.titulo}><h2>{secao.titulo}</h2><dl>{secao.linhas.map(([label, value], i) => <div key={`${label}:${i}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>)}
    <section><h2>Plano e cronograma financeiro</h2><p>{resumo.avisoFinanceiro}</p>
      {resumo.parcelas.length ? <table><thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th><th>Estado</th></tr></thead><tbody>{resumo.parcelas.map((parcela, i) => <tr key={i}><td>{parcela.rotulo}</td><td>{parcela.valor}</td><td>{parcela.vencimento}</td><td>{parcela.estado}</td></tr>)}</tbody></table> : <p>Nenhum cronograma aplicável disponível nesta consulta.</p>}
    </section>
    <footer>Kidmais · Resumo para consulta · Condições comerciais da versão selecionada, sem recálculo.</footer>
  </article>;
}

const LOGO_PDF = '/assets/contratos/kidmais-logo-template-v1.jpg';

/** O logo é opcional: sem ele o PDF sai com a marca em texto, nunca falha por isso. */
async function carregarLogo(): Promise<LogoJpeg | null> {
  try {
    const resposta = await fetch(LOGO_PDF, { cache: 'force-cache' });
    if (!resposta.ok) return null;
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    const dimensoes = dimensoesJpeg(bytes);
    return dimensoes ? { bytes, ...dimensoes } : null;
  } catch {
    return null;
  }
}

/** Download direto do arquivo: não abre o diálogo de impressão nem uma nova aba. */
async function baixarPdf(resumo: Resumo) {
  const pdf = criarPdfResumo(resumo, await carregarLogo());
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivoResumo(resumo.arquivo.contratante, resumo.arquivo.dataEvento);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `vitrine`: dados estáticos para /preview-ux (sem sessão e sem rede). */
export default function ResumoContratacao({ vitrine }: { vitrine?: Resumo } = {}) {
  const [resumo, setResumo] = useState<Resumo | null>(vitrine ?? null), [erro, setErro] = useState('');
  const [baixando, setBaixando] = useState(false), [erroPdf, setErroPdf] = useState('');
  const impresso = useRef(false), baixado = useRef(false);
  async function baixar() {
    if (!resumo || baixando) return;
    setBaixando(true); setErroPdf('');
    try { await baixarPdf(resumo); } catch { setErroPdf('Não foi possível gerar o PDF agora. Tente novamente ou use Imprimir.'); } finally { setBaixando(false); }
  }
  useEffect(() => {
    if (vitrine) return;
    let ativo = true;
    async function carregar() {
      const params = new URLSearchParams(window.location.search), contratoId = params.get('contratoId');
      if (!contratoId) throw Error('Selecione um contrato no módulo Contratos.');
      const pronto = await carregarResumo(adminFetch, contratoId, params.get('versaoId'));
      if (ativo) setResumo(pronto);
    }
    void carregar().catch(() => { if (ativo) setErro('Resumo indisponível. Confira a sessão, a versão selecionada e a disponibilidade do Financeiro no módulo Contratos.'); });
    return () => { ativo = false; };
  }, [vitrine]);
  useEffect(() => {
    if (!resumo || new URLSearchParams(window.location.search).get('imprimir') !== '1' || impresso.current) return;
    let ativo = true;
    // Aguardar fontes e imagens evita impressão parcial da identidade visual.
    void Promise.all([document.fonts.ready, ...Array.from(document.images).map(image => image.decode().catch(() => {}))]).then(() => {
      if (ativo && !impresso.current) { impresso.current = true; window.print(); }
    });
    return () => { ativo = false; };
  }, [resumo]);
  useEffect(() => {
    // `?baixar=1` vem do atalho "Baixar PDF" em Contratos: baixa uma única vez, sem imprimir.
    if (!resumo || new URLSearchParams(window.location.search).get('baixar') !== '1' || baixado.current) return;
    baixado.current = true;
    void baixarPdf(resumo).catch(() => setErroPdf('Não foi possível gerar o PDF agora. Tente novamente ou use Imprimir.'));
  }, [resumo]);
  const indisponivel = !resumo || !!erro;
  return <main className={styles.page}>
    <div className={styles.toolbar}>
      <a className={styles.voltar} href="/admin/contratos"><span aria-hidden="true">←</span> Voltar a Contratos</a>
      <div className={styles.acoes}>
        <button type="button" className={styles.principal} disabled={indisponivel || baixando} aria-busy={baixando} onClick={() => void baixar()}>{baixando ? 'Gerando PDF…' : 'Baixar PDF'}</button>
        <button type="button" className={styles.secundaria} disabled={indisponivel} onClick={() => window.print()}>Imprimir</button>
      </div>
      <span className={styles.somenteLeitura}>Consulta somente leitura</span>
    </div>
    {erroPdf && <p className={styles.erroPdf} role="alert">{erroPdf}</p>}
    {erro ? <p role="alert">{erro}</p> : resumo ? <DocumentoResumo resumo={resumo} /> : <p role="status">Carregando resumo da versão selecionada…</p>}
  </main>;
}
