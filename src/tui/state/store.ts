type Listener<T> = (state: T) => void

export class Store<T> {
  private state: T
  private listeners = new Set<Listener<T>>()

  constructor(initialState: T) {
    this.state = initialState
  }

  getState(): T {
    return this.state
  }

  setState(partial: Partial<T>): void {
    const prev = this.state
    this.state = { ...this.state, ...partial }
    if (Object.is(prev, this.state)) return
    this.listeners.forEach((listener) => listener(this.state))
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
