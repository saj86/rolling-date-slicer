"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings as fs } from "powerbi-visuals-utils-formattingmodel";

import Card = fs.SimpleCard;
import CompositeCard = fs.CompositeCard;
import Group = fs.Group;
import Slice = fs.Slice;
import Model = fs.Model;
import IEnumMember = powerbi.IEnumMember;

function dropdown(name: string, displayName: string, items: IEnumMember[], defaultValue: string) {
    return new fs.ItemDropdown({ name, displayName, items, value: items.find(i => i.value === defaultValue) || items[0] });
}
function toggle(name: string, displayName: string, value: boolean, description?: string) {
    return new fs.ToggleSwitch({ name, displayName, value, description });
}
function color(name: string, displayName: string, value: string) {
    return new fs.ColorPicker({ name, displayName, value: { value } });
}
function num(name: string, displayName: string, value: number, min = 0, max?: number) {
    const options: powerbi.visuals.NumUpDownFormat = { minValue: { type: powerbi.visuals.ValidatorType.Min, value: min } };
    if (max != null) options.maxValue = { type: powerbi.visuals.ValidatorType.Max, value: max };
    return new fs.NumUpDown({ name, displayName, value, options });
}
function font(size: number) {
    return new fs.FontControl({
        name: "font", displayName: "Font",
        fontFamily: new fs.FontPicker({ name: "fontFamily", value: "Segoe UI" }),
        fontSize: new fs.NumUpDown({ name: "fontSize", value: size }),
        bold: new fs.ToggleSwitch({ name: "bold", value: false }),
        italic: new fs.ToggleSwitch({ name: "italic", value: false }),
        underline: new fs.ToggleSwitch({ name: "underline", value: false })
    });
}
function transparency(name: string, value = 0) {
    return new fs.Slider({
        name, displayName: "Transparency", value,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 0 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 100 },
            unitSymbol: "%"
        }
    });
}

export const STYLE_ITEMS: IEnumMember[] = [
    { value: "list", displayName: "Vertical list" },
    { value: "tile", displayName: "Tile" },
    { value: "between", displayName: "Between" },
    { value: "before", displayName: "Before" },
    { value: "after", displayName: "After" },
    { value: "dropdown", displayName: "Dropdown" },
    { value: "relative", displayName: "Relative date" },
    { value: "datepicker", displayName: "Date picker" }
];

const UNIT_ITEMS: IEnumMember[] = [
    { value: "day", displayName: "Days" },
    { value: "week", displayName: "Weeks" },
    { value: "month", displayName: "Months" },
    { value: "quarter", displayName: "Quarters" },
    { value: "year", displayName: "Years" }
];

const RANGE_TYPE_ITEMS: IEnumMember[] = [
    { value: "last", displayName: "Last N (rolling)" },
    { value: "lastCalendar", displayName: "Last N calendar (complete periods)" },
    { value: "this", displayName: "This period (whole)" },
    { value: "toDate", displayName: "Period to date" },
    { value: "next", displayName: "Next N" }
];

// ------------------------------------------------------------------ Slicer settings

