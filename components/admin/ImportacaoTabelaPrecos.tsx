'use client';
import { useEffect, useMemo, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import imp from './importacao-tabela.module.css';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import {
  NOME_CATEGORIA, NOME_UNIDADE, contarPendencias, faixaTexto, lerValor, mensagemAviso, moeda, resumoPublicacao,
  type Importacao, type RevAdicional, type RevPacote, type Revisao,
} from './importacao-tabela';

type Cadastro = { pacotes: Array<{ id: string; nome: string }>; adicionais: Array<{ id: string; nome: string }>; categorias: Array<{ codigo: string; nome: string }> };
type Aba = 'pacotes' | 'adicionais' | 'horarios' | 'nao';

const API = '/api/admin/configuracoes/importacoes';
const API_LEITURA = '/api/admin/inteligencia/tabela-precos';

async function lerJson(resposta: Response) {
  const body = await resposta.json().catch(() => ({}));
  if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Não foi possível concluir.');
  return body.data;
}

export default function ImportacaoTabelaPrecos() {
  const [lista, setLista] = useState<Importacao[]>([]);
  const [atual, setAtual] = useState<Importacao | null>(null);
  const [revisao, setRevisao] = useState<Revisao | null>(null);
  const [cadastro, setCadastro] = useState<Cadastro | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [lendo, setLendo] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [aba, setAba] = useState<Aba>('pacotes');
  const [pacoteAberto, setPacoteAberto] = useState(0);
  const [confirmando, setConfirmando] = useState(false);
  const [alterado, setAlterado] = useState(false);

  useEffect(() => {
    let vivo = true;
    adminFetch(API).then(lerJson).then((d) => { if (vivo) setLista(d); }).catch((e) => { if (vivo) setErro(e.message); });
    adminFetch('/api/admin/configuracoes/adicionais').then(lerJson).then((d) => { if (vivo) setCadastro(d); }).catch(() => undefined);
    return () => { vivo = false; };
  }, []);

  function abrir(i: Importacao) {
    setAtual(i); setRevisao(i.revisao); setAlterado(false); setErro(''); setAviso(''); setAba('pacotes'); setPacoteAberto(0);
  }

  async function abrirPorId(id: string) {
    try { abrir(await lerJson(await adminFetch(`${API}/${id}`))); } catch (e) { setErro((e as Error).message); }
  }

  async function ler() {
    if (!arquivo) return;
    setLendo(true); setErro(''); setAviso('');
    try {
      const form = new FormData();
      form.set('arquivo', arquivo);
      abrir(await lerJson(await adminFetch(API_LEITURA, { method: 'POST', body: form })));
    } catch (e) { setErro((e as Error).message); } finally { setLendo(false); }
  }

  async function acao(nome: 'reler' | 'descartar' | 'publicar') {
    if (!atual) return;
    setSalvando(true); setErro('');
    try {
      let versao = atual.versao;
      if (nome === 'publicar' && alterado && revisao) versao = (await salvar()).versao;
      const data = nome === 'reler'
        ? await lerJson(await adminFetch(`${API_LEITURA}?id=${atual.id}`, { method: 'POST' }))
        : await lerJson(await adminFetch(`${API}/${atual.id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nome === 'publicar' ? { acao: nome, versao } : { acao: nome }),
        }));
      if (nome === 'descartar') { setAtual(null); setRevisao(null); setLista((l) => l.filter((x) => x.id !== atual.id)); setAviso('Importação descartada.'); }
      else if (nome === 'reler') abrir(data);
      else { setConfirmando(false); setAtual({ ...atual, situacao: 'PUBLICADA', resultado: data }); }
    } catch (e) { setErro((e as Error).message); } finally { setSalvando(false); }
  }

  async function salvar(): Promise<Importacao> {
    if (!atual || !revisao) throw Error('Nada para salvar.');
    const data = await lerJson(await adminFetch(`${API}/${atual.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versao: atual.versao, revisao }),
    }));
    setAtual(data); setAlterado(false); setAviso('Revisão salva.');
    return data;
  }

  function mudarPacote(i: number, mudanca: Partial<RevPacote>) {
    setRevisao((r) => r && { ...r, pacotes: r.pacotes.map((p, k) => (k === i ? { ...p, ...mudanca } : p)) });
    setAlterado(true);
  }
  function mudarAdicional(i: number, mudanca: Partial<RevAdicional>) {
    setRevisao((r) => r && { ...r, adicionais: r.adicionais.map((a, k) => (k === i ? { ...a, ...mudanca } : a)) });
    setAlterado(true);
  }

  const pendencias = useMemo(() => (revisao ? contarPendencias(revisao) : null), [revisao]);
  const resumo = useMemo(() => (revisao ? resumoPublicacao(revisao) : null), [revisao]);
  const nomePacote = (id: string | null) => cadastro?.pacotes.find((p) => p.id === id)?.nome ?? '—';

  // ── Publicado ─────────────────────────────────────────────────────────────
  if (atual?.situacao === 'PUBLICADA') {
    const passos = atual.resultado?.passos ?? [];
    const falhas = passos.filter((p) => !p.ok);
    return <main className={styles.page} data-admin-workspace>
      <header className={styles.header}><h1>Tabela publicada</h1></header>
      <div className={styles.content}>
        <section className={imp.sucesso}><strong>Preços publicados.</strong> A nova tabela já vale para os fechamentos novos. Fechamentos já gravados não mudam.</section>
        {falhas.length > 0 && <section className={imp.alerta}><strong>Algumas atualizações de pacote não foram feitas:</strong><ul>{falhas.map((f) => <li key={f.passo}>{f.passo.split(':').slice(1).join(' · ')}: {f.erro}</li>)}</ul></section>}
        <section className={imp.card}>
          <h2>Próximo passo</h2>
          <p>Adicionais novos ainda não são oferecidos em nenhum pacote. Marque os pacotes em Itens do Buffet › Outros adicionais.</p>
          <div className={styles.actions}><a href="/admin/configuracoes/catalogo">Abrir Itens do Buffet</a><a href="/admin/configuracoes/pacotes">Ver os pacotes</a><button type="button" onClick={() => { setAtual(null); setRevisao(null); }}>Nova importação</button></div>
        </section>
      </div>
    </main>;
  }

  // ── Enviar ────────────────────────────────────────────────────────────────
  if (!atual) {
    return <main className={styles.page} data-admin-workspace aria-busy={lendo}>
      <header className={styles.header}><h1>Importar tabela de preços do PDF</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        {aviso && <p role="status">{aviso}</p>}
        <div className={imp.colunas}>
          <section className={imp.card}>
            <h2>Arquivo</h2>
            <label className={imp.envio}>
              <span>Escolha o PDF da tabela de preços (até 15 MB). Funciona com PDF de texto ou de imagem, como artes do Canva.</span>
              <input type="file" accept="application/pdf" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
            </label>
            <p className={imp.ajuda}>A tabela publicada vale a partir da publicação e substitui a atual. Fechamentos já gravados não mudam.</p>
            <AdminPrimaryButton disabled={!arquivo || lendo} carregando={lendo} onClick={() => void ler()}>Ler tabela</AdminPrimaryButton>
            {lendo && <p role="status">Lendo o PDF com IA. Pode levar até 2 minutos; não feche esta tela.</p>}
          </section>
          <section className={imp.card}>
            <h2>O que será lido</h2>
            <ul className={imp.lista}><li>Pacotes, descrição e o que está incluído</li><li>Preços por convidados, horário promocional e nobre</li><li>Adicionais de buffet, mesas, decoração e extras</li><li>Horários e informações importantes</li></ul>
            <p className={imp.ajuda}>Nada é gravado na leitura. As páginas vão ao provedor de IA configurado (OpenAI) só para leitura: envie apenas a tabela comercial, sem dados de clientes.</p>
          </section>
        </div>
        {lista.filter((i) => i.situacao === 'RASCUNHO').length > 0 && <section className={imp.card}>
          <h2>Importações em revisão</h2>
          {lista.filter((i) => i.situacao === 'RASCUNHO').map((i) => <div key={i.id} className={imp.linhaLista}>
            <span>{i.arquivoNome} · {new Date(i.criadoEm).toLocaleString('pt-BR')}</span>
            <button type="button" onClick={() => void abrirPorId(i.id)}>Continuar revisão</button>
          </div>)}
        </section>}
      </div>
    </main>;
  }

  // ── Leitura sem resultado ────────────────────────────────────────────────
  if (!revisao) {
    return <main className={styles.page} data-admin-workspace aria-busy={salvando}>
      <header className={styles.header}><h1>Leitura não concluída</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        <section className={imp.alerta}>{(atual.avisos.length ? atual.avisos : ['MODELO_INESPERADO']).map((a) => <p key={a}>{mensagemAviso(a)}</p>)}</section>
        <div className={styles.actions}>
          <AdminPrimaryButton carregando={salvando} onClick={() => void acao('reler')}>Ler de novo</AdminPrimaryButton>
          <button type="button" onClick={() => void acao('descartar')}>Descartar</button>
        </div>
      </div>
    </main>;
  }

  // ── Revisão ───────────────────────────────────────────────────────────────
  const p = revisao.pacotes[pacoteAberto];
  return <main className={styles.page} data-admin-workspace aria-busy={salvando}>
    <header className={styles.header}>
      <h1>Revise antes de publicar</h1>
      <span className={styles.badge}>{atual.arquivoNome}</span>
    </header>
    <div className={styles.content}>
      <p role="alert">{erro}</p>
      {aviso && <p role="status">{aviso}</p>}
      {revisao.conferencias.length > 0 && <section className={imp.card}>
        <h2>Conferências automáticas</h2>
        <ul className={imp.conferencias}>{revisao.conferencias.map((c) => <li key={c.texto} data-ok={c.ok}>{c.ok ? '✓' : '!'} {c.texto}</li>)}</ul>
      </section>}
      <div className={imp.abas} role="tablist" aria-label="Partes da revisão">
        {([['pacotes', `Pacotes · ${revisao.pacotes.length}`], ['adicionais', `Adicionais · ${revisao.adicionais.length}`], ['horarios', 'Horários e avisos'], ['nao', `Não importado · ${revisao.naoImportavel.length}`]] as const).map(([id, rotulo]) =>
          <button key={id} type="button" role="tab" aria-selected={aba === id} onClick={() => setAba(id)}>{rotulo}</button>)}
      </div>

      {aba === 'pacotes' && <div className={imp.duas}>
        <nav className={imp.menu} aria-label="Pacotes lidos">
          {revisao.pacotes.map((x, i) => <button key={x.chave} type="button" aria-current={i === pacoteAberto} onClick={() => setPacoteAberto(i)}>
            <strong>{x.nomePdf}</strong>
            <span>{x.pacoteId ? nomePacote(x.pacoteId) : 'Ignorado'}</span>
            <span data-estado={!x.pacoteId ? 'ignorado' : x.confirmado ? 'ok' : 'pendente'}>{!x.pacoteId ? 'não importa' : x.confirmado ? 'Confirmado' : `${x.pendencias.length} pendência(s)`}</span>
          </button>)}
        </nav>
        {p && <section className={imp.card} key={p.chave}>
          <div className={imp.topo}>
            <div><h2>{p.nomePdf}</h2>{p.pagina && <span className={imp.ajuda}>Página {p.pagina}</span>}</div>
            <label>Corresponde a
              <select value={p.pacoteId ?? ''} onChange={(e) => mudarPacote(pacoteAberto, { pacoteId: e.target.value || null, confirmado: false })}>
                <option value="">Ignorar (não importar)</option>
                {cadastro?.pacotes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </label>
          </div>
          {p.cobranca === 'SOB_CONSULTA' && <p className={imp.ajuda}>Sem preço no PDF: o preço atual do pacote não muda.</p>}
          {p.cobranca === 'POR_CONVIDADO' && <div className={imp.linha2}>
            <label>Valor por convidado<input inputMode="decimal" defaultValue={p.porConvidado?.toString().replace('.', ',') ?? ''} onBlur={(e) => mudarPacote(pacoteAberto, { porConvidado: lerValor(e.target.value), confirmado: false })} /></label>
            <label>Mínimo de convidados<input inputMode="numeric" value={p.convidadosMin ?? ''} onChange={(e) => mudarPacote(pacoteAberto, { convidadosMin: Number(e.target.value) || null, confirmado: false })} /></label>
          </div>}
          {p.cobranca === 'FAIXAS' && <div className={imp.tabelaCaixa}>
            <table className={imp.tabela}>
              <thead><tr><th>Convidados</th>{p.grades.map((g) => <th key={g.categoria}>{NOME_CATEGORIA[g.categoria]}</th>)}<th>Hoje</th></tr></thead>
              <tbody>{(p.grades[0]?.faixas ?? []).map((f, linha) => <tr key={f.min}>
                <td>{faixaTexto(f)}</td>
                {p.grades.map((g, gi) => <td key={g.categoria}>
                  <input aria-label={`${NOME_CATEGORIA[g.categoria]} ${faixaTexto(f)}`} inputMode="decimal" defaultValue={g.faixas[linha]?.valor.toFixed(2).replace('.', ',')}
                    onBlur={(e) => { const v = lerValor(e.target.value); if (v == null) return; mudarPacote(pacoteAberto, { confirmado: false, grades: p.grades.map((gg, k) => k !== gi ? gg : { ...gg, faixas: gg.faixas.map((ff, j) => j === linha ? { ...ff, valor: v } : ff) }) }); }} />
                </td>)}
                <td className={imp.ajuda}>{p.atual?.grades.flatMap((g) => g.faixas.filter((x) => x.min <= f.min && (x.max == null || x.max >= f.min)).map((x) => `${NOME_CATEGORIA[g.categoria].slice(0, 5)} ${moeda(x.valor)}`)).join(' · ') || 'sem preço'}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {p.cobranca === 'FAIXAS' && <div className={imp.linha2}>
            <label>Mínimo de convidados<input inputMode="numeric" value={p.convidadosMin ?? ''} readOnly /></label>
            <label>Máximo de convidados<input inputMode="numeric" value={p.convidadosMax ?? ''} onChange={(e) => mudarPacote(pacoteAberto, { convidadosMax: Number(e.target.value) || null, confirmado: false })} /></label>
          </div>}
          <h3>Descrição</h3>
          <p className={imp.ajuda}>Hoje: {p.atual?.descricao || 'Descrição não cadastrada.'}</p>
          <textarea rows={3} value={p.descricao ?? ''} onChange={(e) => mudarPacote(pacoteAberto, { descricao: e.target.value, confirmado: false })} />
          <label className={imp.marcar}><input type="checkbox" checked={p.aplicarDescricao} onChange={(e) => mudarPacote(pacoteAberto, { aplicarDescricao: e.target.checked, confirmado: false })} />Gravar esta descrição no pacote (pacote já usado ganha uma revisão)</label>
          {p.inclusos.length > 0 && <>
            <h3>Incluído no pacote</h3>
            <table className={imp.tabela}><tbody>{p.inclusos.map((inc, k) => <tr key={`${inc.texto}${k}`}>
              <td>{inc.texto}</td>
              <td><select aria-label={`Adicional para ${inc.texto}`} value={inc.adicionalId ?? ''} onChange={(e) => mudarPacote(pacoteAberto, { confirmado: false, inclusos: p.inclusos.map((x, j) => j === k ? { ...x, adicionalId: e.target.value || null } : x) })}>
                <option value="">Só no texto</option>
                {cadastro?.adicionais.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
              </select></td>
            </tr>)}</tbody></table>
            <label className={imp.marcar}><input type="checkbox" checked={p.aplicarInclusos} onChange={(e) => mudarPacote(pacoteAberto, { aplicarInclusos: e.target.checked, confirmado: false })} />Marcar os itens escolhidos como incluídos no pacote (não aparecem como adicional pago)</label>
          </>}
          {p.pendencias.length > 0 && <div className={imp.alerta}><strong>Confira:</strong><ul>{p.pendencias.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          <div className={styles.actions}>
            {p.pacoteId && <button type="button" onClick={() => mudarPacote(pacoteAberto, { confirmado: !p.confirmado })}>{p.confirmado ? 'Desfazer confirmação' : `Confirmar ${p.nomePdf}`}</button>}
          </div>
        </section>}
      </div>}

      {aba === 'adicionais' && <section className={imp.card}>
        <div className={imp.topo}>
          <h2>Adicionais lidos no PDF</h2>
          <button type="button" onClick={() => { setRevisao((r) => r && { ...r, adicionais: r.adicionais.map((a) => (a.destino.tipo !== 'IGNORAR' && a.faixas.length ? { ...a, confirmado: true } : a)) }); setAlterado(true); }}>Confirmar todos com preço</button>
        </div>
        <div className={imp.tabelaCaixa}><table className={imp.tabela}>
          <thead><tr><th>No PDF</th><th>Corresponde a</th><th>Cobrança</th><th>Preços</th><th>Hoje</th><th>Ok</th></tr></thead>
          <tbody>{revisao.adicionais.map((a, i) => <tr key={a.chave} data-pendente={a.pendencias.length > 0}>
            <td>{a.nomePdf}{a.pendencias.map((t) => <small key={t} className={imp.pendencia}>{t}</small>)}</td>
            <td><select aria-label={`Destino de ${a.nomePdf}`} value={a.destino.tipo === 'EXISTENTE' ? a.destino.adicionalId : a.destino.tipo} onChange={(e) => {
              const v = e.target.value;
              mudarAdicional(i, { confirmado: false, destino: v === 'NOVO' ? { tipo: 'NOVO', nome: a.nomePdf } : v === 'IGNORAR' ? { tipo: 'IGNORAR' } : { tipo: 'EXISTENTE', adicionalId: v } });
            }}>
              <option value="NOVO">Criar adicional novo</option>
              <option value="IGNORAR">Ignorar</option>
              {cadastro?.adicionais.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select></td>
            <td><select aria-label={`Cobrança de ${a.nomePdf}`} value={a.unidade} onChange={(e) => mudarAdicional(i, { unidade: e.target.value as RevAdicional['unidade'], confirmado: false })}>
              {Object.entries(NOME_UNIDADE).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select></td>
            <td>{a.faixas.map((f, k) => <label key={f.min} className={imp.faixa}>{f.rotulo ? `${f.rotulo} (${faixaTexto(f)})` : faixaTexto(f)}
              <input inputMode="decimal" defaultValue={f.valor.toFixed(2).replace('.', ',')} onBlur={(e) => { const v = lerValor(e.target.value); if (v == null) return; mudarAdicional(i, { confirmado: false, faixas: a.faixas.map((ff, j) => j === k ? { ...ff, valor: v } : ff) }); }} />
            </label>)}</td>
            <td className={imp.ajuda}>{a.atual?.length ? a.atual.map((f) => `${faixaTexto(f)}: ${moeda(f.valor)}`).join(' · ') : 'sem preço'}</td>
            <td>{a.destino.tipo !== 'IGNORAR' && <input type="checkbox" aria-label={`Confirmar ${a.nomePdf}`} checked={a.confirmado} onChange={(e) => mudarAdicional(i, { confirmado: e.target.checked })} />}</td>
          </tr>)}</tbody>
        </table></div>
        <p className={imp.ajuda}>Os preços entram na nova tabela. Em quais pacotes cada adicional é oferecido continua em Itens do Buffet.</p>
      </section>}

      {aba === 'horarios' && <section className={imp.card}>
        <h2>Horários</h2>
        <ul className={imp.lista}>{revisao.horarios.map((h) => <li key={h.descricao}><strong>{h.horario === 'NOBRE' ? 'Nobre' : 'Promocional'}:</strong> {h.descricao}</li>)}</ul>
        <p className={imp.ajuda}>Só para conferência: a regra de qual horário é nobre continua a da agenda.</p>
        {revisao.comuns.length > 0 && <><h3>Todos os pacotes incluem</h3><ul className={imp.lista}>{revisao.comuns.map((c) => <li key={c}>{c}</li>)}</ul></>}
        {revisao.informacoes.length > 0 && <><h3>Informações importantes</h3><ul className={imp.lista}>{revisao.informacoes.map((c) => <li key={c}>{c}</li>)}</ul></>}
      </section>}

      {aba === 'nao' && <section className={imp.card}>
        <h2>O que não entra no sistema</h2>
        <p className={imp.ajuda}>Fica registrado na importação, para consulta. Nada aqui muda preço.</p>
        <ul className={imp.lista}>{revisao.naoImportavel.map((n) => <li key={n.texto}><strong>{n.texto}</strong>{n.pagina ? ` · página ${n.pagina}` : ''} — {n.motivo}</li>)}</ul>
      </section>}

      <div className={imp.rodape}>
        <span>{pendencias && pendencias.total > 0 ? `Faltam confirmar: ${pendencias.pacotes} pacote(s) e ${pendencias.adicionais} adicional(is).` : 'Tudo confirmado.'}</span>
        <div className={styles.actions}>
          <button type="button" onClick={() => void acao('descartar')}>Descartar</button>
          <button type="button" disabled={!alterado || salvando} onClick={() => { setSalvando(true); void salvar().catch((e) => setErro(e.message)).finally(() => setSalvando(false)); }}>Salvar revisão</button>
          <AdminPrimaryButton disabled={!pendencias || pendencias.total > 0 || salvando} onClick={() => setConfirmando(true)}>Publicar tabela</AdminPrimaryButton>
        </div>
      </div>
    </div>

    {confirmando && resumo && <div className={imp.overlay} role="dialog" aria-label="Publicar nova tabela">
      <div className={imp.dialogo}>
        <h2>Publicar nova tabela de preços?</h2>
        <p>Vale a partir de agora e substitui a tabela atual. Fechamentos já gravados não mudam.</p>
        <ul className={imp.lista}>
          <li>{resumo.pacotes} pacote(s) · {resumo.precosPacote} preço(s)</li>
          <li>{resumo.adicionais} adicional(is) com preço · {resumo.adicionaisNovos} novo(s)</li>
          <li>{resumo.descricoes} descrição(ões) · {resumo.inclusos} item(ns) incluso(s)</li>
        </ul>
        <p className={imp.ajuda}>Ordem: primeiro os preços, numa única publicação; depois descrição e inclusos de cada pacote. Se um pacote falhar nessa segunda parte, os preços continuam publicados e o resultado mostra o que faltou.</p>
        <div className={styles.actions}>
          <button type="button" onClick={() => setConfirmando(false)}>Voltar à revisão</button>
          <AdminPrimaryButton carregando={salvando} onClick={() => void acao('publicar')}>Publicar tabela</AdminPrimaryButton>
        </div>
      </div>
    </div>}
  </main>;
}
