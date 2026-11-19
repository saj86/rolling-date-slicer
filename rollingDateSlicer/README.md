# Rolling Date Slicer (Power BI custom visual)

A date slicer with a **rolling default range**. Example: the default is "Last 30 days". Each time the report
opens, the slicer selects the 30 days ending *today* and filters the page. A user can still drag the slider or
pick dates. If **Save user changes** is off, that change is not kept: the next open shows today's default again.

Build: `npm install` then `npm run package`. The output is `dist/*.pbiviz`. In Power BI, import it via
Visualizations → … → *Import a visual from a file*.

## Styles (Format → Slicer settings)
Vertical list · Tile · Between · Before · After · Dropdown · Relative date · Date picker (quick ranges + dates + slider). Vertical list and Dropdown (shown as a **Tree**: Year › (Quarter) › Month › Day, or Year › ISO week › Day
by default, or flat by day/month/year as vertical or horizontal tiles; search, select all, single select) · Relative date (Last/This/To date/Next N days/weeks/months/quarters/years).

## Look and layout (Format pane)
Power BI's own visual title (General → Title) is suppressed, like the native slicer, so the field name only appears
if the Slicer header is on.

The pane shows only the options that apply to the chosen style. List/Dropdown options appear only for List/Dropdown,
and the Slider card only for Between/Before/After.
| Card | Options |
|---|---|
| Slicer header | On/off; **Text**: show title, title text (empty = field name), font family/size/bold/italic/underline, color; **Border** (bottom/top/both/frame, color, width); **Background** (color, transparency) |
| Buttons | Reset-to-default (↺ icon, only while the selection differs from the default), Clear selections (eraser), each on/off; position: header or next to the date boxes; icon color |
| Values | **Values**: font family/size/B/I/U, color, selection color; **Date boxes**: look = boxes (native, default) / plain text / underline, border, corners; **Background** (color, transparency). Slicer settings has "Show default-range label" with "Label position" (in the header, or in front of the dates; always in front when the header is off), "Show date picker icon" and "Calendar opens": **Pop-up** (default, the browser's own date picker, which can extend over other visuals) or **Inside the visual** (our calendar with range highlight; a custom visual cannot draw outside its own box, so it shrinks to fit). |
| Slider | On/off; **Handles**: bar (native, width/height) or circle (size, fill), border color; **Selected range** color; **Track** color, thickness, first/last date labels |
| Layout & padding | Padding on each side, vertical position (top/middle/bottom), space between rows |

If the header is turned off, the buttons move next to the boxes. Padding leaves a margin at the edge of the visual,
which makes it easier to grab and move the visual on the page.

## Default range (Format → Default range (rolling))
| Setting | Meaning |
|---|---|
| Enabled | Turns the rolling default on or off. Off = a plain slicer. |
| Range type | Last N (rolling), Last N calendar (complete periods), This period, Period to date, Next N |
| N / Unit | e.g. 30 Days, 3 Months, 1 Year |
| Include today | "Last 30 days" ending today or yesterday |
| Save user changes | **Off**: the default is reapplied on every open. **On**: a user's selection is kept, but if they never changed it, it still rolls daily. |
| Show reset button | ↺ button that brings back the default |

## Tree view and the default range
The default range has no length limit (e.g. last 6 months). In the tree it is always ticked on open: months fully
inside the range are checked, the month where the range starts or ends shows partial and opens automatically.
The week tree uses ISO 8601 weeks: Monday to Sunday, week 1 contains the first Thursday of the year, every week has 7 days.
Years in that tree are ISO week-years, so e.g. Dec 29, 2025 sits under 2026 › Week 1. (The "Week starts on" setting
still applies to default ranges such as "This week", not to the ISO tree.)
A user selection that is one unbroken run of dates is saved as a range, not a long list of dates.

## How it works
The filter written to the report records whether it is the default or a user selection:
- The default is written with `< end+1 day`.
- A user selection is written with `<= end 23:59:59`, or as an `In` list.

So a stale default saved yesterday is recognised on open and recalculated for today. The design is meant to
handle bookmarks, persistent filters in the Service, and a report left open past midnight, but it has **not yet
been tested inside Power BI**. "Today" is the viewer's **local** date, not UTC. The open/update decision logic is
in `src/decide.ts`; it is pure and unit-tested.

## Test checklist in Power BI Desktop
1. Add a card showing MIN and MAX of the date. With "Last 30 days" it must show exactly today-29 .. today. This checks the date encoding in your time zone.
2. Change the range, save, and reopen: with Save user changes Off you get the default back; with it On your range is kept.
3. Reopen the next day: the default has moved forward one day.
4. Apply a bookmark that was captured on an earlier day: the default rolls to today.
5. Expected: Desktop shows "unsaved changes" when the rolling filter shifts on open.

## Known limits
- Bind the date **column**, not the auto Date Hierarchy.
- List/Dropdown selections on a *date/time* column with time parts only match midnight values; use a date column.
- In Relative style, a user's custom rule (e.g. "Last 7 days") is remembered with Save user changes = On only
  where the visual can save properties (Desktop, or edit mode in the Service).
- Up to 30,000 distinct dates.
