"use strict";

/**
 * Pure decision logic: what to do with the filter Power BI hands us on each update.
 * Kept free of DOM/host so it can be unit-tested.
 */

export type Bounds = { start: number | null; end: number | null };

export interface DecideInput {
    initialized: boolean;          // false on the first data update after the report opens
    relativeStyle: boolean;
    defaultEnabled: boolean;
    persist: boolean;              // "Save user changes"
    storedRelCustom: boolean;      // relative style: a user rule was saved via persistProperties
    incoming: { bounds: Bounds | null; isDefault: boolean } | null; // bounds null = list filter
    incomingSig: string | null;    // raw serialization of the incoming filter
    echoSig: string | null;        // raw form of OUR last default write for today's key (null if unknown/stale)
    want: Bounds;                  // today's default, as filter bounds for the current style
}

export type Decision =
    | "applyDefault"   // (re)write today's default
    | "keepDefault"    // incoming is our own default for today: show default, do not write
    | "relativeStored" // restore the user's saved relative rule
    | "adopt";         // show whatever the incoming filter says

export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
    return !!a && !!b && a.start === b.start && a.end === b.end;
}

export function decide(i: DecideInput): Decision {
    if (!i.initialized) {
        if (i.relativeStyle) {
            if (i.persist && i.storedRelCustom) return "relativeStored";
            return i.defaultEnabled ? "applyDefault" : "adopt";
        }
        if (!i.defaultEnabled) return "adopt";
        // Save-user-changes OFF: always today's default. ON: keep a user's filter, roll a stale default.
        if (!i.persist || !i.incoming || i.incoming.isDefault) {
            if (i.incoming?.isDefault && sameBounds(i.incoming.bounds, i.want)) return "keepDefault";
            return "applyDefault";
        }
        return "adopt";
    }
    if (i.defaultEnabled && i.incoming?.isDefault) {
        // Our own write coming back (even if Power BI re-encoded the dates): never rewrite -> no loops.
        if (i.echoSig != null && i.incomingSig === i.echoSig) return "keepDefault";
        if (sameBounds(i.incoming.bounds, i.want)) return "keepDefault";
        // Stale default from a bookmark, yesterday, or the author changed N.
        return "applyDefault";
    }
    return "adopt";
}
