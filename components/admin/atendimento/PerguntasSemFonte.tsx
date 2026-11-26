'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { chaveDoGrupo, type GrupoSemFonte } from '@/lib/whatsapp/atendimento/sem-fonte-texto';
import styles from './atendimento.module.css';

type Dados = { disponivel: boolean; dias: number; grupos: GrupoSemFonte[]; omitidasSensiveis: number; limite: number; publicadas: number };
const dataCurta = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }); };

/**
 * Fatia 7: perguntas que o Wall-e passou para a equipe por não ter fonte (últimos 30 dias), agrupadas. "Criar resposta"
 * só pré-preenche o formulário com o texto já mascarado; a pessoa escreve a resposta e revisa a pergunta, e nada é
 * gravado até "Salvar configuração". O texto nunca vai para a URL.
 */
export default function PerguntasSemFonte({ perguntasNoFormulario, limite, onCriar }: { perguntasNoFormulario: string[]; limite: number; onCriar: (texto: string) => void }) {
  const [dados, setDados] = useState<Dados | null>(null), [erro, setErro] = useState('');
  const carregar = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/atendimento/sem-fonte'); const json = await r.json();
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar as perguntas sem resposta.');
      setDados(json.data); setErro('');
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível carregar as perguntas sem resposta.'); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [carregar]);
  const noFormulario = new Set(perguntasNoFormulario.map(chaveDoGrupo));
  const esgotado = perguntasNoFormulario.length >= limite;
  return <section className={styles.semFonte} aria-labelledby="sem-fonte-titulo">
    <h4 id="sem-fonte-titulo">Perguntas que o Wall-e não soube responder</h4>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {!dados && !erro && <p aria-live="polite" className={styles.nota}>Carregando perguntas…</p>}
    {dados && !dados.disponivel && <p className={styles.nota}>Disponível depois da atualização deste ambiente (Wall-e).</p>}
    {dados?.disponivel && <>
      <p className={styles.nota}>Últimos {dados.dias} dias, sem os dados pessoais do cliente. Crie a resposta com o texto da empresa: o Wall-e passa a usar depois de salvar.</p>
      {esgotado && <p className={styles.limiteEsgotado} role="status">Limite de {limite} respostas aprovadas atingido: remova uma resposta para criar outra.</p>}
      {dados.grupos.length === 0 && <p className={styles.nota}>Nenhuma pergunta sem resposta neste período.</p>}
      {dados.grupos.length > 0 && <ul className={styles.listaSemFonte}>{dados.grupos.map(g => {
        const criada = g.jaPublicada || noFormulario.has(chaveDoGrupo(g.texto));
        return <li key={g.id} className={styles.itemSemFonte}>
          <q>{g.texto}</q>
          <span className={styles.nota}>{g.ocorrencias === 1 ? '1 vez' : `${g.ocorrencias} vezes`}{dataCurta(g.ultimaEm) && ` · última em ${dataCurta(g.ultimaEm)}`}</span>
          {g.precisaRevisar && !criada && <span className={styles.nota}>Tem um trecho omitido (dado do cliente): reescreva a pergunta de forma geral antes de salvar.</span>}
          {criada ? <span className={styles.seloSemFonte}>Já tem resposta aprovada</span>
            : <button type="button" disabled={esgotado} onClick={() => onCriar(g.texto)}>Criar resposta<span className={styles.oculto}> para esta pergunta</span></button>}
        </li>; })}</ul>}
      {dados.omitidasSensiveis > 0 && <p className={styles.nota}>{dados.omitidasSensiveis === 1 ? '1 pergunta com dado sensível não aparece aqui' : `${dados.omitidasSensiveis} perguntas com dado sensível não aparecem aqui`} (ficam só no histórico da conversa).</p>}
    </>}
  </section>;
}
