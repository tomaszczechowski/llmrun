import { useEffect, useRef } from "react";
import uPlot from "uplot";

export interface ChartSeries {
    label: string;
    values: number[];
}

interface Props {
    times: number[];
    series: ChartSeries[];
    height?: number;
}

/** Thin uPlot wrapper: one time column + N value columns. */
export default function TimeSeriesChart({ times, series, height = 260 }: Props) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const chartRef = useRef<uPlot | null>(null);
    const seriesCount = series.length;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || seriesCount === 0) return;

        const chart = new uPlot(
            {
                series: [
                    { label: "time" },
                    ...series.map((s) => ({ label: s.label })),
                ],
                axes: [
                    {
                        space: 52,
                        values: (u, vals) => vals.map((v) => new Date(v).toLocaleTimeString([], { hour12: false })),
                    },
                    {},
                ],
                legend: { show: true },
                padding: 8,
            },
            [times, ...series.map((s) => s.values)],
            canvas
        );
        chartRef.current = chart;
        return () => {
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

    return (
        <canvas
            ref={canvasRef}
            style={{ width: "100%", height }}
            className="block"
        />
    );
}
