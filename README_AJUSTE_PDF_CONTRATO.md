# Kidmais Manager - Ajuste visual do PDF de Contrato

Este patch é incremental sobre o Contrato - Bloco 2 já aplicado.

## O que muda

- inclui a logo oficial Kidmais no cabeçalho do PDF;
- substitui o layout textual simples por uma apresentação contratual profissional;
- adiciona cabeçalho institucional e linha de identidade visual Kidmais;
- organiza dados do contratante e do evento em campos alinhados;
- cria blocos visuais para buffet, valor final e aceite eletrônico;
- adiciona rodapé com paginação e identificador resumido de integridade;
- preserva PDF determinístico e SHA-256;
- não altera snapshot, regras de assinatura, migrations, Pagamentos ou Festa.

## Asset imutável do Template V1

`public/assets/contratos/kidmais-logo-template-v1.jpg` é uma cópia visual versionada da logo usada pelo PDF do Template V1.

Não substitua esse arquivo depois que existirem versões V1 assinadas. Alterar o asset mudaria os bytes do PDF regenerado e corretamente faria a checagem SHA-256 falhar. Uma futura identidade visual deve nascer em um novo template contratual.

## Validação após aplicar

```powershell
npx.cmd tsc -p tsconfig.json --noEmit
npm.cmd run test:contrato
npm.cmd run test:disponibilidade
```

Depois reinicie o servidor e abra novamente a rota administrativa do PDF.
