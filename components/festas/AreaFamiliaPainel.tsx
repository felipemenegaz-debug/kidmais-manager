'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './festa.module.css';

type Papel = 'CONTRATANTE' | 'SEGUNDO_RESPONSAVEL';
type Resumo = {
  aberta: boolean;
  fechaEm: string;
  pessoas: Array<{ id: string; papel: Papel; nome: string; whatsappMascarado: string | null; linkAtivoAte: string | null }>;
  aparelhos: Array<{ id: string; papel: Papel; aparelho: string | null; entrouEm: string; ultimoUsoEm: string; lembrar: boolean }>;
};
type LinkGerado = { papel: Papel; url: string; expiraEm: string };

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
    if (d) setLink({ papel, url: `${window.location.origin}${String(d.caminho)}`, expiraEm: String(d.expiraEm) });
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
            <h3>{rotulo(p.papel)}: {p.nome || 'Sem nome'}</h3>
            <p>WhatsApp: {p.whatsappMascarado ?? 'não cadastrado'}</p>
            <p>{p.linkAtivoAte ? `Link enviado, vale até ${dia(p.linkAtivoAte)}.` : 'Nenhum link válido.'}</p>
            {gestao && dados.aberta && <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={() => gerar(p.papel)}>{p.linkAtivoAte ? 'Gerar link novo' : 'Gerar link'}</button>
              {p.papel === 'SEGUNDO_RESPONSAVEL' && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Remover o segundo responsável? Os aparelhos dele serão desconectados.')) void acao({ acao: 'REMOVER_SEGUNDO', pessoaId: p.id }); }}>Remover</button>}
            </div>}
          </article>
        ))}
        {link && <div className={styles.row}>
          <p><strong>Link de {rotulo(link.papel).toLowerCase()}</strong> (aparece só agora; vale até {dia(link.expiraEm)}). Gerar outro cancela este.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link.url)}>Copiar link</button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(mensagem)}>Copiar mensagem pronta</button>
            <button type="button" onClick={() => setLink(null)}>Fechar</button>
          </div>
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
        <h3>Aparelhos conectados</h3>
        {!dados.aparelhos.length ? <p>Nenhum aparelho conectado.</p> : dados.aparelhos.map((a) => (
          <p key={a.id}>{rotulo(a.papel)} • {a.aparelho ?? 'Aparelho'} • entrou em {momento(a.entrouEm)} • último uso {momento(a.ultimoUsoEm)}{a.lembrar ? ' • lembrado' : ''}</p>
        ))}
        {gestao && dados.aparelhos.length > 0 && <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm('Desconectar todos os aparelhos desta festa?')) void acao({ acao: 'DESCONECTAR_TODOS' }); }}>Desconectar todos</button>
        </div>}
      </>}
    </section>
  );
}
