# Prompt: build the "Rolling Date Slicer" Power BI custom visual

You are building a Power BI custom visual in TypeScript with `powerbi-visuals-tools` (pbiviz) 7.x, `powerbi-visuals-api` 5.11, `powerbi-visuals-utils-formattingmodel` 6.x, `powerbi-models` and `powerbi-visuals-utils-interactivityutils`. Plain DOM only (no React, no D3), LESS for styles. All UI text is English, and all dates use the Gregorian calendar.

## 1. Goal

A date slicer that looks and behaves like the built-in Power BI slicer, with one extra feature: a **rolling default range**.

- **Author sets it once:** the report author configures a rule such as "Last 30 days".
- **Recomputed on every open:** each time the report opens, the rule is recalculated for **today's date**, and the filter is applied.
- **Midnight rollover:** if the report stays open past midnight, the range rolls to the new day.
- **"Save user changes" Off (default):** a user may change the dates, and the next time the report opens, today's default comes back. Nobody has to reset it by hand.
- **"Save user changes" On:** a user's own selection is kept. A selection that is still the default keeps rolling every day.
- **Why:** built-in Between/List/Dropdown slicers freeze the saved dates. The built-in relative date slicer rolls, but it can't show a slider, list or tree. This visual does both.

## 2. Project setup

