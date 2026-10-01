'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import ImportarContratoAntigo from './ImportarContratoAntigo';
import ImportacaoReal from './ImportacaoReal';
import { importacaoHabilitada } from './cliente-importacao';
import styles from './importacao.module.css';

/**
 * Escolhe o modo da tela: real, quando o servidor confirma flag, sessão, papel, empresa e tabelas;
 * demonstração em qualquer outro caso (inclusive falha de rede). Nenhum arquivo é enviado para decidir.
 */
export default function ImportacaoContrato() {
  const [modo, setModo] = useState<'verificando' | 'real' | 'demo'>('verificando');
  useEffect(() => {
    let ativo = true;
    void importacaoHabilitada(adminFetch).then((ok) => { if (ativo) setModo(ok ? 'real' : 'demo'); }).catch(() => { if (ativo) setModo('demo'); });
    return () => { ativo = false; };
  }, []);
  if (modo === 'verificando') return <main className={styles.pagina} aria-busy="true"><p className={styles.texto}>Carregando…</p></main>;
  return modo === 'real' ? <ImportacaoReal /> : <ImportarContratoAntigo />;
}
