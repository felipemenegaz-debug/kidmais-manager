'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { reaisDe } from '@/lib/financeiro/calculos';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import styles from './financeiro.module.css';

type PixDaParcela = {
  copiaECola: string;
  qrSvg: string;
  valorCentavos: number;
  txid: string;
  parcela: { numero: number; vencimento: string; cliente: string };
  recebedor: { nome: string; cidade: string; chaveMascarada: string };
};

/**
 * Pix copia e cola + QR da parcela, com a chave da PRÓPRIA empresa (066). O valor é o saldo em aberto.
 * O sistema não confirma o pagamento: depois de conferir o extrato, a baixa é registrada normalmente.
 */
export function PixParcela({ parcelaId, aoFechar }: { parcelaId: string; aoFechar: () => void }) {
  const [pix, setPix] = useState<PixDaParcela | null>(null);
  const [erro, setErro] = useState<{ mensagem: string; codigo?: string } | null>(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/financeiro/contas-receber/${encodeURIComponent(parcelaId)}/pix`)
      .then(async (resposta) => {
        const json = await resposta.json();
        if (!ativo) return;
        if (!json.ok) setErro({ mensagem: json.erro ?? 'Não foi possível gerar o Pix.', codigo: json.codigo });
        else setPix(json.data);
      })
      .catch(() => { if (ativo) setErro({ mensagem: 'Não foi possível gerar o Pix. Verifique a conexão e tente novamente.' }); });
    return () => { ativo = false; };
  }, [parcelaId]);

  useEffect(() => {
    const tecla = (evento: KeyboardEvent) => { if (evento.key === 'Escape') aoFechar(); };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [aoFechar]);

  async function copiar() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.copiaECola);
      setCopiado(true);
    } catch {
      setCopiado(false);
      setErro({ mensagem: 'Não foi possível copiar automaticamente. Selecione o código e copie manualmente.' });
    }
  }

  const imagem = pix ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pix.qrSvg)}` : '';
  return <div className={styles.dialogo} onMouseDown={(evento) => { if (evento.target === evento.currentTarget) aoFechar(); }}>
    <form aria-label="Pix da parcela" aria-busy={!pix && !erro} onSubmit={(evento) => { evento.preventDefault(); void copiar(); }}>
      <h2>Pix da parcela</h2>
      {!pix && !erro && <p>Gerando o Pix…</p>}
      {erro && <p className={styles.erro} role="alert">{erro.mensagem}{erro.codigo === 'PIX_NAO_CONFIGURADO' && <> <Link href="/admin/configuracoes/pix">Cadastrar chave Pix</Link></>}</p>}
      {pix && <>
        <p><strong>{reaisDe(pix.valorCentavos)}</strong> — parcela {pix.parcela.numero} de {pix.parcela.cliente}, vencimento {pix.parcela.vencimento}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG gerado no servidor a partir do BR Code; nada externo é carregado. */}
        <img src={imagem} alt="QR Code Pix da parcela" width={240} height={240} style={{ justifySelf: 'center', background: '#fff', borderRadius: 12, padding: 8 }} />
        <label>Pix copia e cola<textarea readOnly value={pix.copiaECola} rows={4} aria-label="Código Pix copia e cola" onFocus={(evento) => evento.currentTarget.select()} /></label>
        <p>Recebedor: <strong>{pix.recebedor.nome}</strong> ({pix.recebedor.cidade}) · chave {pix.recebedor.chaveMascarada}</p>
        <p>O valor cai direto na conta da empresa. Confira o extrato e registre o recebimento depois do pagamento — o sistema não confirma o Pix automaticamente.</p>
        {copiado && <p role="status">Código copiado.</p>}
      </>}
      <div className={styles.acoes}>
        <button className={styles.voltar} type="button" onClick={aoFechar}>Fechar</button>
        {pix && <AdminPrimaryButton type="submit">Copiar código</AdminPrimaryButton>}
      </div>
    </form>
  </div>;
}
