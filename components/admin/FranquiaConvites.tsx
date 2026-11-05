'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';

export default function FranquiaConvites() {
  const [texto, setTexto] = useState('Carregando franquia…');
  useEffect(() => {
    let ativo = true;
    async function carregar() {
      try {
        const resposta = await adminFetch('/api/admin/creditos/franquia', { cache: 'no-store' });
        const corpo = await resposta.json();
        if (!resposta.ok || !corpo.ok) throw new Error(corpo.erro || 'Não foi possível consultar a franquia.');
        if (ativo) setTexto(`Franquia mensal de ${corpo.data.limite} gerações. Usadas neste mês: ${corpo.data.usado}.`);
      } catch (erro) {
        if (ativo) setTexto(erro instanceof Error ? erro.message : 'Não foi possível consultar a franquia.');
      }
    }
    void carregar();
    return () => { ativo = false; };
  }, []);
  return <p role="status">{texto}</p>;
}
