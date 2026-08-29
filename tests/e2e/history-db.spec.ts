import { test, expect, type Page } from '@playwright/test'
import { DB_NAME, DB_VERSION, QUOTA_RELIEF } from '../../src/shared/history-db'
import type { HistoryPiece, HistoryTrack } from '../../src/core/history/layout'
import { launchWithExtension, openExtensionPage } from './helpers'

/**
 * The index itself, exercised against the database it really runs on.
 *
 * It is tested here and not in the unit set for the same reason `HistoryIo` exists at all: the
 * seam in front of the writer is there so that the *scheduling* of batches can be tested without
 * a browser, and everything on the other side of it — transactions, a unique index that refuses a
 * key, a cursor walking `lastSeenAt` backwards, an upgrade that did not happen — is IndexedDB and
 * exists in Chrome and in no test runner. A hand-written stand-in for it would agree with itself
 * and with no line of `src/shared/history-db.ts`.
 *
 * So every test below opens a page of the extension — which is what the popup, the sweeper and
 * the editor are — and drives the module out of `dist` over a profile of its own. Nothing here
 * plays a video: the writer's own path is `history.spec.ts`, and these are the rows underneath it,
 * whose consumers arrive in Tasks 8, 11 and 12 with the code already written.
 *
 * The address of the module reaches `import()` through a variable, and the type through the
 * source it was built from. Written as a literal, TypeScript would look for
 * `/shared/history-db.js` on this machine, not find it, and fail `npm run typecheck` over a path
 * that is not supposed to be there.
 */

/** The page every session here was watched on. */
const PAGE = { url: 'https://site.example/watch', title: 'A clip' }

/** The representation of the picture, named once so the parts and the track agree about it. */
const VIDEO = 'video:avc1:1920x1080'
const AUDIO = 'audio:mp4a:0x0'

/** A track as the index remembers it, with its init in the piece named here. */
const track = (representation: string, file: string): HistoryTrack => ({
  representation,
  bufferId: representation === VIDEO ? 'sb-1' : 'sb-2',
  kinds: [representation === VIDEO ? 'video' : 'audio'],
  info: {
    tracks: [
      representation === VIDEO
        ? { trackId: 1, kind: 'video', timescale: 90_000, codec: 'avc1', width: 1920, height: 1080 }
        : { trackId: 2, kind: 'audio', timescale: 48_000, codec: 'mp4a', width: 0, height: 0 },
    ],
  },
  init: { file, at: 0, length: 16 },
})

/** One landed piece: the stretch of media time it holds, and what it weighs on disk. */
const piece = (file: string, start: number, end: number, bytes: number): HistoryPiece => ({
  file,
  bytes,
  until: end,
  writtenAt: 1_700_000_000_000,
  parts: [{ representation: VIDEO, start, end, at: 16, length: bytes - 16 }],
})

/** A page of the extension with nothing on it but the index, on a profile of its own. */
async function overIndex(work: (reader: Page) => Promise<void>): Promise<void> {
  const { context, extensionId } = await launchWithExtension()
  try {
    await work(await openExtensionPage(context, extensionId, 'popup/popup.html'))
  } finally {
    await context.close()
  }
}

