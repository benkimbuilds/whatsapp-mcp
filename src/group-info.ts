/**
 * Phone-number-free projection of Baileys group metadata.
 *
 * Listing uses one `groupFetchAllParticipating` query. `groupMetadata` is only
 * a fallback when a requested group JID is missing from that result. Community
 * parent/child links are `linkedParent`, `isCommunity`, and `isCommunityAnnounce`
 * on those groups. `communityFetchLinkedGroups` is intentionally unused: it adds
 * more queries and the raw payload includes owner phone JIDs.
 */

const GROUP_JID = /^[0-9]{5,30}(?:-[0-9]{1,20})?@g\.us$/
const CACHE_TTL_MS = 60_000
const RATE_LIMIT_COOLDOWN_MS = 60_000

export type GroupRole = 'superadmin' | 'admin' | 'member' | 'unknown'

export type AccountIdentity = {
  id?: string
  lid?: string
  phoneNumber?: string
}

/** Cached, shareable group facts. No participant JIDs or phone numbers. */
export type ProjectedGroup = {
  jid: string
  subject: string
  participantCount: number
  participantListPartial: boolean
  isAdmin: boolean
  role: GroupRole
  adminCount: number
  isCommunity: boolean
  isCommunityAnnounce: boolean
  linkedParentJid?: string
}

export type GroupSummary = ProjectedGroup & {
  linkedGroupCount: number
  linkedGroupJids?: string[]
  linkedGroupJidsTruncated?: boolean
}

export type GroupPage = {
  groups: GroupSummary[]
  matched: number
  returned: number
}

export class GroupRateLimitError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super('WhatsApp rate-limited group metadata.')
    this.name = 'GroupRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

export function isGroupJid(value: string): boolean {
  return GROUP_JID.test(value)
}

export function accountIdentity(
  user: AccountIdentity | undefined,
  status?: { pairedJid?: string; pairedNumber?: string },
): AccountIdentity {
  const digits = status?.pairedNumber?.replace(/[^\d]/g, '')
  return {
    id: user?.id ?? status?.pairedJid,
    lid: user?.lid,
    phoneNumber: user?.phoneNumber ?? (digits ? `${digits}@s.whatsapp.net` : undefined),
  }
}

/** Keep only fields that are safe to cache and return. Participant ids are used for the role check, then dropped. */
export function projectGroups(input: unknown, identity: AccountIdentity): ProjectedGroup[] {
  const byId = new Map<string, ProjectedGroup>()
  for (const record of groupRecords(input)) {
    const projected = projectGroup(record, identity)
    if (projected) byId.set(projected.jid, projected)
  }
  return [...byId.values()]
}

export function projectGroup(record: unknown, identity: AccountIdentity): ProjectedGroup | null {
  const group = asRecord(record)
  if (!group || typeof group.id !== 'string' || !isGroupJid(group.id)) return null
  const participants = Array.isArray(group.participants) ? group.participants : []
  const listed = participants.length
  const reported = typeof group.size === 'number' && Number.isFinite(group.size) && group.size >= 0
    ? Math.floor(group.size)
    : listed
  const participantCount = Math.max(reported, listed)
  const keys = identityKeys(identity)
  let role: GroupRole = 'unknown'
  let adminCount = 0
  for (const participant of participants) {
    const view = asRecord(participant)
    if (!view) continue
    const participantRole = roleOf(view)
    if (participantRole === 'admin' || participantRole === 'superadmin') adminCount += 1
    if (role === 'unknown' && participantKeys(view).some((key) => keys.has(key))) role = participantRole
  }
  const linkedParent = typeof group.linkedParent === 'string' && isGroupJid(group.linkedParent) && group.linkedParent !== group.id
    ? group.linkedParent
    : undefined
  return {
    jid: group.id,
    subject: cleanSubject(group.subject),
    participantCount,
    participantListPartial: reported > listed,
    isAdmin: role === 'admin' || role === 'superadmin',
    role,
    adminCount,
    isCommunity: group.isCommunity === true,
    isCommunityAnnounce: group.isCommunityAnnounce === true,
    ...(linkedParent ? { linkedParentJid: linkedParent } : {}),
  }
}

export function linkAndFilter(
  groups: readonly ProjectedGroup[],
  options: { groupJid?: string; name?: string; limit: number },
): GroupPage {
  const children = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.linkedParentJid) continue
    const list = children.get(group.linkedParentJid) ?? []
    list.push(group.jid)
    children.set(group.linkedParentJid, list)
  }
  const linked = groups.map((group) => {
    const childJids = [...(children.get(group.jid) ?? [])].sort((a, b) => a.localeCompare(b))
    const shown = childJids.slice(0, 200)
    return {
      ...group,
      linkedGroupCount: childJids.length,
      ...(shown.length > 0 ? { linkedGroupJids: shown } : {}),
      ...(childJids.length > shown.length ? { linkedGroupJidsTruncated: true } : {}),
    }
  }).sort((a, b) => a.subject.localeCompare(b.subject) || a.jid.localeCompare(b.jid))

  if (options.groupJid) {
    const match = linked.filter((group) => group.jid === options.groupJid)
    return { groups: match, matched: match.length, returned: match.length }
  }
  const needle = fold(options.name?.trim() ?? '')
  const matched = needle ? linked.filter((group) => fold(group.subject).includes(needle)) : linked
  const page = matched.slice(0, options.limit)
  return { groups: page, matched: matched.length, returned: page.length }
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof GroupRateLimitError) return true
  const message = err instanceof Error ? err.message : ''
  if (/rate-overlimit|too many requests|rate limit/i.test(message)) return true
  return errorCodes(err).includes(429)
}

