const compare = (a, b) => a.localeCompare(b, 'en', {numeric:true,sensitivity:'base'});
export function suggestRackSequence(placements, selectedId = null) {
  const match = name => /^(.+?)(\d+)$/.exec(name ?? '');
  const chosen = match(placements.find(p => p.rackId === selectedId)?.name)
    ?? placements.map(p => match(p.name)).filter(Boolean).sort((a,b) => compare(a[1],b[1]) || Number(a[2])-Number(b[2])).at(-1);
  return { prefix: chosen?.[1] ?? 'A', padding: Math.max(2, chosen?.[2].length ?? 2) };
}
export function rackSequenceNames(placements, {quantity = 1, prefix = 'A', startNumber = '', padding = 2} = {}) {
  const count = Number(quantity), width = Number(padding);
  if (!Number.isSafeInteger(count) || count < 1 || count > 128 || placements.length + count > 256)
    throw new Error('Add 1–128 racks at a time, within the 256-rack plan limit.');
  if (typeof prefix !== 'string' || !prefix.trim() || prefix.length > 140 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new Error('Enter a valid rack prefix (1–140 characters).');
  prefix = prefix.trim();
  if (!Number.isSafeInteger(width) || width < 1 || width > 8) throw new Error('Number padding must be from 1 to 8.');
  const used = new Set(placements.map(p => p.name.trim().toLowerCase()));
  let next;
  if (startNumber === '' || startNumber == null) {
    const suffixes=placements.flatMap(p => {
      const name=p.name.trim(); if(!name.toLowerCase().startsWith(prefix.toLowerCase())) return [];
      const tail=name.slice(prefix.length); return /^\d+$/.test(tail) ? [Number(tail)] : [];
    });
    next=Math.max(0,...suffixes)+1;
  } else next=Number(startNumber);
  const names=[];
  while(names.length<count) {
    if (!Number.isSafeInteger(next) || next < 1 || next > 99999999) throw new Error('Start number must be from 1 to 99999999.');
    const name=prefix+String(next++).padStart(width,'0');
    if(!used.has(name.toLowerCase())) {used.add(name.toLowerCase());names.push(name);}
  }
  return names;
}
