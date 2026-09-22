---
name: kidmais-test-gate
description: Define e executa a validação local proporcional ao risco antes de concluir mudanças no Kidmais, incluindo regressão V1 e testes de isolamento quando aplicáveis.
---

# Gate de testes

1. Mapeie arquivos e comportamentos alterados para os scripts existentes em `package.json`; execute primeiro o menor teste específico pertinente.
2. Amplie para `npm run lint`, `npm run build` e `npm run check:v1:static` quando o risco justificar. Não execute scripts de integração, banco, clone ou produção sem ambiente isolado e autorização explícita.
3. Mudanças multi-tenant exigem casos autorizados e negativos cross-tenant/cross-estabelecimento; migrations exigem prechecks, postchecks e rollback exercitado em dados sintéticos.
4. Execute `git diff --check`, revise o diff completo e confirme que não há arquivos fora do escopo.
5. Relate comandos exatos, resultados, testes não executados com motivo, riscos residuais e rollback. Nunca declare sucesso para uma validação não executada.
