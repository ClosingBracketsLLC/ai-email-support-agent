import type { MeterSink } from './types.ts'

/** Discards every record — the default until a caller wires a real sink (e.g. `llm_calls`). */
export const noopMeterSink: MeterSink = {
  async record() {},
}
