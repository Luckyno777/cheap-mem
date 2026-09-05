---
version: anydesign-1
name: cheap-mem viewer
source: src/viewer.mjs (cheap-mem) / src/ansicht.mjs (lucky-mem, same page in German)
captured_at: 2026-09-05
description: |
  A reading surface, not an app: warm off-white paper, hairline-ruled cards, and a
  single deep-teal accent that only ever marks "you are here" or "this is a type".
  The remembered text is set in a serif and the machinery — ids, timestamps, file
  paths, counts — in a monospace, so at a glance you can tell what a person wrote
  from what the system recorded. Nothing glows and nothing floats; what moves,
  moves a few pixels and is over in under a fifth of a second.

colors:
  paper: "#FAF9F6"
  raised: "#FFFFFF"
  sunk: "#F1EFE9"
  ink: "#1A1C1B"
  muted: "#4D5350"
  faint: "#696E6B"
  rule: "#E4E1D9"
  rule-soft: "#EFECE5"
  accent: "#1F5E70"
  accent-soft: "#E1EDF0"
  warn: "#8A5A12"
  warn-soft: "#F6EEDE"
  gone: "#8C3A34"
  gone-soft: "#F6E6E4"
  fresh: "#2C6B4F"

typography:
  brand:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 20px
    fontWeight: 700
    letterSpacing: -0.015em
  entry-title:
    fontFamily: "Charter, Bitstream Charter, Sitka Text, Cambria, Georgia, serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.35
  prose:
    fontFamily: "Charter, Bitstream Charter, Sitka Text, Cambria, Georgia, serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  ui:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 400
  chip-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: 11px
    fontWeight: 400
    letterSpacing: 0.03em

spacing:
  base: 4px
  scale: [2, 4, 5, 6, 8, 10, 12, 14, 16, 20, 22, 56, 80]

motion:
  # Flat on purpose: the body references these as `x`, and durations
  # are named by distance travelled, curves by direction.
  instant: 100ms
  quick: 160ms
  normal: 220ms
  slow: 320ms
  ease-standard: "cubic-bezier(.2,0,0,1)"
  ease-in: "cubic-bezier(.05,.7,.1,1)"
  ease-out: "cubic-bezier(.3,0,.8,.15)"
  ease-crisp: "cubic-bezier(.19,1,.22,1)"

rounded:
  xs: 3px
  sm: 6px
  md: 8px

components:
  entry-card:
    backgroundColor: "{colors.raised}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.md}"
    padding: 14px 16px
    typography: "{typography.entry-title}"
  chip:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.muted}"
    border: "1px solid {colors.rule-soft}"
    rounded: "{rounded.xs}"
    padding: 2px 7px
    typography: "{typography.chip-mono}"
  lens-tab:
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    padding: 9px 13px
    border: "2px solid transparent (bottom only)"
  search-field:
    backgroundColor: "{colors.raised}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    typography: "{typography.prose}"
  list-row:
    backgroundColor: "{colors.raised}"
    border: "1px solid {colors.rule-soft} (top only)"
    rounded: "0"
    padding: 13px 16px
    typography: "{typography.ui}"
  edge-triptych:
    backgroundColor: "{colors.raised}"
    border: "none"
    rounded: "0"
    padding: 0
    typography: "{typography.prose}"
  fact-row:
    backgroundColor: "{colors.raised}"
    border: "none"
    rounded: "0"
    padding: 13px 16px
    typography: "{typography.prose}"
  trail:
    backgroundColor: "transparent"
    border: "2px solid {colors.rule} (left only)"
    rounded: "0"
    padding: 0 0 0 14px
    typography: "{typography.ui}"
---

# Design Analysis — cheap-mem viewer

> Analysis generated with the `anydesign` skill.
> Date: 2026-09-05
> Analysis emphasis: design system + reconstruction

---

## Source

- **Source type**: combination — local source CSS + rendered screenshots
- **Path / URL**: `src/viewer.mjs` (the page is generated, not served); screenshots at
  1280×900 light, 1280×900 dark, 390×844 mobile, rendered against a real 521-entry memory
- **Capture method**: direct read of the inline `<style>` block (CSS custom properties are
  explicit tokens, so ✅ high confidence throughout) plus Playwright screenshots
- **Detected limitations**: none material. The page has no images, no fonts to fetch and no
  network of any kind, so whole categories of the framework simply do not apply.

---

## TL;DR

