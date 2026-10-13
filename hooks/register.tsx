import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ref } from '../types'

const context = atom({ plugin: 'status', key: 'context' } as const, 0)
const reviews = atom({ plugin: 'status', key: 'reviews' } as const, [])
const linkedPr = atom({ plugin: 'status', key: 'linkedPr' } as const, null)
const approved = atom({ plugin: 'status', key: 'approved' } as const, false)
const flash = atom({ plugin: 'status', key: 'flash' } as const, true)
const busy = atom({ plugin: 'status', key: 'busy' } as const, false)
const spin = atom({ plugin: 'status', key: 'spin' } as const, 0)

const IDLE = '#443a3a'
const AMBER = '#ffb454'
const RED = '#f44336'
const GREEN = '#5fd075'
const AMBER_AT = 60
const RED_AT = 80
const FLASH_MS = 500
const SPIN_MS = 90
const MIN_BUSY_MS = 800
const SWEEP_W = 3
const POLL_MS = 20 * 60_000
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const URL_CHARS = '[A-Za-z0-9._~%/:+=&?-]'

let adoUserId: string | null = null
let running: Promise<void> | null = null
let again = false

const adoOrg = (): string =>
  ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.STATUS_ADO_ORG ?? '').replace(/\/+$/, '')

export const contextColor = (pct: number): string | null =>
  pct >= RED_AT ? RED : pct >= AMBER_AT ? AMBER : null

export const lastPrUrl = (text: string): string | null => {
  const pattern = new RegExp(
    `https://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/\\d+|https://dev\\.azure\\.com/${URL_CHARS}*?/pullrequest/\\d+`,
    'g',
  )
  const all = [...text.matchAll(pattern)]

  return all.length > 0 ? all[all.length - 1]![0] : null
}

export const parseAdoPr = (url: string) => {
  const m = url.match(/^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/)

  return m ? { org: m[1]!, project: m[2]!, repo: m[3]!, id: m[4]! } : null
}

export const adoApproved = (status: string, votes: number[]): boolean =>
  status === 'active' && votes.some(v => v >= 10) && votes.every(v => v >= 0)

type AdoPr = {
  id: number
  draft: boolean
  repo: string
  project: string
  by: string
  reviewers: { id: string; vote: number }[]
}

const az = async ($: EngineInterface, url: string, query?: string): Promise<unknown> => {
  const args = ['az', 'rest', '--resource', ADO_RESOURCE, '--url', url, '-o', 'json']

  if (query) args.push('--query', query)
  const r = await $.process.run(args)

  return r.exitCode === 0 ? JSON.parse(r.stdout) : null
}

async function githubReviews($: EngineInterface): Promise<Ref[]> {
  const { exitCode, stdout } = await $.process.run([
    'gh', 'search', 'prs', '--review-requested=@me', '--state=open', '--draft=false',
    '--json', 'number,url', '-L', '20',
  ])

  if (exitCode !== 0) return []

  return (JSON.parse(stdout) as { number: number; url: string }[]).map(p => ({
    label: `PR#${p.number}`,
    href: p.url,
  }))
}

async function adoReviews($: EngineInterface, org: string): Promise<Ref[]> {
  if (!adoUserId) {
    adoUserId = (await az($, `${org}/_apis/connectionData`, 'authenticatedUser.id')) as string | null
  }

  if (!adoUserId) return []

  const me = adoUserId
  const prs = (await az(
    $,
    `${org}/_apis/git/pullrequests?searchCriteria.reviewerId=${me}&searchCriteria.status=active&api-version=7.1`,
    'value[].{id:pullRequestId,draft:isDraft,repo:repository.name,project:repository.project.name,by:createdBy.id,reviewers:reviewers[].{id:id,vote:vote}}',
  )) as AdoPr[] | null

  return (prs ?? [])
    .filter(p => !p.draft && p.by !== me && p.reviewers.some(r => r.id === me && r.vote === 0))
    .map(p => ({
      label: `PR#${p.id}`,
      href: `${org}/${encodeURIComponent(p.project)}/_git/${encodeURIComponent(p.repo)}/pullrequest/${p.id}`,
    }))
}

async function pollReviews($: EngineInterface) {
  const org = adoOrg()
  const [gh, ado] = await Promise.all([
    githubReviews($).catch(() => null),
    org ? adoReviews($, org).catch(() => null) : Promise.resolve([] as Ref[]),
  ])

  if (gh === null && ado === null) return

  const next = [...(gh ?? []), ...(ado ?? [])]
  const cur = await read($, reviews)

  if (next.map(r => r.href).join('|') !== cur.map(r => r.href).join('|')) {
    await update($, reviews, () => next)
  }
}

