# PolkaCredit — Design System

A reference for rebuilding the PolkaCredit UI pixel-for-pixel, and extending it with new screens that feel native to the system. The direction is **quiet, monochrome, modern**: one surface, hairline structure, a single accent used sparingly, tabular numerics as a first-class citizen.

---

## 1. Principles

1. **One surface.** The page has a single ground color. "Cards" are defined by space and 1px hairlines, never by contrasting fills. If a region needs emphasis, add space around it — not a second panel color.
2. **Hairlines, not boxes.** Borders are always 1px. Prefer a top-border rule over a full box. Prefer two hairlines separated by generous padding over one rounded container.
3. **One accent, used once.** The accent color (mint by default) appears at most 2–3 times per screen: the live pip in the nav, the primary action, the active-tier indicator, the progress fill. Never decorate with it.
4. **Type carries the hierarchy.** Size, weight, and tight tracking do the structural work. Tinted backgrounds, shadows, and icons do not.
5. **Numbers are editorial.** Every figure is tabular. The hero score is clamped `18vw` with `-0.055em` tracking. Treat numerals as the primary graphic element.
6. **Monospace = metadata.** Addresses, block heights, reasons, labels, chain IDs — all Geist Mono, uppercase, `0.14em` tracked. Sans is for prose and figures.
7. **Motion is restraint.** 120–180ms eases, opacity and border-color changes, the spring on the hero number. No bounce, no translate, no glow.
8. **No AI slop.** No emoji, no stock iconography, no gradient-heavy hero, no "aurora" backgrounds, no left-border-accent alert boxes.

---

## 2. Tokens

### 2.1 Color (OKLCH)

All tokens live as CSS custom properties on `:root`. Two themes — `ink` (default, dark) and `paper` (light). The system is chromatically neutral; only the accent carries chroma.

```css
:root {
  /* ink (default) */
  --bg:        oklch(0.16 0.006 270);
  --bg-2:      oklch(0.19 0.006 270);   /* for hover fills only */
  --rule:      oklch(0.28 0.006 270);   /* primary hairline */
  --rule-soft: oklch(0.23 0.006 270);   /* interior list separator */
  --text:      oklch(0.96 0.004 85);
  --text-2:    oklch(0.75 0.006 270);   /* body copy */
  --mute:      oklch(0.55 0.006 270);   /* labels, metadata */
  --faint:     oklch(0.38 0.006 270);   /* disabled, dimmed */

  --accent:    oklch(0.84 0.14 160);    /* mint */
  --accent-fg: oklch(0.20 0.008 270);   /* text on accent */
  --warn:      oklch(0.80 0.13 80);     /* amber, used for pending state */
  --bad:       oklch(0.70 0.16 28);     /* coral, used for negative deltas */
}

[data-theme="paper"] {
  --bg:        oklch(0.985 0.003 85);
  --bg-2:      oklch(0.965 0.004 85);
  --rule:      oklch(0.88 0.006 85);
  --rule-soft: oklch(0.93 0.006 85);
  --text:      oklch(0.20 0.008 270);
  --text-2:    oklch(0.36 0.008 270);
  --mute:      oklch(0.52 0.008 270);
  --faint:     oklch(0.72 0.006 85);
}
```

