# Convites avulsos — implementação local, 24/10/2026

Base: `origin/staging` em `22d4ac30`. Branch `codex/convites-avulsos-20261024`.
Worktree: `D:/glass/KidMais Manager/kidmais-manager-convites-avulsos-20261024`.
Candidata preparada para staging. Não houve geração paga; produção fora do escopo. Veja os registros datados abaixo para distinguir preparação e aplicação.

## Comportamento entregue

- Menu **Operação → Convites**, logo após Festas, abre `/admin/convites`.
- **Meus convites** lista 12 cartões por página, com miniatura privada, nome, data, publicação e vínculo. Filtros Todos, Avulsos e Vinculados a festas.
- **Criar convite** oferece criar avulso ou buscar uma festa pelo aniversariante/data. Quando a festa já tem convite, abre o existente.
- Avulso nasce rascunho, sem festa, contrato ou cliente fictício. Não gera arte nem reserva créditos na criação. A mesma intenção UUID não cria duas vezes.
- O editor é o mesmo: dados compactos, arte, prompt, estilo, qualidade, galeria, publicação, link público, famílias e RSVP.
- `/admin/convites/[conviteId]` e o caminho anterior pela festa acessam a mesma linha. O fluxo do cliente pelo token permanece vinculado à festa/cliente contratante.
- Avulso pode publicar e receber confirmações; liberar **edição** à família exige primeiro vincular uma festa. O botão explica essa condição.
- Avulsos usam o saldo da empresa e os mesmos contadores/limites por convite (3/2 inicialmente), consentimento e proteção contra repetição paga. Nenhuma carteira é criada pelo recurso.

## Vinculação

Somente avulso → festa da mesma empresa, com capacidade FESTA_OPERAR e unidade comprovada. Festa cancelada/invalidada, ocupada por outro convite, revisão antiga ou geração RESERVADA/INCERTA recusam o vínculo.

Antes de confirmar, a tela permite manter os campos editados ou substituir nome, idade, data e horário pelos dados do contrato vigente. Local, endereço, mensagem, arte e visual são preservados. Os textos embutidos na imagem não são editados por esse vínculo.

Mantém id, token público, imagens, famílias, respostas, histórico e consumo. Não transfere nem devolve créditos. Volta a rascunho, incrementa revisão, revoga autorização de IA anterior e registra FESTA_VINCULADA. O buffet confere e republica; antes da próxima IA registra a autorização do responsável da festa. Não há desvinculação ou troca de festa já vinculada.

## Autorização e concorrência

- APIs exigem autenticação, política de origem/CSRF para POST, tenant comprovado, acesso comercial e capacidades de Festas.
- Listagem/miniatura/seleção de festas aplicam o escopo de unidade. IDs do navegador não determinam empresa.
- Ordem do vínculo: tenant → contrato → festa → convite, compatível com o editor existente. Festa tem índice UNIQUE; vínculo e evento são transacionais.
- Cliente não acessa avulso por token. Público só acessa publicado em empresa ativa; para vinculados mantém invalidação/cancelamento e versão vigente do contrato.
- RSVP confere vínculo e publicação novamente após travar convite. Mudança concorrente pede reabertura do link.
- Operador continua recebendo pendências dos avulsos, identificadas como “convite avulso”.

## Migration 099 — preparada, NÃO aplicada

`database/migrations/20261024_099_convites_avulsos.sql`:

1. Permite festa/cliente/versão nulos em `convites` e festa nula na evidência de autorização 088.
2. CHECK exige vínculo inteiramente vazio ou completo; avulso não recebe editor_hash nem unidade/cliente inventado.
3. Mantém UNIQUE de festa e FKs. Gatilho impede mudar empresa/id e impede trocar vínculo existente; valida contrato, empresa, cliente e unidade no vínculo novo.
4. Preserva a função imutável da evidência 088, alterando apenas a comparação para admitir festa nula.
5. Índice por empresa/atualização para a galeria.

### Roteiro antes da publicação (ainda não executado)

1. Revalidar a numeração 099 contra a branch de destino e outras frentes. Confirmar schema 073/084/088 e estado do motor de créditos; não alterar flags/créditos nesta entrega.
2. Mediante autorização específica, validar em PostgreSQL descartável: criação/publicação/RSVP de avulso; acesso de outra empresa/unidade recusado; vínculo conserva IDs, artes e consumo; unicidade em concorrência; consentimento com festa nula; todos os testes antigos de convites/088; rollback vazio passa e com avulso/evidência recusa.
3. Revisar código e migration, backup e janela; autorizar e aplicar 099 **antes** do deploy em staging. Smoke com dados sintéticos e sem geração paga. Comparar editor do cliente com o anterior.
4. Promover o mesmo delta após homologação e autorização próprias de produção. Esta tarefa não autoriza operações nesses ambientes.

