# Hibana: per-item sync status symbol (design spec)

Audience: the coding agent that builds this feature.
Companion file: `hibana-sync-status-mockup.html` (open it in a browser; it shows every state, light and dark mode, English LTR and Farsi RTL, and a replay of the sync flow). The mockup is the visual reference. This file is the written rule set. If the two ever disagree, ask nothing: follow this file and note the difference in your final report.

All colour values, icon names and pixel sizes in the mockup are illustrative. Use Hibana's real design tokens and its real icon set. Never copy the mockup's hex values into the app.

---

## 1. Problem

Hibana's kanban board (desktop app and cloud web version on Cloudflare) syncs automatically and also has a manual "Sync" button. Today the user cannot tell whether one specific card they just wrote has reached the cloud. A global counter ("N unsynced changes") says something is unsynced, but not which card.

Goal: every kanban card shows a small symbol that says, at any moment, whether that card is safely in the cloud.

Product lens: experience and trust, not conversion. Success means the user stops wondering "did it save?" and stops pressing Sync "just in case".

Metric to watch later: manual Sync presses made when nothing was pending should go down.

## 2. Decision summary

- One small sync symbol on every kanban card, always visible.
- Four states: pending, syncing, synced, failed.
- Placed in the card's bottom meta row, at the inline-end side, next to the timestamp.
- Loudness follows importance: synced is almost invisible, pending is clear, failed is the loudest.
- Colour never carries the meaning alone. Every state has its own icon shape, and a text label on hover and keyboard focus.
- "Synced" means the server (Cloudflare) confirmed the write. It never means "request sent".

Rejected alternatives:
- Symbol only when something is wrong: a missing symbol is not proof of success, so the user still cannot tell "synced" from "not checked yet".
- Global counter only: does not say which card.

## 3. Current card anatomy (find the real component and class names in the code)

Each kanban card has, from top to bottom:
1. A coloured priority label band (for example "MEDIUM PRIORITY").
2. A bold title.
3. A muted description, cut off after about one line.
4. Sometimes a small "read more" chip.
5. A bottom meta row: a small grey timestamp (for example "25 Oct 2026 · 3:05 AM"), and on some cards a small extra chip (for example a pin or count chip).

Columns have a header with a name, a count pill, and two small icon buttons. The page header has a filled teal "Sync" button and a "Refresh" button.

There may be more than one kind of card (projects, tasks, ideas). Apply the same badge component to every kanban card type.

## 4. The four states

