// chart: 棒と折れ線（UI-07、ADR 0032）。SVG を React で描く（外部のライブラリ・画像・インラインの style を使わない。CSP を守る）。
// 系列は色だけで分けない: 棒は塗り方（べた・斜線・点）、折れ線は線の種類（実線・破線・点線）と点の形（丸・四角・三角）で分け、
// 凡例は同じ形の印とラベルで並べる。棒には値を書き、軸には目盛りの数と項目の名前を書く。読み上げは、図を隠して同じ値の表を
// 画面の外に置く。目盛りは 0 から（棒を含むとき）のきりのよい刻み。位置・大きさは箱の大きさだけから決める。
import { useId } from 'react';
import type { CanvasContent } from '@buddy/contracts';
import { SeriesMark } from '../../../components/CanvasPartIcons.js';
import type { SeriesShape } from '../../../components/CanvasPartIcons.js';
import { chartNumber, niceScale } from '../../../state/canvas-content-state.js';
import type { PartProps } from './part-kit.js';

type ChartContent = Extract<CanvasContent, { component: 'chart' }>;

const MARGIN = { left: 36, right: 8, top: 10, bottom: 22 };
const LEGEND_HEIGHT = 28;
const SHAPES: readonly SeriesShape[] = ['circle', 'square', 'triangle'];
// 折れ線の線の種類（実線・破線・点線）。
const DASHES: readonly (string | undefined)[] = [undefined, '7 4', '2 4'];
const FILLS = ['solid', 'hatch', 'dots'] as const;

