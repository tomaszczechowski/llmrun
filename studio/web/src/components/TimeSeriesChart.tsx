import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSeries {
    label: string;
    values: number[];
}

interface Props {
    times: number[];
    series: ChartSeries[];
    height?: number;
}

// uPlot has no default palette — series without a stroke draw an invisible line
// (only a white point fallback), so assign one explicitly per series.
const STROKE_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#f472b6"];

/** Thin uPlot wrapper: one time column + N value columns. */
export default function TimeSeriesChart({ times, series, height = 260 }: Props) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<uPlot | null>(null);
    const seriesCount = series.length;

    useEffect(() => {
        const host = hostRef.current;
        if (!host || seriesCount === 0) return;

        const chart = new uPlot(
            {
                width: host.clientWidth,
                height,
                ms: 1,
                series: [
                    { label: "time" },
                    ...series.map((s, i) => ({
                        label: s.label,
                        stroke: STROKE_COLORS[i % STROKE_COLORS.length] ?? "#38bdf8",
                        // size: 0 makes uPlot draw points with a negative radius and
                        // throw from inside the effect — hide them via `show` instead.
                        points: { show: false },
                    })),
                ],
                axes: [
                    {
                        space: 52,
                        values: (u, vals) => vals.map((v) => new Date(v).toLocaleTimeString([], { hour12: false })),
                    },
                    {},
                ],
                legend: { show: true },
                padding: [8, 8, 8, 8],
            },
            [times, ...series.map((s) => s.values)],
            host
        );
        chartRef.current = chart;

        // uPlot doesn't auto-resize — follow the container width.
        const ro = new ResizeObserver(() => {
            const w = host.clientWidth;
            if (w > 0 && w !== chart.width) chart.setSize({ width: w, height });
        });
        ro.observe(host);

        return () => {
            ro.disconnect();
            chart.destroy();
            chartRef.current = null;
        };
        // Recreate only when the shape changes (series count / times length on mount).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seriesCount]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        try {
            chart.setData([times, ...series.map((s) => s.values)]);
        } catch {
            // Shape mismatch transient — the recreate effect handles it.
        }
    }, [times, series, seriesCount]);

    return <div ref={hostRef} className="block w-full" />;
}
