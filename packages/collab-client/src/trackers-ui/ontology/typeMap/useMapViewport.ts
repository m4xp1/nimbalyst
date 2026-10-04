/**
 * Pan and zoom for the type map, applied straight to the DOM: dragging or
 * wheeling rewrites one `transform` attribute and never re-renders React. The
 * zoom tier (`data-zoom` on the svg) drives semantic zoom in CSS.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface View { k: number; x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

/** Below 0.3 nothing is readable; below 1 only major pills; 1.3 and up, types list their properties. */
export function zoomTier(k: number): 'tiny' | 'fit' | 'mid' | 'near' {
  if (k < 0.3) return 'tiny';
  if (k < 1) return 'fit';
  return k < 1.3 ? 'mid' : 'near';
}

export function fitView(bounds: { width: number; height: number }, viewport: { width: number; height: number }, pad = 14): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((viewport.width - pad * 2) / Math.max(bounds.width, 1), (viewport.height - pad * 2) / Math.max(bounds.height, 1))));
  return { k, x: (viewport.width - bounds.width * k) / 2, y: (viewport.height - bounds.height * k) / 2 };
}

export interface MapViewport {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  svgRef: React.RefObject<SVGSVGElement | null>;
  sceneRef: React.RefObject<SVGGElement | null>;
  percentRef: React.RefObject<HTMLSpanElement | null>;
  miniViewRef: React.RefObject<SVGRectElement | null>;
  zoomBy: (factor: number) => void;
  fit: (animate?: boolean) => void;
  /** Center a box at zoom `k` (default: keep the current zoom, at least 1). */
  focus: (box: Box, k?: number) => void;
  /** Center a map point, keeping the zoom. */
  centerOn: (x: number, y: number) => void;
  panBy: (dx: number, dy: number) => void;
  /** True while (or just after) a drag moved the map: a click then is not a selection. */
  dragged: () => boolean;
  /** Re-applies the current view (after the minimap reopens). */
  refresh: () => void;
}

export function useMapViewport(bounds: { width: number; height: number } | null): MapViewport {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SVGGElement | null>(null);
  const percentRef = useRef<HTMLSpanElement | null>(null);
  const miniViewRef = useRef<SVGRectElement | null>(null);
  const view = useRef<View>({ k: 1, x: 0, y: 0 });
  const frame = useRef<number | null>(null);
  const moved = useRef(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const apply = useCallback(() => {
    const { k, x, y } = view.current;
    sceneRef.current?.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    svgRef.current?.setAttribute('data-zoom', zoomTier(k));
    if (percentRef.current) percentRef.current.textContent = `${Math.round(k * 100)}%`;
    const canvas = canvasRef.current;
    const mini = miniViewRef.current;
    // The overview only earns its place when part of the map is off screen.
    const bounds = boundsRef.current;
    if (canvas && bounds) {
      const slack = 2;
      const whole = x >= -slack && y >= -slack && x + bounds.width * k <= canvas.clientWidth + slack && y + bounds.height * k <= canvas.clientHeight + slack;
      canvas.setAttribute('data-whole-map', whole ? 'true' : 'false');
    }
    if (canvas && mini) {
      mini.setAttribute('x', String(-x / k));
      mini.setAttribute('y', String(-y / k));
      mini.setAttribute('width', String(canvas.clientWidth / k));
      mini.setAttribute('height', String(canvas.clientHeight / k));
    }
  }, []);

  const flyTo = useCallback((target: View, animate = true) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (!animate || typeof requestAnimationFrame === 'undefined') {
      view.current = target;
      apply();
      return;
    }
    const from = { ...view.current };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 380);
      const e = 1 - (1 - t) ** 3;
      view.current = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      apply();
      frame.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  }, [apply]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    const current = view.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
    view.current = { k, x: cx - (cx - current.x) * (k / current.k), y: cy - (cy - current.y) * (k / current.k) };
    apply();
  }, [apply]);

  const size = () => ({ width: canvasRef.current?.clientWidth ?? 0, height: canvasRef.current?.clientHeight ?? 0 });

  const api = useMemo(() => ({
    zoomBy: (factor: number) => {
      const { width, height } = size();
      zoomAt(factor, width / 2, height / 2);
    },
    fit: (animate = true) => {
      if (boundsRef.current) flyTo(fitView(boundsRef.current, size()), animate);
    },
    focus: (box: Box, k?: number) => {
      const zoom = k ?? Math.max(1, view.current.k);
      const { width, height } = size();
      flyTo({ k: zoom, x: width / 2 - (box.x + box.w / 2) * zoom, y: height / 2 - (box.y + box.h / 2) * zoom });
    },
    centerOn: (x: number, y: number) => {
      const { width, height } = size();
      flyTo({ k: view.current.k, x: width / 2 - x * view.current.k, y: height / 2 - y * view.current.k });
    },
    panBy: (dx: number, dy: number) => {
      view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
      apply();
    },
    dragged: () => moved.current,
    refresh: apply,
  }), [apply, flyTo, zoomAt]);

  // Wheel zooms around the cursor; it must be non-passive to stop the page scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022)), event.clientX - rect.left, event.clientY - rect.top);
    };
    let drag: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest('.type-map-minimap, .type-map-hud')) return;
      moved.current = false;
      drag = { x: event.clientX, y: event.clientY, vx: view.current.x, vy: view.current.y, id: event.pointerId };
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!moved.current && Math.abs(dx) + Math.abs(dy) <= 3) return;
      if (!moved.current) {
        moved.current = true;
        canvas.setPointerCapture(event.pointerId);
        canvas.setAttribute('data-dragging', 'true');
      }
      view.current = { ...view.current, x: drag.vx + dx, y: drag.vy + dy };
      apply();
    };
    const onUp = () => {
      drag = null;
      canvas.removeAttribute('data-dragging');
      // Let the click that ends a drag see `dragged()`, then reset.
      setTimeout(() => { moved.current = false; }, 0);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [apply, zoomAt]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  return { canvasRef, svgRef, sceneRef, percentRef, miniViewRef, ...api };
}
