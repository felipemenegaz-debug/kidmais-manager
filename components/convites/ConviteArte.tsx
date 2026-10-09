'use client';
// Artes já são reencodadas no servidor; URLs privadas não devem passar pelo cache do otimizador Next.
/* eslint-disable @next/next/no-img-element */
import { type Conteudo } from '@/lib/convites/domain';
import { enquadramento, temaVisual, visualPadrao } from '@/lib/convites/visual';
import styles from './convites.module.css';
export function dataBonita(data: string) {
  return data ? new Date(`${data}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }) : 'Data da festa';
}
export default function ConviteArte({ conteudo: c, arte }: { conteudo: Conteudo; arte?: string }) {
  const tema = temaVisual(c), visual = c.visual ?? visualPadrao;
  const completa = visual.modo === 'completa' && !!arte;
  return <article className={styles.convite} style={{ background: tema.fundo, color: tema.tinta }} aria-label="Prévia do convite">
    <div className={completa ? styles.arteCompleta : styles.capa} style={{ color: tema.destaque }}>
      {arte ? <img src={arte} alt="Arte escolhida para o convite" style={{ objectFit: visual.ajuste === 'preencher' ? 'cover' : 'contain', objectPosition: `${visual.x}% ${visual.y}%` }} /> : <><span className={styles.orbita} /><span className={styles.simbolo}>{tema.simbolo}</span><span className={styles.estrela}>✦</span><span className={styles.estrela2}>✧</span><p>VOCÊ FAZ PARTE DESSA FESTA</p></>}
    </div>
    <div className={completa ? styles.somenteLeitor : styles.conviteTexto}><p className={styles.sobretitulo}>VAMOS COMEMORAR</p><h2>{c.nome || 'Nome do aniversariante'}</h2><p className={styles.idade}>{c.idade || 'Um dia muito especial'}</p><p className={styles.mensagem}>{c.mensagem}</p>
      <div className={styles.quando}><strong>{dataBonita(c.data)}</strong><span>às {c.horario || '00:00'}</span></div>
      <strong>{c.local || 'Local da festa'}</strong><p className={styles.endereco}>{c.endereco || 'Endereço do evento'}</p>
    </div>
  </article>;
}

/** Exportação local, sem chamada à IA: textos ficam independentes da arte. */
export async function baixarConvite(c: Conteudo, arte?: string) {
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1440;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const tema = temaVisual(c), visual = c.visual ?? visualPadrao;
  const completa = visual.modo === 'completa' && !!arte;
  ctx.fillStyle = tema.fundo; ctx.fillRect(0, 0, 1080, 1440);
  if (arte) {
    const img = new Image(); img.src = arte; await img.decode();
    const altura = completa ? 1440 : 540;
    const quadro = enquadramento(img.width, img.height, 1080, altura, visual);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 1080, altura); ctx.clip();
    ctx.drawImage(img, quadro.x, quadro.y, quadro.largura, quadro.altura); ctx.restore();
  } else {
    ctx.fillStyle = tema.destaque; ctx.globalAlpha = 0.13; ctx.beginPath(); ctx.arc(540, 225, 270, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = tema.destaque; ctx.font = '220px Georgia'; ctx.textAlign = 'center'; ctx.fillText(tema.simbolo, 540, 310);
    ctx.font = '32px Arial'; ctx.fillText('VOCÊ FAZ PARTE DESSA FESTA', 540, 460);
  }
  if (!completa) {
  ctx.textAlign = 'center'; ctx.fillStyle = tema.tinta;
  const texto = (value: string, y: number, size: number, bold = false) => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px Arial`; ctx.fillText(value, 540, y, 930);
  };
  texto('VAMOS COMEMORAR', 625, 24);
  ctx.font = '80px Georgia'; ctx.fillText(c.nome, 540, 715, 930);
  ctx.font = 'italic 40px Georgia'; ctx.fillText(c.idade, 540, 775, 930);
  const linhas = (value: string, y: number, size: number, maxLines: number) => {
    let rows: string[] = [];
    do {
      ctx.font = `${size}px Arial`; rows = [''];
      for (const word of value.split(/\s+/)) {
        const last = rows.length - 1, next = rows[last] ? `${rows[last]} ${word}` : word;
        if (ctx.measureText(next).width > 880 && rows[last]) rows.push(word); else rows[last] = next;
      }
      if (rows.length <= maxLines || size <= 14) break;
      size -= 1;
    } while (true);
    rows.forEach((line, n) => ctx.fillText(line, 540, y + n * (size + 10), 930));
  };
  linhas(c.mensagem, 850, 30, 4); texto(`${dataBonita(c.data)} · ${c.horario}`, 1090, 40, true);
  texto(c.local, 1200, 38, true); linhas(c.endereco, 1260, 27, 3);
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'convite.png'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
