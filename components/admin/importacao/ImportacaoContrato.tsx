'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import ImportarContratoAntigo from './ImportarContratoAntigo';
import ImportacaoReal from './ImportacaoReal';
import { verificarImportacao } from './cliente-importacao';
import styles from './importacao.module.css';

export default function ImportacaoContrato() {
  const [modo, setModo] = useState<'verificando' | 'real' | 'demo' | 'indisponivel'>('verificando');
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
  if (modo === 'demo') return <ImportarContratoAntigo />;
  if (modo === 'real') return <ImportacaoReal />;
  return <main className={styles.pagina} aria-busy={modo === 'verificando'}>
    <Link href="/admin/contratos">← Contratos</Link>
    <h1>Importar contrato antigo</h1>
    {modo === 'verificando' ? <p className={styles.texto}>Verificando disponibilidade…</p> : <>
      <p className={styles.texto} role="alert">{erro}</p>
      <p className={styles.texto}>Nenhum arquivo foi lido. Você pode conhecer o fluxo com dados fictícios.</p>
      <button type="button" className={styles.fantasma} onClick={() => { setModo('verificando'); setTentativa((t) => t + 1); }}>Tentar novamente</button>
      <button type="button" className={styles.primario} onClick={() => setModo('demo')}>Abrir demonstração com dados fictícios</button>
    </>}
  </main>;
}