`database/rollback/20261024_099_convites_avulsos_down.sql` recusa se houver avulso **ou evidência histórica de autorização avulsa**, inclusive de convite já vinculado. Não apaga dados. Depois do uso, preferir corrigir adiante; voltar ao código antigo deixa avulsos sem editor público compatível. Não prometer rollback irrestrito.

## Validação local

- Suíte unitária estática selecionada pela regressão V1: **3533/3533**, sem conexão a banco.
- Serviço e biblioteca: **87/87**, banco/provedor simulados. Inclui duplicação, cotas, idempotência paga, autorização, vínculo, rollback de falha de auditoria, permissões e RSVP avulso.
- Suítes de convites, navegação e fila do operador: **71/71**, incluindo inspeção estática da migration/rollback (não prova execução SQL).
- TypeScript, ESLint dos arquivos alterados e build: aprovados; conferência final registrada no resumo da entrega.
- Navegador sobre build real + API sintética em memória: galeria, filtro Avulsos, diálogo de criação, criar avulso, editor completo com estilo/qualidade, selecionar festa e importar os quatro campos, retorno à galeria, versão celular.
- A prévia local em `127.0.0.1:3185` é **demonstração**, não conecta banco nem OpenAI; alterações nela não persistem. Evidências em `.local-convites-avulsos/` (ignorado pelo Git).
- Integração PostgreSQL foi concluída na preparação de staging abaixo; homologação e publicação dependem dos registros seguintes. A política `docs/OPERACAO_AGENTES.md` exige autorização explícita para migrations/escritas SQL, inclusive em banco isolado.

## 24/10/2026 — preparação da publicação em staging

Felipe autorizou subir para staging. Revalidação: origin/staging e deploy LIVE dep-dbdphigm7kps73b8n0p0 permanecem em 22d4ac30; serviço srv-daif418ae00c73e8k2gg, branch staging, auto-deploy OFF, sem deploy em andamento. Fetch remoto conferido. Produção não consultada nem alterada.

Acrescentados precheck/postcheck da 099 e registro no inventário canônico. Verificador de migrations PASS (sem conexão; estado aplicado desconhecido) e 10/10 testes estáticos pertinentes PASS. Isso não prova execução SQL.

Autorização específica da migration solicitada, ainda pendente: PostgreSQL descartável para validar aplicação/rollback e staging para aplicar 099 antes do novo código. Sem essa confirmação não foi executado SQL, merge nem deploy. Prosseguir com teste real, revisão, PR/CI, precheck/schema e deploy, sem geração paga. A autorização de publicação em staging continua válida; não pedir novamente pelo mesmo deploy.

## 24/10/2026 — autorização e validação PostgreSQL

Felipe autorizou explicitamente teste isolado e migration em staging. PostgreSQL 18 descartável exclusivo, 127.0.0.1:55589, sem credenciais reais: receita completa até 098 seguida da suíte avulsos-099. PASS: precheck/aplicação/postcheck, preservação byte a byte do convite existente, criação avulsa, consentimento com festa nula, vínculo, invariantes, rollback vazio e recusa com evidência, aplicador real com disco temporário e repetição recusada. A transação de fixtures foi desfeita; o banco descartável não contém dados reais. Suíte registrada na receita para o estado 098.

Gates finais locais: regressão estática V1 completa PASS (testes, lint sem erros, TypeScript, build e leitura PDF); 96/96 serviço/biblioteca/aplicador/seleção. O inventário reconhece a 099 e seus checks, sem blockers. Dois avisos de lint preexistentes, sem erros.

Aplicador `scripts/migration-099-staging.cjs`: trava serviço/ambiente/host/banco; TLS conforme configuração existente; arquivos com SHA-256 fixado; pre/postcheck com hashes dos corpos das funções; marcador exclusivo durável antes do SQL; DDL e postcheck na mesma transação com locks e timeouts; preserva estrutura anterior e contagens, sem alterar linhas. COMMIT incerto pede conferência e nunca repete automaticamente. Não executa rollback nem aceita destino arbitrário.

Precheck remoto autorizado: banco kidmais_staging_1z91, rede privada, TLS false como configuração atual; AUSENTE_PRECHECK_PASS. Até este registro, nenhum DDL foi aplicado em staging. Ordem restante: CI da PR → aplicar 099 uma vez → merge → deploy web → health/UI sem geração paga. Não alterar flags, chaves, créditos ou cron.
