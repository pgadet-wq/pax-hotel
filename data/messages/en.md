# Passenger message templates — EN

Editable file (CDC §8.2). Four required variants: `affecte`, `provisoire`,
`escalade`, `hors_plan`. Each variant starts with a `subject:` line; the rest of the block is the
message body. Available placeholders: `{{pnr}}`, `{{hotel_name}}`,
`{{hotel_address}}`, `{{hotel_url}}`, `{{transfer_mode}}`, `{{max_transfer_min}}`,
`{{mode_reglement_texte}}`, `{{repas_texte}}`, `{{next_update_time}}`,
`{{station_name}}`, `{{contact_channel}}`, `{{creneau_presentation}}`,
`{{transfert_texte}}`, `{{retour_texte}}`. No other placeholder is resolved.

`{{transfert_texte}}` carries the transport and the DECLARED travel time of the ring actually
retained for this file — where `{{transfer_mode}}` / `{{max_transfer_min}}` only know the global
maximum of the station sheet, identical at 4 km and at 40 km. It is never empty (it falls back to
the station sheet). It always states that the duration is DECLARED and not guaranteed: the tool has
no routing service and never converts a distance into a duration.

`{{creneau_presentation}}` and `{{retour_texte}}` are the two OPTIONAL placeholders: they render as
an empty string when the data is missing. Always keep them ALONE on their own paragraph — the
message stays correct without them, with no orphan brace and no "undefined". `{{retour_texte}}`
carries the onward flight, the deadline to be back at the airport and the deadline to leave the
hotel; with no usable connection time it disappears, NO time is invented.

No variant announces a completed booking: the tool does not book, and the allocation is only
confirmed after human validation (C6, INV-1). No variant announces a guaranteed transfer schedule
either: a declared travel time is not a bus timetable.

## affecte

subject: Your accommodation for tonight — booking {{pnr}}

Dear passenger,

Following the disruption of your flight at {{station_name}}, the airline is covering your accommodation and has allocated a room to you in its accommodation plan (file {{pnr}}). No reservation has been made in your name yet: confirmation with the hotel will be announced at the desk. Please wait for that announcement before going to the hotel.

Planned hotel: {{hotel_name}}
Address: {{hotel_address}}
Hotel page: {{hotel_url}}

Transfer: {{transfert_texte}}
Room payment: {{mode_reglement_texte}}
Meals: {{repas_texte}}

{{retour_texte}}

{{creneau_presentation}}

Next update: {{next_update_time}}. For any question, please contact {{contact_channel}}.

Thank you for your patience, and our apologies for the inconvenience.

## provisoire

subject: Your accommodation is being confirmed — booking {{pnr}}

Dear passenger,

Following the disruption of your flight at {{station_name}}, the airline is currently arranging your accommodation (booking {{pnr}}).

Hotel under confirmation: {{hotel_name}}
Address: {{hotel_address}}
Hotel page: {{hotel_url}}

Planned transfer: {{transfert_texte}}
Room payment: {{mode_reglement_texte}}
Meals: {{repas_texte}}

{{retour_texte}}

This assignment remains provisional until confirmed. Next update: {{next_update_time}}. For any question, please contact {{contact_channel}}.

Thank you for your patience.

## escalade

subject: Your accommodation — please come to the desk (booking {{pnr}})

Dear passenger,

Following the disruption of your flight at {{station_name}}, your accommodation (booking {{pnr}}) is being handled with priority by our local team: please come to {{contact_channel}}, where a solution will be arranged for you directly.

{{creneau_presentation}}

{{retour_texte}}

Transfer, once the hotel is confirmed: {{transfert_texte}}
Meals: {{repas_texte}}

Next update: {{next_update_time}}.

Thank you for your patience, and our apologies for the inconvenience.

## hors_plan

subject: Individual assistance — booking {{pnr}}

Hello,

Following the disruption of your flight at {{station_name}}, your situation requires individual assistance (booking {{pnr}}).

A company agent is coming to you: please STAY WHERE YOU ARE and do not make your way to the desk.

This message does not offer hotel accommodation: your case is being handled personally with you, according to your situation (medical assistance, escort, entry formalities).

Next update: {{next_update_time}}. If you need immediate help, please signal a company agent near you.

Thank you for your patience.
