'use client';
import { useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { DesfechoTeste, ResultadoTeste } from '@/lib/whatsapp/atendimento/walle/teste';
import styles from './atendimento.module.css';

const LIMITE = 1000;
/** O que o worker faria com a mesma mensagem, em linguagem de atendimento. */
export const NOME_DESFECHO: Record<DesfechoTeste, string> = {
  RESPONDE: 'O Wall-e responderia assim:',
  RESPONDE_E_PASSA: 'O Wall-e responderia assim e passaria a conversa para a equipe:',
  PASSA_EM_SILENCIO: 'O Wall-e não responderia: a conversa iria para a equipe sem mensagem automática.',
  BLOQUEIA_NA_RECEPCAO: 'Pedido para não receber mensagens: o contato seria bloqueado antes do Wall-e e nada seria enviado.',
  BLOQUEIA: 'Pedido para não receber mensagens: o contato seria bloqueado e nada seria enviado.',
  FALHA: 'O Wall-e não encontrou resposta: a conversa iria para a equipe com o aviso fixo de encaminhamento.',
};

/**
 * Fatia 10a: "Testar o Wall-e". O dono escreve como se fosse o cliente e vê a resposta e de onde veio cada parte. Usa a
 * configuração SALVA (o que está no formulário e não foi salvo não entra) e uma conversa nova. Nada é enviado nem
 * gravado; o texto digitado fica só na tela.
 */
export default function TestarWallE() {
  const [texto, setTexto] = useState(''), [resultado, setResultado] = useState<ResultadoTeste | null>(null), [erro, setErro] = useState(''), [ocupado, setOcupado] = useState(false);
  async function testar() {
    const t = texto.trim(); if (!t || ocupado) return;
    setOcupado(true); setErro(''); setResultado(null);
    try {
      const r = await adminFetch('/api/admin/atendimento', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acao: 'testar', texto: t }) });
      const json = await r.json(); if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível testar agora.');
      setResultado(json.data);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível testar agora.'); } finally { setOcupado(false); }
  }
  return <section className={`${styles.painel} ${styles.testeWallE}`} aria-labelledby="testar-walle">
    <h2 id="testar-walle">Testar o Wall-e</h2>
    <p className={styles.nota}>Escreva como se fosse o cliente. Teste: nada é enviado nem gravado, e vale a configuração salva (salve antes o que mudou acima). Cada teste é uma conversa nova.</p>
    <form onSubmit={e => { e.preventDefault(); void testar(); }} aria-busy={ocupado || undefined}>
      <label>Mensagem do cliente<textarea value={texto} rows={3} maxLength={LIMITE} required placeholder="Ex.: Quanto custa o pacote para 50 crianças num sábado?" onChange={e => setTexto(e.target.value)} /></label>
      <button type="submit" className={styles.primario} disabled={ocupado || !texto.trim()}>{ocupado ? 'Testando…' : 'Testar'}</button>
    </form>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {resultado && <div className={styles.resultadoTeste} role="status" aria-live="polite">
      {resultado.mensagem && <p className={styles.nota}>Mensagem testada: “{resultado.mensagem}”</p>}
      <p><strong>{NOME_DESFECHO[resultado.desfecho]}</strong></p>
      {resultado.reclamacaoParaEquipe && <p className={styles.nota}>Como a mensagem também traz uma reclamação, a conversa iria para a equipe responder (sem mensagem automática).</p>}
      {resultado.respostas.length > 0 && <ol className={styles.listaSimples}>{resultado.respostas.map((r, i) => <li key={i} className={styles.respostaTeste}>
        {r.anexo && <p className={styles.nota}>Anexo: {r.anexo.titulo}</p>}
        {r.texto && <p className={styles.textoTeste}>{r.texto}</p>}
        {r.fontes.length > 0 && <p className={styles.nota}>Fonte: {r.fontes.join(' · ')}</p>}
      </li>)}</ol>}
      {resultado.motivos.length > 0 && <p className={styles.nota}>Motivo da passagem: {resultado.motivos.join('; ')}</p>}
      {resultado.entendidoPor && <p className={styles.nota}>{resultado.entendidoPor === 'MODELO' ? 'Mensagem entendida pelo modelo de IA (conta no limite de IA da empresa) e conferida pelas regras.' : 'Mensagem entendida pelas regras locais, sem modelo de IA.'}</p>}
    </div>}
  </section>;
}