async function checkApproval($: EngineInterface) {
  const url = await read($, linkedPr)

  if (!url) return

  let next: boolean | null = null

  try {
    const ado = parseAdoPr(url)

    if (ado) {
      const pr = (await az(
        $,
        `https://dev.azure.com/${ado.org}/${ado.project}/_apis/git/repositories/${ado.repo}/pullrequests/${ado.id}?api-version=7.1`,
        '{status:status,votes:reviewers[].vote}',
      )) as { status: string; votes: number[] } | null

      next = pr ? adoApproved(pr.status, pr.votes) : null
    } else {
      const r = await $.process.run(['gh', 'pr', 'view', url, '--json', 'reviewDecision,state'])

      if (r.exitCode === 0) {
        const pr = JSON.parse(r.stdout) as { reviewDecision: string; state: string }

        next = pr.state === 'OPEN' && pr.reviewDecision === 'APPROVED'
      }
    }
  } catch {
    next = null
  }

  if (next !== null && next !== (await read($, approved))) {
    await update($, approved, () => next)
  }
}

function lookup($: EngineInterface): Promise<void> {
  if (running) {
    again = true

    return running
  }

  running = (async () => {
    try {
      do {
        again = false
        await Promise.all([pollReviews($).catch(() => {}), checkApproval($).catch(() => {})])
      } while (again)
    } finally {
      running = null
    }
  })()

  return running
}

async function refreshClicked($: EngineInterface) {
  if (await read($, busy)) return

  await update($, busy, () => true)

  try {
    await Promise.all([
      lookup($),
      new Promise<void>(resolve => {
        $.clock.after(MIN_BUSY_MS, resolve)
      }),
    ])
  } finally {
    await update($, busy, () => false)
  }
}

export const sweep = (text: string, step: number): [string, string, string] => {
  const start = (step % (text.length + SWEEP_W)) - SWEEP_W
  const from = Math.max(0, start)
  const to = Math.min(text.length, start + SWEEP_W)

  return [text.slice(0, from), text.slice(from, to), text.slice(to)]
}

async function refreshContext($: EngineInterface) {
  try {
    const pct = Math.round((await $.session.usage()).context.percent ?? 0)

    if (pct !== (await read($, context))) {
      await update($, context, () => pct)
    }
  } catch {}
}

async function indicators($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Button, Text } = $.ui.resolve(e)
  const pct = await read($, context)
  const isApproved = await read($, approved)
  const isReview = (await read($, reviews)).length > 0
  const lit = await read($, flash)
  const isBusy = await read($, busy)
  const step = await read($, spin)
  const item = (name: string, color: string | null, flashes: boolean) => (
    <Text color={color && (!flashes || lit) ? color : IDLE} bold>{name}</Text>
  )
  const review = () => {
    const [head, mid, tail] = sweep('REVIEW WANTED', step)
    const parts: [string, string][] = [[head, IDLE], [mid, AMBER], [tail, IDLE]]

    return (
      <Button key="review" plain onPress={() => refreshClicked($)}>
        {parts.filter(([s]) => s).map(([s, c], i) => (
          <Text key={`s${i}`} color={c} bold>{s}</Text>
        ))}
      </Button>
    )
  }

  return [
    item('APPROVED', isApproved ? GREEN : null, false),
    item('CONTEXT', contextColor(pct), pct >= RED_AT),
    isBusy
      ? review()
      : isReview
        ? (
          <Button key="review" plain onPress={() => refreshClicked($)}>
            {item('REVIEW WANTED', AMBER, true)}
          </Button>
        )
        : item('REVIEW WANTED', null, true),
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refreshContext($)
    $.clock.every(2000, () => {
      void refreshContext($)
    })
    $.clock.every(FLASH_MS, async () => {
      const flashing = (await read($, context)) >= RED_AT || (await read($, reviews)).length > 0
      const lit = await read($, flash)

      if (flashing || !lit) {
        await update($, flash, () => (flashing ? !lit : true))
      }
    })
    $.clock.every(SPIN_MS, async () => {
      if (await read($, busy)) {
        await update($, spin, n => n + 1)
      }
    })
    void lookup($)
    $.clock.every(POLL_MS, () => {
      void lookup($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refreshContext($)

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const url = lastPrUrl(JSON.stringify(e.message.content ?? ''))

    if (url && url !== (await read($, linkedPr))) {
      await update($, linkedPr, () => url)
      await update($, approved, () => false)
      void lookup($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const above = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [a, c, r] = await indicators($, e)

    return (
      <Box flexDirection="column">
        {above}
        <Text color={IDLE}>{'─'.repeat(Math.max(0, (e.viewport?.columns ?? 80) - 5))}</Text>
        <Box width="100%" justifyContent="center">
          {a}
          <Text color={IDLE}>{' | '}</Text>
          {c}
          <Text color={IDLE}>{' | '}</Text>
          {r}
        </Box>
      </Box>
    )
  })
}
