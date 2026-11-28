// 形の伸び縮みと、消える物の動き（ADR 0204）。上の中央の島・入力バーのように、中身に合わせて形が滑らかに変わる面に使う。
//
// - FluidBox: 中身（内側の要素）の大きさを測り、外側の要素の幅・高さを数値で指定する。数値どうしなので CSS の
//   transition で補間でき、中身が増えても減っても、形がばねの曲線（--ease-spring）で伸び縮みする。大きさの指定は
//   要素の style プロパティ（CSSOM）で行う。CSP の style-src 'self' が止めるのは style 属性・style 要素の解釈で、
//   CSSOM は止めない（ADR 0024 の「実行時に style 要素を差し込まない」は守る）。
//   測れない環境（サーバー側の描画・試験の DOM）では大きさを指定せず、中身の大きさのままにする。
// - usePresence: 値が null になった後も、消える動きの間だけ前の値を返す。動きの時間が 0（動きを減らす設定・試験の DOM）
//   なら、その場で null を返す。
import { useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

// 伸び縮みの transition。最初の測定が済むまで（data-fluid が ready になるまで）は動かさない（現れた瞬間に 0 から伸びない）。
const FLUID_TRANSITION =
  'data-[fluid=ready]:transition-[width,height] data-[fluid=ready]:duration-(--motion-island) data-[fluid=ready]:ease-spring motion-reduce:transition-none';

export function FluidBox({
  as: Tag = 'div',
  axis = 'both',
  className = '',
  innerClassName = '',
  children,
  ...rest
}: {
  // 外側の要素（島は section。読み上げの領域にする）。
  readonly as?: 'div' | 'section';
  // 伸び縮みさせる向き。height は幅を親に合わせ、高さだけを中身に合わせる。
  readonly axis?: 'both' | 'height';
  readonly innerClassName?: string;
  readonly children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  const outerRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (outer === null || inner === null) return;
    if (typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      const width = inner.offsetWidth;
      const height = inner.offsetHeight;
      // 測れない（表示していない・試験の DOM）ときは指定しない。
      if (width === 0 && height === 0) return;
      // 外側の縁の太さ（box-sizing: border-box）を足す。
      const edgeX = outer.offsetWidth - outer.clientWidth;
      const edgeY = outer.offsetHeight - outer.clientHeight;
      if (axis === 'both') outer.style.width = `${width + edgeX}px`;
      outer.style.height = `${height + edgeY}px`;
      // 最初の大きさを描いてから、次の変化を動かす。
      if (outer.dataset['fluid'] !== 'ready')
        requestAnimationFrame(() => {
          outer.dataset['fluid'] = 'ready';
        });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [axis]);
  return (
    <Tag
      ref={outerRef as never}
      {...rest}
      className={`overflow-clip ${axis === 'both' ? 'flex items-start justify-center' : ''} ${FLUID_TRANSITION} ${className}`}
    >
      <div
        ref={innerRef}
        className={`${axis === 'both' ? 'w-max shrink-0' : ''} ${innerClassName}`}
      >
        {children}
      </div>
    </Tag>
  );
}

// 動きの時間（CSS の変数。'520ms'・'0.52s'・'0s'）をミリ秒で読む。読めなければ 0。
export function motionMs(name: string): number {
  if (typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

// 値が null になった後も、消える動きの間（既定は --motion-move）だけ前の値を返す。
// 戻り値の leaving は、消える動きの途中か（中身を操作させない・読ませないために使う）。
export function usePresence<T>(
  value: T | null,
  duration = '--motion-move',
): { readonly shown: T | null; readonly leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  useLayoutEffect(() => {
    if (value !== null) {
      setKept(value);
      return;
    }
    const wait = motionMs(duration);
    if (wait === 0) {
      setKept(null);
      return;
    }
    const timer = window.setTimeout(() => setKept(null), wait);
    return () => window.clearTimeout(timer);
  }, [value, duration]);
  if (value !== null) return { shown: value, leaving: false };
  return { shown: kept, leaving: kept !== null };
}