A document, not a dashboard. Warm paper (`paper`), hairline rules and a single deep-teal
accent (`accent`) reserved for "you are here" and "this is a type" — everything else is
neutral. The one real move is **the two-face split**: remembered content in a serif,
machine facts in a monospace, so a reader can tell a human sentence from a recorded id
without reading either. Motion is present but rationed: one gliding
underline, one scroll rail, one short lens fade — nothing that makes an entrance.
Actionable: the pre-audit `faint` grey was below WCAG AA on the page's *smallest*
text; it is now `#696E6B`.

---

## 1. Visual identity

### 1.1 Surface description

**Personality**: quiet, archival, unhurried, technical-but-warm, un-branded

**Mood**: opening a well-kept paper file, not opening a product

**Detectable stylistic references**: reading-first surfaces in the line of Instapaper or a
LaTeX-set report; explicitly *not* the Linear/Vercel dark-chrome idiom

**Information density**: balanced — dense metadata, generous prose measure (70ch lead)

**Implicit positioning**: someone auditing their own memory. The page's job is to be
trusted and then forgotten, not to be visited.

**Confidence**: ✅ high

### 1.2 Brand voice / Atmosphere

The design believes the reader is suspicious, and that this is correct. A memory system
asks you to accept that a machine wrote things down about you; the only honest answer is
to open the drawer and let you look. So the page is built as evidence rather than as a
product surface: every entry shows its source file and line number, retired entries stay
visible with a strike rather than disappearing, and a link whose other end is missing is
labelled dead instead of being quietly dropped. A prettier page that hid any of that
would be worth less, not more.

That belief also explains what is missing. There is no shadow system, no motion, no
gradient, no logo. Those signal *product*, and a product is something you have to trust a
vendor about. This page is a file you were handed — it works on a plane, it asks nothing
of the network, and when it is stale you delete it and generate another. The typography
carries the whole hierarchy precisely because nothing else is allowed to.

The single accent follows the same rule. `accent` is a muted teal, not a saturated brand
blue, and it appears only where it answers a question the reader actually has: which lens
am I in, and what kind of thing is this entry. It never decorates.

### 1.3 The "ONE brand thing"

- **The thing**: the **two-face split** — `{typography.prose}` (serif) for anything a
  person or a model *said*, `{typography.chip-mono}` (mono) for anything the system
  *recorded* (ids, timestamps, file:line, counts, topic keys).
- **Why it carries the brand**: it is the visual form of the product's core claim — that
  captured memory and machine bookkeeping are different substances and the second must
  never masquerade as the first. Flatten both to one sans and the page becomes a generic
  admin log; the trust argument goes with it.
- **How everything else supports it**: the palette is deliberately near-monochrome and the
  elevation system is one hairline deep, so the face change is the loudest signal on screen.
