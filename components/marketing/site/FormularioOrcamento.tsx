'use client';
import { useId, useState } from 'react';
import styles from './site-publico.module.css';

export type CapturaFormulario = Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term' | 'kc', string>>;

function novaChave() {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(24, '0').slice(0, 40); }
}

/**
 * Formulário de orçamento do site público. A chave de idempotência nasce ao abrir e só muda depois de um envio aceito:
 * reenviar por falha de rede não duplica o pedido. O campo "website" é armadilha para robôs (invisível para pessoas).
 * Em prévia, nada é enviado.
 */
export default function FormularioOrcamento({ acao, captura, previa = false }: { acao: string; captura: CapturaFormulario; previa?: boolean }) {
  const id = useId();
  // Gerada uma vez ao montar (não aparece na página: sem diferença de hidratação); troca só depois de envio aceito.
  const [chave, setChave] = useState(novaChave);
  const [estado, setEstado] = useState<'pronto' | 'enviando' | 'enviado' | 'erro'>('pronto');
  const [mensagem, setMensagem] = useState('');
  const [campoErro, setCampoErro] = useState<string | null>(null);

  async function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (previa || estado === 'enviando') return;
    const formulario = evento.currentTarget;
    const dados = new FormData(formulario);
    const corpo: Record<string, unknown> = { chave: chave || novaChave(), ...captura };
    for (const campo of ['nome', 'telefone', 'email', 'dataDesejada', 'convidados', 'mensagem', 'website']) corpo[campo] = String(dados.get(campo) ?? '');
    corpo.autorizaWhatsapp = dados.get('autorizaWhatsapp') === 'sim';
    setEstado('enviando'); setMensagem(''); setCampoErro(null);
    try {
      const resposta = await fetch(acao, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const json = await resposta.json().catch(() => null) as { ok?: boolean; erro?: string; data?: { mensagem?: string }; detalhes?: { campo?: string | null } } | null;
      if (resposta.ok && json?.ok) {
        setEstado('enviado'); setMensagem(json.data?.mensagem ?? 'Pedido recebido.'); setChave(novaChave());
        formulario.reset();
        return;
      }
      setEstado('erro'); setMensagem(json?.erro ?? 'Não foi possível enviar agora. Tente novamente.'); setCampoErro(json?.detalhes?.campo ?? null);
    } catch {
      setEstado('erro'); setMensagem('Sem conexão. Confira a internet e envie de novo (o pedido não será duplicado).');
    }
  }

  if (estado === 'enviado') {
    return <div className={styles.confirmacao} role="status"><strong>Pedido enviado!</strong><p>{mensagem}</p>
      <button type="button" className={styles.botaoSecundario} onClick={() => { setEstado('pronto'); setMensagem(''); }}>Enviar outro pedido</button></div>;
  }
  const erroEm = (campo: string) => (campoErro === campo ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-erro` } : {});
  return <form className={styles.formulario} onSubmit={enviar} noValidate={false} aria-describedby={previa ? `${id}-previa` : undefined}>
    {previa && <p id={`${id}-previa`} className={styles.avisoPrevia}>Prévia: o formulário não envia pedidos.</p>}
    <div className={styles.campos}>
      <label>Seu nome<input name="nome" required minLength={2} maxLength={120} autoComplete="name" {...erroEm('nome')} /></label>
      <label>Telefone / WhatsApp<input name="telefone" inputMode="tel" maxLength={20} autoComplete="tel" placeholder="(11) 99999-9999" {...erroEm('telefone')} /></label>
      <label>E-mail<input name="email" type="email" maxLength={254} autoComplete="email" {...erroEm('email')} /></label>
      <label>Data desejada<input name="dataDesejada" type="date" {...erroEm('dataDesejada')} /></label>
      <label>Convidados (aprox.)<input name="convidados" type="number" min={1} max={5000} inputMode="numeric" {...erroEm('convidados')} /></label>
      <label className={styles.campoLargo}>Mensagem<textarea name="mensagem" rows={3} maxLength={1000} placeholder="Tema, idade do aniversariante, dúvidas…" {...erroEm('mensagem')} /></label>
      <label className={`${styles.campoLargo} ${styles.consentimento}`}><input type="checkbox" name="autorizaWhatsapp" value="sim" /> Aceito receber mensagens do buffet pelo WhatsApp sobre festas. Posso cancelar a qualquer momento respondendo PARAR.</label>
      <div className={styles.armadilha} aria-hidden="true"><label>Site<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
    </div>
    <p className={styles.legal}>Informe telefone ou e-mail para receber a resposta. Seus dados são usados só para este atendimento.</p>
    {mensagem && <p id={`${id}-erro`} className={styles.erro} role="alert">{mensagem}</p>}
    <button type="submit" className={styles.botaoPrimario} disabled={previa || estado === 'enviando'}>{estado === 'enviando' ? 'Enviando…' : 'Pedir orçamento'}</button>
  </form>;
}
