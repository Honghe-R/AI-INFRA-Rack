import { test } from 'vitest';
import assert from 'node:assert/strict';
import { revealReply, nearTranscriptEnd, followTranscriptEnd } from '../assistant/reply-display.js';

test('completed replies display progressively without losing Unicode, and finish exactly', () => {
  const tasks = [], seen = [];
  const text = 'Rack 😀: 中文 capacity **checked**';
  revealReply(text, (value, done) => seen.push({value,done}), {schedule: fn => {tasks.push(fn); return fn;}, cancel:()=>{}, durationMs:120, intervalMs:24});
  assert.equal(seen[0].value,'');
  while(tasks.length) tasks.shift()();
  assert.ok(seen.length>2); assert.ok(seen.length<=6);
  assert.equal(seen.at(-1).value,text);assert.equal(seen.at(-1).done,true);
  for(const item of seen) {assert.ok(text.startsWith(item.value));assert.ok(!/[\uD800-\uDBFF]$/.test(item.value));}
});
test('unmount or replacement cancels any pending reveal', () => {
  let tick, cancelled = false; const seen=[];
  const stop=revealReply('hello',value=>seen.push(value),{schedule:fn=>{tick=fn;return 42;},cancel:id=>{assert.equal(id,42);cancelled=true;}});
  stop();tick();assert.equal(cancelled,true);assert.deepEqual(seen,['']);
});
test('growth follows the latest reply but never pulls a reader away from older messages', () => {
  const list={scrollHeight:1000,clientHeight:300,scrollTop:700};
  assert.equal(nearTranscriptEnd(list),true);
  list.scrollTop=200;assert.equal(nearTranscriptEnd(list),false);
  assert.equal(followTranscriptEnd(list,false),false);assert.equal(list.scrollTop,200);
  list.scrollHeight=1200;assert.equal(followTranscriptEnd(list,true),true);assert.equal(list.scrollTop,1200);
  assert.equal(followTranscriptEnd(null,true),false);
});
