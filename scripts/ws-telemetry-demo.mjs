#!/usr/bin/env node
// Minimal WebSocket telemetry sender for testing the WebSocketSource end to end.
// It speaks the documented frame format (no "commanded" field, like a robot that only
// reports measured state). Point the app at it with ?ws=ws://localhost:8765.
//
//   npm run telemetry:demo                 port 8765, 50 Hz
//   npm run telemetry:demo -- --port 9000 --hz 100

import { WebSocketServer } from 'ws';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const port = arg('port', 8765);
const hz = arg('hz', 50);

const JOINTS = ['pelvis', 'spine', 'chest', 'neck', 'head', 'upper_arm.L', 'forearm.L', 'hand.L', 'upper_arm.R', 'forearm.R', 'hand.R', 'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R'];
const temps = Object.fromEntries(JOINTS.map((j) => [j, 34 + Math.random() * 4]));
// Rough torque constant per joint, N·m per amp, so small joints stay inside their ratings.
const KT = (j) => (j.startsWith('hand') || j === 'head' ? 0.5 : j === 'neck' ? 1.2 : j.startsWith('forearm') ? 2.2 : j.startsWith('upper_arm') ? 3.6 : 9);
let battery = 92;

const wss = new WebSocketServer({ port });
console.log(`telemetry demo on ws://localhost:${port} at ${hz} Hz`);

wss.on('connection', (ws, req) => {
  console.log('client connected', req.socket.remoteAddress);
  ws.on('close', () => console.log('client closed'));
});

const t0 = Date.now() / 1000;
setInterval(() => {
  const now = Date.now() / 1000;
  const t = now - t0;
  const wave = Math.sin(t * 1.6);
  const joints = Object.fromEntries(JOINTS.map((j) => [j, [0, 0, 0]]));
  joints['upper_arm.L'] = [-40 + 10 * wave, 0, -20 * wave];
  joints['upper_arm.R'] = [40 - 10 * wave, 0, 20 * wave];
  joints['forearm.L'] = [0, 0, -30 - 20 * wave];
  joints['forearm.R'] = [0, 0, -30 + 20 * wave];
  joints.head = [0, 40 * Math.sin(t * 0.5), 0];
  joints.chest = [3, 8 * Math.sin(t * 0.5), 0];
  joints.root = [0, -0.01 * (1 + wave) / 2, 0];

  const motors = {};
  for (const j of JOINTS) {
    const current = 0.6 + 0.8 * Math.abs(wave) + (j.startsWith('upper_arm') ? 0.9 : 0);
    temps[j] += ((27 + current * current * 5.4 - temps[j]) / 45) / hz;
    motors[j] = { temp_c: +temps[j].toFixed(2), current_a: +current.toFixed(3), torque_nm: +((current - 0.2) * KT(j)).toFixed(2) };
  }
  battery = Math.max(0, battery - 0.0004);
  const frame = JSON.stringify({ t: +now.toFixed(3), joints, motors, system: { battery_pct: +battery.toFixed(2), latency_ms: 8 + Math.random() * 4, controller_load_pct: 40 + 10 * Math.abs(wave) } });
  for (const c of wss.clients) if (c.readyState === 1) c.send(frame);
}, 1000 / hz);