- **Scaffold:** `pbiviz new rollingDateSlicer`, with display name "Rolling Date Slicer".
- **tsconfig:** add `"types": []` so Node typings don't clash with TS 5.x.
- **capabilities.json:**
  - **Data role:** one role `date` (Grouping, display name "Date"), with `dataViewMappings` `categorical.categories.for.in: "date"` and `dataReductionAlgorithm.top.count: 30000`.
  - **`"suppressDefaultTitle": true`:** stops Power BI from showing the field name when our header is off.
  - **Objects:**
    - `general.filter` (type `{ "filter": {} }`);
    - `state` (properties not shown in the pane: `mode`, `relType`, `relCount`, `relUnit`, `relIncludeToday`, used to save a user's relative rule);
    - one object per format card in section 7.
  - **Property names:** they must match the settings model exactly, and `fontFamily` / `fontSize` use the formatting types.
  - **Do not** add `requiredTypes`, because the schema rejects it.
- **Icon:** `assets/icon.png` (20×20), a slicer/filter shape with a small calendar.

## 3. Source layout (keep logic pure and unit-testable)

```
src/dateUtils.ts   pure date math on "day numbers"
src/decide.ts      pure decision: what to do with the incoming filter on each update
src/tree.ts        build Year›(Quarter)›Month›Day and ISO Year›Week›Day trees
src/settings.ts    formatting model (cards, slices, visibility rules)
src/visual.ts      Visual class: update, filter read/write, rendering
style/visual.less
```

### 3.1 dateUtils.ts

- **Day numbers:** work only in **day numbers** (dn = days since 1970-01-01 for a *calendar date*, built with `Date.UTC`). This avoids DST and time-zone off-by-one errors.
- **Helpers:** `dnFromYMD`, `ymdFromDn`, `todayDn()` (the viewer's **local** date), `dow`, `daysInMonth`, `addMonths` (clamp day: Jan 31 + 1 month = Feb 28/29), `addUnits`, `startOfUnit(dn, unit, weekStart)`.
- **`RangeSpec`:** `{ type: "last"|"lastCalendar"|"this"|"toDate"|"next", count, unit: "day"|"week"|"month"|"quarter"|"year", includeToday, weekStart }`.
- **`computeRange(spec, today) → {start, end}`** (inclusive):
  - `last`: end = today (or yesterday if !includeToday); start = addUnits(end, unit, -n) + 1. Example: Last 30 days on 2026-11-19 = 2026-10-21 … 2026-11-19.
  - `lastCalendar`: the n complete units before the current one. With includeToday, it is the n-1 previous units plus the current unit up to today.
  - `this`: the whole current unit, including future days.
  - `toDate`: start of the current unit up to today (yesterday if !includeToday).
  - `next`: n units starting today (or tomorrow).
- **`describeSpec`:** for example "Last 30 days".
- **`dnFromDataValue(v)`:** Date → local Y-M-D.
- **`isoFromDn(dn, endOfDay)`:** gives `"YYYY-MM-DDT00:00:00.000Z"` or `"…T23:59:59.999Z"`. Write the calendar date with no UTC shift.
- **`dnFromIso`:** reads the Y-M-D part back.
- **`formatDn(dn, fmt, gran)`:** always `en-US` with `timeZone: "UTC"`. Formats are mdy (default), dmy, medium, short, long and iso, plus month and year granularity labels.

### 3.2 Filter encoding (provenance lives in the filter itself)

| Meaning | Filter written |
|---|---|
| Our **default** range | `AdvancedFilter` And: `GreaterThanOrEqual start` + **`LessThan end+1`** (00:00) |
| A **user** range | `AdvancedFilter` And: `GreaterThanOrEqual start` + **`LessThanOrEqual end 23:59:59.999`** |
| Before / After | the matching single condition |
| List / tile pick | `BasicFilter` `In` [dates] |
| Contiguous tree / list pick | write it as a user range (compact) |
| Clear | `applyJsonFilter(null, "general", "filter", FilterAction.remove)` |

- **Reading provenance:** the `LessThan` operator is how we recognise "this is our default" when the report reopens or a bookmark is applied.
- **Applying filters:** apply with `host.applyJsonFilter(filter, "general", "filter", FilterAction.merge)`.
- **Target:** get it from `interactivityFilterService.extractFilterColumnTarget(category)`.
- **Reading back:** read the current filter from `options.jsonFilters`.

### 3.3 decide.ts (pure function)

```ts
decide({
  initialized,      // false on the first data update after the report opens
  relativeStyle, defaultEnabled, persist /* Save user changes */, storedRelCustom,
  incoming: { bounds: {start,end} | null, isDefault } | null,
  incomingSig,      // JSON of the incoming filter
  echoSig,          // JSON of our own last default write (for today)
  want,             // today's default bounds
}) → "applyDefault" | "keepDefault" | "relativeStored" | "adopt"
```

- **First update (`!initialized`):**
  - **Relative style:**
    - persist && storedRelCustom → `relativeStored`;
    - otherwise defaultEnabled → `applyDefault`;
    - otherwise → `adopt`.
  - **Other styles:**
    - `!defaultEnabled` → `adopt`.
    - `!persist`, no incoming filter, or an incoming default: if the incoming filter is a default with the same bounds as `want`, return `keepDefault`; otherwise `applyDefault`.
    - Otherwise (persist on and a user filter came in) → `adopt`.
- **Later updates:** if defaultEnabled and incoming.isDefault:
  - the incoming signature equals `echoSig`, or the bounds equal `want` → `keepDefault`;
  - otherwise → `applyDefault` (a stale default from a bookmark, yesterday, or the author changed N).
  - Everything else → `adopt`.
- **Loop guards in visual.ts:**
  - remember the signature of our last write;
  - backstop: at most 5 default writes in 10 seconds;
  - a midnight timer recomputes `want` and re-runs the decision.
- **Unit tests:** write tests for every branch.

### 3.4 tree.ts

- **`buildTree(dates, mode: "month"|"quarter"|"week", dayLabel)`:** newest first, and every node stores all of its day numbers.
- **ISO 8601 week (`isoWeek(dn)`):** Monday-based. Week 1 contains the first Thursday, and the week-year may differ from the calendar year (2025-12-29 is 2026-W01). Label: `Week 47 · Nov 16 – Nov 22`.
- **Tri-state check boxes:** `checkState(node, selectedSet)` returns checked, partial or none.
- **`autoExpanded`:** opens every partially selected node so the edges of the default range are visible; if nothing is partial, open the newest year. The default range must be pre-ticked on open **whatever its length** (it may span many months).
- **`isContiguous(days, allDatesSorted)`:** if true, write a range filter instead of a long `In` list.

## 4. Slicer styles (Format › Slicer settings › Style)

| Style | Behaviour |
|---|---|
| **Between** (default) | Two date boxes plus a two-handle slider |
| **Before** / **After** | One box plus a one-handle slider |
| **Vertical list** | Search box, "Select all" and a list or tree with check boxes |
| **Tile** | Wrapping buttons of months / years / days |
| **Dropdown** | The same list or tree inside a dropdown panel |
| **Relative date** | `Last/Next/This` + number + unit + "Include today"; shows the resulting dates. A user's rule may be saved via `persistProperties` (object `state`) when Save user changes is on |
| **Date picker** | Quick-range `<select>` (Default: …, Today, Yesterday, Last 7/30/90 days, This week, This month, Last month, This quarter, Year to date, Last 12 months, All dates, Custom range) above the date boxes and slider. Quick ranges apply fixed dates; only the Default rolls |

### Date boxes

- **Look:** "Boxes (like the native slicer)" is the default, with border #B3B0AD 1px, radius 2 and a white background. "Plain text" and "Underline" are alternatives.
- **Typing:** users can type a date; it is parsed using the chosen format's day/month order.
- **Calendar icon:** optional, shown inside the box, on by default. **Calendar opens** has two modes:
  - **Pop-up (default):** put a transparent `<input type="date">` over the icon, with `::-webkit-calendar-picker-indicator` stretched to cover it, and set `min`/`max` from the data. The browser draws its own picker, which can extend **outside the visual's iframe**. A custom visual cannot draw past its own bounds, and `showPicker()` is blocked in cross-origin iframes.
  - **Inside the visual:** our own month calendar, showing the range highlighted, today outlined, dates without data dimmed, year/month navigation and a "Today" link. It is an overlay on the visual, scaled down with `transform: scale()` to fit when the visual is short.

### Slider

- **Handles:** "Bar" (default, like native: width 5, height 17, colour #252423) or "Circle" (size 20, border and fill colours).
- **Selected range:** colour #252423.
- **Track:** colour #C8C6C4, thickness 3, with optional first/last date labels underneath.
- **Dragging:** when both handles overlap, the drag direction picks the handle. Wrap `setPointerCapture` in try/catch.
- **Keyboard:** handles support arrow keys.

### Buttons

- **Reset to default** (circular-arrow SVG): only shown while the selection differs from today's default.
- **Clear selections** (eraser SVG): removes the filter.
- **Toggles:** each button can be switched off.
- **Position:** "In the header" or "Next to the dates". When the header is off, they are always next to the dates.
- **Icons:** build SVG with `createElementNS`; never use `innerHTML`.

### Default-range label

- **Text:** a pill such as "Last 30 days" while the default is active, or "Custom selection" after a user changes it, with a tooltip explaining what happens.
- **Setting:** lives in **Slicer settings** with "Label position": In the header, or In front of the dates.
- **Header off:** the label is always in front of the dates, and also in front of the dropdown, the search box and the relative row.

## 5. Header (like the native "Slicer header")

- **Visibility:** a top-level On/Off toggle. When it is off, render nothing: no field name anywhere.
- **Text:**
  - show title;
  - title text (empty = field display name);
  - font family/size/bold/italic/underline via `FontControl`, default Segoe UI 9;
  - colour.
- **Border:** on/off, colour, width, position (Bottom only / Top only / Top + bottom / Frame).
- **Background:** on/off, colour, transparency.

## 6. Layout

Padding on each side (default 4/6/4/6 px), a vertical position (Top / Middle / Bottom) and the space between rows (8). The visual cannot be moved by Power BI's own padding, so these settings matter.

## 7. Format pane (formattingmodel cards; hide options that don't apply)

1. **Slicer settings:**
   - Style;
   - Show dates;
   - Show date picker icon;
   - Calendar opens;
   - Show default-range label;
   - Label position;
   - View (List/Dropdown: Tree Year›Month›Day, Tree Year›ISO week›Day, Days, Months, Years; default Tree);
   - Show quarters;
   - Tiles show (Months/Years/Days);
   - Single select;
   - Show "Select all";
   - Show search box.
2. **Default range (rolling)**, top-level toggle On:
   - Range type (Last N (rolling), Last N calendar (complete periods), This period (whole), Period to date, Next N);
   - N = 30, with no upper limit;
   - Unit = Days;
   - Include today = On;
   - Save user changes = Off.
3. **Slicer header** (composite card, top-level toggle): groups Text, Border and Background.
4. **Values** (composite):
   - **Values group:** font, colour, selection colour #118DFF;
   - **Date boxes group:** look, border colour, border width, rounded corners;
   - **Background group:** on (default), colour, transparency.
5. **Slider** (composite, top-level toggle):
   - **Handles:** shape, border, fill, width, height, size;
   - **Selected range:** colour;
   - **Track:** colour, thickness, show first/last date.
6. **Buttons:** Reset to default button, Clear selections button (eraser), Position, Icon colour #605E5C.
7. **Layout & padding:** padding ×4, vertical position, space between rows.
8. **Dates:**
   - Date format: 11/19/2026, 19/11/2026, Nov 19, 2026, 11/19/26, November 19, 2026, 2026-11-19;
   - Week starts on: Monday, Sunday, Saturday.

**Visibility rules** (implement `applyVisibility()` and call it after `populateFormattingSettingsModel` on each update):

- date-box and slider options only for Between/Before/After/Date picker;
- list options only for List/Dropdown; tile options only for Tile;
- "Show quarters" only with the month tree;
- handle width/height for Bar, size for Circle;
- N hidden for This/To-date;
- Include today hidden for This;
- Calendar opens only when the icon is on;
- Label position only when the label is on and the header is on;
- default-range options only when the Default range is on.

## 8. Rendering and styling

- **CSS variables:** set them on the root `.rds` element from the settings (fonts, colours, border, handle sizes, padding, alignment).
- **Root class:** `rds rds--{boxed|plain|underline} rds--handle-{bar|circle}`.
- **Re-rendering:** re-render the DOM on every update. After a search-box re-render, keep its focus and caret.
- **Look:** match the native slicer: Segoe UI, #252423 text, #605E5C icons, 26px-high date boxes.
- **Phone/narrow widths:** boxes use `flex: 1; min-width: 0`, and labels/badges/buttons use `flex: none`.

## 9. Acceptance checks

1. **Date math:** unit tests for `computeRange`, covering month-end clamping, leap years, week start and year boundaries. ISO weeks must match Python's `date.isocalendar()` for 2015–2030.
2. **Decisions:** unit tests for every branch of `decide`, including echo and loop prevention.
3. **In Power BI Desktop:**
   - Default Last 30 days with Save user changes Off: change the dates, save, close, reopen → today's last 30 days are back.
   - Save user changes On: a user range survives a reopen, while a default selection rolls the next day.
   - A bookmark that captured an old default rolls to today; a bookmark with a user range keeps it.
   - List/Dropdown tree with a 4-month default: the right days are ticked, and partial months/years are open.
   - Header off: no field name is visible; the buttons and label sit in front of / beside the dates.
   - Calendar Pop-up mode opens over neighbouring visuals in a short slicer; Inside mode shrinks to fit.
   - No apply → update → apply loops (watch the filter pane and the performance analyzer).
4. **Packaging:** `pbiviz package` succeeds and eslint passes.