test('a session is opened once under its key, and a deleted one comes back to life', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          recordPiece,
          listSessions,
          sessionById,
          setDeleted,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const first = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        // The reload, the second tab and the return to the same video a day later all arrive here
        // (§6.1): one key, one row, and the material of all of them in it.
        const again = await openSession('one', { ...input.page, createdAt: 9_000, lastSeenAt: 9_000 })
        const beforeAnythingLanded = await listSessions()

        await recordPiece(first, input.piece, [input.track], {
          page: { ...input.page, lastSeenAt: 3_000 },
        })
        const listed = await listSessions()

        await setDeleted(first, 5_000)
        const afterDelete = await listSessions()

        // Watched again before the sweeper came round. The row is still on disk, and it is this
        // session's row: opening a second one would leave the material of one video in two.
        const back = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 7_000 })
        const revived = await sessionById(first)

        return { first, again, beforeAnythingLanded, listed, afterDelete, back, revived }
      },
      { page: PAGE, piece: piece('aaaaaaaa-000000.tcm', 0, 2, 1_016), track: track(VIDEO, 'aaaaaaaa-000000.tcm') },
    )

    expect(got.again, 'one key opened two rows').toBe(got.first)
    // The row exists, and it is still not history: it was opened by a batch whose file has not
    // landed. Listed, the popup would show a recording of nothing — and the row a key move left
    // behind under the old key would be one of those.
    expect(got.beforeAnythingLanded, 'a session with nothing in it was listed').toEqual([])

    expect(got.listed.map((row) => row.id)).toEqual([got.first])
    expect(got.listed[0]!.bytes).toBe(1_016)
    expect(got.listed[0]!.seconds).toBeCloseTo(2)
    expect(got.listed[0]!.title).toBe(PAGE.title)

    expect(got.afterDelete, 'a deleted session was listed').toEqual([])
    expect(got.back).toBe(got.first)
    expect(got.revived!.deletedAt, 'watching it again left it deleted').toBe(0)
  })
})

test('what a landed piece leaves in the index: bytes summed, seconds joined, one place per init', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          recordPiece,
          sessionById,
          piecesOf,
          readTotals,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const id = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        const signed = { page: { ...input.page, lastSeenAt: 3_000 } }

        await recordPiece(id, input.first, [input.picture], signed)
        // The same stretch, written a second time by the frame of a second tab, and its init with
        // it: neither side's claim on an init is comparable with the other's, so the same track
        // arrives placed in another file (see `HistoryTrack.init`).
        await recordPiece(id, input.second, [input.pictureAgain], signed)
        await recordPiece(id, input.third, [input.sound], signed)

        const row = await sessionById(id)
        const pieces = await piecesOf(id)
        const totals = await readTotals()

        // A batch that landed after the sweeper took its session. The piece is an orphan, the
        // repair will take the file, and a row for it would resurrect half a session.
        await recordPiece('no-such-session', input.orphan, [], signed)
        const afterOrphan = await readTotals()

        return { row, pieces, totals, afterOrphan }
      },
      {
        page: PAGE,
        first: piece('aaaaaaaa-000000.tcm', 0, 2, 1_016),
        second: piece('bbbbbbbb-000000.tcm', 0, 2, 1_016),
        third: piece('aaaaaaaa-000001.tcm', 10, 12, 500),
        orphan: piece('cccccccc-000000.tcm', 0, 2, 999),
        picture: track(VIDEO, 'aaaaaaaa-000000.tcm'),
        pictureAgain: track(VIDEO, 'bbbbbbbb-000000.tcm'),
        sound: track(AUDIO, 'aaaaaaaa-000001.tcm'),
      },
    )

    // The first place an init landed in is the place the index keeps. Not because a repeat is
    // impossible — two merge keys gathering at once and becoming one session is exactly where it
    // happens — but because otherwise which of the two files the editor reads the init from would
    // be decided by the order they landed in.
    expect(got.row!.tracks.map((one) => [one.representation, one.init.file])).toEqual([
      [VIDEO, 'aaaaaaaa-000000.tcm'],
      [AUDIO, 'aaaaaaaa-000001.tcm'],
    ])

    expect(got.row!.bytes).toBe(1_016 + 1_016 + 500)
    // Joined and not summed: the two copies of 0–2 are one stretch of watching, and 10–12 is
    // another. Added up, this session would claim six seconds of a six-second video.
    expect(got.row!.covered).toEqual([
      { start: 0, end: 2 },
      { start: 10, end: 12 },
    ])
    expect(got.row!.seconds).toBeCloseTo(4)
    expect(got.row!.sound, 'a session with an audio track was written down as silent').toBe(true)

    expect(got.pieces.map((one) => one.file).sort()).toEqual([
      'aaaaaaaa-000000.tcm',
      'aaaaaaaa-000001.tcm',
      'bbbbbbbb-000000.tcm',
    ])
    expect(got.totals.bytes).toBe(1_016 + 1_016 + 500)
    expect(got.totals.sessions, 'a session was counted once per piece').toBe(1)
    expect(got.afterOrphan, 'an orphan piece was written into the totals').toEqual(got.totals)
  })
})

