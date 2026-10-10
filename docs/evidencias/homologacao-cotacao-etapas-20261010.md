# Evidência — homologação local das etapas Buffet → Conclusão e do fluxo legado (10/10/2026)

Autorização de Felipe: E0–E6 do [pacote](../HOMOLOGACAO_COTACAO_ETAPAS_20261010.md) para a candidata
`59b08981f92fbfbd8c67fcf6cfe87a85f3034e88` (código `72b8659`); exatamente três envios de pedidos sintéticos no banco descartável
local; no celular, parar no Resumo; sem chamadas externas, banco real, Render, push ou deploy; preservar pastas; encerrar processos;
registrar o catálogo global do buffet e o cliente existente com OTP como pendências para produção.

## Pré-condições e passos

| Passo | Resultado |
|---|---|
| 0 | HEAD = candidata; só `docs/` após `72b8659`; árvore limpa; sem `.env*`/`PG*`/`ASSINATURA_*_DIAS`; portas livres; seed+servidor 24/24; tela/marca 17/17; seed `--plano` `confere: true`; servidor `--plano` `OK` (`consultaCepExterna: false`) |
| E0 | `.local-navegador/` → `.local-navegador-execucao-121d49c/` (renomeada, intacta) |
| E1 | `.local-navegador-pg-f5f2cb3db1144607bf8b1a78f8f743b5`: `CRIADO`, `INICIADO` em `127.0.0.1:55481`, `CONFERE`, bancos `[]` |
| E2 | seed `PASS` em `kidmais_navegador_etapas_20261010` (79/201, impressão conferida). Isolamento: Profissional Pocket 1500 / Doces+Salgados / “Painel sintético Profissional” / PIX 5/2 / “Cartão Profissional”; Premium 2300 / Massa do bolo / “Pula-pula sintético Premium” / 0/0 / “Cartão de crédito”. Legado: `kidmais` com 6 pacotes e 3 adicionais com preço. Nenhuma senha ou CPF na saída |
| E3 | servidor `127.0.0.1:3481`, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, `consultaCepExterna: false`, `AGENDA_PUBLICA_EMPRESA_ID` e `CONSULTA_CEP_EXTERNA` na lista fechada, fontes locais |
| E4 | checklist abaixo, sem sessão administrativa; dados digitados só em `localhost:3481` a partir do arquivo ignorado |
| E5 | `conferir --banco` `CONFERE`; pós-conferência só leitura `CONFERE` (abaixo) |
| E6 | servidor parado (3481 livre); cluster `PARADO` (55481 livre); `next-env.d.ts` regenerado restaurado; árvore limpa |

## Os três envios (desktop; PIX à vista)

| # | Endereço | Cliente | Resposta do servidor |
|---|---|---|---|
| 1 | `/b/nav-profissional` | A (novo) | `201`, `KM-1A27B974`, `AGUARDANDO_CONTRATO`, pacote 1500 + Painel 250 = 1750, PIX 5%, revisão `DISPENSADA` |
| 2 | `/b/nav-premium` | A (mesmo CPF → novo nesta empresa) | `201`, `KM-D2144A84`, `AGUARDANDO_CONTRATO`, 2300 + Pula-pula 400 = 2700, desconto 0% |
| 3 | `/fechamento` (legado) | B (novo) | `201`, `KM-01BA9A2A`, `AGUARDANDO_CONTRATO`, Festa Completa 6000 − 15% (`DIA_UTIL_15`) = 5100 + Arco 240 = 5340, PIX 10% |

Log do servidor: `POST /api/fechamentos` exatamente 3×; demais escritas/cálculos: `cotacao` (7), `consultar-cpf` (7), `consultar-cep`
(6, todas recusadas antes do `fetch` com “Consulta externa de CEP desligada neste ambiente”; as 6 menções a `viacep` no log são a
linha de código exibida junto ao erro, nenhuma requisição). Nenhum `iniciar-desafio`/OTP. `.local-navegador/emails` vazio.

## Checklist (D = desktop 1018 px; C = celular 375×812)

