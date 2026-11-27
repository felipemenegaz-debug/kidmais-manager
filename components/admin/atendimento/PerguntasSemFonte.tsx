'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { estadoDoGrupo, type GrupoSemFonte, type PerguntaAprovada } from '@/lib/whatsapp/atendimento/sem-fonte-texto';
import styles from './atendimento.module.css';

type Dados = { disponivel: boolean; dias: number; grupos: GrupoSemFonte[]; omitidasSensiveis: number; limite: number; publicadas: number };
const dataCurta = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }); };

/**
 * Fatia 7: perguntas que o Wall-e passou para a equipe por não ter fonte (últimos 30 dias), agrupadas. O texto do
 * cliente é só para leitura: "Criar resposta" abre uma pergunta VAZIA ligada ao grupo e a pessoa escreve a pergunta com
 * as próprias palavras (desenho novo, decisão de Felipe depois do Astra r3). Nada é gravado até "Salvar configuração" e
 * o texto nunca vai para a URL nem para o formulário.
 * O selo usa a configuração SALVA mais recente (`salvas`, recarregada depois de salvar), o formulário e o vínculo
 * resposta → grupo: só no formulário é rascunho; salva é "Já tem resposta aprovada"; removida, volta o botão.
 */
export default function PerguntasSemFonte({ salvas, formulario, vinculos, limite, onCriar }: { salvas: PerguntaAprovada[]; formulario: PerguntaAprovada[]; vinculos: Record<string, string>; limite: number; onCriar: (grupoId: string) => void }) {
  const [dados, setDados] = useState<Dados | null>(null), [erro, setErro] = useState('');
  const carregar = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/atendimento/sem-fonte'); const json = await r.json();
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar as perguntas sem resposta.');
      setDados(json.data); setErro('');
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível carregar as perguntas sem resposta.'); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [carregar]);
  const esgotado = formulario.length >= limite;
  return <section className={styles.semFonte} aria-labelledby="sem-fonte-titulo">
    <h4 id="sem-fonte-titulo">Perguntas que o Wall-e não soube responder</h4>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {!dados && !erro && <p aria-live="polite" className={styles.nota}>Carregando perguntas…</p>}
    {dados && !dados.disponivel && <p className={styles.nota}>Disponível depois da atualização deste ambiente (Wall-e).</p>}
    {dados?.disponivel && <>
      <p className={styles.nota}>Últimos {dados.dias} dias. Os trechos têm mascaramento automático, mas ainda podem conter dados pessoais do cliente. O texto do cliente fica só aqui: em “Criar resposta”, escreva a pergunta com suas palavras, de forma geral, e a resposta da empresa. O Wall-e passa a usar depois de salvar.</p>
      {esgotado && <p className={styles.limiteEsgotado} role="status">Limite de {limite} respostas aprovadas atingido: remova uma resposta para criar outra.</p>}
      {dados.grupos.length === 0 && <p className={styles.nota}>Nenhuma pergunta sem resposta neste período.</p>}
      {dados.grupos.length > 0 && <ul className={styles.listaSemFonte}>{dados.grupos.map(g => {
        const estado = estadoDoGrupo(g, salvas, formulario, vinculos);
        return <li key={g.id} className={styles.itemSemFonte}>
          <q>{g.texto}</q>
          <span className={styles.nota}>{g.ocorrencias === 1 ? '1 vez' : `${g.ocorrencias} vezes`}{dataCurta(g.ultimaEm) && ` · última em ${dataCurta(g.ultimaEm)}`}</span>
          {estado === 'publicada' ? <span className={styles.seloSemFonte}>Já tem resposta aprovada</span>
            : estado === 'rascunho' ? <span className={styles.nota}>Resposta em edição no formulário: escreva a resposta e salve a configuração.</span>
            : <button type="button" disabled={esgotado} onClick={() => onCriar(g.id)}>Criar resposta<span className={styles.oculto}> para esta pergunta</span></button>}
        </li>; })}</ul>}
      {dados.omitidasSensiveis > 0 && <p className={styles.nota}>{dados.omitidasSensiveis === 1 ? '1 pergunta com dado sensível ou nome do cliente não aparece aqui' : `${dados.omitidasSensiveis} perguntas com dado sensível ou nome do cliente não aparecem aqui`} (ficam só no histórico da conversa).</p>}
    </>}
  </section>;
}
