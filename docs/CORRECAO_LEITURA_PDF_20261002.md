# Correção da leitura real de PDF — 02/10/2026

O build Turbopack copiava pdf-worker.ts como asset, mantendo imports TypeScript e a dependência relativa pdf-texto.ts ausente. A execução do asset reproduziu falha de módulo. O upload convertia essa falha em revisão com todos os campos ausentes e reutilizava o resultado no reenvio.

O Worker agora usa um asset CommonJS autossuficiente, gerado dos fontes TypeScript por scripts/gerar-pdf-worker.cjs. O check estático verifica se ele está atualizado e executa o Worker copiado pelo build com PDF sintético. Isolamento, prazo, teto de memória e cancelamento permanecem. Falha do Worker produz erro explícito; uma extração sem campos é relida no reenvio. Uma revisão ativa vazia, sem campos revisados e sem decisão de cliente, pode receber a nova extração com controle de versão; revisões editadas e importações concluídas são preservadas.

As regras reconhecem a redação jurídica KidMais para data da festa, horário de início/término, aniversariante, pessoas, festa tipo, valor da festa contratada e pagamento à vista. Nome e CPF são associados à qualificação do contratante; CPF da contratada, taxas extras e multas não substituem esses campos. O texto original e as evidências continuam preservados, e nenhuma regra registra pagamentos como realizados.

Validação local do PDF original informado pelo usuário, sem upload, provedor externo ou banco: 2 páginas, 6128 caracteres, sem avisos de parser; 13 de 27 campos encontrados. Os demais permanecem sem preenchimento automático. Regressões usam contrato sintético sem dados pessoais reais. Sem migration ou operação direta em banco remoto.
