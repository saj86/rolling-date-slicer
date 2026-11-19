"use strict";

/**
 * Pure date helpers. A "day number" (dn) is the count of days since 1970-01-01
 * for a *calendar date* (no time, no timezone). All range math is done on dn so
 * there are no DST / UTC-offset off-by-one errors.
 */

export type Unit = "day" | "week" | "month" | "quarter" | "year";
export type RangeType =
    "last"          // rolling: last N units ending today (or yesterday)
    | "lastCalendar"  // last N complete calendar units (e.g. previous 3 full months)
    | "this"          // the whole current unit (this month)
    | "toDate"        // current unit up to today (month-to-date)
    | "next";         // next N units starting today (or tomorrow)

export interface RangeSpec {
    type: RangeType;
    count: number;
    unit: Unit;
    includeToday: boolean;
    weekStart: number; // 0 = Sunday, 1 = Monday, 6 = Saturday
}

export interface DayRange { start: number; end: number; } // inclusive

const MS_DAY = 86400000;

export function dnFromYMD(y: number, m: number, d: number): number {
    return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

export function ymdFromDn(dn: number): { y: number; m: number; d: number } {
    const dt = new Date(dn * MS_DAY);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Today's calendar date in the viewer's local time zone. */
export function todayDn(now: Date = new Date()): number {
    return dnFromYMD(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Day of week, 0 = Sunday. */
export function dow(dn: number): number {
    return ((dn % 7) + 7 + 4) % 7; // 1970-01-01 was a Thursday
}

export function daysInMonth(y: number, m: number): number {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(dn: number, months: number): number {
    const { y, m, d } = ymdFromDn(dn);
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = total - ny * 12 + 1;
    return dnFromYMD(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

function monthsPer(unit: Unit): number {
    return unit === "month" ? 1 : unit === "quarter" ? 3 : unit === "year" ? 12 : 0;
}

/** Shift a date by k units (calendar aware). */
export function addUnits(dn: number, unit: Unit, k: number): number {
    if (unit === "day") return dn + k;
    if (unit === "week") return dn + 7 * k;
    return addMonths(dn, monthsPer(unit) * k);
}

export function startOfUnit(dn: number, unit: Unit, weekStart: number): number {
    if (unit === "day") return dn;
    if (unit === "week") return dn - ((dow(dn) - weekStart + 7) % 7);
    const { y, m } = ymdFromDn(dn);
    if (unit === "month") return dnFromYMD(y, m, 1);
    if (unit === "quarter") return dnFromYMD(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
    return dnFromYMD(y, 1, 1);
}

export function computeRange(spec: RangeSpec, today: number): DayRange {
    const n = Math.max(1, Math.floor(spec.count || 1));
    const { unit, weekStart } = spec;
    switch (spec.type) {
        case "last": {
            const end = spec.includeToday ? today : today - 1;
            // "Last 30 days" ending today = today-29 .. today.
            // "Last 3 months" ending 2026-11-19 = 2026-08-20 .. 2026-11-19.
            return { start: addUnits(end, unit, -n) + 1, end };
        }
        case "lastCalendar": {
            const cur = startOfUnit(today, unit, weekStart);
            if (spec.includeToday) {
                // N-1 previous full units + current unit up to today
                return { start: addUnits(cur, unit, -(n - 1)), end: today };
            }
            return { start: addUnits(cur, unit, -n), end: cur - 1 };
        }
        case "this": {
            const s = startOfUnit(today, unit, weekStart);
            return { start: s, end: addUnits(s, unit, 1) - 1 };
        }
        case "toDate": {
            const s = startOfUnit(today, unit, weekStart);
            return { start: s, end: spec.includeToday ? today : Math.max(s, today - 1) };
        }
        case "next": {
            const start = spec.includeToday ? today : today + 1;
            return { start, end: addUnits(start, unit, n) - 1 };
        }
    }
    return { start: today, end: today };
}

/** Human description, e.g. "Last 30 days". */
export function describeSpec(spec: RangeSpec): string {
    const n = Math.max(1, Math.floor(spec.count || 1));
    const u = n === 1 ? spec.unit : spec.unit + "s";
    switch (spec.type) {
        case "last": return `Last ${n} ${u}${spec.includeToday ? "" : " (excl. today)"}`;
        case "lastCalendar": return `Last ${n} calendar ${u}${spec.includeToday ? " (incl. current)" : ""}`;
        case "this": return `This ${spec.unit}`;
        case "toDate": return `${spec.unit[0].toUpperCase()}${spec.unit.slice(1)} to date`;
        case "next": return `Next ${n} ${u}`;
    }
    return "";
}

/** Convert a value coming from the data view (Date in local time, or string/number) to a dn. */
export function dnFromDataValue(v: unknown): number | null {
    if (v == null) return null;
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return null;
        return dnFromYMD(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    if (typeof v === "string") return dnFromIso(v);
    if (typeof v === "number") {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : dnFromYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    return null;
}

/**
 * Filter values: we write the calendar date as "YYYY-MM-DDT00:00:00.000Z" (no UTC
 * shift from the local time zone) and read back the Y-M-D part.
 */
export function isoFromDn(dn: number, endOfDay = false): string {
    const { y, m, d } = ymdFromDn(dn);
    const p = (x: number, l = 2) => String(x).padStart(l, "0");
    return `${p(y, 4)}-${p(m)}-${p(d)}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
}

export function dnFromIso(v: unknown): number | null {
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return null;
        return dnFromYMD(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    }
    if (typeof v !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return dnFromYMD(+m[1], +m[2], +m[3]);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : dnFromYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Grouping key for list mode granularity. */
export function groupKey(dn: number, gran: "day" | "month" | "year"): number {
    if (gran === "day") return dn;
    const { y, m } = ymdFromDn(dn);
    return gran === "month" ? dnFromYMD(y, m, 1) : dnFromYMD(y, 1, 1);
}

export type DateFormat = "iso" | "short" | "medium" | "long" | "dmy" | "mdy";

export function formatDn(dn: number, fmt: DateFormat, locale = "en-US", gran: "day" | "month" | "year" = "day"): string {
    const { y, m, d } = ymdFromDn(dn);
    const p = (x: number) => String(x).padStart(2, "0");
    const dt = new Date(Date.UTC(y, m - 1, d));
    const loc = "en-US"; void locale; // English-only slicer
    if (gran === "year") return String(y);
    if (gran === "month") {
        if (fmt === "iso") return `${y}-${p(m)}`;
        return new Intl.DateTimeFormat(loc, { timeZone: "UTC", year: "numeric", month: fmt === "long" ? "long" : "short" }).format(dt);
    }
    switch (fmt) {
        case "iso": return `${y}-${p(m)}-${p(d)}`;
        case "dmy": return `${p(d)}/${p(m)}/${y}`;
        case "mdy": return `${p(m)}/${p(d)}/${y}`;
        case "short": return new Intl.DateTimeFormat(loc, { timeZone: "UTC", dateStyle: "short" }).format(dt);
        case "long": return new Intl.DateTimeFormat(loc, { timeZone: "UTC", dateStyle: "long" }).format(dt);
        default: return new Intl.DateTimeFormat(loc, { timeZone: "UTC", dateStyle: "medium" }).format(dt);
    }
}