test('a session moves to the key it is now known by, and refuses one that is taken', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          renameSession,
          sessionById,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const one = await openSession('live', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        // The soft navigation of §6.1: the address and the title come with the key.
        const moved = await renameSession(one, 'stated', {
          url: 'https://site.example/next',
          title: 'The next one',
        })
        const afterMove = await sessionById(one)

        // A key that says nothing about the page: the row keeps the name it had rather than
        // losing it to an empty string.
        const movedAgain = await renameSession(one, 'again', { url: '', title: '' })
        const afterBlank = await sessionById(one)

        // Another frame opened a row for the same video under the key this one is moving to. The
        // pieces of a session live in the directory its identity names, so folding the two would
        // mean moving files: the caller is told no and goes on writing into the row it has.
        const two = await openSession('taken', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        const refused = await renameSession(two, 'again', { url: '', title: '' })
        const kept = await sessionById(two)

        // And a row the sweeper has already taken.
        const nowhere = await renameSession('no-such-session', 'orphan', { url: '', title: '' })

        return { moved, afterMove, movedAgain, afterBlank, refused, kept, nowhere }
      },
      { page: PAGE },
    )

    expect(got.moved).toBe(true)
    expect(got.afterMove!.key).toBe('stated')
    expect(got.afterMove!.url).toBe('https://site.example/next')
    expect(got.afterMove!.title).toBe('The next one')

    expect(got.movedAgain).toBe(true)
    expect(got.afterBlank!.key).toBe('again')
    expect(got.afterBlank!.url, 'a move with no page behind it wiped the address').toBe(
      'https://site.example/next',
    )

    expect(got.refused, 'two rows were allowed to stand under one key').toBe(false)
    expect(got.kept!.key).toBe('taken')
    expect(got.nowhere).toBe(false)
  })
})

test('the marks a user leaves on a session, and the order the rows come back in', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          recordPiece,
          listSessions,
          sessionById,
          setPinned,
          setUsed,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const newest = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 3_000 })
        const oldest = await openSession('two', { ...input.page, createdAt: 1_000, lastSeenAt: 1_000 })
        const middle = await openSession('three', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })

        await recordPiece(newest, input.a, [], { page: { ...input.page, lastSeenAt: 3_000 } })
        await recordPiece(oldest, input.b, [], { page: { ...input.page, lastSeenAt: 1_000 } })
        await recordPiece(middle, input.c, [], { page: { ...input.page, lastSeenAt: 2_000 } })

        const all = (await listSessions()).map((row) => row.id)
        const first = (await listSessions(1)).map((row) => row.id)

        await setPinned(oldest, true)
        await setUsed(oldest, 8_000)
        const marked = await sessionById(oldest)

        await setPinned(oldest, false)
        const unpinned = await sessionById(oldest)

        // A mark on a session the sweeper has taken: nothing to write it on, and nothing written.
        await setPinned('no-such-session', true)
        const after = (await listSessions()).map((row) => row.id)

        return { newest, oldest, middle, all, first, marked, unpinned, after }
      },
      {
        page: PAGE,
        a: piece('aaaaaaaa-000000.tcm', 0, 2, 1_016),
        b: piece('bbbbbbbb-000000.tcm', 0, 2, 1_016),
        c: piece('cccccccc-000000.tcm', 0, 2, 1_016),
      },
    )

    // Newest first: the popup shows what was watched last at the top and never sorts anything.
    expect(got.all).toEqual([got.newest, got.middle, got.oldest])
    expect(got.first).toEqual([got.newest])

    expect(got.marked!.pinned).toBe(true)
    expect(got.marked!.usedAt).toBe(8_000)
    expect(got.unpinned!.pinned).toBe(false)
    expect(got.unpinned!.usedAt, 'unpinning took the last use with it').toBe(8_000)
    expect(got.after).toEqual([got.newest, got.middle, got.oldest])
  })
})

