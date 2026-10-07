---
status: accepted
---

# Same-hack judgments run on N models in parallel, with no code overlap gate and no fail-open

One comparison service makes every "same hack?" judgment: the **Duplicate** check on a **Report**, the same-hack check on an **Edit**, and **Incident** grouping. It sends each pair (the new record vs one candidate) to N Jev-compatible decision APIs in parallel; N is config and starts at 2 (Jev plus a second such API). A strong `same` is a `same` verdict at or above that model's configured probability threshold (default 0.9) with a valid candidate pointer. A **Report** is a **Duplicate** on a strong `same` from any model; an **Edit** goes through only if every model says `same`; an **Incident** joins on a strong `same` from any model. A missing answer never acts: a **Report** or **Incident** is decided early only by a strong `same`, otherwise it waits for all N answers, and an **Edit** always waits for all N. During an outage the **Request** waits in the queue (visibility-timeout backoff, no DLQ) and ends **Rejected** (expired) only if its signed `deadline` passes. "Same hack" is the models' judgment alone: time, addresses, and tx hashes are prompt signals, not code checks, because **Guardians** of different kinds don't share those fields. Design record: [`intake-redesign.md`](../intake-redesign.md) D27, D36, D47, D48, D49, D85, D89.

## Considered Options

- **A code overlap gate or pre-filter** (a shared address, a shared tx hash, or `attackedAt` within ±24 h or ±48 h) — rejected. **Guardians** of different kinds fill in different fields, so a strict match misses real duplicates and adds nothing the models don't already weigh.
- **Failing open** (relay with `duplicateCheck: skipped` when the model is down) — rejected. A missing answer would fast-track a **Report** past the **Duplicate** check, exactly when an incident is busiest.
- **Acting on a partial set of answers** — rejected. With one model down, the every-model **Edit** rule would quietly become any-model.
- **A single model** — rejected. No second opinion where it matters (**Edit** pivots), and its outage stops intake with no fallback.

## Consequences

- A model outage holds **Reports** and **Edits** in **Checking** until it recovers; it shows as queue message age and per-model error, auth/credit, and balance alarms, not as a DLQ.
- Model calls cost pool size × N per **Report**, plus the same for grouping off the relay path.
- One prompt spec and injection suite serve every model; each model keeps its own threshold in config, so adding or swapping a model is a config and fixture change, not a redesign.
- One fooled model can still end a real hack as a final **Duplicate**; it cannot approve an **Edit** pivot alone.
