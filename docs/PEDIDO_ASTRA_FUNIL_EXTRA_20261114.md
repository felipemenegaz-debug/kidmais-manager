# Astra — revisão extra autorizada, somente P2-R2-1

Felipe autorizou explicitamente uma rodada extra restrita após a R2. Confira SOMENTE P2-R2-1 e regressões em conversão/atribuição no checkout D:/glass/KidMais Manager/kidmais-manager-funil-oportunidades-20261114. Só LOCAL; não corrija, não faça commit/push/PR nem operações reais.

Leia docs/PARECER_ASTRA_FUNIL_20261114_R2.md, docs/evidencias/funil-extra-20261114/VALIDACAO.md e a atualização do relatório/vault. Confira manifesto vigente docs/evidencias/funil-20261114/manifesto.json, manifesto anterior e sha256.json no pacote funil-extra-20261114. Diff completo inclui arquivos novos.

Conferir: vínculo/herança comuns em lib/marketing/conversao.ts, usados por contatos.ts e oportunidades/conversao.ts; origem/campanha do contato herdadas para cliente novo/recorrente sem sobrescrever origem própria; vínculo convertido/ação/responsável na mesma transação; repetir mesmo par retorna sucesso sem duplicação ou reescrita de marketing_atribuicoes; vínculo diferente e empresa/cliente inválidos continuam recusados. Relatório real metricas.ts atribui a negociação à campanha correta. Conferir testes antes/depois e compatibilidade do caminho manual com o modelo086.

O módulo marketing/conversao.ts não existia neste clone: o bloco de herança foi extraído de contatos.ts, mantendo uma implementação. O módulo homônimo da frente de simplificações deve ser reconciliado futuramente, sem importar essa frente nesta revisão.

Entregue todos os achados juntos, reprodução e arquivo/linha. Só P1/P2 reproduzíveis bloqueiam; P3 vira pendência. Não reabrir os demais achados encerrados ou migrations/rota de resumo. Se restar bloqueante, levar a Felipe; não iniciar outra rodada automaticamente. Registre docs/PARECER_ASTRA_FUNIL_EXTRA_20261114.md e atualize vault/relato.

Logs são do implementador. Se testar, use env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL; qualquer PG exclusivamente descartável no diretório E:/kidmais-pg-descartavel/funil-oportunidades, porta livre diferente5432/5433, com conector/receita do projeto e limpeza ao fim. Não ler .env reais. Dependências/build/cluster da implementação serão removidos; retomar exige npm ci. Nada autoriza publicação.