**Accent variations** (all `oklch(L≈0.80, C≈0.14)` — same luminance so swaps don't break contrast):

| Token  | OKLCH                    | Use                    |
|--------|--------------------------|------------------------|
| mint   | `0.84 0.14 160`          | default                |
| amber  | `0.83 0.15 75`           | warm alternative       |
| blush  | `0.80 0.13 18`           | social / community     |
| iris   | `0.76 0.14 280`          | experimental / dev     |

**Rules of use.** Text is `--text`. Metadata is `--mute`. Body copy is `--text-2`. Borders are `--rule`. Accent is reserved for: the live-pip in the nav chip, the primary CTA, the active-tier indicator stripe, the score-scale fill, and positive deltas in the ledger. Nothing else.

### 2.2 Type

```css
--f-sans: "Inter Tight", "Inter", ui-sans-serif, system-ui, sans-serif;
--f-mono: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

- Global `font-feature-settings: "ss01", "cv11", "tnum" 1;`
- Global `font-variant-numeric: tabular-nums;`
- Global `letter-spacing: -0.005em;` (tight)
- Global `line-height: 1.45;`

**Type scale.** No modular scale — each role has an explicit size:

| Role                          | Size                | Weight | Tracking   | Notes            |
|-------------------------------|---------------------|--------|------------|------------------|
| Hero score numeral            | `clamp(120px, 18vw, 200px)` | 400 | `-0.055em` | `line-height: 0.85` |
| Connect headline              | `clamp(48px, 6.5vw, 88px)` | 400 | `-0.045em` | `line-height: 0.98` |
| Page title (h1)               | 40px                | 500    | `-0.035em` | `line-height: 1.05` |
| Micro-stat value              | 28px                | 450    | `-0.03em`  |                  |
| Tier amount                   | 28px                | 500    | `-0.03em`  |                  |
| Connect right-pane title      | 24px                | 500    | `-0.025em` |                  |
| Section kv value.big          | 20px                | 500    | `-0.02em`  |                  |
| Score band                    | 18px                | 500    | `-0.02em`  |                  |
| Body, section h2, nav brand   | 15px                | 500    | `-0.01em`  |                  |
| Button label                  | 13.5px              | 500    | `-0.005em` |                  |
| kv row, vouch addr, page lede | 13–14px             | 400    | inherit    |                  |
| Section header `num` prefix   | 11px mono           | 500    | `0.1em`    | `"01", "02", "∞"` |
| All metadata labels           | 10.5px mono         | 400    | `0.14em`   | `UPPERCASE`      |

### 2.3 Space, radius, motion

| Token         | Value                        |
|---------------|------------------------------|
| `--pad`       | 24px (18px when compact)     |
| `--gap`       | 28px (20px when compact)     |
| `--rad`       | 12px (used on the tier row, tweaks panel) |
| `--rad-sm`    | 6px (tabs, seg buttons)      |
| Pill radius   | 999px (buttons, chips)       |
| Page column   | `max-width: 940px`, `padding: 72px 40px 120px` |
| Section spacing | `margin-bottom: 56px`      |
| Section head → body | `margin-bottom: 20px`; `padding-bottom: 16px` + `border-bottom: 1px var(--rule)` |

**Motion.** `transition: ... 0.15s ease;` is the house default. The score hero uses a custom spring (`useSpring`, ~900ms, cubic ease-out). Score-scale fill uses `1s cubic-bezier(.2,.8,.2,1)`. No element translates more than 1px on hover. The connect wallet rows slide `padding-left: 0 → 6px` on hover (content only; no transform).

---

## 3. Layout

### 3.1 App chrome

```
┌────────────────────────────────────────────────────────┐
│ NAV (sticky, 1px bottom rule, blurred bg, z=40)        │
│  ◉ PolkaCredit   Overview Stake Vouch Activity   ⋯ ⋯   │
├────────────────────────────────────────────────────────┤
│                                                         │
│     MAIN (centered, max-width: 940px)                   │
│                                                         │
│     ┌── pageHead ─────────────────────────────────┐    │
│     │ H1 "Your credit"    tag     ·     live tag  │    │
│     └─────────────────────────────────────────────┘    │
│                                                         │
│     … sections, each separated by 56px margin …         │
│                                                         │
└────────────────────────────────────────────────────────┘
```

- Nav padding: `18px 40px`. Sticky with `backdrop-filter: saturate(140%) blur(10px)` over a 92%-opacity bg.
- Nav children: `brand` (mark + wordmark), `tabs` (buttons with 6px radius), `spacer`, then chips for chain + wallet.
- Page title row uses `display: flex; align-items: baseline; gap: 16px` with `h1` set `white-space: nowrap; flex-shrink: 0`.

### 3.2 Hero

```
┌─────────────────────────────────┬──────────────┐
│                                 │  SOULBOUND   │
│       612                       │  ● Strong    │
│            / 850                │  finalized   │
│                                 │  block 5,870 │
└─────────────────────────────────┴──────────────┘
───── 2px rule, scale fill ────────────────────────▮
0        200       400       600            850
```

- `grid-template-columns: 1fr auto`, `gap: 48px`, `align-items: end`.
- 40px `padding-bottom`, then a 1px bottom rule, then 40px `margin-bottom`.
- Score scale: a 2px horizontal rule with a full-width fill animated to the score percentage, a 2px-wide × 10px-tall marker at the current position, and 5-column mono labels beneath.

### 3.3 Micro-stats row

A 4-column grid bordered top + bottom with 1px hairlines and 1px vertical rules between cells. First cell loses `padding-left`, last loses `padding-right`, so cell content aligns with the main column edges. Each cell: mono label (10.5px, `0.14em`), then 28px figure with optional smaller unit suffix.

### 3.4 Proposal bar

A horizontal row with a 48×48 SVG ring on the left, meta text in the middle, primary/ghost button on the right. Bordered top + bottom with 1px rules. The ring arc uses `stroke="var(--text)"` normally and switches to `var(--accent)` when ready.

### 3.5 Sections

```
01   Section title                 right-aligned sub
────────────────────────────────────────────────
   body …
```

- Head: `num` (mono `01`/`02`/`03`/`∞`), `h2`, `sub` (auto margin-left), 16px padding-bottom, 1px border-bottom.
- Body: occasionally split into `.two` — `grid-template-columns: 1.4fr 1fr; gap: 48px` — left column holds controls, right holds explanatory prose + kv rows.

---

## 4. Components

### 4.1 Button

```
.btn                 default → background var(--text), color var(--bg), radius 999
.btn.primary         background var(--accent), color var(--accent-fg)
.btn.ghost           transparent, 1px var(--rule) border
.btn.sm              7px 14px / 12.5px
.btn.arrow::after    "→"
```

Hover: `background` shifts to `var(--text-2)` / mixed accent. Disabled: `opacity: 0.35`. No transforms.

### 4.2 Chip

```
.chip               6px 11px, pill, 1px rule, 11px mono, white-space: nowrap
.chip .pip          6px dot + 3px accent halo (inset box-shadow)
.chip.wallet        clickable, border hovers to text-2
```

### 4.3 Tier row

A single `display: grid; grid-template-columns: repeat(3, 1fr)` inside one rounded box (`--rad`). Columns share 1px vertical rules. Selected tier:

- Fills with `var(--bg-2)`.
- Gets a 2px top accent stripe via `::before`.
- Everything else unchanged — no halo, no glow.

Each tier cell renders: `.amt` (28px figure), `.lbl` (mono metadata), `.perks` (13px prose).

### 4.4 Field / input

```
.field            column, 8px gap, 16px bottom margin
.field label      mono 10.5 UPPERCASE, 0.14em, two-column (name · hint)
.input            row, 1px BOTTOM border only (no box), 8px vertical padding
.input:focus-within   border-color: var(--text)
.input input      no border, no outline, transparent bg, 14px mono
.input .prefix    mono 12 mute, right-margin 10px
```

The input is *underline-only*. No rounded box, no tint.

### 4.5 Key/value rows

```
.kv           space-between, 12px padding, top border var(--rule-soft), 13px
.kv .k        mute mono 11.5 (capitalized plain English labels allowed)
.kv .v        mono 13
.kv .v.big    sans 20 / 500 / -0.02em
```

### 4.6 Ledger table

- 5 columns: `52px 1fr 180px 100px 70px` — `Idx Event Source Block Δ`.
- Header row: 10.5px mono mute uppercase, 1px bottom rule.
- Rows: 14px vertical padding, 1px bottom `--rule-soft`, hover fills `--bg-2`.
- Δ column: right-aligned 14px mono. `.pos` → accent, `.neg` → `--bad`.

### 4.7 Vouch row (list item)

```
┌ 0x51Bf…6e7F   #7 · $1,000 committed       47d left   ● pending
│ ───────────────▮──────────────────────────────────────────  (2px rule, accent fill)
└
```

Top: baseline flex. Bottom: 2px rule with progress fill. Between rows: `rule-soft` hairline.

### 4.8 Tweaks panel

Fixed bottom-right, 260px wide, 1px rule, `--rad` 10px, `--bg-2` background, soft drop-shadow. Rows separated by `rule-soft`. Segmented control: a small pill of mono buttons; active button inverts to `var(--text)` background, `var(--bg)` fg. Switch: 30×17 pill, accent fill when on.

### 4.9 Connect screen

- `grid-template-columns: 1fr 1fr; min-height: 100vh;`
- Left: padded 56px, brand top, headline mid, `.by` footer (mono 11 mute). Headline is `clamp(48px,6.5vw,88px)`, single `<h1>` with one `<b>` wrapped in a subtle linear-gradient text clip (accent → text at 90%).
- Right: 56px padded, max-width 520px, centered justify. Header block → wallet list → nothing else.
- Wallet rows: bottom-border-only buttons, 18px vertical padding, hover turns text to accent and slides `padding-left: 0 → 6px`.

### 4.10 Status semantics (no invented severities)

| State         | Visual                                                |
|---------------|-------------------------------------------------------|
| neutral       | text var(--mute), no pip                              |
| live / ok     | accent pip + halo, otherwise mute text                |
| pending       | `--warn` pip only; text stays mute                    |
| negative      | `--bad` used only for negative delta figures          |
| disabled      | `opacity: 0.35`, `cursor: not-allowed`                |

Never introduce a fifth color. Never fill a region in warn/bad — only pips and figures.

---

## 5. Data model

The app is driven by a single `state` object representing one account's on-chain position. This is also the shape the backend-wired app would produce after resolving contract reads.

```ts
type State = {
  account: `0x${string}`;              // EVM address, serves as popId
  finalizedScore: number;              // 0..850
  finalizedAt: number;                 // block height of last finalization
  totalPoints: number;                 // current point balance (projected feeds score)
  eventCount: number;                  // ledger length
  stake: null | {
    amount: number;                    // in mUSD, base unit
    lockUntil: number;                 // block height
    isLocked: boolean;                 // any outstanding vouches
    tier: "1k" | "5k" | "10k";
  };
  stableBalance: number;
  vouches: Array<{
    id: number;
    vouchee: `0x${string}`;
    amount: number;
    openedAt: number;                  // block
    expiresAt: number;                 // block
    status: "pending" | "success" | "failed";
  }>;
  history: Array<{
    idx: number;
    block: number;
    reason:
      | "stake_deposit" | "vouch_given" | "vouch_received"
      | "opengov_vote" | "transfer_volume" | "loan_repaid"
      | "inactivity"   | "vouch_failure";
    src: string;                       // human-readable source detail
    delta: number;                     // signed
  }>;
  pending: null | {                    // score proposal in its challenge window
    id: number;
    score: number;
    totalPoints: number;
    sourceBlockHeight: number;         // block the indexer anchored to
    proposedAt: number;                // block the proposal landed
  };
  head: number;                        // current chain head
};
```

**Derived constants.**

- Challenge window = **7200 blocks** (~24h @ 6s).
- Stake lock = **262,800 blocks** (~6 months).
- Vouch window = same 262,800 blocks + 10-block grace.
- Vouchee success threshold = **+50 points** during the window.
- Min voucher score = **80**.

**Score curve** (points → score, clamped to [0, 850]):

| Points range  | Formula                       |
|---------------|-------------------------------|
| `p ≤ 0`       | `0`                           |
| `p ≤ 100`     | `p`                           |
| `p ≤ 300`     | `100 + (p - 100) × 1.5`       |
| `p ≤ 700`     | `400 + (p - 300) × 0.75`      |
| `p ≤ 1200`    | `700 + (p - 700) × 0.3`       |
| `p > 1200`    | `850`                         |

**Bands** (used by `band(score)`):

| Score    | Label      |
|----------|------------|
| ≥ 720    | Prime      |
| ≥ 580    | Strong     |
| ≥ 400    | Building   |
| ≥ 200    | Emerging   |
| > 0      | Nascent    |
| 0        | Unscored   |

**Reason labels** (`REASON_LABEL`): `stake_deposit → First-stake bonus`, `vouch_given → Vouch given · resolved`, `vouch_received → Vouch received · credited`, `opengov_vote → OpenGov vote attributed`, `transfer_volume → Transfer volume · band crossed`, `loan_repaid → Loan repaid`, `inactivity → Inactivity penalty`, `vouch_failure → Vouch failure · clawback`.

---

## 6. Screens

### 6.1 Connect

One split screen. Left communicates the product in ≤12 words, right lists wallets. Never auto-connect. Never add a third column.

### 6.2 Overview

Stacked sections in this order, each 56px apart:

1. **Hero** — score numeral + meta + score-scale.
2. **Micros** — 4-column row (Points · Projected · Events · Stake).
3. **Proposal bar** — appears only when `state.pending` is not null.
4. **Staking position** (section 01) — active view or tier picker.
5. **Vouch for a peer** (section 02) — form + explainer, with active-vouches list appended if any.
6. **Points ledger** (section 03) — full history.

### 6.3 Stake / Vouch / Activity tabs

Same shell, same typography, single section rendered in the main column. No sidebar, no card wrap — the tab simply scopes the content.

### 6.4 Empty / zero states

- No stake: show the tier picker as the primary surface.
- No vouches: render nothing (the list quietly absent — do not add empty-state art).
- No history: `"No point events yet. Stake to write the first entry."` centered 40px padding, mute 13.

### 6.5 Future screens (how to extend)

Any new screen must:

- Use `<Section num="NN" title="…" sub="…">` as the primary container.
- Respect the 940px column and 56px section rhythm.
- Use only the token palette — no ad-hoc color.
- Prefer kv rows + hairlines over new card patterns.
- Limit accent to 2 instances per fold.

Examples of natural extensions:

- **Disputes** — section 04; a list of `dispute-row`s similar to vouch-row, with a bond amount, claim type tag, and a progress bar for resolution window.
- **Identity linking** — section 05; an address-linked view with a hairline-bound sr25519 input and a "Request link" primary button.
- **Governance** — section 06; an OpenGov contribution feed that reuses ledger-row grid but with different columns (`Track · Referendum · Conviction · Attributed`).

---

## 7. Interactions

- **Score spring.** On persona or score change, animate the displayed numeral with `useSpring(target, 900)` (cubic ease-out).
- **Live tick.** `head` increments every 4s to simulate a new block; the `live · block N` tag updates in the page head.
- **Tweaks persistence.** Listen for `__activate_edit_mode` / `__deactivate_edit_mode` on `window`, post `__edit_mode_available` after mount, post `__edit_mode_set_keys` with the full tweak object whenever it changes.
- **Focus.** Inputs switch their bottom border to `var(--text)` on focus-within. Buttons do not change color on focus (use keyboard focus ring from UA).
- **Hover.** Tabs → `color: var(--text)`. Ledger rows → `background: var(--bg-2)`. Chips → border-color hovers to `var(--text-2)`. Wallet rows → color-to-accent + `padding-left: 6px`.

---

## 8. Tweak surface

The in-design `Tweaks` panel exposes:

| Key              | Values                                       | Effect                                  |
|------------------|----------------------------------------------|-----------------------------------------|
| `theme`          | `ink` / `paper`                              | Sets `data-theme` on `<html>`           |
| `accent`         | `mint` / `amber` / `blush` / `iris`          | Sets `data-accent` on `<html>`          |
| `density`        | `regular` / `compact`                        | Shrinks `--pad`, `--gap`                |
| `mockStateIndex` | `0` / `1` / `2` / `3`                        | Unscored / Emerging / Strong / Prime    |
| `showPending`    | `true` / `false`                             | Toggles the proposal bar                |

Tweaks are not decorative: every variant must remain a valid production state.

---

## 9. Do / Don't

| Do                                                                 | Don't                                                              |
|--------------------------------------------------------------------|--------------------------------------------------------------------|
| Define regions with hairlines + space                              | Wrap cards in rounded boxes with tinted fills                      |
| Use the accent ≤ 3× per screen                                     | Use the accent for decorative flourish                             |
| Pair a figure with a mono metadata label                           | Label figures with sans at the same size                           |
| Let long form breathe (56px between sections)                      | Cram two sections into a single card                               |
| Keep addresses and block heights in mono                           | Mix sans into mono-only contexts                                   |
| Use `white-space: nowrap` on chips and page h1                     | Let headline text reflow under viewport pressure                   |
| Add a new section via `<Section>` with a mono num prefix           | Invent a new card component per screen                             |
| Stick to the 940px reading column                                  | Push content edge-to-edge past 1040px                              |
| Use `clamp()` for hero figures so they scale                       | Hard-code hero sizes in px for every breakpoint                    |
| Keep motion ≤ 180ms and within opacity / border-color              | Spring, bounce, or translate more than 1px                         |

---

## 10. File map

```
PolkaCredit.html       entrypoint, Google Font preconnects, TWEAK_DEFAULTS block
styles.css             all tokens, all component styles
app.jsx                single React file — helpers, personas, all components, App
```

Keep it this flat. If a new screen grows past ~200 lines, split only the screen, not the design system.
