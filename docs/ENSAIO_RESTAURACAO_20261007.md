# Ensaio de restauração do backup de production — plano (07/10/2026)

**Não executado.** Nenhum recurso pago foi criado e nenhum dado foi baixado. A restauração nunca foi ensaiada; até lá,
nenhum documento deve afirmar que um backup "garante" rollback.

Fonte das capacidades: <https://render.com/docs/postgresql-backups> — PITR cria **uma instância nova** no estado de um
instante passado (janela de 3 dias no Hobby, 7 no Pro+, só em planos pagos); exportações lógicas são `.dir.tar.gz`,
ficam **7 dias** no Render e restauram com `pg_restore` (cliente na mesma versão do servidor — PostgreSQL 18).

## Opções

| | A. Exportação lógica → cluster local descartável | B. PITR → instância nova no Render |
|---|---|---|
| Custo | zero de infraestrutura | instância Postgres nova cobrada enquanto existir (plano a escolher; **custo novo, exige autorização**) |
| Dados reais fora do Render | **sim**, no disco do PC de Felipe | não |
| Prova | o arquivo de backup restaura e o schema/dados batem | o mecanismo de PITR funciona e o tempo de recuperação é conhecido |
| Recomendação | **primeiro** (prova o backup lógico já feito nas janelas) | depois, uma vez por trimestre |

## A. Roteiro (exportação lógica, local)

Pré-condições: autorização de Felipe para baixar a exportação (dados pessoais reais); disco com BitLocker ligado;
PostgreSQL 18 instalado (`C:\Program Files\PostgreSQL\18\bin`).

1. **Origem**: Render Dashboard → `dpg-dak750gae00c73fudmg0-a` → Recovery → exportação mais recente (ou nova
   exportação). Anotar ID, data e tamanho. Baixar (Felipe) para `D:\glass\KidMais Manager\ambientes-locais\ensaio-restauracao-<data>\`.
2. **Destino** (identidade explícita): cluster novo derivado de `scripts/pg-descartavel-061.cjs` com DIR
   `ambientes-locais\pg-descartavel-ensaio-restauracao`, porta **55540**, papel `kidmais_descartavel`, banco
   `kidmais_ensaio_restauracao`. O script recusa porta 5432/5433, `DATABASE_URL` herdada e o banco `kidmais_manager`.
   Antes de restaurar: `SELECT current_setting('cluster_name'), inet_server_port(), current_database()` tem de dar
   `kidmais_descartavel`, `55540`, `kidmais_ensaio_restauracao`.
3. **Restauração**: extrair o `.dir.tar.gz`; `pg_restore --list` (guardar a contagem de objetos);
   `pg_restore --no-owner --no-privileges --exit-on-error -d kidmais_ensaio_restauracao <dir>`; medir o tempo.
4. **Verificações** (somente leitura; sem exibir dados pessoais):
   - presença das migrations com as mesmas expressões do diagnóstico v7 (`diagnostico-leitura.cjs`);
   - contagens por tabela (`empresas`, `memberships`, `usuarios_administrativos`, `clientes`, `contratos`, `festas`,
     `pagamentos`, `auditoria`) comparadas às contagens do diagnóstico v7 da mesma data;
   - gatilhos de guarda presentes (empresas, memberships, importações);
   - `SELECT count(*) FROM pg_constraint WHERE NOT convalidated` = 0;
   - uma consulta de integridade por domínio (ex.: toda `membership` aponta para empresa e usuário existentes).
5. **Registro**: ID e data da exportação, tamanho, tempo de restauração, contagens origem × destino, divergências.
6. **Limpeza obrigatória**: encerrar e `limpar` o cluster; apagar o arquivo baixado e a pasta extraída; esvaziar a
   lixeira; registrar a exclusão. Dados reais não ficam no PC depois do ensaio.

## B. Roteiro (PITR, quando autorizado)

1. Render → banco → Recovery → Point-in-Time → instante = fim da última janela verificada → criar instância nova com
   nome `kidmais-production-ensaio-<data>` (**plano escolhido por Felipe; custo enquanto existir**).
2. Não ligar nenhum serviço a ela. Rodar as verificações do item A.4 por uma conexão de leitura.
3. Medir o tempo até "Available". Excluir a instância no mesmo dia e registrar o custo real.

## Riscos

- Exportação com mais de 7 dias já não existe no Render.
- Versão do `pg_restore` diferente da do servidor falha ou perde objetos.
- Dados pessoais reais em máquina local (LGPD): minimizar tempo, disco cifrado, apagar ao final.
