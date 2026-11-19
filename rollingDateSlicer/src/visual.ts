"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { AdvancedFilter, BasicFilter, IAdvancedFilterCondition, IFilterColumnTarget } from "powerbi-models";
import { interactivityFilterService } from "powerbi-visuals-utils-interactivityutils";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import FilterAction = powerbi.FilterAction;
import DataView = powerbi.DataView;

import { VisualFormattingSettingsModel } from "./settings";
import { decide } from "./decide";
import { buildTree, checkState, autoExpanded, isContiguous, TreeNode } from "./tree";
import {
    RangeSpec, RangeType, Unit, DayRange, DateFormat,
    computeRange, describeSpec, dnFromDataValue, dnFromIso, isoFromDn, todayDn,
    formatDn, groupKey, ymdFromDn, dnFromYMD, daysInMonth, dow, addMonths
} from "./dateUtils";

type Style = "between" | "before" | "after" | "list" | "tile" | "dropdown" | "relative" | "datepicker";
type Gran = "day" | "month" | "year";

/** What the slicer currently has selected. */
type Selection =
    | { kind: "all" }
    | { kind: "range"; start: number | null; end: number | null }
    | { kind: "list"; days: Set<number> };

/** Parsed incoming filter + whether it was written as "the rolling default". */
interface IncomingFilter { sel: Selection; isDefault: boolean; sig: string; }

const FAR_FUTURE = dnFromYMD(9999, 12, 30);

/*
 * HOW THE ROLLING DEFAULT WORKS
 * -----------------------------
 * The filter we write records where it came from, so this survives report save,
 * the Service's persistent filters, and bookmarks without extra storage:
 *   - default range  -> AdvancedFilter [>= start, <  end+1 day]   (uses "LessThan")
 *   - user's choice  -> AdvancedFilter [>= start, <= end 23:59:59] (uses "LessThanOrEqual")
 *                       or BasicFilter "In" for list picks
 * On open (first update):
 *   - default enabled and "Save user changes" OFF -> always apply today's default.
 *   - default enabled and "Save user changes" ON  -> keep a user filter. A stale
 *     default filter (saved yesterday) is recomputed for today.
 * Later updates: if a default-encoded filter arrives that is not today's
 * (bookmark, author changed N, midnight passed) it is recomputed.
 */
export class Visual implements IVisual {
    private host: IVisualHost;
    private root: HTMLElement;
    private settings: VisualFormattingSettingsModel;
    private fmtService = new FormattingSettingsService();
    private selectionManager: powerbi.extensibility.ISelectionManager;

    private initialized = false;
    private target: IFilterColumnTarget | null = null;
    private dates: number[] = [];
    private sel: Selection = { kind: "all" };
    private isDefault = false;
    private relSpec: RangeSpec | null = null;
    private lastToday = todayDn();
    private awaitEchoKey: string | null = null;
    private echoKey: string | null = null;
    private echoSig: string | null = null;
    private defaultWrites: number[] = [];

