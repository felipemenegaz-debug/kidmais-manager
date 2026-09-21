'use client';
import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import KidmaisBrand from '@/components/layout/KidmaisBrand';
import { montarResumo, selecionarVersaoResumo, type PainelResumo, type FinanceiroResumo } from './resumo-contratacao';
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

export default function ResumoContratacao() {
  const [resumo, setResumo] = useState<Resumo | null>(null), [erro, setErro] = useState('');
  const impresso = useRef(false);
  useEffect(() => {
    let ativo = true;
    async function carregar() {
      const params = new URLSearchParams(window.location.search), contratoId = params.get('contratoId');
      if (!contratoId) throw Error('Selecione um contrato no módulo Contratos.');
      const response = await adminFetch(`/api/admin/contratos/painel?contratoId=${encodeURIComponent(contratoId)}`), body = await response.json();
      if (!response.ok || !body.ok) throw Error('Não foi possível consultar o contrato. Verifique sua sessão e tente novamente.');
      const painel = body.data as PainelResumo, versao = selecionarVersaoResumo(painel, params.get('versaoId'));
      let financeiro: FinanceiroResumo | null = null;
      if (versao.id === painel.fluxo?.versao_vigente_id && painel.financeiro.length) {
        const responseFinanceiro = await adminFetch(`/api/admin/contratos/${encodeURIComponent(contratoId)}/financeiro`), bodyFinanceiro = await responseFinanceiro.json();
        if (!responseFinanceiro.ok || !bodyFinanceiro.ok) throw Error('Não foi possível consultar o Financeiro. O resumo não será impresso com dados incompletos.');
        financeiro = bodyFinanceiro.data.painel;
      }
      if (ativo) setResumo(montarResumo(painel, versao.id, financeiro));
    }
    void carregar().catch(() => { if (ativo) setErro('Resumo indisponível. Confira a sessão, a versão selecionada e a disponibilidade do Financeiro no módulo Contratos.'); });
    return () => { ativo = false; };
  }, []);
  useEffect(() => {
    if (!resumo || new URLSearchParams(window.location.search).get('imprimir') !== '1' || impresso.current) return;
    let ativo = true;
    // Aguardar fontes e imagens evita impressão parcial da identidade visual.
    void Promise.all([document.fonts.ready, ...Array.from(document.images).map(image => image.decode().catch(() => {}))]).then(() => {
      if (ativo && !impresso.current) { impresso.current = true; window.print(); }
    });
    return () => { ativo = false; };
  }, [resumo]);
  return <main className={styles.page}>
    <div className={styles.toolbar}><a href="/admin/contratos">Voltar a Contratos</a><button disabled={!resumo || !!erro} onClick={() => window.print()}>Imprimir resumo</button><span>Consulta somente leitura</span></div>
    {erro ? <p role="alert">{erro}</p> : resumo ? <DocumentoResumo resumo={resumo} /> : <p role="status">Carregando resumo da versão selecionada…</p>}
  </main>;
}