class SlicerCard extends Card {
    style = dropdown("style", "Style", STYLE_ITEMS, "between");
    // Between / Before / After / Date picker
    showInputs = toggle("showInputs", "Show dates", true);
    showCalendarIcon = toggle("showCalendarIcon", "Show date picker icon", true,
        "Calendar icon in each date. Without it, users can still type a date.");
    calendarMode = dropdown("calendarMode", "Calendar opens", [
        { value: "browser", displayName: "Pop-up (can go over other visuals)" },
        { value: "inside", displayName: "Inside the visual (range highlight)" }
    ], "browser");
    // Vertical list / Tile / Dropdown
    granularity = dropdown("granularity", "View", [
        { value: "tree", displayName: "Tree (Year › Month › Day)" },
        { value: "treeWeek", displayName: "Tree (Year › ISO week › Day)" },
        { value: "day", displayName: "Days" },
        { value: "month", displayName: "Months" },
        { value: "year", displayName: "Years" }
    ], "tree");
    tileGranularity = dropdown("tileGranularity", "Tiles show", [
        { value: "month", displayName: "Months" },
        { value: "year", displayName: "Years" },
        { value: "day", displayName: "Days" }
    ], "month");
    showBadge = toggle("showBadge", "Show default-range label", false,
        "Shows e.g. \"Last 30 days\" or \"Custom selection\".");
    badgePosition = dropdown("badgePosition", "Label position", [
        { value: "header", displayName: "In the header" },
        { value: "inline", displayName: "In front of the dates" }
    ], "header");
    showQuarters = toggle("showQuarters", "Show quarters", false);
    singleSelect = toggle("singleSelect", "Single select", false);
    showSelectAll = toggle("showSelectAll", "Show \"Select all\"", true);
    showSearch = toggle("showSearch", "Show search box", true);

    name = "slicer";
    displayName = "Slicer settings";
    slices: Slice[] = [this.style, this.showInputs, this.showCalendarIcon, this.calendarMode, this.showBadge, this.badgePosition, this.granularity, this.tileGranularity,
        this.showQuarters, this.singleSelect, this.showSelectAll, this.showSearch];
}

// ------------------------------------------------------------------ Default range

class DefaultRangeCard extends Card {
    enabled = toggle("enabled", "Default range", true);
    topLevelSlice = this.enabled;
    rangeType = dropdown("rangeType", "Range type", RANGE_TYPE_ITEMS, "last");
    count = num("count", "N", 30, 1);
    unit = dropdown("unit", "Unit", UNIT_ITEMS, "day");
    includeToday = toggle("includeToday", "Include today", true);
    persistUserChanges = toggle("persistUserChanges", "Save user changes", false,
        "Off: every time the report opens, the default range for that day is applied, even if a user changed it. On: a user's change is kept.");

    name = "defaultRange";
    displayName = "Default range (rolling)";
    slices: Slice[] = [this.rangeType, this.count, this.unit, this.includeToday, this.persistUserChanges];
}

// ------------------------------------------------------------------ Slicer header (Text / Border / Background)

class HeaderCard extends CompositeCard {
    show = toggle("show", "Slicer header", true);
    topLevelSlice = this.show;

    showTitle = toggle("showTitle", "Show title", true);
    titleText = new fs.TextInput({ name: "titleText", displayName: "Title text", value: "", placeholder: "Field name" });
    font = font(9);
    fontColor = color("fontColor", "Font color", "#252423");
    text = new Group({ name: "text", displayName: "Text",
        slices: [this.showTitle, this.titleText, this.font, this.fontColor] });

    borderShow = toggle("borderShow", "Border", false);
    borderColor = color("borderColor", "Color", "#C8C6C4");
    borderWidth = num("borderWidth", "Width", 1, 1, 10);
    borderPosition = dropdown("borderPosition", "Position", [
        { value: "bottom", displayName: "Bottom only" },
        { value: "top", displayName: "Top only" },
        { value: "topBottom", displayName: "Top + bottom" },
        { value: "frame", displayName: "Frame" }
    ], "bottom");
    border = new Group({ name: "border", displayName: "Border", topLevelSlice: this.borderShow,
        slices: [this.borderColor, this.borderWidth, this.borderPosition] });

    bgShow = toggle("bgShow", "Background", false);
    bgColor = color("bgColor", "Color", "#FFFFFF");
    bgTransparency = transparency("bgTransparency");
    background = new Group({ name: "background", displayName: "Background", topLevelSlice: this.bgShow,
        slices: [this.bgColor, this.bgTransparency] });

    name = "header";
    displayName = "Slicer header";
    groups: Group[] = [this.text, this.border, this.background];
}

// ------------------------------------------------------------------ Values (Values / Date boxes / Background)

