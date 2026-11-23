import React, { useEffect, useId, useRef, useState } from "react";
import { lineSegments } from "./insight-chart-data";

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
export function BarChart({ title, unit, rows, selected, onSelect }: {
  title: string; unit: string;
  rows: { id: string; label: string; value: number; detail?: string }[];
  selected?: string; onSelect?: (id: string) => void;
}) {
  const heading = useId(), max = Math.max(1, ...rows.map(row => row.value));
  return <figure className="insight-chart" aria-labelledby={heading}>
    <figcaption id={heading}>{title}</figcaption>
    {!rows.length ? <p>No data in this view.</p> : <>
      <p className="muted">{unit}{onSelect ? ". Select a tenant to view its daily usage below." : ""}</p>
      <div className="insight-bars">{rows.map(row => <div key={row.id}
        className={`insight-bar-row${row.id === selected ? " selected" : ""}`}>
        <div className="insight-bar-label">{onSelect ?
          <button onClick={() => onSelect(row.id)} aria-pressed={row.id === selected}>{row.label}</button> :
          <span>{row.label}</span>}{row.detail && <small>{row.detail}</small>}</div>
        <div className="insight-bar-track" aria-hidden="true"><div style={{ width: `${100 * row.value / max}%` }} /></div>
        <span className="insight-bar-value">{number(row.value)}<span className="insight-sr-only"> {unit}</span></span>
      </div>)}</div>
    </>}
  </figure>;
}
export function LineChart({ title, unit, labels, values, integers = false }: {
  title: string; unit: string; labels: string[]; values: (number | null)[]; integers?: boolean;
}) {
  const id = useId(), host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800), [selected, setSelected] = useState<number>();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(280, Math.round(element.clientWidth))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const peak = values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0);
  const rawStep = Math.max(peak, 1) / 4, magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const steps = integers ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const step = Math.max(integers ? 1 : 0, steps.find(n => n * magnitude >= rawStep)! * magnitude);
  const max = step * 4, left = 64, right = width - 18, top = 20, bottom = 230;
  const x = (index: number) => labels.length === 1 ? (left + right) / 2 : left + index / (labels.length - 1) * (right - left);
  const y = (value: number) => bottom - value / max * (bottom - top);
  const paths = lineSegments(values, x, y);
  const tickCount = Math.min(labels.length, Math.max(2, Math.floor(width / 145)));
  const tickIndexes = Array.from({ length: tickCount }, (_, n) =>
    tickCount === 1 ? 0 : Math.round(n / (tickCount - 1) * (labels.length - 1)));
  const lastValue = values.reduce<number>((last, value, i) => value === null ? last : i, 0);
  const active = Math.max(0, Math.min(selected ?? lastValue, labels.length - 1));
  const value = values[active];
  return <figure className="insight-chart" aria-labelledby={`${id}-title`}>
    <figcaption id={`${id}-title`}>{title}</figcaption>
    <p id={`${id}-description`} className="muted">{unit}. Point to the chart or use the slider to inspect each UTC time bucket.
      {!integers && " Gaps indicate no completed measurements, not zero duration."}</p>
    <div ref={host} className="insight-line-host">
      {!paths.length ? <p>No completed measurements in this range.</p> : <svg role="img" aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`} viewBox={`0 0 ${width} 275`} width="100%" height="275"
        onPointerMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          const pointer = (event.clientX - box.left) * width / box.width;
          setSelected(Math.max(0, Math.min(labels.length - 1, Math.round((pointer - left) / (right - left) * (labels.length - 1)))));
        }}>
        {[0, 1, 2, 3, 4].map(tick => <g key={tick}>
          <line className="insight-gridline" x1={left} x2={right} y1={y(step * tick)} y2={y(step * tick)} />
          <text x={left - 10} y={y(step * tick) + 4} textAnchor="end">{number(step * tick)}</text>
        </g>)}
        {tickIndexes.map((index, i) => <text key={index} x={x(index)} y={bottom + 25}
          textAnchor={i === 0 ? "start" : i === tickIndexes.length - 1 ? "end" : "middle"}>
          {labels[index]?.slice(0, 10)}
          {labels[index]!.length > 10 && <tspan x={x(index)} dy="14">{labels[index]!.slice(11)}</tspan>}
        </text>)}
        {paths.map((d, index) => <path key={index} className="insight-line" d={d} />)}
        {values.length <= 366 && values.map((value, index) => value !== null && (values.length <= 31 ||
          ((index === 0 || values[index - 1] === null) && (index === values.length - 1 || values[index + 1] === null))) ?
          <circle key={index} className="insight-point" cx={x(index)} cy={y(value)} r="2.5" /> : null)}
        <line className="insight-cursor" x1={x(active)} x2={x(active)} y1={top} y2={bottom} />
        {value !== null && value !== undefined && <circle className="insight-point" cx={x(active)} cy={y(value)} r="5" />}
      </svg>}
    </div>
    {paths.length > 0 && <>
      <label className="insight-sr-only" htmlFor={`${id}-point`}>Data point for {title}</label>
      <input id={`${id}-point`} className="insight-chart-slider" type="range" min="0" max={Math.max(0, labels.length - 1)}
        value={active} onChange={event => setSelected(Number(event.target.value))}
        aria-valuetext={`${labels[active]} UTC: ${value === null ? "No completed measurements" : `${number(value!)} ${unit}`}`} />
      <output className="insight-chart-value" htmlFor={`${id}-point`}>
        {labels[active]} UTC: <strong>{value === null ? "No completed measurements" : `${number(value!)} ${unit}`}</strong>
      </output>
    </>}
  </figure>;
}
