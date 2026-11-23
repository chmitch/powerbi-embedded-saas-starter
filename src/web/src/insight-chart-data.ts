import type { InsightWindow } from "./insight-types";

const dayMs = 86_400_000;
export const insightPresets = [
  { value: "week", label: "Last week (7 days)", days: 7 },
  { value: "month", label: "Last month (30 days)", days: 30 },
  { value: "quarter", label: "Last quarter (90 days)", days: 90 },
  { value: "year", label: "Last year (365 days)", days: 365 },
] as const;
export type InsightPreset = typeof insightPresets[number]["value"];

export function presetWindow(preset: InsightPreset, now = new Date()): InsightWindow {
  const to = now.toISOString().slice(0, 10);
  const days = insightPresets.find(item => item.value === preset)!.days;
  return { from: new Date(Date.parse(to) - (days - 1) * dayMs).toISOString().slice(0, 10), to };
}
export function insightDates(range: InsightWindow) {
  const result: string[] = [];
  for (let at = Date.parse(range.from); at <= Date.parse(range.to); at += dayMs)
    result.push(new Date(at).toISOString().slice(0, 10));
  return result;
}
export function dailySeries(range: InsightWindow, rows: { day: string; renders: number; averageDurationMs?: number }[]) {
  const byDay = new Map(rows.map(row => [row.day, row]));
  const labels = insightDates(range);
  return {
    labels,
    counts: labels.map(day => byDay.get(day)?.renders ?? 0),
    averages: labels.map(day => {
      const row = byDay.get(day);
      return row?.renders && row.averageDurationMs !== undefined ? row.averageDurationMs / 1000 : null;
    }),
  };
}
export function hourlySeries(range: InsightWindow, rows: { day: string; hour: number; renders: number }[]) {
  const byHour = new Map(rows.map(row => [`${row.day} ${row.hour.toString().padStart(2, "0")}:00`, row.renders]));
  const labels = insightDates(range).flatMap(day => Array.from({ length: 24 }, (_, hour) =>
    `${day} ${hour.toString().padStart(2, "0")}:00`));
  return { labels, counts: labels.map(label => byHour.get(label) ?? 0) };
}
export function lineSegments(values: (number | null)[], x: (index: number) => number, y: (value: number) => number) {
  const segments: string[] = [];
  let segment = "";
  values.forEach((value, i) => {
    if (value === null) {
      if (segment) segments.push(segment);
      segment = "";
    } else segment += `${segment ? "L" : "M"}${x(i).toFixed(2)},${y(value).toFixed(2)}`;
  });
  if (segment) segments.push(segment);
  return segments;
}
