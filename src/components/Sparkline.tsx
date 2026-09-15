"use client";

interface SparklineProps {
  data: number[];
  positive?: boolean;
  width?: number;
  height?: number;
}

export function Sparkline({
  data,
  positive = true,
  width = 120,
  height = 36,
}: SparklineProps) {
  if (!data.length) {
    return (
      <div
        className="text-[10px] text-zinc-500 flex items-center"
        style={{ width, height }}
      >
        —
      </div>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;

  const points = data
    .map((v, i) => {
      const x = pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const stroke = positive ? "#34d399" : "#f87171";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      {data.length > 0 && (
        <circle
          cx={
            pad +
            ((data.length - 1) / Math.max(data.length - 1, 1)) *
              (width - pad * 2)
          }
          cy={
            height -
            pad -
            ((data[data.length - 1] - min) / range) * (height - pad * 2)
          }
          r="2.25"
          fill={stroke}
        />
      )}
    </svg>
  );
}
