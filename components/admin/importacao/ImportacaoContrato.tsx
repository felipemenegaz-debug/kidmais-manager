'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import ImportacaoReal from './ImportacaoReal';
import { verificarImportacao } from './cliente-importacao';
import styles from './importacao.module.css';

export default function ImportacaoContrato() {
  const [modo, setModo] = useState<'verificando' | 'real' | 'indisponivel'>('verificando');
  const [erro, setErro] = useState('');
  const [tentativa, setTentativa] = useState(0);
  useEffect(() => {
    let ativo = true;
    void verificarImportacao(adminFetch).then((r) => {
      if (!ativo) return;
      if (r.ok && r.dados.habilitado) setModo('real');
      else {
        setErro(r.ok ? 'A importação não está habilitada neste ambiente.' : r.mensagem);
        setModo('indisponivel');
      }
    }).catch(() => { if (ativo) { setErro('Não foi possível verificar a importação. Tente novamente.'); setModo('indisponivel'); } });
    return () => { ativo = false; };
  }, [tentativa]);
  if (modo === 'real') return <ImportacaoReal />;
  return <main className={styles.pagina} aria-busy={modo === 'verificando'}>
    <Link href="/admin/contratos">← Contratos</Link>
    <h1>Importar contrato antigo</h1>
    {modo === 'verificando' ? <p className={styles.texto}>Verificando disponibilidade…</p> : <>
      <p className={styles.texto} role="alert">{erro}</p>
      <button type="button" onClick={() => { setModo('verificando'); setTentativa((t) => t + 1); }}>Tentar novamente</button>
    </>}
  </main>;
}
