import Image from "next/image";
import Link from "next/link";

/** Marca do produto para a equipe de qualquer empresa. A logo do buffet fica em MarcaPublica e nos documentos. */
export default function ProdutoBrand({ href }: { href: string }) {
  return (
    <Link href={href} aria-label="iA.Fest">
      <Image src="/assets/iafest/logotipo-painel.png" alt="iA.Fest" width={120} height={36} style={{ width: "auto", height: 36 }} priority />
    </Link>
  );
}
