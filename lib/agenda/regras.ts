export const REGRAS_AGENDA_KIDMAIS = {
  festasSimultaneas: 1,
  maximoFestasPorDia: 2,
  maximoConvidados: 150,

  horariosBase: [
    { id: "almoco", inicio: "11:00", fim: "15:00" },
    { id: "noite", inicio: "17:00", fim: "21:00" },
  ],

  toleranciaInicioMinutos: 30,
  reservaTemporaria: false,

  restricoesComerciais: {
    pocket:
      "Disponível de segunda a quinta, sujeito à agenda operacional.",
    mini:
      "Disponível de segunda a quinta e sexta no primeiro período, sujeito à agenda operacional.",
    compacta:
      "Disponível conforme agenda, exceto sábado no segundo período.",
    pizza_party_scienza:
      "Sempre sob consulta; exige confirmação da equipe Kidmais/Scienza.",
  },

  descontoComercial: {
    automatico: {
      percentual: 15,
      dias: "segunda a quinta",
      pacotes: [
        "Festa Essencial",
        "Festa Completa",
        "Festa Premium",
        "Pizza Party Scienza",
      ],
      baseCalculo:
        "valor do pacote; adicionais são calculados separadamente",
    },
    personalizado:
      "Pode ser definido por pacote, data e horário no painel. O percentual manual substitui o desconto automático naquela combinação.",
  },

  prioridadeStatus: [
    "ocupacao_fisica_da_agenda",
    "override_manual_do_pacote",
    "regra_padrao_do_pacote",
  ],
} as const;
