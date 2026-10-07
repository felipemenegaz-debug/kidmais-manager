'use client';
import { useEffect, useMemo, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { problemasDoConteudo, type ConteudoModelo } from '@/lib/contratos/modelo-empresa/conteudo';
import styles from './workspace.module.css';
import imp from './importacao-tabela.module.css';
import mc from './modelo-contrato.module.css';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { mensagemAviso } from './importacao-tabela';

type Campo = { chave: string; rotulo: string; grupo: string; exemplo: string };
type Painel = {
  migracaoPendente: boolean;
  ativo: { id: string; versao: number; aprovadoEm: string } | null;
  versoes: Array<{ versao: number; situacao: string; aprovadoEm: string }>;
  rascunhos: Array<{ id: string; arquivoNome: string; criadoEm: string }>;
  campos: Campo[];
};
type Rascunho = { id: string; situacao: string; arquivoNome: string; versao: number; avisos: string[]; revisao: { conteudo: ConteudoModelo; avisos: string[] } | null };
type Foco = { campo: string; inicio: number; fim: number } | null;

const API = '/api/admin/configuracoes/modelo-contrato';
const API_LEITURA = '/api/admin/inteligencia/modelo-contrato';

async function lerJson(resposta: Response) {
  const body = await resposta.json().catch(() => ({}));
  if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Não foi possível concluir.');
  return body.data;
}

export default function ModeloContrato() {
  const [painel, setPainel] = useState<Painel | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [conteudo, setConteudo] = useState<ConteudoModelo | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [alterado, setAlterado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [revisado, setRevisado] = useState(false);
  const [foco, setFoco] = useState<Foco>(null);

  async function carregarPainel() { setPainel(await lerJson(await adminFetch(API))); }
  useEffect(() => {
    let vivo = true;
    adminFetch(API).then(lerJson).then((d) => { if (vivo) setPainel(d); }).catch((e) => { if (vivo) setErro(e.message); });
    return () => { vivo = false; };
  }, []);

  function abrir(r: Rascunho) { setRascunho(r); setConteudo(r.revisao?.conteudo ?? null); setAlterado(false); setErro(''); }

  async function executar<T>(trabalho: () => Promise<T>) {
    setOcupado(true); setErro('');
    try { return await trabalho(); } catch (e) { setErro((e as Error).message); return undefined; } finally { setOcupado(false); }
  }

  const ler = () => executar(async () => {
    if (!arquivo) return;
    const form = new FormData();
    form.set('arquivo', arquivo);
    abrir(await lerJson(await adminFetch(API_LEITURA, { method: 'POST', body: form })));
  });
  const reler = () => executar(async () => { if (rascunho) abrir(await lerJson(await adminFetch(`${API_LEITURA}?id=${rascunho.id}`, { method: 'POST' }))); });
  const abrirRascunho = (id: string) => executar(async () => abrir(await lerJson(await adminFetch(`${API}/${id}`))));
  async function salvar(): Promise<Rascunho | undefined> {
    if (!rascunho || !conteudo) return undefined;
    const data: Rascunho = await lerJson(await adminFetch(`${API}/${rascunho.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versao: rascunho.versao, revisao: { conteudo, avisos: rascunho.revisao?.avisos ?? [] } }),
    }));
    setRascunho(data); setAlterado(false); setAviso('Rascunho salvo.');
    return data;
  }
  const previa = () => executar(async () => {
    if (!rascunho || !conteudo) return;
    const r = await adminFetch(`${API}/${rascunho.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'previa', conteudo }) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw Error(b.erro || 'Não foi possível gerar a prévia.'); }
    window.open(URL.createObjectURL(await r.blob()), '_blank', 'noopener');
  });
  const publicar = () => executar(async () => {
    if (!rascunho) return;
    const atual = alterado ? await salvar() : rascunho;
    if (!atual) return;
    const data = await lerJson(await adminFetch(`${API}/${atual.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'publicar', versao: atual.versao, revisadoPorPessoa: true }),
    }));
    setConfirmando(false); setRascunho(null); setConteudo(null); setRevisado(false);
    setAviso(`Modelo publicado (versão ${data.versao}). Os próximos contratos gerados no admin seguem este padrão.`);
    await carregarPainel();
  });
  const descartar = () => executar(async () => {
    if (!rascunho) return;
    await lerJson(await adminFetch(`${API}/${rascunho.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'descartar' }) }));
    setRascunho(null); setConteudo(null); setAviso('Rascunho descartado.');
    await carregarPainel();
  });

  function mudar(m: (c: ConteudoModelo) => ConteudoModelo) { setConteudo((c) => (c ? m(c) : c)); setAlterado(true); }
  const lembrar = (campo: string) => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    setFoco({ campo, inicio: e.currentTarget.selectionStart ?? e.currentTarget.value.length, fim: e.currentTarget.selectionEnd ?? e.currentTarget.value.length });
  };
  function inserir(chave: string) {
    const f = foco;
    if (!f || !conteudo) { setAviso('Clique no texto onde o campo deve entrar e depois no campo.'); return; }
    const marca = `{{${chave}}}`;
    const colar = (t: string) => t.slice(0, f.inicio) + marca + t.slice(f.fim);
    const [tipo, indice] = f.campo.split(':');
    const i = Number(indice);
    mudar((c) => {
      if (tipo === 'titulo') return { ...c, titulo: colar(c.titulo) };
      if (tipo === 'preambulo') return { ...c, preambulo: c.preambulo.map((x, k) => (k === i ? colar(x) : x)) };
      if (tipo === 'observacao') return { ...c, observacoes: c.observacoes.map((x, k) => (k === i ? colar(x) : x)) };
      if (tipo === 'clausula') return { ...c, clausulas: c.clausulas.map((x, k) => (k === i ? { ...x, texto: colar(x.texto) } : x)) };
      return c;
    });
    setFoco({ ...f, inicio: f.inicio + marca.length, fim: f.inicio + marca.length });
  }

  const problemas = useMemo(() => (conteudo ? problemasDoConteudo(conteudo) : []), [conteudo]);
  const grupos = useMemo(() => {
    const m = new Map<string, Campo[]>();
    for (const c of painel?.campos ?? []) m.set(c.grupo, [...(m.get(c.grupo) ?? []), c]);
    return [...m.entries()];
  }, [painel]);

  // ── Painel ────────────────────────────────────────────────────────────────
  if (!rascunho) {
    return <main className={styles.page} data-admin-workspace aria-busy={ocupado}>
      <header className={styles.header}><h1>Modelo de contrato</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        {aviso && <p role="status">{aviso}</p>}
        {painel?.migracaoPendente && <section className={imp.alerta}>A atualização do banco para modelos de contrato (071 e 072) ainda não foi aplicada.</section>}
        <section className={imp.card}>
          <h2>Modelo em uso</h2>
          {painel?.ativo
            ? <p>Versão {painel.ativo.versao}, aprovada em {new Date(painel.ativo.aprovadoEm).toLocaleString('pt-BR')}. Os contratos gerados no admin desta empresa usam este texto, com os dados de cada festa.</p>
            : <p>Esta empresa ainda não tem modelo próprio. Envie o contrato que a loja já usa para gerar os contratos no padrão dela.</p>}
          {painel && painel.versoes.length > 1 && <p className={imp.ajuda}>Versões anteriores: {painel.versoes.filter((v) => v.situacao !== 'ATIVO').map((v) => v.versao).join(', ')}. Contratos já gerados guardam o próprio PDF e não mudam.</p>}
        </section>
        <div className={imp.colunas}>
          <section className={imp.card}>
            <h2>Importar o contrato da loja</h2>
            <label className={imp.envio}>
              <span>Escolha o contrato em PDF (até 15 MB). Pode ser um contrato já preenchido: os dados do cliente viram campos automáticos.</span>
              <input type="file" accept="application/pdf" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
            </label>
            <AdminPrimaryButton disabled={!arquivo || ocupado} carregando={ocupado} onClick={() => void ler()}>Ler contrato</AdminPrimaryButton>
            {ocupado && <p role="status">Lendo o contrato com IA. Pode levar até 2 minutos; não feche esta tela.</p>}
          </section>
          <section className={imp.card}>
            <h2>Como funciona</h2>
            <ul className={imp.lista}>
              <li>A IA copia as cláusulas e troca os dados de cada festa por campos (nome, CPF, data, valor…).</li>
              <li>Você revisa o texto, confere a prévia em PDF e aprova.</li>
              <li>Só depois da aprovação o modelo passa a valer para os contratos novos.</li>
            </ul>
            <p className={imp.ajuda}>O PDF vai ao provedor de IA (OpenAI) só para leitura. A revisão jurídica do texto é responsabilidade da empresa.</p>
          </section>
        </div>
        {(painel?.rascunhos.length ?? 0) > 0 && <section className={imp.card}>
          <h2>Rascunhos em revisão</h2>
          {painel!.rascunhos.map((r) => <div key={r.id} className={imp.linhaLista}>
            <span>{r.arquivoNome} · {new Date(r.criadoEm).toLocaleString('pt-BR')}</span>
            <button type="button" onClick={() => void abrirRascunho(r.id)}>Continuar revisão</button>
          </div>)}
        </section>}
      </div>
    </main>;
  }

  // ── Leitura sem resultado ────────────────────────────────────────────────
  if (!conteudo) {
    return <main className={styles.page} data-admin-workspace aria-busy={ocupado}>
      <header className={styles.header}><h1>Leitura não concluída</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        <section className={imp.alerta}>{(rascunho.avisos.length ? rascunho.avisos : ['MODELO_INESPERADO']).map((a) => <p key={a}>{mensagemAviso(a)}</p>)}</section>
        <div className={styles.actions}>
          <AdminPrimaryButton carregando={ocupado} onClick={() => void reler()}>Ler de novo</AdminPrimaryButton>
          <button type="button" onClick={() => void descartar()}>Descartar</button>
          <button type="button" onClick={() => setRascunho(null)}>Voltar</button>
        </div>
      </div>
    </main>;
  }

  // ── Revisão ───────────────────────────────────────────────────────────────
  return <main className={styles.page} data-admin-workspace aria-busy={ocupado}>
    <header className={styles.header}><h1>Revise o modelo de contrato</h1><span className={styles.badge}>{rascunho.arquivoNome}</span></header>
    <div className={styles.content}>
      <p role="alert">{erro}</p>
      {aviso && <p role="status">{aviso}</p>}
      {(rascunho.revisao?.avisos.length ?? 0) > 0 && <section className={imp.alerta}><strong>A leitura pede atenção:</strong><ul>{rascunho.revisao!.avisos.map((a) => <li key={a}>{a}</li>)}</ul></section>}
      <div className={mc.grade}>
        <div className={mc.editor}>
          <section className={imp.card}>
            <h2>Cabeçalho</h2>
            <label>Título<input value={conteudo.titulo} onFocus={lembrar('titulo:0')} onSelect={lembrar('titulo:0')} onChange={(e) => mudar((c) => ({ ...c, titulo: e.target.value }))} /></label>
            <div className={imp.linha2}>
              <label>Contratada (nome ou razão social)<input value={conteudo.contratada.nome} onChange={(e) => mudar((c) => ({ ...c, contratada: { ...c.contratada, nome: e.target.value } }))} /></label>
              <label>CNPJ ou CPF<input value={conteudo.contratada.documento} onChange={(e) => mudar((c) => ({ ...c, contratada: { ...c.contratada, documento: e.target.value } }))} /></label>
            </div>
            <label>Endereço da contratada<input value={conteudo.contratada.endereco} onChange={(e) => mudar((c) => ({ ...c, contratada: { ...c.contratada, endereco: e.target.value } }))} /></label>
            <div className={imp.linha2}>
              <label>Representante<input value={conteudo.contratada.representante} onChange={(e) => mudar((c) => ({ ...c, contratada: { ...c.contratada, representante: e.target.value } }))} /></label>
              <label>Cidade da assinatura<input value={conteudo.cidadeAssinatura} onChange={(e) => mudar((c) => ({ ...c, cidadeAssinatura: e.target.value }))} /></label>
            </div>
            {conteudo.preambulo.map((t, i) => <label key={`p${i}`}>Preâmbulo<textarea rows={3} value={t} onFocus={lembrar(`preambulo:${i}`)} onSelect={lembrar(`preambulo:${i}`)} onChange={(e) => mudar((c) => ({ ...c, preambulo: c.preambulo.map((x, k) => (k === i ? e.target.value : x)) }))} /></label>)}
          </section>
          <section className={imp.card}>
            <h2>Cláusulas · {conteudo.clausulas.length}</h2>
            {conteudo.clausulas.map((cl, i) => <div key={`c${i}`} className={mc.clausula}>
              <div className={mc.clausulaTopo}>
                <strong>Cláusula {i + 1}</strong>
                <div className={mc.botoes}>
                  <button type="button" aria-label={`Subir cláusula ${i + 1}`} disabled={i === 0} onClick={() => mudar((c) => { const l = [...c.clausulas]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; return { ...c, clausulas: l }; })}>↑</button>
                  <button type="button" aria-label={`Descer cláusula ${i + 1}`} disabled={i === conteudo.clausulas.length - 1} onClick={() => mudar((c) => { const l = [...c.clausulas]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; return { ...c, clausulas: l }; })}>↓</button>
                  <button type="button" aria-label={`Remover cláusula ${i + 1}`} onClick={() => mudar((c) => ({ ...c, clausulas: c.clausulas.filter((_, k) => k !== i) }))}>×</button>
                </div>
              </div>
              <label>Título (opcional)<input value={cl.titulo ?? ''} onChange={(e) => mudar((c) => ({ ...c, clausulas: c.clausulas.map((x, k) => (k === i ? { ...x, titulo: e.target.value || null } : x)) }))} /></label>
              <textarea aria-label={`Texto da cláusula ${i + 1}`} rows={Math.min(12, Math.max(3, Math.ceil(cl.texto.length / 90)))} value={cl.texto} onFocus={lembrar(`clausula:${i}`)} onSelect={lembrar(`clausula:${i}`)} onChange={(e) => mudar((c) => ({ ...c, clausulas: c.clausulas.map((x, k) => (k === i ? { ...x, texto: e.target.value } : x)) }))} />
            </div>)}
            <button type="button" onClick={() => mudar((c) => ({ ...c, clausulas: [...c.clausulas, { titulo: null, texto: 'Nova cláusula.' }] }))}>+ Adicionar cláusula</button>
          </section>
          {conteudo.observacoes.length > 0 && <section className={imp.card}>
            <h2>Observações finais</h2>
            {conteudo.observacoes.map((t, i) => <textarea key={`o${i}`} aria-label={`Observação ${i + 1}`} rows={2} value={t} onFocus={lembrar(`observacao:${i}`)} onSelect={lembrar(`observacao:${i}`)} onChange={(e) => mudar((c) => ({ ...c, observacoes: c.observacoes.map((x, k) => (k === i ? e.target.value : x)) }))} />)}
          </section>}
        </div>
        <aside className={mc.lateral}>
          <section className={imp.card}>
            <h2>Campos automáticos</h2>
            <p className={imp.ajuda}>Clique no texto e depois no campo para inserir. Cada contrato preenche com os dados da festa.</p>
            {grupos.map(([grupo, campos]) => <div key={grupo}>
              <h3>{grupo}</h3>
              <div className={mc.chips}>{campos.map((c) => <button key={c.chave} type="button" title={`Ex.: ${c.exemplo}`} onClick={() => inserir(c.chave)}>{c.rotulo}</button>)}</div>
            </div>)}
          </section>
          <section className={problemas.length ? imp.alerta : imp.sucesso} aria-live="polite">
            {problemas.length ? <><strong>Antes de publicar:</strong><ul>{problemas.map((p) => <li key={p}>{p}</li>)}</ul></> : 'Campos conferidos: o modelo pode ser publicado.'}
          </section>
        </aside>
      </div>
      <div className={imp.rodape}>
        <span>{alterado ? 'Alterações não salvas.' : 'Rascunho salvo.'}</span>
        <div className={styles.actions}>
          <button type="button" onClick={() => void descartar()}>Descartar</button>
          <button type="button" disabled={!alterado || ocupado} onClick={() => void executar(salvar)}>Salvar rascunho</button>
          <button type="button" disabled={ocupado} onClick={() => void previa()}>Ver prévia em PDF</button>
          <AdminPrimaryButton disabled={problemas.length > 0 || ocupado} onClick={() => setConfirmando(true)}>Publicar modelo</AdminPrimaryButton>
        </div>
      </div>
    </div>
    {confirmando && <div className={imp.overlay} role="dialog" aria-label="Publicar modelo de contrato">
      <div className={imp.dialogo}>
        <h2>Publicar o modelo de contrato?</h2>
        <p>Os próximos contratos gerados no admin desta empresa usarão este texto. Contratos já gerados não mudam.</p>
        <label className={imp.marcar}><input type="checkbox" checked={revisado} onChange={(e) => setRevisado(e.target.checked)} />Revisei o texto deste contrato e aprovo seu uso com os clientes desta empresa.</label>
        <div className={styles.actions}>
          <button type="button" onClick={() => setConfirmando(false)}>Voltar</button>
          <AdminPrimaryButton disabled={!revisado} carregando={ocupado} onClick={() => void publicar()}>Publicar modelo</AdminPrimaryButton>
        </div>
      </div>
    </div>}
  </main>;
}
