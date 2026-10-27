#!/usr/bin/env node
/**
 * Screenshot the running shell through the Chrome DevTools Protocol.
 *
 * A UI change is verified by looking at it, and this drives the real dev server
 * in headless Chrome — including clicking into the state under review — then
 * writes a PNG. It has no dependencies: Node's built-in `WebSocket` speaks CDP
 * directly, so nothing is added to the project to take a picture of it.
 *
 * Chrome cannot start its GPU process under this sandbox, so it runs with
 * `--no-sandbox --disable-gpu`; that is a harness requirement, not a shell one.
 *
 * Usage:
 *   node scripts/ui-shot.mjs --out /tmp/shot.png [--url http://localhost:5173/]
 *     [--width 1600] [--height 1000] [--wait 2500] [--scale 1]
 *     [--click <selector-or-text=Label>]... [--real-click <selector>]...
 *     [--real-drag <selector>,<dx>,<dy>]... [--real-drag-at <x>,<y>,<dx>,<dy>]...
 *     [--eval <js>]... [--probe <js>]...
 *     [--fresh] [--reload] [--insecure] [--clip x,y,w,h | --clip-selector <css>]
 *
 * `--click` and `--eval` run in order, each followed by another `--wait`, so a
 * capture can walk into a state: `--click .project-row --click text=Validate`.
 * `--fresh` clears localStorage first, so the shot shows default appearance
 * rather than whatever a previous run persisted.
 *
 * `--insecure` accepts a self-signed certificate, which is what a deployment reached by IP
 * presents. Without it the navigation fails on the certificate and the run dies on an opaque
 * error page before it can look at anything.
 *
 * `--real-click` sends a real mouse press and release through the browser's input
 * pipeline instead of calling `element.click()`. The difference is not academic: a
 * synthetic click dispatches straight to the element and skips hit testing, pointer
 * capture, and every listener on the way, so a control that a user cannot actually
 * click still passes. Three real defects were found only by hand after `--click`
 * reported success, which is why this exists.
 */
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Finds an element by CSS selector, or by `text=Label` among interactive nodes. */
const FIND_ELEMENT = `(function (selector) {
  if (selector.startsWith('text=')) {
    const wanted = selector.slice(5);
    return [...document.querySelectorAll('button, a, [role="button"], .project-row')]
      .find((node) => (node.textContent || '').trim().toLowerCase().includes(wanted.toLowerCase())) || null;
  }
  return document.querySelector(selector);
})`;

function parseArgs(argv) {
  const options = {
    url: 'http://localhost:5173/',
    out: null,
    width: 1600,
    height: 1000,
    wait: 2500,
    scale: 1,
    port: 9333,
    clicks: [],
    evals: [],
    probes: [],
    clip: null,
    clipSelector: null,
    fresh: false,
    reload: false,
    realClicks: [],
    realWheels: [],
    realDrags: [],
    realDragsAt: [],
    insecure: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[(index += 1)];
    if (flag === '--url') options.url = value();
    else if (flag === '--out') options.out = value();
    else if (flag === '--width') options.width = Number(value());
    else if (flag === '--height') options.height = Number(value());
    else if (flag === '--wait') options.wait = Number(value());
    else if (flag === '--scale') options.scale = Number(value());
    else if (flag === '--port') options.port = Number(value());
    else if (flag === '--click') options.clicks.push(value());
    else if (flag === '--real-click') options.realClicks.push(value());
    else if (flag === '--real-wheel') options.realWheels.push(value());
    else if (flag === '--real-drag') options.realDrags.push(value());
    else if (flag === '--real-drag-at') options.realDragsAt.push(value());
    else if (flag === '--eval') options.evals.push(value());
    else if (flag === '--probe') options.probes.push(value());
    else if (flag === '--clip-selector') options.clipSelector = value();
    else if (flag === '--clip') {
      const [x, y, width, height] = value().split(',').map(Number);
      options.clip = { x, y, width, height };
    }
    else if (flag === '--fresh') options.fresh = true;
    else if (flag === '--insecure') options.insecure = true;
    else if (flag === '--reload') options.reload = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  if (!options.out) throw new Error('--out is required.');
  return options;
}

/**
 * Press, move in steps, release — through the browser's own input pipeline.
 *
 * Pointer capture and the gesture thresholds only behave for genuine input, so a gesture has to
 * be driven this way or it is not being tested at all.
 */
async function at0(client, x, y, dx, dy, wait) {
  const at = (type, mx, my, buttons) =>
    client.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(mx),
      y: Math.round(my),
      button: 'left',
      buttons,
      clickCount: type === 'mouseMoved' && buttons === 0 ? 0 : 1,
    });
  await at('mouseMoved', x, y, 0);
  await at('mousePressed', x, y, 1);
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await at('mouseMoved', x + (dx * step) / steps, y + (dy * step) / steps, 1);
  }
  await at('mouseReleased', x + dx, y + dy, 0);
  await delay(wait);
}

