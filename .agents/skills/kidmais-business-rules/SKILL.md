---
name: kidmais-business-rules
description: Verifica regras de negócio oficiais do Kidmais antes de analisar ou alterar comportamento funcional, fluxos, contratos, pagamentos, festas, buffet, disponibilidade ou configurações.
---

# Regras de negócio Kidmais

1. Comece por `docs/README.md`; leia `docs/01-REGRAS-DE-NEGOCIO.md` e os documentos de módulo e ADRs relacionados ao escopo.
2. Identifique a regra vigente, o comportamento atual no código e qualquer diferença entre ambos.
3. Preserve invariantes do core e a compatibilidade da V1; trate parametrizações específicas da Kidmais como configuração, conforme `docs/arquitetura/ADR/ADR-003-CORE-VS-CONFIGURACAO.md`.
4. Implemente somente a mudança explicitamente aprovada. Não use documentação legada ou conversas para sobrepor `docs/`.
5. Informe regras afetadas, casos-limite, testes pertinentes e eventual necessidade de sincronização documental.
