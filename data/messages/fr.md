# Gabarits des messages passagers — FR

Fichier éditable (CDC §8.2). Trois variantes obligatoires : `affecte`, `provisoire`,
`escalade`. Chaque variante commence par une ligne `sujet:` ; le reste du bloc est le
corps du message. Placeholders disponibles : `{{pnr}}`, `{{hotel_name}}`,
`{{hotel_address}}`, `{{hotel_url}}`, `{{transfer_mode}}`, `{{max_transfer_min}}`,
`{{mode_reglement_texte}}`, `{{repas_texte}}`, `{{next_update_time}}`,
`{{station_name}}`, `{{contact_channel}}`. Aucun autre placeholder n'est résolu.

## affecte

sujet: Votre hébergement de ce soir — dossier {{pnr}}

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, la compagnie a organisé votre hébergement (dossier {{pnr}}).

Hôtel : {{hotel_name}}
Adresse : {{hotel_address}}
Fiche de l'hôtel : {{hotel_url}}

Transfert : {{transfer_mode}} (durée maximale prévue : {{max_transfer_min}} min), organisé et pris en charge par la compagnie.
Règlement de la chambre : {{mode_reglement_texte}}
Repas : {{repas_texte}}

Prochain point d'information : {{next_update_time}}. Pour toute question, adressez-vous à {{contact_channel}}.

Nous vous remercions de votre patience et vous prions de nous excuser pour ce contretemps.

## provisoire

sujet: Votre hébergement en cours de confirmation — dossier {{pnr}}

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, la compagnie organise actuellement votre hébergement (dossier {{pnr}}).

Hôtel pressenti (en cours de confirmation) : {{hotel_name}}
Adresse : {{hotel_address}}
Fiche de l'hôtel : {{hotel_url}}

Transfert prévu : {{transfer_mode}} (durée maximale prévue : {{max_transfer_min}} min), organisé et pris en charge par la compagnie.
Règlement de la chambre : {{mode_reglement_texte}}
Repas : {{repas_texte}}

Cette affectation reste provisoire jusqu'à confirmation. Prochain point d'information : {{next_update_time}}. Pour toute question, adressez-vous à {{contact_channel}}.

Nous vous remercions de votre patience.

## escalade

sujet: Votre prise en charge — présentez-vous au comptoir (dossier {{pnr}})

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, votre hébergement (dossier {{pnr}}) est traité en priorité par nos équipes sur place : merci de vous présenter à {{contact_channel}}, où une solution vous sera proposée directement.

Transfert : {{transfer_mode}} (durée maximale prévue : {{max_transfer_min}} min), organisé et pris en charge par la compagnie une fois l'hôtel confirmé.
Repas : {{repas_texte}}

Prochain point d'information : {{next_update_time}}.

Nous vous remercions de votre patience et vous prions de nous excuser pour ce contretemps.