export function ChartPart({ item, content, box }: PartProps<ChartContent>) {
  // useId の文字（コロン・山かっこなど）は url(#…) で壊れ得るので、英数字と _ - だけにする。
  const patternId = `chart${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const width = Math.max(120, box.width);
  const height = Math.max(80, box.height - LEGEND_HEIGHT);
  const plot = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: width - MARGIN.left - MARGIN.right,
    height: height - MARGIN.top - MARGIN.bottom,
  };
  const count = content.x_labels.length;
  const hasBars = content.series.some((series) => series.mark === 'bar');
  const scale = niceScale(
    content.series.flatMap((series) => series.values),
    { includeZero: hasBars, maxTicks: plot.height >= 120 ? 5 : 3 },
  );
  const band = plot.width / count;
  const centerX = (index: number) => plot.x + band * (index + 0.5);
  const valueY = (value: number) =>
    plot.y +
    plot.height -
    ((value - scale.min) / (scale.max - scale.min)) * plot.height;
  const zeroY = valueY(Math.max(scale.min, Math.min(0, scale.max)));
  // 棒と折れ線の系列に、それぞれの中の番号（塗り方・線の種類・点の形を決める）を付ける。
  const bars = content.series.filter((series) => series.mark === 'bar');
  const lines = content.series.filter((series) => series.mark === 'line');
  const barWidth = Math.min(28, (band * 0.7) / Math.max(1, bars.length));
  const labelStep = Math.max(1, Math.ceil(36 / band));
  const fillOf = (barIndex: number) => {
    const kind = FILLS[barIndex % FILLS.length];
    return kind === 'solid' ? undefined : `url(#${patternId}-${kind})`;
  };
  return (
    <>
      <svg
        data-part="chart"
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        className="block"
      >
        <defs>
          <pattern
            id={`${patternId}-hatch`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" className="fill-surface" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              strokeWidth="3"
              className="stroke-accent"
            />
          </pattern>
          <pattern
            id={`${patternId}-dots`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <rect width="6" height="6" className="fill-surface" />
            <circle cx="3" cy="3" r="1.6" className="fill-accent" />
          </pattern>
        </defs>
        {scale.ticks.map((tick) => (
          <g key={tick} data-tick={chartNumber(tick)}>
            <line
              x1={plot.x}
              x2={plot.x + plot.width}
              y1={valueY(tick)}
              y2={valueY(tick)}
              strokeWidth="1"
              className="stroke-separator"
            />
            <text
              x={plot.x - 6}
              y={valueY(tick) + 4}
              textAnchor="end"
              className="fill-muted text-xs"
            >
              {chartNumber(tick)}
            </text>
          </g>
        ))}
        {content.x_labels.map((label, index) =>
          index % labelStep === 0 ? (
            <text
              key={index}
              x={centerX(index)}
              y={plot.y + plot.height + 16}
              textAnchor="middle"
              className="fill-muted text-xs"
            >
              {label}
            </text>
          ) : null,
        )}
        {bars.map((series, barIndex) =>
          series.values.map((value, index) => {
            const x =
              centerX(index) -
              (barWidth * bars.length) / 2 +
              barIndex * barWidth;
            const top = Math.min(valueY(value), zeroY);
            return (
              <g key={`${barIndex}-${index}`} data-bar={`${barIndex}-${index}`}>
                <rect
                  x={x + 1}
                  y={top}
                  width={Math.max(1, barWidth - 2)}
                  height={Math.max(1, Math.abs(valueY(value) - zeroY))}
                  fill={fillOf(barIndex)}
                  strokeWidth="1.5"
                  className={`stroke-accent ${fillOf(barIndex) === undefined ? 'fill-accent' : ''}`}
                />
                {band >= 28 ? (
                  <text
                    x={x + barWidth / 2}
                    y={top - 4}
                    textAnchor="middle"
                    className="fill-foreground text-xs"
                  >
                    {chartNumber(value)}
                  </text>
                ) : null}
              </g>
            );
          }),
        )}
        {lines.map((series, lineIndex) => (
          <g key={lineIndex} data-line={lineIndex}>
            <polyline
              fill="none"
              points={series.values
                .map((value, index) => `${centerX(index)},${valueY(value)}`)
                .join(' ')}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeDasharray={DASHES[lineIndex % DASHES.length]}
              className="stroke-foreground"
            />
            {series.values.map((value, index) => (
              <SeriesMark
                key={index}
                shape={SHAPES[lineIndex % SHAPES.length] ?? 'circle'}
                cx={centerX(index)}
                cy={valueY(value)}
                className="fill-surface stroke-foreground [stroke-width:2]"
              />
            ))}
          </g>
        ))}
      </svg>
      <ul
        data-legend="true"
        aria-hidden="true"
        className="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        {content.series.map((series, index) => {
          const barIndex = bars.indexOf(series);
          const lineIndex = lines.indexOf(series);
          return (
            <li
              key={index}
              data-series={series.mark}
              className="flex items-center gap-1.5 text-xs text-foreground"
            >
              <svg width="22" height="14" viewBox="0 0 22 14">
                {series.mark === 'bar' ? (
                  <rect
                    x="3"
                    y="2"
                    width="16"
                    height="10"
                    fill={
                      fillOf(barIndex) === undefined
                        ? undefined
                        : `url(#${patternId}-${FILLS[barIndex % FILLS.length]})`
                    }
                    strokeWidth="1.5"
                    className={`stroke-accent ${fillOf(barIndex) === undefined ? 'fill-accent' : ''}`}
                  />
                ) : (
                  <>
                    <line
                      x1="1"
                      x2="21"
                      y1="7"
                      y2="7"
                      strokeWidth="2"
                      strokeDasharray={DASHES[lineIndex % DASHES.length]}
                      className="stroke-foreground"
                    />
                    <SeriesMark
                      shape={SHAPES[lineIndex % SHAPES.length] ?? 'circle'}
                      cx={11}
                      cy={7}
                      r={3.5}
                      className="fill-surface stroke-foreground [stroke-width:2]"
                    />
                  </>
                )}
              </svg>
              <span>{series.label}</span>
            </li>
          );
        })}
      </ul>
      <table className="sr-only">
        <caption>{item.heading}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {content.x_labels.map((label, index) => (
              <th key={index} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {content.series.map((series, index) => (
            <tr key={index}>
              <th scope="row">{series.label}</th>
              {series.values.map((value, valueIndex) => (
                <td key={valueIndex}>{chartNumber(value)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
