'use client';
import { useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { consultarAtencaoHoje, type AtencaoHoje } from './inteligencia/cliente-inteligencia';
import RespostaAtencao from './inteligencia/RespostaAtencao';
import { BotaoPerguntarKidmais } from './inteligencia/PerguntarKidmais';
import styles from './dashboard.module.css';
import ia from './inteligencia/inteligencia.module.css';

type Estado = { fase: 'ociosa' } | { fase: 'carregando' } | { fase: 'pronta'; dados: AtencaoHoje } | { fase: 'erro'; mensagem: string };

export const PERGUNTA_ATENCAO = 'O que precisa da minha atenção hoje?';

/**
 * Card contextual da Fase 1 (somente leitura, sem mutação): o usuário decide perguntar,
 * a resposta vem da capacidade real `atencao_hoje` (POST /api/admin/inteligencia). Sem estado persistido —
 * se a IA estiver indisponível, o Dashboard continua funcionando.
 */
export default function InteligenciaCard() {
  const [estado, setEstado] = useState<Estado>({ fase: 'ociosa' });
  const emCurso = useRef(false);

  async function perguntar() {
    if (emCurso.current) return;
    emCurso.current = true;
    setEstado({ fase: 'carregando' });
    try {
      const resultado = await consultarAtencaoHoje(adminFetch);
      setEstado(resultado.tipo === 'resposta' ? { fase: 'pronta', dados: resultado.dados } : { fase: 'erro', mensagem: resultado.mensagem });
    } finally {
      emCurso.current = false;
    }
  }

  return <section className={`${styles.cartao} ${styles.inteligencia}`} aria-labelledby="inteligencia-titulo">
    <div className={styles.cabeca}>
      <h2 id="inteligencia-titulo" className={styles.lilas}>Inteligência</h2>
      <span className={styles.iaSelo}>Somente leitura</span>
    </div>

    {estado.fase === 'ociosa' && <div className={ia.cardInicio}>
      <button type="button" className={styles.iaPergunta} onClick={perguntar}>{PERGUNTA_ATENCAO}</button>
      <BotaoPerguntarKidmais className={ia.botaoDiscreto} />
    </div>}

    {estado.fase === 'carregando' && <div className={ia.carregando} aria-busy="true" aria-live="polite"><span /><span /><p>Consultando o Financeiro…</p></div>}

    {estado.fase === 'erro' && <div className={ia.cardRodape}>
      <p className={ia.erro} role="alert">{estado.mensagem}</p>
      <button type="button" className={ia.botaoDiscreto} onClick={perguntar}>Tentar novamente</button>
    </div>}

    {estado.fase === 'pronta' && <>
      <p className={ia.perguntaFeita}>{PERGUNTA_ATENCAO}</p>
      <RespostaAtencao dados={estado.dados} />
      <div className={ia.cardRodape}>
        <button type="button" className={ia.botaoDiscreto} onClick={perguntar}>Atualizar</button>
        <BotaoPerguntarKidmais className={ia.botaoDiscreto} />
      </div>
    </>}
  </section>;
}
