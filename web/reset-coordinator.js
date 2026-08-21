(function installDocumentResetCoordinator(root) {
  class DocumentResetCoordinator {
    constructor({ hostRequired = false } = {}) {
      this.hostRequired = hostRequired === true;
      this.adoptedEpoch = 0;
      this.pending = null;
    }

    begin(rawEpoch) {
      const epoch = Number(rawEpoch);
      if (!Number.isInteger(epoch) || epoch <= this.adoptedEpoch) return false;
      if (this.pending?.epoch === epoch) return false;
      if (this.pending && epoch < this.pending.epoch) return false;
      this.pending = {
        epoch,
        hostAcknowledged: !this.hostRequired,
        resetComplete: false,
      };
      return true;
    }

    acknowledge(rawEpoch) {
      const epoch = Number(rawEpoch);
      if (!this.pending || epoch !== this.pending.epoch) return false;
      this.pending.hostAcknowledged = true;
      return this.canAdopt(epoch);
    }

    complete(rawEpoch) {
      const epoch = Number(rawEpoch);
      if (!this.pending || epoch !== this.pending.epoch) return false;
      this.pending.resetComplete = true;
      return this.canAdopt(epoch);
    }

    canAdopt(rawEpoch = this.pending?.epoch) {
      const epoch = Number(rawEpoch);
      return Boolean(
        this.pending && epoch === this.pending.epoch &&
        this.pending.hostAcknowledged && this.pending.resetComplete
      );
    }

    adopt(rawEpoch) {
      const epoch = Number(rawEpoch);
      if (!Number.isInteger(epoch) || epoch < this.adoptedEpoch) return false;
      if (this.pending && (epoch !== this.pending.epoch || !this.canAdopt(epoch))) return false;
      this.adoptedEpoch = epoch;
      this.pending = null;
      return true;
    }

    acceptsReady(rawEpoch) {
      const epoch = Number(rawEpoch);
      return !this.pending && Number.isInteger(epoch) && epoch === this.adoptedEpoch;
    }
  }

  root.TdomDocumentResetCoordinator = DocumentResetCoordinator;
})(typeof window === 'undefined' ? globalThis : window);
