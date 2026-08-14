import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../accounts'
import { saveGistId } from '../config/loader'
import type { CloudSyncConfig } from '../config/schema'
import * as logger from '../logger'
import type { KiroAuthMethod, KiroRegion, ManagedAccount } from '../types'
import { createGist, getGistContent, updateGist } from './gist-client'

const PAYLOAD_VERSION = 1

interface CloudAccount {
  id: string
  email: string
  authMethod: KiroAuthMethod
  region: KiroRegion
  oidcRegion?: KiroRegion
  clientId?: string
  clientSecret?: string
  profileArn?: string
  startUrl?: string
  refreshToken: string
  usedCount: number
  limitCount: number
  isHealthy: boolean
  unhealthyReason?: string
}

interface CloudPayload {
  version: number
  last_synced: number
  accounts: CloudAccount[]
}

export interface SyncResult {
  pulled: number
  merged: number
  pushed: number
  gistId?: string
  errors: string[]
}

type ConfigLike = { cloud_sync?: CloudSyncConfig }

function toCloud(a: ManagedAccount): CloudAccount {
  return {
    id: a.id,
    email: a.email,
    authMethod: a.authMethod,
    region: a.region,
    oidcRegion: a.oidcRegion,
    clientId: a.clientId,
    clientSecret: a.clientSecret,
    profileArn: a.profileArn,
    startUrl: a.startUrl,
    refreshToken: a.refreshToken,
    usedCount: a.usedCount ?? 0,
    limitCount: a.limitCount ?? 0,
    isHealthy: a.isHealthy,
    unhealthyReason: a.unhealthyReason
  }
}

export async function pullFromCloud(
  config: ConfigLike,
  accountManager: AccountManager
): Promise<{ pulled: number; merged: number }> {
  const cs = config.cloud_sync
  if (!cs?.token || !cs.gist_id) return { pulled: 0, merged: 0 }

  const raw = await getGistContent(cs.token, cs.gist_id)
  if (!raw) return { pulled: 0, merged: 0 }

  let payload: CloudPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error('Remote pool JSON is malformed')
  }
  if (!Array.isArray(payload.accounts)) return { pulled: 0, merged: 0 }

  const local = new Map(accountManager.getAccounts().map((a) => [a.id, a]))
  let pulled = 0
  let merged = 0

  for (const r of payload.accounts) {
    if (!r.id || !r.refreshToken) continue
    const existing = local.get(r.id)

    if (!existing) {
      // New account from another device: seed it with the remote refresh token
      // and expiresAt=0 so the token refresher mints a fresh access token on
      // first use.
      accountManager.addAccount({
        id: r.id,
        email: r.email,
        authMethod: r.authMethod,
        region: r.region,
        oidcRegion: r.oidcRegion,
        clientId: r.clientId,
        clientSecret: r.clientSecret,
        profileArn: r.profileArn,
        startUrl: r.startUrl,
        refreshToken: r.refreshToken,
        accessToken: '',
        expiresAt: 0,
        rateLimitResetTime: 0,
        isHealthy: r.isHealthy !== false,
        failCount: 0,
        usedCount: r.usedCount ?? 0,
        limitCount: r.limitCount ?? 0
      })
      pulled++
      continue
    }

    // Shared account: take the highest usage so no device under-counts a burned
    // quota, and let a dead flag from either side stick. Keep the local refresh
    // token (it rotates locally and is authoritative for this device).
    const nextUsed = Math.max(existing.usedCount ?? 0, r.usedCount ?? 0)
    const nextLimit = Math.max(existing.limitCount ?? 0, r.limitCount ?? 0)
    const healthy = existing.isHealthy && r.isHealthy !== false
    const changed =
      nextUsed !== (existing.usedCount ?? 0) ||
      nextLimit !== (existing.limitCount ?? 0) ||
      healthy !== existing.isHealthy

    if (changed) {
      accountManager.addAccount({
        ...existing,
        usedCount: nextUsed,
        limitCount: nextLimit,
        isHealthy: healthy,
        unhealthyReason: healthy
          ? existing.unhealthyReason
          : existing.unhealthyReason || r.unhealthyReason
      })
      merged++
    }
  }

  return { pulled, merged }
}

export async function pushToCloud(
  config: ConfigLike,
  accountManager: AccountManager
): Promise<{ pushed: number; gistId?: string }> {
  const cs = config.cloud_sync
  if (!cs?.token) return { pushed: 0 }

  const accounts = accountManager.getAccounts().filter((a) => a.refreshToken)
  const payload: CloudPayload = {
    version: PAYLOAD_VERSION,
    last_synced: Date.now(),
    accounts: accounts.map(toCloud)
  }
  const content = JSON.stringify(payload, null, 2)

  let gistId = cs.gist_id
  if (!gistId) {
    gistId = await createGist(cs.token, content)
    cs.gist_id = gistId
    saveGistId(gistId)
  } else {
    await updateGist(cs.token, gistId, content)
  }

  return { pushed: accounts.length, gistId }
}

export async function syncCloud(
  config: ConfigLike,
  repository: AccountRepository,
  accountManager: AccountManager
): Promise<SyncResult> {
  const errors: string[] = []
  let pulled = 0
  let merged = 0

  try {
    const r = await pullFromCloud(config, accountManager)
    pulled = r.pulled
    merged = r.merged
  } catch (e) {
    errors.push(`Pull: ${e instanceof Error ? e.message : String(e)}`)
  }

  let pushed = 0
  let gistId: string | undefined
  try {
    const p = await pushToCloud(config, accountManager)
    pushed = p.pushed
    gistId = p.gistId
  } catch (e) {
    errors.push(`Push: ${e instanceof Error ? e.message : String(e)}`)
  }

  repository.invalidateCache()
  logger.log('Cloud sync finished', { pulled, merged, pushed, errors: errors.length })
  return { pulled, merged, pushed, gistId, errors }
}
