'use client';
import { dialogo } from '@/components/JanelaConfirmacao';
import { useCallback, useEffect, useState } from 'react';
import type { ResumoAcoesPainel } from '@/lib/area-familia/admin';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './festa.module.css';

type Papel = 'CONTRATANTE' | 'SEGUNDO_RESPONSAVEL';
type Resumo = {
  aberta: boolean;
  fechaEm: string;
  pessoas: Array<{ id: string; papel: Papel; nome: string; whatsappMascarado: string | null; linkAtivoAte: string | null }>;
  aparelhos: Array<{ id: string; papel: Papel; aparelho: string | null; entrouEm: string; ultimoUsoEm: string; lembrar: boolean }>;
  acoes?: ResumoAcoesPainel;
};
type LinkGerado = { papel: Papel; url: string; expiraEm: string };
type Copia = { alvo: 'link' | 'mensagem'; ok: boolean };

const dia = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const momento = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const rotulo = (p: Papel) => (p === 'CONTRATANTE' ? 'Contratante' : 'Segundo responsável');

/**
 * Área "Minha festa" no painel da festa (123, F1): enviar o link (copiar ou mensagem pronta no WhatsApp), ver e
 * desconectar aparelhos, cadastrar e remover o segundo responsável. Ações só para a gestão.
 * O link aparece uma vez, logo depois de gerado: o sistema não guarda o link, só o hash.
 */
