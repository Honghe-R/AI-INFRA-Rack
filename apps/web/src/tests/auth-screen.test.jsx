import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthScreen } from '../app/AuthGate.jsx';
import { AccountControl } from '../shell/AccountControl.jsx';

test('sign-in asks for personal credentials and exposes no role or account picker', () => {
  const html = renderToStaticMarkup(<AuthScreen />);
  for (const text of ['Account name', 'type="password"', 'Sign in', 'Contact your platform administrator']) assert.ok(html.includes(text), text);
  assert.match(html, /autocomplete="current-password"/i);
  assert.ok(!html.includes('<select')); assert.ok(!html.includes('dev-user'));
});
test('activation uses new-password fields with a clear policy; pending submits are disabled', () => {
  const html = renderToStaticMarkup(<AuthScreen activation busy error="Example failure" />);
  assert.match(html, /Confirm password/); assert.match(html, /minLength="12"/i); assert.match(html, /new-password/);
  assert.match(html, /role="alert"/); assert.match(html, /<button disabled=""/);
});
test('signed-in account control exposes own identity without the development directory', () => {
  const html = renderToStaticMarkup(<AccountControl devIdentity={{ available: false, current: { name: 'Personal user', subject: 'personal' }, signOut() {} }} />);
  assert.match(html, /Account: Personal user/); assert.match(html, /aria-haspopup="menu"/);
  assert.ok(!html.includes('Switch identity')); assert.ok(!html.includes('dev-editor')); assert.ok(!html.includes('Act as'));
});
