'use client';
import { useState } from 'react';
import { LINK_AVISO_IA, MEIOS_AUTORIZACAO, MEIOS_DO_BUFFET, VINCULOS_RESPONSAVEL, type MeioAutorizacao, type VinculoResponsavel } from '@/lib/convites/consentimento-textos';

// Aviso no momento da geração e autorização específica do responsável legal (parecer da Astra de 21/10/2026).
// Textos, provedor e hashes vêm do servidor (provedor real configurado); o servidor recusa a geração sem o registro.
// A fotografia e as imagens da galeria não fazem parte desta autorização: são confirmadas a cada geração
// (ConfirmacaoImagensIA, abaixo), só depois de escolhidas.
export type AutorizacaoIATela = {
  versao: string; provedor: string; provedorNome: string; operador: 'BUFFET' | 'CLIENTE';
  aviso: string; consentimento: string; foto: string; imagens: string; alternativa: string;
  hashes: { autorizacao: string; imagens: string };
  vigente: { id: string; provedor: string; operador: 'BUFFET' | 'CLIENTE'; vinculo: VinculoResponsavel; meio: MeioAutorizacao; registradaEm: string } | null;
  precisaRenovar: boolean; indisponivel?: boolean; mensagemIndisponivel?: string;
};

type Props = { ia: AutorizacaoIATela; busy: boolean; ui: Record<string, string>; semIA: () => void;
  executar: (body: object, mensagem: string) => Promise<unknown> };

export default function ConviteAutorizacaoIA({ ia, busy, ui, semIA, executar }: Props) {
  const buffet = ia.operador === 'BUFFET';
  const [editando, setEditando] = useState(false);
  const [nome, setNome] = useState(''), [vinculo, setVinculo] = useState<VinculoResponsavel | ''>(''), [meio, setMeio] = useState<MeioAutorizacao | ''>('');
  const [consente, setConsente] = useState(false);
  const vigente = !ia.indisponivel && !ia.precisaRenovar && ia.vigente;
  const formulario = !vigente || editando;
  const quemRegistrou = vigente && (vigente.operador === 'BUFFET' ? 'buffet' : 'próprio responsável');
  const pronto = consente && nome.trim().length >= 2 && !!vinculo && (!buffet || !!meio);
  function limpar() { setNome(''); setVinculo(''); setMeio(''); setConsente(false); setEditando(false); }
  async function registrar() {
    if (!pronto) return;
    const r = await executar({ acao: 'autorizar_ia', versao: ia.versao, provedor: ia.provedor, textoHash: ia.hashes.autorizacao,
      responsavelNome: nome.trim(), vinculo, ...(buffet ? { meio } : {}), declaracao: true }, 'Autorização registrada.');
    if (r) limpar();
  }
  async function revogar() {
    const r = await executar({ acao: 'revogar_autorizacao_ia' }, 'Autorização revogada. Novas gerações com IA ficam bloqueadas até uma nova autorização.');
    if (r) limpar();
  }
  const aviso = <p>{ia.aviso} <a href={LINK_AVISO_IA} target="_blank" rel="noreferrer">Condições no Aviso de privacidade ↗</a></p>;
  return <section className={ui.consentimentoIA} aria-label="Autorização para gerar com IA">
    {formulario && <><h3>Antes de gerar com IA · {ia.provedorNome}</h3>{aviso}</>}
    {ia.indisponivel && <p role="alert">{ia.mensagemIndisponivel ?? 'A geração com IA está indisponível até a atualização do banco. Você pode seguir sem IA.'}</p>}
    {vigente && !editando && <>
      <p role="status"><strong>Autorização registrada</strong> em {new Date(vigente.registradaEm).toLocaleDateString('pt-BR')} · {VINCULOS_RESPONSAVEL[vigente.vinculo] ?? 'Responsável legal'} · {quemRegistrou}</p>
      <details>
        <summary>Detalhes</summary>
        {aviso}
        <p>{vigente.operador === ia.operador ? ia.consentimento : <>Declaração registrada por {quemRegistrou}.</>}</p>
        <p>Meio de autorização · {MEIOS_AUTORIZACAO[vigente.meio] ?? 'Não informado'}</p>
        <p>A fotografia e as imagens da galeria pedem confirmação própria a cada geração.</p>
        <div className={ui.acoes}>
          <button type="button" disabled={busy} onClick={() => setEditando(true)}>Registrar nova autorização</button>
          <button type="button" disabled={busy} onClick={() => void revogar()}>Revogar autorização</button>
        </div>
        <small>Revogar vale para usos futuros. As artes já geradas continuam na galeria até você excluí-las.</small>
      </details>
    </>}
    {formulario && !ia.indisponivel && <fieldset disabled={busy} className={ui.formularioAutorizacao}>
      <legend>{buffet ? 'Autorização do responsável legal' : 'Sua autorização'}</legend>
      {ia.precisaRenovar && <p role="alert">O provedor de IA ou o texto da autorização mudou. A autorização anterior perdeu a validade. Registre uma nova para continuar.</p>}
      <div className={ui.campos}>
        <label>{buffet ? 'Nome do responsável legal' : 'Seu nome (responsável legal)'}<input value={nome} maxLength={120} autoComplete="off" onChange={e => setNome(e.target.value)} /></label>
        <label>Vínculo com a criança<select value={vinculo} onChange={e => setVinculo(e.target.value as VinculoResponsavel)}><option value="">Escolha</option>{Object.entries(VINCULOS_RESPONSAVEL).map(([id, rotulo]) => <option key={id} value={id}>{rotulo}</option>)}</select></label>
        {buffet && <label>Como o responsável autorizou<select value={meio} onChange={e => setMeio(e.target.value as MeioAutorizacao)}><option value="">Escolha</option>{MEIOS_DO_BUFFET.map(id => <option key={id} value={id}>{MEIOS_AUTORIZACAO[id]}</option>)}</select></label>}
      </div>
      <label className={ui.check}><input type="checkbox" checked={consente} onChange={e => setConsente(e.target.checked)} />{ia.consentimento}</label>
      <small>A fotografia e as imagens da galeria não fazem parte desta autorização: são confirmadas a cada geração, depois de escolhidas. Não envie nem guarde cópia de documento: basta o nome e o vínculo.</small>
      <div className={ui.acoes}>
        <button type="button" className={ui.primario} disabled={!pronto} onClick={() => void registrar()}>Registrar autorização</button>
        {editando && <button type="button" onClick={limpar}>Cancelar</button>}
      </div>
    </fieldset>}
    {formulario && <p className={ui.alternativaSemIA}>{ia.alternativa} <button type="button" className={ui.linkBotao} disabled={busy} onClick={semIA}>Usar arte própria, sem IA</button></p>}
  </section>;
}

/** Confirmação da fotografia e das imagens da galeria para ESTA geração; só aparece depois de escolhida uma imagem. */
export function ConfirmacaoImagensIA({ ia, marcado, mudar, busy, ui }: { ia: AutorizacaoIATela; marcado: boolean; mudar: (v: boolean) => void; busy: boolean; ui: Record<string, string> }) {
  return <div>
    <label className={ui.check}><input type="checkbox" checked={marcado} disabled={busy} onChange={e => mudar(e.target.checked)} />{ia.foto}</label>
    <small>{ia.imagens}</small>
  </div>;
}