class ValuesCard extends CompositeCard {
    font = font(9);
    fontColor = color("fontColor", "Font color", "#252423");
    accentColor = color("accentColor", "Selection color", "#118DFF");
    values = new Group({ name: "values", displayName: "Values", slices: [this.font, this.fontColor, this.accentColor] });

    boxStyle = dropdown("boxStyle", "Look", [
        { value: "boxed", displayName: "Boxes (like the native slicer)" },
        { value: "plain", displayName: "Plain text" },
        { value: "underline", displayName: "Underline" }
    ], "boxed");
    borderColor = color("borderColor", "Border color", "#B3B0AD");
    borderWidth = num("borderWidth", "Border width", 1, 1, 6);
    radius = num("radius", "Rounded corners", 2, 0, 20);
    boxes = new Group({ name: "boxes", displayName: "Date boxes",
        slices: [this.boxStyle, this.borderColor, this.borderWidth, this.radius] });

    bgShow = toggle("bgShow", "Background", true);
    bgColor = color("bgColor", "Color", "#FFFFFF");
    bgTransparency = transparency("bgTransparency");
    background = new Group({ name: "background", displayName: "Background", topLevelSlice: this.bgShow,
        slices: [this.bgColor, this.bgTransparency] });

    name = "values";
    displayName = "Values";
    groups: Group[] = [this.values, this.boxes, this.background];
}

// ------------------------------------------------------------------ Slider (Handles / Selected range / Track)

class SliderCard extends CompositeCard {
    show = toggle("show", "Slider", true);
    topLevelSlice = this.show;

    handleShape = dropdown("handleShape", "Shape", [
        { value: "bar", displayName: "Bar (like the native slicer)" },
        { value: "circle", displayName: "Circle" }
    ], "bar");
    handleBorder = color("handleBorder", "Border", "#252423");
    handleFill = color("handleFill", "Fill", "#FFFFFF");
    handleWidth = num("handleWidth", "Width", 5, 2, 30);
    handleHeight = num("handleHeight", "Height", 17, 4, 40);
    handleSize = num("handleSize", "Size", 20, 8, 40);
    handles = new Group({ name: "handles", displayName: "Handles",
        slices: [this.handleShape, this.handleBorder, this.handleFill, this.handleWidth, this.handleHeight, this.handleSize] });

    rangeColor = color("rangeColor", "Color", "#252423");
    selectedRange = new Group({ name: "selectedRange", displayName: "Selected range", slices: [this.rangeColor] });

    trackColor = color("trackColor", "Color", "#C8C6C4");
    trackHeight = num("trackHeight", "Thickness", 3, 1, 10);
    showEnds = toggle("showEnds", "Show first/last date", false);
    track = new Group({ name: "track", displayName: "Track", slices: [this.trackColor, this.trackHeight, this.showEnds] });

    name = "slider";
    displayName = "Slider";
    groups: Group[] = [this.handles, this.selectedRange, this.track];
}

// ------------------------------------------------------------------ Buttons / Layout / Dates

class ButtonsCard extends Card {
    showReset = toggle("showReset", "Reset to default button", true,
        "Shown only while the selection differs from the default range.");
    showClear = toggle("showClear", "Clear selections button (eraser)", true);
    position = dropdown("position", "Position", [
        { value: "header", displayName: "In the header" },
        { value: "inline", displayName: "Next to the dates" }
    ], "header");
    iconColor = color("iconColor", "Icon color", "#605E5C");

    name = "buttons";
    displayName = "Buttons";
    slices: Slice[] = [this.showReset, this.showClear, this.position, this.iconColor];
}