export default function AreaFamiliaPainel({ festaId, gestao }: { festaId: string; gestao: boolean }) {
  const [dados, setDados] = useState<Resumo | null>(null);
  const [erro, setErro] = useState('');
  const [desligada, setDesligada] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<LinkGerado | null>(null);
  const [novo, setNovo] = useState(false);
  const [copia, setCopia] = useState<Copia | null>(null);
  const url = `/api/admin/festas/${festaId}/area-familia`;

  const carregar = useCallback(async () => {
    try {
      const r = await adminFetch(url);
      const j = await r.json();
      if (r.status === 404 && j?.codigo === 'AREA_FAMILIA_DESLIGADA') { setDesligada(true); return; }
      if (!j.ok) { setErro(j.erro || 'Não foi possível carregar a área da família.'); return; }
      setDados(j.data); setErro('');
    } catch { setErro('Não foi possível carregar a área da família.'); }
  }, [url]);

  useEffect(() => {
    let ativo = true;
    adminFetch(url).then(async (r) => {
      const j = await r.json();
      if (!ativo) return;
      if (r.status === 404 && j?.codigo === 'AREA_FAMILIA_DESLIGADA') setDesligada(true);
      else if (!j.ok) setErro(j.erro || 'Não foi possível carregar a área da família.');
      else { setDados(j.data); setErro(''); }
    }).catch(() => { if (ativo) setErro('Não foi possível carregar a área da família.'); });
    return () => { ativo = false; };
  }, [url]);

  async function acao(corpo: Record<string, unknown>) {
    setBusy(true); setErro('');
    try {
      const j = await (await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })).json();
      if (!j.ok) { setErro(j.erro || 'Não foi possível concluir.'); return null; }
      await carregar();
      return j.data as Record<string, unknown>;
    } catch { setErro('Não foi possível concluir.'); return null; } finally { setBusy(false); }
  }

  async function gerar(papel: Papel) {
    const d = await acao({ acao: 'GERAR_LINK', papel });
    setCopia(null);
    if (d) setLink({ papel, url: `${window.location.origin}${String(d.caminho)}`, expiraEm: String(d.expiraEm) });
  }

  /** Copia e avisa. Se o navegador recusar (permissão, aba sem foco, navegador embutido), mostra o texto para copiar à mão. */
  async function copiar(alvo: Copia['alvo'], texto: string) {
    try {
      if (!navigator.clipboard) throw new Error('sem área de transferência');
      await navigator.clipboard.writeText(texto);
      setCopia({ alvo, ok: true });
    } catch { setCopia({ alvo, ok: false }); }
  }

  async function cadastrar(form: FormData) {
    const d = await acao({
      acao: 'CADASTRAR_SEGUNDO', nome: String(form.get('nome') || ''), whatsapp: String(form.get('whatsapp') || ''),
      email: String(form.get('email') || '') || null, documento: String(form.get('documento') || '') || null,
    });
    if (d) setNovo(false);
  }

  if (desligada) return null;
  const segundo = dados?.pessoas.find((p) => p.papel === 'SEGUNDO_RESPONSAVEL');
  const mensagem = link ? `Olá! Este é o link da área da sua festa: ${link.url}\nAo abrir, confirme seus dados e digite o código que chegará no seu WhatsApp. Não compartilhe este link.` : '';

  return (
    <section className={styles.card}>
      <h2>Área da família</h2>
      {erro && <p role="alert">{erro}</p>}
      {!dados ? (!erro && <p>Carregando…</p>) : <>
        {!dados.aberta && <p>A área desta festa está fechada (contrato cancelado, festa removida ou mais de 30 dias depois da festa).</p>}
        {dados.aberta && <p>Disponível até {dia(dados.fechaEm)}.</p>}
        {dados.pessoas.map((p) => (
          <article className={styles.row} key={p.papel + p.id}>
            <h3>{rotulo(p.papel)}: {p.nome || 'Sem nome'}{p.papel === 'SEGUNDO_RESPONSAVEL' && dados.acoes?.segundoPelaFamilia ? ' (convidado pela família)' : ''}</h3>
            <p>WhatsApp: {p.whatsappMascarado ?? 'não cadastrado'}</p>
            <p>{p.linkAtivoAte ? `Link enviado, vale até ${dia(p.linkAtivoAte)}.` : 'Nenhum link válido.'}</p>
            {gestao && dados.aberta && <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={() => gerar(p.papel)}>{p.linkAtivoAte ? 'Gerar link novo' : 'Gerar link'}</button>
              {p.papel === 'SEGUNDO_RESPONSAVEL' && <button type="button" disabled={busy} onClick={async (evento) => { if (await dialogo.confirmar("Remover responsável", 'Remover o segundo responsável? Os aparelhos dele serão desconectados.', undefined, evento.currentTarget)) void acao({ acao: 'REMOVER_SEGUNDO', pessoaId: p.id }); }}>Remover</button>}
            </div>}
          </article>
        ))}
        {link && <div className={styles.row}>
          <p><strong>Link de {rotulo(link.papel).toLowerCase()}</strong> (aparece só agora; vale até {dia(link.expiraEm)}). Gerar outro cancela este.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void copiar('link', link.url)}>Copiar link</button>
            <button type="button" onClick={() => void copiar('mensagem', mensagem)}>Copiar mensagem pronta</button>
            <button type="button" onClick={() => { setLink(null); setCopia(null); }}>Fechar</button>
          </div>
          {copia && <p role="status">{copia.ok
            ? (copia.alvo === 'link' ? 'Link copiado.' : 'Mensagem copiada.')
            : 'Não foi possível copiar automaticamente. Selecione o texto abaixo e copie.'}</p>}
          {copia && !copia.ok && (copia.alvo === 'link'
            ? <label>Link da área<input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} /></label>
            : <label>Mensagem pronta<textarea readOnly value={mensagem} onFocus={(e) => e.currentTarget.select()} /></label>)}
        </div>}
        {gestao && dados.aberta && !segundo && (novo
          ? <form action={cadastrar} className={styles.row}>
              <h3>Segundo responsável</h3>
              <p>Vê tudo da festa, mas não convida nem remove ninguém. O código chega só no WhatsApp dele.</p>
              <label>Nome <input name="nome" required minLength={2} maxLength={120} /></label>
              <label>WhatsApp com DDD <input name="whatsapp" required inputMode="tel" maxLength={20} /></label>
              <label>E-mail (opcional) <input name="email" type="email" maxLength={254} /></label>
              <label>CPF (opcional; se informado, será pedido na entrada) <input name="documento" inputMode="numeric" maxLength={14} /></label>
              <div className={styles.actions}><button type="submit" disabled={busy}>Cadastrar</button><button type="button" onClick={() => setNovo(false)}>Cancelar</button></div>
            </form>
          : <div className={styles.actions}><button type="button" onClick={() => setNovo(true)}>Cadastrar segundo responsável</button></div>)}
        {dados.acoes?.disponivel && <AcoesDaFamiliaPainel acoes={dados.acoes} gestao={gestao} busy={busy} acao={acao} />}
        <h3>Aparelhos conectados</h3>
        {!dados.aparelhos.length ? <p>Nenhum aparelho conectado.</p> : dados.aparelhos.map((a) => (
          <p key={a.id}>{rotulo(a.papel)} • {a.aparelho ?? 'Aparelho'} • entrou em {momento(a.entrouEm)} • último uso {momento(a.ultimoUsoEm)}{a.lembrar ? ' • lembrado' : ''}</p>
        ))}
        {gestao && dados.aparelhos.length > 0 && <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={async (evento) => { if (await dialogo.confirmar("Desconectar todos", 'Desconectar todos os aparelhos desta festa?', undefined, evento.currentTarget)) void acao({ acao: 'DESCONECTAR_TODOS' }); }}>Desconectar todos</button>
        </div>}
      </>}
    </section>
  );
}

