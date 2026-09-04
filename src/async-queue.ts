/** A tiny FIFO critical section used by each state owner. */
export class AsyncQueue {
  #tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async idle(): Promise<void> {
    await this.#tail
  }
}
