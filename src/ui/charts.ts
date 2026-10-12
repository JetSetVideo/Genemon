/** Minimal canvas charts for the Data screen (bars, histogram, line, scatter). Theme-aware. */

function setup(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number; text: string; line: string } {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = c.clientWidth || 300, h = c.clientHeight || 160;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement);
  return { g, w, h, text: cs.getPropertyValue("--text-2").trim() || "#999", line: cs.getPropertyValue("--line").trim() || "#444" };
}

export function barChart(c: HTMLCanvasElement, labels: string[], values: number[], colors: string[] | string): void {
  const { g, w, h, text, line } = setup(c);
  const max = Math.max(1e-9, ...values);
  const n = values.length;
  const bw = (w - 20) / Math.max(1, n);
  g.strokeStyle = line;
  g.beginPath();
  g.moveTo(10, h - 22);
  g.lineTo(w - 10, h - 22);
  g.stroke();
  values.forEach((v, i) => {
    const bh = ((h - 40) * v) / max;
    g.fillStyle = Array.isArray(colors) ? colors[i % colors.length] : colors;
    g.fillRect(12 + i * bw, h - 22 - bh, bw - 4, bh);
    g.fillStyle = text;
    g.font = "10px system-ui";
    g.save();
    g.translate(12 + i * bw + bw / 2, h - 8);
    g.textAlign = "center";
    g.fillText(labels[i].slice(0, 8), 0, 0);
    g.restore();
    g.fillText(String(Math.round(v * 100) / 100), 12 + i * bw, h - 26 - bh);
  });
}

export function histogram(c: HTMLCanvasElement, values: number[], bins: number, color: string, unit = ""): void {
  if (values.length === 0) {
    const { g, w, h, text } = setup(c);
    g.fillStyle = text;
    g.font = "12px system-ui";
    g.textAlign = "center";
    g.fillText("No data yet - fight a battle to fill this chart.", w / 2, h / 2);
    return;
  }
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
  const labels = counts.map((_, i) => `${Math.round(lo + (span * i) / bins)}${unit}`);
  barChart(c, labels, counts, color);
}

export function lineChart(c: HTMLCanvasElement, series: { values: number[]; color: string; label: string }[]): void {
  const { g, w, h, text, line } = setup(c);
  const all = series.flatMap((s) => s.values);
  if (all.length === 0) return;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  g.strokeStyle = line;
  g.strokeRect(8, 8, w - 16, h - 24);
  series.forEach((s, k) => {
    g.strokeStyle = s.color;
    g.lineWidth = 2;
    g.beginPath();
    s.values.forEach((v, i) => {
      const x = 8 + ((w - 16) * i) / Math.max(1, s.values.length - 1);
      const y = h - 16 - ((h - 24) * (v - lo)) / span;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = s.color;
    g.font = "10px system-ui";
    g.fillText(s.label, 14 + k * 90, h - 2);
  });
  g.fillStyle = text;
  g.fillText(String(Math.round(hi)), 12, 18);
  g.fillText(String(Math.round(lo)), 12, h - 18);
}

export function scatter(c: HTMLCanvasElement, pts: { x: number; y: number; color: string; r?: number }[], xLabel: string, yLabel: string): void {
  const { g, w, h, text, line } = setup(c);
  g.strokeStyle = line;
  g.beginPath();
  g.moveTo(w / 2, 6);
  g.lineTo(w / 2, h - 6);
  g.moveTo(6, h / 2);
  g.lineTo(w - 6, h / 2);
  g.stroke();
  for (const p of pts) {
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(w / 2 + (p.x * (w - 20)) / 2, h / 2 - (p.y * (h - 20)) / 2, p.r ?? 3, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = text;
  g.font = "10px system-ui";
  g.fillText(xLabel, w - 80, h / 2 - 4);
  g.fillText(yLabel, w / 2 + 4, 14);
}