const reais = (centavos: number) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quem = (p: Papel | null) => (p ? rotulo(p).toLowerCase() : 'família');

/**
 * F3 (125) no painel: avisos "Já paguei" (conferir ou descartar; o pagamento continua sendo baixado no financeiro),
 * pendências do cliente que a família vê (visível + texto para a família; devolver um "feito"), aviso fixo da empresa.
 */
function AcoesDaFamiliaPainel({ acoes, gestao, busy, acao }: {
  acoes: ResumoAcoesPainel; gestao: boolean; busy: boolean;
  acao: (corpo: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}) {
  const [aviso, setAviso] = useState(acoes.avisoFixo ?? '');
  return <>
    <h3>Avisos de pagamento da família</h3>
    {acoes.avisos.length === 0 && <p>Nenhum aviso para conferir.</p>}
    {acoes.avisos.map((a) => (
      <article className={styles.row} key={a.id}>
        <p>Parcela {a.parcela} ({reais(a.saldoCentavos)}): {quem(a.papel)} avisou em {momento(a.criadoEm)}.</p>
        {a.observacao && <p>Observação: {a.observacao}</p>}
        {gestao && <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => void acao({ acao: 'TRATAR_AVISO_PAGAMENTO', avisoId: a.id, decisao: 'CONFERIDO' })}>Conferido</button>
          <button type="button" disabled={busy} onClick={() => void acao({ acao: 'TRATAR_AVISO_PAGAMENTO', avisoId: a.id, decisao: 'DESCARTADO' })}>Descartar</button>
        </div>}
      </article>
    ))}
    <h3>Pendências que a família vê</h3>
    {acoes.pendencias.length === 0 && <p>Nenhuma pendência do cliente nesta festa.</p>}
    {acoes.pendencias.map((p) => <PendenciaPainel key={p.id} p={p} gestao={gestao} busy={busy} acao={acao} />)}
    <h3>Aviso fixo para as famílias</h3>
    <p>Aparece no início da área de todas as festas da empresa.</p>
    {gestao
      ? <div className={styles.row}>
          <textarea value={aviso} maxLength={500} rows={3} onChange={(e) => setAviso(e.target.value)} aria-label="Aviso fixo para as famílias" />
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => void acao({ acao: 'AVISO_FIXO', texto: aviso.trim() || null })}>Salvar aviso</button>
          </div>
        </div>
      : <p>{acoes.avisoFixo || 'Sem aviso.'}</p>}
  </>;
}

function PendenciaPainel({ p, gestao, busy, acao }: {
  p: ResumoAcoesPainel['pendencias'][number]; gestao: boolean; busy: boolean;
  acao: (corpo: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}) {
  const [visivel, setVisivel] = useState(p.familia?.visivel ?? false);
  const [texto, setTexto] = useState(p.familia?.texto ?? '');
  const f = p.familia;
  return (
    <article className={styles.row}>
      <p>{p.descricao}{p.prazo ? ` (até ${dia(p.prazo)})` : ''}</p>
      {f?.feitaEm && <p>Marcada como feita pela {quem(f.feitaPor)} em {momento(f.feitaEm)}.</p>}
      {f?.devolvidaEm && !f.feitaEm && <p>Devolvida para a família em {momento(f.devolvidaEm)}.</p>}
      {gestao && <>
        <label><input type="checkbox" checked={visivel} onChange={(e) => setVisivel(e.target.checked)} /> Mostrar para a família</label>
        <input value={texto} maxLength={280} onChange={(e) => setTexto(e.target.value)} placeholder="Texto que a família vê" aria-label="Texto que a família vê" />
        <div className={styles.actions}>
          <button type="button" disabled={busy || !texto.trim()} onClick={() => void acao({ acao: 'PENDENCIA_FAMILIA', pendenciaId: p.id, visivel, texto: texto.trim() })}>Salvar</button>
          {f?.feitaEm && <button type="button" disabled={busy} onClick={() => void acao({ acao: 'DEVOLVER_PENDENCIA', pendenciaId: p.id })}>Devolver para a família</button>}
        </div>
      </>}
    </article>
  );
}
