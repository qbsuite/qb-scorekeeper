// meter_worker.js — the room server wrapped in a meter, for
// tests/sim_buzzers.mjs only (never deployed). Same worker and RoomDO as
// rooms/worker.js; the subclass counts every inbound frame by type and
// every storage operation, and GET /__meter reads the totals (DELETE
// zeroes them). Local dev runs the Worker and every room's Durable
// Object in one isolate, so one module-level tally sees them all.
// (What rooms send out is counted by the simulated clients instead: the
// buzz winner goes out from a timer, after the handler returns.)
import worker, { RoomDO as Base } from '../../rooms/worker.js';

const blank = () => ({ inbound: {}, connects: 0,
  storage: { get: 0, put: 0, delete: 0, deleteAll: 0, setAlarm: 0, deleteAlarm: 0 } });
let meter = blank();

export class RoomDO extends Base {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = new Proxy(ctx.storage, {
      get(target, key) {
        const v = target[key];
        if (typeof v !== 'function') return v;
        return (...a) => {
          if (key in meter.storage) {
            // a get/put of several keys is one call but several rows
            meter.storage[key] += key === 'get' && Array.isArray(a[0]) ? a[0].length : 1;
          }
          return v.apply(target, a);
        };
      },
    });
    const origCtx = ctx;
    this.ctx = new Proxy(origCtx, {
      get(target, key) {
        if (key === 'storage') return storage;
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') meter.connects++;
    return super.fetch(request);
  }

  async webSocketMessage(ws, raw) {
    let t = '?';
    try { t = JSON.parse(raw).t; } catch (e) { /* counted as '?' */ }
    meter.inbound[t] = (meter.inbound[t] || 0) + 1;
    return super.webSocketMessage(ws, raw);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__meter') {
      if (request.method === 'DELETE') meter = blank();
      return Response.json(meter);
    }
    return worker.fetch(request, env, ctx);
  },
};
