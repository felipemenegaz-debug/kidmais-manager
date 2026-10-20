'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ROTA_AJUDA } from '@/lib/suporte/rota';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import type { SituacaoPrivacidade } from '@/lib/whatsapp/atendimento/privacidade';
import styles from './atendimento.module.css';

/**
 * Privacidade do atendimento (12/10/2026), para a Gestão da empresa ATIVA (não depende de ela ser a piloto do bot):
 * excluir os dados de uma conversa, revogar, trocar o link, expirar e reativar arquivos da biblioteca, e configurar a
 * retenção (sem prazo padrão), com a situação da última execução. Toda ação pede a senha de novo; as irreversíveis
 * (excluir, revogar) pedem também a palavra de confirmação.
 */
type Pendente = { titulo: string; explicacao: string; corpo: Record<string, unknown>; palavra?: 'EXCLUIR' | 'REVOGAR'; sucesso: string };
const ESTADO_ARQUIVO = (a: SituacaoPrivacidade['arquivos'][number]) =>
  a.revogadoEm ? 'Revogado (conteúdo apagado)' : a.disponivel ? (a.expiraEm ? `Disponível até ${new Date(a.expiraEm).toLocaleString('pt-BR')}` : 'Disponível') : a.vencido ? 'Vencido' : 'Indisponível';
const ACAO_REGISTRO: Record<string, string> = {
  CONVERSA_EXCLUIDA: 'Conversa excluída', ARQUIVO_REVOGADO: 'Arquivo revogado', ARQUIVO_LINK_TROCADO: 'Link trocado', ARQUIVO_EXPIRACAO_DEFINIDA: 'Expiração definida',
  ARQUIVO_REATIVADO: 'Arquivo reativado', RETENCAO_CONFIGURADA: 'Retenção configurada',
};

