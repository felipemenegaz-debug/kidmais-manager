---
name: kidmais-pr-review
description: Revisa diffs e PRs do Kidmais procurando bugs, regressões, falhas de segurança, violações multi-tenant e cobertura ausente sem modificar o código.
---

# Revisão de PR

Atue em modo read-only.

1. Leia o objetivo e os documentos oficiais relacionados; inspecione o diff e trace os fluxos afetados no código.
2. Priorize correção, regressão V1, autorização, isolamento por empresa/unidade, integridade financeira/contratual, concorrência e testes ausentes.
3. Para cada achado, cite arquivo/linha, cenário reproduzível, impacto e correção esperada; ordene por severidade.
4. Não registre preferência de estilo como bug. Declare explicitamente quando não houver achados e liste riscos ou lacunas de validação restantes.
5. Não edite arquivos nem faça commit, push, merge, deploy ou acesso a produção.
