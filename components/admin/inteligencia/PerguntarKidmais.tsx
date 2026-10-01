'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import { interpretarPergunta } from './perguntas';
import { consultarAtencaoHoje, continuacaoValida, conversar, decidirOperacao, focoValido, rotaInternaSegura, type ContextoTela, type ContinuacaoUI, type FocoUI, type RascunhoPublico } from './cliente-inteligencia';
import {
  adicionarPergunta, aguardandoResposta, cancelarEspera, historicoParaServidor, marcarDecisao, perguntaEmCurso, perguntaReenviavel, rascunhoAberto, registrarConversa, registrarDecisao,
  registrarResultado, type Mensagem,
} from './conversa';
import DrawerKidmais from './DrawerKidmais';
import visual from '../visual.module.css';

type Assistente = { abrir(): void; definirContexto(contexto: ContextoTela | null): void };

const Contexto = createContext<Assistente | null>(null);

/** Null fora do Admin autenticado: quem usa esconde o gatilho. */
export function usePerguntarKidmais() {
  return useContext(Contexto);
}

/**
 * Drawer global "Perguntar ao Kidmais".
 *
 * - "O que precisa da minha atenção hoje?" sem tela específica continua no endpoint da V1 (só a flag-mestra).
 * - O resto vai ao orquestrador do servidor, que decide: leitura, rascunho sob Human Gate ou "ainda não".
 * - Confirmar/cancelar só acontece pelo clique nos botões do preview; texto nunca confirma.
 * - A UI envia só texto, contexto de tela e, no clique, operacaoId/versão/hash. Tenant e papel ficam no servidor.
 */
export function PerguntarKidmaisProvider({ children }: { children: React.ReactNode }) {
  const [aberto, setAberto] = useState(false);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [contexto, setContexto] = useState<ContextoTela | null>(null);
  const origemFoco = useRef<HTMLElement | null>(null);
  const proximoId = useRef(0);
  const emCurso = useRef(false);
  const controle = useRef<AbortController | null>(null);
  const historico = useRef<Mensagem[]>([]);
  /** Foco da conversa (PR 5): só na sessão da página; reenviado como dica (tipo + id). */
  const foco = useRef<FocoUI | null>(null);
  /** IA operacional: pergunta de parâmetro pendente; vale só para a próxima mensagem (dica revalidada no servidor). */
  const continuacao = useRef<ContinuacaoUI | null>(null);
  const router = useRouter();
  useEffect(() => { historico.current = mensagens; }, [mensagens]);

  const abrir = useCallback(() => {
    origemFoco.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAberto(true);
  }, []);

  const fechar = useCallback(() => {
    setAberto(false);
    origemFoco.current?.focus();
  }, []);

  const perguntar = useCallback(async (texto: string) => {
    const pergunta = texto.trim();
    if (!pergunta || emCurso.current) return;
    const id = ++proximoId.current;
    const rascunho = rascunhoAberto(historico.current);
    const local = interpretarPergunta(pergunta);
    const legado = !rascunho && !contexto && local.tipo === 'capacidade';
    setMensagens((h) => adicionarPergunta(h, id, pergunta, legado ? local : { tipo: 'servidor' }));
    emCurso.current = true;
    const abortar = new AbortController();
    controle.current = abortar;
    try {
      if (legado) {
        const resultado = await consultarAtencaoHoje(adminFetch, abortar.signal);
        setMensagens((h) => (abortar.signal.aborted ? cancelarEspera(h, id) : registrarResultado(h, id, resultado)));
      } else {
        const pendente = continuacao.current;
        continuacao.current = null;
        const resultado = await conversar(adminFetch, { texto: pergunta, contexto, ...(rascunho ? { operacaoId: rascunho.operacaoId } : {}), foco: foco.current, continuacao: pendente, historico: historicoParaServidor(historico.current) }, abortar.signal);
        if (resultado.tipo === 'ok') foco.current = focoValido((resultado.resposta as { foco?: unknown }).foco, foco.current) ?? foco.current;
        if (resultado.tipo === 'ok') continuacao.current = continuacaoValida((resultado.resposta as { continuacao?: unknown }).continuacao);
        // Resposta a rascunho não é repetida automaticamente: o operador vê o estado atual e decide.
        setMensagens((h) => registrarConversa(h, id, resultado, !rascunho));
        // Navegação pedida explicitamente, com destino único da lista fechada (revalidado aqui): abre a tela.
        if (!abortar.signal.aborted && resultado.tipo === 'ok' && resultado.resposta.tipo === 'navegacao' && rotaInternaSegura(resultado.resposta.destino)) {
          router.push(resultado.resposta.destino);
          fechar();
        }
      }
    } finally {
      emCurso.current = false;
      controle.current = null;
    }
  }, [contexto, router, fechar]);

  /** Cancela só a ESPERA da pergunta em curso; o clique de confirmação nunca passa por aqui. */
  const cancelar = useCallback(() => {
    const id = perguntaEmCurso(historico.current);
    controle.current?.abort();
    if (id !== null) setMensagens((h) => cancelarEspera(h, id));
  }, []);

  const reenviar = useCallback((id: number) => {
    // Só pergunta nova (nunca resposta a rascunho) e só sem rascunho aberto: a repetição não pode cair num rascunho.
    const pergunta = perguntaReenviavel(historico.current, id);
    if (pergunta && !rascunhoAberto(historico.current)) void perguntar(pergunta);
  }, [perguntar]);

  const decidir = useCallback(async (rascunho: RascunhoPublico, decisao: 'confirmar' | 'cancelar') => {
    if (emCurso.current) return;
    emCurso.current = true;
    setMensagens((h) => marcarDecisao(h, rascunho.operacaoId, true));
    try {
      const resultado = await decidirOperacao(adminFetch, rascunho, decisao);
      setMensagens((h) => registrarDecisao(h, rascunho.operacaoId, resultado));
    } finally {
      emCurso.current = false;
    }
  }, []);

  const definirContexto = useCallback((novo: ContextoTela | null) => setContexto(novo), []);
  const valor = useMemo<Assistente>(() => ({ abrir, definirContexto }), [abrir, definirContexto]);

  return <Contexto.Provider value={valor}>
    {children}
    {aberto && <DrawerKidmais mensagens={mensagens} aguardando={aguardandoResposta(mensagens)} contexto={contexto}
      onPerguntar={perguntar} onDecidir={decidir} onCancelar={cancelar} onReenviar={reenviar} onFechar={fechar} />}
  </Contexto.Provider>;
}

export function BotaoPerguntarKidmais({ className, children = 'Perguntar ao Kidmais', aoAbrir }: { className?: string; children?: React.ReactNode; aoAbrir?(): void }) {
  const assistente = usePerguntarKidmais();
  if (!assistente) return null;
  return <button type="button" className={`${className ?? ''} ${visual.assistente}`} data-km-assistente aria-haspopup="dialog" onClick={() => { aoAbrir?.(); assistente.abrir(); }}>{children}</button>;
}

/**
 * Informa ao drawer em que tela o operador está (ex.: a festa aberta). Não renderiza nada.
 * O id é só uma dica: o servidor revalida a entidade no tenant comprovado.
 */
export function ContextoKidmais({ tela, entidadeId }: ContextoTela) {
  const assistente = usePerguntarKidmais();
  useEffect(() => {
    if (!assistente) return;
    assistente.definirContexto(entidadeId ? { tela, entidadeId } : { tela });
    return () => assistente.definirContexto(null);
  }, [assistente, tela, entidadeId]);
  return null;
}
