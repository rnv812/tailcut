import type { ExtensionToTab, SaveResult, SessionList, SessionSummary } from './protocol'

/**
 * The main frame of a tab: the one frame whose number is known without asking anybody.
 *
 * Everything the extension sent a tab used to go here and nowhere else. The reason was sound —
 * a request with no frame in it goes to every frame at once (both content scripts are declared
 * with all_frames), each answers out of its own registry, and Chrome hands back whichever answer
 * came first: on a page carrying advertising frames that is a stranger's empty list.
 *
 * The price was a whole class of ordinary pages. An article, a documentation page, a landing page
 * carries an embedded player rather than one of its own, and the recording of such a player works
 * perfectly — measured on a page holding nothing but an iframe with an embedded player: one
 * source, 126 appends, 4 014 954 bytes of AV1 and Opus over 27 seconds — but it lives in the
 * registry of the frame that holds the player, and the popup, asking the top frame alone, said
 * "Nothing recorded on this page yet".
 *
 * It stays here as the fallback: when the frames of a tab cannot be enumerated at all, this is
 * the one frame that is certainly there.
 */
export const MAIN_FRAME = 0

/**
 * How long a whole round of frames has to answer before the popup draws what it has.
 *
 * One deadline for the round and not one per frame: what has to stay bounded is the wait the user
 * sits through, and fifty frames each allowed half a second of their own would be twenty-five.
 *
 * The size of it is set by what a frame that is there actually costs. Measured on a page with 52
 * frames in it, one of them a player and three of them frames no content script runs in: the
 * enumeration took 1–5 ms, the whole round 11–13 ms, and the slowest single frame 10 ms — the
 * frames are asked all at once, so the round costs the slowest of them and not the sum. Half a
 * second is fifty times the slowest frame measured, and it is not there to hurry a slow frame
 * along; it is there for a frame that will never answer at all. The content script answers
 * through its bridge, and a frame whose bridge never loads leaves the reply channel open with
 * nobody on it — one such frame used to hold the popup on "Loading…" for good, and a tab has as
 * many chances at that as it has frames.
 */
const ROUND_DEADLINE_MS = 500

/**
 * A session summary with the frame that holds it.
 *
 * The material of a session never leaves the frame it was gathered in, so a save has to go back
 * to that same registry: the key alone addresses nothing without it.
 */
export interface FramedSession extends SessionSummary {
  frameId: number
}

/** What the frames of one tab answered, merged into the single answer the popup draws. */
export interface TabSessions extends SessionList {
  sessions: FramedSession[]
}

/**
 * The frames of a tab, by number.
 *
 * Through chrome.scripting, which the extension already holds a permission for, and not through
 * the webNavigation API, whose permission would add a second consent screen at installation
 * ("read your browsing history") for nothing but a list of numbers. An injection that returns a
 * constant is the cheapest thing that reports the frame it ran in: measured at 1–5 ms for 52
 * frames, and the isolated world it lands in is already there — the content script runs in every
 * frame of every page. Frames on the extension's own origin, the bridge frames among them,
 * Chrome leaves out of the answer of its own accord.
 *
 * Sorted, so that a list built out of it comes out the same on two openings of the popup: Chrome
 * answers in the order the injections happened to finish, which is not an order at all.
 */
async function framesOf(tabId: number): Promise<number[]> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // The result is beside the point; what is wanted is which frame each answer came from.
      func: () => true,
      // Without it the injection may wait for the frame to finish loading, and the popup opens
      // over a page that is still loading as often as not.
      injectImmediately: true,
    })

    const ids = [...new Set(injected.map((result) => result.frameId))]
    return ids.length ? ids.sort((a, b) => a - b) : [MAIN_FRAME]
  } catch {
    // A tab no extension may touch — chrome://, the extension store — or one that closed under
    // the popup. The main frame is asked anyway: it answers the same "no" a little later.
    return [MAIN_FRAME]
  }
}

/** What one frame answered, or nothing at all if it could not be reached. */
async function askFrame(tabId: number, frameId: number): Promise<SessionList | undefined> {
  const request: ExtensionToTab = { type: 'tc:list' }
  try {
    return await chrome.tabs.sendMessage(tabId, request, { frameId })
  } catch {
    // A frame with no content script in it: about:blank, a sandboxed frame, a data: document.
    // Measured on the same 52-frame page — three of them, and each refused in 6 ms rather than
    // hanging. Nothing was recorded there and nothing is known about it either.
    return undefined
  }
}

/**
 * Asks every frame of a tab what it has gathered and merges the answers into one.
 *
 * All the frames at once: asked one after another, a page with fifty of them would pay for fifty
 * round trips in a row, and the popup has to open instantly.
 */
export async function listTabSessions(tabId: number): Promise<TabSessions> {
  const frames = await framesOf(tabId)

  let expire: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    expire = setTimeout(() => resolve(undefined), ROUND_DEADLINE_MS)
  })

  const answers = await Promise.all(
    frames.map(async (frameId) => ({
      frameId,
      reply: await Promise.race([askFrame(tabId, frameId), deadline]),
    })),
  )
  clearTimeout(expire)

  const merged: TabSessions = { sessions: [] }
  const gathered: FramedSession[] = []

  for (const { frameId, reply } of answers) {
    if (!reply) continue

    // Both facts are about a document and not about the tab, and either is worth saying whichever
    // frame it came out of: a protected player inside an embed refuses exactly as one on the top
    // page does, and the popup owes the user the reason there is nothing to show.
    if (reply.encrypted) merged.encrypted = true
    if (reply.unreachable) merged.unreachable = true

    // A frame of an older build, or an answer that is not one at all: it may not take the rest of
    // the tab's list down with it.
    if (!Array.isArray(reply.sessions)) continue

    for (const session of reply.sessions) gathered.push({ ...session, frameId })
  }

  // Newest first across the whole tab, and not frame by frame. The popup opens on the first
  // session of the list and calls it the one being watched right now; ordered by frame, the top
  // of the list would be whichever frame the page happened to declare first — on a page with
  // three embeds, the first embed, however long ago it stopped.
  gathered.sort((a, b) => b.lastAt - a.lastAt)

  // A key addresses one session, and the popup has nothing else to address one by. Two frames
  // answering under the same key are playing the same video from the same address — the same
  // clip embedded twice — and two rows the user cannot tell apart, of which "Save all" would
  // reach whichever came first, are worse than one: the freshest of them is kept.
  const seen = new Set<string>()
  for (const session of gathered) {
    if (seen.has(session.key)) continue
    seen.add(session.key)
    merged.sessions.push(session)
  }

  return merged
}

/**
 * Asks one frame of a tab to assemble a session of its own registry into a file.
 *
 * The frame is named by the caller rather than looked up here: the answer is about the session
 * the popup is showing, and the frame it came out of was known at the moment it was listed.
 */
export function saveInFrame(
  tabId: number,
  frameId: number,
  key: string,
): Promise<SaveResult | undefined> {
  const request: ExtensionToTab = { type: 'tc:save', key }
  return chrome.tabs.sendMessage(tabId, request, { frameId })
}