export default function PrivacidadeAtendimento() {
  const [dados, setDados] = useState<SituacaoPrivacidade | null>(null);
  const [erro, setErro] = useState(''), [aviso, setAviso] = useState(''), [ocupado, setOcupado] = useState(false);
  const [pendente, setPendente] = useState<Pendente | null>(null), [senha, setSenha] = useState(''), [palavra, setPalavra] = useState('');
  const [busca, setBusca] = useState(''), [buscaAplicada, setBuscaAplicada] = useState('');
  const [prazo, setPrazo] = useState(''), [motivo, setMotivo] = useState<'PEDIDO_DO_TITULAR' | 'DECISAO_DA_EMPRESA'>('PEDIDO_DO_TITULAR'), [validade, setValidade] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    try {
      // M4: com um número completo, a conversa do titular é buscada no servidor (exata), além das 200 mais recentes.
      const r = await adminFetch(`/api/admin/atendimento/privacidade${buscaAplicada ? `?contato=${encodeURIComponent(buscaAplicada)}` : ''}`); const json = await r.json();
      if (!r.ok || !json.ok) { setDados(null); setErro(json?.erro || 'Não foi possível carregar a privacidade do atendimento.'); return; }
      setDados(json.data); setErro('');
    } catch { setErro('Não foi possível carregar a privacidade do atendimento.'); }
  }, [buscaAplicada]);
  useEffect(() => { const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [carregar]);

  function pedir(p: Pendente) { setAviso(''); setErro(''); setSenha(''); setPalavra(''); setPendente(p); }
  async function confirmar() {
    if (!pendente || ocupado) return;
    if (pendente.palavra && palavra.trim() !== pendente.palavra) { setErro(`Digite ${pendente.palavra} para confirmar. Nada foi alterado.`); return; }
    setOcupado(true); setErro('');
    try {
      const auth = await reautenticarSessao(senha);
      if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
      const corpo = pendente.palavra ? { ...pendente.corpo, confirmacao: pendente.palavra } : pendente.corpo;
      const r = await adminFetch('/api/admin/atendimento/privacidade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
      const json = await r.json().catch(() => null);
      // B3: só uma recusa do servidor (4xx) garante que nada mudou; falha do servidor ou resposta ilegível, não.
      if (!r.ok || !json?.ok) { setErro(r.status >= 400 && r.status < 500 ? (json?.erro || 'Não foi possível concluir. Nada foi alterado.') : 'Não foi possível confirmar o resultado. Atualize a página e confira antes de repetir.'); return; }
      setAviso(pendente.sucesso); setPendente(null); await carregar();
    } catch { setErro('Não foi possível confirmar a operação. Atualize a página e confira antes de repetir.'); }
    finally { setSenha(''); setPalavra(''); setOcupado(false); }
  }

  const ret = dados?.retencao;
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Privacidade do atendimento</h1><p>Excluir conversas, controlar arquivos da biblioteca e a retenção desta empresa.</p></div>
      <div className={styles.acoes}><Link href="/admin/atendimento">Voltar ao atendimento</Link><Link href="/admin/atendimento/biblioteca">Biblioteca</Link></div></header>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {aviso && <p role="status" className={styles.aviso}>{aviso}</p>}
    {!dados && !erro && <p aria-live="polite">Carregando…</p>}
    <p className={styles.nota} data-limites>O que é apagado aqui sai do sistema. Não alcança cópias que o WhatsApp, o cliente ou os backups já guardaram, nem uma mensagem cujo envio já começou.</p>
    {pendente && <section className={styles.dialogo} role="dialog" aria-modal="true" aria-labelledby="privacidade-confirmar"><h2 id="privacidade-confirmar">{pendente.titulo}</h2><p>{pendente.explicacao}</p>
      {pendente.palavra && <label>Digite {pendente.palavra} para confirmar<input name="confirmacao" value={palavra} disabled={ocupado} onChange={(e) => setPalavra(e.target.value)} /></label>}
      <label>Sua senha<input type="password" name="senha" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} /></label>
      <div className={styles.acoes}><button type="button" disabled={ocupado || !senha} onClick={() => void confirmar()}>Confirmar</button><button type="button" disabled={ocupado} onClick={() => setPendente(null)}>Cancelar</button></div>
    </section>}
    {dados && <>
      <section className={styles.painel} aria-labelledby="privacidade-retencao" data-secao="retencao"><h2 id="privacidade-retencao">Retenção</h2>
        <p>{ret?.prazoDias ? <>Conversas sem atividade há mais de <strong>{ret.prazoDias} dias</strong> são excluídas automaticamente.</> : <>Sem exclusão automática: nenhum prazo foi definido para esta empresa.</>}</p>
        <p className={styles.nota} data-execucao>{ret?.ultimaExecucao
          ? `Última execução: ${new Date(ret.ultimaExecucao.iniciadaEm).toLocaleString('pt-BR')} — ${ret.ultimaExecucao.situacao === 'EXECUTADA' ? 'executada' : ret.ultimaExecucao.situacao === 'EXECUTADA_COM_FALHAS' ? 'executada COM FALHAS nesta empresa' : ret.ultimaExecucao.situacao === 'EM_ANDAMENTO' ? 'em andamento' : 'não concluída'}; ${ret.ultimaExecucao.excluidasDestaEmpresa} conversa(s) desta empresa excluída(s)${ret.ultimaExecucao.adiadasDestaEmpresa ? `, ${ret.ultimaExecucao.adiadasDestaEmpresa} adiada(s)` : ''}${ret.ultimaExecucao.falhasDestaEmpresa ? `, ${ret.ultimaExecucao.falhasDestaEmpresa} com falha (serão tentadas de novo; se persistir, avise o suporte)` : ''}.`
          : 'A rotina de retenção ainda não foi executada neste ambiente.'}</p>
        {ret?.atrasada && <p className={styles.erro} role="status" data-atrasada>Há prazo definido, mas a rotina de retenção não terminou nas últimas 36 horas: nada está sendo excluído automaticamente. <Link href={ROTA_AJUDA}>Avise o suporte</Link>.</p>}
        <label>Prazo em dias (1 a 3650)<input type="number" min={1} max={3650} name="prazo" value={prazo} onChange={(e) => setPrazo(e.target.value)} /></label>
        <div className={styles.acoes}>
          <button type="button" disabled={!/^\d{1,4}$/.test(prazo) || Number(prazo) < 1 || Number(prazo) > 3650} onClick={() => pedir({ titulo: 'Definir a retenção', explicacao: `Conversas sem atividade há mais de ${prazo} dias passam a ser excluídas automaticamente, sem volta.`, corpo: { acao: 'retencao', prazoDias: Number(prazo) }, sucesso: 'Retenção definida.' })}>Definir prazo</button>
          {ret?.prazoDias != null && <button type="button" onClick={() => pedir({ titulo: 'Desligar a exclusão automática', explicacao: 'Nenhuma conversa será excluída automaticamente até um novo prazo ser definido.', corpo: { acao: 'retencao', prazoDias: null }, sucesso: 'Exclusão automática desligada.' })}>Desligar exclusão automática</button>}
        </div>
      </section>
      <section className={styles.painel} aria-labelledby="privacidade-conversas" data-secao="conversas"><h2 id="privacidade-conversas">Conversas</h2>
        <label>Motivo da exclusão<select name="motivo" value={motivo} onChange={(e) => setMotivo(e.target.value as typeof motivo)}><option value="PEDIDO_DO_TITULAR">Pedido do cliente</option><option value="DECISAO_DA_EMPRESA">Decisão da empresa</option></select></label>
        <form className={styles.acoes} onSubmit={(e) => { e.preventDefault(); setBuscaAplicada(busca.replace(/\D/g, '')); }}>
          <label>Número completo do cliente (DDI + DDD + número)<input name="busca" inputMode="numeric" value={busca} onChange={(e) => setBusca(e.target.value)} /></label>
          <button type="submit">Buscar</button>{buscaAplicada && <button type="button" onClick={() => { setBusca(''); setBuscaAplicada(''); }}>Ver as mais recentes</button>}
        </form>
        <p className={styles.nota}>{dados.busca === 'NUMERO' ? 'Resultado da busca pelo número informado.' : 'As 200 conversas com atividade mais recente. Para atender um pedido do titular, busque pelo número completo.'}</p>
        {!dados.conversas.length && <p>{dados.busca === 'NUMERO' ? 'Nenhuma conversa com este número nesta empresa.' : 'Nenhuma conversa desta empresa.'}</p>}
        <ul className={styles.listaSimples}>{dados.conversas.map((c) => <li key={c.id} data-conversa={c.id}>
          <span>Final {c.contatoFinal} · {c.mensagens} mensagem(ns) · {new Date(c.atualizadaEm).toLocaleString('pt-BR')}{c.naoContatar ? ' · pediu PARAR' : c.pausa ? ' · pediu pausa' : ''}</span>
          <button type="button" onClick={() => pedir({ titulo: 'Excluir os dados desta conversa', explicacao: `Apaga as mensagens, o nome de perfil, a memória do Wall-e e o resumo da conversa final ${c.contatoFinal}. Não tem volta. ${c.naoContatar || c.pausa ? 'O pedido de parar/pausa continua valendo.' : ''}`.trim(), corpo: { acao: 'excluir_conversa', conversaId: c.id, motivo }, palavra: 'EXCLUIR', sucesso: 'Dados da conversa excluídos.' })}>Excluir dados</button>
        </li>)}</ul>
      </section>
      <section className={styles.painel} aria-labelledby="privacidade-arquivos" data-secao="arquivos"><h2 id="privacidade-arquivos">Arquivos da biblioteca</h2>
        {!dados.arquivos.length && <p>Nenhum arquivo enviado.</p>}
        <ul className={styles.listaSimples}>{dados.arquivos.map((a) => {
          const vencido = a.vencido;
          return <li key={a.id} data-arquivo={a.id}>
            <span>{a.nome} · {ESTADO_ARQUIVO(a)}</span>
            {!a.revogadoEm && <span className={styles.acoesArquivo}>
              {a.disponivel && <button type="button" onClick={() => pedir({ titulo: 'Trocar o link', explicacao: 'O link atual deixa de funcionar na hora. O arquivo continua nas mensagens prontas.', corpo: { acao: 'trocar_link', arquivoId: a.id }, sucesso: 'Link trocado.' })}>Trocar link</button>}
              {a.disponivel && <button type="button" onClick={() => pedir({ titulo: 'Expirar agora', explicacao: 'O arquivo deixa de ser servido e enviado na hora; envios ainda na fila são cancelados. Para usar de novo, será preciso reativar (com link novo).', corpo: { acao: 'expiracao', arquivoId: a.id, expiraEm: 'agora' }, sucesso: 'Arquivo expirado.' })}>Expirar agora</button>}
              {a.disponivel && <><input type="datetime-local" aria-label={`Expira em (${a.nome})`} value={validade[a.id] ?? ''} onChange={(e) => setValidade({ ...validade, [a.id]: e.target.value })} />
                <button type="button" disabled={!validade[a.id]} onClick={() => pedir({ titulo: 'Definir a expiração', explicacao: 'Depois da data o arquivo não é mais servido nem enviado.', corpo: { acao: 'expiracao', arquivoId: a.id, expiraEm: new Date(validade[a.id]).toISOString() }, sucesso: 'Expiração definida.' })}>Definir expiração</button></>}
              {vencido && <button type="button" onClick={() => pedir({ titulo: 'Reativar com link novo', explicacao: 'O arquivo volta a ser servido com um link novo (o anterior nunca volta), sem data de expiração.', corpo: { acao: 'reativar', arquivoId: a.id, expiraEm: null }, sucesso: 'Arquivo reativado com link novo.' })}>Reativar</button>}
              <button type="button" onClick={() => pedir({ titulo: 'Revogar o arquivo', explicacao: `Apaga o conteúdo do arquivo, desativa o link, arquiva as mensagens prontas que o usam e cancela os envios ainda na fila. Não tem volta.${a.enviosSemConfirmacao ? ` Atenção: ${a.enviosSemConfirmacao} envio(s) deste arquivo ainda sem confirmação de entrega — revogar agora pode impedir que cheguem (o que já foi entregue não é recolhido).` : ''}`, corpo: { acao: 'revogar', arquivoId: a.id }, palavra: 'REVOGAR', sucesso: 'Arquivo revogado.' })}>Revogar</button>
            </span>}
          </li>;
        })}</ul>
      </section>
      <section className={styles.painel} aria-labelledby="privacidade-registro" data-secao="registro"><h2 id="privacidade-registro">Registro</h2>
        {!dados.registro.length && <p>Nenhuma ação registrada.</p>}
        <ul className={styles.listaSimples}>{dados.registro.map((r, i) => <li key={`${r.criadaEm}-${i}`}>{new Date(r.criadaEm).toLocaleString('pt-BR')} · {ACAO_REGISTRO[r.acao] ?? r.acao}{r.origem === 'RETENCAO' ? ' (retenção)' : ''}{r.mensagens != null ? ` · ${r.mensagens} mensagem(ns)` : ''}{r.prazoDias != null ? ` · prazo ${r.prazoDias} dias` : ''}</li>)}</ul>
      </section>
    </>}
  </main>;
}
