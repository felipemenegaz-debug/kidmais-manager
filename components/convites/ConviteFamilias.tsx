'use client';
import { useEffect, useRef, useState } from 'react';
import type { ComandoFamilia, Familia } from '@/lib/convites/familias-domain';
export type ResultadoFamilia = { id: string; revisao: number; linkFamilia?: string | null };

export default function ConviteFamilias({ familias, publicado, busy, erro, ui, executar }: {
  familias: Familia[]; publicado: boolean; busy: boolean; erro: string; ui: Record<string, string>;
  executar: (cmd: ComandoFamilia) => Promise<ResultadoFamilia | null>;
}) {
  const [nome, setNome] = useState(''), [adultos, setAdultos] = useState(2), [criancas, setCriancas] = useState(0);
  const [editando, setEditando] = useState<Familia | null>(null), [filtro, setFiltro] = useState('ativas'), [busca, setBusca] = useState('');
  const [links, setLinks] = useState<Record<string, { valor: string; revisao: number }>>({}), [aviso, setAviso] = useState('');
  const [confirmacao, setConfirmacao] = useState<{ comando: ComandoFamilia; titulo: string; texto: string } | null>(null);
  const dialogo = useRef<HTMLDialogElement>(null), nomeInput = useRef<HTMLInputElement>(null), chave = useRef<string | null>(null);
  useEffect(() => { if (confirmacao) dialogo.current?.showModal(); else dialogo.current?.close(); }, [confirmacao]);
  const ativas = familias.filter(f => f.ativa), pendentes = ativas.filter(f => f.presenca == null);
  const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const lista = familias.filter(f => (filtro === 'arquivadas' ? !f.ativa : f.ativa && (filtro === 'ativas' || (filtro === 'pendentes' ? f.presenca == null : f.presenca === (filtro === 'sim')))) && normalizar(f.nome).includes(normalizar(busca.trim())));
  async function operar(cmd: ComandoFamilia) {
    setAviso(''); const r = await executar(cmd);
    if (r) {
      const linkFamilia = r.linkFamilia;
      if (linkFamilia) setLinks(v => ({ ...v, [r.id]: { valor: new URL(linkFamilia, window.location.origin).href, revisao: r.revisao } }));
      else if (cmd.acao !== 'familia_adicionar') setLinks(v => { const novo = { ...v }; delete novo[r.id]; return novo; });
    }
    return r;
  }
  function limpar() { setEditando(null); setNome(''); setAdultos(2); setCriancas(0); chave.current = null; }
  return <section className={ui.painel} aria-labelledby="titulo-familias">
    <p className={ui.sobretitulo}>CONVIDADOS DA FESTA</p><h2 id="titulo-familias">Famílias e links individuais</h2>
    <p>Cadastre cada família e envie seu link exclusivo. Assim você acompanha quem ainda precisa responder.</p>
    <div className={ui.indicadores}><div><strong>{ativas.length}</strong><span>Famílias cadastradas</span></div><div><strong>{pendentes.length}</strong><span>Aguardando resposta</span></div><div><strong>{ativas.filter(f => f.presenca === true).length}</strong><span>Confirmaram presença</span></div><div><strong>{ativas.filter(f => f.presenca === false).length}</strong><span>Não vão</span></div></div>
    {!publicado && <p className={ui.aviso}>Publique o convite atualizado antes de compartilhar os links.</p>}
    {aviso && <p role="status" className={ui.aviso}>{aviso}</p>}
    <form aria-label={editando ? 'Editar família' : 'Adicionar família'} onSubmit={async e => {
      e.preventDefault();
      const cmd: ComandoFamilia = editando ? { acao: 'familia_editar', id: editando.id, revisao: editando.revisao, nome, adultos, criancas } : { acao: 'familia_adicionar', id: chave.current ?? (chave.current = crypto.randomUUID()), nome, adultos, criancas };
      if (await operar(cmd)) { limpar(); setAviso(editando ? 'Cadastro atualizado. A resposta da família foi preservada.' : 'Família adicionada. Copie o link na lista abaixo.'); }
    }}><fieldset disabled={busy} className={ui.formulario}>
      <label>Nome da família<input ref={nomeInput} required minLength={2} maxLength={100} value={nome} onChange={e => setNome(e.target.value)} placeholder="Ex.: Família Souza" /></label>
      <div className={ui.campos}><label>Adultos previstos<input required type="number" min={0} max={20} value={adultos} onChange={e => setAdultos(Number(e.target.value))} /></label><label>Crianças previstas<input required type="number" min={0} max={20} value={criancas} onChange={e => setCriancas(Number(e.target.value))} /></label></div>
      <small>A previsão ajuda no planejamento. A família informa a quantidade confirmada ao responder.</small>
      <div className={ui.acoes}><button className={ui.primario} type="submit" disabled={adultos + criancas < 1}>{editando ? 'Salvar família' : 'Adicionar família'}</button>{editando && <button type="button" onClick={limpar}>Cancelar edição da família</button>}</div>
    </fieldset></form>
    <label>Buscar família cadastrada<input type="search" maxLength={100} value={busca} onChange={e => setBusca(e.target.value)} /></label>
    <div className={ui.acoes} role="group" aria-label="Filtrar famílias">{[['ativas', 'Ativas'], ['pendentes', 'Pendentes'], ['sim', 'Confirmaram'], ['nao', 'Não vão'], ['arquivadas', 'Arquivadas']].map(([id, texto]) => <button key={id} type="button" aria-pressed={filtro === id} onClick={() => setFiltro(id)}>{texto}</button>)}</div>
    <ul className={ui.familiasLista}>{lista.map(f => {
      const link = f.ativa && f.linkAtivo && links[f.id]?.revisao === f.revisao ? links[f.id].valor : null;
      return <li key={f.id} aria-label={`Família: ${f.nome}`}>
        <strong>{f.nome}</strong><p>{!f.ativa ? 'Arquivada' : f.presenca == null ? 'Aguardando resposta' : f.presenca ? 'Presença confirmada' : 'Não vai'} · Previsão: {f.adultos} adultos e {f.criancas} crianças</p>
        {f.presenca === true && <p>Confirmados: {f.adultosConfirmados} adultos e {f.criancasConfirmadas} crianças</p>}
        {f.ativa && <small>{f.linkAtivo ? 'Link ativo. Quem receber este link poderá consultar e atualizar a resposta desta família.' : 'Link revogado. Gere um novo para receber a confirmação.'}</small>}
        {link && <label>Link individual<input readOnly value={link} onFocus={e => e.target.select()} /></label>}
        <div className={ui.acoes}>
          {link && <button type="button" disabled={!publicado} onClick={async () => { try { await navigator.clipboard.writeText(link); setAviso('Link da família copiado. Envie somente para esta família.'); } catch { setAviso('Selecione o link acima para copiar manualmente.'); } }}>Copiar link da família</button>}
          {f.ativa ? <>
            <button type="button" disabled={busy} onClick={() => { setEditando(f); setNome(f.nome); setAdultos(f.adultos); setCriancas(f.criancas); nomeInput.current?.focus(); }}>Editar família</button>
            <button type="button" disabled={busy} onClick={() => setConfirmacao({ comando: { acao: 'familia_link', id: f.id, revisao: f.revisao, habilitado: true }, titulo: f.linkAtivo ? 'Renovar link da família?' : 'Gerar link da família?', texto: 'O link anterior deixará de funcionar. A resposta já recebida será preservada. Copie e envie o novo link após confirmar.' })}>{f.linkAtivo ? 'Renovar link' : 'Gerar link'}</button>
            {f.linkAtivo && <button type="button" disabled={busy} onClick={() => setConfirmacao({ comando: { acao: 'familia_link', id: f.id, revisao: f.revisao, habilitado: false }, titulo: 'Revogar link da família?', texto: 'O link deixará de funcionar. O cadastro e a resposta continuarão no painel.' })}>Revogar link</button>}
            <button type="button" disabled={busy} onClick={() => setConfirmacao({ comando: { acao: 'familia_status', id: f.id, revisao: f.revisao, ativa: false }, titulo: 'Arquivar família?', texto: 'O link será revogado e a família sairá dos totais. Você poderá restaurar o cadastro e a resposta pela lista de arquivadas.' })}>Arquivar família</button>
          </> : <button type="button" disabled={busy} onClick={async () => { if (await operar({ acao: 'familia_status', id: f.id, revisao: f.revisao, ativa: true })) setAviso('Família restaurada com sua resposta anterior. Gere um novo link para compartilhar.'); }}>Restaurar família</button>}
        </div>
      </li>;
    })}</ul>
    {!lista.length && <p>Nenhuma família neste filtro.</p>}
    <small>Links gerados ficam disponíveis nesta aba. Ao sair, será necessário renovar para copiar novamente. O link geral continua funcionando, mas respostas por ele não são vinculadas automaticamente ao cadastro.</small>
    <dialog ref={dialogo} className={ui.dialogo} aria-labelledby="titulo-acao-familia" onCancel={e => { if (busy) e.preventDefault(); else setConfirmacao(null); }} onClose={() => setConfirmacao(null)}>
      <h2 id="titulo-acao-familia">{confirmacao?.titulo}</h2><p>{confirmacao?.texto}</p>{erro && <p role="alert" className={ui.erro}>{erro}</p>}
      <div className={ui.acoes}><button type="button" disabled={busy} autoFocus onClick={() => setConfirmacao(null)}>Cancelar</button><button type="button" disabled={busy} className={ui.primario} onClick={async () => { if (confirmacao && await operar(confirmacao.comando)) { setConfirmacao(null); setAviso('Cadastro atualizado. Confira o estado da família na lista.'); } }}>Confirmar</button></div>
    </dialog>
  </section>;
}
