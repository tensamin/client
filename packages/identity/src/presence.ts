/** An epoch is installed only by a complete snapshot, never by a live push. */
export class PresenceOrder<State> {
  private epoch: string | undefined;
  private generation = -1;
  private versions = new Map<number, number>();
  private pending = new Map<
    number,
    { epoch: string; generation: number; version: number; state: State }
  >();

  install(epoch: string, generation: number): boolean | null {
    if (this.epoch !== undefined && this.epoch !== epoch) return null;
    if (generation < this.generation) return null;
    if (this.epoch === epoch && this.generation === generation) return false;
    this.epoch = epoch;
    this.generation = generation;
    this.versions.clear();
    return true;
  }

  accept(
    epoch: string,
    generation: number,
    userId: number,
    version: number,
  ): boolean {
    if (epoch !== this.epoch || generation !== this.generation) return false;
    const previous = this.versions.get(userId);
    if (previous !== undefined && version <= previous) return false;
    this.versions.set(userId, version);
    return true;
  }

  event(
    epoch: string,
    generation: number,
    userId: number,
    version: number,
    state: State,
  ): boolean {
    if (this.accept(epoch, generation, userId, version)) return true;
    if (
      (this.epoch === undefined || this.epoch === epoch) &&
      generation > this.generation
    ) {
      const previous = this.pending.get(userId);
      if (
        !previous ||
        previous.generation < generation ||
        (previous.generation === generation && previous.version < version)
      ) {
        this.pending.set(userId, { epoch, generation, version, state });
      }
    }
    return false;
  }

  takePending(): { userId: number; state: State }[] {
    const updates: { userId: number; state: State }[] = [];
    for (const [userId, update] of this.pending) {
      if (this.accept(update.epoch, update.generation, userId, update.version))
        updates.push({ userId, state: update.state });
      if (update.generation <= this.generation) this.pending.delete(userId);
    }
    return updates;
  }
}
