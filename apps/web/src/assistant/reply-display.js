/** Display animation for an already completed, server-sanitized reply; not provider streaming. */
export function revealReply(text, onText, { schedule = setTimeout, cancel = clearTimeout, durationMs = 1200, intervalMs = 24 } = {}) {
  const characters = Array.from(text);
  const step = Math.max(1, Math.ceil(characters.length / Math.max(1, Math.ceil(durationMs / intervalMs))));
  let offset = 0, timer = null, stopped = false;
  onText('', false);
  const tick = () => {
    if (stopped) return;
    offset = Math.min(characters.length, offset + step);
    onText(characters.slice(0, offset).join(''), offset === characters.length);
    if (offset < characters.length) timer = schedule(tick, intervalMs);
  };
  timer = schedule(tick, intervalMs);
  return () => { stopped = true; if (timer !== null) cancel(timer); };
}

export function nearTranscriptEnd(element) {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
}
export function followTranscriptEnd(element, following) {
  if (!element || !following) return false;
  element.scrollTop = element.scrollHeight;
  return true;
}
