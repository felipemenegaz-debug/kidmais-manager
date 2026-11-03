'use client';
import { idMensagemErro, focarCampo, resumoErros, type ErroCampo } from '@/lib/ui/erros-formulario';
import css from './erros-formulario.module.css';

/** Mensagem logo abaixo do controle; o controle aponta para ela com `aria-describedby` (`propsCampo`). */
export function MensagemCampo({ id, mensagem }: { id: string; mensagem: string | null | undefined }) {
  if (!mensagem) return null;
  return <small id={idMensagemErro(id)} className={css.mensagem}>{mensagem}</small>;
}

/** Resumo dos erros (`role="alert"`), com link para cada campo. O link rola e foca o campo, sem mudar a URL. */
export function ResumoErros({ id, erros, titulo = 'Corrija para continuar:', abrir }: {
  id: string; erros: readonly ErroCampo[]; titulo?: string; abrir?: (campo: string) => void;
}) {
  if (!erros.length) return null;
  return <div id={id} className={css.resumo} role="alert" tabIndex={-1}>
    <p>{titulo}</p>
    <ul>{resumoErros(erros).map((e) => <li key={`${e.campo}:${e.mensagem}`}>
      {/* Pendência sem controle na tela (ex.: bloqueio devolvido pelo servidor): texto, sem link. */}
      {!e.campo ? e.mensagem : <a href={`#${e.campo}`} onClick={(ev) => {
        ev.preventDefault();
        abrir?.(e.campo);
        requestAnimationFrame(() => requestAnimationFrame(() => { focarCampo(e.campo); }));
      }}>{e.mensagem}</a>}
    </li>)}</ul>
  </div>;
}

/**
 * Erro que não é de campo (ex.: recusa do servidor): aviso fixo no rodapé, visível de qualquer ponto da página, com
 * `aria-live`. Fica até ser resolvido (a tela limpa a mensagem) ou fechado. A página reserva espaço para ele
 * (`scroll-padding-bottom`), então não cobre o controle em foco no celular nem com zoom.
 */
export function AvisoGlobal({ mensagem, onFechar }: { mensagem: string | null | undefined; onFechar(): void }) {
  return <div className={css.camadaAviso} aria-live="assertive" role="status">
    {mensagem && <div className={css.aviso}>
      <p>{mensagem}</p>
      <button type="button" onClick={onFechar} aria-label="Fechar aviso">Fechar</button>
    </div>}
  </div>;
}