| State | When it applies | Icon shape (outline) | Colour direction | Visible text | Label on hover / focus (EN) | Label (FA, draft) |
|---|---|---|---|---|---|---|
| Pending | The latest edit is saved on this device but the server has not confirmed it yet. Also used while offline. | Cloud with an up arrow | Teal (the Sync button's token) | none | "Saved on this device" (offline: "Waiting for connection") | «فقط روی این دستگاه ذخیره شده» (offline: «منتظر اتصال») |
| Syncing | A sync request for this card is in flight and has taken longer than about 500 ms. | Two rotating arrows | Teal | none | "Syncing…" | «در حال همگام‌سازی…» |
| Synced | The server confirmed the latest edit. | Cloud with a check mark | Muted grey (the timestamp's token) | none | "Synced" | «همگام‌شده» |
| Failed | The sync gave up or the server returned a non-retryable error. | Cloud with an exclamation mark, inside a small pill | Danger / error token | The word "Retry" (FA: «تلاش دوباره») | "Couldn't sync. Retry" | «همگام‌سازی انجام نشد. تلاش دوباره» |

If the sync engine already has a conflict state, show it as Failed with its own hover text. Do not invent new conflict logic.

## 5. Placement

- Put the badge as the last child of the card's bottom meta row, at the inline-end side.
- Push it to that end with `margin-inline-start: auto`. Keep the timestamp and any existing chip at the inline-start side, in their current order.
- Use logical CSS properties only (`margin-inline-start`, `inset-inline-end`, `padding-inline`). In Farsi (RTL) the badge then moves to the left side automatically.
- Do not add a new row. Do not make any card taller. The badge must fit inside the current height of the meta row.
- Do not put the badge in the priority band, the column header, or next to the title.

Why this spot: the timestamp says when the item was written, so the sync state belongs next to it. A fixed end position makes one vertical scan line down every column, even when some cards have an extra chip.

## 6. Visual design

- Thin outline icons. Match the stroke weight and corner style of the existing Sync and Refresh icons in the page header. Use the icon set the app already uses.
- Icon size matches the timestamp's line height (suggested about 14 to 16 px). All four icons are the same size.
- Pending, syncing and synced are icon-only on the card.
- Failed is a small pill: icon plus the word "Retry". Suggested visible height about 22 px. Make it a real button.
- Extend the clickable area of the failed pill beyond its visible edge without changing layout (suggested at least about 32 px high on desktop, about 44 px on touch screens). A transparent pseudo-element or padding trick works.

## 7. Colour direction (strategic only)

- Do not use amber, yellow, orange or red for pending or syncing. Those hues already mean priority (Medium, High, Urgent). Reusing them would make users read sync state as priority.
- Pending and syncing use the existing teal token of the Sync button. Reason: pressing Sync is what clears these states.
- Synced uses the existing muted-text token of the timestamp.
- Failed uses the existing danger / error token. It is the one place red is allowed. The pill shape and the text label keep it distinct from the priority band.
- Do not invent new colour values. If a needed token does not exist, use the closest existing token and list the gap in the final report so the owner can run a colour review.
- Support light mode and every dark-mode variant.

## 8. Behaviour and timing

- Optimistic start: the moment the user edits a card, the card shows Pending. Do not wait for the network.
- Show Syncing only if a sync takes longer than about 500 ms. Faster syncs go straight from Pending to Synced with no spinner.
- When a card changes to Synced, play a short subtle confirmation (suggested about 300 ms, a small fade and scale of the check icon).
- If the operating system setting `prefers-reduced-motion` is on, switch states with no animation and do not rotate the Syncing icon.
- Pending stays until the server acknowledges the write. If a newer edit arrives while an older one is syncing, the card goes back to Pending.
- Offline: the card stays Pending with the label "Waiting for connection". When the connection returns, the normal flow resumes.
- Failed: show it only after the sync engine's own retry policy has given up (or the server returns a non-retryable error). Clicking the failed pill retries that one card only. While the retry runs, the card shows Syncing, then Synced or Failed again.
- Update only the cards whose state changed. Do not poll per card. Do not re-render the whole board.

## 9. Header Sync button

- Show a small count badge on the "Sync" button whenever one or more cards are Pending or Failed. Hide it when the count is zero.
- Rotate the Sync icon while any sync is running.
- The count comes from the same source as the per-card badges, so the button and the cards always agree.
- If the app already shows an "N unsynced changes" text somewhere visible, show the count in one place only. Never show it twice.
- Pressing Sync moves all Pending and Failed cards to Syncing together.

## 10. Item detail page

Show the same badge near the Save area of the item detail page, with the text "Synced" plus the time of the last confirmed sync (for example "Synced 2 min ago"). When Pending or Failed, show the matching label instead.

## 11. Text and languages

- Add all labels to the app's existing translation system, English and Farsi.
- Farsi strings in this file are drafts. Keep them as the starting point and let the owner adjust.
- Microcopy rules: sentence case, no exclamation marks, errors say what happened then what to do.

## 12. Accessibility

- Colour is never the only signal. Each state has its own icon shape and a text label.
- Give each badge an accessible name equal to its label. The label also appears on hover and on keyboard focus.
- The failed pill is a real `<button>` and is reachable by keyboard.
- Announce state changes politely (for example through an `aria-live="polite"` region) but only for changes the user caused or needs to act on: Synced after a user edit, and Failed. Do not announce every background sync.
- Keep the card's tab order sensible. Do not add a tab stop for the icon-only states if the label is already part of the card's accessible description. The mockup makes them focusable only to demonstrate the focus tooltip.
- Check contrast of the muted synced icon against the card background in light and dark mode. It may be quiet, but it must stay perceivable.

## 13. Right-to-left (Farsi)

- Use logical properties everywhere so the layout mirrors.
- The badge stays at the end of the meta row, which becomes the left side in RTL.
- Do not mirror the icons themselves unless the icon set mirrors them by default.

## 14. Engineering rules

- One source of truth. Derive each card's sync state from the existing offline queue and the existing server acknowledgement. Do not create a second state store that can disagree with the "N unsynced changes" logic.
- "Synced" only after server confirmation.
- Prefer no database schema change. If one is truly needed, make it a numbered, non-destructive migration, run it on the dev database first, and keep user-owned tables scoped by `user_id`.
- One reusable badge component used by every card type. Do not copy markup per card.
- Keep the board fast with 200 or more cards. Update only what changed.
- Stack hint (verify in the code, do not trust blindly): static HTML with htmx and Alpine.js, vanilla JS, plain CSS, Hono backend on Cloudflare Workers with D1. The desktop app may be a wrapper around the same code.

## 15. Out of scope

- New conflict-resolution logic.
- Changes to the sync engine's retry policy (only read it).
- A new colour palette (flag token gaps instead).
- Redesigning the cards, columns or header.

## 16. Acceptance checklist

1. Every kanban card type shows the badge in the meta row, at the inline-end side, without changing card height.
2. All four states are reachable and look as described (use a test switch or mock to force each state).
3. Edit a card online: Pending, then (Syncing only if slow), then Synced. The Synced confirmation plays unless reduced motion is on.
4. Edit a card offline: Pending with "Waiting for connection". Go online: it syncs and turns Synced.
5. Force a server error: Failed pill appears. Click it: Syncing, then Synced.
6. The Sync button's count equals the number of Pending plus Failed cards at all times, and hides at zero.
7. Colour is never the only signal. Labels appear on hover and keyboard focus. Screen reader reads the label.
8. Works in English LTR and Farsi RTL, in light mode and every dark mode, on desktop and a narrow mobile width.
9. A board with 200 or more cards shows no visible slowdown.
10. No new hex colours were added. Any token gap is listed in the final report.
11. Existing lint, type-check and tests pass. New tests cover the state transitions and the count rule.
