import { useEffect, useState } from 'react';

/**
 * True when the viewport is at/below the app's mobile-and-tablet breakpoint
 * (matches the 1023px the layout grids collapse at). Used to hide the filter
 * rail by default on small screens and open it as a slide-over drawer instead.
 */
export function useIsMobile(query = '(max-width: 1023px)'): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [isMobile, setIsMobile] = useState<boolean>(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}