- **Where it appears (and where it deliberately doesn't)**: everywhere, without exception.
  A mono id never appears in serif; a remembered sentence never appears in mono — not even
  in the details table, where values are serif and keys are mono.

*Confidence*: ✅ high

---

## 2. Design System (tokens)

### 2.1 Colors — light

| Token | Hex | Role | Where it appears | Confidence |
|---|---|---|---|---|
| `paper` | `#FAF9F6` | Page ground | body, sticky header | ✅ high |
| `raised` | `#FFFFFF` | Card / list surface | entry cards, lists, inputs | ✅ high |
| `sunk` | `#F1EFE9` | Recessed fill | chips, bar track, retired cards, row hover | ✅ high |
| `ink` | `#1A1C1B` | Primary text | brand, entry titles, fact values | ✅ high |
| `muted` | `#4D5350` | Secondary text | prose, leads, subs, chips | ✅ high |
| `faint` | `#696E6B` | Tertiary text | meta line, counts, summary, dates | ✅ high |
| `rule` | `#E4E1D9` | Structural border | card and list outlines, trail spine | ✅ high |
| `rule-soft` | `#EFECE5` | Internal divider | row separators, table row tops | ✅ high |
| `accent` | `#1F5E70` | State + type | active tab, type chip, link kind, focus ring | ✅ high |
| `accent-soft` | `#E1EDF0` | Accent fill | type chip and link-kind backgrounds | ✅ high |
| `warn` | `#8A5A12` | Caution | contested, stale, contradicting links | ✅ high |
| `warn-soft` | `#F6EEDE` | Caution fill | warn chips, search highlight | ✅ high |
| `gone` | `#8C3A34` | Retired / broken | retired chips, dead edges | ✅ high |
| `gone-soft` | `#F6E6E4` | Retired fill | retired chip backgrounds | ✅ high |
| `fresh` | `#2C6B4F` | Confirmed-recent | declared, currently unused | ⚠️ medium |

### 2.1b Colors — dark

Same fourteen roles, redefined under both `prefers-color-scheme:dark` (guarded so an
explicit light choice wins) and `[data-theme="dark"]`.

| Token | Hex | Token | Hex |
|---|---|---|---|
| `paper` | `#141716` | `rule` | `#2C332F` |
| `raised` | `#1B1F1D` | `rule-soft` | `#242A27` |
| `sunk` | `#202523` | `accent` | `#7FC3D4` |
| `ink` | `#E7EAE6` | `accent-soft` | `#172C32` |
| `muted` | `#B4BBB5` | `warn` / `warn-soft` | `#D9A758` / `#2B2416` |
| `faint` | `#8B9089` | `gone` / `gone-soft` | `#E08C85` / `#2E1D1C` |

### 2.2 Typography

- **Detected families**: none — three *stacks*, no webfont, by design. ✅ high (read from source)
- **Suggested fallback**: already the fallback; the first name in each stack is a hint, not
  a dependency.

**Scale** (a seven-step ladder; half-pixel sizes were removed in this audit):

| Token | Size | Weight | Face | Use |
|---|---|---|---|---|
| `brand` | 20px | 700 | ui | page title |
| `entry-title` | 17px | 600 | prose | card headline |
| `prose` | 15px | 400 | prose | remembered text, fact values, search field |
| `ui` | 14px | 400 | ui | tabs, leads, list rows |
| `ui-sm` | 13px | 400 | ui | selects, tables, trail |
| `meta` | 12px | 400 | code | table keys, disclosure summaries |
| `chip-mono` | 11px | 400 | code | chips, counts, dates, link kinds |

**Notable tracking**: `-0.015em` on the brand, `-0.005em` on titles, `+0.03em` on mono
chips — mono is opened up, serif is tightened.

### 2.3 Spacing

- **Inferred base unit**: 2px, used in a loose ladder rather than a strict scale
- **Observable multiples**: 2, 4, 5, 6, 8, 10, 12, 14, 16, 20, 22, 56, 80
- **Consistency**: ⚠️ medium — deliberately hand-tuned per component rather than derived.
  Unlike the type scale, this was left as-is: the page has few enough components that a
  strict scale would buy nothing and would fight the optical alignment of chip rows.

### 2.4 Radii

- `xs`: 3px (chips, bar track, link kinds)
- `sm`: 6px (inputs, selects, focus rings)
- `md`: 8px (cards, lists)
- No pill radius anywhere — a deliberate omission (see Don'ts).

### 2.5 Elevation system

Two tiers only, and that is the point.

| Level | Name | Treatment | Use |
|---|---|---|---|
| 0 | Ground | `paper`, no border | page, sticky header |
| 1 | Hairline | `raised` + `1px solid {colors.rule}` + `{rounded.md}` | cards, lists |
| −1 | Sunk | `sunk` fill, dashed border when retired | chips, bar tracks, retired cards |

**There is no shadow in this design.** Not a subtle one, not on hover, not on the sticky
header. Depth is expressed as surface tone and a hairline. Do not add a third tier.
The one exception to flatness is temporal, not spatial: a card entering the viewport
finishes arriving (see 2.8), which reads as depth of field rather than elevation.

#### Decorative depth

None. No gradients, no patterns, no noise, no polarity-flipped bands. Omitting this is a
choice, not an oversight: a page that must render identically offline and print cleanly
has nothing to gain from atmosphere.

### 2.6 Borders

- Base: `1px solid {colors.rule}`; internal dividers `1px solid {colors.rule-soft}`
- Trail spine: `2px solid {colors.rule}`, left only
- Retired cards switch to `dashed` — the only border-style change in the system
- Focus: `2px solid {colors.accent}`, `outline-offset:2px` (inset by −1px on the search
  field so the ring replaces rather than surrounds its border)

### 2.8 Motion

Durations are named after the **distance travelled**, not by importance — a status dot
needs less than something crossing half the screen. Curves are split by **direction**,
because coming in and going out are not the same movement. The values sit inside both
Material 3's band (50–600ms) and Apple's (0.2–0.5s for interactive elements) without
copying either.

| Token | Value | Use |
|---|---|---|
| ``instant`` | 100ms | chip hover, disclosure arrow, summary colour |
| ``quick`` | 160ms | tab colour, row hover, the lens fade-in |
| ``normal`` | 220ms | the gliding tab underline |
| ``slow`` | 320ms | the citation bar filling |
| ``ease-standard`` | `cubic-bezier(.2,0,0,1)` | state changes |
| ``ease-in`` | `cubic-bezier(.05,.7,.1,1)` | something arriving |
| ``ease-out`` | `cubic-bezier(.3,0,.8,.15)` | something leaving |
| ``ease-crisp`` | `cubic-bezier(.19,1,.22,1)` | the tool-like snap, used on the underline |

**Reduced motion is its own token layer, not a patch.** Under
`prefers-reduced-motion: reduce` all four durations become `0ms`, so someone who asked
for calm gets *this* page instantly rather than a second, half-maintained one. The two
scroll-driven effects additionally opt out entirely.

There are exactly **four** moving things, and each answers a question:

1. **Reading rail** — a 2px accent line under the header, driven by
   `animation-timeline: scroll(root)`. At 500 entries "how far in am I?" is a real
   question and a phone scrollbar does not answer it. It only moves *because* you
   scroll; it never animates on its own.
2. **Gliding tab underline** — one element that moves between lenses instead of a border
   that jumps. It buys spatial continuity: you see where you came from. Positions are
   *measured* after layout, never computed, because tab widths depend on the font.
3. **Card approach** — `animation-timeline: view()` over `entry 0% → 18%`, from
   `opacity:.5` and 4px down. Deliberately not a reveal: exaggerated scroll entrances
   now read as a step back from speed, and a list you read daily must not make an
   entrance every time.
4. **Lens fade** — `document.startViewTransition`, 100ms out / 160ms in. Rows arrive
   **together**, never staggered one after another; staggering reads as a landing page
   and tires you out in daily use.

Two traps are load-bearing, not stylistic:

- **Every `animation-timeline` sits inside `@supports`.** With a fill mode and no
  support, the element stays permanently invisible — a page nobody can read is worse
  than a page without the effect.
- **The View Transition names only `#view` and silences `root`.** By default the API
  cross-fades the whole surface, which at 500 cards looks coarse and stutters.

Also here: `content-visibility:auto` with `contain-intrinsic-size:0 190px` on cards.
That is performance, not motion, but the intrinsic size is what stops the scrollbar
from jumping — omitting it is the standard mistake.

**Nothing is `infinite`.** WCAG 2.2.2 wants a stop past five seconds of continuous
motion, so there is no continuous motion at all: no spinner, no shimmer, no pulsing dot.
The data is already in the file — nothing ever loads, so there are no loading states to
animate.

### 2.7 Accessibility quick-check

See companion `viewer-design-a11y.md`. Summary after this audit:

- `ink` on `paper`: **16.27:1** — AAA ✅
- `muted` on `raised`: **7.87:1** — AAA ✅
- `faint` on `sunk` (the worst case): **4.52:1** — AA ✅
- `accent` on `accent-soft`: **6.07:1** — AA ✅

Before the audit, `faint` was `#8B8F8A` — **3.12:1 on paper, failing AA**, and it was
carrying the smallest text on the page (11–12px timestamps, counts, file paths). That was
the single measurable defect the analysis found.

---

## 3. Components Inventory

### 3.1 Generic components

#### entry-card
- **Variants**: default, `gone` (retired: `sunk` fill, dashed border, struck-through title)
- **Composition**: serif headline → chip row → optional serif prose body → optional
  `<details>` field table
- **Padding**: 14px 16px · **Radius**: `{rounded.md}` · **Confidence**: ✅ high

#### chip
- **Variants**: default, `type` (accent-soft), `gone`, `warn`, `tag` (transparent, ruled),
  `act` (hoverable)
- **Composition**: 11px mono, 2px 7px padding, `{rounded.xs}` · **Confidence**: ✅ high

#### lens-tab
- **Variants**: default, hover, `aria-selected="true"` (accent text + 2px accent underline
  + bold), focus-visible
- **Sizes**: 36px tall at desk, 44px below 620px · **Confidence**: ✅ high

#### search-field
- **Variants**: default, focus (2px inset accent ring, border goes transparent)
- **Behaviour**: filters as you type; `/` focuses it, `Esc` clears it · **Confidence**: ✅ high

#### list-row
- **Variants**: default, hover (`sunk`), focus-visible; rendered as a `<button>` when it
  navigates and a `<div>` when it does not
- **Composition**: sans heading → serif sub → chip row → optional trail · **Confidence**: ✅ high

### 3.2 Signature components

#### edge-triptych
- **What it is**: a link rendered as `source — kind — target`, a three-column grid with the
  relation as a small accent pill in the middle and both endpoints as truncated serif lines.
- **Why it's signature**: every other memory tool renders a link as a row of two ids. This
  renders the *sentence* the link makes, resolving both ids to what they actually say, and
  colours the middle pill `warn` when the relation is a contradiction. It is the only place
  the design lets a data value change a colour.
- **Composition**: `grid-template-columns:1fr auto 1fr`, endpoints ellipsised, collapses to
  one column below 620px.
- **Where it appears**: the Links lens only. In the timeline the same edge is flattened back
  into one resolved headline.
- **Confidence**: ✅ high

#### fact-row
- **What it is**: `key · value · since <date>` on one baseline-aligned grid line, mono key,
  serif value, faint mono date, with prior values stacked below in a `trail`.
- **Why it's signature**: it renders a *changing* fact as one line plus its own history,
  rather than as either a settings row or a log. The design refuses to let the current value
  stand alone — the history is always attached.
- **Composition**: `minmax(120px,auto) 1fr auto`, collapses to one column below 620px.
- **Where it appears**: the Facts lens; the trail form is reused under topics.
- **Confidence**: ✅ high

#### trail
- **What it is**: a left-ruled stack of earlier states, each prefixed by a faint mono date.
- **Why it's signature**: it is the same shape whether it holds a topic's earlier entries or
  a fact's earlier values, which is what makes "how it got here" read as one idea across
  lenses instead of two unrelated widgets.
- **Composition**: `border-left:2px solid {colors.rule}`, 14px inset, 5px row gap.
- **Confidence**: ✅ high

---

## 4. Layout & Composition

### 4.1 Grid & containers

- Container max-width **1080px**, 20px horizontal padding, centred
- Sticky opaque header (`z-index:20`) carrying brand, tools and lens tabs
- Lead paragraph capped at **70ch** — the only measure constraint, applied where it matters
- Vertical rhythm: 22px above content, 10px between cards, 80px tail padding

### 4.2 Composition patterns

- One page, five lenses over the same entries; the tab row is the only navigation
- Cards for the timeline; a single ruled list container for every other lens
- Search, memory switcher, type filter and the live/retired toggle sit in one wrapping row;
  the type filter and toggle hide themselves outside the timeline rather than going inert

### 4.3 Responsive behavior

#### Breakpoints

| Name | Width | Key changes |
|---|---|---|
| Mobile | < 620px | Edge triptych and fact row collapse to one column; tabs grow to 44px |
| Everything else | ≥ 620px | Full grids; container caps at 1080px, gutters absorb the rest |

One breakpoint. The tools row wraps by flexbox rather than by media query, and the tab row
scrolls horizontally instead of collapsing into a menu.

#### Touch targets

- Lens tabs: 36px at desk → **44px below 620px** (raised in this audit)
- Search field: 37px · selects: 33px — both below 44px and both flagged in Open Questions
- List rows: 45–70px ✅

#### Collapsing strategy

- **Tabs**: horizontal scroll, never a hamburger — the lens names are the information
- **Two-column components**: collapse to one column, keep their labels
- **Cards**: never collapse; they are already one column

### 4.4 Image behavior

No images of any kind — no logo, no icons, no illustrations. Every glyph on the page is
text. This is what allows the whole page to be one file with no network.

---

## 5. Reconstruction Notes

### Suggested stack

**Vanilla CSS in a single inline `<style>` block.** Not a preference — a constraint. The
page must be one self-contained file, so there is no build step, no CDN and no external
stylesheet. Custom properties do the work a framework would.

### Quick wins

- The fourteen colour tokens plus the three font stacks reproduce ~80% of the look
- Hairline + `{rounded.md}` + `raised` on `paper` is the entire card recipe

### Tricky bits

- The page is emitted from inside a JS template literal, so `${` in the page's own script
  must be escaped or the module will not parse
- Both theme mechanisms must stay in sync: the media query is guarded with
  `:root:not([data-theme="light"])` so an explicit choice always wins
- Every colour must be defined on bare `:root` first; a value that exists only inside the
  dark block leaves light mode unstyled

### Implicit states to define

- ~~Visible keyboard focus~~ — added in this audit for tabs, rows, selects and summaries
- Hover on cards: deliberately absent (cards are not clickable; rows are)
- Loading: not applicable, the data is already in the file — so no spinner and no
  skeleton, which is the right answer rather than a missing one
- Empty: defined per lens, each naming the command that would create the first entry

### Confidence map

| Layer | Confidence | Why |
|---|---|---|
| Identity | ✅ high | Source and rendered output both available |
| Colors | ✅ high | Read as CSS custom properties, not inferred |
| Typography | ✅ high | Stacks read from source |
| Spacing | ⚠️ medium | Hand-tuned, no derivable scale |
| Components | ✅ high | Full inventory from source |
| Layout | ✅ high | Three viewports rendered against real data |

---

## 6. Do's and Don'ts

### Do

- **Set anything a person or model said in `{typography.prose}`, and anything the system
  recorded in `{typography.chip-mono}`.** This split is the brand; it has no exceptions.
- **Reserve `accent` for state and type only** — the active lens, a type chip, a link kind,
  a focus ring. It is never decoration and never a background wash.
- **Express depth as `raised` on `paper` plus a `{colors.rule}` hairline.** One tier.
- **Keep every value legible against `sunk`, not just `paper`.** `sunk` is the worst-case
  background and it is where chips live.
- **Show broken and retired things, marked.** A dead edge gets a `gone` chip; a retired
  entry keeps its place with a strike. Never hide either.
- **Give every interactive element a `:focus-visible` ring in `accent`.** The page is meant
  to be driven from the keyboard.
- **Name empty states after the command that would fill them** (`mem log timeline --key …`).
- **Move only where movement answers a question**, and keep the distance small: 2–8px at
  100–220ms. Small steps, precise — not big jumps, fast.

### Don't

- **Don't add a webfont.** It breaks offline rendering and tells a font host, with a
  referrer, that someone is reading their memory. This is a security property, not a taste.
- **Don't add a shadow.** Not on cards, not on hover, not under the sticky header.
- **Don't introduce a fifth hue.** The system is neutral + `accent` + `warn` + `gone`
  (+ `fresh`, declared). A new accent flattens the meaning of the existing one.
- **Don't use pill radius.** The ladder is 3 / 6 / 8px; a pill would read as a product
  badge, which is exactly the register this page avoids.
- **Don't set headlines below `{typography.entry-title}` weight 600 or above it.** 700 is
  reserved for the brand and list headings; the weight ceiling is deliberate.
- **Don't add half-pixel font sizes.** The scale is 11 / 12 / 13 / 14 / 15 / 17 / 20 and
  half-steps round inconsistently across platforms.
- **Don't stagger a list.** Rows appear together in one short fade or not at all. Per-row
  entrances read as a landing page and tire you out on a page you open daily.
- **Don't add a fifth moving thing** without removing one. Two moving elements per view is
  the ceiling; the four here are already spread across different views.
- **Don't animate on every keystroke.** The search filters instantly; a cross-fade per
  character is exactly what makes a tool feel cheap.
- **Don't use a spring, an overshoot, or a scale past 100% on a state change.** Playful,
  not precise — high-end tools go 98 → 100, not 80 → 110. And never ship an
  `animation-timeline` outside `@supports`, or let anything run `infinite`.

---

## 7. Open Questions

- **`fresh` (`#2C6B4F`) is declared but never used.** Either wire it to the
   "confirmed recently" case on facts, or drop it. A token nothing references is a claim
   the design does not keep.
- **Search field (37px) and selects (33px) are below the 44px touch floor** on mobile. The
   tabs were raised in this audit; these two were left alone because growing them changes
   the header's proportions on desktop too. Worth a decision.
- **Dark-mode `rule` (`#2C332F`) on `paper` (`#141716`)** is roughly 1.4:1 — the card
   outlines are nearly invisible and the cards read as floating on tone alone. Deliberate or
   not, it is a different design from the light mode's ruled look.
- **No print stylesheet.** The design is otherwise print-shaped (paper ground, serif prose,
   no shadow). One `@media print` block would make `mem view > report.pdf` a real workflow.
- **`chip.act` (hoverable chip) is styled but not currently emitted** by any lens. Same
   question as `fresh`.

---

*The German port in `lucky-mem/src/ansicht.mjs` shares this system byte-for-byte apart from
UI strings and one class name (`kind.contradicts` → `kind.widerspricht`, since the relation
vocabulary is German there). Changes to the tokens must land in both.*