| # | D | C | Observação |
|---|---|---|---|
| E-P1 Pacote | PASS | PASS | só “Pocket sintético · R$ 1.500,00” |
| E-P2 Convidados | PASS | PASS | 25 → R$ 1.500,00 (faixa 20–30) |
| E-P3 Buffet | PASS | PASS | só Salgados (3) e Doces (2); sem Massa do bolo; sem campos Lembrancinha/Empratado/Bombom. **Itens do catálogo global** (ex.: “Bombom de mandioca com carne seca”) — pendência registrada |
| E-P4 Personalização | PASS | PASS | só “Painel sintético Profissional” R$ 250; sem tabela de mesas; “Observações para a equipe do buffet” |
| E-P5 Valor | PASS | PASS | 1500 + 250 = 1750; PIX 5%/2%; sem Cielo/−15% |
| E-P6 Seus dados | PASS | PASS | A → “Nenhum cadastro encontrado”; CEP → “Preencha o endereço manualmente”. No celular, A já existia (envio 1): “Cadastro encontrado… nenhuma informação pessoal é exibida”, só WhatsApp mascarado; “Enviar código” **não** acionado; seguiu com B → novo |
| E-P7 Resumo | PASS | PASS (parou) | dados e rodapé do Profissional |
| E-P8 Envio/conclusão | PASS | — | “Fale com Buffet Sintético Profissional” + contatos dele; sem Kidmais. A tela não exibe o protocolo (só a resposta da API) |
| E-R1 Pacote/Convidados | PASS | PASS | só “Pocket sintético · R$ 2.300,00” |
| E-R2 Buffet | PASS | PASS | só Massa do bolo (Branca/Preta/Mista); “Salgados/Doces” aparecem apenas como campos de texto livre genéricos |
| E-R3 Personalização | PASS | PASS | só “Pula-pula sintético Premium” R$ 400 |
| E-R4 Valor | PASS | PASS | 2300 + 400 = 2700; “Sem desconto automático”; “Cartão de crédito”; sem Cielo |
| E-R5 Seus dados | PASS | PASS | **mesmo CPF de A** → “Nenhum cadastro encontrado”, nada do Profissional revelado (no celular, com B) |
| E-R6 Resumo/envio | PASS | PASS (parou) | sem contato de nenhuma empresa (Premium não tem); conclusão idem |
| E-K1 Marca | PASS | PASS | logo Kidmais; rodapé “Kidmais • (61) 99340-5359 www.kidmaisfestas.com”. Bloco do PDF de pacotes ausente: só aparece quando o arquivo da tabela existe no servidor (`HEAD /api/fechamentos/tabela-pacotes` → 404 local) |
| E-K2 Pacote | PASS | PASS | 7 cartões com selos e horários; preços publicados R$ 4.000–6.500; Pizza Party “Sob consulta”; nenhum sintético |
| E-K3 Buffet/Personalização | PASS | PASS | composição da 022 (Completa: Salgados 8, Doces 16, Massa, Recheio, Lembrancinhas); adicionais da Kidmais com preço; “equipe Kidmais”. Sem adicional MESA com preço → texto de mesas não observado |
| E-K4 Valor | PASS | PASS | PIX 10%/3%, “Cartão é processado pela Cielo”, −15% de segunda a quinta |
| E-K5 Dados/Resumo/envio | PASS | PASS (parou) | B novo (D); A novo no legado (C); conclusão com “Falar com a Kidmais no WhatsApp” |
| E-I1–E-I3 APIs | PASS | — | pacotes: Profissional 1500, Premium 2300, legado 7 da Kidmais sem sintéticos; catálogo Premium só Massa do bolo, Profissional Salgados+Doces; adicionais Premium só Pula-pula; `nav-essencial` e `nav-inexistente` 404 idênticos (`COTACAO_PUBLICA_INDISPONIVEL`) |

Recursos só de `localhost:3481` em todas as páginas; nenhuma rolagem horizontal no celular.

## Pós-conferência (E5, `BEGIN READ ONLY`)

`resultado: CONFERE` — `nav-profissional`, `nav-premium`, `kidmais`: 1 pedido `AGUARDANDO_CONTRATO` e 1 cliente cada; nenhum pedido
de cliente em outras empresas; o CPF de A em exatamente 2 empresas (registros distintos); 0 festas `CONFIRMADO`.

## Diferenças em relação ao pacote (sem vazamento)

- Conclusão não mostra o protocolo `KM-…` na tela (ele vem na resposta da API).
- Bloco do PDF de pacotes da Kidmais depende do arquivo da tabela no servidor (ausente localmente).
- Texto de tamanho das mesas da Kidmais não observado: nenhum adicional MESA recebeu preço sintético.
- No celular, o Profissional usou o cliente B (A já existia após o envio 1); o caminho de cliente existente parou antes do código.

## Pendências registradas para produção

1. **Catálogo global do buffet** (`buffet_categorias`/`buffet_itens` sem `empresa_id`): nomes de itens compartilhados entre empresas.
2. **Cliente existente com OTP**: envio/confirmação do código, prova e consumo não exercitados localmente; validar em staging.

Registradas em [PACOTE_CONSOLIDADO_20261010.md](../PACOTE_CONSOLIDADO_20261010.md) (“Pendências fora deste pacote”).

## Encerramento

Preservados: `.local-concorrencia-pg-5611…`, `.local-concorrencia-pg-a9e1…`, `.local-navegador-pg-5d5b…`, `.local-navegador-pg-a7eb…`,
`.local-navegador-pg-52f7…`, `.local-navegador-pg-f5f2…` (com `seed-etapas.json` e `servidor-etapas.log`), `.local-navegador-execucao-936ef67/`,
`.local-navegador-execucao-121d49c/`, a nova `.local-navegador/` e as saídas dos testes de navegador da etapa anterior (`.local-festa/`,
`.local-ux/`). Nenhuma remoção (C6).
