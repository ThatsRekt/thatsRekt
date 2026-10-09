---
status: accepted
---

# Same-hack judgments run on Jev, with no code overlap gate and no fail-open

One comparison service makes every "same hack?" judgment: the **Duplicate** check on a **Report**, the same-hack check on an **Edit**, and **Incident** grouping. The service takes a configured list of models. Cutover runs one: Jev. No second model is named, and no combiner is chosen. Clef is not in the design. A strong `same` is a `same` verdict at or above Jev's threshold, set from the production eval set, not a default of 0.9. The answer is bound to a candidate we sent. A **Report** is a **Duplicate** on a strong `same` from Jev. An **Edit** goes through only if Jev says `same`. An **Incident** joins on a strong `same` from Jev. A missing answer never acts. The **Request** waits on the retry queue and stays **Checking**. Nothing is posted unchecked.

## Considered Options

- **A code overlap gate or pre-filter** (a shared address, a shared tx hash, or `attackedAt` within ±24 h or ±48 h) — rejected. **Guardians** of different kinds fill in different fields, so a strict match misses real duplicates and adds nothing Jev does not already weigh.
- **Failing open** (relay with `duplicateCheck: skipped` when Jev is down) — rejected. A missing answer would fast-track a **Report** past the **Duplicate** check, exactly when an incident is busiest.
- **2-of-3, or Jev plus Clef** — rejected (Bauti, 2026-10-09). No third model is named. Clef is not in the design. The service can take another model later; that needs a combiner decision, which is not made now.
- **Any-of-N while running more than one model** — not the cutover rule. With one model it collapses to Jev's answer.

## Consequences

- A Jev outage holds **Reports** and **Edits** in **Checking** until Jev answers. It shows as queue message age and Jev error, auth, credit, and balance alarms, not as a DLQ.
- One fooled answer can end a real hack as a final **Duplicate**, and can approve an **Edit** pivot. The measured threshold is the guard.
- Candidates are batched into one Jev request when the batch fits. Otherwise one call per candidate.
- Adding a model later is a config change plus a combiner decision, not a redesign of the service.