/** A minimal CDP client: one socket, id-matched replies, one-shot event waits. */
class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed.')), { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    socket.addEventListener('message', (event) => this.receive(event.data));
  }

  receive(raw) {
    const message = JSON.parse(raw);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    const waiter = this.waiters.get(message.method);
    if (waiter) {
      this.waiters.delete(message.method);
      waiter(message.params);
    }
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => this.waiters.set(method, resolve));
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`Page threw: ${result.exceptionDetails.exception?.description ?? 'unknown error'}`);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForPageTarget(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Chrome exposed no page target: ${lastError?.message ?? 'timed out'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = `/tmp/ui-shot-profile-${process.pid}`;

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-breakpad',
      '--disable-crash-reporter',
      // A deployment reached by IP has no certificate a browser will accept, and a
      // navigation that fails on the certificate lands on an opaque error page where even
      // `localStorage` is denied — so `--fresh` would fail rather than the check. Opt-in,
      // because the point of the harness is to see what a real browser shows.
      ...(options.insecure ? ['--ignore-certificate-errors'] : []),
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${options.port}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  let client = null;
  try {
    const target = await waitForPageTarget(options.port);
    client = await Cdp.connect(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    // An exact viewport, independent of any window chrome or default size.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });

    const navigate = async () => {
      const loaded = client.once('Page.loadEventFired');
      await client.send('Page.navigate', { url: options.url });
      await loaded;
      await delay(options.wait);
    };

    await navigate();

    if (options.fresh) {
      await client.evaluate('window.localStorage.clear()');
      await navigate();
    }

    for (const expression of options.evals) {
      await client.evaluate(expression);
      await delay(options.wait);
    }

    // `--reload` re-reads what an eval wrote (a persisted preference, say), which
    // the page only picks up on a fresh load.
    if (options.reload) await navigate();

    // A real press and release, through the input pipeline. The coordinates are measured
    // from the element, and the press and release land on the same point so the browser
    // resolves a click the way it would for a user.
    for (const selector of options.realClicks) {
      const point = await client.evaluate(
        `(function () {
           const element = ${FIND_ELEMENT}(${JSON.stringify(selector)});
           if (!element) return null;
           element.scrollIntoView({ block: 'center' });
           const r = element.getBoundingClientRect();
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
         })()`,
      );
      if (!point) throw new Error(`No element matched --real-click "${selector}".`);
      const mouse = (type) =>
        client.send('Input.dispatchMouseEvent', {
          type,
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
        });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
      await mouse('mousePressed');
      await mouse('mouseReleased');
      await delay(options.wait);
    }

    // A real wheel over an element. `Input.dispatchMouseEvent` with `mouseWheel` goes
    // through the same pipeline a trackpad does, so the browser performs the default scroll
    // *and* the page's own wheel listeners see it — which a dispatched `WheelEvent` cannot
    // do, and which is exactly the difference between "the panel scrolls" and "the map
    // zoomed instead". `<selector>,<deltaX>,<deltaY>`; the point is the element's centre.
    for (const spec of options.realWheels) {
      const [selector, dxRaw, dyRaw] = spec.split(',');
      const point = await client.evaluate(
        `(function () {
           const element = ${FIND_ELEMENT}(${JSON.stringify(selector)});
           if (!element) return null;
           element.scrollIntoView({ block: 'center' });
           const r = element.getBoundingClientRect();
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
         })()`,
      );
      if (!point) throw new Error(`No element matched --real-wheel "${selector}".`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: point.x,
        y: point.y,
        deltaX: Number(dxRaw) || 0,
        deltaY: Number(dyRaw) || 0,
      });
      await delay(options.wait);
    }

    // A real drag: press on the element, move in steps, release. Pointer capture and the
    // gesture's own thresholds only behave for genuine input, so a pan has to be driven
    // this way or it is not being tested at all.
    for (const spec of options.realDrags) {
      const [selector, dxRaw, dyRaw] = spec.split(',');
      const from = await client.evaluate(
        `(function () {
           const element = ${FIND_ELEMENT}(${JSON.stringify(selector)});
           if (!element) return null;
           element.scrollIntoView({ block: 'center' });
           const r = element.getBoundingClientRect();
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
         })()`,
      );
      if (!from) throw new Error(`No element matched --real-drag "${selector}".`);
      await at0(client, from.x, from.y, Number(dxRaw), Number(dyRaw), options.wait);
    }

    // A drag at explicit viewport coordinates. `--real-drag` measures the element first, which
    // is the friendlier form but depends on the layout being settled when it measures; a gesture
    // that has to start at a point already known — the centre of a shape a previous step
    // selected — is stated in coordinates instead.
    for (const spec of options.realDragsAt) {
      const [xRaw, yRaw, dxRaw, dyRaw] = spec.split(',').map(Number);
      await at0(client, xRaw, yRaw, dxRaw, dyRaw, options.wait);
    }

    for (const selector of options.clicks) {
      const clicked = await client.evaluate(
        `(function () {
           const element = ${FIND_ELEMENT}(${JSON.stringify(selector)});
           if (!element) return false;
           element.scrollIntoView({ block: 'center' });
           element.click();
           return true;
         })()`,
      );
      // Fail loudly: a screenshot of the wrong state is worse than no screenshot.
      if (!clicked) throw new Error(`No element matched --click "${selector}".`);
      await delay(options.wait);
    }

    // Probes report observable state, so a visual claim can be checked rather
    // than asserted: `--probe "getComputedStyle(document.querySelector('.tab')).backgroundColor"`.
    for (const expression of options.probes) {
      const value = await client.evaluate(expression);
      console.log(`${expression} => ${JSON.stringify(value)}`);
    }

    // A clip captures one region at `--scale`, so a border or a 1px alignment can
    // be reviewed at full resolution instead of guessed at from a shrunk preview.
    // `--clip-selector` measures an element, which beats guessing coordinates.
    if (options.clipSelector) {
      const rect = await client.evaluate(
        `(() => {
           const element = document.querySelector(${JSON.stringify(options.clipSelector)});
           if (!element) return null;
           const r = element.getBoundingClientRect();
           return { x: r.x, y: r.y, width: r.width, height: r.height };
         })()`,
      );
      if (!rect) throw new Error(`No element matched --clip-selector "${options.clipSelector}".`);
      options.clip = rect;
    }

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      ...(options.clip
        ? { clip: { ...options.clip, scale: options.scale } }
        : {}),
    });
    await writeFile(options.out, Buffer.from(shot.data, 'base64'));
    console.log(`${options.out}  ${options.width}x${options.height} @${options.scale}x`);
  } finally {
    client?.close();
    chrome.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ui-shot failed: ${error.message}`);
  process.exitCode = 1;
});