    // transient UI state
    private popup: { which: "start" | "end"; year: number; month: number } | null = null;
    private dropdownOpen = false;
    private search = "";
    private fieldName = "";
    private treeExpanded: Set<string> | null = null; // null = automatic (open where the selection starts/ends)
    private lastOptions: VisualUpdateOptions | null = null;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.root = document.createElement("div");
        this.root.className = "rds";
        options.element.appendChild(this.root);
        options.element.addEventListener("contextmenu", (e: MouseEvent) => {
            this.selectionManager.showContextMenu({} as powerbi.visuals.ISelectionId, { x: e.clientX, y: e.clientY });
            e.preventDefault();
        });
        // Report left open past midnight: roll the default to the new day.
        window.setInterval(() => {
            const t = todayDn();
            if (t !== this.lastToday) {
                this.lastToday = t;
                if (this.settings && this.target && this.isDefault && this.defaultEnabled()) { this.applyDefault(); this.render(); }
            }
        }, 60000);
    }

    // ------------------------------------------------------------------ update

    public update(options: VisualUpdateOptions) {
        this.host.eventService?.renderingStarted(options);
        try {
            this.lastOptions = options;
            const dv: DataView | undefined = options.dataViews?.[0];
            this.settings = this.fmtService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dv);
            this.settings.applyVisibility();
            this.applyTheme();

            const cat = dv?.categorical?.categories?.[0];
            if (!cat) {
                this.dates = [];
                this.target = null;
                this.renderEmpty();
                this.host.eventService?.renderingFinished(options);
                return;
            }
            this.target = interactivityFilterService.extractFilterColumnTarget(cat);
            this.fieldName = cat.source.displayName || "";
            const set = new Set<number>();
            for (const v of cat.values) {
                const dn = dnFromDataValue(v);
                if (dn != null) set.add(dn);
            }
            this.dates = Array.from(set).sort((a, b) => a - b);

            this.lastToday = todayDn();
            const incoming = this.parseIncoming(options.jsonFilters as unknown[]);
            const stateObj = dv?.metadata?.objects?.state || {};
            this.syncSelection(incoming, stateObj);
            this.render();
            this.host.eventService?.renderingFinished(options);
        } catch (e) {
            this.host.eventService?.renderingFailed(options, String(e));
            throw e;
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.settings);
    }

    // ------------------------------------------------------------- settings

    private get style(): Style { return this.settings.slicer.style.value.value as Style; }
    private defaultEnabled(): boolean { return this.settings.defaultRange.enabled.value; }
    private persist(): boolean { return this.settings.defaultRange.persistUserChanges.value; }
    private weekStart(): number { return Number(this.settings.dateFormat.weekStart.value.value); }
    private fmt(): DateFormat { return this.settings.dateFormat.format.value.value as DateFormat; }
    private isTree(): boolean {
        const g = this.settings.slicer.granularity.value.value;
        return (this.style === "list" || this.style === "dropdown") && (g === "tree" || g === "treeWeek");
    }
    private gran(): Gran {
        if (this.style === "tile") return this.settings.slicer.tileGranularity.value.value as Gran;
        return (this.style === "list" || this.style === "dropdown")
            && !this.isTree() ? this.settings.slicer.granularity.value.value as Gran : "day";
    }

    private defaultSpec(): RangeSpec {
        const d = this.settings.defaultRange;
        return {
            type: d.rangeType.value.value as RangeType,
            count: d.count.value,
            unit: d.unit.value.value as Unit,
            includeToday: d.includeToday.value,
            weekStart: this.weekStart()
        };
    }

    private defaultRange(): DayRange { return computeRange(this.defaultSpec(), todayDn()); }

    // ------------------------------------------------------ selection logic

    private parseIncoming(filters: unknown[] | undefined): IncomingFilter | null {
        const f = filters?.[0] as any;
        if (!f) return null;
        if (Array.isArray(f.conditions)) {
            let start: number | null = null, end: number | null = null, isDefault = false;
            for (const c of f.conditions as IAdvancedFilterCondition[]) {
                const dn = dnFromIso(c.value);
                if (dn == null) continue;
                switch (c.operator) {
                    case "GreaterThanOrEqual": start = dn; break;
                    case "GreaterThan": start = dn + 1; break;
                    case "LessThan": end = dn - 1; isDefault = true; break;
                    case "LessThanOrEqual": end = dn; break;
                }
            }
            if (end != null && end >= FAR_FUTURE - 1) end = null;
            return { sel: { kind: "range", start, end }, isDefault, sig: JSON.stringify(f.conditions) };
        }
        if (Array.isArray(f.values)) {
            const days = new Set<number>();
            for (const v of f.values) {
                const dn = dnFromIso(Array.isArray(v) ? v[0] : v);
                if (dn != null) days.add(dn);
            }
            return { sel: { kind: "list", days }, isDefault: false, sig: JSON.stringify(f.values) };
        }
        return null;
    }

    private syncSelection(incoming: IncomingFilter | null, stateObj: powerbi.DataViewObject) {
        const want = this.defaultFilterBounds(this.defaultRange());
        const key = this.defaultKey();

        // The first default-encoded filter after our own default write is our echo.
        // Remember its raw form so a re-encoded round-trip can never cause a write loop.
        if (this.awaitEchoKey && incoming?.isDefault) {
            if (this.awaitEchoKey === key) { this.echoSig = incoming.sig; this.echoKey = key; }
            this.awaitEchoKey = null;
        }
        const relCustom = this.persist() && stateObj["mode"] === "custom";
        const decision = decide({
            initialized: this.initialized,
            relativeStyle: this.style === "relative",
            defaultEnabled: this.defaultEnabled(),
            persist: this.persist(),
            storedRelCustom: relCustom,
            incoming: incoming ? {
                bounds: incoming.sel.kind === "range" ? { start: incoming.sel.start, end: incoming.sel.end } : null,
                isDefault: incoming.isDefault
            } : null,
            incomingSig: incoming?.sig ?? null,
            echoSig: this.echoKey === key ? this.echoSig : null,
            want
        });
        this.initialized = true;

        switch (decision) {
            case "applyDefault":
                this.applyDefault();
                break;
            case "keepDefault":
                this.sel = { kind: "range", start: want.start, end: want.end };
                this.isDefault = true;
                if (this.style === "relative") this.relSpec = this.defaultSpec();
                break;
            case "relativeStored":
                this.relSpec = {
                    type: (stateObj["relType"] as RangeType) || "last",
                    count: Number(stateObj["relCount"]) || 1,
                    unit: (stateObj["relUnit"] as Unit) || "day",
                    includeToday: stateObj["relIncludeToday"] !== false,
                    weekStart: this.weekStart()
                };
                this.applyRelative(false);
                break;
            default:
                this.sel = incoming ? incoming.sel : { kind: "all" };
                this.isDefault = !!incoming?.isDefault;
        }
        if (this.style === "relative" && !this.relSpec) this.relSpec = this.defaultSpec();
    }

    /** Identifies "today's default" for the current style and settings. */
    private defaultKey(): string {
        return `${todayDn()}|${this.style}|${JSON.stringify(this.defaultSpec())}`;
    }

    /** Start/end as they appear in the filter for the current style. */
    private defaultFilterBounds(r: DayRange): { start: number | null; end: number | null } {
        if (this.style === "before") return { start: null, end: r.end };
        if (this.style === "after") return { start: r.start, end: null };
        return { start: r.start, end: r.end };
    }

    private applyDefault() {
        this.treeExpanded = null;
        const b = this.defaultFilterBounds(this.defaultRange());
        this.sel = { kind: "range", start: b.start, end: b.end };
        this.isDefault = true;
        if (this.style === "relative") this.relSpec = this.defaultSpec();
        // Backstop: never write the default more than 5 times in 10 seconds.
        const now = Date.now();
        this.defaultWrites = this.defaultWrites.filter(t => now - t < 10000);
        if (this.defaultWrites.length >= 5) return;
        this.defaultWrites.push(now);
        this.awaitEchoKey = this.defaultKey();
        this.writeRangeFilter(b.start, b.end, true);
    }

    private applyRelative(userAction: boolean) {
        if (!this.relSpec) return;
        const r = computeRange(this.relSpec, todayDn());
        const d = this.defaultSpec();
        const s = this.relSpec;
        const matchesDefault = this.defaultEnabled() && s.type === d.type && s.count === d.count
            && s.unit === d.unit && s.includeToday === d.includeToday;
        if (matchesDefault) {
            this.applyDefault();
            if (userAction) this.saveState("default");
            return;
        }
        this.sel = { kind: "range", start: r.start, end: r.end };
        this.isDefault = false;
        this.writeRangeFilter(r.start, r.end, false);
        if (userAction) this.saveState("custom");
    }

    private writeRangeFilter(start: number | null, end: number | null, asDefault: boolean) {
        if (!this.target) return;
        const conds: IAdvancedFilterCondition[] = [];
        if (start != null) conds.push({ operator: "GreaterThanOrEqual", value: isoFromDn(start) });
        if (asDefault) {
            conds.push({ operator: "LessThan", value: isoFromDn(end != null ? end + 1 : FAR_FUTURE + 1) });
        } else if (end != null) {
            conds.push({ operator: "LessThanOrEqual", value: isoFromDn(end, true) });
        }
        if (!conds.length) { this.clearFilter(); return; }
        const filter = new AdvancedFilter(this.target, "And", conds);
        this.host.applyJsonFilter(filter, "general", "filter", FilterAction.merge);
    }

    private writeListFilter(days: Set<number>) {
        if (!this.target) return;
        if (days.size === 0 || days.size === this.dates.length) { this.clearFilter(); return; }
        const sorted = Array.from(days).sort((a, b) => a - b);
        if (isContiguous(sorted, this.dates)) {
            // One unbroken run (e.g. a whole month, or many months): store it as a compact range.
            this.writeRangeFilter(sorted[0], sorted[sorted.length - 1], false);
            return;
        }
        const values = sorted.map(d => isoFromDn(d));
        const filter = new BasicFilter(this.target, "In", values);
        this.host.applyJsonFilter(filter, "general", "filter", FilterAction.merge);
    }

    private clearFilter() {
        this.host.applyJsonFilter(null, "general", "filter", FilterAction.remove);
    }

    private saveState(mode: "default" | "custom") {
        if (!this.persist() && mode === "custom") return;
        const s = this.relSpec;
        this.host.persistProperties({
            merge: [{
                objectName: "state", selector: null,
                properties: {
                    mode,
                    relType: s?.type ?? "last", relCount: s?.count ?? 30,
                    relUnit: s?.unit ?? "day", relIncludeToday: s?.includeToday ?? true
                }
            }]
        });
    }

    // ---- user actions

    private userSetRange(start: number | null, end: number | null) {
        if (start != null && end != null && start > end) [start, end] = [end, start];
        this.sel = { kind: "range", start, end };
        this.isDefault = false;
        this.writeRangeFilter(start, end, false);
        this.render();
    }

    private userSetList(days: Set<number>) {
        this.sel = days.size === 0 || days.size === this.dates.length ? { kind: "all" } : { kind: "list", days };
        this.isDefault = false;
        this.writeListFilter(days);
        this.render();
    }

    private userReset() {
        this.popup = null;
        if (this.style === "relative") { this.relSpec = this.defaultSpec(); this.saveState("default"); }
        this.applyDefault();
        this.render();
    }

    private userClear() {
        this.popup = null;
        this.treeExpanded = null;
        this.sel = { kind: "all" };
        this.isDefault = false;
        this.clearFilter();
        this.render();
    }

    /** Selected individual days (for list/dropdown). */
    private selectedDays(): Set<number> {
        const s = this.sel;
        if (s.kind === "list") return new Set(s.days);
        if (s.kind === "range") {
            const lo = s.start ?? -Infinity, hi = s.end ?? Infinity;
            return new Set(this.dates.filter(d => d >= lo && d <= hi));
        }
        return new Set();
    }

    private currentRange(): { start: number | null; end: number | null } {
        const s = this.sel;
        if (s.kind === "range") return { start: s.start, end: s.end };
        if (s.kind === "list" && s.days.size) {
            const arr = Array.from(s.days);
            return { start: Math.min(...arr), end: Math.max(...arr) };
        }
        return { start: null, end: null };
    }

    // ------------------------------------------------------------- rendering

    private applyTheme() {
        const { values: v, header: h, slider: sl, layout: l, buttons: b } = this.settings;
        const st = this.root.style;
        const set = (k: string, val: string) => st.setProperty(k, val);
        const fam = (f: string) => `${f}, "Segoe UI", wf_segoe-ui_normal, helvetica, arial, sans-serif`;
        const rgba = (hex: string, transparencyPct: number) => {
            const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
            if (!m) return hex;
            const n = parseInt(m[1], 16);
            return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${1 - transparencyPct / 100})`;
        };
        // Values
        set("--rds-font", fam(v.font.fontFamily.value));
        set("--rds-font-size", `${v.font.fontSize.value}pt`);
        set("--rds-weight", v.font.bold.value ? "600" : "400");
        set("--rds-italic", v.font.italic.value ? "italic" : "normal");
        set("--rds-decoration", v.font.underline.value ? "underline" : "none");
        set("--rds-fg", v.fontColor.value.value);
        set("--rds-accent", v.accentColor.value.value);
        set("--rds-input-bg", v.bgShow.value ? rgba(v.bgColor.value.value, v.bgTransparency.value) : "transparent");
        set("--rds-popup-bg", v.bgShow.value ? v.bgColor.value.value : "#FFFFFF");
        set("--rds-border", v.borderColor.value.value);
        set("--rds-border-w", `${v.borderWidth.value}px`);
        set("--rds-radius", `${v.radius.value}px`);
        // Header
        set("--rds-h-font", fam(h.font.fontFamily.value));
        set("--rds-h-size", `${h.font.fontSize.value}pt`);
        set("--rds-h-weight", h.font.bold.value ? "600" : "400");
        set("--rds-h-italic", h.font.italic.value ? "italic" : "normal");
        set("--rds-h-decoration", h.font.underline.value ? "underline" : "none");
        set("--rds-h-color", h.fontColor.value.value);
        set("--rds-h-bg", h.bgShow.value ? rgba(h.bgColor.value.value, h.bgTransparency.value) : "transparent");
        const bw = h.borderShow.value ? `${h.borderWidth.value}px solid ${h.borderColor.value.value}` : "none";
        const pos = h.borderPosition.value.value;
        set("--rds-h-bt", h.borderShow.value && pos !== "bottom" ? bw : "none");
        set("--rds-h-bb", h.borderShow.value && pos !== "top" ? bw : "none");
        set("--rds-h-bs", h.borderShow.value && pos === "frame" ? bw : "none");
        // Buttons, slider, layout
        set("--rds-icon", b.iconColor.value.value);
        set("--rds-range", sl.rangeColor.value.value);
        set("--rds-track", sl.trackColor.value.value);
        set("--rds-handle-fill", sl.handleFill.value.value);
        set("--rds-handle-border", sl.handleBorder.value.value);
        const circle = sl.handleShape.value.value === "circle";
        set("--rds-handle-w", `${circle ? sl.handleSize.value : sl.handleWidth.value}px`);
        set("--rds-handle-h", `${circle ? sl.handleSize.value : sl.handleHeight.value}px`);
        set("--rds-track-h", `${sl.trackHeight.value}px`);
        set("--rds-gap", `${l.gap.value}px`);
        st.padding = `${l.paddingTop.value}px ${l.paddingRight.value}px ${l.paddingBottom.value}px ${l.paddingLeft.value}px`;
        const va = l.verticalAlign.value.value;
        st.justifyContent = va === "center" ? "center" : va === "bottom" ? "flex-end" : "flex-start";
        this.root.className = `rds rds--${v.boxStyle.value.value} rds--handle-${circle ? "circle" : "bar"}`;
    }

    private renderEmpty() {
        this.root.replaceChildren(el("div", "rds-empty", "Add a date column to the Date field."));
    }

    private render() {
        if (!this.target) { this.renderEmpty(); return; }
        const r = this.root;
        r.replaceChildren();
        const header = this.renderHeader();
        if (header) r.appendChild(header);
        const grow = this.style === "list" || this.style === "tile" || (this.style === "dropdown" && this.dropdownOpen);
        const body = el("div", "rds-body" + (grow ? " grow" : ""));
        r.appendChild(body);
        if (!this.dates.length && this.style !== "relative") {
            body.appendChild(el("div", "rds-empty", "No dates in data."));
            return;
        }
        switch (this.style) {
            case "between": this.renderRangeStyle(body, true, true); break;
            case "before": this.renderRangeStyle(body, false, true); break;
            case "after": this.renderRangeStyle(body, true, false); break;
            case "list": case "tile": this.renderList(body); break;
            case "datepicker": this.renderDatePicker(body); break;
            case "dropdown": this.renderDropdown(body); break;
            case "relative": this.renderRelative(body); break;
        }
        if (this.popup) r.appendChild(this.renderCalendar());
    }

    /** Buttons go in the header, or next to the boxes ("inline"), or inline anyway when the header is hidden. */
    private buttonsInline(): boolean {
        const isRange = this.style === "between" || this.style === "before" || this.style === "after"
            || this.style === "datepicker";
        return !this.settings.header.show.value || (isRange && this.settings.buttons.position.value.value === "inline");
    }

    private actionButtons(): HTMLElement[] {
        const b = this.settings.buttons;
        const out: HTMLElement[] = [];
        if (b.showReset.value && this.defaultEnabled() && !this.isDefault) {
            out.push(iconButton(ICONS.reset, "Reset to default range", () => this.userReset()));
        }
        if (b.showClear.value && this.sel.kind !== "all") {
            out.push(iconButton(ICONS.eraser, "Clear selections", () => this.userClear()));
        }
        return out;
    }

    private renderHeader(): HTMLElement | null {
        const hs = this.settings.header;
        if (!hs.show.value) return null;
        const h = el("div", "rds-header");
        if (hs.showTitle.value) {
            const text = hs.titleText.value.trim() || this.fieldName;
            const t = el("div", "rds-title", text);
            t.title = text;
            h.appendChild(t);
        }
        if (this.showBadge() && !this.badgeInline()) h.appendChild(this.badge());
        h.appendChild(el("span", "rds-spacer"));
        if (!this.buttonsInline()) this.actionButtons().forEach(b => h.appendChild(b));
        return h.childElementCount > 1 ? h : null;
    }

    private showBadge(): boolean {
        return this.defaultEnabled() && this.settings.slicer.showBadge.value;
    }

    /** The default-range label goes in front of the dates when asked to, or whenever the header is off. */
    private badgeInline(): boolean {
        return this.showBadge()
            && (!this.settings.header.show.value || this.settings.slicer.badgePosition.value.value === "inline");
    }

    /** Something (buttons or the label) has to be placed in the row with the dates. */
    private inlineExtras(): boolean {
        return this.buttonsInline() || this.badgeInline();
    }

    private badge(): HTMLElement {
        const badge = el("span", "rds-badge" + (this.isDefault ? " is-default" : ""),
            this.isDefault ? describeSpec(this.defaultSpec()) : "Custom selection");
        badge.title = this.isDefault
            ? "Rolling default: recalculated every day the report opens"
            : `Default is ${describeSpec(this.defaultSpec())}` +
              (this.persist() ? "" : ". The default comes back the next time the report opens.");
        return badge;
    }

    /** Puts the label in front of a row and the action buttons after it, when they are placed inline. */
    private addInlineButtons(row: HTMLElement) {
        if (this.badgeInline()) row.insertBefore(this.badge(), row.firstChild);
        if (!this.buttonsInline()) return;
        const btns = this.actionButtons();
        if (!btns.length) return;
        const wrap = el("span", "rds-inline-btns");
        btns.forEach(b => wrap.appendChild(b));
        row.appendChild(wrap);
    }

    private label(dn: number | null, gran: Gran = "day"): string {
        return dn == null ? "" : formatDn(dn, this.fmt(), "en-US", gran);
    }

    // ---- between / before / after

    private renderRangeStyle(body: HTMLElement, hasStart: boolean, hasEnd: boolean) {
        const min = this.dates[0], max = this.dates[this.dates.length - 1];
        const cur = this.currentRange();
        const start = cur.start ?? min, end = cur.end ?? max;

        if (this.settings.slicer.showInputs.value) {
            const row = el("div", "rds-inputs");
            if (hasStart) row.appendChild(this.dateInput("start", cur.start, hasEnd ? "Start date" : "On or after"));
            if (hasEnd) row.appendChild(this.dateInput("end", cur.end, hasStart ? "End date" : "On or before"));
            this.addInlineButtons(row);
            body.appendChild(row);
        } else if (this.inlineExtras()) {
            const row = el("div", "rds-inputs rds-btn-row");
            this.addInlineButtons(row);
            if (row.childElementCount) body.appendChild(row);
        }
        if (this.settings.slider.show.value && max > min) {
            body.appendChild(this.slider(min, max, hasStart ? start : null, hasEnd ? end : null));
        }
    }

    /** Date picker: quick ranges on top, then dates + slider. */
    private renderDatePicker(body: HTMLElement) {
        const today = todayDn();
        const presets: [string, string, RangeSpec | null][] = [];
        if (this.defaultEnabled()) presets.push(["default", `Default: ${describeSpec(this.defaultSpec())}`, this.defaultSpec()]);
        const ws = this.weekStart();
        const P = (type: RangeType, count: number, unit: Unit, includeToday = true): RangeSpec =>
            ({ type, count, unit, includeToday, weekStart: ws });
        presets.push(
            ["today", "Today", P("last", 1, "day")],
            ["yesterday", "Yesterday", P("last", 1, "day", false)],
            ["l7", "Last 7 days", P("last", 7, "day")],
            ["l30", "Last 30 days", P("last", 30, "day")],
            ["l90", "Last 90 days", P("last", 90, "day")],
            ["tw", "This week", P("this", 1, "week")],
            ["tm", "This month", P("this", 1, "month")],
            ["lm", "Last month", P("lastCalendar", 1, "month", false)],
            ["tq", "This quarter", P("this", 1, "quarter")],
            ["ytd", "Year to date", P("toDate", 1, "year")],
            ["l12", "Last 12 months", P("last", 12, "month")]
        );
        const cur = this.currentRange();
        let current = "custom";
        if (this.isDefault) current = "default";
        else if (cur.start != null && cur.end != null) {
            const hit = presets.find(([k, , sp]) => {
                if (k === "default" || !sp) return false;
                const r = computeRange(sp, today);
                return r.start === cur.start && r.end === cur.end;
            });
            if (hit) current = hit[0];
        } else if (this.sel.kind === "all") current = "all";
        const opts: [string, string][] = presets.map(([k, l]) => [k, l] as [string, string]);
        opts.push(["all", "All dates"], ["custom", "Custom range"]);
        const row = el("div", "rds-preset-row");
        row.appendChild(select("Quick range", opts, current, v => {
            if (v === "default") { this.userReset(); return; }
            if (v === "all") { this.userClear(); return; }
            const p = presets.find(x => x[0] === v);
            if (p?.[2]) { const r = computeRange(p[2], todayDn()); this.userSetRange(r.start, r.end); }
        }));
        body.appendChild(row);
        this.renderRangeStyle(body, true, true);
    }

    private dateInput(which: "start" | "end", value: number | null, aria: string): HTMLElement {
        const wrap = el("div", "rds-input");
        const input = document.createElement("input");
        input.type = "text";
        input.value = this.label(value);
        input.placeholder = which === "start" ? "Start date" : "End date";
        input.setAttribute("aria-label", aria);
        input.addEventListener("change", () => {
            const dn = parseUserDate(input.value, this.fmt() === "dmy");
            if (dn == null) { input.value = this.label(value); return; }
            this.commitDate(which, dn);
        });
        wrap.appendChild(input);
        if (this.settings.slicer.showCalendarIcon.value && this.settings.slicer.calendarMode.value.value === "browser") {
            // A custom visual lives in an iframe the size of the visual, so nothing we draw can go past its
            // edges. The browser's own date picker is drawn by the browser itself and can, so the icon is
            // covered by an invisible <input type="date"> whose picker opens on click.
            const holder = el("span", "rds-native-cal");
            holder.appendChild(svgIcon(ICONS.calendar));
            const nat = document.createElement("input");
            nat.type = "date";
            nat.title = "Open date picker";
            nat.setAttribute("aria-label", aria + " (date picker)");
            if (this.dates.length) {
                nat.min = isoFromDn(this.dates[0]).slice(0, 10);
                nat.max = isoFromDn(this.dates[this.dates.length - 1]).slice(0, 10);
            }
            if (value != null) nat.value = isoFromDn(value).slice(0, 10);
            nat.addEventListener("change", () => {
                const dn = dnFromIso(nat.value);
                if (dn != null) this.commitDate(which, dn);
            });
            holder.appendChild(nat);
            wrap.appendChild(holder);
        } else if (this.settings.slicer.showCalendarIcon.value) {
            wrap.appendChild(iconButton(ICONS.calendar, "Open date picker", () => {
                const base = value ?? (which === "start" ? this.dates[0] : this.dates[this.dates.length - 1]) ?? todayDn();
                const { y, m } = ymdFromDn(base);
                this.popup = this.popup?.which === which ? null : { which, year: y, month: m };
                this.render();
            }, "rds-cal-btn"));
        }
        return wrap;
    }

    private commitDate(which: "start" | "end", dn: number) {
        const cur = this.currentRange();
        if (which === "start") this.userSetRange(dn, this.style === "after" ? null : cur.end);
        else this.userSetRange(this.style === "before" ? null : cur.start, dn);
    }

    private slider(min: number, max: number, start: number | null, end: number | null): HTMLElement {
        const wrap = el("div", "rds-slider");
        const track = el("div", "rds-track");
        const fill = el("div", "rds-fill");
        track.appendChild(fill);
        wrap.appendChild(track);
        const clamp = (d: number) => Math.min(max, Math.max(min, d));
        const pct = (d: number) => ((clamp(d) - min) / (max - min)) * 100;
        const vals = { start: start == null ? null : clamp(start), end: end == null ? null : clamp(end) };

        const layout = () => {
            const lo = vals.start ?? min, hi = vals.end ?? max;
            fill.style.left = `${pct(lo)}%`;
            fill.style.width = `${pct(hi) - pct(lo)}%`;
            if (sThumb) sThumb.style.left = `${pct(lo)}%`;
            if (eThumb) eThumb.style.left = `${pct(hi)}%`;
            const inputs = this.root.querySelectorAll<HTMLInputElement>(".rds-input input");
            const both = vals.start != null && vals.end != null;
            if (inputs[0]) inputs[0].value = this.label(vals.start ?? vals.end);
            if (both && inputs[1]) inputs[1].value = this.label(vals.end);
        };
        const commit = () => this.userSetRange(
            vals.start == null ? null : vals.start,
            vals.end == null ? null : vals.end);

        const makeThumb = (key: "start" | "end"): HTMLElement => {
            const t = el("div", "rds-thumb");
            t.tabIndex = 0;
            t.setAttribute("role", "slider");
            t.setAttribute("aria-label", key === "start" ? "Start date" : "End date");
            t.addEventListener("pointerdown", (e: PointerEvent) => {
                try { t.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
                // Handles on top of each other: the first drag direction picks the handle
                // (left = start, right = end), like the native slicer.
                const overlap = !!sThumb && !!eThumb
                    && Math.abs(sThumb.offsetLeft - eThumb.offsetLeft) < t.offsetWidth;
                let active: "start" | "end" | null = overlap ? null : key;
                const x0 = e.clientX;
                const move = (ev: PointerEvent) => {
                    if (!active) {
                        if (Math.abs(ev.clientX - x0) < 2) return;
                        active = ev.clientX < x0 ? "start" : "end";
                    }
                    const rect = track.getBoundingClientRect();
                    const f = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
                    let dn = Math.round(min + f * (max - min));
                    if (active === "start" && vals.end != null) dn = Math.min(dn, vals.end);
                    if (active === "end" && vals.start != null) dn = Math.max(dn, vals.start);
                    vals[active] = dn;
                    layout();
                };
                const up = () => {
                    t.removeEventListener("pointermove", move);
                    t.removeEventListener("pointerup", up);
                    commit();
                };
                t.addEventListener("pointermove", move);
                t.addEventListener("pointerup", up);
                e.preventDefault();
            });
            t.addEventListener("keydown", (e: KeyboardEvent) => {
                const step = e.key === "PageUp" ? 30 : e.key === "PageDown" ? -30
                    : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1
                    : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
                if (!step) return;
                vals[key] = clamp((vals[key] ?? (key === "start" ? min : max)) + step);
                e.preventDefault();
                commit();
            });
            track.appendChild(t);
            return t;
        };
        const sThumb = vals.start != null || start != null ? makeThumb("start") : null;
        const eThumb = vals.end != null || end != null ? makeThumb("end") : null;
        layout();

        if (this.settings.slider.showEnds.value) {
            const ends = el("div", "rds-slider-ends");
            ends.appendChild(el("span", "", this.label(min)));
            ends.appendChild(el("span", "", this.label(max)));
            wrap.appendChild(ends);
        }
        return wrap;
    }

    private renderCalendar(): HTMLElement {
        const p = this.popup;
        const overlay = el("div", "rds-overlay");
        overlay.addEventListener("click", (e) => { if (e.target === overlay) { this.popup = null; this.render(); } });
        const cal = el("div", "rds-calendar");
        overlay.appendChild(cal);

        const nav = el("div", "rds-cal-nav");
        const shift = (k: number) => {
            const dn = addMonths(dnFromYMD(p.year, p.month, 1), k);
            const { y, m } = ymdFromDn(dn);
            this.popup = { which: p.which, year: y, month: m };
            this.render();
        };
        nav.appendChild(iconButton(ICONS.chevronsLeft, "Previous year", () => shift(-12)));
        nav.appendChild(iconButton(ICONS.chevronLeft, "Previous month", () => shift(-1)));
        nav.appendChild(el("span", "rds-cal-title", formatDn(dnFromYMD(p.year, p.month, 1), "long", "en-US", "month")));
        nav.appendChild(iconButton(ICONS.chevronRight, "Next month", () => shift(1)));
        nav.appendChild(iconButton(ICONS.chevronsRight, "Next year", () => shift(12)));
        cal.appendChild(nav);

        const grid = el("div", "rds-cal-grid");
        const ws = this.weekStart();
        const names = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
        for (let i = 0; i < 7; i++) grid.appendChild(el("span", "rds-cal-dow", names[(ws + i) % 7]));
        const first = dnFromYMD(p.year, p.month, 1);
        const lead = (dow(first) - ws + 7) % 7;
        for (let i = 0; i < lead; i++) grid.appendChild(el("span", ""));
        const cur = this.currentRange();
        const has = new Set(this.dates);
        const today = todayDn();
        for (let d = 1; d <= daysInMonth(p.year, p.month); d++) {
            const dn = first + d - 1;
            const inRange = (cur.start ?? -Infinity) <= dn && dn <= (cur.end ?? Infinity) && this.sel.kind !== "all";
            const b = document.createElement("button");
            b.className = "rds-day" + (inRange ? " in-range" : "") + (dn === today ? " today" : "")
                + (has.has(dn) ? "" : " no-data") + (dn === cur.start || dn === cur.end ? " edge" : "");
            b.textContent = String(d);
            b.title = this.label(dn);
            b.addEventListener("click", () => { const w = p.which; this.popup = null; this.commitDate(w, dn); });
            grid.appendChild(b);
        }
        cal.appendChild(grid);

        const foot = el("div", "rds-cal-foot");
        const todayBtn = document.createElement("button");
        todayBtn.className = "rds-link";
        todayBtn.textContent = "Today";
        todayBtn.addEventListener("click", () => { const w = p.which; this.popup = null; this.commitDate(w, today); });
        foot.appendChild(todayBtn);
        cal.appendChild(foot);
        // Nothing can be drawn outside the visual, so shrink the calendar to fit a small visual.
        requestAnimationFrame(() => {
            const k = Math.min(1, (overlay.clientWidth - 4) / cal.offsetWidth, (overlay.clientHeight - 4) / cal.offsetHeight);
            if (k > 0 && k < 1) cal.style.transform = `scale(${k})`;
        });
        return overlay;
    }

    // ---- list / dropdown

    private groups(g: Gran = this.gran()): { key: number; days: number[]; label: string }[] {
        const map = new Map<number, number[]>();
        for (const d of this.dates) {
            const k = groupKey(d, g);
            let arr = map.get(k);
            if (!arr) { arr = []; map.set(k, arr); }
            arr.push(d);
        }
        return Array.from(map.entries()).sort((a, b) => b[0] - a[0])
            .map(([key, days]) => ({ key, days, label: this.label(key, g) }));
    }

    private renderListInto(container: HTMLElement) {
        const sl = this.settings.slicer;
        const single = sl.singleSelect.value;
        const horizontal = this.style === "tile";
        if (sl.showSearch.value && this.style !== "tile") {
            const s = document.createElement("input");
            s.type = "search";
            s.className = "rds-search";
            s.placeholder = "Search";
            s.setAttribute("aria-label", "Search dates");
            s.value = this.search;
            s.addEventListener("input", () => {
                this.search = s.value;
                this.render();
                const again = this.root.querySelector<HTMLInputElement>(".rds-search");
                again?.focus();
                again?.setSelectionRange(again.value.length, again.value.length);
            });
            const row = el("div", "rds-search-row");
            row.appendChild(s);
            if (this.style === "list") this.addInlineButtons(row);
            container.appendChild(row);
        } else if ((this.style === "list" || this.style === "tile") && this.inlineExtras()) {
            const row = el("div", "rds-search-row rds-btn-row");
            this.addInlineButtons(row);
            if (row.childElementCount) container.appendChild(row);
        }
        const selected = this.selectedDays();
        const q = this.search.trim().toLowerCase();
        if (this.isTree() && !q) { this.renderTree(container, selected, single); return; }
        const groups = this.groups(this.isTree() ? "day" : this.gran()).filter(g => !q || g.label.toLowerCase().includes(q)
            || formatDn(g.key, "iso", "en-US").includes(q));

        const list = el("div", "rds-list" + (horizontal ? " horizontal" : ""));
        list.setAttribute("role", "listbox");
        if (sl.showSelectAll.value && !single && !q) {
            const all = this.sel.kind === "all";
            list.appendChild(this.listItem("Select all", all, false, () => this.userSetList(new Set())));
        }
        for (const g of groups) {
            const n = g.days.filter(d => selected.has(d)).length;
            const checked = n === g.days.length && this.sel.kind !== "all";
            const partial = n > 0 && !checked;
            list.appendChild(this.listItem(g.label, checked, partial, () => {
                let next: Set<number>;
                if (single) {
                    next = checked ? new Set() : new Set(g.days);
                } else {
                    next = new Set(selected);
                    if (checked) g.days.forEach(d => next.delete(d));
                    else g.days.forEach(d => next.add(d));
                }
                this.userSetList(next);
            }, single));
        }
        if (!groups.length) list.appendChild(el("div", "rds-empty", "No matches"));
        container.appendChild(list);
    }

    private renderTree(container: HTMLElement, selected: Set<number>, single: boolean) {
        const sl = this.settings.slicer;
        const mode = sl.granularity.value.value === "treeWeek" ? "week" : sl.showQuarters.value ? "quarter" : "month";
        const roots = buildTree(this.dates, mode, dn => this.label(dn));
        const expanded = this.treeExpanded ?? autoExpanded(roots, this.sel.kind === "all" ? new Set() : selected);
        const list = el("div", "rds-list rds-tree");
        list.setAttribute("role", "tree");
        if (sl.showSelectAll.value && !single) {
            list.appendChild(this.listItem("Select all", this.sel.kind === "all", false, () => this.userSetList(new Set())));
        }
        const toggle = (n: TreeNode, state: string) => {
            let next: Set<number>;
            if (single) {
                next = state === "checked" && selected.size === n.days.length ? new Set() : new Set(n.days);
            } else {
                next = this.sel.kind === "all" ? new Set() : new Set(selected);
                if (state === "checked") n.days.forEach(d => next.delete(d));
                else n.days.forEach(d => next.add(d));
            }
            this.userSetList(next);
        };
        const draw = (n: TreeNode) => {
            const state = this.sel.kind === "all" ? "none" : checkState(n, selected);
            const row = el("div", "rds-tree-row");
            row.style.paddingLeft = `${n.level * 14}px`;
            const open = expanded.has(n.key);
            if (n.children.length) {
                const caret = iconButton(open ? ICONS.chevronDown : ICONS.chevronRight, (open ? "Collapse " : "Expand ") + n.label, () => {
                    const set = new Set(expanded);
                    if (open) set.delete(n.key); else set.add(n.key);
                    this.treeExpanded = set;
                    this.render();
                }, "rds-caret-btn");
                caret.setAttribute("aria-expanded", String(open));
                row.appendChild(caret);
            } else {
                row.appendChild(el("span", "rds-caret-spacer"));
            }
            const item = this.listItem(n.label, state === "checked", state === "partial", () => toggle(n, state), single);
            item.setAttribute("role", "treeitem");
            row.appendChild(item);
            list.appendChild(row);
            if (open) n.children.forEach(draw);
        };
        roots.forEach(draw);
        container.appendChild(list);
    }

    private listItem(text: string, checked: boolean, partial: boolean, onClick: () => void, radio = false): HTMLElement {
        const item = document.createElement("button");
        item.className = "rds-item" + (checked ? " checked" : "") + (partial ? " partial" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(checked));
        const box = el("span", "rds-check" + (radio ? " radio" : ""));
        item.appendChild(box);
        item.appendChild(el("span", "rds-item-label", text));
        item.addEventListener("click", onClick);
        return item;
    }

    private renderList(body: HTMLElement) { this.renderListInto(body); }

    private renderDropdown(body: HTMLElement) {
        const btn = document.createElement("button");
        btn.className = "rds-dropdown-btn";
        btn.setAttribute("aria-expanded", String(this.dropdownOpen));
        btn.appendChild(el("span", "", this.summaryText()));
        const caret = el("span", "rds-caret");
        caret.appendChild(svgIcon(this.dropdownOpen ? ICONS.chevronUp : ICONS.chevronDown));
        btn.appendChild(caret);
        btn.addEventListener("click", () => { this.dropdownOpen = !this.dropdownOpen; this.render(); });
        const row = el("div", "rds-dropdown-row");
        row.appendChild(btn);
        this.addInlineButtons(row);
        body.appendChild(row);
        if (this.dropdownOpen) {
            const panel = el("div", "rds-dropdown-panel");
            this.renderListInto(panel);
            body.appendChild(panel);
        }
    }

    private summaryText(): string {
        const s = this.sel;
        if (s.kind === "all") return "All";
        if (this.isDefault) return describeSpec(this.defaultSpec());
        if (s.kind === "list") {
            if (s.days.size === 1) return this.label(Array.from(s.days)[0]);
            return `${s.days.size} dates selected`;
        }
        const st = s.start == null ? "…" : this.label(s.start);
        const en = s.end == null ? "…" : this.label(s.end);
        return `${st} – ${en}`;
    }

    // ---- relative

    private renderRelative(body: HTMLElement) {
        const spec = this.relSpec ?? this.defaultSpec();
        this.relSpec = spec;
        const row = el("div", "rds-rel-row");
        const update = (patch: Partial<RangeSpec>) => {
            this.relSpec = { ...spec, ...patch, weekStart: this.weekStart() };
            this.applyRelative(true);
            this.render();
        };
        row.appendChild(select("Range type", [
            ["last", "Last"], ["lastCalendar", "Last (calendar)"], ["this", "This"], ["toDate", "To date"], ["next", "Next"]
        ], spec.type, v => update({ type: v as RangeType })));
        if (spec.type === "last" || spec.type === "lastCalendar" || spec.type === "next") {
            const n = document.createElement("input");
            n.type = "number";
            n.min = "1";
            n.className = "rds-num";
            n.value = String(spec.count);
            n.setAttribute("aria-label", "Number of periods");
            n.addEventListener("change", () => update({ count: Math.max(1, Math.floor(Number(n.value) || 1)) }));
            row.appendChild(n);
        }
        row.appendChild(select("Unit", [
            ["day", "Days"], ["week", "Weeks"], ["month", "Months"], ["quarter", "Quarters"], ["year", "Years"]
        ], spec.unit, v => update({ unit: v as Unit })));
        this.addInlineButtons(row);
        body.appendChild(row);

        const inc = el("label", "rds-check-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = spec.includeToday;
        cb.addEventListener("change", () => update({ includeToday: cb.checked }));
        inc.appendChild(cb);
        inc.appendChild(document.createTextNode(" Include today"));
        body.appendChild(inc);

        const r = computeRange(spec, todayDn());
        body.appendChild(el("div", "rds-rel-result", `${this.label(r.start)} – ${this.label(r.end)}`));
    }
}

// ------------------------------------------------------------------ helpers

function el(tag: string, className: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

/** 16x16 line icons (stroke paths), drawn as SVG so they look the same in every font. */
const ICONS = {
    // counter-clockwise arrow: "reset to default"
    reset: ["M2.5 8a5.5 5.5 0 1 0 1.7-3.98", "M2.2 1.8v3.2h3.2"],
    // eraser, like Power BI's "Clear selections"
    eraser: ["M9.2 2.6l4.2 4.2a1 1 0 0 1 0 1.4L8.1 13.5H5.3L2.6 10.8a1 1 0 0 1 0-1.4l5.2-5.2a1 1 0 0 1 1.4 0z",
        "M5.6 6.4l4 4", "M8.1 13.5H14"],
    calendar: ["M2.5 3.5h11v10h-11z", "M2.5 6.5h11", "M5.5 1.8v3", "M10.5 1.8v3"],
    chevronDown: ["M4 6l4 4 4-4"],
    chevronUp: ["M4 10l4-4 4 4"],
    chevronLeft: ["M10 4L6 8l4 4"],
    chevronRight: ["M6 4l4 4-4 4"],
    chevronsLeft: ["M8 4L4 8l4 4", "M12 4L8 8l4 4"],
    chevronsRight: ["M4 4l4 4-4 4", "M8 4l4 4-4 4"]
};

function svgIcon(paths: string[]): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of paths) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "currentColor");
        p.setAttribute("stroke-width", "1.3");
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        svg.appendChild(p);
    }
    return svg;
}

function iconButton(icon: string[], label: string, onClick: () => void, extraClass = ""): HTMLElement {
    const b = document.createElement("button");
    b.className = "rds-icon-btn " + extraClass;
    b.appendChild(svgIcon(icon));
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}

function select(aria: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
    const s = document.createElement("select");
    s.className = "rds-select";
    s.setAttribute("aria-label", aria);
    for (const [v, t] of options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        o.selected = v === value;
        s.appendChild(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
}

/** Accepts 2026-11-19, 11/19/2026, Nov 19, 2026, 19 Nov 2026 ... (English). */
function parseUserDate(text: string, dayFirst = false): number | null {
    const t = text.trim();
    if (!t) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
    if (m) {
        const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
        return dayFirst ? valid(y, +m[2], +m[1]) : valid(y, +m[1], +m[2]); // M/D/Y unless D/M/Y format
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : dnFromYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());

    function valid(y: number, mo: number, da: number): number | null {
        if (mo < 1 || mo > 12 || da < 1 || da > daysInMonth(y, mo)) return null;
        return dnFromYMD(y, mo, da);
    }
}
