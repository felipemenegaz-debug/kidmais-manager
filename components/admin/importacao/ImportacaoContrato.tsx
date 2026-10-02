'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import ImportarContratoAntigo from './ImportarContratoAntigo';
import ImportacaoReal from './ImportacaoReal';
import { importacaoHabilitada } from './cliente-importacao';
import styles from './importacao.module.css';

/**
 * Escolhe o modo da tela: real, quando o servidor confirma flag, sessão, papel, empresa e tabelas;
 * indisponível nos demais casos; demonstração só por escolha explícita. Nenhum arquivo é enviado para decidir.
 */
export default function ImportacaoContrato() {
  const [modo, setModo] = useState<'verificando' | 'real' | 'demo' | 'indisponivel'>('verificando');
  const [erro, setErro] = useState('A importação está desabilitada para esta empresa.');
  useEffect(() => {
    let ativo = true;
    void importacaoHabilitada(adminFetch).then((ok) => { if (ativo) setModo(ok ? 'real' : 'indisponivel'); }).catch(() => { if (ativo) { setErro('Não foi possível verificar a importação. Tente novamente.'); setModo('indisponivel'); } });
    return () => { ativo = false; };
  }, []);
  if (modo === 'verificando') return <main className={styles.pagina} aria-busy="true"><p className={styles.texto}>Carregando…</p></main>;
  if (modo === 'indisponivel') return <main className={styles.pagina}><h1>Importar contrato antigo</h1><p role="alert">{erro}</p><p>Nenhum arquivo foi lido. Você pode conhecer o fluxo com dados fictícios.</p><button type="button" className={styles.fantasma} onClick={() => window.location.reload()}>Tentar novamente</button> <button type="button" className={styles.primario} onClick={() => setModo('demo')}>Abrir demonstração com dados fictícios</button></main>;
  return modo === 'real' ? <ImportacaoReal /> : <ImportarContratoAntigo />;
}
