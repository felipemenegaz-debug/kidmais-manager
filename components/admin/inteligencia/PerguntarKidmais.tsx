'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { interpretarPergunta } from './perguntas';
import { consultarAtencaoHoje } from './cliente-inteligencia';
import { adicionarPergunta, aguardandoResposta, registrarResultado, type Mensagem } from './conversa';
import DrawerKidmais from './DrawerKidmais';

type Assistente = { abrir(): void };

const Contexto = createContext<Assistente | null>(null);

/** Null fora do Admin autenticado: quem usa esconde o gatilho. */
export function usePerguntarKidmais() {
  return useContext(Contexto);
}

/**
 * Drawer global “Perguntar ao Kidmais”. Não é um agente aberto: cada pergunta é roteada no navegador
 * para uma capacidade registrada (hoje só `atencao_hoje`) ou respondida como “ainda não disponível”.
 * Nada aqui escreve; a única chamada de rede é o mesmo POST somente leitura do card do Dashboard.
 */
export function PerguntarKidmaisProvider({ children }: { children: React.ReactNode }) {
  const [aberto, setAberto] = useState(false);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const origemFoco = useRef<HTMLElement | null>(null);
  const proximoId = useRef(0);
  const emCurso = useRef(false);

  const abrir = useCallback(() => {
    origemFoco.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAberto(true);
  }, []);

  const fechar = useCallback(() => {
    setAberto(false);
    origemFoco.current?.focus();
  }, []);

  const perguntar = useCallback(async (texto: string) => {
    const interpretacao = interpretarPergunta(texto);
    if (interpretacao.tipo === 'vazia' || emCurso.current) return;
    const id = ++proximoId.current;
    const pergunta = texto.trim();
    setMensagens((historico) => adicionarPergunta(historico, id, pergunta, interpretacao));
    if (interpretacao.tipo !== 'capacidade') return;
    emCurso.current = true;
    try {
      const resultado = await consultarAtencaoHoje(adminFetch);
      setMensagens((historico) => registrarResultado(historico, id, resultado));
    } finally {
      emCurso.current = false;
    }
  }, []);

  const valor = useMemo<Assistente>(() => ({ abrir }), [abrir]);

  return <Contexto.Provider value={valor}>
    {children}
    {aberto && <DrawerKidmais mensagens={mensagens} aguardando={aguardandoResposta(mensagens)} onPerguntar={perguntar} onFechar={fechar} />}
  </Contexto.Provider>;
}

export function BotaoPerguntarKidmais({ className, children = 'Perguntar ao Kidmais', aoAbrir }: { className?: string; children?: React.ReactNode; aoAbrir?(): void }) {
  const assistente = usePerguntarKidmais();
  if (!assistente) return null;
  return <button type="button" className={className} aria-haspopup="dialog" onClick={() => { aoAbrir?.(); assistente.abrir(); }}>{children}</button>;
}
