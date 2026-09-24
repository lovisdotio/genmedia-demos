'use client';
export function DataCurve({
  values,
  time,
  duration,
  label,
  unit,
  source = 'IMAGE ESTIMATE',
}: {
  values: number[];
  time: number;
  duration: number;
  label: string;
  unit: string;
  source?: string;
}) {
  const samples = values.length ? values : [0, 0],
    lo = Math.min(...samples),
    hi = Math.max(...samples),
    span = Math.max(hi - lo, 0.3),
    floor = lo - span * 0.15,
    range = span * 1.3;
  const u = Math.min(0.99999, Math.max(0, time / (duration || 1))),
    index = u * (samples.length - 1),
    a = Math.floor(index),
    value =
      samples[a] +
      (samples[Math.min(a + 1, samples.length - 1)] - samples[a]) * (index - a);
  const x = u * 240,
    y = (v: number) => 44 - ((v - floor) / range) * 38;
  const points = samples
    .map((v, i) => (i / (samples.length - 1)) * 240 + ',' + y(v))
    .join(' ');
  return (
    <div className="robot-data-cell">
      <div className="data-cell-label">
        <span>{label}</span>
        <small>{source}</small>
      </div>
      <div className="data-cell-value">
        {values.length ? value.toFixed(1) : '—'}
        <small>{unit}</small>
      </div>
      <svg
        viewBox="0 0 240 50"
        role="img"
        aria-label={label + ' over this clip. Source: ' + source}
      >
        {[8, 25, 44].map((v) => (
          <line
            key={v}
            x1="0"
            x2="240"
            y1={v}
            y2={v}
            stroke="#333"
            strokeDasharray="1 5"
          />
        ))}
        <polyline
          points={points}
          fill="none"
          stroke="#dcdcdc"
          strokeWidth="1.4"
        />
        <line x1={x} x2={x} y1="3" y2="47" stroke="#777" strokeWidth=".6" />
        <circle cx={x} cy={y(value)} r="2.5" fill="white" />
      </svg>
      <div className="data-cell-axis">
        <span>
          {values.length ? lo.toFixed(1) : '0'}
          {unit}
        </span>
        <span>
          {values.length ? hi.toFixed(1) : '0'}
          {unit}
        </span>
      </div>
    </div>
  );
}