test('pieces and whole sessions go out with the volume they took', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          recordPiece,
          piecesOf,
          sessionById,
          readTotals,
          dropPieceRows,
          dropSessionRows,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const id = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        const signed = { page: { ...input.page, lastSeenAt: 3_000 } }
        await recordPiece(id, input.first, [input.picture], signed)
        await recordPiece(id, input.second, [], signed)
        await recordPiece(id, input.third, [], signed)
        const before = await sessionById(id)

        const nothing = await dropPieceRows(id, [])
        const unknown = await dropPieceRows(id, ['no-such-file.tcm'])

        // Eviction by the buffer length (§7.3) takes the two pieces holding 0–2 and leaves 10–12.
        const freed = await dropPieceRows(id, [input.first.file, input.second.file])
        const after = await sessionById(id)
        const left = (await piecesOf(id)).map((one) => one.file)
        const totals = await readTotals()

        await dropSessionRows(id)
        const gone = await sessionById(id)
        const noPieces = await piecesOf(id)
        const emptied = await readTotals()

        // And a second removal of the same session takes nothing away twice.
        await dropSessionRows(id)
        const stillEmpty = await readTotals()

        return { before, nothing, unknown, freed, after, left, totals, gone, noPieces, emptied, stillEmpty }
      },
      {
        page: PAGE,
        first: piece('aaaaaaaa-000000.tcm', 0, 2, 1_016),
        second: piece('bbbbbbbb-000000.tcm', 0, 2, 1_016),
        third: piece('aaaaaaaa-000001.tcm', 10, 12, 500),
        picture: track(VIDEO, 'aaaaaaaa-000000.tcm'),
      },
    )

    expect(got.before!.seconds).toBeCloseTo(4)
    expect(got.nothing).toBe(0)
    expect(got.unknown, 'a file the index never held was counted as freed').toBe(0)

    expect(got.freed).toBe(1_016 + 1_016)
    expect(got.left).toEqual(['aaaaaaaa-000001.tcm'])
    expect(got.after!.bytes).toBe(500)
    // Rebuilt from what is left rather than shortened by what went: 0–2 was in both of the pieces
    // that went, and subtracting their seconds would have taken four away from a session that
    // lost two.
    expect(got.after!.covered).toEqual([{ start: 10, end: 12 }])
    expect(got.after!.seconds).toBeCloseTo(2)
    expect(got.totals.bytes).toBe(500)

    expect(got.gone).toBeUndefined()
    expect(got.noPieces).toEqual([])
    expect(got.emptied.bytes).toBe(0)
    expect(got.emptied.sessions).toBe(0)
    expect(got.stillEmpty, 'a session was subtracted from the totals twice').toEqual(got.emptied)
  })
})

