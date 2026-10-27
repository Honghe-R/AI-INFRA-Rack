import { useCallback, useEffect, useState } from 'react';

/**
 * A menu anchored to a control in the sidebar's bottom band.
 *
 * The placement is the reason this exists. The band sits at the bottom of the frame, so the
 * menu opens **upward**, and the sidebar clips its horizontal overflow — so an absolutely
 * positioned menu in the 64px rail is cut off at the rail's edge. Positioning it `fixed`
 * from the control's measured rect escapes that clipping, because a fixed element is not
 * clipped by an ancestor's `overflow` unless that ancestor transforms, and nothing in the
 * shell does. The clamp keeps it on screen when the sidebar is against an edge or the window
 * is narrow.
 *
 * Shared rather than written twice: two menus in the same band that disagreed about where a
 * menu goes would be worse than either being wrong.
 */
const MENU_WIDTH_PX = 320;
const MENU_MARGIN_PX = 8;

export function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const [containerRef, setContainerRef] = useState(null);
  const [placement, setPlacement] = useState(null);

  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }

    const measure = () => {
      const rect = containerRef?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(MENU_WIDTH_PX, window.innerWidth - MENU_MARGIN_PX * 2);
      const left = Math.max(MENU_MARGIN_PX, Math.min(rect.left, window.innerWidth - width - MENU_MARGIN_PX));
      setPlacement({
        left: Math.round(left),
        bottom: Math.round(window.innerHeight - rect.top + MENU_MARGIN_PX),
        width: Math.round(width),
      });
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, containerRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, containerRef]);

  const close = useCallback(() => setOpen(false), []);

  return {
    open,
    containerRef: setContainerRef,
    placement,
    toggle: useCallback(() => setOpen((value) => !value), []),
    close,
    /** Inline style for the menu, or null until it has been measured. */
    menuStyle: placement ? { left: `${placement.left}px`, bottom: `${placement.bottom}px`, width: `${placement.width}px` } : null,
  };
}
