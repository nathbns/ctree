/** The commits the refs pointed at when the session started. */
export type GittreeBaseline = string[]

declare module 'claude-code' {
  interface PluginState {
    gittree: {
      baseline: GittreeBaseline | null
    }
  }
}
