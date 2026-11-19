"use strict";

import { ymdFromDn, dnFromYMD, dow } from "./dateUtils";

export type TreeMode = "month" | "quarter" | "week";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * ISO 8601 week: weeks start on Monday, week 1 is the week containing the year's first Thursday.
 * The ISO week-year can differ from the calendar year (e.g. 2025-12-29 is in week 1 of 2026).
 */
export function isoWeek(dn: number): { year: number; week: number; start: number; end: number } {
    const thursday = dn - ((dow(dn) + 6) % 7) + 3;
    const year = ymdFromDn(thursday).y;
    const week = Math.floor((thursday - dnFromYMD(year, 1, 1)) / 7) + 1;
    return { year, week, start: thursday - 3, end: thursday + 3 };
}

function shortDate(dn: number): string {
    const { m, d } = ymdFromDn(dn);
    return `${SHORT[m - 1]} ${d}`;
}

export interface TreeNode {
    key: string;
    label: string;
    level: number;
    days: number[];          // every date (dn) under this node
    children: TreeNode[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

/** Year › (Quarter) › Month › Day, or ISO Year › ISO Week › Day, built from the dates in the data. Newest first. */
export function buildTree(dates: number[], mode: TreeMode, dayLabel: (dn: number) => string): TreeNode[] {
    const years: TreeNode[] = [];
    const byKey = new Map<string, TreeNode>();
    const sorted = [...dates].sort((a, b) => b - a);
    const node = (key: string, label: string, level: number, parent: TreeNode[] | null): TreeNode => {
        let n = byKey.get(key);
        if (!n) {
            n = { key, label, level, days: [], children: [] };
            byKey.set(key, n);
            (parent ?? years).push(n);
        }
        return n;
    };
    for (const dn of sorted) {
        const { y, m } = ymdFromDn(dn);
        if (mode === "week") {
            const w = isoWeek(dn);
            const yn = node(`y${w.year}`, String(w.year), 0, null);
            const wn = node(`w${w.year}-${w.week}`, `Week ${w.week} · ${shortDate(w.start)} – ${shortDate(w.end)}`, 1, yn.children);
            const dnode = node(`d${dn}`, dayLabel(dn), 2, wn.children);
            dnode.days.push(dn);
            wn.days.push(dn);
            yn.days.push(dn);
            continue;
        }
        const yn = node(`y${y}`, String(y), 0, null);
        let parent = yn;
        if (mode === "quarter") {
            const q = Math.floor((m - 1) / 3) + 1;
            parent = node(`q${y}-${q}`, `Q${q}`, 1, yn.children);
        }
        const mn = node(`m${y}-${m}`, MONTHS[m - 1], parent.level + 1, parent.children);
        const dnode = node(`d${dn}`, dayLabel(dn), mn.level + 1, mn.children);
        dnode.days.push(dn);
        mn.days.push(dn);
        if (parent !== yn) parent.days.push(dn);
        yn.days.push(dn);
    }
    return years;
}

export type CheckState = "checked" | "partial" | "none";

export function checkState(n: TreeNode, selected: Set<number>): CheckState {
    let c = 0;
    for (const d of n.days) if (selected.has(d)) c++;
    return c === 0 ? "none" : c === n.days.length ? "checked" : "partial";
}

/**
 * Nodes to open automatically so the edges of the selection are visible:
 * every partially selected node. If nothing is partial, open the newest year.
 */
export function autoExpanded(roots: TreeNode[], selected: Set<number>): Set<string> {
    const out = new Set<string>();
    const walk = (n: TreeNode) => {
        if (!n.children.length) return;
        if (checkState(n, selected) === "partial") out.add(n.key);
        n.children.forEach(walk);
    };
    roots.forEach(walk);
    if (!out.size && roots[0]) out.add(roots[0].key);
    return out;
}

/** True if `days` is one unbroken run of the dates present in the data. */
export function isContiguous(days: number[], allDatesSorted: number[]): boolean {
    if (!days.length) return false;
    const s = [...days].sort((a, b) => a - b);
    const i0 = allDatesSorted.indexOf(s[0]);
    if (i0 < 0) return false;
    for (let k = 0; k < s.length; k++) if (allDatesSorted[i0 + k] !== s[k]) return false;
    return true;
}
