export type Ref = { label: string; href: string }

declare module 'claude-code' {
  interface PluginState {
    status: {
      context: number
      reviews: Ref[]
      linkedPr: string | null
      approved: boolean
      flash: boolean
      busy: boolean
      spin: number
    }
  }
}