class LayoutCard extends Card {
    paddingTop = num("paddingTop", "Padding top", 4, 0, 200);
    paddingRight = num("paddingRight", "Padding right", 6, 0, 200);
    paddingBottom = num("paddingBottom", "Padding bottom", 4, 0, 200);
    paddingLeft = num("paddingLeft", "Padding left", 6, 0, 200);
    verticalAlign = dropdown("verticalAlign", "Vertical position", [
        { value: "top", displayName: "Top" },
        { value: "center", displayName: "Middle" },
        { value: "bottom", displayName: "Bottom" }
    ], "top");
    gap = num("gap", "Space between rows", 8, 0, 60);

    name = "layout";
    displayName = "Layout & padding";
    slices: Slice[] = [this.paddingTop, this.paddingRight, this.paddingBottom, this.paddingLeft, this.verticalAlign, this.gap];
}

class DateFormatCard extends Card {
    format = dropdown("format", "Date format", [
        { value: "mdy", displayName: "11/19/2026" },
        { value: "dmy", displayName: "19/11/2026" },
        { value: "medium", displayName: "Nov 19, 2026" },
        { value: "short", displayName: "11/19/26" },
        { value: "long", displayName: "November 19, 2026" },
        { value: "iso", displayName: "2026-11-19" }
    ], "mdy");
    weekStart = dropdown("weekStart", "Week starts on", [
        { value: "1", displayName: "Monday" },
        { value: "0", displayName: "Sunday" },
        { value: "6", displayName: "Saturday" }
    ], "1");

    name = "dateFormat";
    displayName = "Dates";
    slices: Slice[] = [this.format, this.weekStart];
}

export class VisualFormattingSettingsModel extends Model {
    slicer = new SlicerCard();
    defaultRange = new DefaultRangeCard();
    header = new HeaderCard();
    values = new ValuesCard();
    slider = new SliderCard();
    buttons = new ButtonsCard();
    layout = new LayoutCard();
    dateFormat = new DateFormatCard();
    cards = [this.slicer, this.defaultRange, this.header, this.values, this.slider, this.buttons, this.layout, this.dateFormat];

    /** Show only the options that apply to the chosen style. */
    public applyVisibility() {
        const style = this.slicer.style.value.value as string;
        const isList = style === "list" || style === "dropdown";
        const isTile = style === "tile";
        const hasDates = style === "between" || style === "before" || style === "after" || style === "datepicker";
        const view = this.slicer.granularity.value.value as string;
        const s = this.slicer;
        s.showInputs.visible = hasDates;
        s.showCalendarIcon.visible = hasDates && s.showInputs.value;
        s.calendarMode.visible = s.showCalendarIcon.visible && s.showCalendarIcon.value;
        s.granularity.visible = isList;
        s.tileGranularity.visible = isTile;
        s.showQuarters.visible = isList && view === "tree";
        s.singleSelect.visible = isList || isTile;
        s.showSelectAll.visible = isList || isTile;
        s.showSearch.visible = isList;
        this.slider.visible = hasDates;
        this.values.boxes.visible = hasDates;
        const circle = this.slider.handleShape.value.value === "circle";
        this.slider.handleFill.visible = circle;
        this.slider.handleSize.visible = circle;
        this.slider.handleWidth.visible = !circle;
        this.slider.handleHeight.visible = !circle;
        const boxed = this.values.boxStyle.value.value !== "plain";
        this.values.borderColor.visible = boxed;
        this.values.borderWidth.visible = boxed;
        this.values.radius.visible = this.values.boxStyle.value.value === "boxed";
        const t = this.defaultRange.rangeType.value.value as string;
        this.defaultRange.count.visible = t === "last" || t === "lastCalendar" || t === "next";
        this.defaultRange.includeToday.visible = t !== "this";
        this.buttons.showReset.visible = this.defaultRange.enabled.value;
        this.buttons.position.visible = hasDates;
        this.header.titleText.visible = this.header.showTitle.value;
        s.showBadge.visible = this.defaultRange.enabled.value;
        // With the header off the label always sits in front of the dates.
        s.badgePosition.visible = s.showBadge.visible && s.showBadge.value && this.header.show.value;
    }
}
