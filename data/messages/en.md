# Passenger message templates — EN

Editable file (CDC §8.2). Three required variants: `affecte`, `provisoire`,
`escalade`. Each variant starts with a `subject:` line; the rest of the block is the
message body. Available placeholders: `{{pnr}}`, `{{hotel_name}}`,
`{{hotel_address}}`, `{{hotel_url}}`, `{{transfer_mode}}`, `{{max_transfer_min}}`,
`{{mode_reglement_texte}}`, `{{repas_texte}}`, `{{next_update_time}}`,
`{{station_name}}`, `{{contact_channel}}`. No other placeholder is resolved.

## affecte

subject: Your accommodation for tonight — booking {{pnr}}

Dear passenger,

Following the disruption of your flight at {{station_name}}, the airline has arranged your accommodation (booking {{pnr}}).

Hotel: {{hotel_name}}
Address: {{hotel_address}}
Hotel page: {{hotel_url}}

Transfer: {{transfer_mode}} (maximum expected duration: {{max_transfer_min}} min), arranged and paid for by the airline.
Room payment: {{mode_reglement_texte}}
Meals: {{repas_texte}}

Next update: {{next_update_time}}. For any question, please contact {{contact_channel}}.

Thank you for your patience, and our apologies for the inconvenience.

## provisoire

subject: Your accommodation is being confirmed — booking {{pnr}}

Dear passenger,

Following the disruption of your flight at {{station_name}}, the airline is currently arranging your accommodation (booking {{pnr}}).

Hotel under confirmation: {{hotel_name}}
Address: {{hotel_address}}
Hotel page: {{hotel_url}}

Planned transfer: {{transfer_mode}} (maximum expected duration: {{max_transfer_min}} min), arranged and paid for by the airline.
Room payment: {{mode_reglement_texte}}
Meals: {{repas_texte}}

This assignment remains provisional until confirmed. Next update: {{next_update_time}}. For any question, please contact {{contact_channel}}.

Thank you for your patience.

## escalade

subject: Your accommodation — please come to the desk (booking {{pnr}})

Dear passenger,

Following the disruption of your flight at {{station_name}}, your accommodation (booking {{pnr}}) is being handled with priority by our local team: please come to {{contact_channel}}, where a solution will be arranged for you directly.

Transfer: {{transfer_mode}} (maximum expected duration: {{max_transfer_min}} min), arranged and paid for by the airline once the hotel is confirmed.
Meals: {{repas_texte}}

Next update: {{next_update_time}}.

Thank you for your patience, and our apologies for the inconvenience.