test('a refusal to take more lowers the ceiling, and a fresh start forgets it', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const {
          openSession,
          recordPiece,
          readTotals,
          markStorageFull,
          clearStorageFull,
          recordSnapshot,
          listSnapshots,
          dropSnapshotRow,
        }: typeof import('../../src/shared/history-db') = await import(address)

        const id = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        const signed = { page: { ...input.page, lastSeenAt: 3_000 } }
        await recordPiece(id, input.first, [], signed)

        await markStorageFull(input.at)
        const refused = await readTotals()

        // Recording went on after the sweeper made room, and the browser refused again. The
        // ceiling comes down a second time and never back up: raised to a share of what is held
        // now, it would sit above what was already proved impossible.
        await recordPiece(id, input.second, [], signed)
        await markStorageFull(input.at + 1)
        const refusedAgain = await readTotals()

        // The repair at start-up: a full disk is a fact about a machine at a moment, and one
        // attempt per start of the browser is a cheap way to find out whether it still holds.
        await clearStorageFull()
        const cleared = await readTotals()

        await recordSnapshot({ id: 'snap-1', capturedAt: 5_000, bytes: 400, title: 'A cut' })
        const snapshots = await listSnapshots()
        const withSnapshot = await readTotals()

        await dropSnapshotRow('snap-1')
        const afterDrop = await listSnapshots()
        const withoutSnapshot = await readTotals()

        await dropSnapshotRow('no-such-snapshot')
        const unchanged = await readTotals()

        return {
          refused,
          refusedAgain,
          cleared,
          snapshots,
          withSnapshot,
          afterDrop,
          withoutSnapshot,
          unchanged,
        }
      },
      {
        page: PAGE,
        at: 1_700_000_000_000,
        first: piece('aaaaaaaa-000000.tcm', 0, 2, 1_000),
        second: piece('aaaaaaaa-000001.tcm', 10, 12, 1_000),
      },
    )

    expect(got.refused.fullAt).toBe(1_700_000_000_000)
    // A share of what is held and not a fixed number of megabytes: a refusal says nothing about
    // how much room is missing, and this frees something at every size without emptying the
    // history in one go.
    expect(got.refused.cappedBytes).toBe(Math.floor(1_000 * QUOTA_RELIEF))

    expect(got.refusedAgain.fullAt).toBe(1_700_000_000_001)
    expect(got.refusedAgain.cappedBytes, 'a second refusal raised the ceiling').toBe(
      Math.floor(1_000 * QUOTA_RELIEF),
    )

    expect(got.cleared.cappedBytes).toBe(0)
    expect(got.cleared.fullAt).toBe(0)

    expect(got.snapshots).toEqual([{ id: 'snap-1', capturedAt: 5_000, bytes: 400, title: 'A cut' }])
    // A snapshot is a temporary of one editing and it takes room like everything else: left out
    // of the total, the sweeper would be freeing against a number smaller than the disk.
    expect(got.withSnapshot.bytes).toBe(2_000 + 400)
    expect(got.afterDrop).toEqual([])
    expect(got.withoutSnapshot.bytes).toBe(2_000)
    expect(got.unchanged, 'a snapshot that was not there was subtracted anyway').toEqual(
      got.withoutSnapshot,
    )
  })
})

test('a database that would not open is not remembered as the answer', async () => {
  await overIndex(async (reader) => {
    const got = await reader.evaluate(
      async (input) => {
        const address = '/shared/history-db.js'
        const { openHistoryDb, openSession }: typeof import('../../src/shared/history-db') =
          await import(address)

        // A version from a newer build, left behind by an extension that was rolled back: an open
        // at our own version is refused with VersionError and there is nothing to be done about
        // it until somebody clears the database.
        const ahead = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(input.name, input.version + 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        ahead.close()

        let refused = ''
        try {
          await openHistoryDb()
        } catch (cause) {
          refused = String(cause)
        }

        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(input.name)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve()
        })

        // Remembered, that failure would be the answer for the life of this context: the popup,
        // the sweeper and every frame that records would be told the index is gone until the page
        // was reloaded. Private browsing, a corrupted store and a version from a newer build all
        // arrive this way, and the next caller deserves its own attempt.
        const id = await openSession('one', { ...input.page, createdAt: 1_000, lastSeenAt: 2_000 })
        return { refused, id }
      },
      { name: DB_NAME, version: DB_VERSION, page: PAGE },
    )

    expect(got.refused, 'an open at our own version over a newer database succeeded').toMatch(/\S/)
    expect(got.id, 'a failed open was remembered and the index stayed shut').toMatch(/\S/)
  })
})
