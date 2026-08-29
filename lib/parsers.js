/* MMM-NetworkStatus - lib/parsers.js
 *
 * Pure parsers translating the output of the supported speed test engines
 * into one common shape:
 *
 *   {
 *     ping:     { latency: <ms>, jitter: <ms>|null, packetLoss: <%>|null },
 *     download: { bandwidth: <bits per second> },
 *     upload:   { bandwidth: <bits per second> },
 *     server:   { name, location, id } | null,
 *     isp:      <string> | null,
 *     resultUrl:<string> | null
 *   }
 *
 * Everything in here is dependency free and unit tested.
 *
 * MIT Licensed.
 */
"use strict";

const EMPTY_RESULT = () => ({
  ping: { latency: null, jitter: null, packetLoss: null },
  download: { bandwidth: null },
  upload: { bandwidth: null },
  server: null,
  isp: null,
  resultUrl: null
});

function num (value) {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a single JSONL line emitted by the official Ookla Speedtest CLI
 * (`speedtest --format=jsonl --progress=yes`).
 *
 * Returns either
 *   { kind: "progress", stage: "ping"|"download"|"upload", progress: 0..1, bandwidth, latency }
 *   { kind: "result", result: <common shape> }
 *   { kind: "error", message }
 *   null when the line carries nothing we care about.
 */
function parseOoklaLine (line) {
  if (typeof line !== "string" || !line.trim()) return null;

  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  switch (data.type) {
    case "ping": {
      const latency = num(data.ping?.latency);
      return {
        kind: "progress",
        stage: "ping",
        progress: num(data.ping?.progress) ?? num(data.progress) ?? 0,
        latency,
        jitter: num(data.ping?.jitter),
        bandwidth: null
      };
    }
    case "download":
    case "upload": {
      const section = data[data.type] || {};
      // Ookla reports bandwidth in *bytes* per second.
      const bytesPerSecond = num(section.bandwidth);
      return {
        kind: "progress",
        stage: data.type,
        progress: num(section.progress) ?? num(data.progress) ?? 0,
        bandwidth: bytesPerSecond === null ? null : bytesPerSecond * 8,
        latency: null,
        jitter: null
      };
    }
    case "result": {
      const result = EMPTY_RESULT();
      result.ping.latency = num(data.ping?.latency);
      result.ping.jitter = num(data.ping?.jitter);
      result.ping.packetLoss = num(data.packetLoss);
      const dl = num(data.download?.bandwidth);
      const ul = num(data.upload?.bandwidth);
      result.download.bandwidth = dl === null ? null : dl * 8;
      result.upload.bandwidth = ul === null ? null : ul * 8;
      if (data.server) {
        result.server = {
          name: data.server.name ?? null,
          location: data.server.location ?? null,
          id: data.server.id ?? null
        };
      }
      result.isp = data.isp ?? null;
      result.resultUrl = data.result?.url ?? null;
      return { kind: "result", result };
    }
    case "log":
      return null;
    default:
      if (data.error) return { kind: "error", message: String(data.error) };
      return null;
  }
}

/**
 * Parse the complete JSON document of the Ookla CLI (`--format=json`).
 */
function parseOoklaJson (text) {
  const parsed = safeJson(text);
  if (!parsed) return null;
  const line = parseOoklaLine(JSON.stringify({ ...parsed, type: parsed.type || "result" }));
  return line && line.kind === "result" ? line.result : null;
}

/**
 * Parse the output of the community Python client `speedtest-cli --json`.
 * Bandwidths are already bits per second there.
 */
function parseSpeedtestCliJson (text) {
  const data = safeJson(text);
  if (!data) return null;
  const result = EMPTY_RESULT();
  result.ping.latency = num(data.ping);
  result.download.bandwidth = num(data.download);
  result.upload.bandwidth = num(data.upload);
  if (data.server) {
    result.server = {
      name: data.server.sponsor ?? data.server.name ?? null,
      location: data.server.name ?? null,
      id: data.server.id ?? null
    };
  }
  result.isp = data.client?.isp ?? null;
  return result;
}

/**
 * Parse the output of `librespeed-cli --json`.
 * Speeds are reported in Mbps there.
 */
function parseLibrespeedJson (text) {
  const data = safeJson(text);
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry) return null;
  const result = EMPTY_RESULT();
  result.ping.latency = num(entry.ping);
  result.ping.jitter = num(entry.jitter);
  const dl = num(entry.download);
  const ul = num(entry.upload);
  result.download.bandwidth = dl === null ? null : dl * 1e6;
  result.upload.bandwidth = ul === null ? null : ul * 1e6;
  if (entry.server) {
    result.server = {
      name: entry.server.name ?? null,
      location: null,
      id: null
    };
  }
  result.resultUrl = entry.share ?? null;
  return result;
}

/**
 * Extract the average round trip time (ms) out of the output of the system
 * `ping` binary. Works with the iputils (Linux), BSD/macOS and Windows
 * variants and is locale tolerant because it falls back to scanning
 * `time=<x> ms` samples.
 */
function parsePingOutput (text) {
  if (typeof text !== "string" || !text.trim()) return null;

  // Linux / macOS summary line: rtt min/avg/max/mdev = 5.1/6.0/7.2/0.8 ms
  const summary = text.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/);
  if (summary) {
    return {
      latency: num(summary[2]),
      min: num(summary[1]),
      max: num(summary[3]),
      jitter: num(summary[4]),
      packetLoss: parsePacketLoss(text)
    };
  }

  // Windows: Minimum = 4ms, Maximum = 9ms, Average = 6ms
  const windows = text.match(/=\s*(\d+)ms[^=]*=\s*(\d+)ms[^=]*=\s*(\d+)ms/);
  if (windows) {
    return {
      latency: num(windows[3]),
      min: num(windows[1]),
      max: num(windows[2]),
      jitter: null,
      packetLoss: parsePacketLoss(text)
    };
  }

  // Fallback: average all "time=xx ms" samples.
  const samples = [...text.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)]
    .map((m) => num(m[1]))
    .filter((v) => v !== null);
  if (!samples.length) return null;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    latency: avg,
    min: Math.min(...samples),
    max: Math.max(...samples),
    jitter: null,
    packetLoss: parsePacketLoss(text)
  };
}

function parsePacketLoss (text) {
  const match = text.match(/([\d.]+)\s*%\s*(?:packet\s*loss|loss)/i);
  return match ? num(match[1]) : null;
}

function safeJson (text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some CLIs print warnings before the JSON document.
    const start = trimmed.search(/[[{]/);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  EMPTY_RESULT,
  parseOoklaLine,
  parseOoklaJson,
  parseSpeedtestCliJson,
  parseLibrespeedJson,
  parsePingOutput,
  parsePacketLoss,
  safeJson
};
