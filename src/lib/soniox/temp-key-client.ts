import { scheduleKeyRenewal, type KeyLease, type RenewalScheduleOptions } from "./reconnect";

/**
 * Manages the current temp-key lease for one Soniox connection pair. Does NOT call
 * `fetch()` itself — `getKey` is injected (DI) so this file has zero network/browser
 * dependency and is fully unit-testable. The FE wave's hook wires the real `getKey` by
 * calling `POST /api/sessions/:id/soniox-key` (response `{keys:[string], expires_at}`),
 * normalizing it into `{key, expiresAt}` (this file only ever sees ONE key string per
 * lease — picking which of `keys[]` to use for which connection is the caller's job).
 */

export type GetKeyFn = () => Promise<KeyLease>;

export class TempKeyClient {
  private lease: KeyLease | null = null;
  private cancelRenewal: (() => void) | null = null;

  constructor(
    private readonly getKey: GetKeyFn,
    private readonly renewalOpts: RenewalScheduleOptions = {},
  ) {}

  /** Fetches the initial lease (call right after the connection pair is about to open). */
  async fetchInitial(): Promise<KeyLease> {
    this.lease = await this.getKey();
    return this.lease;
  }

  get currentLease(): KeyLease | null {
    return this.lease;
  }

  /** Schedules `onRenewDue` at the current lease's TTL-leadMs (SU R7). Call after
   *  fetchInitial()/renew(). Replaces any previously scheduled renewal. */
  scheduleRenewal(onRenewDue: () => void): void {
    if (!this.lease) throw new Error("TempKeyClient: no lease to schedule renewal for");
    this.cancelRenewal?.();
    this.cancelRenewal = scheduleKeyRenewal(this.lease, onRenewDue, this.renewalOpts);
  }

  /** Fetches a fresh lease (renew flow) — caller opens a new connection pair with it,
   *  overlaps briefly with the old pair, then closes the old one. */
  async renew(): Promise<KeyLease> {
    this.lease = await this.getKey();
    return this.lease;
  }

  /** Cancels any pending scheduled renewal — call on stopCapture()/unmount. */
  dispose(): void {
    this.cancelRenewal?.();
    this.cancelRenewal = null;
  }
}
