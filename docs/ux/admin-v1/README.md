# UX administrativo V1

Esta pasta é a fonte de verdade versionada do UX administrativo do Kidmais Manager. A documentação foi criada inicialmente sobre o commit `45f639a641071039e9a15efeff613b3ffdec13d3`, branch `review/v1-perfil-empresa`, e esse commit contém a implementação funcional do shell mobile tomada como referência. Ela existe para outro agente implementar o shell administrativo e o alinhamento visual do Perfil da Empresa sem a conversa que originou estes arquivos e sem reabrir o UX Pilot.

A implementação visual ainda não foi feita. Esta pasta não altera componentes, CSS, APIs, banco nem migrations.

## As três camadas

Estas três camadas valem para toda a pasta. Em conflito, a camada indicada prevalece no assunto dela.

1. **UX Pilot é referência visual.** Artboards, tokens e composição descritos em [referencias.md](referencias.md) e [tokens.md](tokens.md) dizem como a interface deve parecer. Eles não criam regra de negócio, rota, campo editável nem fluxo.
2. **A documentação funcional do Kidmais é a regra de produto.** Rascunho, publicação, conflito, auditoria, capacidades, asteriscos e o que cada módulo faz estão definidos pelo produto já implementado e pelos documentos funcionais do repositório. O mockup não substitui essa regra.
3. **Código, APIs e migrations existentes são a implementação técnica.** O comportamento real está nos arquivos citados em [navegacao.md](navegacao.md) e [perfil-empresa.md](perfil-empresa.md). Se o desenho e o código divergem, o código vigente descreve o que o sistema faz hoje. Mudar o visual não autoriza mudar a API.

Nenhuma funcionalidade inexistente deve ser criada só porque aparece no mockup.

Em caso de conflito, regras funcionais, segurança, RBAC, integridade de dados e contratos técnicos existentes prevalecem sobre o protótipo visual. O UX Pilot não autoriza por si só criação, remoção ou alteração de funcionalidades, APIs, persistência, permissões ou migrations.

## O que é referência

- Documento UX Pilot “Kidmais Manager - Perfil da Empresa (Admin)”, share [https://uxpilot.ai/s/9ee1d98314d8ec21f6820641038dfc7f](https://uxpilot.ai/s/9ee1d98314d8ec21f6820641038dfc7f), página File 2 `JHqdH8xAqY8SrhhWrISA`.
- Desktop aprovado: artboard “Kidmais - AdminPerfilEmpresa”, versão 3/3, ID `NyzMuM4gcmrvcqH7WxGB`, 1440×1658.
- Mobile: versão 2/2, ID `pJtifCp4ezXtllds7P9o`, 375×2465. Esta versão é a **base visual** mobile. Ela não está aprovada com o mesmo status do desktop 3/3.

Outras versões do mesmo documento não são referência. A lista curta está em [referencias.md](referencias.md).

## O que está fora de escopo

- Criar Dashboard, Solicitações, Pacotes (CRUD), Tabelas de Preços, Segurança, páginas “em breve” ou links para rotas que não existem.
- Renomear a aba “Em contratação” de Festas para Solicitações, ou fundir Segurança com Usuários e acessos.
- Implementar upload de logo, armazenamento de arquivo ou campo editável de código da empresa.
- Fazer contratos, PDFs ou marca lerem `perfil_empresas`.
- Nova migration. As migrations 026, 027 e 028 já estão no repositório e esta documentação não autoriza outra.
- Tratar o botão de menu do protótipo mobile como especificação. O comportamento funcional de navegação mobile continua o do commit `45f639a641071039e9a15efeff613b3ffdec13d3`.

## Como usar

1. Leia este índice e as três camadas.
2. Leia [referencias.md](referencias.md) antes de abrir o share, para não copiar uma versão descartada.
3. Use [tokens.md](tokens.md) para cor, tipo e medidas literais. Não converta classes Tailwind de escala em pixel oficial.
4. Use [navegacao.md](navegacao.md) para o menu pretendido e para a lista do que já tem rota.
5. Use [perfil-empresa.md](perfil-empresa.md) para o que a tela de perfil pode alinhar visualmente e o que deve permanecer igual.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| [README.md](README.md) | Como usar a pasta, as três camadas, referência e fora de escopo. |
| [referencias.md](referencias.md) | IDs oficiais, versões a ignorar e o que o HTML entrega. |
| [tokens.md](tokens.md) | Tokens literais e referências estruturais que não são pixel oficial. |
| [navegacao.md](navegacao.md) | Menu pretendido, rotas existentes e navegação mobile funcional. |
| [perfil-empresa.md](perfil-empresa.md) | Perfil da Empresa: visual, preservação funcional e checklist. |
