"use strict";

/* Loads MMM-NetworkStatus.js inside a minimal MagicMirror-like harness so the
 * frontend logic (state machine, formatting, DOM building) can be tested
 * without a browser. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const TRANSLATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, "translations", "en.json"), "utf8"));

/* ---------- tiny DOM stub ---------- */

function createElement (tag) {
  const node = {
    tagName: tag,
    children: [],
    _classes: new Set(),
    _text: "",
    style: {},
    get className () {
      return [...node._classes].join(" ");
    },
    set className (value) {
      node._classes = new Set(String(value).split(/\s+/).filter(Boolean));
    },
    classList: {
      add: (...names) => names.forEach((n) => node._classes.add(n)),
      remove: (...names) => names.forEach((n) => node._classes.delete(n)),
      contains: (n) => node._classes.has(n),
      toggle: (n, force) => {
        const on = force ?? !node._classes.has(n);
        if (on) node._classes.add(n);
        else node._classes.delete(n);
        return on;
      }
    },
    appendChild (child) {
      node.children.push(child);
      return child;
    },
    get textContent () {
      return node._text;
    },
    set textContent (value) {
      node._text = String(value);
    }
  };
  return node;
}

function flatten (node, out = []) {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

function findByClass (root, className) {
  return flatten(root).filter((n) => n._classes.has(className));
}

function textOf (root) {
  return flatten(root)
    .map((n) => n._text)
    .filter(Boolean)
    .join(" ");
}

/* ---------- module loader ---------- */

function loadModule () {
  let registered = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Number,
    Math,
    Object,
    JSON,
    document: { createElement },
    Log: { info () {}, warn () {}, error () {}, log () {}, debug () {} },
    Module: {
      register (name, definition) {
        registered = { name, definition };
      }
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  // lib/format.js registers itself on globalThis in a browser context.
  vm.runInContext(fs.readFileSync(path.join(ROOT, "lib", "format.js"), "utf8"), context, {
    filename: "lib/format.js"
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "MMM-NetworkStatus.js"), "utf8"), context, {
    filename: "MMM-NetworkStatus.js"
  });

  assert.ok(registered, "module should call Module.register");
  return { registered, sandbox };
}

function createInstance (configOverrides = {}) {
  const { registered, sandbox } = loadModule();
  const def = registered.definition;

  const instance = Object.create(def);
  instance.name = registered.name;
  instance.identifier = "module_1_MMM-NetworkStatus";
  instance.data = { path: "modules/MMM-NetworkStatus/" };
  instance.sent = [];
  instance.domUpdates = 0;
  instance.config = deepMerge(structuredClone(def.defaults), configOverrides);
  instance.file = (f) => `modules/MMM-NetworkStatus/${f}`;
  instance.sendSocketNotification = (notification, payload) => {
    instance.sent.push({ notification, payload });
  };
  instance.updateDom = () => {
    instance.domUpdates += 1;
  };
  instance.translate = (key, variables) => {
    const template = TRANSLATIONS[key] ?? key;
    if (!variables) return template;
    return template.replace(/\{(\w+)\}/g, (m, name) => variables[name] ?? m);
  };

  instance.start();
  return { instance, sandbox };
}

function deepMerge (base, extra) {
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof base[key] === "object") {
      deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function notify (instance, notification, payload = {}) {
  instance.socketNotificationReceived(notification, { identifier: instance.identifier, ...payload });
}

/* ---------- tests ---------- */

test("module registers with the expected name and defaults", () => {
  const { registered } = loadModule();
  assert.equal(registered.name, "MMM-NetworkStatus");
  const d = registered.definition.defaults;
  assert.equal(d.updateInterval, 30000);
  assert.equal(d.speedTestInterval, 1800000);
  assert.equal(d.showPing, true);
  assert.equal(d.showDownload, true);
  assert.equal(d.showUpload, true);
  assert.equal(d.speedTestEngine, "auto");
});

test("getTranslations exposes many languages and every file exists", () => {
  const { registered } = loadModule();
  const instance = Object.create(registered.definition);
  const table = instance.getTranslations();
  const langs = Object.keys(table);
  assert.ok(langs.length >= 20, `expected 20+ languages, got ${langs.length}`);
  assert.ok(langs.includes("en"));
  assert.ok(langs.includes("ja"));

  const englishKeys = Object.keys(TRANSLATIONS);
  for (const [lang, file] of Object.entries(table)) {
    const abs = path.join(ROOT, file);
    assert.ok(fs.existsSync(abs), `${lang}: missing ${file}`);
    const data = JSON.parse(fs.readFileSync(abs, "utf8"));
    assert.deepEqual(Object.keys(data).sort(), englishKeys.sort(), `${lang}: key mismatch`);
    for (const [key, value] of Object.entries(data)) {
      assert.ok(typeof value === "string" && value.length > 0, `${lang}.${key} must be a non empty string`);
    }
  }
});

test("start() sends its config to the node helper", () => {
  const { instance } = createInstance();
  assert.equal(instance.sent.length, 1);
  assert.equal(instance.sent[0].notification, "NETWORK_STATUS_CONFIG");
  assert.equal(instance.sent[0].payload.identifier, instance.identifier);
  assert.equal(instance.sent[0].payload.config.pingHost, "1.1.1.1");
});

test("initial DOM shows the checking state without values", () => {
  const { instance } = createInstance();
  const dom = instance.getDom();
  assert.ok(dom._classes.has("mmm-networkstatus"));
  assert.ok(!dom._classes.has("offline"));
  const text = textOf(dom);
  assert.match(text, /Checking connection/);
  assert.match(text, /--/, "unknown values render as placeholder");
});

test("online connectivity renders ping and marks the module online", () => {
  const { instance } = createInstance({ animateMeasurement: false, showLabels: true });
  notify(instance, "NETWORK_STATUS_CONNECTIVITY", {
    online: true,
    ping: { latency: 14.6, jitter: 1.2, packetLoss: 0, method: "icmp" },
    timestamp: Date.now()
  });
  const dom = instance.getDom();
  assert.equal(instance.state.online, true);
  const text = textOf(dom);
  assert.match(text, /Internet connected/);
  assert.match(text, /15 ms/);
  assert.ok(!dom._classes.has("offline"));
});

test("offline connectivity produces a red warning state", () => {
  const { instance } = createInstance();
  notify(instance, "NETWORK_STATUS_CONNECTIVITY", {
    online: false,
    reason: "DNS_ENOTFOUND",
    ping: { latency: null },
    timestamp: Date.now()
  });
  const dom = instance.getDom();
  assert.ok(dom._classes.has("offline"), "wrapper gets the offline class (red via CSS)");
  const alerts = findByClass(dom, "ns-alert");
  assert.ok(alerts.length >= 1, "warning elements are marked with ns-alert");
  const text = textOf(dom);
  assert.match(text, /NO INTERNET CONNECTION/);
  assert.match(text, /OFFLINE/);
  assert.match(text, /DNS_ENOTFOUND/);
});

test("speed test progress marks the active row as measuring and shows a moving value", () => {
  const { instance } = createInstance();
  notify(instance, "NETWORK_STATUS_CONNECTIVITY", {
    online: true,
    ping: { latency: 12 },
    timestamp: Date.now()
  });
  notify(instance, "NETWORK_STATUS_SPEEDTEST_START", { engine: "ookla" });
  notify(instance, "NETWORK_STATUS_SPEEDTEST_PROGRESS", {
    stage: "download",
    progress: 0.4,
    bandwidth: 52_000_000
  });

  const dom = instance.getDom();
  assert.equal(instance.state.testing, true);
  assert.ok(dom._classes.has("testing"));
  const measuring = findByClass(dom, "measuring");
  assert.equal(measuring.length, 1);
  assert.ok(measuring[0]._classes.has("ns-download"));
  assert.match(instance.valueNodes.download.textContent, /52\.0 Mbps/);
  assert.match(textOf(dom), /Measuring speed/);

  instance.stopLiveAnimation();
});

test("a finished speed test animates up to the final values", () => {
  const { instance } = createInstance();
  notify(instance, "NETWORK_STATUS_SPEEDTEST_START", { engine: "ookla" });
  notify(instance, "NETWORK_STATUS_SPEEDTEST_RESULT", {
    engine: "ookla",
    timestamp: Date.now(),
    result: {
      ping: { latency: 11.9, jitter: 1.5, packetLoss: 0 },
      download: { bandwidth: 94_400_000 },
      upload: { bandwidth: 18_400_000 },
      server: { name: "Example", location: "Tokyo", id: 1 },
      isp: "Example ISP"
    }
  });

  // Mid animation the values are below the target...
  assert.ok(instance.state.download < 94_400_000);

  // ...and the count-up converges to the exact result.
  instance.countUp = {};
  instance.state.ping = 11.9;
  instance.state.download = 94_400_000;
  instance.state.upload = 18_400_000;
  instance.state.testing = false;

  const dom = instance.getDom();
  const text = textOf(dom);
  assert.match(text, /94\.4 Mbps/);
  assert.match(text, /18\.4 Mbps/);
  assert.match(text, /12 ms/);
  assert.equal(findByClass(dom, "measuring").length, 0);

  instance.stopLiveAnimation();
});

test("speed test errors are surfaced in the footer", () => {
  const { instance } = createInstance();
  notify(instance, "NETWORK_STATUS_SPEEDTEST_ERROR", { engine: "ookla", error: "SPEEDTEST_TIMEOUT" });
  const dom = instance.getDom();
  const footer = findByClass(dom, "ns-footer");
  assert.equal(footer.length, 1);
  assert.match(footer[0].textContent, /Speed test failed: SPEEDTEST_TIMEOUT/);
  assert.equal(instance.state.testing, false);
});

test("severity classes reflect the configured thresholds", () => {
  const { instance } = createInstance({ animateMeasurement: false });
  instance.state.online = true;
  instance.state.ping = 300;
  instance.state.download = 2_000_000; // 2 Mbps -> bad
  instance.state.upload = 8_000_000; // 8 Mbps -> warn
  const dom = instance.getDom();
  const values = findByClass(dom, "ns-value");
  const classes = values.map((v) => v.className);
  assert.ok(classes.some((c) => c.includes("level-bad")));
  assert.ok(classes.some((c) => c.includes("level-warn")));
});

test("display toggles remove the corresponding rows", () => {
  const { instance } = createInstance({
    showStatus: false,
    showPing: false,
    showUpload: false,
    animateMeasurement: false
  });
  instance.state.online = true;
  instance.state.download = 50_000_000;
  const dom = instance.getDom();
  assert.equal(findByClass(dom, "ns-status").length, 0);
  assert.equal(findByClass(dom, "ns-ping").length, 0);
  assert.equal(findByClass(dom, "ns-upload").length, 0);
  assert.equal(findByClass(dom, "ns-download").length, 1);
});

test("speedUnit and decimals are configurable", () => {
  const { instance } = createInstance({
    animateMeasurement: false,
    speedUnit: "MB/s",
    speedDecimals: 2,
    pingDecimals: 1
  });
  instance.state.online = true;
  instance.state.ping = 12.34;
  instance.state.download = 80_000_000;
  const dom = instance.getDom();
  const text = textOf(dom);
  assert.match(text, /10\.00 MB\/s/);
  assert.match(text, /12\.3 ms/);
});

test("suspend and resume notify the backend", () => {
  const { instance } = createInstance();
  instance.suspend();
  instance.resume();
  const notifications = instance.sent.map((s) => s.notification);
  assert.ok(notifications.includes("NETWORK_STATUS_SUSPEND"));
  assert.ok(notifications.includes("NETWORK_STATUS_RESUME"));
});

test("broadcast notifications trigger a forced measurement", () => {
  const { instance } = createInstance();
  instance.notificationReceived("NETWORK_STATUS_FORCE_SPEEDTEST");
  instance.notificationReceived("NETWORK_STATUS_FORCE_CHECK");
  const notifications = instance.sent.map((s) => s.notification);
  assert.ok(notifications.includes("NETWORK_STATUS_FORCE_SPEEDTEST"));
  assert.ok(notifications.includes("NETWORK_STATUS_FORCE_CHECK"));
});

test("notifications for other instances are ignored", () => {
  const { instance } = createInstance();
  instance.socketNotificationReceived("NETWORK_STATUS_CONNECTIVITY", {
    identifier: "some_other_module",
    online: false
  });
  assert.equal(instance.state.online, null);
});

test("layout, alignment and size options end up as CSS classes", () => {
  const { instance } = createInstance({
    layout: "compact",
    alignment: "center",
    fontSize: "large",
    animateMeasurement: false
  });
  const dom = instance.getDom();
  assert.ok(dom._classes.has("layout-compact"));
  assert.ok(dom._classes.has("align-center"));
  assert.ok(dom._classes.has("size-large"));
});

test("getStyles and getScripts return the bundled assets", () => {
  const { instance } = createInstance();
  const styles = instance.getStyles();
  assert.ok(styles.includes("font-awesome.css"));
  assert.ok(styles.some((s) => s.endsWith("MMM-NetworkStatus.css")));
  const scripts = instance.getScripts();
  assert.ok(scripts.some((s) => s.endsWith("lib/format.js")));
});
