# GAM: verify existing work before continuing

This change addresses MBA-427 and extends the unmerged MBA-425 transport fix.
It does not modify existing GAM entities, frozen script sources, release packages,
dependencies or audit rules.

## What the reported errors establish

The reported 2,005 conflicts contain five `UNPARSABLE` errors from order capacity
checks and 2,000 generic line-item mismatch messages. The previous implementation
converted every capacity read failure into an order configuration conflict.
Capacity checks happen after line-item inspection, so those five errors do not
prove that the 2,000 line items were also false conflicts. Existing singleton
OR/AND targeting normalization already accepted the documented equivalent shape.
The exact production PQL parser cause and actual differing line-item fields
cannot be established from the old messages alone.

## Safe continuation

- An existing entity is reused only after its identity and relevant settings
  match the saved plan. Compatible completed work is counted as done.
- Only entities confirmed absent may be created. An unavailable or malformed
  GAM lookup is not evidence that an entity is absent.
- A failed lookup remains unverified. Dependencies that cannot be verified stay
  blocked instead of becoming configuration conflicts.
- Retrying verification keeps the same saved job and input. Starting the same
  active plan opens the existing job without automatically continuing writes.
- A true mismatch or duplicate name remains a conflict. The explanation identifies
  the settings that differ; existing objects are not overwritten or deleted.
- An unacknowledged create remains protected by its durable attempt. Check its
  outcome before continuing; verification never blindly repeats the create.

Order capacity uses a validated numeric order ID in the documented `orderId`
filter. A plan with no missing line items does not need a capacity query.
GAM page metadata must be valid before an empty response can mean no matches;
pagination must not skip rows when a response contains fewer than the requested
number of rows.

## Operator flow

Open the existing job under **API integracije → Line itemi → Nastavak i istorija
line itema**. Retry verification in that job after a read failure or corrected
configuration. Review done, missing, unverified and conflict counts separately.
If a create has an unknown outcome, use **Proveri ishod u GAM-u** before
**Nastavi posao**.

The initial review does not verify every creative association. Their state is
verified during the saved job's association steps; the UI must not label
unverified associations as done. The approved phase order and total plan remain
unchanged.

## Evidence boundaries

Regression tests use independently seeded GAM-shaped responses, including
string-valued IDs and numeric fields, singleton OR/AND targeting, populated
immediate-start dates and empty optional fields. They cover complete reruns with
zero creates, partial plans, storage restart, lost responses, true mismatches and
read failures. Browser checks use synthetic local responses on desktop and narrow
screens. These are not live GAM or hosted deployment evidence.

References: [GAM PQL](https://developers.google.com/ad-manager/api/pqlreference),
[v202608 LineItemService](https://developers.google.com/ad-manager/api/reference/v202608/LineItemService),
[v202608 LineItemPage](https://developers.google.com/ad-manager/api/reference/v202608/LineItemService.LineItemPage).
