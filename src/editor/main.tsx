import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { loadSnapshot } from './source/snapshot'
import { buildPreview, type Preview } from './source/preview'
import { Shell, type EditorState } from './shell'

/**
 * The editor tab.
 *
 * Everything it works on comes out of one file in OPFS named by the address. Nothing is kept
 * between openings and nothing is written back: the snapshot is read-only from the moment the
 * bridge closed it, and F5 rebuilds the same screen from the same bytes.
 */
function Editor() {
  const [state, setState] = useState<EditorState>({ status: 'opening' })

  useEffect(() => {
    let built: Preview | null = null
    let dropped = false

    void loadSnapshot(window.location.search).then(async (loaded) => {
      if (!loaded.ok) {
        setState({ status: 'failed', reason: loaded.reason })
        return
      }

      // The screen goes up first and the preview follows: assembling it reads the whole of the
      // material out of storage, and a title that waits for a hundred megabytes is a blank tab.
      setState({
        status: 'ready',
        reader: loaded.reader,
        material: loaded.material,
        preview: 'building',
      })

      built = await buildPreview(loaded.reader, loaded.material)
      if (dropped) {
        built?.release()
        return
      }
      setState({
        status: 'ready',
        reader: loaded.reader,
        material: loaded.material,
        preview: built,
      })
    })

    return () => {
      dropped = true
      built?.release()
    }
  }, [])

  return <Shell state={state} />
}

render(<Editor />, document.body)
