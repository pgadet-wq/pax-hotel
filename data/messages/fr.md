# Gabarits des messages passagers — FR

Fichier éditable (CDC §8.2). Quatre variantes obligatoires : `affecte`, `provisoire`,
`escalade`, `hors_plan`. Chaque variante commence par une ligne `sujet:` ; le reste du bloc est le
corps du message. Placeholders disponibles : `{{pnr}}`, `{{hotel_name}}`,
`{{hotel_address}}`, `{{hotel_url}}`, `{{transfer_mode}}`, `{{max_transfer_min}}`,
`{{mode_reglement_texte}}`, `{{repas_texte}}`, `{{next_update_time}}`,
`{{station_name}}`, `{{contact_channel}}`, `{{creneau_presentation}}`,
`{{transfert_texte}}`, `{{retour_texte}}`. Aucun autre placeholder n'est résolu.

`{{transfert_texte}}` porte le transport et le TEMPS DE TRAJET DÉCLARÉ de la couronne réellement
retenue pour ce dossier — là où `{{transfer_mode}}` / `{{max_transfer_min}}` ne connaissent que le
maximum global de la fiche escale, identique à 4 km et à 40 km. Il n'est jamais vide (repli sur la
fiche escale). Il dit toujours que la durée est DÉCLARÉE et non garantie : l'outil n'a aucun service
de routage et ne convertit jamais une distance en durée.

`{{creneau_presentation}}` et `{{retour_texte}}` sont les deux placeholders FACULTATIFS : ils rendent
une chaîne vide quand la donnée manque. Placez-les toujours SEULS sur leur paragraphe — le message
reste correct sans eux, sans accolade orpheline ni « undefined ». `{{retour_texte}}` porte le vol
suivant, l'heure limite de retour à l'aéroport et l'heure limite de départ de l'hôtel ; sans horaire
de correspondance exploitable il disparaît, AUCUNE heure n'est inventée.

Aucune variante n'annonce une réservation faite : l'outil ne réserve pas et la répartition
n'est confirmée qu'après validation humaine (C6, INV-1). Aucune variante n'annonce non plus un
horaire de transfert garanti : un temps de trajet déclaré n'est pas un horaire de bus.

## affecte

sujet: Votre hébergement de ce soir — dossier {{pnr}}

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, la compagnie prend en charge votre hébergement et vous a attribué une chambre dans son plan d'hébergement (dossier {{pnr}}). Aucune réservation n'est encore faite à votre nom : la confirmation auprès de l'hôtel vous sera annoncée au comptoir. Attendez cette annonce avant de vous rendre à l'hôtel.

Hôtel prévu : {{hotel_name}}
Adresse : {{hotel_address}}
Fiche de l'hôtel : {{hotel_url}}

Transfert : {{transfert_texte}}
Règlement de la chambre : {{mode_reglement_texte}}
Repas : {{repas_texte}}

{{retour_texte}}

{{creneau_presentation}}

Prochain point d'information : {{next_update_time}}. Pour toute question, adressez-vous à {{contact_channel}}.

Nous vous remercions de votre patience et vous prions de nous excuser pour ce contretemps.

## provisoire

sujet: Votre hébergement en cours de confirmation — dossier {{pnr}}

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, la compagnie organise actuellement votre hébergement (dossier {{pnr}}).

Hôtel pressenti (en cours de confirmation) : {{hotel_name}}
Adresse : {{hotel_address}}
Fiche de l'hôtel : {{hotel_url}}

Transfert prévu : {{transfert_texte}}
Règlement de la chambre : {{mode_reglement_texte}}
Repas : {{repas_texte}}

{{retour_texte}}

Cette affectation reste provisoire jusqu'à confirmation. Prochain point d'information : {{next_update_time}}. Pour toute question, adressez-vous à {{contact_channel}}.

Nous vous remercions de votre patience.

## escalade

sujet: Votre prise en charge — présentez-vous au comptoir (dossier {{pnr}})

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, votre hébergement (dossier {{pnr}}) est traité en priorité par nos équipes sur place : merci de vous présenter à {{contact_channel}}, où une solution vous sera proposée directement.

{{creneau_presentation}}

{{retour_texte}}

Transfert, une fois l'hôtel confirmé : {{transfert_texte}}
Repas : {{repas_texte}}

Prochain point d'information : {{next_update_time}}.

Nous vous remercions de votre patience et vous prions de nous excuser pour ce contretemps.

## hors_plan

sujet: Votre prise en charge individuelle — dossier {{pnr}}

Bonjour,

À la suite de l'immobilisation de votre vol à {{station_name}}, votre situation demande une prise en charge individuelle (dossier {{pnr}}).

Un agent de la compagnie vient vers vous : merci de RESTER À VOTRE PLACE, ou à l'endroit où vous vous trouvez, et de ne pas vous déplacer vers le comptoir.

Aucun hébergement hôtelier ne vous est proposé par ce message : votre solution est traitée personnellement avec vous, selon votre situation (assistance médicale, accompagnement, formalités d'entrée sur le territoire).

Prochain point d'information : {{next_update_time}}. En cas de besoin immédiat, signalez-vous à un agent de la compagnie près de vous.

Nous vous remercions de votre patience.
