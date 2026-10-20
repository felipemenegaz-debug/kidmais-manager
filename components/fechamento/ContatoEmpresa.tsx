import type { ContatoPublico } from "@/lib/fechamentos/marca-publica";
import styles from "./FechamentoWizard.module.css";

/**
 * Contatos da empresa do endereço /b/<código>, vindos do cadastro aplicado dela. Sem contato cadastrado não
 * renderiza nada (nunca recorre ao contato da Kidmais). A Kidmais continua com os contatos fixos atuais.
 */
export default function ContatoEmpresa({ nome, contato, titulo }: { nome: string; contato: ContatoPublico | null; titulo?: string }) {
  if (!contato) return null;
  const itens = [
    contato.whatsapp && { rotulo: "WhatsApp", texto: contato.whatsapp.texto, url: contato.whatsapp.url, externo: true },
    contato.telefone && { rotulo: "Telefone", texto: contato.telefone.texto, url: contato.telefone.url, externo: false },
    contato.email && { rotulo: "E-mail", texto: contato.email, url: `mailto:${contato.email}`, externo: false },
    contato.instagram && { rotulo: "Instagram", texto: contato.instagram.texto, url: contato.instagram.url, externo: true },
    contato.site && { rotulo: "Site", texto: contato.site.texto, url: contato.site.url, externo: true },
  ].filter((item): item is { rotulo: string; texto: string; url: string; externo: boolean } => Boolean(item));
  if (!itens.length) return null;
  return (
    <div className={styles.contatoEmpresa} aria-label={`Contato de ${nome}`}>
      {titulo ? <strong>{titulo}</strong> : null}
      <ul>
        {itens.map((item) => (
          <li key={item.rotulo}>
            <span>{item.rotulo}</span>{" "}
            <a href={item.url} {...(item.externo ? { target: "_blank", rel: "noreferrer" } : {})}>{item.texto}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
