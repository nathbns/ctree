/** The commits the refs pointed at when the session started. */
export type CtreeBaseline = string[]

declare module 'claude-code' {
  interface PluginState {
    ctree: {
      baseline: CtreeBaseline | null
    }
  }
}
