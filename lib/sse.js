/**
 * Diffusion Server-Sent Events vers les onglets connectés.
 */
export class Hub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => this.ping(), 25_000);
    this.timer.unref();
  }

  add(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connecté\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }

  ping() {
    for (const res of this.clients) {
      try { res.write(': ping\n\n'); } catch { this.clients.delete(res); }
    }
  }
}
