// One inference at a time, from model preparation until the work has actually finished.
// CPU editing is deliberately outside this queue.
type Ticket = {
  label: string;
  work: () => Promise<unknown>;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  position?: (position: number | null) => void;
  removeAbort?: () => void;
};

export type Inference = <T>(label: string, work: () => Promise<T>, signal?: AbortSignal, position?: (position: number | null) => void) => Promise<T>;

export class InferenceQueue {
  private waiting: Ticket[] = [];
  private active: { ticket: Ticket; since: string } | null = null;
  private blocked: string | null = null;

  run: Inference = (label, work, signal, position) => {
    if (this.blocked) return Promise.reject(new Error(this.blocked));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const ticket: Ticket = { label, work, resolve, reject, signal, position };
      const abort = () => {
        const index = this.waiting.indexOf(ticket);
        if (index < 0) return; // active work owns cancellation; do not release its slot early
        this.waiting.splice(index, 1);
        ticket.removeAbort?.();
        reject(signal?.reason);
        this.positions();
      };
      signal?.addEventListener("abort", abort, { once: true });
      ticket.removeAbort = () => signal?.removeEventListener("abort", abort);
      this.waiting.push(ticket);
      this.positions();
      void this.drain();
    });
  };

  snapshot() {
    return { active: this.active ? { label: this.active.ticket.label, since: this.active.since } : null,
      waiting: this.waiting.map((ticket, index) => ({ label: ticket.label, position: index + 1 })), blocked: this.blocked };
  }

  private positions() {
    for (const [index, ticket] of this.waiting.entries()) ticket.position?.(index + 1);
  }

  private async drain() {
    if (this.active || this.blocked) return;
    const ticket = this.waiting.shift();
    if (!ticket) return;
    ticket.removeAbort?.();
    this.active = { ticket, since: new Date().toISOString() };
    ticket.position?.(null);
    this.positions();
    try {
      ticket.signal?.throwIfAborted();
      ticket.resolve(await ticket.work());
    } catch (error) {
      // A reset invalidates the compute context. Never feed the next model into it automatically.
      if (/hipError|unspecified launch failure|device-side assert|illegal memory access|GPU reset/i.test(String(error))) {
        this.blocked = "Inference stopped after a GPU/context failure. Restart the backend and RiverField web service before resuming; completed assets are retained.";
        for (const pending of this.waiting.splice(0)) {
          pending.removeAbort?.();
          pending.reject(new Error(this.blocked));
        }
      }
      ticket.reject(error);
    } finally {
      this.active = null;
      void this.drain();
    }
  }
}