/** Client-facing text. Never includes the underlying message, which may contain a JID. */
export function publicGroupError(err: unknown): string {
  if (err instanceof GroupRateLimitError) {
    const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000))
    return `WhatsApp rate-limited group metadata. Wait ${seconds} seconds before trying again.`
  }
  if (isRateLimitError(err)) return 'WhatsApp rate-limited group metadata. Wait 60 seconds before trying again.'
  const message = err instanceof Error ? err.message : ''
  const codes = errorCodes(err)
  if (codes.includes(403) || /not-authorized|forbidden|not a participant/i.test(message)) {
    return 'This account cannot read that group.'
  }
  if (codes.includes(404) || /item-not-found|group not found/i.test(message)) return 'Group not found.'
  if (/connection closed|connection was lost|connection terminated|timed out|not connected|query cancelled/i.test(message)) {
    return 'WhatsApp is not connected. Pair via QR or wait for reconnect.'
  }
  return 'Could not read group metadata.'
}

export class GroupQueryGuard {
  private cooldownUntil = 0
  private cache: { at: number; groups: ProjectedGroup[] } | null = null
  private pending: Promise<ProjectedGroup[]> | null = null

  constructor(private readonly options: { ttlMs?: number; cooldownMs?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  retryAfterMs(): number {
    return Math.max(0, this.cooldownUntil - this.now())
  }

  /** One in-flight participating fetch, then a short cache. Rate limits open a cooldown with no automatic retry. */
  async load(fetchAll: () => Promise<ProjectedGroup[]>): Promise<ProjectedGroup[]> {
    const wait = this.retryAfterMs()
    if (wait > 0) throw new GroupRateLimitError(wait)
    if (this.cache && this.now() - this.cache.at <= (this.options.ttlMs ?? CACHE_TTL_MS)) {
      return this.cache.groups.map((group) => ({ ...group }))
    }
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(fetchAll)
        .then((groups) => {
          this.cache = { at: this.now(), groups: dedupe(groups) }
          return this.cache.groups.map((group) => ({ ...group }))
        })
        .catch((err: unknown) => {
          if (isRateLimitError(err)) this.cooldownUntil = this.now() + (this.options.cooldownMs ?? RATE_LIMIT_COOLDOWN_MS)
          throw err
        })
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }

  async fetchOne<T>(fetchOne: () => Promise<T>): Promise<T> {
    const wait = this.retryAfterMs()
    if (wait > 0) throw new GroupRateLimitError(wait)
    try {
      return await fetchOne()
    } catch (err) {
      if (isRateLimitError(err)) this.cooldownUntil = this.now() + (this.options.cooldownMs ?? RATE_LIMIT_COOLDOWN_MS)
      throw err
    }
  }

  remember(group: ProjectedGroup): void {
    if (!this.cache || this.now() - this.cache.at > (this.options.ttlMs ?? CACHE_TTL_MS)) return
    if (this.cache.groups.some((existing) => existing.jid === group.jid)) return
    this.cache.groups.push({ ...group })
  }
}

function dedupe(groups: ProjectedGroup[]): ProjectedGroup[] {
  const byId = new Map<string, ProjectedGroup>()
  for (const group of groups) {
    if (isGroupJid(group.jid)) byId.set(group.jid, { ...group })
  }
  return [...byId.values()]
}

function groupRecords(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  const record = asRecord(input)
  return record ? Object.values(record) : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function cleanSubject(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function bareJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string') return undefined
  const trimmed = jid.trim().toLowerCase()
  const at = trimmed.indexOf('@')
  if (at <= 0 || trimmed.includes('@', at + 1)) return undefined
  const server = trimmed.slice(at + 1) === 'c.us' ? 's.whatsapp.net' : trimmed.slice(at + 1)
  if (!/^[a-z0-9.]+$/.test(server)) return undefined
  const user = trimmed.slice(0, at).split(':')[0]?.split('_')[0] ?? ''
  if (!/^[0-9]+$/.test(user)) return undefined
  return `${user}@${server}`
}

function identityKeys(identity: AccountIdentity): Set<string> {
  const keys = new Set<string>()
  for (const value of [identity.id, identity.lid, identity.phoneNumber]) {
    const bare = bareJid(value)
    if (bare) keys.add(bare)
  }
  return keys
}

function participantKeys(participant: Record<string, unknown>): string[] {
  return [participant.id, participant.lid, participant.phoneNumber]
    .map((value) => bareJid(value))
    .filter((value): value is string => Boolean(value))
}

function roleOf(participant: Record<string, unknown>): Exclude<GroupRole, 'unknown'> {
  if (participant.admin === 'superadmin' || participant.isSuperAdmin === true) return 'superadmin'
  if (participant.admin === 'admin' || participant.isAdmin === true) return 'admin'
  return 'member'
}

function errorCodes(err: unknown): number[] {
  if (!err || typeof err !== 'object') return []
  const codes: number[] = []
  const output = (err as { output?: { statusCode?: unknown } }).output
  if (typeof output?.statusCode === 'number') codes.push(output.statusCode)
  const data = (err as { data?: unknown }).data
  if (typeof data === 'number' && Number.isFinite(data)) codes.push(data)
  return codes
}
