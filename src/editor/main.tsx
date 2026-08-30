import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { setUsed } from '../shared/history-db'
import { isSnapshotId } from '../shared/protocol'
import { readSettings } from '../shared/settings-store'
import { loadSnapshot } from './source/snapshot'
import { buildPreview, type Preview } from './source/preview'
import { Shell, type EditorOptions, type EditorState } from './shell'

/**
 * The recording of the history this tab stands over, or null when it stands over a snapshot.
 *
 * Read off the address here as well as in `loadSnapshot`, and on purpose: what the loader gives
 * back is a reader over material, one shape for both doors, and threading an identifier through
 * it would put a field on every reader that only one kind of reader ever has.
 */
function historyIdIn(search: string): string | null {
  const id = new URLSearchParams(search).get('h') ?? ''
  return isSnapshotId(id) ? id : null
}

/**
 * The editor tab.
 *
 * Everything it works on comes out of storage named by the address: a snapshot file for a page
 * that was frozen, the pieces of a recording for a session out of the history. Nothing is kept
 * between openings and nothing is written back — both are read-only from the moment they were
 * written, and F5 rebuilds the same screen from the same bytes.
 */
function Editor() {
  const [state, setState] = useState<EditorState>({ status: 'opening' })

  useEffect(() => {
    let built: Preview | null = null
    let dropped = false

    // The settings are waited for rather than filled in afterwards: the name template is part of
    // the context every clip is named against, and a context that changed under a session would
    // take the clips of that session with it.
    void (async () => {
      let opened: Awaited<ReturnType<typeof loadSnapshot>>
      let settings: Awaited<ReturnType<typeof readSettings>>

      try {
        const result = await Promise.all([
          loadSnapshot(window.location.search),
          readSettings(),
        ])
        opened = result[0]
        settings = result[1]
      } catch {
        if (!dropped) setState({ status: 'failed', reason: 'open-failed' })
        return
      }

      const loaded = opened
      if (!loaded.ok) {
        if (!dropped) setState({ status: 'failed', reason: loaded.reason })
        return
      }

      const historyId = historyIdIn(window.location.search)
      const options: EditorOptions = {
        askWhere: settings.export.askWhere,
        export: settings.export,
        // A recording somebody cut a clip out of is one they chose, and it is
        // kept ahead of one that was only watched. Nothing to say for a snapshot: it is a
        // temporary of this one editing and the sweeper takes it by age.
        onSaved: historyId
          ? () => void setUsed(historyId, Date.now()).catch(() => undefined)
          : undefined,
      }

      // The screen goes up first and the preview follows: assembling it reads the whole of the
      // material out of storage, and a title that waits for a hundred megabytes is a blank tab.
      if (!dropped) {
        setState({
          status: 'ready',
          reader: loaded.reader,
          material: loaded.material,
          preview: 'building',
          options,
        })
      }

      try {
        built = await buildPreview(loaded.reader, loaded.material)
      } catch {
        if (!dropped) {
          setState({
            status: 'ready',
            reader: loaded.reader,
            material: loaded.material,
            preview: 'failed',
            options,
          })
        }
        return
      }

      if (dropped) {
        built?.release()
        return
      }
      setState({
        status: 'ready',
        reader: loaded.reader,
        material: loaded.material,
        preview: built ?? (loaded.material.video ? 'failed' : null),
        options,
      })
    })()

    return () => {
      dropped = true
      built?.release()
    }
  }, [])

  return <Shell state={state} />
}

render(<Editor />, document.body)
